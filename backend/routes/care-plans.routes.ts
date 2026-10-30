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
const { conditionCodes, objectIdSchema, registerSchema, visitReviewSchema, patientReviewCompletionSchema, coordinatorEscalationResolutionSchema, coordinatorReviewContactSchema, loginSchema, passwordChangeSchema, clinicianPatientSchema, enrolPatientSchema, enrollmentProfileSchema, medicationDraftItemSchema, prescriptionDocumentSchema, medicationSubmitSchema, medicationFinalizeSchema, clinicalReviewDecisionSchema, apexCareClinicalReviewDecisionSchema, coordinatorCallSchema, apexGeneralHistoryAnswerSchema, apexGeneralHistorySaveSchema, medicationDraftCreateSchema, medicationDraftReviewSchema, dietitianAssessmentSchema, diagnosisRecordSchema, staffCreateSchema, staffStatusSchema, vitalRecordSchema, opdVisitSchema, carePlanAdjustmentSchema, taskCompleteSchema, serviceCaseSchema, serviceCaseQuerySchema, deactivatePatientSchema, carePlanSchema, hypertensionDraftPlanSchema, parseOrReply, authContext, findApexCareOrganization, routeParam, findAccessiblePatient, publicRouter, protectedRouter, careTaskPriority, isDuplicateKey, reservePatientSlot, isKnownValidationError } = Common;

protectedRouter.patch('/patients/:patientId/care-plans/:carePlanId/approve', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patient = await Patient.findOne({ _id: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId, status: 'ACTIVE' }).select('assignedClinicianId').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    if (String(patient.assignedClinicianId) !== auth.userId) { res.status(403).json({ error: { code: 'PATIENT_NOT_ASSIGNED', message: 'Only the assigned clinician can approve this care plan.' } }); return; }
    const plan = await CarePlan.findOneAndUpdate(
      { _id: routeParam(req.params.carePlanId, 'carePlanId'), patientId: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId, condition: 'HYPERTENSION', status: 'DRAFT' },
      { $set: { status: 'ACTIVE', approvedByUserId: auth.userId, approvedAt: new Date() } },
      { new: true },
    );
    if (!plan) { res.status(404).json({ error: { code: 'DRAFT_CARE_PLAN_NOT_FOUND', message: 'A draft hypertension care plan was not found.' } }); return; }
    res.json({ data: plan });
  } catch (error) { next(error); }
});

protectedRouter.patch('/patients/:patientId/care-plans/:carePlanId', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const input = parseOrReply(carePlanAdjustmentSchema, req.body, res);
    if (!input) return;
    const auth = authContext(req);
    const patient = await Patient.findOne({ _id: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId, status: 'ACTIVE' }).select('assignedClinicianId').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    if (String(patient.assignedClinicianId) !== auth.userId) { res.status(403).json({ error: { code: 'PATIENT_NOT_ASSIGNED', message: 'Only the assigned clinician can adjust this care plan.' } }); return; }
    const plan = await CarePlan.findOneAndUpdate(
      { _id: routeParam(req.params.carePlanId, 'carePlanId'), patientId: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId, condition: 'HYPERTENSION' },
      { $set: { ...(input.goals !== undefined ? { goals: input.goals } : {}), ...(input.status ? { status: input.status } : {}), lastAdjustedByUserId: auth.userId, lastAdjustedAt: new Date() }, $inc: { version: 1 } },
      { new: true },
    );
    if (!plan) { res.status(404).json({ error: { code: 'CARE_PLAN_NOT_FOUND', message: 'Care plan not found.' } }); return; }
    res.json({ data: plan });
  } catch (error) { next(error); }
});


