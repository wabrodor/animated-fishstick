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

protectedRouter.post('/apexcare/patients/:patientId/dietitian-assessment', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_DIETITIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(dietitianAssessmentSchema, req.body, res);
    if (!input) return;
    const patientId = routeParam(req.params.patientId, 'patientId');
    const enrollment = await ApexCareEnrollment.findOne({ patientId, apexcareOrganizationId: auth.organizationId, status: 'ACTIVE' }).lean();
    if (!enrollment) { res.status(404).json({ error: { code: 'APEXCARE_ENROLLMENT_NOT_FOUND', message: 'Active ApexCare enrollment not found.' } }); return; }
    const patient = await Patient.findOne({ _id: patientId, organizationId: enrollment.clinicOrganizationId, status: 'ACTIVE' }).select('enrollmentStatus conditions assignedClinicianId').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    if (!patient.conditions.some((condition) => condition.code === 'HYPERTENSION' && condition.status !== 'INACTIVE')) {
      res.status(422).json({ error: { code: 'CONDITION_NOT_AVAILABLE', message: 'The current care-plan engine supports hypertension only.' } }); return;
    }
    if (enrollment.coordinatorCallStatus !== 'CONTACTED') {
      res.status(409).json({ error: { code: 'COORDINATOR_CALL_REQUIRED', message: 'The coordinator must contact the patient before the dietitian assessment can start care-plan generation.' } });
      return;
    }
    const existingAssessment = await DietitianAssessment.findOne({
      apexCareEnrollmentId: enrollment._id,
      apexcareOrganizationId: auth.organizationId,
      clinicOrganizationId: enrollment.clinicOrganizationId,
      patientId,
    }).lean();

    if (existingAssessment) {
      const updatedAssessment = await DietitianAssessment.findOneAndUpdate(
        { _id: existingAssessment._id, apexCareEnrollmentId: enrollment._id, apexcareOrganizationId: auth.organizationId, clinicOrganizationId: enrollment.clinicOrganizationId, patientId },
        { $set: { remarks: input.remarks, assessmentData: input.assessmentData, dietitianUserId: auth.userId } },
        { new: true, runValidators: true },
      ).lean();
      const currentEnrollment = await ApexCareEnrollment.findOne({ _id: enrollment._id, apexcareOrganizationId: auth.organizationId, patientId, clinicOrganizationId: enrollment.clinicOrganizationId }).lean();
      if (!currentEnrollment) {
        res.status(404).json({ error: { code: 'APEXCARE_ENROLLMENT_NOT_FOUND', message: 'Active ApexCare enrollment not found.' } }); return;
      }
      if (currentEnrollment.carePlanGenerationStatus === 'COMPLETED' && currentEnrollment.carePlanDraftId) {
        res.status(200).json({ data: { assessment: updatedAssessment, carePlanGenerationStatus: 'COMPLETED', jobId: currentEnrollment.carePlanGenerationJobId ?? null, carePlanDraftId: String(currentEnrollment.carePlanDraftId) } });
        return;
      }
      if (currentEnrollment.carePlanGenerationStatus === 'QUEUED' || currentEnrollment.carePlanGenerationStatus === 'PROCESSING') {
        res.status(202).json({ data: { assessment: updatedAssessment, carePlanGenerationStatus: currentEnrollment.carePlanGenerationStatus, jobId: currentEnrollment.carePlanGenerationJobId ?? null } });
        return;
      }
      if (currentEnrollment.carePlanGenerationStatus !== 'FAILED') {
        res.status(409).json({ error: { code: 'CARE_PLAN_GENERATION_STATE_CONFLICT', message: 'The care-plan generation state cannot accept another request.' } }); return;
      }

      const retryAttempt = (currentEnrollment.carePlanGenerationAttempt ?? 0) + 1;
      const claimedRetry = await ApexCareEnrollment.findOneAndUpdate(
        { _id: enrollment._id, apexcareOrganizationId: auth.organizationId, carePlanGenerationStatus: 'FAILED', carePlanGenerationAssessmentId: existingAssessment._id, carePlanGenerationAttempt: currentEnrollment.carePlanGenerationAttempt ?? 0 },
        { $set: { carePlanGenerationStatus: 'QUEUED', carePlanGenerationAttempt: retryAttempt, carePlanGenerationJobId: null, carePlanGenerationError: null } },
        { new: true },
      ).lean();
      if (!claimedRetry) {
        res.status(409).json({ error: { code: 'CARE_PLAN_GENERATION_RETRY_CONFLICT', message: 'Another request is already retrying care-plan generation.' } }); return;
      }

      try {
        const jobId = await scheduleHypertensionDraftGeneration({
          patientId,
          clinicOrganizationId: String(enrollment.clinicOrganizationId),
          apexcareOrganizationId: auth.organizationId,
          clinicianId: String(patient.assignedClinicianId),
          enrollmentId: String(enrollment._id),
          assessmentId: String(updatedAssessment?._id ?? existingAssessment._id),
          attempt: retryAttempt,
        });
        await ApexCareEnrollment.updateOne({ _id: enrollment._id, carePlanGenerationStatus: 'QUEUED', carePlanGenerationAttempt: retryAttempt }, { $set: { carePlanGenerationJobId: jobId } });
        res.status(202).json({ data: { assessment: updatedAssessment, carePlanGenerationStatus: 'QUEUED', jobId } });
      } catch (error) {
        await ApexCareEnrollment.updateOne({ _id: enrollment._id, carePlanGenerationStatus: 'QUEUED', carePlanGenerationAttempt: retryAttempt }, { $set: { carePlanGenerationStatus: 'FAILED', carePlanGenerationError: error instanceof Error ? error.message.slice(0, 1000) : 'Unable to schedule care-plan generation.' } });
        throw error;
      }
      return;
    }

    let assessment;
    try {
      assessment = await DietitianAssessment.create({
        patientId,
        clinicOrganizationId: enrollment.clinicOrganizationId,
        apexcareOrganizationId: auth.organizationId,
        apexCareEnrollmentId: enrollment._id,
        dietitianUserId: auth.userId,
        remarks: input.remarks,
        assessmentData: input.assessmentData,
      });
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000) throw error;
      const concurrentAssessment = await DietitianAssessment.findOne({
        apexCareEnrollmentId: enrollment._id,
        apexcareOrganizationId: auth.organizationId,
        clinicOrganizationId: enrollment.clinicOrganizationId,
        patientId,
      }).lean();
      if (!concurrentAssessment) throw error;
      const currentEnrollment = await ApexCareEnrollment.findById(enrollment._id).lean();
      if (!currentEnrollment) throw error;
      res.status(currentEnrollment.carePlanGenerationStatus === 'COMPLETED' ? 200 : 202).json({
        data: {
          assessment: concurrentAssessment,
          carePlanGenerationStatus: currentEnrollment.carePlanGenerationStatus,
          jobId: currentEnrollment.carePlanGenerationJobId ?? null,
          carePlanDraftId: currentEnrollment.carePlanDraftId ? String(currentEnrollment.carePlanDraftId) : undefined,
        },
      });
      return;
    }
    if (enrollment.carePlanGenerationStatus === 'COMPLETED' && enrollment.carePlanDraftId) {
      await ApexCareEnrollment.updateOne(
        { _id: enrollment._id, apexcareOrganizationId: auth.organizationId, status: 'ACTIVE' },
        { $set: { dietitianAssessmentStatus: 'COMPLETED' } },
      );
      res.status(200).json({ data: { assessment, carePlanGenerationStatus: 'COMPLETED', jobId: enrollment.carePlanGenerationJobId ?? null, carePlanDraftId: String(enrollment.carePlanDraftId) } });
      return;
    }
    const attempt = 1;
    const queuedEnrollment = await ApexCareEnrollment.findOneAndUpdate(
      { _id: enrollment._id, apexcareOrganizationId: auth.organizationId, status: 'ACTIVE', coordinatorCallStatus: 'CONTACTED', carePlanGenerationStatus: 'NOT_STARTED', carePlanGenerationAssessmentId: { $exists: false } },
      { $set: { dietitianAssessmentStatus: 'COMPLETED', carePlanGenerationStatus: 'QUEUED', carePlanGenerationAttempt: attempt, carePlanGenerationAssessmentId: assessment._id, carePlanGenerationError: null, carePlanGenerationJobId: null } },
      { new: true },
    ).lean();
    if (!queuedEnrollment) {
      await DietitianAssessment.deleteOne({ _id: assessment._id });
      res.status(409).json({ error: { code: 'CARE_PLAN_GENERATION_ALREADY_STARTED', message: 'Another care-plan generation request is already in progress.' } }); return;
    }

    try {
      const jobId = await scheduleHypertensionDraftGeneration({
        patientId,
        clinicOrganizationId: String(enrollment.clinicOrganizationId),
        apexcareOrganizationId: auth.organizationId,
        clinicianId: String(patient.assignedClinicianId),
        enrollmentId: String(enrollment._id),
        assessmentId: String(assessment._id),
        attempt,
      });
      await ApexCareEnrollment.updateOne({ _id: enrollment._id, carePlanGenerationStatus: 'QUEUED', carePlanGenerationAttempt: attempt, carePlanGenerationAssessmentId: assessment._id }, { $set: { carePlanGenerationJobId: jobId } });
      res.status(202).json({ data: { assessment, carePlanGenerationStatus: 'QUEUED', jobId } });
    } catch (error) {
      await ApexCareEnrollment.updateOne({ _id: enrollment._id, carePlanGenerationStatus: 'QUEUED', carePlanGenerationAttempt: attempt, carePlanGenerationAssessmentId: assessment._id }, { $set: { carePlanGenerationStatus: 'FAILED', carePlanGenerationError: error instanceof Error ? error.message.slice(0, 1000) : 'Unable to schedule care-plan generation.' } });
      throw error;
    }
  } catch (error) { next(error); }
});

