import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { ensureCarePlanExecution, attachCarePlanTasksToExecution, getCarePlanExecution, getMilestoneDay, transitionCarePlanMilestone } from '../care-plan-execution.js';
import { createHash } from 'node:crypto';
import { Router, raw, type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { env } from '../config.js';
import { issueAccessToken, requireOrganizationType, requireRoles, type AuthenticatedRequest } from '../auth.js';
import { enqueueOutboxEvent } from '../outbox.js';
import { listNotifications, markAllNotificationsRead, markNotificationRead } from '../notifications.js';
import { scheduleApexCareReferralEscalation, scheduleCarePlanReviewSla, scheduleCareTaskReminder, scheduleCoordinatorCallSla, scheduleHypertensionDraftGeneration, schedulePrescriptionAnalysis, schedulePrescriptionVerification } from '../queues.js';
import { buildHypertensionProgressSummary } from '../ai.js';
import { generateHypertensionVisitAssist } from '../visit-assist.js';
import { approveHypertensionCarePlanDraft, approveHypertensionCarePlanDraftAsApexCare, generateHypertensionCarePlanDraft } from '../ai-care-plan.js';
import { type MedicationCandidate } from '../prescription-analysis.js';
import { approveMedicationClinicalReview, escalateMedicationClinicalReview, openMedicationClinicalReview, rejectMedicationClinicalReview } from '../clinical-review.js';
import { completePatientReview, getPatientReview } from '../patient-review.js';
import { createCareTaskReminderCommunication, createPatientReviewReminderCommunication } from '../patient-communication.js';
import { listCoordinatorEscalations, resolveCoordinatorEscalation } from '../coordinator-escalation.js';
import { ensureLabClinicalSignals, listClinicalSignals, reviewClinicalSignal } from '../clinical-signal.js';
import { readPrescriptionImage, savePrescriptionImage } from '../storage.js';
import { createLabDocument } from '../lab-document.js';
import { ApexCareEnrollment, ApexCareGeneralHistory, ApexCareReferral, CarePlan, CarePlanDraft, CarePlanMilestone, CareTask, PatientCommunication, Diagnosis, DietitianAssessment, Organization, Patient, PatientClinicRelationship, PrescriptionDocument, MedicationDraft, MedicationRecord, MedicationHistory, ClinicalReviewCase, ClinicalReviewEvent, LabResult, ProgramConsent, Subscription, User, VitalRecord, OpdVisit, ServiceCase, VisitReview, PatientReview, LabDocument, LabInterpretation, type Role } from '../models.js';
import { APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION, APEX_GENERAL_HISTORY_QUESTIONS } from '../apexcare-general-history-questionnaire.js';

import * as Common from './shared.js';
const { conditionCodes, objectIdSchema, registerSchema, visitReviewSchema, patientReviewCompletionSchema, coordinatorEscalationResolutionSchema, coordinatorReviewContactSchema, loginSchema, passwordChangeSchema, clinicianPatientSchema, enrolPatientSchema, enrollmentProfileSchema, medicationDraftItemSchema, prescriptionDocumentSchema, medicationSubmitSchema, medicationFinalizeSchema, clinicalReviewDecisionSchema, apexCareClinicalReviewDecisionSchema, coordinatorCallSchema, apexGeneralHistoryAnswerSchema, apexGeneralHistorySaveSchema, medicationDraftCreateSchema, medicationDraftReviewSchema, dietitianAssessmentSchema, diagnosisRecordSchema, staffCreateSchema, staffStatusSchema, vitalRecordSchema, opdVisitSchema, carePlanAdjustmentSchema, taskCompleteSchema, serviceCaseSchema, serviceCaseQuerySchema, deactivatePatientSchema, carePlanSchema, parseOrReply, authContext, findApexCareOrganization, routeParam, findAccessiblePatient, publicRouter, protectedRouter, careTaskPriority, isDuplicateKey, reservePatientSlot, isKnownValidationError } = Common;

protectedRouter.post('/patients/:patientId/prescription-documents/:documentId/medication-drafts/:draftId/submit', requireRoles('CLINICIAN'), async (req: Request, res: Response, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(medicationSubmitSchema, req.body, res);
    if (!input) return;
    const patientId = routeParam(req.params.patientId, 'patientId');
    const documentId = routeParam(req.params.documentId, 'documentId');
    const draftId = routeParam(req.params.draftId, 'draftId');
    const document = await PrescriptionDocument.findOne({ _id: documentId, patientId, clinicOrganizationId: auth.organizationId }).lean();
    if (!document) { res.status(404).json({ error: { code: 'PRESCRIPTION_NOT_FOUND', message: 'Prescription document not found.' } }); return; }
    const draft = await MedicationDraft.findOne({ _id: draftId, prescriptionDocumentId: document._id, patientId, clinicOrganizationId: auth.organizationId });
    if (!draft) { res.status(404).json({ error: { code: 'MEDICATION_DRAFT_NOT_FOUND', message: 'Medication draft not found.' } }); return; }
    if (draft.status === 'DRAFT') { res.status(409).json({ error: { code: 'MEDICATION_DRAFT_ANALYSIS_PENDING', message: 'Prescription analysis is still running. Wait for the draft to reach VERIFICATION_REQUIRED before submitting it.' } }); return; }
    if (document.analysisStatus === 'FAILED') { res.status(409).json({ error: { code: 'PRESCRIPTION_ANALYSIS_FAILED', message: 'Prescription analysis failed. This prescription requires clinical review before medication submission.' } }); return; }
    if (draft.status === 'VERIFIED' || draft.status === 'VERIFYING') { res.status(409).json({ error: { code: 'MEDICATION_DRAFT_ALREADY_SUBMITTED', message: 'This medication draft has already been submitted or is currently being verified.' } }); return; }
    const medications: MedicationCandidate[] = input.medications.map((item) => ({ ...item }));
    draft.medications = medications;
    draft.staffSubmittedByUserId = auth.userId;
    draft.staffSubmittedAt = new Date();
    draft.clinicalReviewRequired = false;
    draft.clinicalReviewReason = undefined;
    draft.status = 'VERIFYING';
    await draft.save();

    let jobId: string;
    try {
      jobId = await schedulePrescriptionVerification(String(document._id), String(draft._id));
    } catch (queueError) {
      console.error('Prescription verification job could not be scheduled.', queueError);
      draft.status = 'VERIFICATION_REQUIRED';
      draft.clinicalReviewRequired = true;
      draft.clinicalReviewReason = 'Prescription verification could not be queued. Please retry the submission or review it manually.';
      await draft.save();
      const patient = await Patient.findOne({ _id: patientId, organizationId: auth.organizationId, status: 'ACTIVE' }).select('assignedClinicianId').lean();
      if (patient?.assignedClinicianId) {
        await openMedicationClinicalReview({
          patientId,
          clinicOrganizationId: auth.organizationId,
          apexcareOrganizationId: String(document.apexcareOrganizationId),
          prescriptionDocumentId: String(document._id),
          medicationDraftId: String(draft._id),
          clinicClinicianId: String(patient.assignedClinicianId),
          reasonCode: 'AI_VERIFICATION_FAILURE',
          reason: draft.clinicalReviewReason,
        });
      }
      res.status(503).json({ error: { code: 'PRESCRIPTION_VERIFICATION_QUEUE_UNAVAILABLE', message: 'The medication list was saved, but AI verification could not be queued. Please retry.', medicationDraftId: String(draft._id) } });
      return;
    }
    res.status(202).json({ data: { draft, prescriptionStatus: 'VERIFYING', analysisStatus: 'PENDING', jobId } });
  } catch (error) { next(error); }
});