protectedRouter.get(
  '/patients/:patientId/service-cases',
  requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'),
  async (req: Request, res, next) => {
    try {
      const auth = authContext(req);
      const patientId = routeParam(req.params.patientId, 'patientId');

      const patient = await findAccessiblePatient(
        patientId,
        auth.organizationId,
        auth.roles,
        auth.userId,
      );

      if (!patient) {
        res.status(404).json({
          error: {
            code: 'PATIENT_NOT_FOUND',
            message: 'Patient not found.',
          },
        });
        return;
      }

      const serviceCases = await ServiceCase.find({
        organizationId: auth.organizationId,
        patientId,
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

      res.json({
        data: serviceCases,
      });
    } catch (error) {
      next(error);
    }
  },
);


protectedRouter.post('/patients/:patientId/service-cases', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const input = parseOrReply(serviceCaseSchema, req.body, res);
    if (!input) return;
    const auth = authContext(req);
    const patient = await Patient.findOne({
      _id: routeParam(req.params.patientId, 'patientId'),
      organizationId: auth.organizationId,
      status: 'ACTIVE',
    }).select('assignedClinicianId').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    if (String(patient.assignedClinicianId) !== auth.userId) {
      res.status(403).json({ error: { code: 'PATIENT_NOT_ASSIGNED', message: 'Only the assigned clinician can request an ApexCare service.' } });
      return;
    }
    const patientId = routeParam(req.params.patientId, 'patientId');
    const apexcareOrganization = await findApexCareOrganization();
    if (!apexcareOrganization) {
      res.status(503).json({ error: { code: 'APEXCARE_ORGANIZATION_NOT_CONFIGURED', message: 'ApexCare is not configured for this platform.' } });
      return;
    }
    const enrollment = await ApexCareEnrollment.findOne({
      patientId,
      clinicOrganizationId: auth.organizationId,
      apexcareOrganizationId: apexcareOrganization._id,
      status: 'ACTIVE',
    }).select('_id').lean();
    if (!enrollment) {
      res.status(409).json({ error: { code: 'APEXCARE_ENROLLMENT_REQUIRED', message: 'The patient must have an active ApexCare enrolment before requesting an ApexCare service.' } });
      return;
    }
    const serviceCase = await ServiceCase.create({
      ...input,
      organizationId: auth.organizationId,
      clinicOrganizationId: auth.organizationId,
      apexcareOrganizationId: apexcareOrganization._id,
      patientId,
      requestedByUserId: auth.userId,
    });
    res.status(201).json({ data: serviceCase });
  } catch (error) { next(error); }
});


protectedRouter.get('/service-cases', requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const input = parseOrReply(serviceCaseQuerySchema, req.query, res);
    if (!input) return;
    const auth = authContext(req);
    const filter: Record<string, unknown> = {
      organizationId: auth.organizationId,
      status: input.status ?? { $in: ['REQUESTED', 'ASSIGNED', 'SCHEDULED'] },
    };
    if (input.service) filter.service = input.service;
    const cases = await ServiceCase.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ data: cases });
  } catch (error) { next(error); }
});

protectedRouter.get('/service-cases/:caseId', requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const caseId = routeParam(req.params.caseId, 'caseId');
    const serviceCase = await ServiceCase.findOne({
      _id: caseId,
      organizationId: auth.organizationId,
    }).lean();
    if (!serviceCase) {
      res.status(404).json({ error: { code: 'SERVICE_CASE_NOT_FOUND', message: 'Service case not found.' } });
      return;
    }
    const [patient, requestingClinician] = await Promise.all([
      Patient.findOne({
        _id: serviceCase.patientId,
        organizationId: auth.organizationId,
        status: 'ACTIVE',
      }).select('name dateOfBirth sexAtBirth preferredLanguage preferredContactChannel conditions assignedClinicianId').lean(),
      User.findOne({
        _id: serviceCase.requestedByUserId,
        organizationId: auth.organizationId,
        roles: 'CLINICIAN',
        status: 'ACTIVE',
      }).select('_id name email roles').lean(),
    ]);
    if (!patient) {
      res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient linked to this service case was not found.' } });
      return;
    }
    res.json({ data: { serviceCase, patient, requestingClinician } });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/hypertension/progress-summary', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patient = await Patient.findOne({ _id: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId, status: 'ACTIVE' }).select('assignedClinicianId conditions').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    if (String(patient.assignedClinicianId) !== auth.userId) { res.status(403).json({ error: { code: 'PATIENT_NOT_ASSIGNED', message: 'Only the assigned clinician can view this clinical summary.' } }); return; }
    const hasHypertension = patient.conditions.some((condition) => condition.code === 'HYPERTENSION' && condition.status !== 'INACTIVE');
    if (!hasHypertension) { res.status(422).json({ error: { code: 'CONDITION_NOT_ENROLLED', message: 'Hypertension is not an active condition for this patient.' } }); return; }
    const summary = await buildHypertensionProgressSummary(auth.organizationId, routeParam(req.params.patientId, 'patientId'));
    if (!summary) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    res.json({ data: summary });
  } catch (error) { next(error); }
});

