import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({ env: { AI_ENABLED: true, AI_PROVIDER: 'openai-compatible', AI_API_KEY: 'test-key', AI_BASE_URL: 'https://example.test/v1', AI_MODEL: 'test-model' } }));
import { CarePlan, CarePlanExecution, CarePlanMilestone, Organization, Patient, PatientReview, PatientReviewSummary, User, VitalRecord } from '../models.js';
import { ensurePatientReviewForMilestone, completePatientReview } from '../patient-review.js';
import { generatePatientReviewSummary } from '../patient-review-ai.js';

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
  await Promise.all([Organization.init(), User.init(), Patient.init(), CarePlan.init(), CarePlanExecution.init(), CarePlanMilestone.init(), PatientReview.init(), PatientReviewSummary.init(), VitalRecord.init()]);
});

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

beforeEach(async () => {
  await Promise.all([Organization.deleteMany({}), User.deleteMany({}), Patient.deleteMany({}), CarePlan.deleteMany({}), CarePlanExecution.deleteMany({}), CarePlanMilestone.deleteMany({}), PatientReview.deleteMany({}), PatientReviewSummary.deleteMany({}), VitalRecord.deleteMany({})]);
  const organization = await Organization.create({ name: 'Clinic 3C3', type: 'CLINIC' }); organizationId = organization._id;
  const user = await User.create({ organizationId, name: 'Coordinator', email: `3c3-${Date.now()}@example.com`, passwordHash: 'x', roles: ['CLINIC_COORDINATOR'] }); userId = user._id;
  const patient = await Patient.create({ organizationId, medicalRecordNumber: `3C3-${Date.now()}`, name: { first: 'Review', last: 'Patient' }, preferredLanguage: 'ml', assignedClinicianId: user._id }); patientId = patient._id;
  const plan = await CarePlan.create({ organizationId, patientId, condition: 'HYPERTENSION', status: 'ACTIVE', startDate: new Date('2026-09-21'), endDate: new Date('2026-12-20'), goals: [], createdByUserId: user._id }); carePlanId = plan._id;
  const execution = await CarePlanExecution.create({ organizationId, patientId, carePlanId, condition: 'HYPERTENSION', protocolKey: 'HYPERTENSION', protocolVersion: '1.0', status: 'ACTIVE', startDate: plan.startDate, endDate: plan.endDate, activationKey: `3c3:${plan._id}` }); executionId = execution._id;
  const milestone = await CarePlanMilestone.create({ organizationId, patientId, carePlanId, executionId, key: 'DAY_7_EARLY_REVIEW', offsetDays: 7, day: 7, dueAt: new Date('2026-09-28'), reviewRequired: true, status: 'DUE' }); milestoneId = milestone._id;
  const review = await ensurePatientReviewForMilestone({ organizationId: String(organizationId), patientId: String(patientId), executionId: String(executionId), milestoneId: String(milestoneId) });
  await completePatientReview({ organizationId: String(organizationId), patientId: String(patientId), reviewId: String(review!.review._id), actorUserId: String(userId), answers: [{ questionId: 'medication_adherence', topic: 'MEDICATION_ADHERENCE', question: 'Did the patient follow the prescribed medication plan?', answer: 'Yes' }], notes: 'No new concerns.' });
});

function mockAi() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ clinicianSummary: 'Medication adherence reported as good. No new concerns documented.', patientSummary: 'നിങ്ങളുടെ മരുന്ന് പാലനം നല്ലതായി രേഖപ്പെടുത്തിയിട്ടുണ്ട്. പുതിയ ആശങ്കകൾ രേഖപ്പെടുത്തിയിട്ടില്ല.', suggestedActions: ['Continue the current care-plan follow-up.', 'Confirm the next scheduled review.'], clinicianReviewRequired: true }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })));
}

describe('Phase 3C.3 AI review summary', () => {
  it('creates a preferred-language clinician and patient summary from review data', async () => {
    mockAi();
    const review = await PatientReview.findOne({ organizationId, patientId }).lean();
    const result = await generatePatientReviewSummary({ organizationId: String(organizationId), patientId: String(patientId), reviewId: String(review!._id) });
    expect(result?.idempotent).toBe(false);
    expect(result?.summary.language).toBe('ml');
    expect(result?.summary.status).toBe('COMPLETED');
    expect(result?.summary.clinicianSummary).toContain('Medication adherence');
    expect(result?.summary.patientSummary).toContain('മരുന്ന്');
  });

  it('does not call AI twice for the same logical summary', async () => {
    mockAi();
    const review = await PatientReview.findOne({ organizationId, patientId }).lean();
    const first = await generatePatientReviewSummary({ organizationId: String(organizationId), patientId: String(patientId), reviewId: String(review!._id) });
    const second = await generatePatientReviewSummary({ organizationId: String(organizationId), patientId: String(patientId), reviewId: String(review!._id) });
    expect(first?.idempotent).toBe(false);
    expect(second?.idempotent).toBe(true);
    expect(String(first?.summary._id)).toBe(String(second?.summary._id));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(await PatientReviewSummary.countDocuments({ organizationId, reviewId: review!._id })).toBe(1);
  });

  it('keeps summaries tenant-scoped', async () => {
    const foreign = await Organization.create({ name: 'Foreign 3C3', type: 'CLINIC' });
    const review = await PatientReview.findOne({ organizationId, patientId }).lean();
    expect(await generatePatientReviewSummary({ organizationId: String(foreign._id), patientId: String(patientId), reviewId: String(review!._id) })).toBeNull();
    expect(await PatientReviewSummary.countDocuments({ organizationId: foreign._id })).toBe(0);
  });

  it('marks AI failure retryable without corrupting the patient review', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 503 })));
    const review = await PatientReview.findOne({ organizationId, patientId }).lean();
    await expect(generatePatientReviewSummary({ organizationId: String(organizationId), patientId: String(patientId), reviewId: String(review!._id) })).rejects.toThrow(/HTTP 503/);
    const failed = await PatientReviewSummary.findOne({ organizationId, reviewId: review!._id }).lean();
    expect(failed?.status).toBe('FAILED');
    const unchanged = await PatientReview.findById(review!._id).lean();
    expect(unchanged?.status).toBe('COMPLETED');
  });
});
