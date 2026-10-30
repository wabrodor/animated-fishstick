import { attachCarePlanTasksToExecution, ensureCarePlanExecution } from './care-plan-execution.js';
import { ApexCareEnrollment, CarePlan, CarePlanDraft, Patient, VitalRecord, CareTask, OpdVisit, Diagnosis, DietitianAssessment, ProgramConsent } from './models.js';
import { env } from './config.js';

const PLAN_DAYS = 90;

export type HypertensionCarePlanDraft = {
  summary: string;
  goals: Array<{ title: string; target?: string; unit?: string; rationale?: string }>;
  tasks: Array<{ type: 'OPD_VISIT' | 'VITALS' | 'LAB' | 'MEDICATION' | 'DIETITIAN_SESSION' | 'FOLLOW_UP'; title: string; dueDay: number; rationale?: string }>;
  clinicalInterventionNeeded: boolean;
  confidence: number;
  safetyNotes: string[];
};

type PatientSnapshot = {
  dietitianRemarks: string | null;
  ageYears: number | null;
  sexAtBirth: string | null;
  hypertensionStatus: string;
  diagnosedAt: string | null;
  latestBloodPressure: { systolic: number; diastolic: number; recordedAt: string } | null;
  recentBloodPressures: Array<{ systolic: number; diastolic: number; recordedAt: string }>;
  latestWeightKg: number | null;
  weightChangeKg: number | null;
  recentTaskCompletionRate: number;
  overdueTaskCount: number;
  recentOpdVisits: number;
  dataCompleteness: { score: number; missing: string[]; known: string[] };
};

