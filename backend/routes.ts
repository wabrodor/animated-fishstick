import bcrypt from 'bcrypt';
import { ensureCarePlanExecution, attachCarePlanTasksToExecution, getCarePlanExecution, getMilestoneDay, transitionCarePlanMilestone } from './care-plan-execution.js';
import { createHash } from 'node:crypto';
import { Router, raw, type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { env } from './config.js';
import { issueAccessToken, requireOrganizationType, requireRoles, type AuthenticatedRequest } from './auth.js';
import { enqueueOutboxEvent } from './outbox.js';
import { listNotifications, markAllNotificationsRead, markNotificationRead } from './notifications.js';
import { scheduleApexCareReferralEscalation, scheduleCarePlanReviewSla, scheduleCareTaskReminder, scheduleCoordinatorCallSla, scheduleHypertensionDraftGeneration, schedulePrescriptionAnalysis, schedulePrescriptionVerification } from './queues.js';
import { buildHypertensionProgressSummary } from './ai.js';
import { generateHypertensionVisitAssist } from './visit-assist.js';
import { approveHypertensionCarePlanDraft, approveHypertensionCarePlanDraftAsApexCare, generateHypertensionCarePlanDraft } from './ai-care-plan.js';
import { getPrescriptionOcrRuntimeStatus, type MedicationCandidate } from './prescription-analysis.js';
import { approveMedicationClinicalReview, escalateMedicationClinicalReview, openMedicationClinicalReview, rejectMedicationClinicalReview } from './clinical-review.js';
import { completePatientReview, getPatientReview } from './patient-review.js';
import { createCareTaskReminderCommunication, createPatientReviewReminderCommunication } from './patient-communication.js';
import { listCoordinatorEscalations, resolveCoordinatorEscalation } from './coordinator-escalation.js';
import { ensureLabClinicalSignals, listClinicalSignals, reviewClinicalSignal } from './clinical-signal.js';
import { readPrescriptionImage, savePrescriptionImage } from './storage.js';
import { createLabDocument } from './lab-document.js';
import { ApexCareEnrollment, ApexCareReferral, CarePlan, CarePlanDraft, CarePlanMilestone, CareTask, PatientCommunication, Diagnosis, DietitianAssessment, Organization, Patient, PatientClinicRelationship, PrescriptionDocument, MedicationDraft, MedicationRecord, MedicationHistory, ClinicalReviewCase, ClinicalReviewEvent, LabResult, ProgramConsent, Subscription, User, VitalRecord, OpdVisit, ServiceCase, VisitReview, PatientReview, LabDocument, LabInterpretation, type Role } from './models.js';

const conditionCodes = ['HYPERTENSION', 'TYPE_2_DIABETES', 'DYSLIPIDEMIA', 'PCOS'] as const;
const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid identifier.');

const registerSchema = z.object({
  organizationName: z.string().trim().min(2).max(160),
  adminName: z.string().trim().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(12).max(128),
});
const visitReviewSchema = z.object({
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

const patientReviewCompletionSchema = z.object({
  answers: z.array(
    z.object({
      questionId: z.string().trim().min(1).max(80),
      topic: z.enum([
        'MEDICATION_ADHERENCE',
        'DIET_ADHERENCE',
        'LIFESTYLE_ADHERENCE',
        'LABS',
        'SYMPTOMS',
        'CARE_PLAN',
        'PATIENT_CONCERNS',
        'HOME_BP',
        'LIFESTYLE',
        'FOLLOW_UP',
      ]),
      question: z.string().trim().min(1).max(300),
      answer: z.string().trim().max(1000).optional(),
    }),
  ).max(20),
  notes: z.string().trim().max(3000).optional(),
  vitalsRecordId: objectIdSchema.optional(),
});

const coordinatorEscalationResolutionSchema = z.object({ outcome: z.string().trim().min(1).max(500), notes: z.string().trim().max(2000).optional() });
const coordinatorReviewContactSchema = z.object({
  outcome: z.enum(['CONTACTED', 'UNANSWERED']),
  notes: z.string().trim().max(1000).optional(),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const passwordChangeSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12).max(128) });
const clinicianPatientSchema = z.object({
  medicalRecordNumber: z.string().trim().min(1).max(64).optional(),
  name: z.object({ first: z.string().trim().min(1).max(80), last: z.string().trim().max(80).optional() }),
  dateOfBirth: z.coerce.date().optional(),
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

const enrolPatientSchema = z.object({
  communicationConsent: z.literal(true),
  consentMethod: z.enum(['VERBAL', 'WRITTEN', 'DIGITAL']),
  consentVersion: z.string().trim().min(1).max(40),
});

const enrollmentProfileSchema = z.object({
  phone: z.string().trim().min(7).max(25),
  whatsapp: z.string().trim().min(7).max(25).optional(),
  dateOfBirth: z.coerce.date().optional(),
  sexAtBirth: z.enum(['FEMALE', 'MALE', 'INTERSEX', 'NOT_RECORDED']).optional(),
  preferredLanguage: z.string().trim().min(2).max(20).optional(),
  preferredContactChannel: z.enum(['PHONE', 'SMS', 'WHATSAPP', 'APP']).optional(),
});


const patientContactProfileSchema = z.object({
  phone: z.string().trim().min(7).max(25).optional(),
  whatsapp: z.string().trim().max(25).optional(),
  preferredLanguage: z.string().trim().min(2).max(20).optional(),
  preferredContactChannel: z
    .enum(['PHONE', 'SMS', 'WHATSAPP', 'APP'])
    .optional(),
}).refine(
  (value) =>
    Object.values(value).some((entry) => entry !== undefined),
  {
    message: 'Provide at least one contact field to update.',
  },
).refine(
  (value) =>
    value.preferredContactChannel !== 'WHATSAPP' ||
    Boolean(value.whatsapp?.trim()),
  {
    message:
      'A WhatsApp number is required when WhatsApp is the preferred contact channel.',
    path: ['whatsapp'],
  },
);

const medicationDraftItemSchema = z.object({
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

const prescriptionDocumentSchema = z.object({
  source: z.enum(['IMAGE', 'PAPER_IMAGE', 'EMR_DOCUMENT']).default('IMAGE'),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  imageBase64: z.string().min(1).max(8_000_000),
});

const medicationSubmitSchema = z.object({
  medications: z.array(medicationDraftItemSchema).min(1, 'Add at least one medication candidate before submission.').max(50),
});


const medicationFinalizeSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});

const clinicalReviewDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'ESCALATE_TO_APEXCARE']),
  reason: z.string().trim().min(1).max(1000).optional(),
});

const apexCareClinicalReviewDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().min(1).max(1000).optional(),
  protocolSafe: z.literal(true),
});

const coordinatorCallSchema = z.object({
  status: z.enum(['CONTACTED', 'NO_ANSWER', 'ESCALATED']),
});

const medicationDraftCreateSchema = z.object({
  extractionSource: z.enum(['OCR', 'MANUAL_TRANSCRIPTION']),
  rawText: z.string().trim().max(20000).optional(),
  medications: z.array(medicationDraftItemSchema).max(50).default([]),
});

const medicationDraftReviewSchema = z.object({
  status: z.enum(['VERIFIED', 'REJECTED']),
  rejectionReason: z.string().trim().max(1000).optional(),
});

const dietitianAssessmentSchema = z.object({
  remarks: z.string().trim().min(1).max(5000),
  assessmentData: z.record(z.unknown()).optional(),
});

const diagnosisRecordSchema = z.object({
  condition: z.enum(['HYPERTENSION', 'TYPE_2_DIABETES', 'DYSLIPIDEMIA', 'PCOS']),
  diagnosedAt: z.coerce.date().optional(),
  notes: z.string().trim().max(2000).optional(),
});

const staffCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email(),
  role: z.enum(['CLINICIAN', 'CLINIC_COORDINATOR']),
  temporaryPassword: z.string().min(12).max(128),
});

const staffStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) });

const vitalRecordSchema = z.object({
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
}).refine(
  (value) =>
    value.bloodPressure
      ? value.bloodPressure.systolic >
        value.bloodPressure.diastolic
      : true,
  {
    message:
      'Systolic blood pressure must be greater than diastolic blood pressure.',
    path: ['bloodPressure'],
  },
);

const opdVisitSchema = z.object({
  visitAt: z.coerce.date().default(() => new Date()),
  clinicianId: objectIdSchema,
  reason: z.string().trim().max(500).optional(),
  assessment: z.string().trim().max(5000).optional(),
  planAdjustment: z.string().trim().max(5000).optional(),
  carePlanId: objectIdSchema.optional(),
  vitalsRecordId: objectIdSchema.optional(),
  vitals: vitalRecordSchema.optional(),
}).refine(
  (value) => !(value.vitalsRecordId && value.vitals),
  {
    message: 'Pass either an existing vitalsRecordId or new vitals, not both.',
  });


const carePlanAdjustmentSchema = z.object({
  goals: z.array(z.object({
    title: z.string().trim().min(1).max(180),
    target: z.string().trim().max(120).optional(),
    unit: z.string().trim().max(32).optional(),
  })).max(10).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional(),
});

const taskCompleteSchema = z.object({
  status: z.enum(['COMPLETED', 'SKIPPED']).default('COMPLETED'),
});

const serviceCaseSchema = z.object({
  service: z.enum(['DIETITIAN', 'ENDOCRINOLOGY']),
  reason: z.string().trim().max(1000).refine((value) => value.length > 0, { message: 'Reason is required.' }),
});

const serviceCaseQuerySchema = z.object({
  status: z.enum(['REQUESTED', 'ASSIGNED', 'SCHEDULED', 'COMPLETED', 'CANCELLED']).optional(),
  service: z.enum(['DIETITIAN', 'ENDOCRINOLOGY']).optional(),
});

const deactivatePatientSchema = z.object({ status: z.literal('INACTIVE') });
const carePlanSchema = z.object({
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

function parseOrReply<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | undefined {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed.', details: parsed.error.flatten() } });
    return undefined;
  }
  return parsed.data;
}

function authContext(req: Request) {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth) throw new Error('Authentication context missing after authentication middleware.');
  return auth;
}

async function findApexCareOrganization() {
  return Organization.findOne({ type: 'APEXCARE', status: 'ACTIVE' }).select('_id name type').lean();
}

