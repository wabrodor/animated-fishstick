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
import { scheduleApexCareReferralEscalation, scheduleCarePlanReviewSla, scheduleCareTaskReminder, scheduleCoordinatorCallSla, scheduleHypertensionDraftGeneration, schedulePrescriptionAnalysis, schedulePrescriptionVerification, scheduleLabDocumentExtraction, scheduleLabResultStructuring } from '../queues.js';
import { buildHypertensionProgressSummary } from '../ai.js';
import { generateHypertensionVisitAssist } from '../visit-assist.js';
import { approveHypertensionCarePlanDraft, approveHypertensionCarePlanDraftAsApexCare, generateHypertensionCarePlanDraft } from '../ai-care-plan.js';
import { type MedicationCandidate } from '../prescription-analysis.js';
import { approveMedicationClinicalReview, escalateMedicationClinicalReview, openMedicationClinicalReview, rejectMedicationClinicalReview } from '../clinical-review.js';
import { completePatientReview, getPatientReview } from '../patient-review.js';
import { createCareTaskReminderCommunication, createPatientReviewReminderCommunication } from '../patient-communication.js';
import { listCoordinatorEscalations, resolveCoordinatorEscalation } from '../coordinator-escalation.js';
import { ensureLabClinicalSignals, listClinicalSignals, reviewClinicalSignal } from '../clinical-signal.js';
import { deletePrescriptionImage, readLabPdf, readPrescriptionImage, savePrescriptionImage } from '../storage.js';
import { createLabDocument } from '../lab-document.js';
import { ApexCareEnrollment, ApexCareGeneralHistory, ApexCareReferral, CarePlan, CarePlanDraft, CarePlanMilestone, CareTask, PatientCommunication, Diagnosis, DietitianAssessment, Organization, Patient, PatientClinicRelationship, PrescriptionDocument, MedicationDraft, MedicationRecord, MedicationHistory, ClinicalReviewCase, ClinicalReviewEvent, LabResult, ProgramConsent, Subscription, User, VitalRecord, OpdVisit, ServiceCase, VisitReview, PatientReview, LabDocument, LabInterpretation, type Role } from '../models.js';
import { APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION, APEX_GENERAL_HISTORY_QUESTIONS } from '../apexcare-general-history-questionnaire.js';

import * as Common from './shared.js';
const { conditionCodes, objectIdSchema, registerSchema, visitReviewSchema, patientReviewCompletionSchema, coordinatorEscalationResolutionSchema, coordinatorReviewContactSchema, loginSchema, passwordChangeSchema, clinicianPatientSchema, enrolPatientSchema, enrollmentProfileSchema, medicationDraftItemSchema, prescriptionDocumentSchema, medicationSubmitSchema, medicationFinalizeSchema, clinicalReviewDecisionSchema, apexCareClinicalReviewDecisionSchema, coordinatorCallSchema, apexGeneralHistoryAnswerSchema, apexGeneralHistorySaveSchema, medicationDraftCreateSchema, medicationDraftReviewSchema, dietitianAssessmentSchema, diagnosisRecordSchema, staffCreateSchema, staffStatusSchema, vitalRecordSchema, opdVisitSchema, carePlanAdjustmentSchema, taskCompleteSchema, serviceCaseSchema, serviceCaseQuerySchema, deactivatePatientSchema, carePlanSchema, hypertensionDraftPlanSchema, parseOrReply, authContext, findApexCareOrganization, routeParam, findAccessiblePatient, publicRouter, protectedRouter, careTaskPriority, isDuplicateKey, reservePatientSlot, isKnownValidationError } = Common;

protectedRouter.get('/patients', requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const filter: Record<string, unknown> = { organizationId: auth.organizationId, status: 'ACTIVE' };
    if (auth.roles.includes('CLINICIAN') && !auth.roles.includes('CLINIC_ADMIN') && !auth.roles.includes('CLINIC_COORDINATOR')) filter.assignedClinicianId = auth.userId;
    const patients = await Patient.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ data: patients });
  } catch (error) { next(error); }
});

