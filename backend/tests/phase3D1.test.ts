import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApexCareEnrollment, LabDocument, Organization, OutboxEvent, Patient, User } from '../models.js';
import { createLabDocument } from '../lab-document.js';

let mongo: MongoMemoryServer;
let organizationId: mongoose.Types.ObjectId;
let apexcareOrganizationId: mongoose.Types.ObjectId;
let patientId: mongoose.Types.ObjectId;
let userId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([
    Organization.init(), User.init(), Patient.init(), ApexCareEnrollment.init(), LabDocument.init(), OutboxEvent.init(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    Organization.deleteMany({}), User.deleteMany({}), Patient.deleteMany({}),
    ApexCareEnrollment.deleteMany({}), LabDocument.deleteMany({}), OutboxEvent.deleteMany({}),
  ]);
  const clinic = await Organization.create({ name: 'Lab Clinic', type: 'CLINIC' });
  const apex = await Organization.create({ name: 'ApexCare', type: 'APEXCARE' });
  organizationId = clinic._id;
  apexcareOrganizationId = apex._id;
  const user = await User.create({ organizationId, name: 'Clinician', email: `lab-${Date.now()}@example.com`, passwordHash: 'x', roles: ['CLINICIAN'] });
  userId = user._id;
  const patient = await Patient.create({
    organizationId,
    medicalRecordNumber: `LAB-${Date.now()}`,
    name: { first: 'Lab', last: 'Patient' },
    assignedClinicianId: user._id,
    preferredLanguage: 'ml',
    preferredContactChannel: 'WHATSAPP',
    enrollmentStatus: 'ACTIVE_CARE',
  });
  patientId = patient._id;
  await ApexCareEnrollment.create({ patientId, clinicOrganizationId: organizationId, apexcareOrganizationId, status: 'ACTIVE', enrolledAt: new Date() });
});

const pdf = (text = 'lab report') => Buffer.from(`%PDF-1.7\n${text}\n%%EOF`);

describe('Phase 3D.1 lab PDF ingestion', () => {
  it('creates one lab document and one outbox event', async () => {
    const first = await createLabDocument({
      clinicOrganizationId: String(organizationId), apexcareOrganizationId: String(apexcareOrganizationId),
      patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'cbc.pdf', idempotencyKey: 'lab-1', buffer: pdf('cbc'),
    });
    expect(first.idempotent).toBe(false);
    expect(first.document.mimeType).toBe('application/pdf');
    expect(first.document.status).toBe('UPLOADED');
    expect(first.document.storageProvider).toMatch(/^(local|s3)$/);
    expect(first.document.storageKey).not.toContain(String(organizationId));
    expect(first.document.storageKey).not.toContain(String(patientId));
    expect(first.document.processingStage).toBe('QUEUED');
    expect(await LabDocument.countDocuments({ clinicOrganizationId: organizationId, patientId })).toBe(1);
    expect(await OutboxEvent.countDocuments({ organizationId, eventType: 'LAB_DOCUMENT_UPLOADED' })).toBe(1);
  });

  it('returns the same document for an idempotent retry', async () => {
    const input = {
      clinicOrganizationId: String(organizationId), apexcareOrganizationId: String(apexcareOrganizationId),
      patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'cbc.pdf', idempotencyKey: 'lab-retry', buffer: pdf('cbc'),
    };
    const first = await createLabDocument(input);
    const second = await createLabDocument(input);
    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(String(first.document._id)).toBe(String(second.document._id));
    expect(await LabDocument.countDocuments({ patientId })).toBe(1);
    expect(await OutboxEvent.countDocuments({ organizationId, eventType: 'LAB_DOCUMENT_UPLOADED' })).toBe(1);
  });

  it('deduplicates the same PDF even with a different idempotency key', async () => {
    const base = { clinicOrganizationId: String(organizationId), apexcareOrganizationId: String(apexcareOrganizationId), patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'same.pdf', buffer: pdf('same') };
    const first = await createLabDocument({ ...base, idempotencyKey: 'one' });
    const second = await createLabDocument({ ...base, idempotencyKey: 'two' });
    expect(second.idempotent).toBe(true);
    expect(String(first.document._id)).toBe(String(second.document._id));
  });

  it('rejects reuse of an idempotency key for different content', async () => {
    await createLabDocument({ clinicOrganizationId: String(organizationId), apexcareOrganizationId: String(apexcareOrganizationId), patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'a.pdf', idempotencyKey: 'same-key', buffer: pdf('a') });
    await expect(createLabDocument({ clinicOrganizationId: String(organizationId), apexcareOrganizationId: String(apexcareOrganizationId), patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'b.pdf', idempotencyKey: 'same-key', buffer: pdf('b') })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSE' });
  });

  it('rejects a non-PDF payload before persistence', async () => {
    await expect(createLabDocument({ clinicOrganizationId: String(organizationId), apexcareOrganizationId: String(apexcareOrganizationId), patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'bad.pdf', idempotencyKey: 'bad', buffer: Buffer.from('not pdf') })).rejects.toThrow(/PDF/);
    expect(await LabDocument.countDocuments()).toBe(0);
  });

  it('keeps tenant isolation in the document identity', async () => {
    const foreign = await Organization.create({ name: 'Foreign', type: 'CLINIC' });
    const result = await createLabDocument({ clinicOrganizationId: String(foreign._id), apexcareOrganizationId: String(apexcareOrganizationId), patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'foreign.pdf', idempotencyKey: 'foreign', buffer: pdf('foreign') });
    expect(result.document.clinicOrganizationId.toString()).toBe(String(foreign._id));
  });
});
