import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApexCareEnrollment, LabDocument, LabResult, Organization, OutboxEvent, Patient, User } from '../models.js';
import { createLabDocument } from '../lab-document.js';
import { processLabDocumentExtraction } from '../lab-pdf-extraction.js';
import { parseStructuredLabResults, processLabResultStructuring } from '../lab-result-structuring.js';

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
  await Promise.all([Organization.init(), User.init(), Patient.init(), ApexCareEnrollment.init(), LabDocument.init(), LabResult.init(), OutboxEvent.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([Organization.deleteMany({}), User.deleteMany({}), Patient.deleteMany({}), ApexCareEnrollment.deleteMany({}), LabDocument.deleteMany({}), LabResult.deleteMany({}), OutboxEvent.deleteMany({})]);
  const clinic = await Organization.create({ name: 'Structured Lab Clinic', type: 'CLINIC' });
  const apex = await Organization.create({ name: 'ApexCare', type: 'APEXCARE' });
  organizationId = clinic._id;
  apexcareOrganizationId = apex._id;
  const user = await User.create({ organizationId, name: 'Clinician', email: `lab3-${Date.now()}@example.com`, passwordHash: 'x', roles: ['CLINICIAN'] });
  userId = user._id;
  const patient = await Patient.create({ organizationId, medicalRecordNumber: `LAB3-${Date.now()}`, name: { first: 'Structured', last: 'Patient' }, assignedClinicianId: user._id, preferredLanguage: 'ml', preferredContactChannel: 'WHATSAPP', enrollmentStatus: 'ACTIVE_CARE' });
  patientId = patient._id;
  await ApexCareEnrollment.create({ patientId, clinicOrganizationId: organizationId, apexcareOrganizationId, status: 'ACTIVE', enrolledAt: new Date() });
});

describe('Phase 3D.3 structured laboratory results', () => {
  it('parses supported lab lines deterministically without AI', () => {
    const results = parseStructuredLabResults('HbA1c: 7.8 % 4.0-5.6 HIGH\nCreatinine: 0.9 mg/dL 0.6-1.2');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ normalizedTestName: 'HBA1C', valueNumber: 7.8, unit: '%', referenceLow: 4, referenceHigh: 5.6, abnormalFlag: 'HIGH' });
    expect(results[1]).toMatchObject({ normalizedTestName: 'CREATININE', valueNumber: 0.9, unit: 'mg/dL', abnormalFlag: 'NORMAL' });
  });

  it('creates one structured result set idempotently', async () => {
    const created = await createLabDocument({ clinicOrganizationId: String(organizationId), apexcareOrganizationId: String(apexcareOrganizationId), patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'report.pdf', idempotencyKey: 'd3-1', buffer: pdfWithText('HbA1c: 7.8 % 4.0-5.6 HIGH\nCreatinine: 0.9 mg/dL 0.6-1.2') });
    await processLabDocumentExtraction(String(created.document._id));
    const first = await processLabResultStructuring(String(created.document._id));
    const second = await processLabResultStructuring(String(created.document._id));
    expect(first.processed).toBe(true);
    expect(second.idempotent).toBe(true);
    expect(await LabResult.countDocuments({ labDocumentId: created.document._id })).toBe(2);
    const document = await LabDocument.findById(created.document._id).lean();
    expect(document?.structuringStatus).toBe('COMPLETED');
    expect(document?.structuredResultCount).toBe(2);
  });

  it('does not create results for unrelated prose', async () => {
    const created = await createLabDocument({ clinicOrganizationId: String(organizationId), apexcareOrganizationId: String(apexcareOrganizationId), patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'prose.pdf', idempotencyKey: 'd3-2', buffer: pdfWithText('Patient attended clinic today and reports feeling well.') });
    await processLabDocumentExtraction(String(created.document._id));
    await expect(processLabResultStructuring(String(created.document._id))).rejects.toThrow('LAB_NO_STRUCTURED_RESULTS');
    expect(await LabResult.countDocuments({ labDocumentId: created.document._id })).toBe(0);
    const document = await LabDocument.findById(created.document._id).lean();
    expect(document?.structuringStatus).toBe('FAILED');
  });

  it('keeps results tenant scoped', async () => {
    const otherOrg = await Organization.create({ name: 'Other Clinic', type: 'CLINIC' });
    const created = await createLabDocument({ clinicOrganizationId: String(organizationId), apexcareOrganizationId: String(apexcareOrganizationId), patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'secure.pdf', idempotencyKey: 'd3-3', buffer: pdfWithText('LDL: 142 mg/dL 0-100 HIGH') });
    await processLabDocumentExtraction(String(created.document._id));
    await processLabResultStructuring(String(created.document._id));
    expect(await LabResult.countDocuments({ organizationId: otherOrg._id })).toBe(0);
    expect(await LabResult.countDocuments({ organizationId, patientId })).toBe(1);
  });

  it('prevents concurrent structuring from creating duplicates', async () => {
    const created = await createLabDocument({ clinicOrganizationId: String(organizationId), apexcareOrganizationId: String(apexcareOrganizationId), patientId: String(patientId), uploadedByUserId: String(userId), fileName: 'concurrent.pdf', idempotencyKey: 'd3-4', buffer: pdfWithText('HDL: 48 mg/dL 40-60') });
    await processLabDocumentExtraction(String(created.document._id));
    const [a, b] = await Promise.all([processLabResultStructuring(String(created.document._id)), processLabResultStructuring(String(created.document._id))]);
    expect([a.processed, b.processed].filter(Boolean)).toHaveLength(1);
    expect([a.idempotent, b.idempotent].filter(Boolean)).toHaveLength(1);
    expect(await LabResult.countDocuments({ labDocumentId: created.document._id })).toBe(1);
  });
});
