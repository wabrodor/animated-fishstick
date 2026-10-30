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

export const conditionCodes = ['HYPERTENSION', 'TYPE_2_DIABETES', 'DYSLIPIDEMIA', 'PCOS'] as const;
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid identifier.');

export const registerSchema = z.object({
  organizationName: z.string().trim().min(2).max(160),
  adminName: z.string().trim().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(12).max(128),
});
export const visitReviewSchema = z.object({
  visitAt: z.coerce.date().default(() => new Date()),

  answers: z.array(
    z.object({
      questionId: z.string().trim().min(1).max(80),
      topic: z.enum([
        'MEDICATION_ADHERENCE',
        'HOME_BP',
        'SYMPTOMS',
        'LABS',
        'LIFESTYLE',
        'CARE_PLAN',
        'FOLLOW_UP',
      ]),
      question: z.string().trim().min(1).max(300),
      answer: z.string().trim().max(1000).optional(),
    }),
  ).max(20),
});

export const patientReviewCompletionSchema = z.object({
  answers: z.array(
    z.object({
      questionId: z.string().trim().min(1).max(80),
      topic: z.string().trim().min(1).max(80),
      question: z.string().trim().min(1).max(300),
      answer: z.string().trim().max(1000).optional(),
    }),
  ).max(20),
  notes: z.string().trim().max(3000).optional(),
  vitalsRecordId: objectIdSchema.optional(),
});

export const coordinatorEscalationResolutionSchema = z.object({ outcome: z.string().trim().min(1).max(500), notes: z.string().trim().max(2000).optional() });
export const coordinatorReviewContactSchema = z.object({
  outcome: z.enum(['CONTACTED', 'UNANSWERED']),
  notes: z.string().trim().max(1000).optional(),
});
export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
export const passwordChangeSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12).max(128) });
export const clinicianPatientSchema = z.object({
  medicalRecordNumber: z.string().trim().min(1).max(64).optional(),
  name: z.object({ first: z.string().trim().min(1).max(80), last: z.string().trim().max(80).optional() }),
  ageAtRegistration: z.number().int().min(0).max(130),
  sexAtBirth: z.enum(['FEMALE', 'MALE', 'INTERSEX', 'NOT_RECORDED']).optional(),
  phone: z.string().trim().min(7).max(25).optional(),
  whatsapp: z.string().trim().min(7).max(25).optional(),
  preferredLanguage: z.string().trim().min(2).max(20).default('en'),
  preferredContactChannel: z.enum(['PHONE', 'SMS', 'WHATSAPP', 'APP']).default('PHONE'),
  assignedClinicianId: objectIdSchema.optional(),
  diagnosis: z.object({
    condition: z.enum(['HYPERTENSION', 'TYPE_2_DIABETES', 'DYSLIPIDEMIA', 'PCOS']),
    diagnosedAt: z.coerce.date().optional(),
    notes: z.string().trim().max(2000).optional(),
  }),
});

export const enrolPatientSchema = z.object({
  communicationConsent: z.literal(true),
  consentMethod: z.enum(['VERBAL', 'WRITTEN', 'DIGITAL']),
  consentVersion: z.string().trim().min(1).max(40),
});

export const enrollmentProfileSchema = z.object({
  phone: z.string().trim().min(7).max(25),
  whatsapp: z.string().trim().min(7).max(25).optional(),
  dateOfBirth: z.coerce.date(),
  sexAtBirth: z.enum(['FEMALE', 'MALE', 'INTERSEX', 'NOT_RECORDED']).optional(),
  preferredLanguage: z.string().trim().min(2).max(20).optional(),
  preferredContactChannel: z.enum(['PHONE', 'SMS', 'WHATSAPP', 'APP']).optional(),
});

export const medicationDraftItemSchema = z.object({
  name: z.string().trim().min(1).max(160),
  strength: z.string().trim().max(80).optional(),
  dose: z.string().trim().max(80).optional(),
  route: z.string().trim().max(40).optional(),
  frequency: z.string().trim().max(80).optional(),
  duration: z.string().trim().max(80).optional(),
  instructions: z.string().trim().max(500).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceText: z.string().trim().max(1000).optional(),
});

export const prescriptionDocumentSchema = z.object({
  source: z.enum(['IMAGE', 'PAPER_IMAGE', 'EMR_DOCUMENT']).default('IMAGE'),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  imageBase64: z.string().min(1).max(8_000_000),
});

export const medicationSubmitSchema = z.object({
  medications: z.array(medicationDraftItemSchema).max(50),
});


export const medicationFinalizeSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});

export const clinicalReviewDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'ESCALATE_TO_APEXCARE']),
  reason: z.string().trim().min(1).max(1000).optional(),
});

export const apexCareClinicalReviewDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().min(1).max(1000).optional(),
  protocolSafe: z.literal(true),
});

export const coordinatorCallSchema = z.object({
  status: z.enum(['CONTACTED', 'NO_ANSWER', 'ESCALATED']),
});

