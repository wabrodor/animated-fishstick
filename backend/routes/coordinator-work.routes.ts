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

protectedRouter.get('/care-queue', requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const now = new Date();
    await CareTask.updateMany(
      { organizationId: auth.organizationId, status: 'PENDING', dueAt: { $lt: now } },
      { $set: { status: 'OVERDUE' } },
    );
    const rawTasks = await CareTask.find({
      organizationId: auth.organizationId,
      status: { $in: ['OVERDUE', 'PENDING', 'SKIPPED'] },
    }).sort({ dueAt: 1 }).limit(200).lean();

    const patientIds = rawTasks.map((task) => String(task.patientId));
    const patients = await Patient.find({
      organizationId: auth.organizationId,
      _id: { $in: patientIds },
      status: 'ACTIVE',
    }).select('_id name medicalRecordNumber enrollmentStatus conditions assignedClinicianId phone whatsapp preferredContactChannel').lean();
    const patientById = new Map(patients.map((patient) => [String(patient._id), patient]));

    const tasks = rawTasks
      .map((task) => ({
        ...task,
        priority: careTaskPriority(task, now),
        contactStatus: task.contactStatus ?? 'NOT_CONTACTED',
        lastContactedAt: task.lastContactedAt ?? null,
        contactNotes: task.contactNotes ?? null,
        patient: patientById.get(String(task.patientId)) ? {
          _id: patientById.get(String(task.patientId))!._id,
          name: patientById.get(String(task.patientId))!.name,
          medicalRecordNumber: patientById.get(String(task.patientId))!.medicalRecordNumber,
          enrollmentStatus: patientById.get(String(task.patientId))!.enrollmentStatus,
          condition: patientById.get(String(task.patientId))!.conditions?.[0]?.code ?? null,
          phone: patientById.get(String(task.patientId))!.phone ?? null,
          whatsapp: patientById.get(String(task.patientId))!.whatsapp ?? null,
          preferredContactChannel: patientById.get(String(task.patientId))!.preferredContactChannel ?? 'PHONE',
        } : null,
      }))
      .filter((task) => task.patient);

    const priorityRank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
    tasks.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

    const reviewRows = await PatientReview.find({
      organizationId: auth.organizationId,
      status: { $in: ['OPEN', 'IN_PROGRESS'] },
    }).sort({ dueAt: 1 }).limit(100).lean();
    const reviewPatientIds = reviewRows.map((review) => String(review.patientId));
    const reviewPatients = await Patient.find({
      _id: { $in: reviewPatientIds },
      organizationId: auth.organizationId,
      status: 'ACTIVE',
    }).select('_id name medicalRecordNumber enrollmentStatus conditions phone whatsapp preferredContactChannel').lean();
    const reviewPatientMap = new Map(reviewPatients.map((patient) => [String(patient._id), patient]));
    const reviews = reviewRows.map((review) => {
      const patient = reviewPatientMap.get(String(review.patientId));
      if (!patient) return null;
      const dueAt = new Date(review.dueAt);
      const hoursUntilDue = (dueAt.getTime() - now.getTime()) / (60 * 60 * 1000);
      return {
        ...review,
        priority: hoursUntilDue <= 24 ? 'HIGH' : hoursUntilDue <= 72 ? 'MEDIUM' : 'LOW',
        daysOverdue: dueAt.getTime() < now.getTime() ? Math.max(1, Math.ceil((now.getTime() - dueAt.getTime()) / 86400000)) : 0,
        patient: {
          _id: String(patient._id),
          name: `${patient.name?.first ?? ''}${patient.name?.last ? ` ${patient.name.last}` : ''}`.trim(),
          medicalRecordNumber: patient.medicalRecordNumber,
          enrollmentStatus: patient.enrollmentStatus,
          condition: patient.conditions?.[0]?.code ?? null,
          phone: patient.phone ?? null,
          whatsapp: patient.whatsapp ?? null,
          preferredContactChannel: patient.preferredContactChannel ?? 'PHONE',
        },
      };
    }).filter(Boolean);

    const overdueVisits = tasks.filter((task) => task.type === 'OPD_VISIT' && task.status === 'OVERDUE');
    const incompleteLabs = tasks.filter((task) => task.type === 'LAB' && task.status !== 'COMPLETED');
    const missedCareTasks = tasks.filter((task) => task.status === 'OVERDUE' || task.status === 'SKIPPED');
    res.json({
      data: {
        counts: { overdueVisits: overdueVisits.length, incompleteLabs: incompleteLabs.length, missedCareTasks: missedCareTasks.length, pendingReviews: reviews.length },
        overdueVisits,
        incompleteLabs,
        missedCareTasks,
        tasks,
        reviews,
      },
    });
  } catch (error) { next(error); }
});

