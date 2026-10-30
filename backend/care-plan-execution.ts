import mongoose from 'mongoose';
import { CarePlan, CarePlanExecution, CarePlanMilestone, CareTask } from './models.js';
import { resolveCareProtocol, type ChronicCondition } from './care-protocol.js';
import { enqueueOutboxEvent } from './outbox.js';

export type MilestoneAction = 'COMPLETE' | 'SKIP';

export function milestoneKey(offsetDays: number, key?: string): string {
  return key?.trim() || `DAY_${offsetDays}`;
}

export function buildTaskDefinitionKey(milestone: { key: string; offsetDays: number } | number, type: string, sequence = 1): string {
  // Task identity remains day-based even when the protocol gives a milestone
  // a descriptive key. This preserves the Phase 3.0 logical task contract:
  // DAY_30:OPD_VISIT:1, while milestone.key can evolve independently.
  const day = typeof milestone === 'number' ? milestone : milestone.offsetDays;
  return `DAY_${day}:${type}:${sequence}`;
}

export function getMilestoneDay(startDate: Date, dueAt: Date): number {
  const start = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
  const due = Date.UTC(dueAt.getUTCFullYear(), dueAt.getUTCMonth(), dueAt.getUTCDate());
  return Math.round((due - start) / 86_400_000);
}

