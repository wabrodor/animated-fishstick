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

protectedRouter.get('/clinic-team', requireRoles('CLINIC_ADMIN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const staff = await User.find({
      organizationId: auth.organizationId,
      roles: { $in: ['CLINICIAN', 'CLINIC_COORDINATOR'] },
    }).select('_id name email roles status mustChangePassword createdAt').sort({ name: 1 }).lean();
    res.json({ data: staff });
  } catch (error) { next(error); }
});

protectedRouter.post('/clinic-team', requireRoles('CLINIC_ADMIN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const input = parseOrReply(staffCreateSchema, req.body, res);
    if (!input) return;
    const passwordHash = await bcrypt.hash(input.temporaryPassword, 12);
    const user = await User.create({
      organizationId: auth.organizationId,
      name: input.name,
      email: input.email.toLowerCase(),
      passwordHash,
      roles: [input.role],
      mustChangePassword: true,
    });
    res.status(201).json({
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        roles: user.roles,
        status: user.status,
        mustChangePassword: true,
      },
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      res.status(409).json({ error: { code: 'STAFF_EMAIL_EXISTS', message: 'A staff account with this email already exists in this clinic.' } }); return;
    }
    next(error);
  }
});

protectedRouter.patch('/clinic-team/:userId/status', requireRoles('CLINIC_ADMIN'), async (req: Request, res, next) => {
  try {
    const input = parseOrReply(staffStatusSchema, req.body, res);
    if (!input) return;
    const auth = authContext(req);
    const user = await User.findOneAndUpdate(
      { _id: routeParam(req.params.userId, 'userId'), organizationId: auth.organizationId, roles: { $in: ['CLINICIAN', 'CLINIC_COORDINATOR'] } },
      { $set: { status: input.status } },
      { new: true },
    ).select('_id name email roles status mustChangePassword');
    if (!user) { res.status(404).json({ error: { code: 'STAFF_NOT_FOUND', message: 'Clinic staff account not found.' } }); return; }
    res.json({ data: user });
  } catch (error) { next(error); }
});


publicRouter.post('/auth/register-organization', async (req: Request, res: Response, next) => {
  try {
    const input = parseOrReply(registerSchema, req.body, res);
    if (!input) return;
    const organization = await Organization.create({ name: input.organizationName, type: 'CLINIC' });
    const periodStart = new Date();
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
    const subscription = await Subscription.create({
      organizationId: organization._id,
      planCode: 'TRIAL_50',
      status: 'TRIAL',
      activePatientLimit: 50,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    });
    try {
      const passwordHash = await bcrypt.hash(input.password, 12);
      const admin = await User.create({ organizationId: organization._id, name: input.adminName, email: input.email.toLowerCase(), passwordHash, roles: ['CLINIC_ADMIN'] });
      organization.adminUserId = admin._id;
      organization.subscriptionId = subscription._id;
      await organization.save();
      const token = issueAccessToken({ userId: String(admin._id), organizationId: String(organization._id), roles: ['CLINIC_ADMIN'] });
      res.status(201).json({ data: { organization: { id: organization.id, name: organization.name }, user: { id: admin.id, name: admin.name, email: admin.email, roles: admin.roles }, accessToken: token } });
    } catch (error) {
      await User.deleteMany({ organizationId: organization._id });
      await Subscription.deleteOne({ _id: subscription._id });
      await Organization.deleteOne({ _id: organization._id });
      throw error;
    }
    return;
  } catch (error) {
    if (isDuplicateKey(error)) { res.status(409).json({ error: { code: 'EMAIL_EXISTS', message: 'An account with this email already exists.' } }); return; }
    next(error);
  }
});

publicRouter.post('/auth/login', async (req: Request, res: Response, next) => {
  try {
    const input = parseOrReply(loginSchema, req.body, res);
    if (!input) return;
    const user = await User.findOne({ email: input.email.toLowerCase() }).select('+passwordHash');
    if (!user || user.status !== 'ACTIVE' || !(await bcrypt.compare(input.password, user.passwordHash))) {
      res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } }); return;
    }
    const organization = await Organization.exists({ _id: user.organizationId, status: 'ACTIVE' });
    if (!organization) {
      res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } }); return;
    }
    const token = issueAccessToken({ userId: user.id, organizationId: String(user.organizationId), roles: user.roles as Role[] });
    res.json({ data: { accessToken: token, user: { id: user.id, name: user.name, email: user.email, roles: user.roles, mustChangePassword: user.mustChangePassword } } });
  } catch (error) { next(error); }
});

protectedRouter.get('/me', async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const user = await User.findOne({ _id: auth.userId, organizationId: auth.organizationId }).lean();

    if (!user) {
      res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found.',
        },
      });
      return;
    }
    res.json({ data: user && { id: String(user._id), name: user.name, email: user.email, roles: user.roles, organizationId: String(user.organizationId),    mustChangePassword: user.mustChangePassword} });
  } catch (error) { next(error); }
});


protectedRouter.patch('/me/password', async (req: Request, res, next) => {
  try {
    const input = parseOrReply(passwordChangeSchema, req.body, res);
    if (!input) return;
    const auth = authContext(req);
    const user = await User.findOne({ _id: auth.userId, organizationId: auth.organizationId }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
      res.status(401).json({ error: { code: 'INVALID_PASSWORD', message: 'Current password is incorrect.' } }); return;
    }
    user.passwordHash = await bcrypt.hash(input.newPassword, 12);
    user.mustChangePassword = false;
    await user.save();
    res.json({ data: { success: true, mustChangePassword: false } });
  } catch (error) { next(error); }
});

