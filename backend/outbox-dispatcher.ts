import { LabDocument, OutboxEvent } from './models.js';
import { scheduleCarePlanMilestone, scheduleCareTaskReminder, scheduleLabDocumentExtraction, scheduleLabResultStructuring, scheduleLabInterpretation } from './queues.js';
import { claimOutboxEvent, markOutboxFailed, markOutboxPublished, OUTBOX_PROCESSING_LEASE_MS } from './outbox.js';
import { createCarePlanActivationCommunication } from './patient-communication.js';

export async function dispatchOutboxEvent(event: { eventType: string; payload: Record<string, unknown> }): Promise<string> {
  if (event.eventType === 'CARE_PLAN_ACTIVATED') {
    const result = await createCarePlanActivationCommunication({ organizationId: String(event.payload.organizationId), patientId: String(event.payload.patientId), carePlanId: String(event.payload.carePlanId) });
    return result ? String(result.communication._id) : 'NO_COMMUNICATION';
  }

  if (event.eventType === 'CARE_TASK_DUE') {
    const payload = event.payload;
    await scheduleCareTaskReminder(String(payload.taskId), new Date(String(payload.dueAt)), { organizationId: String(payload.organizationId), patientId: String(payload.patientId) });
    return String(payload.taskId);
  }

  if (event.eventType === 'LAB_DOCUMENT_UPLOADED') {
    const payload = event.payload;
    const documentId = String(payload.documentId);
    const claimedForQueue = await LabDocument.updateOne(
      {
        _id: documentId,
        clinicOrganizationId: String(payload.clinicOrganizationId),
        patientId: String(payload.patientId),
        extractionStatus: 'NOT_STARTED',
      },
      { $set: { extractionStatus: 'QUEUED' } },
    );
    if (claimedForQueue.matchedCount === 0) {
      const current = await LabDocument.findOne({ _id: documentId, clinicOrganizationId: String(payload.clinicOrganizationId), patientId: String(payload.patientId) }).select('extractionStatus').lean();
      if (!current) throw new Error('LAB_DOCUMENT_NOT_FOUND_FOR_EXTRACTION');
      if (current.extractionStatus === 'COMPLETED') return documentId;
    }
    return scheduleLabDocumentExtraction({
      documentId,
      organizationId: String(payload.clinicOrganizationId),
      patientId: String(payload.patientId),
      apexcareOrganizationId: String(payload.apexcareOrganizationId),
    });
  }

  if (event.eventType === 'LAB_DOCUMENT_EXTRACTED') {
    const payload = event.payload;
    const documentId = String(payload.documentId);
    const document = await LabDocument.findOne({ _id: documentId, clinicOrganizationId: String(payload.clinicOrganizationId), patientId: String(payload.patientId), extractionStatus: 'COMPLETED' }).select('structuringStatus').lean();
    if (!document) throw new Error('LAB_DOCUMENT_NOT_READY_FOR_STRUCTURING');
    if (document.structuringStatus === 'COMPLETED') return documentId;
    return scheduleLabResultStructuring({
      documentId,
      organizationId: String(payload.clinicOrganizationId),
      patientId: String(payload.patientId),
      apexcareOrganizationId: String(payload.apexcareOrganizationId),
    });
  }

  if (event.eventType === 'LAB_RESULTS_STRUCTURED') {
    const payload = event.payload;
    const documentId = String(payload.documentId);
    const document = await LabDocument.findOne({ _id: documentId, clinicOrganizationId: String(payload.clinicOrganizationId), patientId: String(payload.patientId), extractionStatus: 'COMPLETED', structuringStatus: 'COMPLETED' }).select('interpretationStatus').lean();
    if (!document) throw new Error('LAB_DOCUMENT_NOT_READY_FOR_INTERPRETATION');
    if (document.interpretationStatus === 'COMPLETED') return documentId;
    return scheduleLabInterpretation({
      documentId,
      organizationId: String(payload.clinicOrganizationId),
      patientId: String(payload.patientId),
      apexcareOrganizationId: String(payload.apexcareOrganizationId),
    });
  }

  if (event.eventType === 'CLINICAL_SIGNAL_OPENED' || event.eventType === 'CLINICAL_SIGNAL_ACTION_REQUIRED') {
    return String(event.payload.signalId ?? event.payload.sourceId ?? event.payload.signalKey ?? 'CLINICAL_SIGNAL');
  }

  if (event.eventType === 'CARE_PLAN_MILESTONE_DUE') {
    const payload = event.payload;
    return scheduleCarePlanMilestone({
      organizationId: String(payload.organizationId),
      patientId: String(payload.patientId),
      executionId: String(payload.executionId),
      milestoneId: String(payload.milestoneId),
      day: Number(payload.day),
      offsetDays: Number(payload.offsetDays ?? payload.day),
      milestoneKey: String(payload.milestoneKey ?? `DAY_${payload.day}`),
      dueAt: new Date(String(payload.dueAt)),
    });
  }

  throw new Error(`OUTBOX_EVENT_TYPE_UNSUPPORTED:${event.eventType}`);
}

export async function processOutboxBatch(limit = 50, now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - OUTBOX_PROCESSING_LEASE_MS);
  const candidates = await OutboxEvent.find({
    $or: [
      { status: 'PENDING', availableAt: { $lte: now } },
      { status: 'PROCESSING', processingStartedAt: { $lte: staleBefore } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select('_id')
    .lean();

  let processed = 0;
  for (const candidate of candidates) {
    const event = await claimOutboxEvent(String(candidate._id), now);
    if (!event) continue;

    try {
      await dispatchOutboxEvent({ eventType: event.eventType, payload: event.payload as Record<string, unknown> });
      await markOutboxPublished(String(event._id));
      processed += 1;
    } catch (error) {
      const retryAt = new Date(now.getTime() + Math.min(60_000, 1_000 * 2 ** Math.min(event.attempts, 6)));
      await markOutboxFailed(String(event._id), error, retryAt);
    }
  }

  return processed;
}
