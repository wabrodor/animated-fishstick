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

protectedRouter.get('/patient/me', requireRoles('PATIENT'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const user = await User.findOne({ _id: auth.userId, organizationId: auth.organizationId, status: 'ACTIVE', roles: 'PATIENT' }).select('patientId name email').lean();
    if (!user?.patientId) { res.status(404).json({ error: { code: 'PATIENT_ACCOUNT_NOT_LINKED', message: 'This patient account is not linked to a patient record.' } }); return; }
    const patient = await Patient.findOne({ _id: user.patientId, organizationId: auth.organizationId, status: 'ACTIVE' }).lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient record not found.' } }); return; }
    res.json({ data: { patient, account: { id: String(user._id), name: user.name, email: user.email } } });
  } catch (error) { next(error); }
});

protectedRouter.get('/patient/care', requireRoles('PATIENT'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const user = await User.findOne({ _id: auth.userId, organizationId: auth.organizationId, status: 'ACTIVE', roles: 'PATIENT' }).select('patientId').lean();
    if (!user?.patientId) { res.status(404).json({ error: { code: 'PATIENT_ACCOUNT_NOT_LINKED', message: 'This patient account is not linked to a patient record.' } }); return; }
    const patientId = String(user.patientId);
    const patient = await Patient.findOne({ _id: patientId, organizationId: auth.organizationId, status: 'ACTIVE' }).lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient record not found.' } }); return; }

    const now = new Date();
    await CareTask.updateMany({ organizationId: auth.organizationId, patientId, status: 'PENDING', dueAt: { $lt: now } }, { $set: { status: 'OVERDUE' } });

    const [plan, tasks, medicationsList, labSummaries, services] = await Promise.all([
      CarePlan.findOne({ organizationId: auth.organizationId, patientId, status: { $in: ['ACTIVE', 'PAUSED'] } }).sort({ startDate: -1 }).lean(),
      CareTask.find({ organizationId: auth.organizationId, patientId }).sort({ dueAt: 1 }).limit(100).lean(),
      MedicationRecord.find({ clinicOrganizationId: auth.organizationId, patientId, status: 'ACTIVE' }).sort({ startedAt: -1, createdAt: -1 }).lean(),
      LabInterpretation.find({ organizationId: auth.organizationId, patientId, clinicianReviewStatus: { $in: ['APPROVED', 'MODIFIED'] }, patientApprovedSummary: { $exists: true, $ne: '' } }).sort({ createdAt: -1 }).limit(20).select('labDocumentId patientApprovedSummary patientLanguage clinicianReviewStatus createdAt').lean(),
      ServiceCase.find({ clinicOrganizationId: auth.organizationId, patientId }).sort({ createdAt: -1 }).limit(20).lean(),
    ]);

    const pendingTasks = tasks.filter((task) => task.status === 'PENDING' || task.status === 'OVERDUE');
    const completedTasks = tasks.filter((task) => task.status === 'COMPLETED').length;
    const totalTasks = tasks.length;

    res.json({ data: { patient, plan, tasks, pendingTasks, completedTasks, totalTasks, medications: medicationsList, labSummaries, services } });
  } catch (error) { next(error); }
});

protectedRouter.patch('/patient/tasks/:taskId', requireRoles('PATIENT'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const user = await User.findOne({ _id: auth.userId, organizationId: auth.organizationId, status: 'ACTIVE', roles: 'PATIENT' }).select('patientId').lean();
    if (!user?.patientId) { res.status(404).json({ error: { code: 'PATIENT_ACCOUNT_NOT_LINKED', message: 'This patient account is not linked to a patient record.' } }); return; }
    const taskId = routeParam(req.params.taskId, 'taskId');
    const input = parseOrReply(taskCompleteSchema, req.body, res);
    if (!input) return;
    const task = await CareTask.findOneAndUpdate(
      { _id: taskId, organizationId: auth.organizationId, patientId: user.patientId, status: { $in: ['PENDING', 'OVERDUE'] } },
      { $set: { status: input.status, ...(input.status === 'COMPLETED' ? { completedAt: new Date() } : {}), completedByUserId: auth.userId } },
      { new: true },
    ).lean();
    if (!task) { res.status(404).json({ error: { code: 'PATIENT_TASK_NOT_FOUND', message: 'The task is not available for completion.' } }); return; }
    res.json({ data: task });
  } catch (error) { next(error); }
});

