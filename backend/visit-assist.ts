import {
  CarePlan,
  CareTask,
  Diagnosis,
  OpdVisit,
  Patient,
  ServiceCase,
  VitalRecord,
} from './models.js';
import { env } from './config.js';

export type VisitAssistQuestion = {
  id: string;
  topic:
    | 'MEDICATION_ADHERENCE'
    | 'HOME_BP'
    | 'SYMPTOMS'
    | 'LABS'
    | 'LIFESTYLE'
    | 'CARE_PLAN'
    | 'FOLLOW_UP';
  question: string;
  answerType: 'TEXT' | 'YES_NO' | 'CHOICE';
  choices?: string[];
  reason: string;
};

export type VisitAssistResponse = {
  patientId: string;
  generatedAt: string;

  missingInformation: Array<{
    key: string;
    label: string;
    importance: 'LOW' | 'MEDIUM' | 'HIGH';
  }>;

  questions: VisitAssistQuestion[];
};

type VisitContext = {
  diagnosisPresent: boolean;
  activeCarePlan: boolean;
  recentVitals: Array<{
    systolic: number;
    diastolic: number;
    recordedAt: string;
    source?: string;
  }>;
  recentOpdVisits: number;
  recentLabsTasks: Array<{
    title: string;
    status: string;
    dueAt: string;
  }>;
  overdueCareTasks: number;
  serviceRequests: Array<{
    service: string;
    status: string;
  }>;
};