export const apexGeneralHistoryAnswerSchema = z.object({
  questionId: z.string().trim().min(1).max(80),
  section: z.enum(['PAST_MEDICAL', 'FAMILY', 'SOCIAL', 'ALLERGIES', 'REPRODUCTIVE', 'PRIOR_INVESTIGATIONS']),
  question: z.string().trim().min(1).max(300),
  answer: z.enum(['YES', 'NO', 'UNKNOWN', 'DECLINED']),
  details: z.string().trim().max(2000).optional(),
});

export const apexGeneralHistorySaveSchema = z.object({
  questionnaireVersion: z.string().trim().min(1).max(40),
  answers: z.array(apexGeneralHistoryAnswerSchema).max(30),
  notes: z.string().trim().max(3000).optional(),
  record: z.boolean().optional().default(false),
  // Compatibility alias for an older frontend build. It now means record,
  // never submit for clinician approval.
  submit: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.questionnaireVersion !== APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['questionnaireVersion'], message: 'Unsupported general-history questionnaire version.' });
  }
  const seen = new Set<string>();
  for (const [index, answer] of value.answers.entries()) {
    if (seen.has(answer.questionId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers', index, 'questionId'], message: 'Duplicate question answers are not allowed.' });
    }
    seen.add(answer.questionId);
    const definition = APEX_GENERAL_HISTORY_QUESTIONS.find((question) => question.questionId === answer.questionId);
    if (!definition) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers', index, 'questionId'], message: 'Unknown general-history question.' });
      continue;
    }
    if (answer.section !== definition.section) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers', index, 'section'], message: 'Question section does not match the questionnaire.' });
    }
    const shouldRecord = value.record || value.submit === true;
    if (shouldRecord && answer.answer === 'YES' && definition.detailsRequiredOnYes && !answer.details?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers', index, 'details'], message: 'Please record the follow-up details for this Yes answer.' });
    }
  }
  if ((value.record || value.submit === true) && seen.size !== APEX_GENERAL_HISTORY_QUESTIONS.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answers'], message: 'Answer every general-history question before recording the history.' });
  }
});

export const medicationDraftCreateSchema = z.object({
  extractionSource: z.enum(['OCR', 'MANUAL_TRANSCRIPTION']),
  rawText: z.string().trim().max(20000).optional(),
  medications: z.array(medicationDraftItemSchema).max(50).default([]),
});

export const medicationDraftReviewSchema = z.object({
  status: z.enum(['VERIFIED', 'REJECTED']),
  rejectionReason: z.string().trim().max(1000).optional(),
});

export const dietitianAssessmentSchema = z.object({
  remarks: z.string().trim().min(1).max(5000),
  assessmentData: z.record(z.unknown()).optional(),
});

export const diagnosisRecordSchema = z.object({
  condition: z.enum(['HYPERTENSION', 'TYPE_2_DIABETES', 'DYSLIPIDEMIA', 'PCOS']),
  diagnosedAt: z.coerce.date().optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const staffCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email(),
  role: z.enum(['CLINICIAN', 'CLINIC_COORDINATOR']),
  temporaryPassword: z.string().min(12).max(128),
});

export const staffStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) });

export const vitalRecordSchema = z.object({
  recordedAt: z.coerce.date().default(() => new Date()),
  source: z.enum(['OPD', 'HOME', 'DEVICE']).default('OPD'),
  bloodPressure: z.object({
    systolic: z.coerce.number().min(40).max(300),
    diastolic: z.coerce.number().min(20).max(200),
    pulse: z.coerce.number().min(20).max(250).optional(),
  }).optional(),
  bloodSugar: z.object({
    value: z.coerce.number().min(10).max(1000),
    type: z.enum(['FASTING', 'POST_PRANDIAL', 'RANDOM', 'HBA1C']),
    unit: z.enum(['MG_DL', 'PERCENT']).default('MG_DL'),
  }).optional(),
  weightKg: z.coerce.number().min(1).max(500).optional(),
  symptoms: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  notes: z.string().trim().max(2000).optional(),
}).refine((value) => value.bloodPressure || value.bloodSugar || value.weightKg || value.symptoms.length > 0, {
  message: 'At least one vital or symptom is required.',
});

export const opdVisitSchema = z.object({
  visitAt: z.coerce.date().default(() => new Date()),
  clinicianId: objectIdSchema,
  reason: z.string().trim().max(500).optional(),
  assessment: z.string().trim().max(5000).optional(),
  planAdjustment: z.string().trim().max(5000).optional(),
  carePlanId: objectIdSchema.optional(),
  vitals: vitalRecordSchema.optional(),
});

export const carePlanAdjustmentSchema = z.object({
  goals: z.array(z.object({
    title: z.string().trim().min(1).max(180),
    target: z.string().trim().max(120).optional(),
    unit: z.string().trim().max(32).optional(),
  })).max(10).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional(),
});

