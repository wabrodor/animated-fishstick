import { PatientCommunication, Patient, CarePlan, CareTask } from './models.js';
import { env } from './config.js';

export type PatientCommunicationResult = { communication: Record<string, unknown>; idempotent: boolean };

export type PatientCommunicationChannel = 'WHATSAPP' | 'APP';

export function preferredChannel(patient: { preferredContactChannel?: string; whatsapp?: string }): 'WHATSAPP' | 'APP' {
  return patient.preferredContactChannel === 'WHATSAPP' && patient.whatsapp ? 'WHATSAPP' : 'APP';
}

async function generatePatientMessage(input: { language: string; patientName: string; condition: string; summary: string; goals: Array<{ title: string; target?: string; unit?: string }>; tasks: Array<{ title: string; dueAt: Date; type: string }> }): Promise<string> {
  if (!env.AI_ENABLED || env.AI_PROVIDER !== 'openai-compatible' || !env.AI_API_KEY || !env.AI_BASE_URL || !env.AI_MODEL) {
    const tasks = input.tasks.slice(0, 5).map((task) => `• ${task.title}`).join('\n');
    return `Hello ${input.patientName},\n\nYour ${input.condition.toLowerCase().replaceAll('_', ' ')} care plan is now active.\n\n${input.summary}\n\nYour first steps:\n${tasks || 'Please follow the care plan discussed with your clinic.'}\n\nPlease contact your clinic if you have questions.`;
  }
  const response = await fetch(`${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify({ model: env.AI_MODEL, temperature: 0.2, messages: [
      { role: 'system', content: 'You write patient-facing care-plan messages. Translate and simplify the supplied clinical plan into the requested language. Do not add diagnoses, medication changes, medical advice, or facts not supplied. Preserve dates/tasks. Keep it concise, warm, and actionable.' },
      { role: 'user', content: JSON.stringify(input) },
    ] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`PATIENT_MESSAGE_AI_FAILED:${response.status}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('PATIENT_MESSAGE_AI_EMPTY');
  return text;
}

export async function createCarePlanActivationCommunication(input: { organizationId: string; patientId: string; carePlanId: string }): Promise<PatientCommunicationResult | null> {
  const [patient, plan] = await Promise.all([
    Patient.findOne({ _id: input.patientId, organizationId: input.organizationId, status: 'ACTIVE' }).select('name preferredLanguage preferredContactChannel whatsapp programmeConsent').lean(),
    CarePlan.findOne({ _id: input.carePlanId, patientId: input.patientId, organizationId: input.organizationId, status: 'ACTIVE' }).lean(),
  ]);
  if (!patient || !plan || patient.programmeConsent?.communicationConsent === false) return null;
  const idempotencyKey = `care-plan-activation:${input.carePlanId}:v${plan.version}`;
  const existing = await PatientCommunication.findOne({ organizationId: input.organizationId, idempotencyKey }).lean();
  if (existing) return { communication: existing as unknown as Record<string, unknown>, idempotent: true };
  const tasks = await CareTask.find({ organizationId: input.organizationId, patientId: input.patientId, carePlanId: plan._id }).sort({ dueAt: 1 }).limit(5).select('title dueAt type').lean();
  const message = await generatePatientMessage({
    language: patient.preferredLanguage || 'en', patientName: patient.name.first, condition: plan.condition,
    summary: `Your clinic has approved your ${plan.condition.toLowerCase().replaceAll('_', ' ')} care plan for the next ${Math.max(0, Math.round((plan.endDate.getTime() - plan.startDate.getTime()) / 86400000))} days.`,
    goals: plan.goals.map((goal) => ({ title: goal.title, target: goal.target, unit: goal.unit })),
    tasks: tasks.map((task) => ({ title: task.title, dueAt: task.dueAt, type: task.type })),
  });
  try {
    const communication = await PatientCommunication.create({ organizationId: input.organizationId, patientId: input.patientId, carePlanId: input.carePlanId, purpose: 'CARE_PLAN_ACTIVATION', channel: preferredChannel(patient), language: patient.preferredLanguage || 'en', message, status: 'READY', idempotencyKey });
    return { communication: communication.toObject() as unknown as Record<string, unknown>, idempotent: false };
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    const communication = await PatientCommunication.findOne({ organizationId: input.organizationId, idempotencyKey }).lean();
    if (!communication) throw error;
    return { communication: communication as unknown as Record<string, unknown>, idempotent: true };
  }
}



export async function createPatientReviewReminderCommunication(input: {
  organizationId: string;
  patientId: string;
  reviewId: string;
  carePlanId: string;
  dueAt: Date;
  condition: string;
}): Promise<PatientCommunicationResult | null> {
  const patient = await Patient.findOne({
    _id: input.patientId,
    organizationId: input.organizationId,
    status: 'ACTIVE',
  }).select('name preferredLanguage preferredContactChannel whatsapp programmeConsent').lean();
  if (!patient || patient.programmeConsent?.communicationConsent === false) return null;

  const idempotencyKey = `patient-review-reminder:${input.reviewId}:v1`;
  const existing = await PatientCommunication.findOne({ organizationId: input.organizationId, idempotencyKey }).lean();
  if (existing) return { communication: { ...existing, _id: String(existing._id) } as unknown as Record<string, unknown>, idempotent: true };

  const message = `Hello ${patient.name.first}, this is a reminder from your clinic about your ${input.condition.toLowerCase().replaceAll('_', ' ')} follow-up review. Please contact the clinic or respond through the patient app when convenient. Your review was due on ${input.dueAt.toISOString().slice(0, 10)}.`;
  try {
    const communication = await PatientCommunication.create({
      organizationId: input.organizationId,
      patientId: input.patientId,
      carePlanId: input.carePlanId,
      purpose: 'PATIENT_REVIEW_REMINDER',
      channel: preferredChannel(patient),
      language: patient.preferredLanguage || 'en',
      message,
      status: 'READY',
      idempotencyKey,
    });
    return { communication: { ...communication.toObject(), _id: String(communication._id) } as unknown as Record<string, unknown>, idempotent: false };
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    const communication = await PatientCommunication.findOne({ organizationId: input.organizationId, idempotencyKey }).lean();
    if (!communication) throw error;
    return { communication: { ...communication, _id: String(communication._id) } as unknown as Record<string, unknown>, idempotent: true };
  }
}

export async function createCareTaskReminderCommunication(input: {
  organizationId: string;
  taskId: string;
}): Promise<PatientCommunicationResult | null> {
  const task = await CareTask.findOne({
    _id: input.taskId,
    organizationId: input.organizationId,
  }).lean();
  if (!task || !['PENDING', 'OVERDUE'].includes(task.status)) return null;

  const [patient, plan] = await Promise.all([
    Patient.findOne({
      _id: task.patientId,
      organizationId: input.organizationId,
      status: 'ACTIVE',
    }).select('name preferredLanguage preferredContactChannel whatsapp programmeConsent').lean(),
    CarePlan.findOne({
      _id: task.carePlanId,
      patientId: task.patientId,
      organizationId: input.organizationId,
      status: 'ACTIVE',
    }).select('condition').lean(),
  ]);

  if (!patient || !plan || patient.programmeConsent?.communicationConsent === false) return null;

  const idempotencyKey = `care-task-reminder:${task._id}:v1`;
  const existing = await PatientCommunication.findOne({
    organizationId: input.organizationId,
    idempotencyKey,
  }).lean();
  if (existing) return { communication: { ...existing, _id: String(existing._id) } as unknown as Record<string, unknown>, idempotent: true };

  const message = await generatePatientMessage({
    language: patient.preferredLanguage || 'en',
    patientName: patient.name.first,
    condition: plan.condition,
    summary: `This is a reminder for your ApexCare task: ${task.title}. It is planned for ${task.dueAt.toISOString().slice(0, 10)}.`,
    goals: [],
    tasks: [{ title: task.title, dueAt: task.dueAt, type: task.type }],
  });

  try {
    const communication = await PatientCommunication.create({
      organizationId: input.organizationId,
      patientId: task.patientId,
      carePlanId: task.carePlanId,
      taskId: task._id,
      purpose: 'CARE_TASK_REMINDER',
      channel: preferredChannel(patient),
      language: patient.preferredLanguage || 'en',
      message,
      status: 'READY',
      idempotencyKey,
    });
    return { communication: { ...communication.toObject(), _id: String(communication._id) } as unknown as Record<string, unknown>, idempotent: false };
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    const communication = await PatientCommunication.findOne({ organizationId: input.organizationId, idempotencyKey }).lean();
    if (!communication) throw error;
    return { communication: { ...communication, _id: String(communication._id) } as unknown as Record<string, unknown>, idempotent: true };
  }
}