protectedRouter.get('/apexcare/care-plan-review-queue', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_DOCTOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const drafts = await CarePlanDraft.find({ status: { $in: ['GENERATED', 'CLINICIAN_REVIEW'] }, fallbackEligibleAt: { $lte: new Date() } }).sort({ fallbackEligibleAt: 1 }).limit(500).lean();
    const patientIds = drafts.map((draft) => draft.patientId);
    const enrollments = await ApexCareEnrollment.find({ patientId: { $in: patientIds }, apexcareOrganizationId: auth.organizationId, status: 'ACTIVE' }).select('patientId').lean();
    const enrolledPatientIds = new Set(enrollments.map((item) => String(item.patientId)));
    res.json({ data: drafts.filter((draft) => enrolledPatientIds.has(String(draft.patientId))).slice(0, 200) });
  } catch (error) { next(error); }
});

protectedRouter.patch('/apexcare/patients/:patientId/hypertension/care-plan-drafts/:draftId/fallback-approve', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_DOCTOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patientId = routeParam(req.params.patientId, 'patientId');
    const draftId = routeParam(req.params.draftId, 'draftId');
    const enrollment = await ApexCareEnrollment.findOne({ patientId, apexcareOrganizationId: auth.organizationId, status: 'ACTIVE' }).lean();
    if (!enrollment) { res.status(404).json({ error: { code: 'APEXCARE_ENROLLMENT_NOT_FOUND', message: 'Active ApexCare enrollment not found.' } }); return; }
    const plan = await approveHypertensionCarePlanDraftAsApexCare(String(enrollment.clinicOrganizationId), patientId, draftId, auth.userId);
    if (!plan) { res.status(404).json({ error: { code: 'CARE_PLAN_DRAFT_NOT_FOUND', message: 'Care-plan draft not found or already processed.' } }); return; }
    if ('error' in plan) {
      const status = plan.error === 'CLINICIAN_REVIEW_WINDOW_ACTIVE' ? 409 : 422;
      res.status(status).json({ error: { code: plan.error, message: plan.error === 'CLINICIAN_REVIEW_WINDOW_ACTIVE' ? 'The clinic clinician review window has not expired.' : 'The care-plan draft could not be approved.' } }); return;
    }
    await Patient.updateOne({ _id: patientId, organizationId: enrollment.clinicOrganizationId }, { $set: { enrollmentStatus: 'ACTIVE_CARE' } });
    res.status(201).json({ data: plan });
  } catch (error) { next(error); }
});