export async function generateHypertensionCarePlanDraft(
  apexcareOrganizationId: string,
  clinicOrganizationId: string,
  patientId: string,
  generatedByUserId: string,
  enrollmentId: string,
  assessmentId: string,
) {
  const patient = await Patient.findOne({ _id: patientId, organizationId: clinicOrganizationId, status: 'ACTIVE' }).lean();
  if (!patient) return null;
  if (!['ENROLLED', 'CARE_PLAN_REVIEW'].includes(patient.enrollmentStatus ?? 'NOT_ENROLLED')) return { error: 'PATIENT_NOT_ENROLLED' as const };

  const enrollment = await ApexCareEnrollment.findOne({
    _id: enrollmentId,
    patientId,
    clinicOrganizationId,
    apexcareOrganizationId,
    status: 'ACTIVE',
    coordinatorCallStatus: 'CONTACTED',
    dietitianAssessmentStatus: 'COMPLETED',
  }).lean();
  if (!enrollment) return { error: 'CARE_PLAN_GENERATION_CONTEXT_INVALID' as const };

  const [diagnosis, consent, vitals, tasks, visits, dietitianAssessment] = await Promise.all([
    Diagnosis.findOne({ organizationId: clinicOrganizationId, patientId, condition: 'HYPERTENSION', status: 'CONFIRMED' }).sort({ diagnosedAt: -1 }).lean(),
    ProgramConsent.findOne({ organizationId: clinicOrganizationId, patientId, program: 'APEXCARE_CHRONIC_CARE', consentGiven: true }).sort({ consentAt: -1 }).lean(),
    VitalRecord.find({ organizationId: clinicOrganizationId, patientId }).sort({ recordedAt: -1 }).limit(10).lean(),
    CareTask.find({ organizationId: clinicOrganizationId, patientId }).lean(),
    OpdVisit.find({ organizationId: clinicOrganizationId, patientId }).sort({ visitAt: -1 }).limit(5).lean(),
    DietitianAssessment.findOne({ _id: assessmentId, apexCareEnrollmentId: enrollment._id, patientId, clinicOrganizationId, apexcareOrganizationId }).lean(),
  ]);
  if (!diagnosis) return { error: 'CONFIRMED_DIAGNOSIS_REQUIRED' as const };
  if (!consent) return { error: 'PROGRAM_CONSENT_REQUIRED' as const };
  if (!dietitianAssessment) return { error: 'DIETITIAN_ASSESSMENT_REQUIRED' as const };

  const bp = vitals.filter((v) => v.bloodPressure).map((v) => ({
    systolic: v.bloodPressure!.systolic,
    diastolic: v.bloodPressure!.diastolic,
    recordedAt: v.recordedAt.toISOString(),
  }));
  const weights = vitals.filter((v) => typeof v.weightKg === 'number').map((v) => v.weightKg as number);
  const latestWeightKg = weights[0] ?? null;
  const weightChangeKg = weights.length > 1 ? Number((weights[0] - weights[weights.length - 1]).toFixed(1)) : null;
  const completed = tasks.filter((task) => task.status === 'COMPLETED').length;
  const overdue = tasks.filter((task) => task.status === 'OVERDUE' || (task.status === 'PENDING' && task.dueAt < new Date())).length;
  const completionRate = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  const ageYears = patient.dateOfBirth ? Math.max(0, Math.floor((Date.now() - patient.dateOfBirth.getTime()) / (365.25 * 24 * 60 * 60 * 1000))) : null;

  const known: string[] = ['diagnosis'];
  const missing: string[] = [];
  if (patient.dateOfBirth) known.push('age'); else missing.push('age');
  if (patient.sexAtBirth && patient.sexAtBirth !== 'NOT_RECORDED') known.push('sex'); else missing.push('sex');
  if (bp.length) known.push('bloodPressure'); else missing.push('bloodPressureTrend');
  if (latestWeightKg !== null) known.push('weight'); else missing.push('weight');
  if (visits.length) known.push('opdHistory'); else missing.push('opdHistory');
  missing.push('medicationAdherence', 'laboratoryResults', 'lifestyleHistory');
  const completenessScore = Math.round((known.length / (known.length + missing.length)) * 100);

  const snapshot: PatientSnapshot = {
    dietitianRemarks: dietitianAssessment.remarks,
    ageYears,
    sexAtBirth: patient.sexAtBirth ?? null,
    hypertensionStatus: patient.conditions.find((condition) => condition.code === 'HYPERTENSION')?.status ?? 'UNKNOWN',
    diagnosedAt: patient.conditions.find((condition) => condition.code === 'HYPERTENSION')?.diagnosedAt?.toISOString() ?? null,
    latestBloodPressure: bp[0] ?? null,
    recentBloodPressures: bp.slice(0, 5),
    latestWeightKg,
    weightChangeKg,
    recentTaskCompletionRate: completionRate,
    overdueTaskCount: overdue,
    recentOpdVisits: visits.length,
    dataCompleteness: { score: completenessScore, known, missing },
  };

  const generated = env.AI_ENABLED && env.AI_PROVIDER === 'openai-compatible'
    ? await generateWithProvider(snapshot)
    : generateSafeRulesDraft(snapshot);

  const existingDraft = await CarePlanDraft.findOne({
    organizationId: clinicOrganizationId,
    patientId,
    condition: 'HYPERTENSION',
    status: 'CLINICIAN_REVIEW',
  }).lean();
  if (existingDraft) return existingDraft;

  try {
    return await CarePlanDraft.create({
      organizationId: clinicOrganizationId,
      patientId,
      condition: 'HYPERTENSION',
      generatedByUserId,
      status: 'CLINICIAN_REVIEW',
      source: generated.source,
      provider: generated.provider,
      model: generated.model,
      inputSnapshot: snapshot,
      clinicianReviewDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      fallbackEligibleAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      plan: generated.plan,
    });
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) {
      const duplicate = await CarePlanDraft.findOne({
        organizationId: clinicOrganizationId,
        patientId,
        condition: 'HYPERTENSION',
        status: 'CLINICIAN_REVIEW',
      }).lean();
      if (duplicate) return duplicate;
    }
    throw error;
  }
}

