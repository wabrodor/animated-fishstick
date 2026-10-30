import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../queues.js', () => ({
  scheduleCareTaskReminder: vi.fn().mockResolvedValue(undefined),
}));

import { CarePlan, CarePlanDraft, CarePlanExecution, CarePlanMilestone, CareTask, Organization, OutboxEvent, User, Patient } from '../models.js';
import { ensureCarePlanExecution } from '../care-plan-execution.js';
import { processCarePlanMilestone } from '../milestone-orchestrator.js';

let mongo: MongoMemoryServer;
let organizationId: mongoose.Types.ObjectId;
let patientId: mongoose.Types.ObjectId;
let carePlanId: mongoose.Types.ObjectId;
let userId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([CarePlan.init(), CarePlanDraft.init(), CarePlanExecution.init(), CarePlanMilestone.init(), CareTask.init(), OutboxEvent.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    Organization.deleteMany({}), User.deleteMany({}), Patient.deleteMany({}), CarePlan.deleteMany({}),
    CarePlanDraft.deleteMany({}), CarePlanExecution.deleteMany({}), CarePlanMilestone.deleteMany({}), CareTask.deleteMany({}), OutboxEvent.deleteMany({}),
  ]);
  const organization = await Organization.create({ name: 'Clinic A', type: 'CLINIC' });
  organizationId = organization._id;
  const user = await User.create({ organizationId, name: 'Clinician', email: `c-${Date.now()}@example.com`, passwordHash: 'x', roles: ['CLINICIAN'] });
  userId = user._id;
  const patient = await Patient.create({ organizationId, medicalRecordNumber: `MRN-${Date.now()}`, name: { first: 'Test', last: 'Patient' }, assignedClinicianId: userId });
  patientId = patient._id;
  const plan = await CarePlan.create({ organizationId, patientId, condition: 'HYPERTENSION', status: 'ACTIVE', startDate: new Date('2026-09-21T00:00:00.000Z'), endDate: new Date('2026-12-20T00:00:00.000Z'), goals: [], createdByUserId: userId });
  carePlanId = plan._id;
  await CarePlanDraft.create({
    organizationId, patientId, condition: 'HYPERTENSION', status: 'APPROVED', generatedByUserId: userId,
    approvedByUserId: userId, approvedAt: new Date('2026-09-21T00:00:00.000Z'), source: 'RULES',
    inputSnapshot: {}, plan: { summary: 'test', goals: [], clinicalInterventionNeeded: false, confidence: 1, safetyNotes: [], tasks: [
      { type: 'LAB', title: 'Day 3 lab', dueDay: 3 },
      { type: 'OPD_VISIT', title: 'Day 7 review', dueDay: 7 },
    ] },
  });
});

describe('Phase 3A.2 automatic milestone/task orchestration', () => {
  it('moves a due milestone to DUE and materializes its tasks idempotently', async () => {
    const execution = await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });
    const milestone = await CarePlanMilestone.findOne({ executionId: execution?._id, offsetDays: 3 });
    expect(milestone).toBeTruthy();
    const now = new Date('2026-09-25T00:00:00.000Z');

    const first = await processCarePlanMilestone({ organizationId: String(organizationId), patientId: String(patientId), executionId: String(execution?._id), milestoneId: String(milestone?._id), now });
    const second = await processCarePlanMilestone({ organizationId: String(organizationId), patientId: String(patientId), executionId: String(execution?._id), milestoneId: String(milestone?._id), now });

    expect(first.processed).toBe(true);
    expect(second.processed).toBe(true);
    expect(await CarePlanMilestone.findById(milestone?._id).then((doc) => doc?.status)).toBe('DUE');
    expect(await CareTask.countDocuments({ executionId: execution?._id, milestoneId: milestone?._id })).toBe(1);
    expect(await OutboxEvent.countDocuments({ eventType: 'CARE_TASK_DUE' })).toBe(1);
  });

  it('does not mutate another tenant even when the job payload is forged', async () => {
    const execution = await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });
    const milestone = await CarePlanMilestone.findOne({ executionId: execution?._id, offsetDays: 3 });
    const result = await processCarePlanMilestone({ organizationId: new mongoose.Types.ObjectId().toHexString(), patientId: String(patientId), executionId: String(execution?._id), milestoneId: String(milestone?._id), now: new Date('2026-09-25T00:00:00.000Z') });
    expect(result.reason).toBe('EXECUTION_NOT_ACTIVE');
    expect(await CareTask.countDocuments({ executionId: execution?._id })).toBe(0);
  });

  it('marks only crossed pending tasks overdue', async () => {
    const execution = await ensureCarePlanExecution({ organizationId: String(organizationId), patientId: String(patientId), carePlanId: String(carePlanId) });
    const milestone = await CarePlanMilestone.findOne({ executionId: execution?._id, offsetDays: 7 });
    await CareTask.create({ organizationId, patientId, carePlanId, executionId: execution?._id, milestoneId: milestone?._id, taskKey: 'DAY_3:LAB:1', type: 'LAB', title: 'late lab', dueAt: new Date('2026-09-23T00:00:00.000Z'), status: 'PENDING' });
    await CareTask.create({ organizationId, patientId, carePlanId, executionId: execution?._id, milestoneId: milestone?._id, taskKey: 'DAY_7:OPD_VISIT:99', type: 'OPD_VISIT', title: 'future visit', dueAt: new Date('2026-10-01T00:00:00.000Z'), status: 'PENDING' });
    await processCarePlanMilestone({ organizationId: String(organizationId), patientId: String(patientId), executionId: String(execution?._id), milestoneId: String(milestone?._id), now: new Date('2026-09-30T00:00:00.000Z') });
    expect(await CareTask.findOne({ taskKey: 'DAY_3:LAB:1' }).then((doc) => doc?.status)).toBe('OVERDUE');
    expect(await CareTask.findOne({ taskKey: 'DAY_7:OPD_VISIT:99' }).then((doc) => doc?.status)).toBe('PENDING');
  });
});
