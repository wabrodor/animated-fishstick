import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApexCareEnrollment, LabDocument, Organization, OutboxEvent, Patient, User } from '../models.js';
import { createLabDocument } from '../lab-document.js';
import { processLabDocumentExtraction, extractPdfText } from '../lab-pdf-extraction.js';

let mongo: MongoMemoryServer;
let organizationId: mongoose.Types.ObjectId;
let apexcareOrganizationId: mongoose.Types.ObjectId;
let patientId: mongoose.Types.ObjectId;
let userId: mongoose.Types.ObjectId;

function pdfWithText(text: string) {
  const stream = `BT\n/F1 12 Tf\n(${text.replace(/[()\\]/g, '\\$&')}) Tj\nET`;
  return Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n%%EOF`, 'latin1');
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Organization.init(), User.init(), Patient.init(), ApexCareEnrollment.init(), LabDocument.init(), OutboxEvent.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([Organization.deleteMany({}), User.deleteMany({}), Patient.deleteMany({}), ApexCareEnrollment.deleteMany({}), LabDocument.deleteMany({}), OutboxEvent.deleteMany({})]);
  const clinic = await Organization.create({ name: 'Lab Clinic', type: 'CLINIC' });
  const apex = await Organization.create({ name: 'ApexCare', type: 'APEXCARE' });
  organizationId = clinic._id;
  apexcareOrganizationId = apex._id;
  const user = await User.create({ organizationId, name: 'Clinician', email: `lab2-${Date.now()}@example.com`, passwordHash: 'x', roles: ['CLINICIAN'] });
  userId = user._id;
  const patient = await Patient.create({ organizationId, medicalRecordNumber: `LAB2-${Date.now()}`, name: { first: 'Lab', last: 'Patient' }, assignedClinicianId: user._id, preferredLanguage: 'ml', preferredContactChannel: 'WHATSAPP', enrollmentStatus: 'ACTIVE_CARE' });
  patientId = patient._id;
  await ApexCareEnrollment.create({ patientId, clinicOrganizationId: organizationId, apexcareOrganizationId, status: 'ACTIVE', enrolledAt: new Date() });
});

describe('Phase 3D.2 lab PDF text extraction', () => {
  it('extracts deterministic text from a text-based PDF', () => {
    expect(extractPdfText(pdfWithText('HbA1c 7.8 percent'))).toContain('HbA1c 7.8 percent');
  });

  it('processes a queued document exactly once', async () => {
    const created = await createLabDocument({ clinicOrganizationId: String(organizationId), apexcareOrganizationId: String(apexcareOrganizationId), patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'cbc.pdf', idempotencyKey: 'extract-1', buffer: pdfWithText('HbA1c 7.8 percent') });
    await LabDocument.updateOne({ _id: created.document._id }, { $set: { extractionStatus: 'QUEUED' } });
    const first = await processLabDocumentExtraction(String(created.document._id));
    const second = await processLabDocumentExtraction(String(created.document._id));
    expect(first.processed).toBe(true);
    expect(second.idempotent).toBe(true);
    const document = await LabDocument.findById(created.document._id).lean();
    expect(document?.extractionStatus).toBe('COMPLETED');
    expect(document?.status).toBe('EXTRACTED');
    expect(document?.extractedText).toContain('HbA1c 7.8 percent');
    expect(document?.extractionVersion).toBe(1);
  });

  it('fails safely for image-only/unextractable PDFs and records the reason', async () => {
    const created = await createLabDocument({ clinicOrganizationId: String(organizationId), apexcareOrganizationId: String(apexcareOrganizationId), patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'scan.pdf', idempotencyKey: 'extract-fail', buffer: Buffer.from('%PDF-1.7\n%%EOF') });
    await LabDocument.updateOne({ _id: created.document._id }, { $set: { extractionStatus: 'QUEUED' } });
    await expect(processLabDocumentExtraction(String(created.document._id))).rejects.toThrow('LAB_PDF_NO_TEXT_CONTENT');
    const document = await LabDocument.findById(created.document._id).lean();
    expect(document?.extractionStatus).toBe('FAILED');
    expect(document?.status).toBe('FAILED');
  });

  it('does not allow a concurrent second processor to claim the same document', async () => {
    const created = await createLabDocument({ clinicOrganizationId: String(organizationId), apexcareOrganizationId: String(apexcareOrganizationId), patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'concurrent.pdf', idempotencyKey: 'extract-concurrent', buffer: pdfWithText('Creatinine 0.9 mg/dL') });
    await LabDocument.updateOne({ _id: created.document._id }, { $set: { extractionStatus: 'QUEUED' } });
    const [a, b] = await Promise.all([processLabDocumentExtraction(String(created.document._id)), processLabDocumentExtraction(String(created.document._id))]);
    expect([a.processed, b.processed].filter(Boolean)).toHaveLength(1);
    expect([a.idempotent, b.idempotent].filter(Boolean)).toHaveLength(1);
    expect(await LabDocument.countDocuments({ _id: created.document._id })).toBe(1);
  });
});