protectedRouter.post('/patients/:patientId/hypertension/care-plan-drafts', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patient = await Patient.findOne({ _id: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId, status: 'ACTIVE' }).select('assignedClinicianId enrollmentStatus').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    if (String(patient.assignedClinicianId) !== auth.userId) { res.status(403).json({ error: { code: 'PATIENT_NOT_ASSIGNED', message: 'Only the assigned clinician can access this care-plan workflow.' } }); return; }
    res.status(409).json({ error: { code: 'CARE_PLAN_GENERATION_OWNED_BY_APEXCARE', message: 'Care-plan generation starts after ApexCare coordinator and dietitian workflow completion.' } });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/hypertension/care-plan-drafts', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patient = await Patient.findOne({ _id: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId, status: 'ACTIVE' }).select('assignedClinicianId enrollmentStatus').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    if (String(patient.assignedClinicianId) !== auth.userId) { res.status(403).json({ error: { code: 'PATIENT_NOT_ASSIGNED', message: 'Only the assigned clinician can view draft care plans.' } }); return; }
    if (!['CARE_PLAN_REVIEW', 'ACTIVE_CARE'].includes(patient.enrollmentStatus)) {
      res.status(409).json({ error: { code: 'CARE_PLAN_NOT_AVAILABLE', message: 'The patient must be enrolled in ApexCare before care-plan drafts are available.' } }); return;
    }
    const drafts = await CarePlanDraft.find({ organizationId: auth.organizationId, patientId: routeParam(req.params.patientId, 'patientId') }).sort({ createdAt: -1 }).limit(20).lean();
    res.json({ data: drafts });
  } catch (error) { next(error); }
});

protectedRouter.patch('/patients/:patientId/hypertension/care-plan-drafts/:draftId', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patientId = routeParam(req.params.patientId, 'patientId');
    const draftId = routeParam(req.params.draftId, 'draftId');
    const input = parseOrReply(hypertensionDraftPlanSchema, req.body, res);
    if (!input) return;
    const patient = await Patient.findOne({ _id: patientId, organizationId: auth.organizationId, status: 'ACTIVE' }).select('assignedClinicianId').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    if (String(patient.assignedClinicianId) !== auth.userId) { res.status(403).json({ error: { code: 'PATIENT_NOT_ASSIGNED', message: 'Only the assigned clinician can edit a draft care plan.' } }); return; }
    const draft = await CarePlanDraft.findOneAndUpdate(
      { _id: draftId, organizationId: auth.organizationId, patientId, condition: 'HYPERTENSION', status: { $in: ['GENERATED', 'CLINICIAN_REVIEW'] } },
      { $set: { plan: input } },
      { new: true, runValidators: true },
    ).lean();
    if (!draft) { res.status(404).json({ error: { code: 'CARE_PLAN_DRAFT_NOT_FOUND', message: 'Editable hypertension draft not found.' } }); return; }
    res.json({ data: draft });
  } catch (error) { next(error); }
});

