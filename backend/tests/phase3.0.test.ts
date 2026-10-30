import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../queues.js', () => ({
  scheduleCarePlanMilestone: vi.fn().mockResolvedValue('care-plan-milestone-job'),
}));

import { CarePlan, CarePlanExecution, CarePlanMilestone, CareTask, CareProtocol, Organization, OutboxEvent, Patient, User } from '../models.js';
import { ensureCarePlanExecution, attachCarePlanTasksToExecution, buildTaskDefinitionKey, getCarePlanExecution, transitionCarePlanMilestone } from '../care-plan-execution.js';
import { enqueueOutboxEvent, claimOutboxEvent, markOutboxFailed } from '../outbox.js';
import { processOutboxBatch } from '../outbox-dispatcher.js';
import { scheduleCarePlanMilestone } from '../queues.js';

let mongo: MongoMemoryServer;
let organizationId: mongoose.Types.ObjectId;
let otherOrganizationId: mongoose.Types.ObjectId;
let patientId: mongoose.Types.ObjectId;
let carePlanId: mongoose.Types.ObjectId;
let otherCarePlanId: mongoose.Types.ObjectId;
let userId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  // Ensure unique indexes exist before tests exercise database-level idempotency constraints.
  await Promise.all([CareTask.init(), CarePlanExecution.init(), CarePlanMilestone.init(), OutboxEvent.init(), CareProtocol.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    Organization.deleteMany({}), User.deleteMany({}), Patient.deleteMany({}), CarePlan.deleteMany({}),
    CarePlanExecution.deleteMany({}), CarePlanMilestone.deleteMany({}), CareTask.deleteMany({}), CareProtocol.deleteMany({}), OutboxEvent.deleteMany({}),
  ]);

  const [organization, otherOrganization, user] = await Promise.all([
    Organization.create({ name: 'Clinic A', type: 'CLINIC' }),
    Organization.create({ name: 'Clinic B', type: 'CLINIC' }),
    User.create({ organizationId: new mongoose.Types.ObjectId(), name: 'placeholder', email: `placeholder-${Date.now()}@example.com`, passwordHash: 'x', roles: ['CLINICIAN'] }),
  ]);
  organizationId = organization._id;
  otherOrganizationId = otherOrganization._id;
  await User.deleteOne({ _id: user._id });
  const userDoc = await User.create({ organizationId, name: 'Clinician', email: `clinician-${Date.now()}@example.com`, passwordHash: 'x', roles: ['CLINICIAN'] });
  userId = userDoc._id;
  const patient = await Patient.create({
    organizationId,
    medicalRecordNumber: `MRN-${Date.now()}`,
    name: { first: 'Test', last: 'Patient' },
    assignedClinicianId: userId,
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
    createdByUserId: userId,
  });
  carePlanId = plan._id;
  const otherPatient = await Patient.create({
    organizationId: otherOrganizationId,
    medicalRecordNumber: `MRN-B-${Date.now()}`,
    name: { first: 'Other', last: 'Patient' },
    assignedClinicianId: userId,
  });
  const otherUser = await User.create({ organizationId: otherOrganizationId, name: 'Other Clinician', email: `other-${Date.now()}@example.com`, passwordHash: 'x', roles: ['CLINICIAN'] });
  await Patient.updateOne({ _id: otherPatient._id }, { $set: { assignedClinicianId: otherUser._id } });
  const otherPlan = await CarePlan.create({
    organizationId: otherOrganizationId,
    patientId: otherPatient._id,
    condition: 'HYPERTENSION',
    status: 'ACTIVE',
    startDate: new Date('2026-09-21T00:00:00.000Z'),
    endDate: new Date('2026-12-20T00:00:00.000Z'),
    goals: [],
    createdByUserId: otherUser._id,
  });
  otherCarePlanId = otherPlan._id;
});