function routeParam(value: string | string[], name: string): string {
  if (Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid route parameter: ${name}`);
  }
  return value;
}

async function findAccessiblePatient(patientId: string, organizationId: string, roles: Role[], userId: string) {
  const filter: Record<string, unknown> = { _id: patientId, organizationId, status: 'ACTIVE' };
  if (roles.includes('CLINICIAN') && !roles.includes('CLINIC_ADMIN') && !roles.includes('CLINIC_COORDINATOR')) filter.assignedClinicianId = userId;
  return Patient.findOne(filter).lean();
}

export const publicRouter = Router();
export const protectedRouter = Router();

// Safe diagnostic endpoint: exposes configuration state only, never OCR URLs or secrets.
protectedRouter.get('/prescription-ocr/status', requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR', 'CLINICIAN'), async (_req: Request, res: Response) => {
  res.json({ data: getPrescriptionOcrRuntimeStatus() });
});

for (const parameter of ['userId', 'patientId', 'carePlanId', 'taskId', 'caseId', 'draftId', 'enrollmentId', 'documentId', 'milestoneId', 'reviewId']) {
  protectedRouter.param(parameter, (req, res, next, value) => {
    if (!objectIdSchema.safeParse(value).success) {
      res.status(400).json({ error: { code: 'INVALID_ID', message: `Invalid ${parameter}.` } });
      return;
    }
    next();
  });
}

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
      dateOfBirth: input.dateOfBirth,
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
        aggregateId: referral._id,
        payload: { patientId: String(patient._id), patientName: `${patient.name.first} ${patient.name.last ?? ''}`.trim(), referralId: String(referral._id), clinicianId: auth.userId },
      });
    }
    res.status(201).json({ data: patient, referral });
  } catch (error) {
    if (isDuplicateKey(error)) { res.status(409).json({ error: { code: 'MRN_EXISTS', message: 'This medical-record number is already used in the clinic.' } }); return; }
    next(error);
  }
});

protectedRouter.post(
  '/patients/:patientId/diagnoses',
  requireRoles('CLINICIAN'),
  async (req: Request, res, next) => {
    try {
      const auth = authContext(req);
      const patientId = routeParam(req.params.patientId, 'patientId');

      const input = parseOrReply(
        diagnosisRecordSchema,
        req.body,
        res,
      );

      if (!input) return;

      // Fetch all fields needed by the handler.
      const patient = await Patient.findOne({
        _id: patientId,
        organizationId: auth.organizationId,
        status: 'ACTIVE',
      })
        .select(
          'name assignedClinicianId enrollmentStatus conditions',
        )
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

      // Only the assigned clinician may add a diagnosis.
      if (String(patient.assignedClinicianId) !== auth.userId) {
        res.status(403).json({
          error: {
            code: 'PATIENT_NOT_ASSIGNED',
            message:
              'Only the assigned clinician can record this diagnosis.',
          },
        });
        return;
      }

      // Post-enrollment changes must follow the clinical workflow.
      if (patient.enrollmentStatus !== 'NOT_ENROLLED') {
        res.status(409).json({
          error: {
            code: 'PATIENT_ALREADY_ENROLLED',
            message:
              'Diagnosis changes after ApexCare enrolment require the clinical workflow.',
          },
        });
        return;
      }

      const diagnosedAt = input.diagnosedAt ?? new Date();

      // Preserve other diagnoses and replace only the same condition.
      const existingConditions = patient.conditions ?? [];

      const updatedConditions = [
        ...existingConditions.filter(
          (condition) => condition.code !== input.condition,
        ),
        {
          code: input.condition,
          status: 'CONFIRMED' as const,
          diagnosedAt,
        },
      ];

      // Save the diagnosis history.
      const diagnosis = await Diagnosis.create({
        organizationId: auth.organizationId,
        patientId: patient._id,
        condition: input.condition,
        status: 'CONFIRMED',
        diagnosedAt,
        diagnosedByUserId: auth.userId,
        source: 'CLINICIAN',
        notes: input.notes,
      });

      // Update the patient's current condition summary.
      await Patient.updateOne(
        {
          _id: patient._id,
          organizationId: auth.organizationId,
        },
        {
          $set: {
            conditions: updatedConditions,
          },
        },
      );

      // Find the ApexCare organization.
      const apexcareOrganization =
        await findApexCareOrganization();

      let referral = null;
      let referralCreated = false;

      if (apexcareOrganization) {
        const referralFilter = {
          patientId: patient._id,
          clinicOrganizationId: auth.organizationId,
          apexcareOrganizationId: apexcareOrganization._id,
          status: 'PENDING_STAFF' as const,
        };

        // Reuse an existing pending referral on a retry.
        referral = await ApexCareReferral.findOne(referralFilter);

        if (!referral) {
          const referredAt = new Date();

          const staffEscalationDueAt = new Date(
            referredAt.getTime() + 12 * 60 * 60 * 1000,
          );

          try {
            referral = await ApexCareReferral.create({
              patientId: patient._id,
              clinicOrganizationId: auth.organizationId,
              apexcareOrganizationId: apexcareOrganization._id,
              referredByUserId: auth.userId,
              condition: input.condition,
              status: 'PENDING_STAFF',
              referredAt,
              staffEscalationDueAt,
            });

            referralCreated = true;
          } catch (error) {
            // A concurrent request may have created the referral.
            if (!isDuplicateKey(error)) {
              throw error;
            }

            referral =
              await ApexCareReferral.findOne(referralFilter);

            if (!referral) {
              throw error;
            }
          }
        }

        // Schedule and publish only for a newly created referral.
        if (referralCreated && referral) {
          try {
            await scheduleApexCareReferralEscalation(
              String(referral._id),
              referral.staffEscalationDueAt,
            );
          } catch (error) {
            console.error(
              'ApexCare referral SLA could not be scheduled.',
              error,
            );
          }

          await enqueueOutboxEvent({
            organizationId: auth.organizationId,
            eventKey: `patient-referral-created:${referral._id}`,
            eventType: 'PATIENT_REFERRAL_CREATED',
            aggregateType: 'ApexCareReferral',
            aggregateId: String(referral._id),
            payload: {
              patientId: String(patient._id),
              patientName: [
                patient.name?.first ?? '',
                patient.name?.last ?? '',
              ]
                .join(' ')
                .trim(),
              referralId: String(referral._id),
              clinicianId: auth.userId,
            },
          });
        }
      }

      res.status(201).json({
        data: diagnosis,
        referral,
      });
    } catch (error) {
      next(error);
    }
  },
);

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


protectedRouter.patch(
  '/patients/:patientId/contact-profile',
  requireRoles('CLINIC_ADMIN', 'CLINIC_COORDINATOR'),
  async (req: Request, res, next) => {
    try {
      const auth = authContext(req);

      const input = parseOrReply(
        patientContactProfileSchema,
        req.body,
        res,
      );

      if (!input) return;

      const patient = await Patient.findOneAndUpdate(
        {
          _id: routeParam(req.params.patientId, 'patientId'),
          organizationId: auth.organizationId,
          status: 'ACTIVE',
        },
        {
          $set: {
            ...input,
            contactProfileLastUpdatedAt: new Date(),
            contactProfileLastUpdatedByUserId: auth.userId,
          },
        },
        {
          new: true,
          runValidators: true,
        },
      ).lean();

      if (!patient) {
        res.status(404).json({
          error: {
            code: 'PATIENT_NOT_FOUND',
            message: 'Patient not found.',
          },
        });
        return;
      }

      res.json({ data: patient });
    } catch (error) {
      next(error);
    }
  },
);

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
    const document = await PrescriptionDocument.create({ patientId, clinicOrganizationId: auth.organizationId, apexcareOrganizationId: apexcareOrganization._id, source: 'IMAGE', status: 'ANALYZING', fileName: input.fileName, originalFileName: input.fileName, mimeType: input.mimeType, storageKey: stored.storageKey, sizeBytes: stored.sizeBytes, sha256: stored.sha256, analysisStatus: 'PENDING', capturedByUserId: auth.userId });
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
        aggregateId: document._id,
        payload: { patientId, patientName: `${assignedPatient.name.first} ${assignedPatient.name.last ?? ''}`.trim(), prescriptionDocumentId: String(document._id), clinicianId: String(assignedPatient.assignedClinicianId) },
      });
    }
    res.status(202).json({ data: { prescriptionDocument: document, medicationDraft: draft, analysisStatus: 'PENDING', jobId } });
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
    const document = await PrescriptionDocument.findOne({ _id: documentId, patientId, clinicOrganizationId: auth.organizationId }).select('storageKey mimeType fileName').lean();
    if (!document) { res.status(404).json({ error: { code: 'PRESCRIPTION_DOCUMENT_NOT_FOUND', message: 'Prescription document not found.' } }); return; }
    const image = await readPrescriptionImage(document.storageKey);
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
    const documents = await PrescriptionDocument.find({ clinicOrganizationId: auth.organizationId, patientId: patient._id }).sort({ createdAt: -1 }).limit(20).lean();
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
    const patient = await Patient.findOne({ _id: patientId, organizationId: auth.organizationId, status: 'ACTIVE', enrollmentStatus: 'NOT_ENROLLED' }).select('phone whatsapp assignedClinicianId').lean();
    if (!patient) { res.status(409).json({ error: { code: 'PATIENT_ALREADY_ENROLLED', message: 'Patient is already enrolled or no longer active.' } }); return; }
    if (!patient.phone) { res.status(422).json({ error: { code: 'PATIENT_PHONE_REQUIRED', message: 'Staff must capture a patient phone number before ApexCare enrolment.' } }); return; }
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
        referral.enrolledByUserId = auth.userId;
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
    const clinician = patient.assignedClinicianId
  ? await User.findOne({
      _id: patient.assignedClinicianId,
      organizationId: auth.organizationId,
      roles: 'CLINICIAN',
      status: 'ACTIVE',
    })
      .select('name')
      .lean()
  : null;
    res.json({ data: {
      ...patient,   
     assignedClinicianName: clinician?.name ?? null,
     }});
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

  let vitalsRecordId: string | undefined;
const patientId = routeParam(req.params.patientId, 'patientId');

if (input.vitalsRecordId) {
  const linkedVital = await VitalRecord.findOne({
    _id: input.vitalsRecordId,
    patientId,
    organizationId: auth.organizationId,
  })
    .select('_id')
    .lean();

  if (!linkedVital) {
    res.status(422).json({
      error: {
        code: 'INVALID_VITAL_RECORD',
        message:
          'The selected vitals record does not belong to this patient and clinic.',
      },
    });
    return;
  }

  vitalsRecordId = String(linkedVital._id);
}

if (input.vitals) {
  const vital = await VitalRecord.create({
    ...input.vitals,
    organizationId: auth.organizationId,
    patientId,
    recordedByUserId: auth.userId,
  });

  vitalsRecordId = String(vital._id);
}

const visit = await OpdVisit.create({
  organizationId: auth.organizationId,
  patientId,
  visitAt: input.visitAt,
  recordedByUserId: auth.userId,
  clinicianId: input.clinicianId,
  reason: input.reason,
  assessment: input.assessment,
  planAdjustment: input.planAdjustment,
  carePlanId: input.carePlanId,
  vitalsRecordId,
});
   
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

      res.status(result.idempotent ? 200 : 201).json({ data: result });
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
  '/patients/:patientId/lab-documents',
  requireRoles('CLINICIAN'),
  async (req: Request, res, next) => {
    try {
      const auth = authContext(req);
      const patientId = routeParam(req.params.patientId, 'patientId');
      const patient = await findAccessiblePatient(patientId, auth.organizationId, auth.roles, auth.userId);
      if (!patient) { res.status(404).json({ error: { code: 'PATIENT_NOT_FOUND', message: 'Patient not found.' } }); return; }
      const documents = await LabDocument.find({ clinicOrganizationId: auth.organizationId, patientId })
        .sort({ createdAt: -1 }).limit(100).lean();
      res.json({ data: documents });
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
      const results = await LabResult.find({ organizationId: auth.organizationId, patientId, labDocumentId: documentId }).sort({ normalizedTestName: 1, createdAt: 1 }).lean();
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
          contactStatus: input.data.outcome,
          lastContactedAt: now,
          lastContactedByUserId: auth.userId,
          contactNotes: input.data.notes,
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
    // The frontend request helper unwraps `data`; keep queued/idempotent metadata inside it.
    res.status(202).json({ data: { communication: communication.communication, queued: true, idempotent: communication.idempotent } });
  } catch (error) { next(error); }
});

function careTaskPriority(task: { status?: string; dueAt?: Date | string }, now: Date): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (task.status === 'OVERDUE' || task.status === 'SKIPPED') return 'HIGH';
  const dueAt = task.dueAt ? new Date(task.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const hoursUntilDue = (dueAt - now.getTime()) / (60 * 60 * 1000);
  if (hoursUntilDue <= 24) return 'HIGH';
  if (hoursUntilDue <= 72) return 'MEDIUM';
  return 'LOW';
}

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
      { $set: { contactStatus: input.data.outcome, lastContactedAt: new Date(), lastContactedByUserId: auth.userId, contactNotes: input.data.notes } },
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
    const enrollments = await ApexCareEnrollment.find({ apexcareOrganizationId: auth.organizationId, status: 'ACTIVE', coordinatorCallStatus: { $in: ['PENDING', 'ESCALATED', 'NO_ANSWER'] } })
      .sort({ coordinatorCallDueAt: 1 }).limit(200).lean();
    const patients = enrollments.length
      ? await Patient.find({ _id: { $in: enrollments.map((item) => item.patientId) }, status: 'ACTIVE' })
          .select('_id organizationId name phone whatsapp dateOfBirth sexAtBirth preferredLanguage conditions')
          .lean()
      : [];
    const patientById = new Map(patients.map((patient) => [String(patient._id), patient]));
    const data = enrollments.flatMap((enrollment) => {
      const patient = patientById.get(String(enrollment.patientId));
      // Enforce the clinic boundary again while joining patient data to the ApexCare enrollment.
      if (!patient || String(patient.organizationId) !== String(enrollment.clinicOrganizationId)) return [];
      return [{
        ...enrollment,
        patient: {
          _id: String(patient._id),
          name: patient.name,
          phone: patient.phone ?? null,
          whatsapp: patient.whatsapp ?? null,
          dateOfBirth: patient.dateOfBirth?.toISOString() ?? null,
          sexAtBirth: patient.sexAtBirth ?? null,
          preferredLanguage: patient.preferredLanguage ?? 'en',
          conditions: patient.conditions,
        },
      }];
    });
    res.json({ data });
  } catch (error) { next(error); }
});

// The coordinator handoff is represented by coordinatorCallStatus=CONTACTED.
// This queue is the next stage of the same ApexCareEnrollment workflow—not the
// separate generic ServiceCase workflow used for ad-hoc specialist requests.
protectedRouter.get('/apexcare/dietitian-queue', requireOrganizationType('APEXCARE'), requireRoles('APEXCARE_DIETITIAN'), async (req: Request, res, next) => {
  try {
    const auth = authContext(req);
    const enrollments = await ApexCareEnrollment.find({
      apexcareOrganizationId: auth.organizationId,
      status: 'ACTIVE',
      coordinatorCallStatus: 'CONTACTED',
    }).sort({ updatedAt: -1, createdAt: -1 }).limit(200).lean();
    const patientIds = enrollments.map((item) => item.patientId);
    const patients = patientIds.length
      ? await Patient.find({ _id: { $in: patientIds }, status: 'ACTIVE' })
          .select('_id organizationId name phone whatsapp dateOfBirth sexAtBirth preferredLanguage conditions')
          .lean()
      : [];
    const patientById = new Map(patients.map((patient) => [String(patient._id), patient]));
    const assessments = enrollments.length
      ? await DietitianAssessment.find({
          apexcareOrganizationId: auth.organizationId,
          apexCareEnrollmentId: { $in: enrollments.map((item) => item._id) },
        }).select('apexCareEnrollmentId remarks assessmentData completedAt dietitianUserId').sort({ completedAt: -1 }).lean()
      : [];
    const assessmentByEnrollmentId = new Map<string, (typeof assessments)[number]>();
    for (const assessment of assessments) {
      const key = String(assessment.apexCareEnrollmentId ?? '');
      if (key && !assessmentByEnrollmentId.has(key)) assessmentByEnrollmentId.set(key, assessment);
    }
    const data = enrollments.flatMap((enrollment) => {
      const patient = patientById.get(String(enrollment.patientId));
      // Do not return an enrollment if the patient no longer belongs to its clinic tenant.
      if (!patient || String(patient.organizationId) !== String(enrollment.clinicOrganizationId)) return [];
      const assessment = assessmentByEnrollmentId.get(String(enrollment._id));
      return [{
        ...enrollment,
        patient: {
          _id: String(patient._id),
          name: patient.name,
          phone: patient.phone ?? null,
          whatsapp: patient.whatsapp ?? null,
          dateOfBirth: patient.dateOfBirth?.toISOString() ?? null,
          sexAtBirth: patient.sexAtBirth ?? null,
          preferredLanguage: patient.preferredLanguage ?? 'en',
          conditions: patient.conditions,
        },
        assessment: assessment ? {
          remarks: assessment.remarks,
          assessmentData: assessment.assessmentData ?? {},
          completedAt: assessment.completedAt?.toISOString() ?? null,
          dietitianUserId: String(assessment.dietitianUserId),
        } : null,
      }];
    });
    res.json({ data });
  } catch (error) { next(error); }
});

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
      if ('error' in result) { res.status(409).json({ error: { code: result.error, message: result.error === 'MEDICATION_DRAFT_EMPTY' ? 'Add and verify at least one medication candidate before approving this prescription.' : 'The medication review context is no longer available.' } }); return; }
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
      if ('error' in result) { res.status(409).json({ error: { code: result.error, message: result.error === 'MEDICATION_DRAFT_EMPTY' ? 'Add and verify at least one medication candidate before approving this prescription.' : 'The medication review context is no longer available.' } }); return; }
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
    const document = await PrescriptionDocument.findOne({ _id: documentId, patientId, apexcareOrganizationId: auth.organizationId }).select('storageKey mimeType fileName').lean();
    if (!document) { res.status(404).json({ error: { code: 'PRESCRIPTION_DOCUMENT_NOT_FOUND', message: 'Prescription document not found.' } }); return; }
    const image = await readPrescriptionImage(document.storageKey);
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Disposition', `inline; filename=\"${document.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}\"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(image);
  } catch (error) { next(error); }
});

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
      const currentEnrollment = await ApexCareEnrollment.findOne({ _id: enrollment._id, apexcareOrganizationId: auth.organizationId, patientId, clinicOrganizationId: enrollment.clinicOrganizationId }).lean();
      if (!currentEnrollment) {
        res.status(404).json({ error: { code: 'APEXCARE_ENROLLMENT_NOT_FOUND', message: 'Active ApexCare enrollment not found.' } }); return;
      }
      if (currentEnrollment.carePlanGenerationStatus === 'COMPLETED' && currentEnrollment.carePlanDraftId) {
        res.status(200).json({ data: { assessment: existingAssessment, carePlanGenerationStatus: 'COMPLETED', jobId: currentEnrollment.carePlanGenerationJobId ?? null, carePlanDraftId: String(currentEnrollment.carePlanDraftId) } });
        return;
      }
      if (currentEnrollment.carePlanGenerationStatus === 'QUEUED' || currentEnrollment.carePlanGenerationStatus === 'PROCESSING') {
        res.status(202).json({ data: { assessment: existingAssessment, carePlanGenerationStatus: currentEnrollment.carePlanGenerationStatus, jobId: currentEnrollment.carePlanGenerationJobId ?? null } });
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
          assessmentId: String(existingAssessment._id),
          attempt: retryAttempt,
        });
        await ApexCareEnrollment.updateOne({ _id: enrollment._id, carePlanGenerationStatus: 'QUEUED', carePlanGenerationAttempt: retryAttempt }, { $set: { carePlanGenerationJobId: jobId } });
        res.status(202).json({ data: { assessment: existingAssessment, carePlanGenerationStatus: 'QUEUED', jobId } });
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
    const attempt = 1;
    const queuedEnrollment = await ApexCareEnrollment.findOneAndUpdate(
      { _id: enrollment._id, apexcareOrganizationId: auth.organizationId, status: 'ACTIVE', coordinatorCallStatus: 'CONTACTED', carePlanGenerationStatus: 'NOT_STARTED', carePlanGenerationAssessmentId: { $in: [null] } },
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

function isDuplicateKey(error: unknown): error is { code: number } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: number }).code === 11000;
}

async function reservePatientSlot(organizationId: string) {
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