protectedRouter.get('/clinical-review-queue', requireRoles('CLINICIAN'), async (req: Request, res: Response, next) => {
  try {
    const auth = authContext(req);
    const cases = await ClinicalReviewCase.find({
      clinicOrganizationId: auth.organizationId,
      clinicClinicianId: auth.userId,
      status: 'CLINICIAN_REVIEW',
    }).sort({ clinicReviewDueAt: 1, createdAt: 1 }).limit(200).lean();
    res.json({ data: cases });
  } catch (error) { next(error); }
});

protectedRouter.get('/clinical-review-cases/:caseId', requireRoles('CLINICIAN'), async (req: Request, res: Response, next) => {
  try {
    const auth = authContext(req);
    const reviewCase = await ClinicalReviewCase.findOne({
      _id: routeParam(req.params.caseId, 'caseId'),
      clinicOrganizationId: auth.organizationId,
      clinicClinicianId: auth.userId,
    }).lean();
    if (!reviewCase) { res.status(404).json({ error: { code: 'CLINICAL_REVIEW_CASE_NOT_FOUND', message: 'Clinical review case not found.' } }); return; }
    const [events, draft, document] = await Promise.all([
      ClinicalReviewEvent.find({ clinicalReviewCaseId: reviewCase._id }).sort({ createdAt: 1 }).lean(),
      MedicationDraft.findOne({ _id: reviewCase.medicationDraftId, prescriptionDocumentId: reviewCase.prescriptionDocumentId }).lean(),
      PrescriptionDocument.findOne({ _id: reviewCase.prescriptionDocumentId, patientId: reviewCase.patientId }).select('_id fileName mimeType status analysisStatus clinicalReviewReason createdAt').lean(),
    ]);
    res.json({ data: { reviewCase, draft, document, events } });
  } catch (error) { next(error); }
});