describe('Phase 3.0 execution foundation', () => {

  it('uses a disease-specific versioned protocol instead of a hard-coded seven-day schedule', async () => {
    await CareProtocol.create({
      protocolKey: 'TYPE_2_DIABETES',
      version: '1.0',
      condition: 'TYPE_2_DIABETES',
      jurisdiction: 'IN',
      durationDays: 60,
      milestones: [
        { key: 'BASELINE', label: 'Baseline', offsetDays: 0, sequence: 1 },
        { key: 'EARLY_REVIEW', label: 'Early review', offsetDays: 10, sequence: 1 },
        { key: 'MAJOR_REVIEW', label: 'Major review', offsetDays: 30, sequence: 1 },
        { key: 'OUTCOME', label: 'Outcome', offsetDays: 60, sequence: 1 },
      ],
    });
    const diabetesPlan = await CarePlan.create({
      organizationId,
      patientId,
      condition: 'TYPE_2_DIABETES',
      status: 'ACTIVE',
      startDate: new Date('2026-09-21T00:00:00.000Z'),
      endDate: new Date('2026-11-20T00:00:00.000Z'),
      goals: [],
      createdByUserId: userId,
    });

    const execution = await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(diabetesPlan._id) });
    const milestones = await CarePlanMilestone.find({ executionId: execution?._id }).sort({ offsetDays: 1 }).lean();

    expect(execution?.protocolKey).toBe('TYPE_2_DIABETES');
    expect(execution?.protocolVersion).toBe('1.0');
    expect(milestones.map((milestone) => milestone.offsetDays)).toEqual([0, 10, 30, 60]);
  });

  it('keeps an existing execution on its protocol version after a newer version becomes active', async () => {
    const execution = await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });
    await CareProtocol.updateOne({ condition: 'HYPERTENSION', version: '1.0' }, { $set: { status: 'INACTIVE' } });
    await CareProtocol.create({
      protocolKey: 'HYPERTENSION',
      version: '2.0',
      condition: 'HYPERTENSION',
      jurisdiction: 'IN',
      durationDays: 90,
      milestones: [{ key: 'NEW_BASELINE', label: 'New baseline', offsetDays: 0, sequence: 1 }],
    });

    const repeated = await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });
    expect(String(repeated?._id)).toBe(String(execution?._id));
    expect(repeated?.protocolVersion).toBe('1.0');
    expect(await CarePlanMilestone.countDocuments({ executionId: execution?._id })).toBe(7);
  });
  it('creates exactly one execution and seven deterministic milestones', async () => {
    const first = await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });
    const second = await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });

    expect(String(first?._id)).toBe(String(second?._id));
    expect(await CarePlanExecution.countDocuments({ carePlanId })).toBe(1);
    expect(await CarePlanMilestone.countDocuments({ carePlanId })).toBe(7);
    expect(await CarePlanMilestone.find({ carePlanId }).sort({ day: 1 }).distinct('day')).toEqual([0, 3, 7, 14, 30, 60, 90]);
  });

  it('is safe when two callers attempt execution creation concurrently', async () => {
    const results = await Promise.all([
      ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) }),
      ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) }),
    ]);

    expect(String(results[0]?._id)).toBe(String(results[1]?._id));
    expect(await CarePlanExecution.countDocuments({ carePlanId })).toBe(1);
    expect(await CarePlanMilestone.countDocuments({ carePlanId })).toBe(7);
  });

  it('does not allow one organization to bootstrap another organization execution', async () => {
    const result = await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(otherCarePlanId) });
    expect(result).toBeNull();
    expect(await CarePlanExecution.countDocuments({ carePlanId: otherCarePlanId })).toBe(0);
  });

  it('attaches tasks deterministically to matching milestones', async () => {
    await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });
    const task = await CareTask.create({
      organizationId,
      patientId,
      carePlanId,
      type: 'OPD_VISIT',
      title: 'Day 30 review',
      dueAt: new Date('2026-10-21T00:00:00.000Z'),
    });

    await attachCarePlanTasksToExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId), tasks: [task] });
    const updated = await CareTask.findById(task._id).lean();
    const milestone = await CarePlanMilestone.findOne({ carePlanId, day: 30 }).lean();

    expect(String(updated?.executionId)).toBe(String(milestone?.executionId));
    expect(String(updated?.milestoneId)).toBe(String(milestone?._id));
    expect(updated?.taskKey).toBe(buildTaskDefinitionKey(30, 'OPD_VISIT', 1));
  });

  it('uses a stable task definition key instead of a human-readable title', async () => {
    const execution = await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });
    const task = await CareTask.create({
      organizationId,
      patientId,
      carePlanId,
      type: 'FOLLOW_UP',
      title: 'Original title',
      dueAt: new Date('2026-10-21T00:00:00.000Z'),
      executionId: execution?._id,
      taskKey: buildTaskDefinitionKey(30, 'FOLLOW_UP', 1),
    });
    await CareTask.updateOne({ _id: task._id }, { $set: { title: 'Updated operational wording' } });
    const updated = await CareTask.findById(task._id).lean();
    expect(updated?.taskKey).toBe('DAY_30:FOLLOW_UP:1');
  });

  it('completes a milestone early and treats a repeated completion as idempotent', async () => {
    const execution = await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });
    const milestone = await CarePlanMilestone.findOne({ executionId: execution?._id, day: 3 }).lean();
    const now = new Date('2026-09-22T00:00:00.000Z');
    const first = await transitionCarePlanMilestone({
      organizationId: String(organizationId),
      patientId: String(patientId),
      carePlanId: String(carePlanId),
      milestoneId: String(milestone?._id),
      action: 'COMPLETE',
      actorUserId: String(userId),
      now,
    });
    expect('error' in first).toBe(false);
    if (!('error' in first)) expect(first.milestone.status).toBe('COMPLETED_EARLY');

    const second = await transitionCarePlanMilestone({
      organizationId: String(organizationId),
      patientId: String(patientId),
      carePlanId: String(carePlanId),
      milestoneId: String(milestone?._id),
      action: 'COMPLETE',
      actorUserId: String(userId),
      now,
    });
    expect('error' in second).toBe(false);
    if (!('error' in second)) expect(second.idempotent).toBe(true);
  });

  it('does not allow a milestone transition after the execution is cancelled', async () => {
    const execution = await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });
    await CarePlanExecution.updateOne({ _id: execution?._id }, { $set: { status: 'CANCELLED' } });
    const milestone = await CarePlanMilestone.findOne({ executionId: execution?._id, day: 7 }).lean();
    const result = await transitionCarePlanMilestone({
      organizationId: String(organizationId),
      patientId: String(patientId),
      carePlanId: String(carePlanId),
      milestoneId: String(milestone?._id),
      action: 'COMPLETE',
      actorUserId: String(userId),
    });
    expect(result).toEqual({ error: 'CARE_PLAN_EXECUTION_NOT_ACTIVE' });
  });

  it('returns execution, milestones, and tasks together', async () => {
    await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });
    const task = await CareTask.create({ organizationId, patientId, carePlanId, type: 'VITALS', title: 'Day 7 vitals', dueAt: new Date('2026-09-28T00:00:00.000Z') });
    await attachCarePlanTasksToExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId), tasks: [task] });
    const result = await getCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });
    expect(result?.milestones).toHaveLength(7);
    expect(result?.tasks).toHaveLength(1);
    expect(result?.tasks[0]?.taskKey).toBe('DAY_7:VITALS:1');
  });

  it('does not allow a duplicate logical task inside one execution', async () => {
    await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });
    const first = await CareTask.create({
      organizationId,
      patientId,
      carePlanId,
      type: 'OPD_VISIT',
      title: 'Day 30 review',
      dueAt: new Date('2026-10-21T00:00:00.000Z'),
      executionId: (await CarePlanExecution.findOne({ carePlanId }))!._id,
      taskKey: 'DAY_30:OPD_VISIT:1',
    });
    expect(first._id).toBeDefined();
    await expect(CareTask.create({
      organizationId,
      patientId,
      carePlanId,
      type: 'OPD_VISIT',
      title: 'Day 30 review duplicate',
      dueAt: new Date('2026-10-21T00:00:00.000Z'),
      executionId: first.executionId,
      taskKey: 'DAY_30:OPD_VISIT:1',
    })).rejects.toMatchObject({ code: 11000 });
  });

  it('creates one durable milestone outbox event per milestone and reuses them on repeated execution bootstrap', async () => {
    const first = await ensureCarePlanExecution({
      organizationId: String(organizationId),
      patientId: String(patientId),
      carePlanId: String(carePlanId),
    });
    expect(first).not.toBeNull();
    expect(await OutboxEvent.countDocuments({
      organizationId: organizationId,
      eventType: 'CARE_PLAN_MILESTONE_DUE',
    })).toBe(7);
    expect(await OutboxEvent.countDocuments({
      organizationId: organizationId,
      eventType: 'CARE_PLAN_ACTIVATED',
    })).toBe(1);

    await ensureCarePlanExecution({
      organizationId: String(organizationId),
      patientId: String(patientId),
      carePlanId: String(carePlanId),
    });
    expect(await OutboxEvent.countDocuments({
      organizationId: organizationId,
      eventType: 'CARE_PLAN_MILESTONE_DUE',
    })).toBe(7);
    expect(await OutboxEvent.countDocuments({
      organizationId: organizationId,
      eventType: 'CARE_PLAN_ACTIVATED',
    })).toBe(1);
  });

  it('dispatches a pending milestone event exactly once and marks it published', async () => {
    const now = new Date('2026-09-21T00:00:00.000Z');
    const event = await enqueueOutboxEvent({
      organizationId: String(organizationId),
      eventKey: `care-plan-milestone-due:${carePlanId}:dispatch-test`,
      eventType: 'CARE_PLAN_MILESTONE_DUE',
      aggregateType: 'CarePlanMilestone',
      aggregateId: String(carePlanId),
      payload: {
        organizationId: String(organizationId),
        patientId: String(patientId),
        executionId: String(carePlanId),
        milestoneId: String(carePlanId),
        day: 3,
        dueAt: now.toISOString(),
      },
    });

    await OutboxEvent.updateOne({ _id: event?._id }, { $set: { availableAt: now } });
    expect(await processOutboxBatch(10, now)).toBe(1);
    const published = await OutboxEvent.findById(event?._id).lean();
    expect(published?.status).toBe('PUBLISHED');
    expect(published?.attempts).toBe(1);
    expect(scheduleCarePlanMilestone).toHaveBeenCalledTimes(1);
  });

  it('releases a claimed event back to pending when BullMQ publication fails', async () => {
    const now = new Date('2026-09-21T00:00:00.000Z');
    const event = await enqueueOutboxEvent({
      organizationId: String(organizationId),
      eventKey: `care-plan-milestone-due:${carePlanId}:failure-test`,
      eventType: 'CARE_PLAN_MILESTONE_DUE',
      aggregateType: 'CarePlanMilestone',
      aggregateId: String(carePlanId),
      payload: {
        organizationId: String(organizationId),
        patientId: String(patientId),
        executionId: String(carePlanId),
        milestoneId: String(carePlanId),
        day: 7,
        dueAt: now.toISOString(),
      },
    });

    await OutboxEvent.updateOne({ _id: event?._id }, { $set: { availableAt: now } });
    const claimed = await claimOutboxEvent(String(event?._id), now);
    expect(claimed?.status).toBe('PROCESSING');
    await markOutboxFailed(String(event?._id), new Error('redis unavailable'), new Date(now.getTime() + 1000));

    const retriable = await OutboxEvent.findById(event?._id).lean();
    expect(retriable?.status).toBe('PENDING');
    expect(retriable?.lastError).toBe('redis unavailable');
  });

  it('does not duplicate an outbox event when the same logical event is enqueued twice', async () => {
    const input = {
      organizationId: String(organizationId),
      eventKey: `care-task-reminder:${carePlanId}:task-1`,
      eventType: 'CARE_TASK_REMINDER_SCHEDULE',
      aggregateType: 'CarePlan',
      aggregateId: String(carePlanId),
      payload: { taskId: 'task-1' },
    };
    const first = await enqueueOutboxEvent(input);
    const second = await enqueueOutboxEvent(input);

    expect(String(first?._id)).toBe(String(second?._id));
    expect(await OutboxEvent.countDocuments({ eventKey: input.eventKey })).toBe(1);
  });
});
