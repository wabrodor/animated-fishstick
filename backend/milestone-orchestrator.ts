import { CarePlan, CarePlanDraft, CarePlanExecution, CarePlanMilestone, CareTask } from './models.js';
import { buildTaskDefinitionKey } from './care-plan-execution.js';
import { enqueueOutboxEvent } from './outbox.js';
import { ensurePatientReviewForMilestone } from './patient-review.js';

export type ProcessMilestoneInput = {
  organizationId: string;
  patientId: string;
  executionId: string;
  milestoneId: string;
  now?: Date;
};

export type ProcessMilestoneResult = {
  processed: boolean;
  milestoneStatus?: string;
  createdTaskIds: string[];
  overdueTaskIds: string[];
  reason?: string;
};

/**
 * Phase 3A.2 orchestration boundary.
 *
 * The worker never trusts the BullMQ payload as current truth. It revalidates
 * tenant, execution, patient, milestone and care-plan state before mutating anything.
 * Every task creation and outbox emission is keyed deterministically so a retry is safe.
 */
export async function processCarePlanMilestone(input: ProcessMilestoneInput): Promise<ProcessMilestoneResult> {
  const now = input.now ?? new Date();
  const createdTaskIds: string[] = [];
  const overdueTaskIds: string[] = [];

  const execution = await CarePlanExecution.findOne({
    _id: input.executionId,
    organizationId: input.organizationId,
    patientId: input.patientId,
    status: 'ACTIVE',
  }).lean();

  if (!execution) return { processed: false, createdTaskIds, overdueTaskIds, reason: 'EXECUTION_NOT_ACTIVE' };

  const plan = await CarePlan.findOne({
    _id: execution.carePlanId,
    organizationId: input.organizationId,
    patientId: input.patientId,
    status: 'ACTIVE',
  }).lean();

  if (!plan) return { processed: false, createdTaskIds, overdueTaskIds, reason: 'CARE_PLAN_NOT_ACTIVE' };

  const milestone = await CarePlanMilestone.findOne({
    _id: input.milestoneId,
    organizationId: input.organizationId,
    patientId: input.patientId,
    carePlanId: execution.carePlanId,
    executionId: execution._id,
  }).lean();

  if (!milestone) return { processed: false, createdTaskIds, overdueTaskIds, reason: 'MILESTONE_NOT_FOUND' };
  if (milestone.dueAt.getTime() > now.getTime()) {
    return { processed: false, milestoneStatus: milestone.status, createdTaskIds, overdueTaskIds, reason: 'MILESTONE_NOT_DUE' };
  }
  if (['COMPLETED', 'COMPLETED_EARLY', 'SKIPPED', 'CANCELLED'].includes(milestone.status)) {
    return { processed: false, milestoneStatus: milestone.status, createdTaskIds, overdueTaskIds, reason: 'MILESTONE_FINAL' };
  }

  // Only one concurrent worker may move PLANNED -> DUE. A retry that sees DUE
  // continues safely to the task materialisation step.
  await CarePlanMilestone.updateOne(
    {
      _id: milestone._id,
      organizationId: input.organizationId,
      patientId: input.patientId,
      executionId: execution._id,
      status: 'PLANNED',
      dueAt: { $lte: now },
    },
    { $set: { status: 'DUE' } },
  );

  const currentMilestone = await CarePlanMilestone.findOne({
    _id: milestone._id,
    organizationId: input.organizationId,
    patientId: input.patientId,
    executionId: execution._id,
  }).lean();
  if (!currentMilestone || !['DUE'].includes(currentMilestone.status)) {
    return { processed: false, milestoneStatus: currentMilestone?.status, createdTaskIds, overdueTaskIds, reason: 'MILESTONE_NO_LONGER_DUE' };
  }

  await ensurePatientReviewForMilestone({
    organizationId: input.organizationId,
    patientId: input.patientId,
    executionId: String(execution._id),
    milestoneId: String(currentMilestone._id),
  });

  // Approved drafts remain immutable historical task-definition snapshots. Reuse
  // them as the source of truth so the orchestrator can materialise only the tasks
  // that belong to this milestone when they become due.
  const approvedDraft = await CarePlanDraft.findOne({
    organizationId: input.organizationId,
    patientId: input.patientId,
    condition: plan.condition,
    status: 'APPROVED',
  }).sort({ approvedAt: -1, createdAt: -1 }).lean();

  const definitions = approvedDraft?.plan?.tasks?.filter((task) => {
    const dueDay = Number(task.dueDay);
    return dueDay === currentMilestone.offsetDays;
  }) ?? [];

  const sequenceByType = new Map<string, number>();
  for (const definition of definitions) {
    const sequence = (sequenceByType.get(definition.type) ?? 0) + 1;
    sequenceByType.set(definition.type, sequence);
    const taskKey = buildTaskDefinitionKey(currentMilestone.offsetDays, definition.type, sequence);
    const dueAt = new Date(execution.startDate);
    dueAt.setUTCDate(dueAt.getUTCDate() + currentMilestone.offsetDays);

    const task = await CareTask.findOneAndUpdate(
      {
        organizationId: input.organizationId,
        patientId: input.patientId,
        carePlanId: execution.carePlanId,
        executionId: execution._id,
        taskKey,
      },
      {
        $setOnInsert: {
          organizationId: input.organizationId,
          patientId: input.patientId,
          carePlanId: execution.carePlanId,
          executionId: execution._id,
          milestoneId: currentMilestone._id,
          taskKey,
          type: definition.type,
          title: definition.title,
          dueAt,
          status: 'PENDING',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();

    if (task) {
      createdTaskIds.push(String(task._id));
      await enqueueOutboxEvent({
        organizationId: input.organizationId,
        eventKey: `care-task-due:${task._id}`,
        eventType: 'CARE_TASK_DUE',
        aggregateType: 'CareTask',
        aggregateId: String(task._id),
        payload: {
          organizationId: input.organizationId,
          patientId: input.patientId,
          executionId: String(execution._id),
          milestoneId: String(currentMilestone._id),
          taskId: String(task._id),
          dueAt: task.dueAt.toISOString(),
        },
      });
    }
  }

  // Revalidate by tenant + execution. Only pending tasks that have actually
  // crossed their due time become OVERDUE. Future tasks are untouched.
  const overdue = await CareTask.find({
    organizationId: input.organizationId,
    patientId: input.patientId,
    executionId: execution._id,
    status: 'PENDING',
    dueAt: { $lt: now },
  }).select('_id').lean();
  if (overdue.length) {
    await CareTask.updateMany(
      { _id: { $in: overdue.map((task) => task._id) }, organizationId: input.organizationId, patientId: input.patientId, executionId: execution._id, status: 'PENDING', dueAt: { $lt: now } },
      { $set: { status: 'OVERDUE' } },
    );
    overdueTaskIds.push(...overdue.map((task) => String(task._id)));
  }

  return {
    processed: true,
    milestoneStatus: currentMilestone.status,
    createdTaskIds: [...new Set(createdTaskIds)],
    overdueTaskIds,
  };
}
