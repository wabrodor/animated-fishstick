import mongoose from 'mongoose';
import { CarePlanExecution, CareTask, LabInterpretation, Patient, PatientReview } from './models.js';

// Resolve the model from Mongoose at runtime. This avoids an ESM initialization
// edge case when patient-review.ts imports this module while the model module
// is still being evaluated.
const ClinicalSignal = mongoose.models.ClinicalSignal ?? mongoose.model('ClinicalSignal');
import { enqueueOutboxEvent } from './outbox.js';

export type ClinicalSignalSource = 'LAB_INTERPRETATION' | 'ADHERENCE_REVIEW';
export type ClinicalSignalKind = 'URGENT_LAB' | 'ABNORMAL_LAB' | 'LOW_ADHERENCE' | 'REPEATED_MISSED_TASKS';

function signalKey(source: ClinicalSignalSource, sourceId: string, kind: ClinicalSignalKind) {
  return `clinical-signal:${source}:${sourceId}:${kind}`;
}

export async function ensureLabClinicalSignals(input: { organizationId: string; patientId: string; interpretationId: string }) {
  const interpretation = await LabInterpretation.findOne({
    _id: input.interpretationId,
    organizationId: input.organizationId,
    patientId: input.patientId,
    clinicianReviewStatus: { $in: ['APPROVED', 'MODIFIED'] },
  }).lean();
  if (!interpretation) return { created: 0, idempotent: false };

  const kinds: ClinicalSignalKind[] = [];
  if (interpretation.urgentReview) kinds.push('URGENT_LAB');
  if (interpretation.suggestedDiscussionPoints.length > 0) kinds.push('ABNORMAL_LAB');
  let created = 0;

  for (const kind of kinds) {
    const key = signalKey('LAB_INTERPRETATION', String(interpretation._id), kind);
    const existing = await ClinicalSignal.findOne({
      organizationId: input.organizationId,
      signalKey: key,
    }).lean();
    if (existing) continue;

    let createdSignal;
    try {
      createdSignal = await ClinicalSignal.create({
        organizationId: input.organizationId,
        patientId: input.patientId,
        sourceType: 'LAB_INTERPRETATION',
        sourceId: interpretation._id,
        signalKey: key,
        kind,
        priority: kind === 'URGENT_LAB' ? 'HIGH' : 'MEDIUM',
        status: 'OPEN',
        summary: interpretation.clinicianSummary,
        evidence: {
          interpretationId: String(interpretation._id),
          labDocumentId: String(interpretation.labDocumentId),
          suggestedDiscussionPoints: interpretation.suggestedDiscussionPoints,
          confidence: interpretation.confidence,
        },
      });
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000) throw error;
      continue;
    }
    created += 1;
    await enqueueOutboxEvent({
      organizationId: input.organizationId,
      eventKey: `clinical-signal-opened:${key}`,
      eventType: 'CLINICAL_SIGNAL_OPENED',
      aggregateType: 'ClinicalSignal',
      aggregateId: createdSignal._id,
      payload: { organizationId: input.organizationId, patientId: input.patientId, signalKey: key, sourceType: 'LAB_INTERPRETATION', sourceId: String(interpretation._id), kind },
    });
  }
  return { created, idempotent: created === 0 };
}

export async function ensureAdherenceClinicalSignal(input: { organizationId: string; patientId: string; reviewId: string }) {
  const review = await PatientReview.findOne({ _id: input.reviewId, organizationId: input.organizationId, patientId: input.patientId, status: 'COMPLETED' }).lean();
  if (!review?.adherenceSnapshot) return null;
  const snapshot = review.adherenceSnapshot;
  const low = snapshot.totalDueTasks > 0 && snapshot.completionRate < 0.7;
  const missed = snapshot.overdueTasks >= 3;
  if (!low && !missed) return { created: 0, idempotent: false };

  const kind: ClinicalSignalKind = low ? 'LOW_ADHERENCE' : 'REPEATED_MISSED_TASKS';
  const key = signalKey('ADHERENCE_REVIEW', String(review._id), kind);
  const existing = await ClinicalSignal.findOne({ organizationId: input.organizationId, signalKey: key }).lean();
  if (existing) return { signal: existing, created: 0, idempotent: true };

  try {
    const signal = await ClinicalSignal.create({
      organizationId: input.organizationId,
      patientId: input.patientId,
      sourceType: 'ADHERENCE_REVIEW',
      sourceId: review._id,
      signalKey: key,
      kind,
      priority: low ? 'HIGH' : 'MEDIUM',
      status: 'OPEN',
      summary: low ? `Care-plan completion rate is ${Math.round(snapshot.completionRate * 100)}%.` : `${snapshot.overdueTasks} care tasks are overdue.`,
      evidence: { reviewId: String(review._id), completionRate: snapshot.completionRate, overdueTasks: snapshot.overdueTasks, skippedTasks: snapshot.skippedTasks, totalDueTasks: snapshot.totalDueTasks },
    });
    await enqueueOutboxEvent({ organizationId: input.organizationId, eventKey: `clinical-signal-opened:${key}`, eventType: 'CLINICAL_SIGNAL_OPENED', aggregateType: 'ClinicalSignal', aggregateId: signal._id, payload: { organizationId: input.organizationId, patientId: input.patientId, signalKey: key, sourceType: 'ADHERENCE_REVIEW', sourceId: String(review._id), kind } });
    return { signal: signal.toObject(), created: 1, idempotent: false };
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    const signal = await ClinicalSignal.findOne({ organizationId: input.organizationId, signalKey: key }).lean();
    return { signal, created: 0, idempotent: true };
  }
}