export async function generateHypertensionVisitAssist(
  organizationId: string,
  patientId: string,
): Promise<VisitAssistResponse | null> {
  const patient = await Patient.findOne({
    _id: patientId,
    organizationId,
    status: 'ACTIVE',
  })
    .select('conditions enrollmentStatus')
    .lean();

  if (!patient) return null;

  const hasHypertension = patient.conditions.some(
    (condition) =>
      condition.code === 'HYPERTENSION' &&
      condition.status !== 'INACTIVE',
  );

  if (!hasHypertension) return null;

  const [diagnosis, vitals, visits, carePlan, tasks, serviceCases] =
    await Promise.all([
      Diagnosis.findOne({
        organizationId,
        patientId,
        condition: 'HYPERTENSION',
        status: 'CONFIRMED',
      })
        .sort({ diagnosedAt: -1 })
        .lean(),

      VitalRecord.find({
        organizationId,
        patientId,
      })
        .sort({ recordedAt: -1 })
        .limit(10)
        .lean(),

      OpdVisit.find({
        organizationId,
        patientId,
      })
        .sort({ visitAt: -1 })
        .limit(5)
        .lean(),

      CarePlan.findOne({
        organizationId,
        patientId,
        condition: 'HYPERTENSION',
        status: { $in: ['ACTIVE', 'DRAFT', 'PAUSED'] },
      })
        .sort({ startDate: -1 })
        .lean(),

      CareTask.find({
        organizationId,
        patientId,
      })
        .sort({ dueAt: 1 })
        .lean(),

      ServiceCase.find({
        organizationId,
        patientId,
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

  const context: VisitContext = {
    diagnosisPresent: Boolean(diagnosis),

    activeCarePlan: Boolean(carePlan),

    recentVitals: vitals
      .filter((item) => item.bloodPressure)
      .slice(0, 5)
      .map((item) => ({
        systolic: item.bloodPressure!.systolic,
        diastolic: item.bloodPressure!.diastolic,
        recordedAt: item.recordedAt.toISOString(),
        source: item.source,
      })),

    recentOpdVisits: visits.length,

    recentLabsTasks: tasks
      .filter((task) => task.type === 'LAB')
      .slice(0, 10)
      .map((task) => ({
        title: task.title,
        status: task.status,
        dueAt: task.dueAt.toISOString(),
      })),

    overdueCareTasks: tasks.filter(
      (task) =>
        task.status === 'OVERDUE' ||
        (task.status === 'PENDING' && task.dueAt < new Date()),
    ).length,

    serviceRequests: serviceCases.map((item) => ({
      service: item.service,
      status: item.status,
    })),
  };

  if (
    env.AI_ENABLED &&
    env.AI_PROVIDER === 'openai-compatible' &&
    env.AI_API_KEY &&
    env.AI_BASE_URL &&
    env.AI_MODEL
  ) {
    const aiResult = await generateWithProvider(context);

    if (aiResult) {
      return {
        patientId,
        generatedAt: new Date().toISOString(),
        missingInformation: aiResult.missingInformation,
        questions: aiResult.questions,
      };
    }
  }

  return {
    patientId,
    generatedAt: new Date().toISOString(),
    missingInformation: buildMissingInformation(context),
    questions: buildRuleQuestions(context),
  };
}

async function generateWithProvider(
  context: VisitContext,
): Promise<{
  missingInformation: VisitAssistResponse['missingInformation'];
  questions: VisitAssistQuestion[];
} | null> {
  const system = [
    'You are an information-gap assistant used by a clinic care coordinator during a hypertension follow-up visit.',
    'Your ONLY purpose is to identify missing patient information and generate concise questions the coordinator can ask.',
    'Do not provide a patient summary.',
    'Do not diagnose.',
    'Do not interpret whether hypertension is controlled or uncontrolled.',
    'Do not recommend, stop, start, or change medications.',
    'Do not provide treatment advice.',
    'Do not produce risk scores.',
    'Do not invent patient facts.',
    'Use only the supplied structured context.',
    'Prefer simple questions that a coordinator can ask in a busy OPD.',
    'Return JSON only.',
  ].join(' ');

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      missingInformation: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', maxLength: 80 },
            label: { type: 'string', maxLength: 180 },
            importance: {
              type: 'string',
              enum: ['LOW', 'MEDIUM', 'HIGH'],
            },
          },
          required: ['key', 'label', 'importance'],
        },
      },

      questions: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', maxLength: 80 },
            topic: {
              type: 'string',
              enum: [
                'MEDICATION_ADHERENCE',
                'HOME_BP',
                'SYMPTOMS',
                'LABS',
                'LIFESTYLE',
                'CARE_PLAN',
                'FOLLOW_UP',
              ],
            },
            question: { type: 'string', maxLength: 300 },
            answerType: {
              type: 'string',
              enum: ['TEXT', 'YES_NO', 'CHOICE'],
            },
            choices: {
              type: 'array',
              maxItems: 6,
              items: { type: 'string', maxLength: 100 },
            },
            reason: { type: 'string', maxLength: 300 },
          },
          required: [
            'id',
            'topic',
            'question',
            'answerType',
            'reason',
          ],
        },
      },
    },
    required: ['missingInformation', 'questions'],
  };

  const response = await fetch(
    `${env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'hypertension_visit_assist',
            strict: true,
            schema,
          },
        },
        messages: [
          {
            role: 'system',
            content: system,
          },
          {
            role: 'user',
            content: JSON.stringify(context),
          },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    },
  );

  if (!response.ok) return null;

  const body = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };

  const content = body.choices?.[0]?.message?.content;
  if (!content) return null;

  try {
    const parsed = JSON.parse(content) as {
      missingInformation?: VisitAssistResponse['missingInformation'];
      questions?: VisitAssistQuestion[];
    };

    if (
      !Array.isArray(parsed.missingInformation) ||
      !Array.isArray(parsed.questions)
    ) {
      return null;
    }

    return {
      missingInformation: parsed.missingInformation,
      questions: parsed.questions,
    };
  } catch {
    return null;
  }
}

function buildMissingInformation(
  context: VisitContext,
): VisitAssistResponse['missingInformation'] {
  const missing: VisitAssistResponse['missingInformation'] = [];

  if (context.recentVitals.length === 0) {
    missing.push({
      key: 'HOME_BP',
      label: 'Recent blood-pressure monitoring information',
      importance: 'HIGH',
    });
  }

  missing.push({
    key: 'MEDICATION_ADHERENCE',
    label: 'Medication-taking pattern since the last visit',
    importance: 'HIGH',
  });

  missing.push({
    key: 'SYMPTOMS',
    label: 'Current symptoms or new concerns',
    importance: 'HIGH',
  });

  if (context.recentLabsTasks.some((task) => task.status !== 'COMPLETED')) {
    missing.push({
      key: 'LABS',
      label: 'Whether requested laboratory tests were completed',
      importance: 'MEDIUM',
    });
  }

  if (!context.activeCarePlan) {
    missing.push({
      key: 'CARE_PLAN_FOLLOW_UP',
      label: 'Current care-plan follow-up status',
      importance: 'MEDIUM',
    });
  }

  return missing;
}

function buildRuleQuestions(
  context: VisitContext,
): VisitAssistQuestion[] {
  const questions: VisitAssistQuestion[] = [];

  questions.push({
    id: 'medication-adherence',
    topic: 'MEDICATION_ADHERENCE',
    question: 'Have you missed any prescribed medicines since your last visit?',
    answerType: 'CHOICE',
    choices: [
      'No',
      '1–2 doses',
      'Several doses',
      'Not sure',
    ],
    reason: 'Medication-taking information is not present in the available visit context.',
  });

  questions.push({
    id: 'home-bp-frequency',
    topic: 'HOME_BP',
    question: 'How often have you checked your blood pressure at home since the last visit?',
    answerType: 'CHOICE',
    choices: [
      'Daily',
      '2–3 times a week',
      'Occasionally',
      'Not checking',
    ],
    reason: 'Home-monitoring frequency is not reliably captured in the current record.',
  });

  questions.push({
    id: 'current-symptoms',
    topic: 'SYMPTOMS',
    question: 'Have you had any new symptoms or concerns since your last visit?',
    answerType: 'YES_NO',
    choices: ['Yes', 'No'],
    reason: 'Current symptom information is not available in the structured visit data.',
  });

  if (
    context.recentLabsTasks.some(
      (task) => task.status !== 'COMPLETED',
    )
  ) {
    questions.push({
      id: 'labs-completed',
      topic: 'LABS',
      question: 'Were the requested laboratory tests completed?',
      answerType: 'YES_NO',
      choices: ['Yes', 'No'],
      reason: 'At least one laboratory follow-up task is incomplete.',
    });
  }

  return questions;
}