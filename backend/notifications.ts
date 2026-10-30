import { Notification, Patient, User } from './models.js';
import { emitNotification, emitNotificationRead, emitAllNotificationsRead } from './socket.js';

type NotificationEvent = {
  eventType: string;
  eventKey: string;
  organizationId: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
};

type NotificationTemplate = { title: string; body: string; href?: string; priority?: 'HIGH'|'MEDIUM'|'LOW'; roles?: string[]; recipientUserIds?: string[] };

function patientLabel(payload: Record<string, unknown>): string {
  return String(payload.patientName ?? 'Patient');
}

async function resolveRecipients(event: NotificationEvent): Promise<{ userId: string; template: NotificationTemplate }[]> {
  const p = event.payload;
  const patientName = patientLabel(p);
  const common = { roles: undefined as string[] | undefined };
  switch (event.eventType) {
    case 'PATIENT_REFERRAL_CREATED':
      return (await User.find({ organizationId: event.organizationId, status: 'ACTIVE', roles: 'CLINIC_COORDINATOR' }).select('_id').lean())
        .map((u) => ({ userId: String(u._id), template: { ...common, title: 'New patient ready for enrollment', body: `${patientName} was referred by the clinician and is waiting for coordinator enrollment.`, href: '/care-queue', priority: 'HIGH' as const } }));
    case 'PRESCRIPTION_UPLOADED':
      return p.clinicianId ? [{ userId: String(p.clinicianId), template: { title: 'Prescription uploaded', body: `${patientName}'s prescription is ready for OCR review and clinical verification.`, href: `/patients/${String(p.patientId)}`, priority: 'HIGH' } }] : [];
    case 'PRESCRIPTION_OCR_COMPLETED':
      return p.clinicianId ? [{ userId: String(p.clinicianId), template: { title: p.clinicalReviewRequired ? 'Prescription needs clinical review' : 'Prescription OCR completed', body: p.clinicalReviewRequired ? `${patientName}'s prescription requires clinical verification.` : `${patientName}'s prescription has been extracted and is ready for clinical verification.`, href: '/clinical-inbox', priority: 'HIGH' } }] : [];
    case 'CLINICAL_REVIEW_OPENED':
      return p.clinicianId ? [{ userId: String(p.clinicianId), template: { title: 'Clinical review required', body: `${patientName}'s prescription needs clinician review.`, href: '/clinical-inbox', priority: 'HIGH' } }] : [];
    case 'CLINICAL_REVIEW_DECIDED':
      return (await User.find({ organizationId: event.organizationId, status: 'ACTIVE', roles: 'CLINIC_COORDINATOR' }).select('_id').lean())
        .map((u) => ({ userId: String(u._id), template: { title: 'Prescription verification updated', body: `${patientName}'s clinician review is now ${String(p.decision ?? 'updated').toLowerCase()}.`, href: `/patients/${String(p.patientId)}`, priority: 'MEDIUM' as const } }));
    case 'PATIENT_REVIEW_READY':
      return (await User.find({ organizationId: event.organizationId, status: 'ACTIVE', roles: 'CLINIC_COORDINATOR' }).select('_id').lean())
        .map((u) => ({ userId: String(u._id), template: { title: 'Patient review due', body: `${patientName} has a care-plan review ready for coordinator follow-up.`, href: '/reviews', priority: 'HIGH' } }));
    case 'CLINICAL_SIGNAL_ACTION_REQUIRED': {
      const patient = await Patient.findOne({ _id: String(p.patientId), organizationId: event.organizationId }).select('assignedClinicianId').lean();
      return patient?.assignedClinicianId ? [{ userId: String(patient.assignedClinicianId), template: { title: 'Clinical action required', body: `${patientName} has a clinical signal requiring review.`, href: '/clinical-inbox', priority: 'HIGH' } }] : [];
    }
    case 'COORDINATOR_ESCALATION_OPENED':
      return (await User.find({ organizationId: event.organizationId, status: 'ACTIVE', roles: 'CLINIC_COORDINATOR' }).select('_id').lean())
        .map((u) => ({ userId: String(u._id), template: { title: 'Coordinator escalation opened', body: `${patientName} has an operational escalation requiring attention.`, href: '/care-queue', priority: 'HIGH' } }));
    case 'CARE_TASK_DUE':
      return (await User.find({ organizationId: event.organizationId, status: 'ACTIVE', roles: 'CLINIC_COORDINATOR' }).select('_id').lean())
        .map((u) => ({ userId: String(u._id), template: { title: 'Care task due', body: `${patientName} has a care task due.`, href: '/care-queue', priority: 'MEDIUM' } }));
    default:
      return [];
  }
}

export async function createNotificationsForEvent(event: NotificationEvent): Promise<void> {
  const recipients = await resolveRecipients(event);
  for (const recipient of recipients) {
    const t = recipient.template;
    const notificationKey = `${event.eventKey}:user:${recipient.userId}`;
    try {
      const notification = await Notification.findOneAndUpdate(
        { notificationKey },
        { $setOnInsert: { notificationKey, organizationId: event.organizationId, recipientUserId: recipient.userId, eventType: event.eventType, title: t.title, body: t.body, href: t.href, priority: t.priority ?? 'MEDIUM', aggregateType: event.aggregateType, aggregateId: event.aggregateId, payload: event.payload } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
      if (notification) emitNotification(recipient.userId, notification as unknown as Record<string, unknown>);
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000) throw error;
    }
  }
}

export async function listNotifications(input: { organizationId: string; recipientUserId: string; unreadOnly?: boolean; limit?: number }) {
  const filter = { organizationId: input.organizationId, recipientUserId: input.recipientUserId, ...(input.unreadOnly ? { readAt: null } : {}) };
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const [items, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
    Notification.countDocuments({ organizationId: input.organizationId, recipientUserId: input.recipientUserId, readAt: null }),
  ]);
  return { items, unreadCount };
}

export async function markNotificationRead(input: { organizationId: string; recipientUserId: string; notificationId: string }) {
  const notification = await Notification.findOneAndUpdate({ _id: input.notificationId, organizationId: input.organizationId, recipientUserId: input.recipientUserId, readAt: null }, { $set: { readAt: new Date() } }, { new: true }).lean();
  if (notification) emitNotificationRead(input.recipientUserId, String(notification._id));
  return notification;
}

export async function markAllNotificationsRead(input: { organizationId: string; recipientUserId: string }) {
  const result = await Notification.updateMany({ organizationId: input.organizationId, recipientUserId: input.recipientUserId, readAt: null }, { $set: { readAt: new Date() } });
  if (result.modifiedCount > 0) emitAllNotificationsRead(input.recipientUserId);
  return result.modifiedCount;
}
