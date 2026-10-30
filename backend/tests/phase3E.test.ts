import { describe, expect, beforeAll, afterAll, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { CarePlan, CarePlanExecution, ClinicalSignal, LabInterpretation, Organization, Patient, PatientReview } from '../models.js';
import { ensureLabClinicalSignals, ensureAdherenceClinicalSignal, reviewClinicalSignal } from '../clinical-signal.js';

let mongo: MongoMemoryServer;
let organizationId: mongoose.Types.ObjectId;
let patientId: mongoose.Types.ObjectId;
let clinicianId: mongoose.Types.ObjectId;
let carePlanId: mongoose.Types.ObjectId;
let executionId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  organizationId = new mongoose.Types.ObjectId();
  patientId = new mongoose.Types.ObjectId();
  clinicianId = new mongoose.Types.ObjectId();
  carePlanId = new mongoose.Types.ObjectId();
  executionId = new mongoose.Types.ObjectId();
  await Organization.create({ _id: organizationId, name: '3E Org', type: 'CLINIC' });
  await Patient.create({ _id: patientId, organizationId, status: 'ACTIVE', assignedClinicianId: clinicianId, medicalRecordNumber: '3E-MRN-001', name: { first: 'Test', last: 'Patient' }, preferredLanguage: 'ml' });
  await CarePlan.create({ _id: carePlanId, organizationId, patientId, condition: 'HYPERTENSION', status: 'ACTIVE', goals: [], createdByUserId: clinicianId, startDate: new Date(), endDate: new Date(Date.now()+86400000) });
  await CarePlanExecution.create({ _id: executionId, organizationId, patientId, carePlanId, condition: 'HYPERTENSION', status: 'ACTIVE', startDate: new Date(), endDate: new Date(Date.now()+86400000), activationKey: '3e-execution' });
});

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('Phase 3E clinical feedback loop', () => {
  it('creates lab signals idempotently after clinician-approved interpretation', async () => {
    const interpretation = await LabInterpretation.create({ organizationId, apexcareOrganizationId: organizationId, patientId, labDocumentId: new mongoose.Types.ObjectId(), interpretationKey: '3e-lab-1', interpretationVersion: 1, provider: 'test', model: 'test', patientLanguage: 'ml', clinicianSummary: 'HbA1c elevated', patientSummary: 'Sugar is high', suggestedDiscussionPoints: ['Review control'], urgentReview: true, confidence: 0.9, status: 'READY', clinicianReviewStatus: 'APPROVED' });
    const first = await ensureLabClinicalSignals({ organizationId: String(organizationId), patientId: String(patientId), interpretationId: String(interpretation._id) });
    const second = await ensureLabClinicalSignals({ organizationId: String(organizationId), patientId: String(patientId), interpretationId: String(interpretation._id) });
    expect(first.created).toBe(2);
    expect(second.created).toBe(0);
    expect(await ClinicalSignal.countDocuments({ organizationId })).toBe(2);
  });

  it('enforces assigned-clinician review security and creates one follow-up task', async () => {
    const review = await PatientReview.create({ organizationId, patientId, carePlanId, executionId, milestoneId: new mongoose.Types.ObjectId(), reviewKey: '3e-review', status: 'COMPLETED', dueAt: new Date(), adherenceSnapshot: { periodStartAt: new Date(), periodEndAt: new Date(), totalDueTasks: 10, completedTasks: 2, skippedTasks: 0, overdueTasks: 4, pendingTasks: 4, completionRate: 0.2, actionedRate: 0.6, byType: {}, generatedAt: new Date() } });
    const signalResult = await ensureAdherenceClinicalSignal({ organizationId: String(organizationId), patientId: String(patientId), reviewId: String(review._id) });
    expect(signalResult?.created).toBe(1);
    const forbidden = await reviewClinicalSignal({ organizationId: String(organizationId), signalId: String(signalResult?.signal?._id), clinicianUserId: String(new mongoose.Types.ObjectId()), decision: 'ACTION_REQUIRED' });
    expect(forbidden).toBeNull();
    const reviewed = await reviewClinicalSignal({ organizationId: String(organizationId), signalId: String(signalResult?.signal?._id), clinicianUserId: String(clinicianId), decision: 'ACTION_REQUIRED', notes: 'Contact patient.' });
    expect(reviewed?.task).toBeTruthy();
    const reviewedAgain = await reviewClinicalSignal({ organizationId: String(organizationId), signalId: String(signalResult?.signal?._id), clinicianUserId: String(clinicianId), decision: 'ACTION_REQUIRED' });
    expect(reviewedAgain).toBeNull();
    const { CareTask } = await import('../models.js');
    expect(await CareTask.countDocuments({ executionId, taskKey: `CLINICAL_SIGNAL:${signalResult?.signal?._id}` })).toBe(1);
  });
});