protectedRouter.get('/subscription', requireRoles('CLINIC_ADMIN'), async (req: Request, res, next) => {
  try {
    const subscription = await Subscription.findOne({ organizationId: authContext(req).organizationId }).lean();
    if (!subscription) { res.status(404).json({ error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription not found.' } }); return; }
    res.json({ data: { planCode: subscription.planCode, status: subscription.status, activePatientLimit: subscription.activePatientLimit, activePatientCount: subscription.activePatientCount, availablePatientSlots: Math.max(0, subscription.activePatientLimit - subscription.activePatientCount), currentPeriodStart: subscription.currentPeriodStart, currentPeriodEnd: subscription.currentPeriodEnd } });
  } catch (error) { next(error); }
});

protectedRouter.post('/patients', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(clinicianPatientSchema, req.body, res);
    if (!input) return;
    const assignedClinicianId = input.assignedClinicianId ?? auth.userId;
    if (assignedClinicianId !== auth.userId) {
      res.status(403).json({ error: { code: 'PATIENT_CLINICIAN_MISMATCH', message: 'A clinician can create a diagnosis record only for their own assigned patient.' } }); return;
    }
    const clinician = await User.exists({ _id: auth.userId, organizationId: auth.organizationId, status: 'ACTIVE', roles: 'CLINICIAN' });
    if (!clinician) { res.status(403).json({ error: { code: 'CLINICIAN_REQUIRED', message: 'An active clinician account is required.' } }); return; }
    const patient = await Patient.create({
      organizationId: auth.organizationId,
      medicalRecordNumber: input.medicalRecordNumber ?? `AC-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: input.name,
      ageAtRegistration: input.ageAtRegistration,
      sexAtBirth: input.sexAtBirth,
      phone: input.phone,
      whatsapp: input.whatsapp,
      preferredLanguage: input.preferredLanguage,
      preferredContactChannel: input.preferredContactChannel,
      assignedClinicianId,
      conditions: [{ code: input.diagnosis.condition, status: 'CONFIRMED', diagnosedAt: input.diagnosis.diagnosedAt ?? new Date() }],
      enrollmentStatus: 'NOT_ENROLLED',
      status: 'ACTIVE',
    });
    try {
      await Diagnosis.create({
        organizationId: auth.organizationId,
        patientId: patient._id,
        condition: input.diagnosis.condition,
        status: 'CONFIRMED',
        diagnosedAt: input.diagnosis.diagnosedAt ?? new Date(),
        diagnosedByUserId: auth.userId,
        source: 'CLINICIAN',
        notes: input.diagnosis.notes,
      });
    } catch (error) {
      await Patient.deleteOne({ _id: patient._id, organizationId: auth.organizationId });
      throw error;
    }

    const apexcareOrganization = await findApexCareOrganization();
    let referral = null;
    if (apexcareOrganization) {
      const referredAt = new Date();
      const staffEscalationDueAt = new Date(referredAt.getTime() + 12 * 60 * 60 * 1000);
      referral = await ApexCareReferral.create({
        patientId: patient._id,
        clinicOrganizationId: auth.organizationId,
        apexcareOrganizationId: apexcareOrganization._id,
        referredByUserId: auth.userId,
        condition: input.diagnosis.condition,
        status: 'PENDING_STAFF',
        referredAt,
        staffEscalationDueAt,
      });
      try { await scheduleApexCareReferralEscalation(String(referral._id), staffEscalationDueAt); }
      catch (error) { console.error('ApexCare referral SLA could not be scheduled.', error); }
      await enqueueOutboxEvent({
        organizationId: auth.organizationId,
        eventKey: `patient-referral-created:${referral._id}`,
        eventType: 'PATIENT_REFERRAL_CREATED',
        aggregateType: 'ApexCareReferral',
        aggregateId: String(referral._id),
        payload: { patientId: String(patient._id), patientName: `${patient.name?.first ?? 'Patient'} ${patient.name?.last ?? ''}`.trim(), referralId: String(referral._id), clinicianId: auth.userId },
      });
    }
    res.status(201).json({ data: patient, referral });
  } catch (error) {
    if (isDuplicateKey(error)) { res.status(409).json({ error: { code: 'MRN_EXISTS', message: 'This medical-record number is already used in the clinic.' } }); return; }
    next(error);
  }
});

protectedRouter.post('/patients/:patientId/diagnoses', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(diagnosisRecordSchema, req.body, res);
    if (!input) return;
    const patient = await Patient.findOne({ _id: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId, status: 'ACTIVE' }).select('assignedClinicianId enrollmentStatus name').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const patientId = String(patient._id);
    if (String(patient.assignedClinicianId) !== auth.userId) { res.status(403).json({ error: { code: 'PATIENT_NOT_ASSIGNED', message: 'Only the assigned clinician can record this diagnosis.' } }); return; }
    if (patient.enrollmentStatus && patient.enrollmentStatus !== 'NOT_ENROLLED') { res.status(409).json({ error: { code: 'PATIENT_ALREADY_ENROLLED', message: 'Diagnosis changes after ApexCare enrolment require the clinical workflow.' } }); return; }
    const diagnosedAt = input.diagnosedAt ?? new Date();
    const diagnosis = await Diagnosis.create({ organizationId: auth.organizationId, patientId: patient._id, condition: input.condition, status: 'CONFIRMED', diagnosedAt, diagnosedByUserId: auth.userId, source: 'CLINICIAN', notes: input.notes });
    await Patient.updateOne({ _id: patient._id, organizationId: auth.organizationId }, { $set: { conditions: [{ code: input.condition, status: 'CONFIRMED', diagnosedAt }] } });
    const apexcareOrganization = await findApexCareOrganization();
    let referral = null;
    if (apexcareOrganization) {
      const referredAt = new Date();
      const staffEscalationDueAt = new Date(referredAt.getTime() + 12 * 60 * 60 * 1000);
      referral = await ApexCareReferral.create({ patientId: patient._id, clinicOrganizationId: auth.organizationId, apexcareOrganizationId: apexcareOrganization._id, referredByUserId: auth.userId, condition: input.condition, status: 'PENDING_STAFF', referredAt, staffEscalationDueAt });
      try { await scheduleApexCareReferralEscalation(String(referral._id), staffEscalationDueAt); }
      catch (error) { console.error('ApexCare referral SLA could not be scheduled.', error); }
      await enqueueOutboxEvent({
        organizationId: auth.organizationId,
        eventKey: `patient-referral-created:${referral._id}`,
        eventType: 'PATIENT_REFERRAL_CREATED',
        aggregateType: 'ApexCareReferral',
        aggregateId: String(referral._id),
        payload: { patientId, patientName: `${patient.name?.first ?? 'Patient'} ${patient.name?.last ?? ''}`.trim(), referralId: String(referral._id), clinicianId: auth.userId },
      });
    }
    res.status(201).json({ data: diagnosis, referral });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/diagnoses', requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patient = await findAccessiblePatient(routeParam(req.params.patientId, 'patientId'), auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const diagnoses = await Diagnosis.find({ organizationId: auth.organizationId, patientId: routeParam(req.params.patientId, 'patientId') }).sort({ diagnosedAt: -1 }).lean();
    res.json({ data: diagnoses });
  } catch (error) { next(error); }
});

protectedRouter.patch('/patients/:patientId/enrollment-profile', requireRoles('CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(enrollmentProfileSchema, req.body, res);
    if (!input) return;
    const patient = await Patient.findOneAndUpdate(
      { _id: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId, status: 'ACTIVE', enrollmentStatus: 'NOT_ENROLLED' },
      { $set: input },
      { new: true, runValidators: true },
    ).select('name dateOfBirth sexAtBirth phone whatsapp preferredLanguage preferredContactChannel enrollmentStatus').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found or already enrolled.' } }); return; }
    res.json({ data: patient });
  } catch (error) { next(error); }
});

protectedRouter.post('/patients/:patientId/prescription-documents/upload', requireRoles('CLINIC_COORDINATOR'), async (req: Request, res: Response, next) => {
  try {
    const auth = authContext(req);
    const patientId = routeParam(req.params.patientId, 'patientId');
    const patient = await Patient.findOne({ _id: patientId, organizationId: auth.organizationId, status: 'ACTIVE' }).select('_id enrollmentStatus').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const input = parseOrReply(prescriptionDocumentSchema, req.body, res);
    if (!input) return;
    const referral = await ApexCareReferral.findOne({ patientId, clinicOrganizationId: auth.organizationId, status: 'PENDING_STAFF' }).select('_id').lean();
    if (!referral) { res.status(409).json({ error: { code: 'APEXCARE_REFERRAL_REQUIRED', message: 'An active clinician referral is required before prescription capture.' } }); return; }
    const apexcareOrganization = await findApexCareOrganization();
    if (!apexcareOrganization) { res.status(503).json({ error: { code: 'APEXCARE_NOT_CONFIGURED', message: 'ApexCare organization is not configured.' } }); return; }
    const encodedImage = input.imageBase64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(encodedImage, 'base64');
    const stored = await savePrescriptionImage(buffer, input.mimeType, auth.organizationId, patientId);
    const document = await PrescriptionDocument.create({ patientId, clinicOrganizationId: auth.organizationId, apexcareOrganizationId: apexcareOrganization._id, source: 'IMAGE', status: 'ANALYZING', fileName: input.fileName, originalFileName: input.fileName, mimeType: input.mimeType, storageKey: stored.storageKey, storageProvider: stored.storageProvider, sizeBytes: stored.sizeBytes, sha256: stored.sha256, analysisStatus: 'PENDING', processingStage: 'QUEUED', capturedByUserId: auth.userId }).catch(async (error) => {
      try {
        await deletePrescriptionImage(stored.storageKey, stored.storageProvider);
      } catch (cleanupError) {
        const code = (cleanupError as { code?: string })?.code;
        console.error('Prescription document orphan cleanup failed', { errorCode: typeof code === 'string' ? code : 'STORAGE_DELETE_FAILED' });
      }
      throw error;
    });
    const draft = await MedicationDraft.create({
      patientId,
      clinicOrganizationId: auth.organizationId,
      apexcareOrganizationId: apexcareOrganization._id,
      prescriptionDocumentId: document._id,
      extractionSource: 'OCR',
      status: 'DRAFT',
      medications: [],
      extractedByUserId: auth.userId,
      clinicalReviewRequired: false,
    });
    let jobId: string;
    try {
      jobId = await schedulePrescriptionAnalysis(String(document._id));
    } catch (queueError) {
      console.error('Prescription analysis job could not be scheduled.', queueError);
      document.analysisStatus = 'FAILED';
      document.status = 'NEEDS_CLINICAL_REVIEW';
      document.processingStage = 'FAILED';
      document.safeLastErrorCode = 'QUEUE_UNAVAILABLE';
      document.clinicalReviewReason = 'Prescription analysis could not be queued. Manual clinical review is required.';
      await document.save();
      res.status(503).json({ error: { code: 'PRESCRIPTION_ANALYSIS_QUEUE_UNAVAILABLE', message: 'The prescription was captured, but AI analysis could not be queued. Please retry or review it manually.', prescriptionDocumentId: String(document._id) } });
      return;
    }
    const assignedPatient = await Patient.findOne({ _id: patientId, organizationId: auth.organizationId }).select('assignedClinicianId name').lean();
    if (assignedPatient?.assignedClinicianId) {
      await enqueueOutboxEvent({
        organizationId: auth.organizationId,
        eventKey: `prescription-uploaded:${document._id}`,
        eventType: 'PRESCRIPTION_UPLOADED',
        aggregateType: 'PrescriptionDocument',
        aggregateId: String(document._id),
        payload: { patientId, patientName: `${assignedPatient.name?.first ?? 'Patient'} ${assignedPatient.name?.last ?? ''}`.trim(), prescriptionDocumentId: String(document._id), clinicianId: String(assignedPatient.assignedClinicianId) },
      });
    }
      const { storageKey: _storageKey, storageProvider: _storageProvider, ...publicDocument } = document.toObject();
      res.status(202).json({ data: { prescriptionDocument: publicDocument, medicationDraft: draft, analysisStatus: 'PENDING', jobId } });
  } catch (error) {
    if (error instanceof Error && /Unsupported prescription image|Prescription image|Invalid storage path|storage/i.test(error.message)) { res.status(422).json({ error: { code: 'INVALID_PRESCRIPTION_IMAGE', message: error.message } }); return; }
    next(error);
  }
});

// Legacy metadata endpoint retained for existing integrations/tests. New staff UI should use /upload.
protectedRouter.post('/patients/:patientId/prescription-documents', requireRoles('CLINIC_COORDINATOR'), async (req: Request, res: Response, next) => {
  try {
    const auth = authContext(req);
    const input = z.object({ source: z.enum(['PAPER_IMAGE', 'EMR_DOCUMENT']), fileName: z.string().trim().min(1).max(255), mimeType: z.string().trim().min(1).max(100), storageKey: z.string().trim().min(1).max(500) }).safeParse(req.body);
    if (!input.success) { res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Legacy metadata endpoint requires a source, filename, MIME type and storage key.' } }); return; }
    const patientId = routeParam(req.params.patientId, 'patientId');
    const patient = await Patient.findOne({ _id: patientId, organizationId: auth.organizationId, status: 'ACTIVE' }).select('_id').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const apexcareOrganization = await findApexCareOrganization();
    if (!apexcareOrganization) { res.status(503).json({ error: { code: 'APEXCARE_NOT_CONFIGURED', message: 'ApexCare organization is not configured.' } }); return; }
    const document = await PrescriptionDocument.create({ ...input.data, patientId, clinicOrganizationId: auth.organizationId, apexcareOrganizationId: apexcareOrganization._id, capturedByUserId: auth.userId, status: 'CAPTURED' });
    res.status(201).json({ data: document });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/prescription-documents/:documentId/image', requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR', 'CLINICIAN'), async (req: Request, res: Response, next) => {
  try {
    const auth = authContext(req);
    const patientId = routeParam(req.params.patientId, 'patientId');
    const documentId = routeParam(req.params.documentId, 'documentId');
    const document = await PrescriptionDocument.findOne({ _id: documentId, patientId, clinicOrganizationId: auth.organizationId }).select('storageKey storageProvider mimeType fileName').lean();
    if (!document) { res.status(404).json({ error: { code: 'PRESCRIPTION_DOCUMENT_NOT_FOUND', message: 'Prescription document not found.' } }); return; }
    const image = await readPrescriptionImage(document.storageKey, document.storageProvider);
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Disposition', `inline; filename=\"${document.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}\"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(image);
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/prescription-documents', requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR', 'CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patient = await findAccessiblePatient(routeParam(req.params.patientId, 'patientId'), auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const documents = await PrescriptionDocument.find({ clinicOrganizationId: auth.organizationId, patientId: patient._id })
      .select('_id fileName originalFileName mimeType sizeBytes sha256 source status analysisStatus processingVersion processingStage processingAttempts safeLastErrorCode clinicalReviewReason capturedAt createdAt')
      .sort({ createdAt: -1 }).limit(20).lean();
    res.json({ data: documents });
  } catch (error) { next(error); }
});

protectedRouter.post('/patients/:patientId/enrol', requireRoles('CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(enrolPatientSchema, req.body, res);
    if (!input) return;
    const patientId = routeParam(req.params.patientId, 'patientId');
    const diagnosis = await Diagnosis.findOne({ organizationId: auth.organizationId, patientId, status: 'CONFIRMED' }).sort({ diagnosedAt: -1 }).lean();
    if (!diagnosis) { res.status(422).json({ error: { code: 'CONFIRMED_DIAGNOSIS_REQUIRED', message: 'A clinician-confirmed diagnosis is required before ApexCare enrolment.' } }); return; }
    const patient = await Patient.findOne({ _id: patientId, organizationId: auth.organizationId, status: 'ACTIVE', enrollmentStatus: 'NOT_ENROLLED' }).select('phone whatsapp dateOfBirth assignedClinicianId').lean();
    if (!patient) { res.status(409).json({ error: { code: 'PATIENT_ALREADY_ENROLLED', message: 'Patient is already enrolled or no longer active.' } }); return; }
    if (!patient.phone) { res.status(422).json({ error: { code: 'PATIENT_PHONE_REQUIRED', message: 'Staff must capture a patient phone number before ApexCare enrolment.' } }); return; }
    if (!patient.dateOfBirth) { res.status(422).json({ error: { code: 'PATIENT_DOB_REQUIRED', message: 'Clinic staff must record the patient’s date of birth before ApexCare enrolment.' } }); return; }
    const prescription = await PrescriptionDocument.findOne({ clinicOrganizationId: auth.organizationId, patientId, source: 'IMAGE', storageKey: { $exists: true, $ne: '' } }).sort({ createdAt: -1 }).lean();
    if (!prescription) { res.status(422).json({ error: { code: 'PRESCRIPTION_REQUIRED', message: 'A prescription image must be captured before ApexCare enrolment.' } }); return; }
    const vitalRecord = await VitalRecord.findOne({ organizationId: auth.organizationId, patientId }).sort({ recordedAt: -1 }).lean();
    if (!vitalRecord) { res.status(422).json({ error: { code: 'VITALS_REQUIRED', message: 'Clinic staff must capture at least one vital record before ApexCare enrolment.' } }); return; }
    const referral = await ApexCareReferral.findOne({ patientId, clinicOrganizationId: auth.organizationId, status: 'PENDING_STAFF' }).sort({ referredAt: -1 });
    if (!referral) { res.status(409).json({ error: { code: 'APEXCARE_REFERRAL_REQUIRED', message: 'A clinician referral is required before ApexCare enrolment.' } }); return; }
    const subscription = await reservePatientSlot(auth.organizationId);
    if (!subscription) { res.status(402).json({ error: { code: 'PATIENT_LIMIT_REACHED', message: 'Your active-patient plan limit has been reached. Upgrade the plan to enrol another patient.' } }); return; }
    const enrolledAt = new Date();
    const patientUpdated = await Patient.findOneAndUpdate(
      { _id: patientId, organizationId: auth.organizationId, status: 'ACTIVE', enrollmentStatus: 'NOT_ENROLLED' },
      { $set: { enrollmentStatus: 'ENROLLED', enrolledByUserId: auth.userId, programmeConsent: { acceptedAt: enrolledAt, acceptedByUserId: auth.userId, communicationConsent: input.communicationConsent } } },
      { new: true },
    ).lean();
    if (!patientUpdated) {
      await Subscription.updateOne({ _id: subscription._id, activePatientCount: { $gt: 0 } }, { $inc: { activePatientCount: -1 } });
      res.status(409).json({ error: { code: 'PATIENT_ALREADY_ENROLLED', message: 'Patient is already enrolled or no longer active.' } }); return;
    }
    try {
      const apexcareOrganization = await findApexCareOrganization();
      if (!apexcareOrganization) throw new Error('ApexCare organization is not configured.');
      await ProgramConsent.create({ organizationId: auth.organizationId, patientId: patientUpdated._id, program: 'APEXCARE_CHRONIC_CARE', consentGiven: true, consentAt: enrolledAt, method: input.consentMethod, recordedByUserId: auth.userId, consentVersion: input.consentVersion, communicationConsent: input.communicationConsent });
      await PatientClinicRelationship.updateOne(
        { patientId: patientUpdated._id, clinicOrganizationId: auth.organizationId, status: 'ACTIVE' },
        { $setOnInsert: { patientId: patientUpdated._id, clinicOrganizationId: auth.organizationId, relationshipType: 'PRIMARY', status: 'ACTIVE', startedAt: enrolledAt } },
        { upsert: true },
      );
      const coordinatorCallDueAt = new Date(enrolledAt.getTime() + 24 * 60 * 60 * 1000);
      const enrollment = await ApexCareEnrollment.findOneAndUpdate(
        { patientId: patientUpdated._id, apexcareOrganizationId: apexcareOrganization._id },
        { $set: { clinicOrganizationId: auth.organizationId, status: 'ACTIVE', enrolledAt, enrolledByUserId: auth.userId, coordinatorCallDueAt, coordinatorCallStatus: 'PENDING', dietitianAssessmentStatus: 'PENDING', carePlanDraftId: null, carePlanGenerationStatus: 'NOT_STARTED', carePlanGenerationJobId: null, carePlanGenerationAttempt: 0, carePlanGenerationError: null, carePlanGenerationAssessmentId: null } },
        { new: true, upsert: true },
      );
      if (referral) {
        referral.status = 'ENROLLED';
        referral.enrolledAt = enrolledAt;
        referral.enrolledByUserId = new mongoose.Types.ObjectId(auth.userId);
        await referral.save();
      }
      try { await scheduleCoordinatorCallSla(String(enrollment._id), coordinatorCallDueAt); }
      catch (error) { console.error('Coordinator call SLA could not be scheduled.', error); }
    } catch (error) {
      await Patient.updateOne({ _id: patientUpdated._id, organizationId: auth.organizationId }, { $set: { enrollmentStatus: 'NOT_ENROLLED', enrolledByUserId: null, programmeConsent: null } });
      await Subscription.updateOne({ _id: subscription._id, activePatientCount: { $gt: 0 } }, { $inc: { activePatientCount: -1 } });
      throw error;
    }
    res.status(202).json({ data: { patientId, enrollmentStatus: 'ENROLLED', coordinatorCallDueAt: new Date(enrolledAt.getTime() + 24 * 60 * 60 * 1000), prescriptionDocumentId: String(prescription._id) } });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId', requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patient = await findAccessiblePatient(routeParam(req.params.patientId, 'patientId'), auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    res.json({ data: patient });
  } catch (error) { next(error); }
});


//visit ai

protectedRouter.post(
  '/patients/:patientId/hypertension/visit-assist',
  requireRoles('CLINIC_COORDINATOR'),
  async (req: Request, res, next) => {
    try {
      const auth = authContext(req);
      const patientId = routeParam(req.params.patientId, 'patientId');

      const patient = await Patient.findOne({
        _id: patientId,
        organizationId: auth.organizationId,
        status: 'ACTIVE',
      })
        .select('assignedClinicianId enrollmentStatus conditions')
        .lean();

      if (!patient) {
        res.status(404).json({
          error: {
            code: 'PATIENT_NOT_FOUND',
            message: 'Patient not found.',
          },
        });
        return;
      }

      const hasHypertension = patient.conditions.some(
        (condition) =>
          condition.code === 'HYPERTENSION' &&
          condition.status !== 'INACTIVE',
      );

      if (!hasHypertension) {
        res.status(422).json({
          error: {
            code: 'CONDITION_NOT_ENROLLED',
            message:
              'Hypertension is not an active condition for this patient.',
          },
        });
        return;
      }

      if (
        !['ENROLLED', 'CARE_PLAN_REVIEW', 'ACTIVE_CARE'].includes(
          patient.enrollmentStatus,
        )
      ) {
        res.status(409).json({
          error: {
            code: 'PATIENT_NOT_ENROLLED',
            message:
              'The patient must be enrolled in ApexCare before using the visit assistant.',
          },
        });
        return;
      }

      const assist = await generateHypertensionVisitAssist(
        auth.organizationId,
        patientId,
      );

      if (!assist) {
        res.status(404).json({
          error: {
            code: 'VISIT_ASSIST_UNAVAILABLE',
            message: 'Visit assistant context is unavailable.',
          },
        });
        return;
      }

      /*
       * Intentionally return ONLY information-gap prompts.
       * No patient summary or clinical interpretation is exposed
       * to the coordinator.
       */
      res.json({
        data: assist,
      });
    } catch (error) {
      next(error);
    }
  },
);


// ============================================================
// NEW: Diagnoses awaiting coordinator enrolment
//
// This is intentionally separate from /care-queue.
// /care-queue handles active-care operational tasks.
// This endpoint handles the handoff between clinician
// diagnosis and coordinator enrolment.
//
// Access:
// - CLINIC_ADMIN
// - CLINIC_COORDINATOR
//
// A patient leaves this queue automatically when
// enrollmentStatus changes from NOT_ENROLLED.
// ============================================================

protectedRouter.post('/patients/:patientId/vitals', requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(vitalRecordSchema, req.body, res);
    if (!input) return;
    const patient = await findAccessiblePatient(routeParam(req.params.patientId, 'patientId'), auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const record = await VitalRecord.create({ ...input, organizationId: auth.organizationId, patientId: routeParam(req.params.patientId, 'patientId'), recordedByUserId: auth.userId });
    res.status(201).json({ data: record });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/vitals', requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patient = await findAccessiblePatient(routeParam(req.params.patientId, 'patientId'), auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const records = await VitalRecord.find({ patientId: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId }).sort({ recordedAt: -1 }).limit(100).lean();
    res.json({ data: records });
  } catch (error) { next(error); }
});

protectedRouter.post('/patients/:patientId/opd-visits', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(opdVisitSchema, req.body, res);
    if (!input) return;
    const patient = await findAccessiblePatient(routeParam(req.params.patientId, 'patientId'), auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    if (String(patient.assignedClinicianId) !== auth.userId) { res.status(403).json({ error: { code: 'PATIENT_NOT_ASSIGNED', message: 'Only the assigned clinician can record an OPD visit.' } }); return; }
    const clinician = await User.exists({ _id: input.clinicianId, organizationId: auth.organizationId, status: 'ACTIVE', roles: 'CLINICIAN' });
    if (!clinician) { res.status(422).json({ error: { code: 'INVALID_CLINICIAN', message: 'Visit clinician is not active in this clinic.' } }); return; }
    if (input.clinicianId !== auth.userId) { res.status(403).json({ error: { code: 'CLINICIAN_MISMATCH', message: 'The OPD visit clinician must be the authenticated assigned clinician.' } }); return; }
    let vitalsRecordId;
    if (input.vitals) {
      const vital = await VitalRecord.create({ ...input.vitals, organizationId: auth.organizationId, patientId: routeParam(req.params.patientId, 'patientId'), recordedByUserId: auth.userId });
      vitalsRecordId = vital._id;
    }
    const visit = await OpdVisit.create({ organizationId: auth.organizationId, patientId: routeParam(req.params.patientId, 'patientId'), visitAt: input.visitAt, recordedByUserId: auth.userId, clinicianId: input.clinicianId, reason: input.reason, assessment: input.assessment, planAdjustment: input.planAdjustment, carePlanId: input.carePlanId, vitalsRecordId });
    res.status(201).json({ data: visit });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/opd-visits', requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patient = await findAccessiblePatient(routeParam(req.params.patientId, 'patientId'), auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const visits = await OpdVisit.find({ patientId: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId }).sort({ visitAt: -1 }).limit(100).lean();
    res.json({ data: visits });
  } catch (error) { next(error); }
});

