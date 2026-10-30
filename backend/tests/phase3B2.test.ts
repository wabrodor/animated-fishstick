import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../queues.js', () => ({
  scheduleCareTaskReminder: vi.fn().mockResolvedValue(undefined),
}));

import { CarePlan, CareTask, Organization, OutboxEvent, Patient, PatientCommunication, User } from '../models.js';
import { createCareTaskReminderCommunication } from '../patient-communication.js';
import { dispatchOutboxEvent } from '../outbox-dispatcher.js';
import { scheduleCareTaskReminder } from '../queues.js';

let mongo: MongoMemoryServer;
let organizationId: mongoose.Types.ObjectId;
let patientId: mongoose.Types.ObjectId;
let carePlanId: mongoose.Types.ObjectId;
let taskId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Organization.init(), User.init(), Patient.init(), CarePlan.init(), CareTask.init(), PatientCommunication.init(), OutboxEvent.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    Organization.deleteMany({}), User.deleteMany({}), Patient.deleteMany({}), CarePlan.deleteMany({}),
    CareTask.deleteMany({}), PatientCommunication.deleteMany({}), OutboxEvent.deleteMany({}),
  ]);

  const organization = await Organization.create({ name: 'Clinic B2', type: 'CLINIC' });
  organizationId = organization._id;
  const user = await User.create({ organizationId, name: 'Clinician', email: `b2-${Date.now()}@example.com`, passwordHash: 'x', roles: ['CLINICIAN'] });
  const patient = await Patient.create({
    organizationId,
    medicalRecordNumber: `B2-${Date.now()}`,
    name: { first: 'Patient', last: 'Reminder' },
    assignedClinicianId: user._id,
    preferredLanguage: 'ml',
    preferredContactChannel: 'WHATSAPP',
    whatsapp: '+919999999999',
    programmeConsent: { communicationConsent: true, acceptedAt: new Date(), acceptedByUserId: user._id },
  });
  patientId = patient._id;
  const plan = await CarePlan.create({
    organizationId,
    patientId,
    condition: 'HYPERTENSION',
    status: 'ACTIVE',
    startDate: new Date('2026-09-21T00:00:00.000Z'),
    endDate: new Date('2026-12-20T00:00:00.000Z'),
    goals: [],
    createdByUserId: user._id,
  });
  carePlanId = plan._id;
  const task = await CareTask.create({
    organizationId,
    patientId,
    carePlanId,
    taskKey: 'DAY_7:VITALS:1',
    type: 'VITALS',
    title: 'Record your home blood pressure',
    dueAt: new Date('2026-09-28T00:00:00.000Z'),
    status: 'PENDING',
  });
  taskId = task._id;
});

describe('Phase 3B.2 patient task delivery backbone', () => {
  it('creates one preferred-language task reminder communication idempotently', async () => {
    const first = await createCareTaskReminderCommunication({ organizationId: String(organizationId), taskId: String(taskId) });
    const second = await createCareTaskReminderCommunication({ organizationId: String(organizationId), taskId: String(taskId) });

    expect(first?.idempotent).toBe(false);
    expect(second?.idempotent).toBe(true);
    expect(first?.communication._id).toBe(second?.communication._id);
    expect(first?.communication.channel).toBe('WHATSAPP');
    expect(first?.communication.language).toBe('ml');
    expect(first?.communication.purpose).toBe('CARE_TASK_REMINDER');
    expect(await PatientCommunication.countDocuments({ organizationId, taskId, purpose: 'CARE_TASK_REMINDER' })).toBe(1);
  });

  it('does not create a reminder for a completed task', async () => {
    await CareTask.updateOne({ _id: taskId }, { $set: { status: 'COMPLETED', completedAt: new Date() } });
    const result = await createCareTaskReminderCommunication({ organizationId: String(organizationId), taskId: String(taskId) });
    expect(result).toBeNull();
    expect(await PatientCommunication.countDocuments({ taskId })).toBe(0);
  });

  it('does not cross tenant boundaries', async () => {
    const foreignOrganization = await Organization.create({ name: 'Foreign', type: 'CLINIC' });
    const result = await createCareTaskReminderCommunication({ organizationId: String(foreignOrganization._id), taskId: String(taskId) });
    expect(result).toBeNull();
    expect(await PatientCommunication.countDocuments({ taskId })).toBe(0);
  });

  it('requires communication consent', async () => {
    await Patient.updateOne({ _id: patientId }, { $set: { 'programmeConsent.communicationConsent': false } });
    const result = await createCareTaskReminderCommunication({ organizationId: String(organizationId), taskId: String(taskId) });
    expect(result).toBeNull();
  });

  it('passes tenant context into the idempotent reminder job', async () => {
    await dispatchOutboxEvent({
      eventType: 'CARE_TASK_DUE',
      payload: {
        taskId: String(taskId),
        organizationId: String(organizationId),
        patientId: String(patientId),
        dueAt: new Date('2026-09-28T00:00:00.000Z').toISOString(),
      },
    });
    expect(scheduleCareTaskReminder).toHaveBeenCalledTimes(1);
    expect(scheduleCareTaskReminder).toHaveBeenCalledWith(
      String(taskId),
      expect.any(Date),
      { organizationId: String(organizationId), patientId: String(patientId) },
    );
  });
});