protectedRouter.patch('/clinical-review-cases/:caseId/decision', requireRoles('CLINICIAN'), async (req: Request, res: Response, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(clinicalReviewDecisionSchema, req.body, res);
    if (!input) return;
    const caseId = routeParam(req.params.caseId, 'caseId');
    const reviewCase = await ClinicalReviewCase.findOne({ _id: caseId, clinicOrganizationId: auth.organizationId, clinicClinicianId: auth.userId, status: 'CLINICIAN_REVIEW' });
    if (!reviewCase) { res.status(404).json({ error: { code: 'CLINICAL_REVIEW_CASE_NOT_FOUND', message: 'Clinical review case not found or is no longer awaiting clinic review.' } }); return; }
    if (input.decision === 'REJECT' && !input.reason) { res.status(422).json({ error: { code: 'REVIEW_REASON_REQUIRED', message: 'A reason is required when rejecting a clinical review case.' } }); return; }
    if (input.decision === 'ESCALATE_TO_APEXCARE' && !input.reason) { res.status(422).json({ error: { code: 'REVIEW_REASON_REQUIRED', message: 'A reason is required when escalating a clinical review case.' } }); return; }

    if (input.decision === 'APPROVE') {
      const result = await approveMedicationClinicalReview(caseId, auth.userId, 'CLINICIAN');
      if (!result) { res.status(409).json({ error: { code: 'CLINICAL_REVIEW_ALREADY_PROCESSED', message: 'This clinical review case has already been processed.' } }); return; }
      if ('error' in result) { res.status(409).json({ error: { code: result.error, message: 'The medication review context is no longer available.' } }); return; }
      res.json({ data: result });
      return;
    }

    if (input.decision === 'REJECT') {
      const result = await rejectMedicationClinicalReview(caseId, auth.userId, 'CLINICIAN', input.reason!);
      if (!result) { res.status(409).json({ error: { code: 'CLINICAL_REVIEW_ALREADY_PROCESSED', message: 'This clinical review case has already been processed.' } }); return; }
      res.json({ data: result });
      return;
    }

    const result = await escalateMedicationClinicalReview(caseId, auth.userId, 'CLINICIAN', input.reason!);
    if (!result) { res.status(409).json({ error: { code: 'CLINICAL_REVIEW_ALREADY_PROCESSED', message: 'This clinical review case has already been processed.' } }); return; }
    res.json({ data: result });
  } catch (error) { next(error); }
});

