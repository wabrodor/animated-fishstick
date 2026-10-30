import { CarePlanExecution, CarePlanMilestone, CareTask, PatientReview } from './models.js';

export type ReviewAdherenceSnapshot = {
  periodStartAt: Date;
  periodEndAt: Date;
  totalDueTasks: number;
  completedTasks: number;
  skippedTasks: number;
  overdueTasks: number;
  pendingTasks: number;
  completionRate: number;
  actionedRate: number;
  byType: Record<string, {
    totalDueTasks: number;
    completedTasks: number;
    skippedTasks: number;
    overdueTasks: number;
    pendingTasks: number;
    completionRate: number;
  }>;
  generatedAt: Date;
};

function rate(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}

export async function buildPatientReviewAdherenceSnapshot(input: {
  organizationId: string;
  patientId: string;
  reviewId: string;
  now?: Date;
}): Promise<ReviewAdherenceSnapshot | null> {
  const now = input.now ?? new Date();
  const review = await PatientReview.findOne({
    _id: input.reviewId,
    organizationId: input.organizationId,
    patientId: input.patientId,
  }).lean();
  if (!review) return null;

  const execution = await CarePlanExecution.findOne({
    _id: review.executionId,
    organizationId: input.organizationId,
    patientId: input.patientId,
  }).lean();
  if (!execution) return null;

  const milestone = await CarePlanMilestone.findOne({
    _id: review.milestoneId,
    organizationId: input.organizationId,
    patientId: input.patientId,
    executionId: execution._id,
  }).lean();
  if (!milestone) return null;

  const previousMilestone = await CarePlanMilestone.findOne({
    organizationId: input.organizationId,
    patientId: input.patientId,
    executionId: execution._id,
    offsetDays: { $lt: milestone.offsetDays },
  }).sort({ offsetDays: -1 }).lean();

  const periodStartAt = previousMilestone?.dueAt ?? execution.startDate;
  // Early reviews must not penalize a patient for tasks that were not yet due.
  const periodEndAt = new Date(Math.min(now.getTime(), milestone.dueAt.getTime()));

  const tasks = await CareTask.find({
    organizationId: input.organizationId,
    patientId: input.patientId,
    executionId: execution._id,
    dueAt: { $gte: periodStartAt, $lte: periodEndAt },
  }).select('type status dueAt').lean();

  const counts = {
    totalDueTasks: tasks.length,
    completedTasks: 0,
    skippedTasks: 0,
    overdueTasks: 0,
    pendingTasks: 0,
  };
  const byType: ReviewAdherenceSnapshot['byType'] = {};

  for (const task of tasks) {
    const key = task.type;
    byType[key] ??= {
      totalDueTasks: 0,
      completedTasks: 0,
      skippedTasks: 0,
      overdueTasks: 0,
      pendingTasks: 0,
      completionRate: 0,
    };
    const bucket = byType[key];
    bucket.totalDueTasks += 1;

    if (task.status === 'COMPLETED') {
      counts.completedTasks += 1;
      bucket.completedTasks += 1;
    } else if (task.status === 'SKIPPED') {
      counts.skippedTasks += 1;
      bucket.skippedTasks += 1;
    } else if (task.status === 'OVERDUE') {
      counts.overdueTasks += 1;
      bucket.overdueTasks += 1;
    } else {
      counts.pendingTasks += 1;
      bucket.pendingTasks += 1;
    }
  }

  for (const bucket of Object.values(byType)) {
    bucket.completionRate = rate(bucket.completedTasks, bucket.totalDueTasks);
  }

  const actionedTasks = counts.completedTasks + counts.skippedTasks + counts.overdueTasks;
  return {
    periodStartAt,
    periodEndAt,
    ...counts,
    completionRate: rate(counts.completedTasks, counts.totalDueTasks),
    actionedRate: rate(actionedTasks, counts.totalDueTasks),
    byType,
    generatedAt: now,
  };
}

export async function ensurePatientReviewAdherenceSnapshot(input: {
  organizationId: string;
  patientId: string;
  reviewId: string;
  now?: Date;
}) {
  const existing = await PatientReview.findOne({
    _id: input.reviewId,
    organizationId: input.organizationId,
    patientId: input.patientId,
  }).select('adherenceSnapshot').lean();
  if (!existing) return null;
  if (existing.adherenceSnapshot) return existing.adherenceSnapshot;

  const snapshot = await buildPatientReviewAdherenceSnapshot(input);
  if (!snapshot) return null;

  await PatientReview.updateOne(
    {
      _id: input.reviewId,
      organizationId: input.organizationId,
      patientId: input.patientId,
      adherenceSnapshot: { $exists: false },
    },
    { $set: { adherenceSnapshot: snapshot } },
  );

  const saved = await PatientReview.findOne({
    _id: input.reviewId,
    organizationId: input.organizationId,
    patientId: input.patientId,
  }).select('adherenceSnapshot').lean();
  return saved?.adherenceSnapshot ?? snapshot;
}
