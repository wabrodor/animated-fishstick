import { CarePlan, CareTask, OpdVisit, Patient, VitalRecord } from './models.js';
import { env } from './config.js';

export type HypertensionProgressSummary = {
  patientId: string;
  generatedAt: string;
  dataWindow: { from: string | null; to: string | null };
  vitals: {
    bloodPressureReadings: number;
    latestBloodPressure: { systolic: number; diastolic: number; recordedAt: string } | null;
    averageBloodPressure: { systolic: number; diastolic: number } | null;
    latestWeightKg: number | null;
    weightChangeKg: number | null;
  };
  careTasks: { total: number; completed: number; overdue: number; completionRate: number };
  opdVisits: number;
  observations: string[];
  clinicianReviewRequired: boolean;
  ai: { enabled: boolean; provider: string | null; generatedText: string | null };
};

export async function buildHypertensionProgressSummary(organizationId: string, patientId: string): Promise<HypertensionProgressSummary | null> {
  const patient = await Patient.findOne({ _id: patientId, organizationId, status: 'ACTIVE' }).lean();
  if (!patient) return null;

  const [vitals, tasks, visits, activePlan] = await Promise.all([
    VitalRecord.find({ organizationId, patientId }).sort({ recordedAt: -1 }).limit(30).lean(),
    CareTask.find({ organizationId, patientId }).lean(),
    OpdVisit.find({ organizationId, patientId }).sort({ visitAt: -1 }).limit(20).lean(),
    CarePlan.findOne({ organizationId, patientId, condition: 'HYPERTENSION', status: { $in: ['DRAFT', 'ACTIVE', 'PAUSED'] } }).sort({ startDate: -1 }).lean(),
  ]);

  const bp = vitals.filter((v) => v.bloodPressure).map((v) => ({
    systolic: v.bloodPressure!.systolic,
    diastolic: v.bloodPressure!.diastolic,
    recordedAt: v.recordedAt,
  }));
  const latest = bp[0] ?? null;
  const recent = bp.slice(0, 5);
  const average = recent.length
    ? {
        systolic: Math.round(recent.reduce((sum, item) => sum + item.systolic, 0) / recent.length),
        diastolic: Math.round(recent.reduce((sum, item) => sum + item.diastolic, 0) / recent.length),
      }
    : null;

  const weights = vitals.filter((v) => typeof v.weightKg === 'number').map((v) => v.weightKg as number);
  const latestWeightKg = weights[0] ?? null;
  const weightChangeKg = weights.length >= 2 ? Number((weights[0] - weights[weights.length - 1]).toFixed(1)) : null;

  const completed = tasks.filter((task) => task.status === 'COMPLETED').length;
  const overdue = tasks.filter((task) => task.status === 'OVERDUE' || (task.status === 'PENDING' && task.dueAt < new Date())).length;
  const completionRate = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;

  const observations: string[] = [];
  if (latest && (latest.systolic >= 140 || latest.diastolic >= 90)) observations.push('Latest recorded blood pressure is above the commonly used clinic threshold of 140/90 mmHg; clinician review is required.');
  if (average && (average.systolic >= 140 || average.diastolic >= 90)) observations.push('The average of the five most recent blood-pressure readings remains above 140/90 mmHg.');
  if (overdue > 0) observations.push(`${overdue} care task${overdue === 1 ? '' : 's'} ${overdue === 1 ? 'is' : 'are'} overdue or still pending after the due time.`);
  if (weightChangeKg !== null && weightChangeKg < -2) observations.push(`Recorded weight has decreased by ${Math.abs(weightChangeKg)} kg across the available readings.`);
  if (weightChangeKg !== null && weightChangeKg > 2) observations.push(`Recorded weight has increased by ${weightChangeKg} kg across the available readings.`);
  if (!activePlan) observations.push('No active hypertension care plan was found.');

  const generatedText = env.AI_ENABLED && env.AI_PROVIDER === 'openai-compatible'
    ? await generateAiNarrative({ condition: 'HYPERTENSION', latest, average, latestWeightKg, weightChangeKg, completionRate, overdue, visits: visits.length, observations })
    : null;

  return {
    patientId,
    generatedAt: new Date().toISOString(),
    dataWindow: {
      from: vitals.at(-1)?.recordedAt?.toISOString() ?? null,
      to: vitals[0]?.recordedAt?.toISOString() ?? null,
    },
    vitals: { bloodPressureReadings: bp.length, latestBloodPressure: latest ? { ...latest, recordedAt: latest.recordedAt.toISOString() } : null, averageBloodPressure: average, latestWeightKg, weightChangeKg },
    careTasks: { total: tasks.length, completed, overdue, completionRate },
    opdVisits: visits.length,
    observations,
    clinicianReviewRequired: Boolean(latest && (latest.systolic >= 140 || latest.diastolic >= 90)) || overdue > 0 || !activePlan,
    ai: { enabled: Boolean(generatedText), provider: generatedText ? env.AI_PROVIDER : null, generatedText },
  };
}

async function generateAiNarrative(input: Record<string, unknown>): Promise<string | null> {
  if (!env.AI_API_KEY || !env.AI_BASE_URL || !env.AI_MODEL) return null;
  const response = await fetch(`${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify({
      model: env.AI_MODEL,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'You are a clinical documentation assistant. Summarize structured hypertension follow-up data for a licensed clinician. Do not diagnose, prescribe, change medication, or invent missing facts. Clearly label uncertainty and advise clinician review when appropriate. Keep the summary concise.' },
        { role: 'user', content: JSON.stringify(input) },
      ],
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return null;
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content?.trim() || null;
}