protectedRouter.get('/apexcare/clinical-review-queue', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_DOCTOR'), async (req: Request, res: Response, next) => {
  try {
    const auth = authContext(req);
    const cases = await ClinicalReviewCase.find({ apexcareOrganizationId: auth.organizationId, status: 'APEXCARE_REVIEW' })
      .sort({ clinicReviewDueAt: 1, createdAt: 1 }).limit(200).lean();
    res.json({ data: cases });
  } catch (error) { next(error); }
});

protectedRouter.patch('/apexcare/clinical-review-cases/:caseId/claim', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_DOCTOR'), async (req: Request, res: Response, next) => {
  try {
    const auth = authContext(req);
    const caseId = routeParam(req.params.caseId, 'caseId');
    const reviewCase = await ClinicalReviewCase.findOneAndUpdate(
      { _id: caseId, apexcareOrganizationId: auth.organizationId, status: 'APEXCARE_REVIEW', $or: [{ apexcareAssignedUserId: { $exists: false } }, { apexcareAssignedUserId: null }] },
      { $set: { apexcareAssignedUserId: auth.userId } },
      { new: true },
    ).lean();
    if (!reviewCase) { res.status(409).json({ error: { code: 'CLINICAL_REVIEW_UNAVAILABLE', message: 'The clinical review case is unavailable or already assigned.' } }); return; }
    await ClinicalReviewEvent.create({
      clinicalReviewCaseId: reviewCase._id,
      patientId: reviewCase.patientId,
      clinicOrganizationId: reviewCase.clinicOrganizationId,
      apexcareOrganizationId: reviewCase.apexcareOrganizationId,
      eventType: 'CLAIMED',
      fromStatus: 'APEXCARE_REVIEW',
      toStatus: 'APEXCARE_REVIEW',
      actorUserId: auth.userId,
      actorType: 'APEXCARE_DOCTOR',
      reason: 'ApexCare doctor claimed the clinical review case.',
    });
    res.json({ data: reviewCase });
  } catch (error) { next(error); }
});

protectedRouter.patch('/apexcare/clinical-review-cases/:caseId/decision', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_DOCTOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(apexCareClinicalReviewDecisionSchema, req.body, res);
    if (!input) return;
    const caseId = routeParam(req.params.caseId, 'caseId');
    const reviewCase = await ClinicalReviewCase.findOne({ _id: caseId, apexcareOrganizationId: auth.organizationId, status: 'APEXCARE_REVIEW' });
    if (!reviewCase) { res.status(404).json({ error: { code: 'CLINICAL_REVIEW_CASE_NOT_FOUND', message: 'Clinical review case not found or is no longer awaiting ApexCare review.' } }); return; }
    if (!reviewCase.apexcareAssignedUserId || String(reviewCase.apexcareAssignedUserId) !== auth.userId) { res.status(403).json({ error: { code: 'CLINICAL_REVIEW_NOT_ASSIGNED', message: 'This clinical review case is not assigned to you.' } }); return; }
    if (input.decision === 'REJECT' && !input.reason) { res.status(422).json({ error: { code: 'REVIEW_REASON_REQUIRED', message: 'A reason is required when rejecting a clinical review case.' } }); return; }

    if (input.decision === 'APPROVE') {
      const result = await approveMedicationClinicalReview(caseId, auth.userId, 'APEXCARE_DOCTOR');
      if (!result) { res.status(409).json({ error: { code: 'CLINICAL_REVIEW_ALREADY_PROCESSED', message: 'This clinical review case has already been processed.' } }); return; }
      if ('error' in result) { res.status(409).json({ error: { code: result.error, message: 'The medication review context is no longer available.' } }); return; }
      res.json({ data: result });
      return;
    }

    const result = await rejectMedicationClinicalReview(caseId, auth.userId, 'APEXCARE_DOCTOR', input.reason!);
    if (!result) { res.status(409).json({ error: { code: 'CLINICAL_REVIEW_ALREADY_PROCESSED', message: 'This clinical review case has already been processed.' } }); return; }
    res.json({ data: result });
  } catch (error) { next(error); }
});