protectedRouter.get('/coordinator/reviews', requireRoles('CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const requestedStatus = typeof req.query.status === 'string' ? req.query.status : 'OPEN';
    const status = ['OPEN', 'IN_PROGRESS', 'COMPLETED'].includes(requestedStatus) ? requestedStatus : 'OPEN';
    const statusFilter = status === 'OPEN' ? { $in: ['OPEN', 'IN_PROGRESS'] } : status;
    const now = new Date();

    const reviews = await PatientReview.find({
      organizationId: auth.organizationId,
      status: statusFilter,
    })
      .sort({ dueAt: 1, createdAt: 1 })
      .limit(100)
      .lean();

    const patientIds = reviews.map((review) => review.patientId);
    const milestoneIds = reviews.map((review) => review.milestoneId);
    const [patients, milestones] = await Promise.all([
      Patient.find({
        _id: { $in: patientIds },
        organizationId: auth.organizationId,
        status: 'ACTIVE',
      })
        .select('_id name medicalRecordNumber enrollmentStatus assignedClinicianId conditions phone whatsapp preferredContactChannel')
        .lean(),
      CarePlanMilestone.find({
        _id: { $in: milestoneIds },
        organizationId: auth.organizationId,
      })
        .select('_id key day dueAt status reviewRequired')
        .lean(),
    ]);

    const patientMap = new Map(patients.map((patient) => [String(patient._id), patient]));
    const milestoneMap = new Map(milestones.map((milestone) => [String(milestone._id), milestone]));

    const data = reviews
      .map((review) => {
        const patient = patientMap.get(String(review.patientId));
        const milestone = milestoneMap.get(String(review.milestoneId));
        if (!patient || !milestone) return null;
        const hypertension = patient.conditions.find((condition) => condition.code === 'HYPERTENSION' && condition.status !== 'INACTIVE');
        const dueAt = new Date(review.dueAt);
        const hoursUntilDue = (dueAt.getTime() - now.getTime()) / (60 * 60 * 1000);
        const priority = hoursUntilDue <= 24 ? 'HIGH' : hoursUntilDue <= 72 ? 'MEDIUM' : 'LOW';
        const daysOverdue = dueAt.getTime() < now.getTime() ? Math.max(1, Math.ceil((now.getTime() - dueAt.getTime()) / 86400000)) : 0;
        return {
          ...review,
          priority,
          daysOverdue,
          milestone: {
            key: milestone.key,
            day: milestone.day,
            dueAt: milestone.dueAt,
            status: milestone.status,
          },
          patient: {
            _id: String(patient._id),
            name: `${patient.name?.first ?? ''}${patient.name?.last ? ` ${patient.name.last}` : ''}`.trim(),
            medicalRecordNumber: patient.medicalRecordNumber,
            enrollmentStatus: patient.enrollmentStatus,
            condition: hypertension?.code ?? patient.conditions?.[0]?.code ?? null,
            phone: patient.phone ?? null,
            whatsapp: patient.whatsapp ?? null,
            preferredContactChannel: patient.preferredContactChannel ?? 'PHONE',
          },
        };
      })
      .filter(Boolean);

    res.json({ data });
  } catch (error) {
    next(error);
  }
});

protectedRouter.patch('/coordinator/reviews/:reviewId/contact', requireRoles('CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const reviewId = routeParam(req.params.reviewId, 'reviewId');
    const input = parseOrReply(coordinatorReviewContactSchema, req.body, res);
    if (!input) return;
    const now = new Date();
    const review = await PatientReview.findOneAndUpdate(
      { _id: reviewId, organizationId: auth.organizationId, status: { $in: ['OPEN', 'IN_PROGRESS'] } },
      {
        $set: {
          contactStatus: input.outcome,
          lastContactedAt: now,
          lastContactedByUserId: auth.userId,
          contactNotes: input.notes,
          status: 'IN_PROGRESS',
        },
      },
      { new: true },
    ).lean();
    if (!review) { res.status(404).json({ error: { code: 'PATIENT_REVIEW_NOT_OPEN', message: 'Patient review is not open for contact update.' } }); return; }
    res.json({ data: review });
  } catch (error) { next(error); }
});

protectedRouter.post('/coordinator/reviews/:reviewId/message', requireRoles('CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const reviewId = routeParam(req.params.reviewId, 'reviewId');
    const review = await PatientReview.findOne({ _id: reviewId, organizationId: auth.organizationId, status: { $in: ['OPEN', 'IN_PROGRESS'] } }).lean();
    if (!review) { res.status(404).json({ error: { code: 'PATIENT_REVIEW_NOT_OPEN', message: 'Patient review is not open for messaging.' } }); return; }
    const execution = await CarePlan.findOne({ _id: review.carePlanId, organizationId: auth.organizationId, patientId: review.patientId, status: 'ACTIVE' }).select('condition').lean();
    if (!execution) { res.status(404).json({ error: { code: 'CARE_PLAN_NOT_FOUND', message: 'Care plan context not found.' } }); return; }
    const communication = await createPatientReviewReminderCommunication({
      organizationId: auth.organizationId,
      patientId: String(review.patientId),
      reviewId: String(review._id),
      carePlanId: String(review.carePlanId),
      dueAt: review.dueAt,
      condition: execution.condition,
    });
    if (!communication) { res.status(409).json({ error: { code: 'PATIENT_COMMUNICATION_NOT_AVAILABLE', message: 'Patient communication consent is not available or the patient cannot be contacted through the configured channel.' } }); return; }
    await PatientReview.updateOne(
      { _id: review._id, organizationId: auth.organizationId },
      { $set: { contactStatus: 'MESSAGE_QUEUED', lastContactedAt: new Date(), lastContactedByUserId: auth.userId, status: 'IN_PROGRESS' } },
    );
    res.status(202).json({ data: communication.communication, queued: true, idempotent: communication.idempotent });
  } catch (error) { next(error); }
});