protectedRouter.post(
  '/patients/:patientId/lab-documents',
  raw({ type: 'application/pdf', limit: env.LAB_PDF_MAX_UPLOAD_BYTES }),
  requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR', 'CLINICIAN'),
  async (req: Request, res, next) => {
    try {
      const auth = authContext(req);
      const patientId = routeParam(req.params.patientId, 'patientId');
      const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
      if (!patient) {
        res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } });
        return;
      }

      const enrollment = await ApexCareEnrollment.findOne({
        patientId,
        clinicOrganizationId: auth.organizationId,
        status: 'ACTIVE',
      }).select('_id apexcareOrganizationId').lean();
      if (!enrollment) {
        res.status(409).json({ error: { code: 'APEXCARE_ENROLLMENT_REQUIRED', message: 'An active ApexCare enrollment is required before uploading a lab document.' } });
        return;
      }

      const idempotencyKey = req.header('Idempotency-Key')?.trim();
      if (!idempotencyKey) {
        res.status(400).json({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header is required.' } });
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: { code: 'LAB_PDF_REQUIRED', message: 'A non-empty application/pdf body is required.' } });
        return;
      }

      const fileName = req.header('X-File-Name')?.trim() || 'lab-report.pdf';
      const result = await createLabDocument({
        clinicOrganizationId: auth.organizationId,
        apexcareOrganizationId: String(enrollment.apexcareOrganizationId),
        patientId,
        uploadedByUserId: auth.userId,
        fileName,
        idempotencyKey,
        buffer: req.body,
      });

      const { storageKey: _storageKey, storageProvider: _storageProvider, ...publicDocument } = result.document;
      res.status(result.idempotent ? 200 : 202).json({ data: { ...result, document: publicDocument } });
    } catch (error) {
      if ((error as { code?: string })?.code === 'IDEMPOTENCY_KEY_REUSE') {
        res.status(409).json({ error: { code: 'IDEMPOTENCY_KEY_REUSE', message: 'The Idempotency-Key was already used for a different lab document.' } });
        return;
      }
      if ((error as { code?: number })?.code === 11000) {
        res.status(409).json({ error: { code: 'LAB_DOCUMENT_DUPLICATE', message: 'This lab document has already been uploaded.' } });
        return;
      }
      if (error instanceof Error && /PDF|size is invalid/i.test(error.message)) {
        res.status(422).json({ error: { code: 'INVALID_LAB_PDF', message: error.message } });
        return;
      }
      next(error);
    }
  },
);