protectedRouter.get('/apexcare/clinical-review-cases/:caseId', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_DOCTOR'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = authContext(req);
    const reviewCase = await ClinicalReviewCase.findOne({ _id: routeParam(req.params.caseId, 'caseId'), apexcareOrganizationId: auth.organizationId }).lean();
    if (!reviewCase) { res.status(404).json({ error: { code: 'CLINICAL_REVIEW_CASE_NOT_FOUND', message: 'Clinical review case not found.' } }); return; }
    const [events, draft, document] = await Promise.all([
      ClinicalReviewEvent.find({ clinicalReviewCaseId: reviewCase._id }).sort({ createdAt: 1 }).lean(),
      MedicationDraft.findOne({ _id: reviewCase.medicationDraftId, prescriptionDocumentId: reviewCase.prescriptionDocumentId }).lean(),
      PrescriptionDocument.findOne({ _id: reviewCase.prescriptionDocumentId, patientId: reviewCase.patientId }).select('_id fileName mimeType status analysisStatus clinicalReviewReason createdAt').lean(),
    ]);
    res.json({ data: { reviewCase, draft, document, events } });
  } catch (error) { next(error); }
});

protectedRouter.post('/patients/:patientId/prescription-documents/:documentId/medication-drafts/:draftId/finalize', requireRoles('CLINICIAN'), async (req: Request, res: Response, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(medicationFinalizeSchema, req.body ?? {}, res);
    if (!input) return;
    const patientId = routeParam(req.params.patientId, 'patientId');
    const documentId = routeParam(req.params.documentId, 'documentId');
    const draftId = routeParam(req.params.draftId, 'draftId');
    const document = await PrescriptionDocument.findOne({ _id: documentId, patientId, clinicOrganizationId: auth.organizationId }).lean();
    if (!document) { res.status(404).json({ error: { code: 'PRESCRIPTION_NOT_FOUND', message: 'Prescription document not found.' } }); return; }
    const draft = await MedicationDraft.findOne({ _id: draftId, prescriptionDocumentId: document._id, patientId, clinicOrganizationId: auth.organizationId, status: 'VERIFIED' }).lean();
    if (!draft) { res.status(409).json({ error: { code: 'MEDICATION_DRAFT_NOT_VERIFIED', message: 'Only a verified medication draft can become a medication record.' } }); return; }
    if (draft.clinicalReviewRequired) { res.status(409).json({ error: { code: 'MEDICATION_DRAFT_REQUIRES_CLINICAL_REVIEW', message: 'Clinical review is required before medication records can be created.' } }); return; }
    const openReview = await ClinicalReviewCase.findOne({ medicationDraftId: draft._id, status: { $in: ['CLINICIAN_REVIEW', 'APEXCARE_REVIEW'] } }).select('_id').lean();
    if (openReview) { res.status(409).json({ error: { code: 'CLINICAL_REVIEW_PENDING', message: 'This medication draft has an unresolved clinical review.' } }); return; }

    const created: Array<{ recordId: string; medicationName: string }> = [];
    for (const medication of draft.medications) {
      const medicationKey = createHash('sha256').update([medication.name, medication.strength ?? '', medication.route ?? ''].map((v) => v.trim().toLowerCase()).join('|')).digest('hex');
      const existing = await MedicationRecord.findOne({ patientId, medicationKey, status: 'ACTIVE', clinicOrganizationId: auth.organizationId });
      if (existing) continue;
      const record = await MedicationRecord.create({
        patientId, clinicOrganizationId: auth.organizationId, apexcareOrganizationId: document.apexcareOrganizationId,
        prescriptionDocumentId: document._id, medicationDraftId: draft._id, name: medication.name, strength: medication.strength, dose: medication.dose, route: medication.route, frequency: medication.frequency, duration: medication.duration, instructions: medication.instructions, status: 'ACTIVE',
        startedAt: new Date(), createdByUserId: auth.userId, updatedByUserId: auth.userId, medicationKey,
      });
      await MedicationHistory.create({
        patientId, clinicOrganizationId: auth.organizationId, apexcareOrganizationId: document.apexcareOrganizationId,
        medicationRecordId: record._id, prescriptionDocumentId: document._id, medicationDraftId: draft._id, version: 1, action: 'CREATED',
        snapshot: { ...medication, status: 'ACTIVE' }, reason: input.reason, changedByUserId: auth.userId,
      });
      created.push({ recordId: String(record._id), medicationName: medication.name });
    }
    res.status(201).json({ data: { medicationRecords: created, sourceDraftId: String(draft._id) } });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/medications', requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR', 'CLINICIAN'), async (req: Request, res: Response, next) => {
  try {
    const auth = authContext(req);
    const patientId = routeParam(req.params.patientId, 'patientId');
    const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const medications = await MedicationRecord.find({ patientId, clinicOrganizationId: auth.organizationId }).sort({ status: 1, createdAt: -1 }).lean();
    res.json({ data: medications });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/medication-history', requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR', 'CLINICIAN'), async (req: Request, res: Response, next) => {
  try {
    const auth = authContext(req);
    const patientId = routeParam(req.params.patientId, 'patientId');
    const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const history = await MedicationHistory.find({ patientId, clinicOrganizationId: auth.organizationId }).sort({ changedAt: -1 }).limit(200).lean();
    res.json({ data: history });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/prescription-documents/:documentId/medication-drafts', requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR', 'CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patientId = routeParam(req.params.patientId, 'patientId');
    const documentId = routeParam(req.params.documentId, 'documentId');
    const document = await PrescriptionDocument.findOne({ _id: documentId, patientId, clinicOrganizationId: auth.organizationId }).select('_id').lean();
    if (!document) { res.status(404).json({ error: { code: 'PRESCRIPTION_DOCUMENT_NOT_FOUND', message: 'Prescription document not found.' } }); return; }
    const drafts = await MedicationDraft.find({ prescriptionDocumentId: document._id, clinicOrganizationId: auth.organizationId }).sort({ createdAt: -1 }).limit(20).lean();
    res.json({ data: drafts });
  } catch (error) { next(error); }
});

protectedRouter.post('/patients/:patientId/prescription-documents/:documentId/medication-drafts', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(medicationDraftCreateSchema, req.body, res);
    if (!input) return;
    const patientId = routeParam(req.params.patientId, 'patientId');
    const documentId = routeParam(req.params.documentId, 'documentId');
    const document = await PrescriptionDocument.findOne({ _id: documentId, patientId, clinicOrganizationId: auth.organizationId }).select('_id apexcareOrganizationId status').lean();
    if (!document) { res.status(404).json({ error: { code: 'PRESCRIPTION_DOCUMENT_NOT_FOUND', message: 'Prescription document not found.' } }); return; }
    if (document.status === 'NEEDS_CLINICAL_REVIEW') { res.status(409).json({ error: { code: 'PRESCRIPTION_REQUIRES_CLINICAL_REVIEW', message: 'This prescription document requires clinical review before medication extraction can proceed.' } }); return; }
    if (!input.medications.length && !input.rawText) { res.status(422).json({ error: { code: 'MEDICATION_DRAFT_EMPTY', message: 'Provide extracted prescription text or at least one medication candidate.' } }); return; }
    const draft = await MedicationDraft.create({
      patientId,
      clinicOrganizationId: auth.organizationId,
      apexcareOrganizationId: document.apexcareOrganizationId,
      prescriptionDocumentId: document._id,
      extractionSource: input.extractionSource,
      status: 'VERIFICATION_REQUIRED',
      rawText: input.rawText,
      medications: input.medications,
      extractedByUserId: auth.userId,
    });
    await PrescriptionDocument.updateOne({ _id: document._id, clinicOrganizationId: auth.organizationId }, { $set: { status: 'VERIFICATION_REQUIRED' } });
    res.status(201).json({ data: draft });
  } catch (error) { next(error); }
});