export const taskCompleteSchema = z.object({
  status: z.enum(['COMPLETED', 'SKIPPED']).default('COMPLETED'),
});

export const serviceCaseSchema = z.object({
  service: z.enum(['DIETITIAN', 'ENDOCRINOLOGY']),
  reason: z.string().trim().max(1000).refine((value) => value.length > 0, { message: 'Reason is required.' }),
});

export const serviceCaseQuerySchema = z.object({
  status: z.enum(['REQUESTED', 'ASSIGNED', 'SCHEDULED', 'COMPLETED', 'CANCELLED']).optional(),
  service: z.enum(['DIETITIAN', 'ENDOCRINOLOGY']).optional(),
});

export const deactivatePatientSchema = z.object({ status: z.literal('INACTIVE') });
export const carePlanSchema = z.object({
  condition: z.enum(conditionCodes),
  startDate: z.coerce.date(),
  goals: z.array(z.object({ title: z.string().trim().min(1).max(180), target: z.string().trim().max(120).optional(), unit: z.string().trim().max(32).optional() })).max(10).default([]),
  tasks: z.array(z.object({
    type: z.enum(['OPD_VISIT', 'VITALS', 'LAB', 'MEDICATION', 'DIETITIAN_SESSION', 'FOLLOW_UP']),
    title: z.string().trim().min(1).max(180),
    dueAt: z.coerce.date(),
    taskKey: z.string().trim().regex(/^[A-Z0-9_:-]{1,220}$/).optional(),
  })).min(1).max(90),
});

export const hypertensionDraftPlanSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  goals: z.array(z.object({ title: z.string().trim().min(1).max(180), target: z.string().trim().max(120).optional(), unit: z.string().trim().max(32).optional(), rationale: z.string().trim().max(500).optional() })).max(10),
  tasks: z.array(z.object({ type: z.enum(['OPD_VISIT', 'VITALS', 'LAB', 'DIETITIAN_SESSION', 'FOLLOW_UP']), title: z.string().trim().min(1).max(180), dueDay: z.number().int().min(0).max(90), rationale: z.string().trim().max(500).optional() })).max(20),
  clinicalInterventionNeeded: z.boolean(),
  confidence: z.number().min(0).max(1),
  safetyNotes: z.array(z.string().trim().min(1).max(500)).max(10),
});

export function parseOrReply<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | undefined {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed.', details: parsed.error.flatten() } });
    return undefined;
  }
  return parsed.data;
}

export function authContext(req: Request) {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth) throw new Error('Authentication context missing after authentication middleware.');
  return auth;
}

export async function findApexCareOrganization() {
  return Organization.findOne({ type: 'APEXCARE', status: 'ACTIVE' }).select('_id name type').lean();
}

export function routeParam(value: string | string[], name: string): string {
  if (Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid route parameter: ${name}`);
  }
  return value;
}

export async function findAccessiblePatient(patientId: string, organizationId: string, roles: Role[], userId: string) {
  const filter: Record<string, unknown> = { _id: patientId, organizationId, status: 'ACTIVE' };
  if (roles.includes('CLINICIAN') && !roles.includes('CLINIC_ADMIN') && !roles.includes('CLINIC_COORDINATOR')) filter.assignedClinicianId = userId;
  return Patient.findOne(filter).lean();
}

export const publicRouter = Router();
export const protectedRouter = Router();

for (const parameter of ['userId', 'patientId', 'carePlanId', 'taskId', 'caseId', 'draftId', 'enrollmentId', 'documentId', 'milestoneId', 'reviewId']) {
  protectedRouter.param(parameter, (req, res, next, value) => {
    if (!objectIdSchema.safeParse(value).success) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: `Invalid ${parameter}.` } });
      return;
    }
    next();
  });
}

export function careTaskPriority(task: { status?: string; dueAt?: Date | string }, now: Date): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (task.status === 'OVERDUE' || task.status === 'SKIPPED') return 'HIGH';
  const dueAt = task.dueAt ? new Date(task.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const hoursUntilDue = (dueAt - now.getTime()) / (60 * 60 * 1000);
  if (hoursUntilDue <= 24) return 'HIGH';
  if (hoursUntilDue <= 72) return 'MEDIUM';
  return 'LOW';
}

export function isDuplicateKey(error: unknown): error is { code: number } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: number }).code === 11000;
}

export async function reservePatientSlot(organizationId: string) {
  const now = new Date();
  return Subscription.findOneAndUpdate(
    {
      organizationId,
      status: { $in: ['TRIAL', 'ACTIVE'] },
      currentPeriodStart: { $lte: now },
      currentPeriodEnd: { $gt: now },
      $expr: { $lt: ['$activePatientCount', '$activePatientLimit'] },
    },
    { $inc: { activePatientCount: 1 } },
    { new: true },
  );
}

export function isKnownValidationError(error: unknown): error is ZodError { return error instanceof ZodError; }

