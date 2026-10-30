import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import { CarePlan, CarePlanExecution, CarePlanMilestone, CareTask, Organization, Patient, PatientReview, User } from '../models.js';
import { ensurePatientReviewForMilestone, completePatientReview } from '../patient-review.js';
import { buildPatientReviewAdherenceSnapshot } from '../patient-review-adherence.js';

let mongo: MongoServer;
let organizationId: mongoose.Types.ObjectId;
let patientId: mongoose.Types.ObjectId;
let carePlanId: mongoose.Types.ObjectId;
let executionId: mongoose.Types.ObjectId;
let milestoneId: mongoose.Types.ObjectId;
let userId: mongoose.Types.ObjectId;

type MongoServer = MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Organization.init(), User.init(), Patient.init(), CarePlan.init(), CarePlanExecution.init(), CarePlanMilestone.init(), CareTask.init(), PatientReview.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([Organization.deleteMany({}), User.deleteMany({}), Patient.deleteMany({}), CarePlan.deleteMany({}), CarePlanExecution.deleteMany({}), CarePlanMilestone.deleteMany({}), CareTask.deleteMany({}), PatientReview.deleteMany({})]);
  const organization = await Organization.create({ name: 'Clinic 3C2', type: 'CLINIC' });
  organizationId = organization._id;
  const user = await User.create({ organizationId, name: 'Coordinator', email: `3c2-${Date.now()}@example.com`, passwordHash: 'x', roles: ['CLINIC_COORDINATOR'] });
  userId = user._id;
  const patient = await Patient.create({ organizationId, medicalRecordNumber: `3C2-${Date.now()}`, name: { first: 'Adherence', last: 'Patient' }, assignedClinicianId: user._id });
  patientId = patient._id;
  const plan = await CarePlan.create({ organizationId, patientId, condition: 'HYPERTENSION', status: 'ACTIVE', startDate: new Date('2026-09-21T00:00:00.000Z'), endDate: new Date('2026-12-20T00:00:00.000Z'), goals: [], createdByUserId: user._id });
  carePlanId = plan._id;
  const execution = await CarePlanExecution.create({ organizationId, patientId, carePlanId, condition: 'HYPERTENSION', protocolKey: 'HYPERTENSION', protocolVersion: '1.0', status: 'ACTIVE', startDate: plan.startDate, endDate: plan.endDate, activationKey: `3c2:${plan._id}` });
  executionId = execution._id;
  const milestone = await CarePlanMilestone.create({ organizationId, patientId, carePlanId, executionId, key: 'DAY_7_EARLY_REVIEW', offsetDays: 7, day: 7, dueAt: new Date('2026-09-28T00:00:00.000Z'), reviewRequired: true, status: 'DUE' });
  milestoneId = milestone._id;
});

async function createReview() {
  const result = await ensurePatientReviewForMilestone({ organizationId: String(organizationId), patientId: String(patientId), executionId: String(executionId), milestoneId: String(milestoneId) });
  return String(result?.review._id);
}

describe('Phase 3C.2 review-to-adherence connection', () => {
  it('aggregates only due tasks in the review period', async () => {
    await CareTask.create([
      { organizationId, patientId, carePlanId, executionId, milestoneId, taskKey: 'DAY_3:LAB:1', type: 'LAB', title: 'Lab', dueAt: new Date('2026-09-24T00:00:00.000Z'), status: 'COMPLETED' },
      { organizationId, patientId, carePlanId, executionId, milestoneId, taskKey: 'DAY_5:MEDICATION:1', type: 'MEDICATION', title: 'Medication', dueAt: new Date('2026-09-26T00:00:00.000Z'), status: 'OVERDUE' },
      { organizationId, patientId, carePlanId, executionId, milestoneId, taskKey: 'DAY_6:DIETITIAN_SESSION:1', type: 'DIETITIAN_SESSION', title: 'Dietitian', dueAt: new Date('2026-09-27T00:00:00.000Z'), status: 'SKIPPED' },
    ]);
    const reviewId = await createReview();
    const snapshot = await buildPatientReviewAdherenceSnapshot({ organizationId: String(organizationId), patientId: String(patientId), reviewId, now: new Date('2026-09-28T12:00:00.000Z') });
    expect(snapshot?.totalDueTasks).toBe(3);
    expect(snapshot?.completedTasks).toBe(1);
    expect(snapshot?.skippedTasks).toBe(1);
    expect(snapshot?.overdueTasks).toBe(1);
    expect(snapshot?.pendingTasks).toBe(0);
    expect(snapshot?.completionRate).toBeCloseTo(1 / 3, 4);
    expect(snapshot?.actionedRate).toBe(1);
  });

  it('stores one adherence snapshot when a review is completed and is retry-safe', async () => {
    await CareTask.create({ organizationId, patientId, carePlanId, executionId, milestoneId, taskKey: 'DAY_5:VITALS:1', type: 'VITALS', title: 'Vitals', dueAt: new Date('2026-09-26T00:00:00.000Z'), status: 'COMPLETED' });
    const reviewId = await createReview();
    const input = { organizationId: String(organizationId), patientId: String(patientId), reviewId, actorUserId: String(userId), answers: [{ questionId: 'medication_adherence', topic: 'MEDICATION_ADHERENCE', question: 'Did the patient follow the prescribed medication plan?', answer: 'Yes' }] };
    const first = await completePatientReview(input);
    const second = await completePatientReview(input);
    expect(first?.status).toBe('COMPLETED');
    expect(first?.adherenceSnapshot?.totalDueTasks).toBe(1);
    expect(second?.status).toBe('COMPLETED');
    expect(String(second?._id)).toBe(String(first?._id));
    expect(await PatientReview.countDocuments({ organizationId, adherenceSnapshot: { $exists: true } })).toBe(1);
  });

  it('does not read tasks from another organization', async () => {
    const reviewId = await createReview();
    const foreignOrg = await Organization.create({ name: 'Foreign 3C2', type: 'CLINIC' });
    const foreignPatient = await Patient.create({ organizationId: foreignOrg._id, medicalRecordNumber: `FOREIGN-${Date.now()}`, name: { first: 'Foreign', last: 'Patient' }, assignedClinicianId: userId });
    await CareTask.create({ organizationId: foreignOrg._id, patientId: foreignPatient._id, carePlanId, executionId, milestoneId, taskKey: 'FOREIGN:LAB:1', type: 'LAB', title: 'Foreign lab', dueAt: new Date('2026-09-25T00:00:00.000Z'), status: 'COMPLETED' });
    const snapshot = await buildPatientReviewAdherenceSnapshot({ organizationId: String(organizationId), patientId: String(patientId), reviewId, now: new Date('2026-09-28T12:00:00.000Z') });
    expect(snapshot?.totalDueTasks).toBe(0);
  });
});