protectedRouter.get(
  '/patients/:patientId/lab-documents/:documentId/file',
  requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR', 'CLINICIAN'),
  async (req: Request, res, next) => {
    try {
      const auth = authContext(req);
      const patientId = routeParam(req.params.patientId, 'patientId');
      const documentId = routeParam(req.params.documentId, 'documentId');
      const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
      if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
      const document = await LabDocument.findOne({ _id: documentId, patientId, clinicOrganizationId: auth.organizationId })
        .select('storageKey storageProvider fileName mimeType')
        .lean();
      if (!document) { res.status(404).json({ error: { code: 'LAB_DOCUMENT_NOT_FOUND', message: 'Lab document not found.' } }); return; }
      const pdf = await readLabPdf(document.storageKey, document.storageProvider);
      const safeFileName = document.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${safeFileName}"`);
      res.setHeader('Content-Length', String(pdf.length));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(pdf);
    } catch (error) { next(error); }
  },
);

protectedRouter.get(
  '/patients/:patientId/lab-documents',
  requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR', 'CLINICIAN'),
  async (req: Request, res, next) => {
    try {
      const auth = authContext(req);
      const patientId = routeParam(req.params.patientId, 'patientId');
      const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
      if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
      const documents = await LabDocument.find({ clinicOrganizationId: auth.organizationId, patientId })
        .select('_id source status fileName mimeType sizeBytes sha256 uploadedAt extractionStatus extractionVersion extractionWarningCode ocrEngine ocrEngineVersion ocrProcessedAt ocrWarningCode structuringStatus structuringVersion structuredAt structuredResultCount interpretationStatus processingVersion processingStage processingAttempts safeLastErrorCode createdAt')
        .sort({ createdAt: -1 }).limit(100).lean();
      res.json({ data: documents });
    } catch (error) { next(error); }
  },
);

