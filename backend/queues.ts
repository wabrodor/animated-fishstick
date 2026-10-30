import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './config.js';


export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const reminderQueue = new Queue('apexcare-reminders', { connection: redisConnection });

export const aiCarePlanQueue = new Queue('apexcare-ai-care-plans', { connection: redisConnection });
export const prescriptionAnalysisQueue = new Queue('apexcare-prescription-analysis', { connection: redisConnection });
export const apexcareOperationalQueue = new Queue('apexcare-operational', { connection: redisConnection });
export const labProcessingQueue = new Queue('apexcare-lab-processing', { connection: redisConnection });

export async function scheduleCareTaskReminder(taskId: string, dueAt: Date, context?: { organizationId?: string; patientId?: string }): Promise<void> {
  const reminderAt = new Date(dueAt);
  reminderAt.setHours(reminderAt.getHours() - 24);
  const delay = Math.max(0, reminderAt.getTime() - Date.now());

  await reminderQueue.add(
    'care-task-due',
    { taskId, ...(context?.organizationId ? { organizationId: context.organizationId } : {}), ...(context?.patientId ? { patientId: context.patientId } : {}) },
    {
      delay,
      jobId: `care-task-${taskId}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    },
  );
}

export async function scheduleHypertensionDraftGeneration(input: {
  patientId: string;
  clinicOrganizationId: string;
  apexcareOrganizationId: string;
  clinicianId: string;
  enrollmentId: string;
  assessmentId: string;
  attempt: number;
}): Promise<string> {
  const jobId = `hypertension-draft-${input.enrollmentId}-${input.assessmentId}-${input.attempt}`;
  const job = await aiCarePlanQueue.add(
    'generate-hypertension-draft',
    input,
    {
      jobId,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    },
  );
  return String(job.id);
}



export async function schedulePrescriptionAnalysis(documentId: string): Promise<string> {
  const job = await prescriptionAnalysisQueue.add(
    'analyze-prescription-image',
    { documentId },
    {
      jobId: `prescription-analysis-${documentId}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );
  return String(job.id);
}

export async function schedulePrescriptionVerification(documentId: string, draftId: string): Promise<string> {
  const job = await prescriptionAnalysisQueue.add(
    'verify-prescription-medications',
    { documentId, draftId },
    {
      jobId: `prescription-verification-${draftId}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );
  return String(job.id);
}


export async function scheduleApexCareReferralEscalation(referralId: string, dueAt: Date): Promise<void> {
  const delay = Math.max(0, dueAt.getTime() - Date.now());
  await apexcareOperationalQueue.add(
    'referral-staff-sla',
    { referralId },
    {
      delay,
      jobId: `apexcare-referral-sla-${referralId}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    },
  );
}

export async function scheduleCoordinatorCallSla(enrollmentId: string, dueAt: Date): Promise<void> {
  const delay = Math.max(0, dueAt.getTime() - Date.now());
  await apexcareOperationalQueue.add(
    'coordinator-call-sla',
    { enrollmentId },
    {
      delay,
      jobId: `apexcare-coordinator-sla-${enrollmentId}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    },
  );
}


export async function scheduleClinicalReviewSla(reviewCaseId: string, dueAt: Date): Promise<void> {
  const delay = Math.max(0, dueAt.getTime() - Date.now());
  await apexcareOperationalQueue.add(
    'clinical-review-sla',
    { reviewCaseId },
    {
      delay,
      jobId: `apexcare-clinical-review-sla-${reviewCaseId}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    },
  );
}

export async function scheduleCarePlanReviewSla(draftId: string, dueAt: Date): Promise<void> {
  const delay = Math.max(0, dueAt.getTime() - Date.now());
  await apexcareOperationalQueue.add(
    'care-plan-review-sla',
    { draftId },
    {
      delay,
      jobId: `apexcare-care-plan-review-sla-${draftId}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    },
  );
}


export async function scheduleCarePlanMilestone(input: {
  organizationId: string;
  patientId: string;
  executionId: string;
  milestoneId: string;
  day: number;
  offsetDays: number;
  milestoneKey: string;
  dueAt: Date;
}): Promise<string> {
  const jobId = `care-plan-milestone-${input.executionId}-${input.milestoneId}`;
  const delay = Math.max(0, input.dueAt.getTime() - Date.now());
  const job = await apexcareOperationalQueue.add(
    'care-plan-milestone-due',
    input,
    {
      delay,
      jobId,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    },
  );
  return String(job.id);
}


export async function scheduleLabDocumentExtraction(input: {
  documentId: string;
  organizationId: string;
  patientId: string;
  apexcareOrganizationId: string;
}): Promise<string> {
  const job = await labProcessingQueue.add(
    'extract-lab-pdf',
    input,
    {
      jobId: `lab-extraction-${input.documentId}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );
  return String(job.id);
}


export async function scheduleLabResultStructuring(input: { documentId: string; organizationId: string; patientId: string; apexcareOrganizationId: string }): Promise<string> {
  const job = await labProcessingQueue.add(
    'structure-lab-results',
    input,
    {
      jobId: `lab-structure-${input.documentId}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );
  return String(job.id);
}


export async function scheduleLabInterpretation(input: { documentId: string; organizationId: string; patientId: string; apexcareOrganizationId: string }): Promise<string> {
  const job = await labProcessingQueue.add(
    'interpret-lab-results',
    input,
    {
      jobId: `lab-interpretation-${input.documentId}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );
  return String(job.id);
}
