import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

import { CarePlan, CarePlanExecution, CarePlanMilestone, CareTask, Organization, OutboxEvent, Patient, PatientReview, User } from '../models.js';
import { ensurePatientReviewForMilestone, completePatientReview } from '../patient-review.js';
import { buildPatientReviewAdherenceSnapshot } from '../patient-review-adherence.js';

let mongo: MongoMemoryServer;
let organizationId: mongoose.Types.ObjectId;
let patientId: mongoose.Types.ObjectId;
let carePlanId: mongoose.Types.ObjectId;
let executionId: mongoose.Types.ObjectId;
let milestoneId: mongoose.Types.ObjectId;
let userId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([
    Organization.init(), User.init(), Patient.init(), CarePlan.init(),
    CarePlanExecution.init(), CarePlanMilestone.init(), CareTask.init(), PatientReview.init(), OutboxEvent.init(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    Organization.deleteMany({}), User.deleteMany({}), Patient.deleteMany({}),
    CarePlan.deleteMany({}), CarePlanExecution.deleteMany({}), CarePlanMilestone.deleteMany({}), CareTask.deleteMany({}),
    PatientReview.deleteMany({}), OutboxEvent.deleteMany({}),
  ]);

  const organization = await Organization.create({ name: 'Clinic 3C1', type: 'CLINIC' });
  organizationId = organization._id;
  const user = await User.create({
    organizationId,
    name: 'Coordinator',
    email: `3c1-${Date.now()}@example.com`,
    passwordHash: 'x',
    roles: ['CLINIC_COORDINATOR'],
  });
  userId = user._id;

  const patient = await Patient.create({
    organizationId,
    medicalRecordNumber: `3C1-${Date.now()}`,
    name: { first: 'Review', last: 'Patient' },
    assignedClinicianId: user._id,
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

  const execution = await CarePlanExecution.create({
    organizationId,
    patientId,
    carePlanId,
    condition: 'HYPERTENSION',
    protocolKey: 'HYPERTENSION',
    protocolVersion: '1.0',
    status: 'ACTIVE',
    startDate: plan.startDate,
    endDate: plan.endDate,
    activationKey: `3c1:${plan._id}`,
  });
  executionId = execution._id;

  const milestone = await CarePlanMilestone.create({
    organizationId,
    patientId,
    carePlanId,
    executionId,
    key: 'DAY_7_EARLY_REVIEW',
    offsetDays: 7,
    day: 7,
    dueAt: new Date('2026-09-28T00:00:00.000Z'),
    reviewRequired: true,
    status: 'DUE',
  });
  milestoneId = milestone._id;
});

describe('Phase 3C.1 patient review checkpoint', () => {
  it('creates one review with a deterministic checklist', async () => {
    const first = await ensurePatientReviewForMilestone({
      organizationId: String(organizationId),
      patientId: String(patientId),
      executionId: String(executionId),
      milestoneId: String(milestoneId),
    });

    expect(first?.idempotent).toBe(false);
    expect(first?.review.status).toBe('OPEN');
    expect((first?.review.questions as unknown[]).length).toBe(7);
    expect(await PatientReview.countDocuments({ organizationId })).toBe(1);
    expect(await OutboxEvent.countDocuments({ organizationId, eventType: 'PATIENT_REVIEW_READY' })).toBe(1);
  });

  it('is idempotent on retry', async () => {
    const input = { organizationId: String(organizationId), patientId: String(patientId), executionId: String(executionId), milestoneId: String(milestoneId) };
    const first = await ensurePatientReviewForMilestone(input);
    const second = await ensurePatientReviewForMilestone(input);

    expect(second?.idempotent).toBe(true);
    expect(String(first?.review._id)).toBe(String(second?.review._id));
    expect(await PatientReview.countDocuments({ organizationId })).toBe(1);
    expect(await OutboxEvent.countDocuments({ organizationId, eventType: 'PATIENT_REVIEW_READY' })).toBe(1);
  });

  it('does not create a review for a milestone that is not review-required', async () => {
    await CarePlanMilestone.updateOne({ _id: milestoneId }, { $set: { reviewRequired: false } });
    const result = await ensurePatientReviewForMilestone({
      organizationId: String(organizationId), patientId: String(patientId),
      executionId: String(executionId), milestoneId: String(milestoneId),
    });
    expect(result).toBeNull();
    expect(await PatientReview.countDocuments({ organizationId })).toBe(0);
  });

  it('does not cross organization boundaries', async () => {
    const foreign = await Organization.create({ name: 'Foreign 3C1', type: 'CLINIC' });
    const result = await ensurePatientReviewForMilestone({
      organizationId: String(foreign._id), patientId: String(patientId),
      executionId: String(executionId), milestoneId: String(milestoneId),
    });
    expect(result).toBeNull();
    expect(await PatientReview.countDocuments({ organizationId: foreign._id })).toBe(0);
  });

  it('completes an open review once and preserves the review identity', async () => {
    const created = await ensurePatientReviewForMilestone({
      organizationId: String(organizationId), patientId: String(patientId),
      executionId: String(executionId), milestoneId: String(milestoneId),
    });
    const completed = await completePatientReview({
      organizationId: String(organizationId),
      patientId: String(patientId),
      reviewId: String(created?.review._id),
      actorUserId: String(userId),
      answers: [{
        questionId: 'medication_adherence',
        topic: 'MEDICATION_ADHERENCE',
        question: 'Did the patient follow the prescribed medication plan?',
        answer: 'Yes',
      }],
      notes: 'Routine review completed.',
    });

    expect(completed?.status).toBe('COMPLETED');
    expect(String(completed?._id)).toBe(String(created?.review._id));
    expect(await PatientReview.countDocuments({ organizationId, status: 'COMPLETED' })).toBe(1);
  });
  it('builds a deterministic adherence snapshot from tasks in the review period', async () => {
    await CareTask.create([
      {
        organizationId, patientId, carePlanId, executionId, milestoneId,
        taskKey: 'DAY_3:LAB:1', type: 'LAB', title: 'Lab',
        dueAt: new Date('2026-09-24T00:00:00.000Z'), status: 'COMPLETED',
      },
      {
        organizationId, patientId, carePlanId, executionId, milestoneId,
        taskKey: 'DAY_5:MEDICATION:1', type: 'MEDICATION', title: 'Medication',
        dueAt: new Date('2026-09-26T00:00:00.000Z'), status: 'OVERDUE',
      },
      {
        organizationId, patientId, carePlanId, executionId, milestoneId,
        taskKey: 'DAY_6:DIETITIAN_SESSION:1', type: 'DIETITIAN_SESSION', title: 'Dietitian',
        dueAt: new Date('2026-09-27T00:00:00.000Z'), status: 'SKIPPED',
      },
    ]);

    const review = await ensurePatientReviewForMilestone({
      organizationId: String(organizationId), patientId: String(patientId),
      executionId: String(executionId), milestoneId: String(milestoneId),
    });
    const snapshot = await buildPatientReviewAdherenceSnapshot({
      organizationId: String(organizationId), patientId: String(patientId),
      reviewId: String(review?.review._id), now: new Date('2026-09-28T12:00:00.000Z'),
    });

    expect(snapshot?.totalDueTasks).toBe(3);
    expect(snapshot?.completedTasks).toBe(1);
    expect(snapshot?.skippedTasks).toBe(1);
    expect(snapshot?.overdueTasks).toBe(1);
    expect(snapshot?.pendingTasks).toBe(0);
    expect(snapshot?.completionRate).toBeCloseTo(1 / 3, 4);
    expect(snapshot?.actionedRate).toBe(1);
    expect(snapshot?.byType.LAB.completedTasks).toBe(1);
  });

  it('stores the adherence snapshot on completion and keeps retry idempotent', async () => {
    await CareTask.create({
      organizationId, patientId, carePlanId, executionId, milestoneId,
      taskKey: 'DAY_5:VITALS:1', type: 'VITALS', title: 'Vitals',
      dueAt: new Date('2026-09-26T00:00:00.000Z'), status: 'COMPLETED',
    });
    const created = await ensurePatientReviewForMilestone({
      organizationId: String(organizationId), patientId: String(patientId),
      executionId: String(executionId), milestoneId: String(milestoneId),
    });
    const input = {
      organizationId: String(organizationId), patientId: String(patientId),
      reviewId: String(created?.review._id), actorUserId: String(userId),
      answers: [{ questionId: 'medication_adherence', topic: 'MEDICATION_ADHERENCE', question: 'Did the patient follow the prescribed medication plan?', answer: 'Yes' }],
    };
    const first = await completePatientReview(input);
    const second = await completePatientReview(input);

    expect(first?.status).toBe('COMPLETED');
    expect(first?.adherenceSnapshot?.totalDueTasks).toBe(1);
    expect(second?.status).toBe('COMPLETED');
    expect(String(second?._id)).toBe(String(first?._id));
    expect(await PatientReview.countDocuments({ organizationId, adherenceSnapshot: { $exists: true } })).toBe(1);
  });

});