protectedRouter.get('/apexcare/service-cases', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_COORDINATOR', 'APEXCARE_DIETITIAN', 'APEXCARE_SPECIALIST'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const filter: Record<string, unknown> = {};
    if (auth.roles.includes('APEXCARE_DIETITIAN')) filter.service = 'DIETITIAN';
    if (auth.roles.includes('APEXCARE_SPECIALIST')) filter.service = 'ENDOCRINOLOGY';
    if (!auth.roles.includes('APEXCARE_COORDINATOR') && !auth.roles.includes('APEXCARE_DIETITIAN') && !auth.roles.includes('APEXCARE_SPECIALIST')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Apexcare role required.' } }); return;
    }
    const cases = await ServiceCase.find({
      ...filter,
      apexcareOrganizationId: auth.organizationId,
      ...(auth.roles.includes('APEXCARE_COORDINATOR') ? {} : { assignedApexcareUserId: auth.userId }),
    }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ data: cases });
  } catch (error) { next(error); }
});

protectedRouter.get('/apexcare/service-cases/:caseId', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_COORDINATOR', 'APEXCARE_DIETITIAN', 'APEXCARE_SPECIALIST'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const serviceCase = await ServiceCase.findOne({ _id: routeParam(req.params.caseId, 'caseId'), apexcareOrganizationId: auth.organizationId }).lean();
    if (!serviceCase) { res.status(404).json({ error: { code: 'SERVICE_CASE_NOT_FOUND', message: 'Service case not found.' } }); return; }
    const isCoordinator = auth.roles.includes('APEXCARE_COORDINATOR');
    const isAssigned = String(serviceCase.assignedApexcareUserId || '') === auth.userId;
    if (!isCoordinator && !isAssigned) { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the assigned Apexcare provider can access this service case.' } }); return; }
    const patient = await Patient.findOne({ _id: serviceCase.patientId, organizationId: serviceCase.clinicOrganizationId, status: 'ACTIVE' })
      .select('name dateOfBirth sexAtBirth preferredLanguage preferredContactChannel conditions assignedClinicianId')
      .lean();
    res.json({ data: { serviceCase, patient } });
  } catch (error) { next(error); }
});