protectedRouter.patch('/patients/:patientId/prescription-documents/:documentId/medication-drafts/:draftId', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(medicationDraftReviewSchema, req.body, res);
    if (!input) return;
    const patientId = routeParam(req.params.patientId, 'patientId');
    const documentId = routeParam(req.params.documentId, 'documentId');
    const draftId = routeParam(req.params.draftId, 'draftId');
    const draft = await MedicationDraft.findOne({ _id: draftId, patientId, prescriptionDocumentId: documentId, clinicOrganizationId: auth.organizationId, status: 'VERIFICATION_REQUIRED' });
    if (!draft) { res.status(404).json({ error: { code: 'MEDICATION_DRAFT_NOT_FOUND', message: 'Medication draft not found or already reviewed.' } }); return; }
    if (input.status !== 'REJECTED') { res.status(409).json({ error: { code: 'SUBMIT_REQUIRED', message: 'Medication drafts must be submitted through the prescription verification workflow.' } }); return; }
    if (!input.rejectionReason) { res.status(422).json({ error: { code: 'REJECTION_REASON_REQUIRED', message: 'A rejection reason is required.' } }); return; }
    draft.status = 'REJECTED';
    draft.clinicalReviewRequired = true;
    draft.clinicalReviewReason = input.rejectionReason;
    draft.rejectionReason = input.rejectionReason;
    await draft.save();
    await PrescriptionDocument.updateOne({ _id: documentId, clinicOrganizationId: auth.organizationId }, { $set: { status: 'NEEDS_CLINICAL_REVIEW', clinicalReviewReason: input.rejectionReason } });
    const patient = await Patient.findOne({ _id: patientId, organizationId: auth.organizationId, status: 'ACTIVE' }).select('assignedClinicianId').lean();
    if (patient?.assignedClinicianId) {
      await openMedicationClinicalReview({
        patientId,
        clinicOrganizationId: auth.organizationId,
        apexcareOrganizationId: String(draft.apexcareOrganizationId),
        prescriptionDocumentId: documentId,
        medicationDraftId: draftId,
        clinicClinicianId: String(patient.assignedClinicianId),
        reasonCode: 'STAFF_REJECTED',
        reason: input.rejectionReason,
      });
    }
    res.json({ data: draft });
  } catch (error) { next(error); }
});