protectedRouter.post(
  '/patients/:patientId/lab-documents/:documentId/retry',
  requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR', 'CLINICIAN'),
  async (req: Request, res, next) => {
    try {
      const auth = authContext(req);
      const patientId = routeParam(req.params.patientId, 'patientId');
      const documentId = routeParam(req.params.documentId, 'documentId');
      const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
      if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
      const parsed = z.object({ stage: z.enum(['OCR', 'AI_EXTRACTION']).optional() }).safeParse(req.body ?? {});
      if (!parsed.success) { res.status(422).json({ error: { code: 'INVALID_RETRY_STAGE', message: 'Retry stage must be OCR or AI_EXTRACTION.' } }); return; }
      const document = await LabDocument.findOne({ _id: documentId, patientId, clinicOrganizationId: auth.organizationId });
      if (!document) { res.status(404).json({ error: { code: 'LAB_DOCUMENT_NOT_FOUND', message: 'Lab document not found.' } }); return; }
      const stage = parsed.data.stage ?? (document.extractionStatus === 'FAILED' ? 'OCR' : 'AI_EXTRACTION');
      if (stage === 'OCR' && document.extractionStatus !== 'FAILED') {
        res.status(409).json({ error: { code: 'OCR_RETRY_NOT_ALLOWED', message: 'OCR can be retried only after an extraction failure.' } }); return;
      }
      if (stage === 'AI_EXTRACTION' && (document.extractionStatus !== 'COMPLETED' || document.structuringStatus !== 'FAILED')) {
        res.status(409).json({ error: { code: 'AI_RETRY_NOT_ALLOWED', message: 'AI extraction can be retried only after OCR completes and structuring fails.' } }); return;
      }
      const nextVersion = document.processingVersion + 1;
      const updated = await LabDocument.findOneAndUpdate(
        { _id: document._id, clinicOrganizationId: auth.organizationId, processingVersion: document.processingVersion, ...(stage === 'OCR' ? { extractionStatus: 'FAILED' } : { extractionStatus: 'COMPLETED', structuringStatus: 'FAILED' }) },
        { $set: { processingVersion: nextVersion, processingStage: stage, safeLastErrorCode: undefined, ...(stage === 'OCR' ? { extractionStatus: 'QUEUED', status: 'UPLOADED', extractionError: undefined, structuringStatus: 'NOT_STARTED', structuringError: undefined } : { structuringStatus: 'NOT_STARTED', structuringError: undefined }) } },
        { new: true },
      );
      if (!updated) { res.status(409).json({ error: { code: 'DOCUMENT_RETRY_CONFLICT', message: 'Document processing changed. Refresh and retry if needed.' } }); return; }
      try {
        const input = { documentId: String(updated._id), organizationId: String(updated.clinicOrganizationId), patientId: String(updated.patientId), apexcareOrganizationId: String(updated.apexcareOrganizationId), processingVersion: nextVersion };
        const jobId = stage === 'OCR' ? await scheduleLabDocumentExtraction(input) : await scheduleLabResultStructuring(input);
        res.status(202).json({ data: { documentId: String(updated._id), processingVersion: nextVersion, stage, jobId } });
      } catch {
        await LabDocument.updateOne({ _id: updated._id, processingVersion: nextVersion }, { $set: { ...(stage === 'OCR' ? { extractionStatus: 'FAILED', extractionError: 'LAB_EXTRACTION_QUEUE_UNAVAILABLE' } : { structuringStatus: 'FAILED', structuringError: 'LAB_STRUCTURING_QUEUE_UNAVAILABLE' }), processingStage: 'FAILED', safeLastErrorCode: 'LAB_QUEUE_UNAVAILABLE' } });
        res.status(503).json({ error: { code: 'LAB_QUEUE_UNAVAILABLE', message: 'Document retry could not be queued. The original file is retained; try again later.' } });
      }
    } catch (error) { next(error); }
  },
);