protectedRouter.patch('/apexcare/service-cases/:caseId/assign', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const input = z.object({ assignedApexcareUserId: z.string().regex(/^[a-f\d]{24}$/i) }).safeParse(req.body);
    if (!input.success) { res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'A valid Apexcare assignee is required.', details: input.error.flatten() } }); return; }
    const auth = authContext(req);
    const serviceCase = await ServiceCase.findOne({ _id: routeParam(req.params.caseId, 'caseId'), apexcareOrganizationId: auth.organizationId });
    if (!serviceCase) { res.status(404).json({ error: { code: 'SERVICE_CASE_NOT_FOUND', message: 'Service case not found.' } }); return; }
    const role = serviceCase.service === 'DIETITIAN' ? 'APEXCARE_DIETITIAN' : 'APEXCARE_SPECIALIST';
    const assignee = await User.exists({ _id: input.data.assignedApexcareUserId, organizationId: auth.organizationId, status: 'ACTIVE', roles: role });
    if (!assignee) { res.status(422).json({ error: { code: 'INVALID_APEXCARE_ASSIGNEE', message: 'The assignee is not an active Apexcare team member for this service.' } }); return; }
    serviceCase.assignedApexcareUserId = input.data.assignedApexcareUserId as any;
    serviceCase.status = 'ASSIGNED';
    await serviceCase.save();
    res.json({ data: serviceCase });
  } catch (error) { next(error); }
});

protectedRouter.patch('/apexcare/service-cases/:caseId/status', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_COORDINATOR', 'APEXCARE_DIETITIAN', 'APEXCARE_SPECIALIST'), async (req: Request, res, next) => {
  try {
    const input = z.object({ status: z.enum(['SCHEDULED', 'COMPLETED', 'CANCELLED']), handoffSummary: z.string().trim().max(5000).optional() }).safeParse(req.body);
    if (!input.success) { res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid service-case status update.', details: input.error.flatten() } }); return; }
    const auth = authContext(req);
    const serviceCase = await ServiceCase.findOne({ _id: routeParam(req.params.caseId, 'caseId'), apexcareOrganizationId: auth.organizationId });
    if (!serviceCase) { res.status(404).json({ error: { code: 'SERVICE_CASE_NOT_FOUND', message: 'Service case not found.' } }); return; }
    const isCoordinator = auth.roles.includes('APEXCARE_COORDINATOR');
    const isAssigned = String(serviceCase.assignedApexcareUserId || '') === auth.userId;
    if (!isCoordinator && !isAssigned) { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the assigned Apexcare provider or coordinator can update this case.' } }); return; }
    serviceCase.status = input.data.status;
    if (input.data.handoffSummary !== undefined) serviceCase.handoffSummary = input.data.handoffSummary;
    await serviceCase.save();
    res.json({ data: serviceCase });
  } catch (error) { next(error); }
});

