import { CarePlan, CarePlanExecution, CarePlanMilestone, Patient, PatientReview, PatientReviewSummary, VitalRecord } from './models.js';
import { env } from './config.js';

export type PatientReviewSummaryResult = {
  summary: Record<string, unknown>;
  idempotent: boolean;
};

type GeneratedSummary = {
  clinicianSummary: string;
  patientSummary: string;
  suggestedActions: string[];
  clinicianReviewRequired: boolean;
};

function summaryKey(reviewId: string, version = 1) {
  return `patient-review-summary:${reviewId}:v${version}`;
}

async function callReviewSummaryAi(input: Record<string, unknown>): Promise<GeneratedSummary | null> {
  if (!env.AI_ENABLED || env.AI_PROVIDER !== 'openai-compatible' || !env.AI_API_KEY || !env.AI_BASE_URL || !env.AI_MODEL) return null;

  const response = await fetch(`${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify({
      model: env.AI_MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a clinical documentation assistant for chronic-care follow-up. Use only the supplied structured facts. Produce JSON with clinicianSummary, patientSummary, suggestedActions, and clinicianReviewRequired. clinicianSummary is concise clinical documentation for the treating clinician. patientSummary must be understandable to a patient and written in the supplied preferred language. Do not diagnose, prescribe, change medication, invent facts, or claim that a suggested action was ordered. Suggested actions are questions or follow-up considerations for the clinician/staff. The clinician remains the final authority.',
        },
        { role: 'user', content: JSON.stringify(input) },
      ],
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`AI review summary request failed with HTTP ${response.status}.`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('AI review summary response was empty.');
  let parsed: Partial<GeneratedSummary>;
  try {
    parsed = JSON.parse(content) as Partial<GeneratedSummary>;
  } catch {
    throw new Error('AI review summary response was not valid JSON.');
  }
  if (typeof parsed.clinicianSummary !== 'string' || typeof parsed.patientSummary !== 'string' || !Array.isArray(parsed.suggestedActions)) {
    throw new Error('AI review summary response did not contain the required fields.');
  }
  return {
    clinicianSummary: parsed.clinicianSummary.trim(),
    patientSummary: parsed.patientSummary.trim(),
    suggestedActions: parsed.suggestedActions.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 10),
    clinicianReviewRequired: parsed.clinicianReviewRequired !== false,
  };
}

async function buildReviewSummaryInput(organizationId: string, patientId: string, reviewId: string) {
  const review = await PatientReview.findOne({ _id: reviewId, organizationId, patientId }).lean();
  if (!review) return null;
  const [patient, execution, milestone] = await Promise.all([
    Patient.findOne({ _id: patientId, organizationId, status: 'ACTIVE' }).lean(),
    CarePlanExecution.findOne({ _id: review.executionId, organizationId, patientId }).lean(),
    CarePlanMilestone.findOne({ _id: review.milestoneId, organizationId, patientId, executionId: review.executionId }).lean(),
  ]);
  if (!patient || !execution || !milestone) return null;
  const plan = await CarePlan.findOne({ _id: execution.carePlanId, organizationId, patientId }).lean();
  const vitals = review.vitalsRecordId
    ? await VitalRecord.findOne({ _id: review.vitalsRecordId, organizationId, patientId }).lean()
    : null;
  return {
    patient: { preferredLanguage: patient.preferredLanguage || 'en', condition: execution.condition },
    review: {
      id: String(review._id),
      dueAt: review.dueAt.toISOString(),
      status: review.status,
      answers: review.answers,
      notes: review.notes || null,
      adherenceSnapshot: review.adherenceSnapshot || null,
      vitals: vitals ? {
        recordedAt: vitals.recordedAt.toISOString(),
        bloodPressure: vitals.bloodPressure || null,
        bloodSugar: vitals.bloodSugar || null,
        weightKg: vitals.weightKg ?? null,
        symptoms: vitals.symptoms || [],
      } : null,
    },
    carePlan: plan ? {
      condition: plan.condition,
      goals: plan.goals || [],
    } : null,
    milestone: { day: milestone.day, key: milestone.key },
    executionId: String(execution._id),
    milestoneId: String(milestone._id),
  };
}

export async function generatePatientReviewSummary(input: {
  organizationId: string;
  patientId: string;
  reviewId: string;
  version?: number;
  now?: Date;
}): Promise<PatientReviewSummaryResult | null> {
  const version = input.version ?? 1;
  const key = summaryKey(input.reviewId, version);
  const now = input.now ?? new Date();
  const source = await buildReviewSummaryInput(input.organizationId, input.patientId, input.reviewId);
  if (!source) return null;

  const existing = await PatientReviewSummary.findOne({ organizationId: input.organizationId, summaryKey: key }).lean();
  if (existing?.status === 'COMPLETED' || existing?.status === 'GENERATING') {
    return { summary: existing as unknown as Record<string, unknown>, idempotent: true };
  }

  let claimed;
  if (existing?.status === 'FAILED') {
    claimed = await PatientReviewSummary.findOneAndUpdate(
      { _id: existing._id, organizationId: input.organizationId, status: 'FAILED' },
      { $set: { status: 'GENERATING', generationStartedAt: now, lastError: undefined, patientId: input.patientId, reviewId: input.reviewId, executionId: source.review.id ? source.review.id : undefined, milestoneId: undefined, language: source.patient.preferredLanguage }, $inc: { attempts: 1 } },
      { new: true },
    ).lean();
  } else {
    try {
      claimed = await PatientReviewSummary.create({
        organizationId: input.organizationId,
        patientId: input.patientId,
        reviewId: input.reviewId,
        executionId: source.executionId,
        milestoneId: source.milestoneId,
        summaryKey: key,
        version,
        language: source.patient.preferredLanguage,
        status: 'GENERATING',
        generationStartedAt: now,
        attempts: 1,
      });
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000) throw error;
      const concurrent = await PatientReviewSummary.findOne({ organizationId: input.organizationId, summaryKey: key }).lean();
      return concurrent ? { summary: concurrent as unknown as Record<string, unknown>, idempotent: true } : null;
    }
  }
  if (!claimed) return null;

  try {
    const generated = await callReviewSummaryAi(source);
    if (!generated) {
      const failed = await PatientReviewSummary.findOneAndUpdate({ _id: claimed._id, organizationId: input.organizationId, status: 'GENERATING' }, { $set: { status: 'FAILED', lastError: 'AI is not configured or enabled.' } }, { new: true }).lean();
      return failed ? { summary: failed as unknown as Record<string, unknown>, idempotent: false } : null;
    }
    const completed = await PatientReviewSummary.findOneAndUpdate(
      { _id: claimed._id, organizationId: input.organizationId, status: 'GENERATING' },
      { $set: { status: 'COMPLETED', clinicianSummary: generated.clinicianSummary, patientSummary: generated.patientSummary, suggestedActions: generated.suggestedActions, clinicianReviewRequired: generated.clinicianReviewRequired, provider: env.AI_PROVIDER, model: env.AI_MODEL, generatedAt: now, lastError: undefined } },
      { new: true },
    ).lean();
    return completed ? { summary: completed as unknown as Record<string, unknown>, idempotent: false } : null;
  } catch (error) {
    await PatientReviewSummary.updateOne({ _id: claimed._id, organizationId: input.organizationId, status: 'GENERATING' }, { $set: { status: 'FAILED', lastError: error instanceof Error ? error.message.slice(0, 1000) : 'AI generation failed.' } });
    throw error;
  }
}

export async function getPatientReviewSummary(input: { organizationId: string; patientId: string; reviewId: string; version?: number }) {
  return PatientReviewSummary.findOne({ organizationId: input.organizationId, patientId: input.patientId, reviewId: input.reviewId, version: input.version ?? 1 }).lean();
}