protectedRouter.get(
  '/patients/:patientId/lab-documents/:documentId/results',
  requireRoles('CLINICIAN'),
  async (req: Request, res, next) => {
    try {
      const auth = authContext(req);
      const patientId = routeParam(req.params.patientId, 'patientId');
      const documentId = routeParam(req.params.documentId, 'documentId');
      const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
      if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
      const document = await LabDocument.findOne({ _id: documentId, clinicOrganizationId: auth.organizationId, patientId }).select('_id structuringStatus structuringError').lean();
      if (!document) { res.status(404).json({ error: { code: 'LAB_DOCUMENT_NOT_FOUND', message: 'Lab document not found.' } }); return; }
      const results = await LabResult.find({ organizationId: auth.organizationId, patientId, labDocumentId: documentId, reviewStatus: { $ne: 'SUPERSEDED' } }).sort({ normalizedTestName: 1, createdAt: 1 }).lean();
      res.json({ data: { document, results } });
    } catch (error) { next(error); }
  },
);

protectedRouter.get(
  '/patients/:patientId/lab-documents/:documentId/interpretation',
  requireRoles('CLINICIAN'),
  async (req: Request, res, next) => {
    try {
      const auth = authContext(req);
      const patientId = routeParam(req.params.patientId, 'patientId');
      const documentId = routeParam(req.params.documentId, 'documentId');
      const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
      if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
      const interpretation = await LabInterpretation.findOne({ organizationId: auth.organizationId, patientId, labDocumentId: documentId }).sort({ createdAt: -1 }).lean();
      if (!interpretation) { res.status(404).json({ error: { code: 'LAB_INTERPRETATION_NOT_FOUND', message: 'Lab interpretation is not available yet.' } }); return; }
      res.json({ data: interpretation });
    } catch (error) { next(error); }
  },
);

