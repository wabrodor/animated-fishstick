import { Types } from 'mongoose';
import { ClinicalReviewCase, ClinicalReviewEvent, MedicationDraft, PrescriptionDocument, Patient } from './models.js';
import { scheduleClinicalReviewSla } from './queues.js';
import { enqueueOutboxEvent } from './outbox.js';

const toObjectId = (value: string) => new Types.ObjectId(value);

export type MedicationClinicalReviewReason =
  | 'AI_VERIFICATION_REQUIRED'
  | 'AI_DISCREPANCY'
  | 'AI_ANALYSIS_FAILURE'
  | 'AI_VERIFICATION_FAILURE'
  | 'STAFF_REJECTED';

export async function openMedicationClinicalReview(params: {
  patientId: string;
  clinicOrganizationId: string;
  apexcareOrganizationId: string;
  prescriptionDocumentId: string;
  medicationDraftId: string;
  clinicClinicianId: string;
  reasonCode: MedicationClinicalReviewReason;
  reason: string;
}): Promise<void> {
  const now = new Date();
  const clinicReviewDueAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const existing = await ClinicalReviewCase.findOne({ medicationDraftId: params.medicationDraftId });
  if (existing) {
    if (existing.status === 'CLINICIAN_REVIEW' && existing.reason !== params.reason) {
      existing.reason = params.reason;
      existing.reasonCode = params.reasonCode;
      await existing.save();
    }
    return;
  }

  let reviewCase;
  try {
    reviewCase = await ClinicalReviewCase.create({
      patientId: params.patientId,
      clinicOrganizationId: params.clinicOrganizationId,
      apexcareOrganizationId: params.apexcareOrganizationId,
      prescriptionDocumentId: params.prescriptionDocumentId,
      medicationDraftId: params.medicationDraftId,
      clinicClinicianId: params.clinicClinicianId,
      reasonCode: params.reasonCode,
      reason: params.reason,
      status: 'CLINICIAN_REVIEW',
      clinicReviewDueAt,
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: number }).code === 11000) return;
    throw error;
  }

  await ClinicalReviewEvent.create({
    clinicalReviewCaseId: reviewCase._id,
    patientId: params.patientId,
    clinicOrganizationId: params.clinicOrganizationId,
    apexcareOrganizationId: params.apexcareOrganizationId,
    eventType: 'OPENED',
    fromStatus: null,
    toStatus: 'CLINICIAN_REVIEW',
    actorType: 'SYSTEM',
    reason: params.reason,
  });

  try {
    await scheduleClinicalReviewSla(String(reviewCase._id), clinicReviewDueAt);
  } catch (error) {
    console.error('Clinical review SLA could not be scheduled.', error);
  }
  const patient = await Patient.findById(params.patientId).select('name').lean();
  await enqueueOutboxEvent({
    organizationId: params.clinicOrganizationId,
    eventKey: `clinical-review-opened:${reviewCase._id}`,
    eventType: 'CLINICAL_REVIEW_OPENED',
    aggregateType: 'ClinicalReviewCase',
    aggregateId: String(reviewCase._id),
    payload: { patientId: params.patientId, patientName: `${patient?.name.first ?? 'Patient'} ${patient?.name.last ?? ''}`.trim(), clinicianId: params.clinicClinicianId, clinicalReviewCaseId: String(reviewCase._id) },
  });
}


async function notifyClinicalReviewDecision(reviewCase: { _id: unknown; patientId: unknown; clinicOrganizationId: unknown; clinicClinicianId: unknown }, decision: string) {
  const patient = await Patient.findById(reviewCase.patientId).select('name').lean();
  await enqueueOutboxEvent({
    organizationId: String(reviewCase.clinicOrganizationId),
    eventKey: `clinical-review-decision:${reviewCase._id}:${decision}`,
    eventType: 'CLINICAL_REVIEW_DECIDED',
    aggregateType: 'ClinicalReviewCase',
    aggregateId: String(reviewCase._id),
    payload: { patientId: String(reviewCase.patientId), patientName: `${patient?.name.first ?? 'Patient'} ${patient?.name.last ?? ''}`.trim(), clinicianId: String(reviewCase.clinicClinicianId), decision },
  });
}

