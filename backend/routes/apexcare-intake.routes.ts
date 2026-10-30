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

protectedRouter.get('/apexcare/referrals', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const referrals = await ApexCareReferral.find({ apexcareOrganizationId: auth.organizationId, status: 'PENDING_STAFF' })
      .sort({ staffEscalatedAt: -1, referredAt: -1 }).limit(200).lean();
    res.json({ data: referrals });
  } catch (error) { next(error); }
});

protectedRouter.get('/apexcare/referrals/escalated', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const referrals = await ApexCareReferral.find({ apexcareOrganizationId: auth.organizationId, status: 'PENDING_STAFF', staffEscalatedAt: { $ne: null } })
      .sort({ staffEscalatedAt: 1 }).limit(200).lean();
    res.json({ data: referrals });
  } catch (error) { next(error); }
});

protectedRouter.patch('/apexcare/enrollments/:enrollmentId/coordinator-call', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(coordinatorCallSchema, req.body, res);
    if (!input) return;
    const enrollment = await ApexCareEnrollment.findOne({ _id: routeParam(req.params.enrollmentId, 'enrollmentId'), apexcareOrganizationId: auth.organizationId, status: 'ACTIVE' });
    if (!enrollment) { res.status(404).json({ error: { code: 'APEXCARE_ENROLLMENT_NOT_FOUND', message: 'ApexCare enrollment not found.' } }); return; }
    enrollment.coordinatorCallStatus = input.status;
    enrollment.coordinatorCalledAt = new Date();
    await enrollment.save();
    res.json({ data: enrollment });
  } catch (error) { next(error); }
});

protectedRouter.get('/apexcare/coordinator-queue', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    // Call outcome and history completion are independent workstreams. A CONTACTED
    // patient remains here until the coordinator submits the general history.
    const enrollments = await ApexCareEnrollment.find({
      apexcareOrganizationId: auth.organizationId,
      status: 'ACTIVE',
      $or: [
        { coordinatorCallStatus: { $in: ['PENDING', 'ESCALATED', 'NO_ANSWER'] } },
        { generalHistoryStatus: { $in: ['NOT_STARTED', 'IN_PROGRESS'] } },
        // Include existing enrollments created before the history fields were added.
        { generalHistoryStatus: { $exists: false } },
      ],
    }).sort({ coordinatorCallDueAt: 1, createdAt: 1 }).limit(200).lean();
    const patients = await Patient.find({ $or: enrollments.map((item) => ({ _id: item.patientId, organizationId: item.clinicOrganizationId })), status: 'ACTIVE' })
      .select('name phone preferredContactChannel preferredLanguage medicalRecordNumber').lean();
    const patientById = new Map(patients.map((patient) => [String(patient._id), patient]));
    res.json({ data: enrollments.flatMap((enrollment) => {
      const patient = patientById.get(String(enrollment.patientId));
      if (!patient) return [];
      return [{
      ...enrollment,
      patient,
      generalHistoryStatus: ['PENDING_REVIEW', 'COMPLETED', 'DECLINED'].includes(String(enrollment.generalHistoryStatus))
        ? 'RECORDED'
        : enrollment.generalHistoryStatus || 'NOT_STARTED',
      generalHistoryId: enrollment.generalHistoryId || null,
      }];
    }) });
  } catch (error) { next(error); }
});

protectedRouter.get('/apexcare/dietitian-queue', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_DIETITIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const enrollments = await ApexCareEnrollment.find({ apexcareOrganizationId: auth.organizationId, status: 'ACTIVE' })
      .sort({ enrolledAt: 1, createdAt: 1 }).limit(200).lean();
    const [patients, assessments] = await Promise.all([
      Patient.find({ $or: enrollments.map((item) => ({ _id: item.patientId, organizationId: item.clinicOrganizationId })), status: 'ACTIVE' })
        .select('name conditions medicalRecordNumber phone').lean(),
      DietitianAssessment.find({ apexcareOrganizationId: auth.organizationId, apexCareEnrollmentId: { $in: enrollments.map((item) => item._id) } }).lean(),
    ]);
    const patientsById = new Map(patients.map((item) => [String(item._id), item]));
    const assessmentsByEnrollment = new Map(assessments.map((item) => [String(item.apexCareEnrollmentId), item]));
    res.json({ data: enrollments.flatMap((item) => {
      const patient = patientsById.get(String(item.patientId));
      if (!patient) return [];
      return [{ ...item, patient, assessment: assessmentsByEnrollment.get(String(item._id)) || null }];
    }) });
  } catch (error) { next(error); }
});

