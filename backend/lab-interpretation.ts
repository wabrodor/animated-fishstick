import { env } from './config.js';
import { LabDocument, LabInterpretation, LabResult, Patient } from './models.js';

export const LAB_INTERPRETATION_VERSION = 1;
const PROCESSING_LEASE_MS = 10 * 60 * 1000;

export type LabInterpretationProvider = (input: {
  patientLanguage: string;
  conditionCodes: string[];
  results: Array<{
    testName: string;
    normalizedTestName: string;
    valueText: string;
    unit?: string;
    referenceRangeText?: string;
    abnormalFlag: string;
  }>;
}) => Promise<{
  clinicianSummary: string;
  patientSummary: string;
  suggestedDiscussionPoints: string[];
  urgentReview: boolean;
  confidence: number;
}>;

let providerOverride: LabInterpretationProvider | undefined;

export function setLabInterpretationProviderForTests(provider?: LabInterpretationProvider) {
  providerOverride = provider;
}

function extractJson(content: string): Record<string, unknown> {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] ?? content;
  const parsed = JSON.parse(candidate);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('LAB_AI_INVALID_JSON');
  return parsed as Record<string, unknown>;
}

function stringField(value: unknown, field: string, max = 5000): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`LAB_AI_INVALID_${field.toUpperCase()}`);
  return value.trim().slice(0, max);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`LAB_AI_INVALID_${field.toUpperCase()}`);
  return value.filter((item): item is string => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, 500)).slice(0, 20);
}

function numberField(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error('LAB_AI_INVALID_CONFIDENCE');
  return number;
}