protectedRouter.get('/apexcare/patients/:patientId/prescription-documents/:documentId/image', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_DOCTOR'), async (req: Request, res: Response, next) => {
  try {
    const auth = authContext(req);
    const patientId = routeParam(req.params.patientId, 'patientId');
    const documentId = routeParam(req.params.documentId, 'documentId');
    const reviewCase = await ClinicalReviewCase.findOne({
      patientId,
      prescriptionDocumentId: documentId,
      apexcareOrganizationId: auth.organizationId,
      status: 'APEXCARE_REVIEW',
    }).select('_id apexcareAssignedUserId').lean();
    if (!reviewCase) { res.status(404).json({ error: { code: 'CLINICAL_REVIEW_CASE_NOT_FOUND', message: 'No active ApexCare clinical review case exists for this prescription.' } }); return; }
    if (reviewCase.apexcareAssignedUserId && String(reviewCase.apexcareAssignedUserId) !== auth.userId) {
      res.status(403).json({ error: { code: 'CLINICAL_REVIEW_NOT_ASSIGNED', message: 'This clinical review case is assigned to another ApexCare doctor.' } }); return;
    }
    const document = await PrescriptionDocument.findOne({ _id: documentId, patientId, apexcareOrganizationId: auth.organizationId }).select('storageKey storageProvider mimeType fileName').lean();
    if (!document) { res.status(404).json({ error: { code: 'PRESCRIPTION_DOCUMENT_NOT_FOUND', message: 'Prescription document not found.' } }); return; }
    const image = await readPrescriptionImage(document.storageKey, document.storageProvider);
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Disposition', `inline; filename=\"${document.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}\"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(image);
  } catch (error) { next(error); }
});