protectedRouter.get('/apexcare/enrollments/:enrollmentId/general-history', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const enrollmentId = routeParam(req.params.enrollmentId, 'enrollmentId');
    const enrollment = await ApexCareEnrollment.findOne({ _id: enrollmentId, apexcareOrganizationId: auth.organizationId, status: 'ACTIVE' }).lean();
    if (!enrollment) { res.status(404).json({ error: { code: 'APEXCARE_ENROLLMENT_NOT_FOUND', message: 'Active ApexCare enrollment not found.' } }); return; }
    const history = await ApexCareGeneralHistory.findOne({ enrollmentId: enrollment._id, apexcareOrganizationId: auth.organizationId }).lean();
    if (!history) { res.json({ data: null }); return; }
    const legacyRecorded = ['PENDING_REVIEW', 'COMPLETED', 'DECLINED'].includes(String(history.status));
    res.json({ data: { ...history, status: legacyRecorded ? 'RECORDED' : history.status, recordedAt: history.recordedAt || history.submittedAt || null } });
  } catch (error) { next(error); }
});

protectedRouter.put('/apexcare/enrollments/:enrollmentId/general-history', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(apexGeneralHistorySaveSchema, req.body, res);
    if (!input) return;
    const shouldRecord = input.record || input.submit === true;
    const enrollmentId = routeParam(req.params.enrollmentId, 'enrollmentId');
    const enrollment = await ApexCareEnrollment.findOne({ _id: enrollmentId, apexcareOrganizationId: auth.organizationId, status: 'ACTIVE' });
    if (!enrollment) { res.status(404).json({ error: { code: 'APEXCARE_ENROLLMENT_NOT_FOUND', message: 'Active ApexCare enrollment not found.' } }); return; }

    let history = await ApexCareGeneralHistory.findOne({ enrollmentId: enrollment._id, apexcareOrganizationId: auth.organizationId });
    if (history && ['RECORDED', 'PENDING_REVIEW', 'COMPLETED', 'DECLINED'].includes(String(history.status))) {
      res.status(409).json({ error: { code: 'GENERAL_HISTORY_ALREADY_RECORDED', message: 'This history is already recorded and is read-only. Do not overwrite the original patient history.' } }); return;
    }

    const questionMap = new Map<string, (typeof APEX_GENERAL_HISTORY_QUESTIONS)[number]>(APEX_GENERAL_HISTORY_QUESTIONS.map((question) => [question.questionId, question]));
    const canonicalAnswers = input.answers.map((answer) => {
      const question = questionMap.get(answer.questionId)!;
      return { questionId: question.questionId, section: question.section, question: question.question, answer: answer.answer, details: answer.answer === 'YES' ? answer.details?.trim() || undefined : undefined };
    });
    const now = new Date();
    const nextStatus = shouldRecord ? 'RECORDED' : 'IN_PROGRESS';

    if (!history) {
      history = new ApexCareGeneralHistory({
        enrollmentId: enrollment._id,
        patientId: enrollment.patientId,
        clinicOrganizationId: enrollment.clinicOrganizationId,
        apexcareOrganizationId: enrollment.apexcareOrganizationId,
        status: nextStatus,
        questionnaireVersion: APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION,
        answers: canonicalAnswers,
        notes: input.notes,
        collectedByUserId: auth.userId,
        lastUpdatedByUserId: auth.userId,
        collectedAt: now,
        recordedAt: shouldRecord ? now : undefined,
        events: [],
      });
    } else {
      history.set('answers', canonicalAnswers);
      history.questionnaireVersion = APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION;
      history.notes = input.notes;
      history.lastUpdatedByUserId = new mongoose.Types.ObjectId(auth.userId);
      history.status = nextStatus;
      if (shouldRecord) history.recordedAt = now;
      if (!history.collectedAt) history.collectedAt = now;
    }
    history.events.push({
      eventType: shouldRecord ? 'RECORDED' : 'DRAFT_SAVED',
      actorUserId: new mongoose.Types.ObjectId(auth.userId),
      actorRole: 'APEXCARE_COORDINATOR',
      createdAt: now,
    } as never);

    try {
      await history.save();
    } catch (error) {
      if (isDuplicateKey(error)) { res.status(409).json({ error: { code: 'GENERAL_HISTORY_CONCURRENT_UPDATE', message: 'Another coordinator saved this history at the same time. Reload before continuing.' } }); return; }
      throw error;
    }

    enrollment.generalHistoryId = history._id;
    enrollment.generalHistoryStatus = nextStatus;
    enrollment.generalHistoryUpdatedAt = now;
    enrollment.generalHistoryRecordedAt = shouldRecord ? now : undefined;
    if (shouldRecord) {
      enrollment.coordinatorCallStatus = 'CONTACTED';
      enrollment.coordinatorCalledAt = now;
    }
    await enrollment.save();
    if (shouldRecord && enrollment.carePlanGenerationStatus === 'NOT_STARTED') {
      const clinician = await Patient.findOne({ _id: enrollment.patientId, organizationId: enrollment.clinicOrganizationId, status: 'ACTIVE' }).select('assignedClinicianId').lean();
      if (clinician?.assignedClinicianId) {
        const attempt = (enrollment.carePlanGenerationAttempt || 0) + 1;
        const claimed = await ApexCareEnrollment.findOneAndUpdate(
          { _id: enrollment._id, apexcareOrganizationId: auth.organizationId, generalHistoryStatus: 'RECORDED', carePlanGenerationStatus: 'NOT_STARTED' },
          { $set: { carePlanGenerationStatus: 'QUEUED', carePlanGenerationAttempt: attempt, carePlanGenerationAssessmentId: history._id, carePlanGenerationJobId: null, carePlanGenerationError: null } },
          { new: true },
        ).lean();
        if (claimed) {
          try {
            const jobId = await scheduleHypertensionDraftGeneration({ patientId: String(enrollment.patientId), clinicOrganizationId: String(enrollment.clinicOrganizationId), apexcareOrganizationId: auth.organizationId, clinicianId: String(clinician.assignedClinicianId), enrollmentId: String(enrollment._id), assessmentId: String(history._id), attempt });
            await ApexCareEnrollment.updateOne({ _id: enrollment._id, carePlanGenerationStatus: 'QUEUED', carePlanGenerationAttempt: attempt }, { $set: { carePlanGenerationJobId: jobId } });
          } catch {
            await ApexCareEnrollment.updateOne({ _id: enrollment._id, carePlanGenerationStatus: 'QUEUED', carePlanGenerationAttempt: attempt }, { $set: { carePlanGenerationStatus: 'FAILED', carePlanGenerationError: 'Unable to schedule draft generation.' } });
          }
        }
      }
    }
    res.json({ data: history.toObject() });
  } catch (error) { next(error); }
});