export async function reviewClinicalSignal(input: { organizationId: string; signalId: string; clinicianUserId: string; decision: 'ACTION_REQUIRED' | 'DISMISSED' | 'REVIEWED'; notes?: string }) {
  const signal = await ClinicalSignal.findOne({ _id: input.signalId, organizationId: input.organizationId, status: 'OPEN' });
  if (!signal) return null;
  const patient = await Patient.findOne({ _id: signal.patientId, organizationId: input.organizationId, assignedClinicianId: input.clinicianUserId, status: 'ACTIVE' }).select('_id').lean();
  if (!patient) return null;

  if (input.decision !== 'ACTION_REQUIRED') {
    signal.status = input.decision === 'DISMISSED' ? 'DISMISSED' : 'REVIEWED';
    signal.reviewedByUserId = input.clinicianUserId as never;
    signal.reviewedAt = new Date();
    signal.reviewNotes = input.notes;
    await signal.save();
    return { signal: signal.toObject(), task: null };
  }

  const execution = await CarePlanExecution.findOne({ organizationId: input.organizationId, patientId: signal.patientId, status: 'ACTIVE' }).sort({ startDate: -1 }).lean();
  if (!execution) return null;
  const taskKey = `CLINICAL_SIGNAL:${signal._id}`;
  let task = await CareTask.findOne({ executionId: execution._id, taskKey }).lean();
  if (!task) {
    const dueAt = new Date();
    try {
      task = await CareTask.create({
        organizationId: input.organizationId,
        patientId: signal.patientId,
        carePlanId: execution.carePlanId,
        executionId: execution._id,
        taskKey,
        type: 'FOLLOW_UP',
        title: 'Follow up on clinical signal',
        dueAt,
        status: 'PENDING',
      }).then((doc) => doc.toObject());
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000) throw error;
      task = await CareTask.findOne({ executionId: execution._id, taskKey }).lean();
    }
  }

  signal.status = 'ACTION_REQUIRED';
  signal.reviewedByUserId = input.clinicianUserId as never;
  signal.reviewedAt = new Date();
  signal.reviewNotes = input.notes;
  signal.actionTaskId = task?._id;
  await signal.save();
  await enqueueOutboxEvent({ organizationId: input.organizationId, eventKey: `clinical-signal-action:${signal._id}`, eventType: 'CLINICAL_SIGNAL_ACTION_REQUIRED', aggregateType: 'ClinicalSignal', aggregateId: signal._id, payload: { organizationId: input.organizationId, patientId: String(signal.patientId), signalId: String(signal._id), taskId: task ? String(task._id) : undefined } });
  return { signal: signal.toObject(), task };
}

export async function listClinicalSignals(input: { organizationId: string; status?: string; patientId?: string; clinicianUserId?: string; limit?: number }) {
  const query: Record<string, unknown> = { organizationId: input.organizationId };
  if (input.status) query.status = input.status;
  if (input.patientId) query.patientId = input.patientId;
  if (input.clinicianUserId) {
    const patients = await Patient.find({ organizationId: input.organizationId, assignedClinicianId: input.clinicianUserId }).select('_id').lean();
    query.patientId = { $in: patients.map((p) => p._id) };
  }
  return ClinicalSignal.find(query).sort({ priority: -1, createdAt: 1 }).limit(Math.min(input.limit ?? 100, 200)).lean();
}
