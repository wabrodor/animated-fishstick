import { CarePlan, CarePlanExecution, CarePlanMilestone, CareTask, PatientReview } from './models.js';
import { enqueueOutboxEvent } from './outbox.js';
import { ensurePatientReviewAdherenceSnapshot } from './patient-review-adherence.js';
import { ensureCoordinatorEscalation } from './coordinator-escalation.js';
import { ensureAdherenceClinicalSignal } from './clinical-signal.js';

export const REVIEW_QUESTION_TEMPLATES = [
  { questionId: 'medication_adherence', topic: 'MEDICATION_ADHERENCE', question: 'Did the patient follow the prescribed medication plan?' },
  { questionId: 'diet_adherence', topic: 'DIET_ADHERENCE', question: 'Did the patient follow the agreed diet plan?' },
  { questionId: 'lifestyle_adherence', topic: 'LIFESTYLE_ADHERENCE', question: 'Did the patient follow the agreed activity/lifestyle plan?' },
  { questionId: 'labs', topic: 'LABS', question: 'Were the planned laboratory tests completed, or is there a reason they were not completed?' },
  { questionId: 'symptoms', topic: 'SYMPTOMS', question: 'Has the patient developed any new or worsening symptoms since the last review?' },
  { questionId: 'care_plan', topic: 'CARE_PLAN', question: 'Did the patient have difficulty following any part of the care plan?' },
  { questionId: 'patient_concerns', topic: 'PATIENT_CONCERNS', question: 'What questions or concerns does the patient have today?' },
] as const;

export type PatientReviewResult = {
  review: Record<string, unknown>;
  idempotent: boolean;
};

export async function ensurePatientReviewForMilestone(input: {
  organizationId: string;
  patientId: string;
  executionId: string;
  milestoneId: string;
}): Promise<PatientReviewResult | null> {
  const milestone = await CarePlanMilestone.findOne({
    _id: input.milestoneId,
    organizationId: input.organizationId,
    patientId: input.patientId,
    executionId: input.executionId,
  }).lean();

  if (!milestone || !milestone.reviewRequired) return null;

  const execution = await CarePlanExecution.findOne({
    _id: input.executionId,
    organizationId: input.organizationId,
    patientId: input.patientId,
    status: 'ACTIVE',
  }).lean();
  if (!execution) return null;

  const plan = await CarePlan.findOne({
    _id: execution.carePlanId,
    organizationId: input.organizationId,
    patientId: input.patientId,
    status: 'ACTIVE',
  }).lean();
  if (!plan) return null;

  const reviewKey = `patient-review:${execution._id}:${milestone._id}`;
  const existing = await PatientReview.findOne({
    organizationId: input.organizationId,
    reviewKey,
  }).lean();
  if (existing) return { review: existing as unknown as Record<string, unknown>, idempotent: true };

  try {
    const review = await PatientReview.create({
      organizationId: input.organizationId,
      patientId: input.patientId,
      carePlanId: execution.carePlanId,
      executionId: execution._id,
      milestoneId: milestone._id,
      reviewKey,
      status: 'OPEN',
      dueAt: milestone.dueAt,
      questions: REVIEW_QUESTION_TEMPLATES.map((question) => ({ ...question })),
    });

    await enqueueOutboxEvent({
      organizationId: input.organizationId,
      eventKey: `patient-review-ready:${review._id}`,
      eventType: 'PATIENT_REVIEW_READY',
      aggregateType: 'PatientReview',
      aggregateId: String(review._id),
      payload: {
        organizationId: input.organizationId,
        patientId: input.patientId,
        carePlanId: String(execution.carePlanId),
        executionId: String(execution._id),
        milestoneId: String(milestone._id),
        reviewId: String(review._id),
        dueAt: milestone.dueAt.toISOString(),
      },
    });

    return { review: review.toObject() as unknown as Record<string, unknown>, idempotent: false };
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    const review = await PatientReview.findOne({
      organizationId: input.organizationId,
      reviewKey,
    }).lean();
    if (!review) throw error;
    return { review: review as unknown as Record<string, unknown>, idempotent: true };
  }
}

export async function getPatientReview(input: {
  organizationId: string;
  patientId: string;
  reviewId: string;
}) {
  return PatientReview.findOne({
    _id: input.reviewId,
    organizationId: input.organizationId,
    patientId: input.patientId,
  }).lean();
}

export async function completePatientReview(input: {
  organizationId: string;
  patientId: string;
  reviewId: string;
  actorUserId: string;
  answers: Array<{ questionId: string; topic: string; question: string; answer?: string }>;
  notes?: string;
  vitalsRecordId?: string;
}) {
  const review = await PatientReview.findOne({
    _id: input.reviewId,
    organizationId: input.organizationId,
    patientId: input.patientId,
    status: { $in: ['OPEN', 'IN_PROGRESS', 'COMPLETED'] },
  });
  if (!review) return null;

  if (review.status === 'COMPLETED') {
    await ensurePatientReviewAdherenceSnapshot({ organizationId: input.organizationId, patientId: input.patientId, reviewId: input.reviewId });
    await ensureCoordinatorEscalation({ organizationId: input.organizationId, patientId: input.patientId, reviewId: input.reviewId });
    await ensureAdherenceClinicalSignal({ organizationId: input.organizationId, patientId: input.patientId, reviewId: input.reviewId });
    return PatientReview.findById(review._id).lean();
  }

  review.status = 'COMPLETED';
  review.startedAt ??= new Date();
  review.completedAt = new Date();
  review.completedByUserId = input.actorUserId;
  review.answers = input.answers as never;
  review.notes = input.notes;
  review.vitalsRecordId = input.vitalsRecordId as never;
  await review.save();

  // A completed coordinator review closes the operational review milestone.
  // A coordinator review closes only the coordinator follow-up task. OPD visits remain
  // clinician-documented events and laboratory tasks remain independently executable.
  await CarePlanMilestone.updateOne(
    { _id: review.milestoneId, organizationId: input.organizationId, patientId: input.patientId },
    { $set: { status: 'COMPLETED', completedAt: review.completedAt, completedByUserId: input.actorUserId } },
  );

  await CareTask.updateMany(
    {
      organizationId: input.organizationId,
      patientId: input.patientId,
      milestoneId: review.milestoneId,
      type: 'FOLLOW_UP',
      status: { $in: ['PENDING', 'OVERDUE'] },
    },
    { $set: { status: 'COMPLETED', completedAt: review.completedAt, completedByUserId: input.actorUserId } },
  );

  if (input.vitalsRecordId) {
    await CareTask.updateMany(
      {
        organizationId: input.organizationId,
        patientId: input.patientId,
        milestoneId: review.milestoneId,
        type: 'VITALS',
        status: { $in: ['PENDING', 'OVERDUE'] },
      },
      { $set: { status: 'COMPLETED', completedAt: review.completedAt, completedByUserId: input.actorUserId } },
    );
  }

  await ensurePatientReviewAdherenceSnapshot({ organizationId: input.organizationId, patientId: input.patientId, reviewId: input.reviewId });
  await ensureCoordinatorEscalation({ organizationId: input.organizationId, patientId: input.patientId, reviewId: input.reviewId });
  await ensureAdherenceClinicalSignal({ organizationId: input.organizationId, patientId: input.patientId, reviewId: input.reviewId });

  return PatientReview.findById(review._id).lean();
}