export async function ensureCarePlanExecution(
  input: {
    organizationId: string;
    patientId: string;
    carePlanId: string;
  },
  session?: mongoose.ClientSession,
) {
  const plan = await CarePlan.findOne({
    _id: input.carePlanId,
    organizationId: input.organizationId,
    patientId: input.patientId,
    status: 'ACTIVE',
  }).select('_id startDate endDate condition').session(session ?? null).lean();

  if (!plan) return null;

  const existingExecution = await CarePlanExecution.findOne({
    organizationId: input.organizationId,
    patientId: input.patientId,
    carePlanId: input.carePlanId,
  }).select('_id protocolKey protocolVersion').session(session ?? null).lean();

  const protocol = await resolveCareProtocol(
    plan.condition as ChronicCondition,
    existingExecution?.protocolVersion,
  );

  let execution;
  try {
    execution = await CarePlanExecution.findOneAndUpdate(
      { organizationId: input.organizationId, patientId: input.patientId, carePlanId: input.carePlanId },
      {
        $setOnInsert: {
          organizationId: input.organizationId,
          patientId: input.patientId,
          carePlanId: input.carePlanId,
          condition: plan.condition,
          protocolKey: protocol.protocolKey,
          protocolVersion: protocol.version,
          status: 'ACTIVE',
          startDate: plan.startDate,
          endDate: plan.endDate,
          activationKey: `care-plan-execution:${input.carePlanId}`,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, session },
    );
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    execution = await CarePlanExecution.findOne({
      organizationId: input.organizationId,
      patientId: input.patientId,
      carePlanId: input.carePlanId,
    }).session(session ?? null);
  }
  if (!execution) throw new Error('CARE_PLAN_EXECUTION_CREATE_FAILED');

  await enqueueOutboxEvent({
    organizationId: input.organizationId,
    eventKey: `care-plan-activated:${execution._id}`,
    eventType: 'CARE_PLAN_ACTIVATED',
    aggregateType: 'CarePlanExecution',
    aggregateId: String(execution._id),
    payload: { organizationId: input.organizationId, patientId: input.patientId, carePlanId: input.carePlanId, executionId: String(execution._id) },
  }, session);

  if (!execution.protocolKey || !execution.protocolVersion) {
    // Legacy executions created before protocol snapshots existed are upgraded once.
    // After this point the protocol/version is immutable for that execution.
    await CarePlanExecution.updateOne(
      { _id: execution._id, protocolKey: { $exists: false } },
      { $set: { protocolKey: protocol.protocolKey, protocolVersion: protocol.version } },
      { session },
    );
    execution = await CarePlanExecution.findById(execution._id).session(session ?? null);
  }

  if (execution?.protocolKey !== protocol.protocolKey || execution?.protocolVersion !== protocol.version) {
    // Existing executions are immutable snapshots. A new protocol version applies only
    // to a new execution; do not silently rewrite an active patient's schedule.
    throw new Error(`CARE_PLAN_PROTOCOL_SNAPSHOT_MISMATCH:${execution?.protocolKey}:${execution?.protocolVersion}`);
  }

  for (const definition of protocol.milestones) {
    const dueAt = new Date(plan.startDate);
    dueAt.setUTCDate(dueAt.getUTCDate() + definition.offsetDays);
    await CarePlanMilestone.updateOne(
      { executionId: execution._id, key: definition.key },
      {
        $setOnInsert: {
          organizationId: input.organizationId,
          patientId: input.patientId,
          carePlanId: input.carePlanId,
          executionId: execution._id,
          key: definition.key,
          offsetDays: definition.offsetDays,
          day: definition.offsetDays,
          dueAt,
          status: 'PLANNED',
          reviewRequired: Boolean(definition.reviewRequired),
        },
      },
      { upsert: true, session },
    );

    const milestone = await CarePlanMilestone.findOne({ executionId: execution._id, key: definition.key }).session(session ?? null).lean();
    if (!milestone) throw new Error(`CARE_PLAN_MILESTONE_CREATE_FAILED:${definition.key}`);

    await enqueueOutboxEvent({
      organizationId: input.organizationId,
      eventKey: `care-plan-milestone-due:${execution._id}:${milestone._id}`,
      eventType: 'CARE_PLAN_MILESTONE_DUE',
      aggregateType: 'CarePlanMilestone',
      aggregateId: String(milestone._id),
      payload: {
        organizationId: input.organizationId,
        patientId: input.patientId,
        executionId: String(execution._id),
        milestoneId: String(milestone._id),
        milestoneKey: milestone.key,
        offsetDays: milestone.offsetDays,
        day: milestone.offsetDays,
        dueAt: milestone.dueAt.toISOString(),
      },
    }, session);
  }

  return CarePlanExecution.findById(execution._id).session(session ?? null).lean();
}

export async function getCarePlanExecution(input: {
  organizationId: string;
  patientId: string;
  carePlanId: string;
}) {
  const execution = await CarePlanExecution.findOne({
    organizationId: input.organizationId,
    patientId: input.patientId,
    carePlanId: input.carePlanId,
  }).lean();
  if (!execution) return null;

  const [milestones, tasks] = await Promise.all([
    CarePlanMilestone.find({
      organizationId: input.organizationId,
      patientId: input.patientId,
      carePlanId: input.carePlanId,
      executionId: execution._id,
    }).sort({ day: 1 }).lean(),
    CareTask.find({
      organizationId: input.organizationId,
      patientId: input.patientId,
      carePlanId: input.carePlanId,
      executionId: execution._id,
    }).sort({ dueAt: 1, createdAt: 1 }).lean(),
  ]);

  return { execution, milestones, tasks };
}

export async function transitionCarePlanMilestone(input: {
  organizationId: string;
  patientId: string;
  carePlanId: string;
  milestoneId: string;
  action: MilestoneAction;
  actorUserId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const execution = await CarePlanExecution.findOne({
    _id: { $exists: true },
    organizationId: input.organizationId,
    patientId: input.patientId,
    carePlanId: input.carePlanId,
  }).select('_id status').lean();

  if (!execution) return { error: 'CARE_PLAN_EXECUTION_NOT_FOUND' as const };
  if (execution.status !== 'ACTIVE') return { error: 'CARE_PLAN_EXECUTION_NOT_ACTIVE' as const };

  const milestone = await CarePlanMilestone.findOne({
    _id: input.milestoneId,
    organizationId: input.organizationId,
    patientId: input.patientId,
    carePlanId: input.carePlanId,
    executionId: execution._id,
  }).lean();
  if (!milestone) return { error: 'CARE_PLAN_MILESTONE_NOT_FOUND' as const };

  if (input.action === 'COMPLETE' && ['COMPLETED', 'COMPLETED_EARLY'].includes(milestone.status)) {
    return { milestone, idempotent: true as const };
  }
  if (input.action === 'SKIP' && milestone.status === 'SKIPPED') {
    return { milestone, idempotent: true as const };
  }
  if (['CANCELLED'].includes(milestone.status)) return { error: 'CARE_PLAN_MILESTONE_CANCELLED' as const };
  if (['COMPLETED', 'COMPLETED_EARLY'].includes(milestone.status) || milestone.status === 'SKIPPED') {
    return { error: 'CARE_PLAN_MILESTONE_ALREADY_FINAL' as const };
  }

  const nextStatus = input.action === 'SKIP'
    ? 'SKIPPED'
    : (now.getTime() < milestone.dueAt.getTime() ? 'COMPLETED_EARLY' : 'COMPLETED');

  const updated = await CarePlanMilestone.findOneAndUpdate(
    {
      _id: milestone._id,
      organizationId: input.organizationId,
      patientId: input.patientId,
      carePlanId: input.carePlanId,
      executionId: execution._id,
      status: { $in: ['PLANNED', 'DUE'] },
    },
    {
      $set: {
        status: nextStatus,
        completedAt: now,
        completedByUserId: input.actorUserId,
      },
    },
    { new: true },
  ).lean();

  if (!updated) {
    const current = await CarePlanMilestone.findById(milestone._id).lean();
    if (current && ((input.action === 'COMPLETE' && ['COMPLETED', 'COMPLETED_EARLY'].includes(current.status)) || (input.action === 'SKIP' && current.status === 'SKIPPED'))) {
      return { milestone: current, idempotent: true as const };
    }
    return { error: 'CARE_PLAN_MILESTONE_TRANSITION_CONFLICT' as const };
  }

  return { milestone: updated, idempotent: false as const };
}

export async function attachCarePlanTasksToExecution(
  input: {
    organizationId: string;
    patientId: string;
    carePlanId: string;
    tasks: Array<{ _id: mongoose.Types.ObjectId; type: string; title: string; dueAt: Date; taskKey?: string | null }>;
  },
  session?: mongoose.ClientSession,
) {
  const execution = await CarePlanExecution.findOne({
    organizationId: input.organizationId,
    patientId: input.patientId,
    carePlanId: input.carePlanId,
  }).session(session ?? null).lean();
  if (!execution) throw new Error('CARE_PLAN_EXECUTION_NOT_FOUND');

  const sequenceByDefinition = new Map<string, number>();
  for (const task of input.tasks) {
    const day = getMilestoneDay(execution.startDate, task.dueAt);
    const milestone = await CarePlanMilestone.findOne({ executionId: execution._id, offsetDays: day }).sort({ offsetDays: 1, createdAt: 1 }).session(session ?? null).lean();
    if (!milestone || day === null) {
      await CareTask.updateOne(
        { _id: task._id, organizationId: input.organizationId, patientId: input.patientId, carePlanId: input.carePlanId },
        { $set: { executionId: execution._id, milestoneId: undefined } },
        { session },
      );
      continue;
    }

    const definitionPrefix = `${milestone.key}:${task.type}`;
    const sequence = (sequenceByDefinition.get(definitionPrefix) ?? 0) + 1;
    sequenceByDefinition.set(definitionPrefix, sequence);
    const stableTaskKey = task.taskKey?.trim() || buildTaskDefinitionKey({ key: milestone.key, offsetDays: milestone.offsetDays }, task.type, sequence);

    await CareTask.updateOne(
      { _id: task._id, organizationId: input.organizationId, patientId: input.patientId, carePlanId: input.carePlanId },
      {
        $set: {
          executionId: execution._id,
          milestoneId: milestone._id,
          taskKey: stableTaskKey,
        },
      },
      { session },
    );
  }
}