/**
 * Clinician-only read endpoint for Patient 360. It returns the latest recorded
 * coordinator-collected history for a patient in the caller's clinic. Drafts
 * remain private to the ApexCare coordinator until recorded.
 */
protectedRouter.get('/patients/:patientId/apexcare/general-history', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patientId = routeParam(req.params.patientId, 'patientId');
    const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }

    const history = await ApexCareGeneralHistory.findOne({
      patientId,
      clinicOrganizationId: auth.organizationId,
      status: { $in: ['RECORDED', 'PENDING_REVIEW', 'COMPLETED', 'DECLINED'] },
    })
      .select('_id patientId status questionnaireVersion answers notes collectedByUserId collectedAt recordedAt submittedAt createdAt updatedAt')
      .sort({ recordedAt: -1, submittedAt: -1, updatedAt: -1, createdAt: -1 })
      .lean();

    if (!history) { res.json({ data: null }); return; }
    const collector = history.collectedByUserId
      ? await User.findById(history.collectedByUserId).select('name').lean()
      : null;
    res.json({ data: {
      _id: history._id,
      patientId: history.patientId,
      status: 'RECORDED',
      source: 'APEXCARE_COORDINATOR',
      questionnaireVersion: history.questionnaireVersion,
      answers: history.answers,
      notes: history.notes,
      collectedAt: history.collectedAt,
      collectedByName: collector?.name || 'ApexCare coordinator',
      recordedAt: history.recordedAt || history.submittedAt || history.updatedAt || history.createdAt,
      updatedAt: history.updatedAt,
    } });
  } catch (error) { next(error); }
});