protectedRouter.patch('/patients/:patientId/hypertension/care-plan-drafts/:draftId/reject', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patient = await Patient.findOne({ _id: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId, status: 'ACTIVE' }).select('assignedClinicianId').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    if (String(patient.assignedClinicianId) !== auth.userId) { res.status(403).json({ error: { code: 'PATIENT_NOT_ASSIGNED', message: 'Only the assigned clinician can reject a draft care plan.' } }); return; }
    const draft = await CarePlanDraft.findOneAndUpdate(
      { _id: routeParam(req.params.draftId, 'draftId'), patientId: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId, condition: 'HYPERTENSION', status: { $in: ['GENERATED', 'CLINICIAN_REVIEW'] } },
      { $set: { status: 'REJECTED', rejectedByUserId: auth.userId, rejectedAt: new Date() } },
      { new: true },
    ).lean();
    if (!draft) { res.status(404).json({ error: { code: 'CARE_PLAN_DRAFT_NOT_FOUND', message: 'Generated hypertension care-plan draft not found or already processed.' } }); return; }
    res.json({ data: draft });
  } catch (error) { next(error); }
});

protectedRouter.patch('/patients/:patientId/hypertension/care-plan-drafts/:draftId/approve', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patient = await Patient.findOne({ _id: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId, status: 'ACTIVE' }).select('assignedClinicianId').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    if (String(patient.assignedClinicianId) !== auth.userId) { res.status(403).json({ error: { code: 'PATIENT_NOT_ASSIGNED', message: 'Only the assigned clinician can approve a draft care plan.' } }); return; }
    const plan = await approveHypertensionCarePlanDraft(auth.organizationId, routeParam(req.params.patientId, 'patientId'), routeParam(req.params.draftId, 'draftId'), auth.userId);
    if (plan && !('error' in plan)) await Patient.updateOne({ _id: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId }, { $set: { enrollmentStatus: 'ACTIVE_CARE' } });
    if (!plan) { res.status(404).json({ error: { code: 'CARE_PLAN_DRAFT_NOT_FOUND', message: 'Generated hypertension care-plan draft not found or already processed.' } }); return; }
    if ('error' in plan) {
      const status = plan.error === 'INVALID_CARE_PLAN_DRAFT' ? 422 : 409;
      const message = plan.error === 'INVALID_CARE_PLAN_DRAFT'
        ? 'The care-plan draft is incomplete and cannot be approved.'
        : 'An active hypertension care plan already exists for this patient.';
      res.status(status).json({ error: { code: plan.error, message } });
      return;
    }
    const tasks = await CareTask.find({ organizationId: auth.organizationId, patientId: routeParam(req.params.patientId, 'patientId'), carePlanId: plan._id }).lean();
    const reminderResults = await Promise.allSettled(tasks.map((task) => scheduleCareTaskReminder(String(task._id), task.dueAt, { organizationId: auth.organizationId, patientId: String(task.patientId) })));
    if (reminderResults.some((result) => result.status === 'rejected')) console.error('One or more care-task reminders could not be scheduled.');
    res.status(201).json({ data: { plan, tasks } });
  } catch (error) { next(error); }
});