async function generateWithProvider(snapshot: PatientSnapshot): Promise<{ source: 'AI'; provider: string; model?: string; plan: HypertensionCarePlanDraft }> {
  if (!env.AI_API_KEY || !env.AI_BASE_URL || !env.AI_MODEL) return { source: 'AI', provider: 'openai-compatible', model: env.AI_MODEL, plan: generateSafeRulesDraft(snapshot).plan };

  const system = [
    'You generate a draft, non-prescriptive hypertension care plan for clinician review.',
    'Use only the supplied structured facts. Do not diagnose, prescribe, recommend medication changes, or invent laboratory values.',
    'Do not create medication tasks that imply a medication or dose. Use VITALS, LAB, OPD_VISIT, FOLLOW_UP, or DIETITIAN_SESSION tasks only when justified.',
    'Goals must be measurable where possible. Tasks use dueDay: day 0 means the plan start date; day 90 is allowed.',
    'Treat missing information as unknown. Never infer missing facts. Use dataCompleteness to keep the plan conservative. If data is sparse or concerning, set clinicalInterventionNeeded=true and explain why in safetyNotes.',
    'Return JSON only matching the requested schema.',
  ].join(' ');
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      summary: { type: 'string', maxLength: 2000 },
      goals: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', maxLength: 180 }, target: { type: 'string', maxLength: 120 }, unit: { type: 'string', maxLength: 32 }, rationale: { type: 'string', maxLength: 500 } }, required: ['title'] } },
      tasks: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['OPD_VISIT', 'VITALS', 'LAB', 'FOLLOW_UP', 'DIETITIAN_SESSION'] }, title: { type: 'string', maxLength: 180 }, dueDay: { type: 'integer', minimum: 0, maximum: 90 }, rationale: { type: 'string', maxLength: 500 } }, required: ['type', 'title', 'dueDay'] } },
      clinicalInterventionNeeded: { type: 'boolean' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      safetyNotes: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 500 } },
    }, required: ['summary', 'goals', 'tasks', 'clinicalInterventionNeeded', 'confidence', 'safetyNotes'],
  };

  const response = await fetch(`${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify({
      model: env.AI_MODEL,
      temperature: 0.1,
      response_format: { type: 'json_schema', json_schema: { name: 'hypertension_care_plan', strict: true, schema } },
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(snapshot) }],
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) return { source: 'AI', provider: 'openai-compatible', model: env.AI_MODEL, plan: generateSafeRulesDraft(snapshot).plan };
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  try {
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '');
    return { source: 'AI', provider: 'openai-compatible', model: env.AI_MODEL, plan: normalizeDraft(parsed) };
  } catch {
    return { source: 'AI', provider: 'openai-compatible', model: env.AI_MODEL, plan: generateSafeRulesDraft(snapshot).plan };
  }
}

function normalizeDraft(value: unknown): HypertensionCarePlanDraft {
  const draft = value as Partial<HypertensionCarePlanDraft>;
  const allowedTypes = new Set(['OPD_VISIT', 'VITALS', 'LAB', 'FOLLOW_UP', 'DIETITIAN_SESSION']);
  const goals = Array.isArray(draft.goals) ? draft.goals.slice(0, 10).map((goal) => ({
    title: String(goal?.title ?? '').trim().slice(0, 180),
    target: goal?.target ? String(goal.target).slice(0, 120) : undefined,
    unit: goal?.unit ? String(goal.unit).slice(0, 32) : undefined,
    rationale: goal?.rationale ? String(goal.rationale).slice(0, 500) : undefined,
  })).filter((goal) => goal.title) : [];
  const tasks = Array.isArray(draft.tasks) ? draft.tasks.slice(0, 20).map((task) => ({
    type: allowedTypes.has(String(task?.type)) ? String(task.type) as HypertensionCarePlanDraft['tasks'][number]['type'] : 'FOLLOW_UP',
    title: String(task?.title ?? '').trim().slice(0, 180),
    dueDay: Math.max(0, Math.min(90, Math.round(Number(task?.dueDay ?? 30)))),
    rationale: task?.rationale ? String(task.rationale).slice(0, 500) : undefined,
  })).filter((task) => task.title) : [];
  return {
    summary: String(draft.summary ?? 'Draft hypertension care plan generated for clinician review.').slice(0, 2000),
    goals,
    tasks,
    clinicalInterventionNeeded: Boolean(draft.clinicalInterventionNeeded),
    confidence: Math.max(0, Math.min(1, Number(draft.confidence ?? 0.5))),
    safetyNotes: Array.isArray(draft.safetyNotes) ? draft.safetyNotes.slice(0, 10).map((note) => String(note).slice(0, 500)) : [],
  };
}

function generateSafeRulesDraft(snapshot: PatientSnapshot): { source: 'RULES'; provider: undefined; model: undefined; plan: HypertensionCarePlanDraft } {
  const elevated = Boolean(snapshot.latestBloodPressure && (snapshot.latestBloodPressure.systolic >= 140 || snapshot.latestBloodPressure.diastolic >= 90));
  const intervention = elevated || snapshot.overdueTaskCount > 0 || snapshot.recentBloodPressures.length === 0;
  return {
    source: 'RULES', provider: undefined, model: undefined,
    plan: {
      summary: 'Baseline hypertension care-plan draft generated from available structured data. Clinician review and approval are required.',
      goals: [
        { title: 'Monitor blood pressure', target: 'Record BP according to the clinician-approved schedule', rationale: 'Trend monitoring supports follow-up decisions.' },
        { title: 'Complete scheduled follow-up', target: 'Attend planned OPD review', rationale: 'Review is needed to assess progress and adjust the plan when clinically appropriate.' },
      ],
      tasks: [
        { type: 'VITALS', title: 'Record blood pressure and weight', dueDay: 0, rationale: 'Establish or update the baseline.' },
        { type: 'FOLLOW_UP', title: 'Coordinator follow-up', dueDay: 14, rationale: 'Check completion of the care plan and identify barriers.' },
        { type: 'OPD_VISIT', title: 'Hypertension OPD review', dueDay: 30, rationale: 'Clinician review of symptoms, vitals, adherence and plan.' },
        { type: 'OPD_VISIT', title: '90-day hypertension review', dueDay: 90, rationale: 'End-of-programme clinical review.' },
      ],
      clinicalInterventionNeeded: intervention,
      confidence: snapshot.recentBloodPressures.length ? 0.65 : 0.4,
      safetyNotes: ['This draft does not prescribe or change medication.', 'Clinician approval is required before activation.'],
    },
  };
}

export async function approveHypertensionCarePlanDraft(organizationId: string, patientId: string, draftId: string, clinicianId: string) {
  const existingActivePlan = await CarePlan.exists({ organizationId, patientId, condition: 'HYPERTENSION', status: 'ACTIVE' });
  if (existingActivePlan) return { error: 'ACTIVE_PLAN_EXISTS' as const };
  const draft = await CarePlanDraft.findOne({ _id: draftId, organizationId, patientId, condition: 'HYPERTENSION', status: { $in: ['GENERATED', 'CLINICIAN_REVIEW'] } });
  if (!draft) return null;

  const draftPlan = draft.plan;
  if (!draftPlan) return { error: 'INVALID_CARE_PLAN_DRAFT' as const };

  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + PLAN_DAYS);
  const plan = await CarePlan.create({
    organizationId,
    patientId,
    condition: 'HYPERTENSION',
    status: 'ACTIVE',
    startDate,
    endDate,
    goals: draftPlan.goals.map((goal) => ({ title: goal.title, target: goal.target, unit: goal.unit })),
    createdByUserId: draft.generatedByUserId,
    approvedByUserId: clinicianId,
    approvedAt: new Date(),
  });

  try {
    const tasks = draftPlan.tasks.map((task) => {
      const dueAt = new Date(startDate);
      dueAt.setUTCDate(dueAt.getUTCDate() + task.dueDay);
      return { type: task.type, title: task.title, dueAt, organizationId, patientId, carePlanId: plan._id };
    });
    const createdTasks = await CareTask.insertMany(tasks);
    await ensureCarePlanExecution({ organizationId, patientId, carePlanId: String(plan._id) });
    await attachCarePlanTasksToExecution({ organizationId, patientId, carePlanId: String(plan._id), tasks: createdTasks });
    draft.status = 'APPROVED';
    draft.approvedByUserId = clinicianId as never;
    draft.approvedAt = new Date();
    await draft.save();
    return plan;
  } catch (error) {
    await CareTask.deleteMany({ _id: { $in: await CareTask.find({ carePlanId: plan._id, organizationId, patientId }).distinct('_id') }, organizationId, patientId, carePlanId: plan._id });
    await CarePlan.deleteOne({ _id: plan._id, organizationId, patientId });
    throw error;
  }
}


export async function approveHypertensionCarePlanDraftAsApexCare(organizationId: string, patientId: string, draftId: string, apexcareDoctorId: string) {
  const enrollment = await ApexCareEnrollment.findOne({ patientId, clinicOrganizationId: organizationId, status: 'ACTIVE' }).lean();
  if (!enrollment) return { error: 'APEXCARE_ENROLLMENT_NOT_FOUND' as const };
  const existingActivePlan = await CarePlan.exists({ organizationId, patientId, condition: 'HYPERTENSION', status: 'ACTIVE' });
  if (existingActivePlan) return { error: 'ACTIVE_PLAN_EXISTS' as const };
  const draft = await CarePlanDraft.findOne({ _id: draftId, organizationId, patientId, condition: 'HYPERTENSION', status: { $in: ['GENERATED', 'CLINICIAN_REVIEW'] } });
  if (!draft) return null;
  if (!draft.fallbackEligibleAt || draft.fallbackEligibleAt.getTime() > Date.now()) return { error: 'CLINICIAN_REVIEW_WINDOW_ACTIVE' as const };
  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + PLAN_DAYS);
  const plan = await CarePlan.create({
    organizationId,
    patientId,
    condition: 'HYPERTENSION',
    status: 'ACTIVE',
    startDate,
    endDate,
    goals: draft.plan.goals.map((goal) => ({ title: goal.title, target: goal.target, unit: goal.unit })),
    createdByUserId: draft.generatedByUserId,
    approvedByUserId: apexcareDoctorId,
    approvedAt: new Date(),
  });
  try {
    const tasks = draft.plan.tasks.map((task) => {
      const dueAt = new Date(startDate);
      dueAt.setUTCDate(dueAt.getUTCDate() + task.dueDay);
      return { type: task.type, title: task.title, dueAt, organizationId, patientId, carePlanId: plan._id };
    });
    const createdTasks = await CareTask.insertMany(tasks);
    await ensureCarePlanExecution({ organizationId, patientId, carePlanId: String(plan._id) });
    await attachCarePlanTasksToExecution({ organizationId, patientId, carePlanId: String(plan._id), tasks: createdTasks });
    draft.status = 'APPROVED';
    draft.approvedByUserId = apexcareDoctorId as never;
    draft.approvedAt = new Date();
    draft.fallbackApprovedByUserId = apexcareDoctorId as never;
    draft.fallbackApprovedAt = new Date();
    await draft.save();
    return plan;
  } catch (error) {
    await CareTask.deleteMany({ _id: { $in: await CareTask.find({ carePlanId: plan._id, organizationId, patientId }).distinct('_id') }, organizationId, patientId, carePlanId: plan._id });
    await CarePlan.deleteOne({ _id: plan._id, organizationId, patientId });
    throw error;
  }
}