export async function approveMedicationClinicalReview(reviewCaseId: string, actorUserId: string, actorType: 'CLINICIAN' | 'APEXCARE_DOCTOR') {
  const reviewCase = await ClinicalReviewCase.findOne({ _id: reviewCaseId, status: { $in: ['CLINICIAN_REVIEW', 'APEXCARE_REVIEW'] } });
  if (!reviewCase) return null;

  const draft = await MedicationDraft.findOne({ _id: reviewCase.medicationDraftId, prescriptionDocumentId: reviewCase.prescriptionDocumentId });
  const document = await PrescriptionDocument.findOne({ _id: reviewCase.prescriptionDocumentId, patientId: reviewCase.patientId });
  if (!draft || !document) return { error: 'REVIEW_CONTEXT_NOT_FOUND' as const };
  if (draft.status === 'REJECTED') return { error: 'MEDICATION_DRAFT_REJECTED' as const };

  const previousStatus = reviewCase.status;
  reviewCase.status = 'APPROVED';
  reviewCase.decision = 'APPROVED';
  reviewCase.decisionReason = 'Medication list approved after clinical review.';
  reviewCase.reviewedByUserId = actorUserId;
  reviewCase.reviewedAt = new Date();
  if (actorType === 'CLINICIAN') reviewCase.clinicReviewedAt = new Date();
  else reviewCase.apexcareReviewedAt = new Date();
  await reviewCase.save();

  draft.status = 'VERIFIED';
  draft.clinicalReviewRequired = false;
  draft.clinicalReviewReason = undefined;
  draft.verifiedByUserId = toObjectId(actorUserId);
  draft.verifiedAt = new Date();
  await draft.save();

  document.status = 'VERIFIED';
  document.analysisStatus = 'COMPLETED';
  document.clinicalReviewReason = undefined;
  document.verifiedByUserId = toObjectId(actorUserId);
  document.verifiedAt = new Date();
  await document.save();

  await ClinicalReviewEvent.create({
    clinicalReviewCaseId: reviewCase._id,
    patientId: reviewCase.patientId,
    clinicOrganizationId: reviewCase.clinicOrganizationId,
    apexcareOrganizationId: reviewCase.apexcareOrganizationId,
    eventType: 'DECISION',
    fromStatus: previousStatus,
    toStatus: 'APPROVED',
    actorUserId,
    actorType,
    decision: 'APPROVED',
    reason: reviewCase.decisionReason,
  });

  await notifyClinicalReviewDecision(reviewCase, 'APPROVED');
  return reviewCase.toObject();
}

export async function rejectMedicationClinicalReview(reviewCaseId: string, actorUserId: string, actorType: 'CLINICIAN' | 'APEXCARE_DOCTOR', reason: string) {
  const reviewCase = await ClinicalReviewCase.findOne({ _id: reviewCaseId, status: { $in: ['CLINICIAN_REVIEW', 'APEXCARE_REVIEW'] } });
  if (!reviewCase) return null;

  const previousStatus = reviewCase.status;
  reviewCase.status = 'REJECTED';
  reviewCase.decision = 'REJECTED';
  reviewCase.decisionReason = reason;
  reviewCase.reviewedByUserId = toObjectId(actorUserId);
  reviewCase.reviewedAt = new Date();
  if (actorType === 'CLINICIAN') reviewCase.clinicReviewedAt = new Date();
  else reviewCase.apexcareReviewedAt = new Date();
  await reviewCase.save();

  await MedicationDraft.updateOne(
    { _id: reviewCase.medicationDraftId, prescriptionDocumentId: reviewCase.prescriptionDocumentId },
    { $set: { status: 'REJECTED', clinicalReviewRequired: true, clinicalReviewReason: reason, rejectionReason: reason } },
  );
  await PrescriptionDocument.updateOne(
    { _id: reviewCase.prescriptionDocumentId, patientId: reviewCase.patientId },
    { $set: { status: 'NEEDS_CLINICAL_REVIEW', clinicalReviewReason: reason } },
  );

  await ClinicalReviewEvent.create({
    clinicalReviewCaseId: reviewCase._id,
    patientId: reviewCase.patientId,
    clinicOrganizationId: reviewCase.clinicOrganizationId,
    apexcareOrganizationId: reviewCase.apexcareOrganizationId,
    eventType: 'DECISION',
    fromStatus: previousStatus,
    toStatus: 'REJECTED',
    actorUserId,
    actorType,
    decision: 'REJECTED',
    reason,
  });

  await notifyClinicalReviewDecision(reviewCase, 'REJECTED');
  return reviewCase.toObject();
}

export async function escalateMedicationClinicalReview(reviewCaseId: string, actorUserId: string, actorType: 'CLINICIAN', reason: string) {
  const reviewCase = await ClinicalReviewCase.findOne({ _id: reviewCaseId, status: 'CLINICIAN_REVIEW' });
  if (!reviewCase) return null;

  reviewCase.status = 'APEXCARE_REVIEW';
  reviewCase.decision = 'ESCALATED';
  reviewCase.decisionReason = reason;
  reviewCase.clinicReviewedAt = new Date();
  reviewCase.apexcareEscalatedAt = new Date();
  await reviewCase.save();

  await ClinicalReviewEvent.create({
    clinicalReviewCaseId: reviewCase._id,
    patientId: reviewCase.patientId,
    clinicOrganizationId: reviewCase.clinicOrganizationId,
    apexcareOrganizationId: reviewCase.apexcareOrganizationId,
    eventType: 'ESCALATED',
    fromStatus: 'CLINICIAN_REVIEW',
    toStatus: 'APEXCARE_REVIEW',
    actorUserId,
    actorType,
    decision: 'ESCALATED',
    reason,
  });

  await notifyClinicalReviewDecision(reviewCase, 'ESCALATED');
  return reviewCase.toObject();
}