protectedRouter.post('/patients/:patientId/care-plans', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(carePlanSchema, req.body, res);
    if (!input) return;
    const patient = await Patient.findOne({ _id: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId, status: 'ACTIVE' }).select('_id assignedClinicianId enrollmentStatus conditions').lean();
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    if (String(patient.assignedClinicianId) !== auth.userId) { res.status(403).json({ error: { code: 'PATIENT_NOT_ASSIGNED', message: 'Only the assigned clinician can create this care plan.' } }); return; }
    if (!['CARE_PLAN_REVIEW', 'ACTIVE_CARE'].includes(patient.enrollmentStatus)) {
      res.status(409).json({ error: { code: 'CARE_PLAN_NOT_AVAILABLE', message: 'The patient must be enrolled in ApexCare before creating a care plan.' } }); return;
    }
    if (input.condition !== 'HYPERTENSION') { res.status(422).json({ error: { code: 'CONDITION_NOT_AVAILABLE', message: 'Only hypertension is enabled in the current MVP.' } }); return; }
    const hasHypertension = patient.conditions.some((condition) => condition.code === 'HYPERTENSION' && condition.status !== 'INACTIVE');
    if (!hasHypertension) { res.status(422).json({ error: { code: 'CONDITION_NOT_ENROLLED', message: 'Hypertension is not an active condition for this patient.' } }); return; }
    const endDate = new Date(input.startDate);
    endDate.setUTCDate(endDate.getUTCDate() + 90);
    if (input.tasks.some((task) => task.dueAt < input.startDate || task.dueAt > endDate)) {
      res.status(422).json({ error: { code: 'TASK_OUTSIDE_PLAN', message: 'Every task must fall within the 90-day plan.' } }); return;
    }
    const plan = await CarePlan.create({ organizationId: auth.organizationId, patientId: routeParam(req.params.patientId, 'patientId'), condition: input.condition, startDate: input.startDate, endDate, goals: input.goals, createdByUserId: auth.userId });
    const taskDocuments = input.tasks.map((task) => ({
      ...task,
      ...(task.taskKey ? { taskKey: task.taskKey } : {}),
      organizationId: auth.organizationId,
      patientId: routeParam(req.params.patientId, 'patientId'),
      carePlanId: plan._id,
    }));
    const tasks = await CareTask.insertMany(taskDocuments);
    await ensureCarePlanExecution({ organizationId: auth.organizationId, patientId: routeParam(req.params.patientId, 'patientId'), carePlanId: String(plan._id) });
    await attachCarePlanTasksToExecution({ organizationId: auth.organizationId, patientId: routeParam(req.params.patientId, 'patientId'), carePlanId: String(plan._id), tasks });
    const reminderResults = await Promise.allSettled(tasks.map((task) => scheduleCareTaskReminder(String(task._id), task.dueAt, { organizationId: auth.organizationId, patientId: String(task.patientId) })));
    if (reminderResults.some((result) => result.status === 'rejected')) {
      console.error('One or more care-task reminders could not be scheduled.');
    }
    res.status(201).json({ data: { plan, tasks } });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/care-plans/:carePlanId/execution', requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patientId = routeParam(req.params.patientId, 'patientId');
    const carePlanId = routeParam(req.params.carePlanId, 'carePlanId');
    const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const execution = await getCarePlanExecution({ organizationId: auth.organizationId, patientId, carePlanId });
    if (!execution) { res.status(404).json({ error: { code: 'CARE_PLAN_EXECUTION_NOT_FOUND', message: 'Care-plan execution not found.' } }); return; }
    res.json({ data: execution });
  } catch (error) { next(error); }
});

protectedRouter.patch('/patients/:patientId/care-plans/:carePlanId/execution/milestones/:milestoneId', requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patientId = routeParam(req.params.patientId, 'patientId');
    const carePlanId = routeParam(req.params.carePlanId, 'carePlanId');
    const milestoneId = routeParam(req.params.milestoneId, 'milestoneId');
    const input = parseOrReply(z.object({ action: z.enum(['COMPLETE', 'SKIP']) }), req.body, res);
    if (!input) return;
    const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const result = await transitionCarePlanMilestone({
      organizationId: auth.organizationId,
      patientId,
      carePlanId,
      milestoneId,
      action: input.action,
      actorUserId: auth.userId,
    });
    if ('error' in result) {
      const status = result.error === 'CARE_PLAN_MILESTONE_NOT_FOUND' || result.error === 'CARE_PLAN_EXECUTION_NOT_FOUND' ? 404 : 409;
      res.status(status).json({ error: { code: result.error, message: 'The care-plan milestone could not be transitioned.' } });
      return;
    }
    res.json({ data: result.milestone, idempotent: result.idempotent });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/care-plan-reviews/:reviewId', requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patientId = routeParam(req.params.patientId, 'patientId');
    const reviewId = routeParam(req.params.reviewId, 'reviewId');
    const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const review = await getPatientReview({ organizationId: auth.organizationId, patientId, reviewId });
    if (!review) { res.status(404).json({ error: { code: 'PATIENT_REVIEW_NOT_FOUND', message: 'Patient review not found.' } }); return; }
    res.json({ data: review });
  } catch (error) { next(error); }
});