async function defaultProvider(input: Parameters<LabInterpretationProvider>[0]): Promise<Awaited<ReturnType<LabInterpretationProvider>>> {
  if (!env.AI_ENABLED || !env.AI_BASE_URL || !env.AI_API_KEY || !env.AI_MODEL) {
    throw new Error('LAB_AI_PROVIDER_NOT_CONFIGURED');
  }

  const system = [
    'You are ApexCare lab-result summarization AI.',
    'Summarize evidence only. Do not diagnose, prescribe, change medication, or give autonomous treatment instructions.',
    'The clinician is the final clinical decision-maker.',
    'Return JSON only with: clinicianSummary, patientSummary, suggestedDiscussionPoints, urgentReview, confidence.',
    'clinicianSummary must use concise clinical terminology and identify abnormal findings and uncertainty.',
    'patientSummary must be plain-language and written in the requested patient language.',
    'suggestedDiscussionPoints must be questions or items for the clinician to review, not treatment orders.',
    'urgentReview is true only when the supplied results contain a potentially urgent abnormality that warrants prompt clinician review.',
  ].join(' ');

  const user = JSON.stringify({ patientLanguage: input.patientLanguage, conditionCodes: input.conditionCodes, results: input.results });
  const response = await fetch(`${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify({ model: env.AI_MODEL, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!response.ok) throw new Error(`LAB_AI_PROVIDER_HTTP_${response.status}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('LAB_AI_EMPTY_RESPONSE');
  const json = extractJson(content);
  return {
    clinicianSummary: stringField(json.clinicianSummary, 'clinicianSummary'),
    patientSummary: stringField(json.patientSummary, 'patientSummary'),
    suggestedDiscussionPoints: stringArray(json.suggestedDiscussionPoints, 'suggestedDiscussionPoints'),
    urgentReview: Boolean(json.urgentReview),
    confidence: numberField(json.confidence),
  };
}

async function ensureInterpretationOutbox(document: { _id: unknown; clinicOrganizationId: unknown; patientId: unknown; apexcareOrganizationId: unknown; structuringVersion?: number }) {
  const { enqueueOutboxEvent } = await import('./outbox.js');
  await enqueueOutboxEvent({
    organizationId: String(document.clinicOrganizationId),
    eventKey: `LAB_RESULTS_STRUCTURED:${String(document._id)}:v${document.structuringVersion ?? 1}`,
    eventType: 'LAB_RESULTS_STRUCTURED',
    aggregateType: 'LabDocument',
    aggregateId: String(document._id),
    payload: {
      documentId: String(document._id),
      patientId: String(document.patientId),
      clinicOrganizationId: String(document.clinicOrganizationId),
      apexcareOrganizationId: String(document.apexcareOrganizationId),
    },
  });
}

export async function claimLabInterpretation(documentId: string, context?: { organizationId?: string; patientId?: string; apexcareOrganizationId?: string }, now = new Date()) {
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  return LabDocument.findOneAndUpdate(
    {
      _id: documentId,
      ...(context?.organizationId ? { clinicOrganizationId: context.organizationId } : {}),
      ...(context?.patientId ? { patientId: context.patientId } : {}),
      ...(context?.apexcareOrganizationId ? { apexcareOrganizationId: context.apexcareOrganizationId } : {}),
      extractionStatus: 'COMPLETED',
      structuringStatus: 'COMPLETED',
      $or: [
        { interpretationStatus: { $in: ['NOT_STARTED', 'FAILED'] } },
        { interpretationStatus: 'PROCESSING', interpretationStartedAt: { $lte: staleBefore } },
      ],
    },
    { $set: { interpretationStatus: 'PROCESSING', interpretationStartedAt: now, interpretationError: undefined } },
    { new: true },
  ).lean();
}

export async function processLabInterpretation(documentId: string, context?: { organizationId?: string; patientId?: string; apexcareOrganizationId?: string }, now = new Date()) {
  const document = await claimLabInterpretation(documentId, context, now);
  if (!document) return { processed: false, idempotent: true };

  try {
    const patient = await Patient.findOne({ _id: document.patientId, organizationId: document.clinicOrganizationId, status: 'ACTIVE' }).select('preferredLanguage conditions').lean();
    if (!patient) throw new Error('LAB_INTERPRETATION_PATIENT_NOT_FOUND');

    const results = await LabResult.find({ organizationId: document.clinicOrganizationId, patientId: document.patientId, labDocumentId: document._id })
      .sort({ normalizedTestName: 1, createdAt: 1 }).lean();
    if (results.length === 0) throw new Error('LAB_NO_STRUCTURED_RESULTS');

    const interpretationKey = `${document._id}:s${document.structuringVersion ?? 1}:i${LAB_INTERPRETATION_VERSION}`;
    const existing = await LabInterpretation.findOne({ organizationId: document.clinicOrganizationId, interpretationKey }).lean();
    if (existing) {
      await LabDocument.updateOne({ _id: document._id, interpretationStatus: 'PROCESSING' }, { $set: { interpretationStatus: 'COMPLETED', interpretationVersion: LAB_INTERPRETATION_VERSION, interpretedAt: existing.createdAt }, $unset: { interpretationStartedAt: 1 } });
      return { processed: false, idempotent: true, interpretationId: String(existing._id) };
    }

    const provider = providerOverride ?? defaultProvider;
    const output = await provider({
      patientLanguage: patient.preferredLanguage || 'en',
      conditionCodes: patient.conditions.filter((condition) => condition.status !== 'INACTIVE').map((condition) => condition.code),
      results: results.map((result) => ({
        testName: result.testName,
        normalizedTestName: result.normalizedTestName,
        valueText: result.valueText,
        unit: result.unit,
        referenceRangeText: result.referenceRangeText,
        abnormalFlag: result.abnormalFlag,
      })),
    });

    let created;
    try {
      created = await LabInterpretation.findOneAndUpdate(
        { organizationId: document.clinicOrganizationId, interpretationKey },
        {
          $setOnInsert: {
            organizationId: document.clinicOrganizationId,
            apexcareOrganizationId: document.apexcareOrganizationId,
            patientId: document.patientId,
            labDocumentId: document._id,
            interpretationKey,
            interpretationVersion: LAB_INTERPRETATION_VERSION,
            provider: env.AI_PROVIDER,
            model: env.AI_MODEL ?? 'unconfigured',
            patientLanguage: patient.preferredLanguage || 'en',
            clinicianSummary: output.clinicianSummary,
            patientSummary: output.patientSummary,
            suggestedDiscussionPoints: output.suggestedDiscussionPoints,
            urgentReview: output.urgentReview,
            confidence: output.confidence,
            status: 'READY',
            clinicianReviewStatus: 'PENDING',
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000) throw error;
      created = await LabInterpretation.findOne({ organizationId: document.clinicOrganizationId, interpretationKey }).lean();
      if (!created) throw error;
    }

    await LabDocument.updateOne(
      { _id: document._id, interpretationStatus: 'PROCESSING' },
      { $set: { interpretationStatus: 'COMPLETED', interpretationVersion: LAB_INTERPRETATION_VERSION, interpretedAt: now }, $unset: { interpretationStartedAt: 1, interpretationError: 1 } },
    );

    return { processed: true, idempotent: false, interpretationId: String(created?._id), urgentReview: output.urgentReview };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'LAB_INTERPRETATION_FAILED';
    await LabDocument.updateOne({ _id: document._id, interpretationStatus: 'PROCESSING' }, { $set: { interpretationStatus: 'FAILED', interpretationError: message.slice(0, 1000) }, $unset: { interpretationStartedAt: 1 } });
    throw error;
  }
}