protectedRouter.patch(
  '/patients/:patientId/lab-documents/:documentId/interpretation/review',
  requireRoles('CLINICIAN'),
  async (req: Request, res, next) => {
    try {
      const auth = authContext(req);
      const patientId = routeParam(req.params.patientId, 'patientId');
      const documentId = routeParam(req.params.documentId, 'documentId');
      const patient = await Patient.findOne({ _id: patientId, organizationId: auth.organizationId, status: 'ACTIVE' }).select('assignedClinicianId').lean();
      if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
      if (String(patient.assignedClinicianId) !== auth.userId) { res.status(403).json({ error: { code: 'PATIENT_NOT_ASSIGNED', message: 'Only the assigned clinician can review this interpretation.' } }); return; }
      const input = z.object({ decision: z.enum(['APPROVED', 'MODIFIED', 'REJECTED']), clinicianApprovedSummary: z.string().trim().max(8000).optional() }).safeParse(req.body);
      if (!input.success) { res.status(422).json({ error: { code: 'INVALID_INTERPRETATION_REVIEW', message: 'Invalid interpretation review.' } }); return; }
      const interpretation = await LabInterpretation.findOneAndUpdate(
        { organizationId: auth.organizationId, patientId, labDocumentId: documentId, clinicianReviewStatus: 'PENDING' },
        { $set: { clinicianReviewStatus: input.data.decision, clinicianReviewedByUserId: auth.userId, clinicianReviewedAt: new Date(), clinicianApprovedSummary: input.data.clinicianApprovedSummary } },
        { new: true },
      ).lean();
      if (!interpretation) { res.status(409).json({ error: { code: 'INTERPRETATION_ALREADY_REVIEWED', message: 'The interpretation has already been reviewed or does not exist.' } }); return; }
      if (interpretation.clinicianReviewStatus === 'APPROVED' || interpretation.clinicianReviewStatus === 'MODIFIED') {
        await ensureLabClinicalSignals({ organizationId: auth.organizationId, patientId, interpretationId: String(interpretation._id) });
      }
      res.json({ data: interpretation });
    } catch (error) { next(error); }
  },
);