protectedRouter.patch('/coordinator/tasks/:taskId/contact', requireRoles('CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const taskId = routeParam(req.params.taskId, 'taskId');
    const input = parseOrReply(coordinatorReviewContactSchema, req.body, res);
    if (!input) return;
    const task = await CareTask.findOneAndUpdate(
      { _id: taskId, organizationId: auth.organizationId, status: { $in: ['PENDING', 'OVERDUE', 'SKIPPED'] } },
      { $set: { contactStatus: input.outcome, lastContactedAt: new Date(), lastContactedByUserId: auth.userId, contactNotes: input.notes } },
      { new: true },
    ).lean();
    if (!task) { res.status(404).json({ error: { code: 'COORDINATOR_TASK_NOT_FOUND', message: 'Task is not available for contact update.' } }); return; }
    res.json({ data: task });
  } catch (error) { next(error); }
});

protectedRouter.post('/coordinator/tasks/:taskId/message', requireRoles('CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const taskId = routeParam(req.params.taskId, 'taskId');
    const task = await CareTask.findOne({ _id: taskId, organizationId: auth.organizationId, status: { $in: ['PENDING', 'OVERDUE', 'SKIPPED'] } }).lean();
    if (!task) { res.status(404).json({ error: { code: 'COORDINATOR_TASK_NOT_FOUND', message: 'Task is not available for messaging.' } }); return; }
    const communication = await createCareTaskReminderCommunication({ organizationId: auth.organizationId, taskId });
    if (!communication) { res.status(409).json({ error: { code: 'PATIENT_COMMUNICATION_NOT_AVAILABLE', message: 'Patient communication consent is not available or no configured contact channel is available.' } }); return; }
    await CareTask.updateOne({ _id: task._id, organizationId: auth.organizationId }, { $set: { contactStatus: 'MESSAGE_QUEUED', lastContactedAt: new Date(), lastContactedByUserId: auth.userId } });
    res.status(202).json({ data: communication.communication, queued: true, idempotent: communication.idempotent });
  } catch (error) { next(error); }
});

protectedRouter.patch('/coordinator/tasks/:taskId', requireRoles('CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(taskCompleteSchema, req.body, res);
    if (!input) return;
    const taskId = routeParam(req.params.taskId, 'taskId');
    const task = await CareTask.findOneAndUpdate(
      {
        _id: taskId,
        organizationId: auth.organizationId,
        status: { $in: ['PENDING', 'OVERDUE', 'SKIPPED'] },
        type: { $in: ['FOLLOW_UP', 'VITALS'] },
      },
      {
        $set: {
          status: input.status,
          ...(input.status === 'COMPLETED' ? { completedAt: new Date(), completedByUserId: auth.userId } : {}),
        },
      },
      { new: true },
    ).lean();
    if (!task) {
      res.status(404).json({ error: { code: 'COORDINATOR_TASK_NOT_FOUND', message: 'This task is not available for coordinator completion.' } });
      return;
    }
    res.json({ data: task });
  } catch (error) { next(error); }
});

