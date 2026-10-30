import { CareTask, Patient, PatientReview, PatientReviewSummary, CoordinatorEscalation } from './models.js';
import { enqueueOutboxEvent } from './outbox.js';

export const NON_ADHERENCE_COMPLETION_THRESHOLD = 0.7;
export const NON_ADHERENCE_MISSED_TASK_THRESHOLD = 3;

export type EscalationEligibility = {
  eligible: boolean;
  reason: 'LOW_ADHERENCE' | 'REPEATED_MISSED_TASKS' | null;
  evidence: Record<string, unknown>;
};

export async function evaluatePatientNonAdherence(input: {
  organizationId: string;
  patientId: string;
  reviewId: string;
}): Promise<EscalationEligibility | null> {
  const review = await PatientReview.findOne({
    _id: input.reviewId,
    organizationId: input.organizationId,
    patientId: input.patientId,
    status: 'COMPLETED',
  }).lean();
  if (!review) return null;

  const snapshot = review.adherenceSnapshot;
  if (!snapshot) return { eligible: false, reason: null, evidence: {} };

  const lowAdherence = snapshot.totalDueTasks > 0 && snapshot.completionRate < NON_ADHERENCE_COMPLETION_THRESHOLD;
  const repeatedMisses = snapshot.overdueTasks >= NON_ADHERENCE_MISSED_TASK_THRESHOLD;
  if (!lowAdherence && !repeatedMisses) {
    return { eligible: false, reason: null, evidence: { completionRate: snapshot.completionRate, overdueTasks: snapshot.overdueTasks, totalDueTasks: snapshot.totalDueTasks } };
  }

  const reason = lowAdherence ? 'LOW_ADHERENCE' : 'REPEATED_MISSED_TASKS';
  return {
    eligible: true,
    reason,
    evidence: {
      reviewId: String(review._id),
      executionId: String(review.executionId),
      milestoneId: String(review.milestoneId),
      completionRate: snapshot.completionRate,
      overdueTasks: snapshot.overdueTasks,
      skippedTasks: snapshot.skippedTasks,
      totalDueTasks: snapshot.totalDueTasks,
      periodStartAt: snapshot.periodStartAt,
      periodEndAt: snapshot.periodEndAt,
    },
  };
}

export async function ensureCoordinatorEscalation(input: {
  organizationId: string;
  patientId: string;
  reviewId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const eligibility = await evaluatePatientNonAdherence(input);
  if (!eligibility?.eligible || !eligibility.reason) return { escalation: null, idempotent: false, eligible: false };

  const review = await PatientReview.findOne({ _id: input.reviewId, organizationId: input.organizationId, patientId: input.patientId }).lean();
  const patient = await Patient.findOne({ _id: input.patientId, organizationId: input.organizationId, status: 'ACTIVE' }).select('_id').lean();
  if (!review || !patient) return { escalation: null, idempotent: false, eligible: false };

  const escalationKey = `non-adherence:${review.executionId}:${review.milestoneId}:${eligibility.reason}`;
  const existing = await CoordinatorEscalation.findOne({ organizationId: input.organizationId, escalationKey }).lean();
  if (existing) return { escalation: existing, idempotent: true, eligible: true };

  const summary = await PatientReviewSummary.findOne({ organizationId: input.organizationId, patientId: input.patientId, reviewId: input.reviewId, status: 'COMPLETED', version: 1 }).select('_id clinicianSummary suggestedActions').lean();
  const evidence = { ...eligibility.evidence, reviewSummaryId: summary?._id ? String(summary._id) : undefined };

  try {
    const escalation = await CoordinatorEscalation.create({
      organizationId: input.organizationId,
      patientId: input.patientId,
      executionId: review.executionId,
      reviewId: review._id,
      milestoneId: review.milestoneId,
      escalationKey,
      reason: eligibility.reason,
      status: 'OPEN',
      priority: eligibility.reason === 'LOW_ADHERENCE' ? 'HIGH' : 'MEDIUM',
      evidence,
      openedAt: now,
    });

    await enqueueOutboxEvent({
      organizationId: input.organizationId,
      eventKey: `coordinator-escalation-opened:${escalation._id}`,
      eventType: 'COORDINATOR_ESCALATION_OPENED',
      aggregateType: 'CoordinatorEscalation',
      aggregateId: String(escalation._id),
      payload: {
        organizationId: input.organizationId,
        patientId: input.patientId,
        executionId: String(review.executionId),
        reviewId: String(review._id),
        milestoneId: String(review.milestoneId),
        escalationId: String(escalation._id),
        reason: eligibility.reason,
        priority: escalation.priority,
        evidence,
      },
    });
    return { escalation: escalation.toObject(), idempotent: false, eligible: true };
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    const concurrent = await CoordinatorEscalation.findOne({ organizationId: input.organizationId, escalationKey }).lean();
    if (!concurrent) throw error;
    return { escalation: concurrent, idempotent: true, eligible: true };
  }
}

export async function listCoordinatorEscalations(input: { organizationId: string; status?: 'OPEN' | 'RESOLVED'; limit?: number }) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  return CoordinatorEscalation.find({ organizationId: input.organizationId, ...(input.status ? { status: input.status } : { status: 'OPEN' }) })
    .sort({ priority: -1, openedAt: 1 })
    .limit(limit)
    .lean();
}

export async function resolveCoordinatorEscalation(input: {
  organizationId: string;
  escalationId: string;
  coordinatorUserId: string;
  outcome: string;
  notes?: string;
}) {
  return CoordinatorEscalation.findOneAndUpdate(
    { _id: input.escalationId, organizationId: input.organizationId, status: 'OPEN' },
    { $set: { status: 'RESOLVED', resolvedAt: new Date(), resolvedByUserId: input.coordinatorUserId, outcome: input.outcome, resolutionNotes: input.notes } },
    { new: true },
  ).lean();
}
