import mongoose from 'mongoose';
import { OutboxEvent } from './models.js';
import { createNotificationsForEvent } from './notifications.js';

export const OUTBOX_PROCESSING_LEASE_MS = 60_000;

export async function enqueueOutboxEvent(input: {
  organizationId: string;
  eventKey: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}, session?: mongoose.ClientSession) {
  try {
    const event = await OutboxEvent.findOneAndUpdate(
      { organizationId: input.organizationId, eventKey: input.eventKey },
      {
        $setOnInsert: {
          organizationId: input.organizationId,
          eventKey: input.eventKey,
          eventType: input.eventType,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          payload: input.payload,
          status: 'PENDING',
          attempts: 0,
          availableAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, session },
    ).lean();
    // User-facing notifications are deliberately created only for events mapped by the notification service.
    // Transactional outbox events passed with a session are also safe because notification mappings currently
    // target non-transactional workflow events.
    if (!session) {
      await createNotificationsForEvent({
        eventType: input.eventType,
        eventKey: input.eventKey,
        organizationId: input.organizationId,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        payload: input.payload,
      });
    }
    return event;
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    return OutboxEvent.findOne({ organizationId: input.organizationId, eventKey: input.eventKey }).session(session ?? null).lean();
  }
}

export async function claimOutboxEvent(eventId: string, now = new Date()) {
  const staleBefore = new Date(now.getTime() - OUTBOX_PROCESSING_LEASE_MS);
  return OutboxEvent.findOneAndUpdate(
    {
      _id: eventId,
      $or: [
        { status: 'PENDING', availableAt: { $lte: now } },
        { status: 'PROCESSING', processingStartedAt: { $lte: staleBefore } },
      ],
    },
    {
      $set: { status: 'PROCESSING', processingStartedAt: now },
      $inc: { attempts: 1 },
    },
    { new: true },
  ).lean();
}

export async function markOutboxPublished(eventId: string) {
  return OutboxEvent.updateOne(
    { _id: eventId, status: 'PROCESSING' },
    { $set: { status: 'PUBLISHED', publishedAt: new Date(), processingStartedAt: null, lastError: null } },
  );
}

export async function markOutboxFailed(eventId: string, error: unknown, retryAt: Date) {
  return OutboxEvent.updateOne(
    { _id: eventId, status: 'PROCESSING' },
    {
      $set: {
        status: 'PENDING',
        availableAt: retryAt,
        processingStartedAt: null,
        lastError: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      },
    },
  );
}