protectedRouter.patch('/patients/:patientId/care-plan-reviews/:reviewId/complete', requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patientId = routeParam(req.params.patientId, 'patientId');
    const reviewId = routeParam(req.params.reviewId, 'reviewId');
    const input = parseOrReply(patientReviewCompletionSchema, req.body, res);
    if (!input) return;
    const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const review = await completePatientReview({
      organizationId: auth.organizationId,
      patientId,
      reviewId,
      actorUserId: auth.userId,
      answers: input.answers,
      notes: input.notes,
      vitalsRecordId: input.vitalsRecordId,
    });
    if (!review) { res.status(404).json({ error: { code: 'PATIENT_REVIEW_NOT_OPEN', message: 'Patient review is not open.' } }); return; }
    res.json({ data: review });
  } catch (error) { next(error); }
});


protectedRouter.get('/clinical-signals', requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const patientId = typeof req.query.patientId === 'string' ? req.query.patientId : undefined;
    const signals = await listClinicalSignals({ organizationId: auth.organizationId, status, patientId, clinicianUserId: auth.roles.includes('CLINICIAN') ? auth.userId : undefined });
    res.json({ data: signals });
  } catch (error) { next(error); }
});

protectedRouter.patch('/clinical-signals/:signalId/review', requireRoles('CLINICIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const signalId = routeParam(req.params.signalId, 'signalId');
    const input = z.object({ decision: z.enum(['ACTION_REQUIRED', 'REVIEWED', 'DISMISSED']), notes: z.string().trim().max(2000).optional() }).safeParse(req.body);
    if (!input.success) { res.status(422).json({ error: { code: 'INVALID_CLINICAL_SIGNAL_REVIEW', message: 'Invalid clinical signal review.' } }); return; }
    const result = await reviewClinicalSignal({ organizationId: auth.organizationId, signalId, clinicianUserId: auth.userId, decision: input.data.decision, notes: input.data.notes });
    if (!result) { res.status(404).json({ error: { code: 'CLINICAL_SIGNAL_NOT_FOUND', message: 'Clinical signal not found, not open, or not assigned to this clinician.' } }); return; }
    res.json({ data: result });
  } catch (error) { next(error); }
});

protectedRouter.get('/coordinator/escalations', requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusParam && statusParam !== 'OPEN' && statusParam !== 'RESOLVED') { res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid escalation status.' } }); return; }
    const limitValue = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const limit = Number.isFinite(limitValue) ? limitValue : undefined;
    const escalations = await listCoordinatorEscalations({ organizationId: auth.organizationId, status: statusParam as 'OPEN' | 'RESOLVED' | undefined, limit });
    res.json({ data: escalations });
  } catch (error) { next(error); }
});

protectedRouter.patch('/coordinator/escalations/:caseId/resolve', requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const caseId = routeParam(req.params.caseId, 'caseId');
    const input = parseOrReply(coordinatorEscalationResolutionSchema, req.body, res);
    if (!input) return;
    const result = await resolveCoordinatorEscalation({ organizationId: auth.organizationId, escalationId: caseId, coordinatorUserId: auth.userId, outcome: input.outcome, notes: input.notes });
    if (!result) { res.status(409).json({ error: { code: 'COORDINATOR_ESCALATION_NOT_OPEN', message: 'Escalation is missing or already resolved.' } }); return; }
    res.json({ data: result });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/care-plan-communications', requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req); const patientId = routeParam(req.params.patientId, 'patientId');
    const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const communications = await PatientCommunication.find({ organizationId: auth.organizationId, patientId }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ data: communications });
  } catch (error) { next(error); }
});

protectedRouter.get('/patients/:patientId/care-plans', requireRoles('CLINIC_ADMIN', 'CLINICIAN', 'CLINIC_COORDINATOR'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const patient = await findAccessiblePatient(routeParam(req.params.patientId, 'patientId'), auth.organizationId, auth.roles, auth.userId);
    if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
    const plans = await CarePlan.find({ patientId: routeParam(req.params.patientId, 'patientId'), organizationId: auth.organizationId }).sort({ startDate: -1 }).lean();
    res.json({ data: plans });
  } catch (error) { next(error); }
});