protectedRouter.get('/notifications', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = authContext(req);
    const unreadOnly = req.query.unreadOnly === 'true';
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 30;
    const result = await listNotifications({ organizationId: auth.organizationId, recipientUserId: auth.userId, unreadOnly, limit });
    res.json({ data: result });
  } catch (error) { next(error); }
});

protectedRouter.patch('/notifications/:notificationId/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = authContext(req);
    const notification = await markNotificationRead({ organizationId: auth.organizationId, recipientUserId: auth.userId, notificationId: routeParam(req.params.notificationId, 'notificationId') });
    if (!notification) { res.status(404).json({ error: { code: 'NOTIFICATION_NOT_FOUND', message: 'Notification not found or already read.' } }); return; }
    res.json({ data: notification });
  } catch (error) { next(error); }
});

protectedRouter.patch('/notifications/read-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = authContext(req);
    const modified = await markAllNotificationsRead({ organizationId: auth.organizationId, recipientUserId: auth.userId });
    res.json({ data: { modified } });
  } catch (error) { next(error); }
});

protectedRouter.get('/care-queue/apexcare-referrals', requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const referrals = await ApexCareReferral.find({ clinicOrganizationId: auth.organizationId, status: 'PENDING_STAFF' })
      .sort({ staffEscalatedAt: -1, referredAt: -1 }).limit(200).lean();
    res.json({ data: referrals });
  } catch (error) { next(error); }
});

protectedRouter.get(
  '/care-queue/new-diagnoses',
  requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR'),
  async (req: Request, res, next) => {
    try {
      const auth = authContext(req);
      const referrals = await ApexCareReferral.find({
        clinicOrganizationId: auth.organizationId,
        status: 'PENDING_STAFF',
      })
        .sort({ referredAt: -1 })
        .limit(100)
        .lean();

      const patientIds = referrals.map((referral) => referral.patientId);
      const patients = await Patient.find({
        _id: { $in: patientIds },
        organizationId: auth.organizationId,
        status: 'ACTIVE',
      })
        .select('name medicalRecordNumber assignedClinicianId conditions enrollmentStatus createdAt')
        .lean();

      const patientMap = new Map(patients.map((patient) => [String(patient._id), patient]));
      const clinicianIds = patients.map((patient) => String(patient.assignedClinicianId));
      const clinicians = await User.find({
        _id: { $in: clinicianIds },
        organizationId: auth.organizationId,
        status: 'ACTIVE',
        roles: 'CLINICIAN',
      }).select('_id name').lean();
      const clinicianMap = new Map(clinicians.map((clinician) => [String(clinician._id), clinician.name]));

      const data = referrals
        .map((referral) => {
          const patient = patientMap.get(String(referral.patientId));
          if (!patient) return null;
          const condition = patient.conditions.find((item) => item.code === referral.condition && item.status !== 'INACTIVE');
          return {
            referralId: String(referral._id),
            patientId: String(patient._id),
            medicalRecordNumber: patient.medicalRecordNumber,
            patientName: `${patient.name?.first ?? ''}${patient.name?.last ? ` ${patient.name.last}` : ''}`,
            condition: referral.condition,
            diagnosedAt: condition?.diagnosedAt ?? null,
            referredAt: referral.referredAt,
            staffEscalationDueAt: referral.staffEscalationDueAt,
            staffEscalatedAt: referral.staffEscalatedAt ?? null,
            assignedClinicianId: String(patient.assignedClinicianId),
            assignedClinicianName: clinicianMap.get(String(patient.assignedClinicianId)) ?? null,
            enrollmentStatus: patient.enrollmentStatus,
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

      res.json({ data });
    } catch (error) { next(error); }
  },
);

// ---------------------------------------------------------------------------
// Patient portal
// Patients are mapped to User.patientId. These routes intentionally expose
// only patient-safe data and never return source lab PDFs or clinician-only
// interpretation text.
// ---------------------------------------------------------------------------
