import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LabDocument, LabInterpretation, LabResult, Organization, Patient, User } from '../models.js';
import { processLabInterpretation, setLabInterpretationProviderForTests } from '../lab-interpretation.js';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Organization.init(), User.init(), Patient.init(), LabDocument.init(), LabResult.init(), LabInterpretation.init()]);
}, 60_000);

afterAll(async () => {
  setLabInterpretationProviderForTests(undefined);
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    Organization.deleteMany({}), User.deleteMany({}), Patient.deleteMany({}),
    LabDocument.deleteMany({}), LabResult.deleteMany({}), LabInterpretation.deleteMany({}),
  ]);
});

describe('Phase 3D.4 lab interpretation', () => {
  it('creates one preferred-language interpretation idempotently', async () => {
    const organization = await Organization.create({ name: 'Clinic', type: 'CLINIC', status: 'ACTIVE' });
    const apexcare = await Organization.create({ name: 'ApexCare', type: 'APEXCARE', status: 'ACTIVE' });
    const user = await User.create({ organizationId: organization._id, name: 'Clinician', email: 'clinician@test.local', passwordHash: 'x'.repeat(60), roles: ['CLINICIAN'] });
    const patient = await Patient.create({ organizationId: organization._id, medicalRecordNumber: 'LAB-1', name: { first: 'Malayalam', last: 'Patient' }, preferredLanguage: 'ml', phone: '9999999999', assignedClinicianId: user._id, conditions: [{ code: 'HYPERTENSION', status: 'CONFIRMED', diagnosedAt: new Date() }], status: 'ACTIVE' });
    const document = await LabDocument.create({ patientId: patient._id, clinicOrganizationId: organization._id, apexcareOrganizationId: apexcare._id, fileName: 'lab.pdf', mimeType: 'application/pdf', storageKey: 'labs/test.pdf', sizeBytes: 100, sha256: 'a'.repeat(64), idempotencyKey: 'lab-1', uploadedByUserId: user._id, extractionStatus: 'COMPLETED', extractionVersion: 1, extractedText: 'HbA1c 7.8 % 4.0-5.6', structuringStatus: 'COMPLETED', structuringVersion: 1, structuredResultCount: 1 });
    await LabResult.create({ organizationId: organization._id, apexcareOrganizationId: apexcare._id, patientId: patient._id, labDocumentId: document._id, testName: 'HbA1c', normalizedTestName: 'HBA1C', valueNumber: 7.8, valueText: '7.8', unit: '%', referenceLow: 4, referenceHigh: 5.6, referenceRangeText: '4.0-5.6', abnormalFlag: 'HIGH', sourceText: 'HbA1c 7.8 % 4.0-5.6', extractionConfidence: .98, parserVersion: 1, resultKey: `${document._id}:1:HBA1C:0` });

    let calls = 0;
    setLabInterpretationProviderForTests(async (input) => { calls += 1; expect(input.patientLanguage).toBe('ml'); return { clinicianSummary: 'HbA1c is above the reported reference range.', patientSummary: 'HbA1c റിപ്പോർട്ടിലെ പരിധിയേക്കാൾ കൂടുതലാണ്.', suggestedDiscussionPoints: ['Review glycemic control with clinician.'], urgentReview: false, confidence: .93 }; });

    const first = await processLabInterpretation(String(document._id));
    const second = await processLabInterpretation(String(document._id));

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(calls).toBe(1);
    expect(await LabInterpretation.countDocuments({ organizationId: organization._id })).toBe(1);
    const saved = await LabInterpretation.findOne({ labDocumentId: document._id }).lean();
    expect(saved?.patientLanguage).toBe('ml');
    expect(saved?.clinicianReviewStatus).toBe('PENDING');
  });

  it('does not create an interpretation across another clinic organization', async () => {
    const organization = await Organization.create({ name: 'Clinic A', type: 'CLINIC', status: 'ACTIVE' });
    const other = await Organization.create({ name: 'Clinic B', type: 'CLINIC', status: 'ACTIVE' });
    const apexcare = await Organization.create({ name: 'ApexCare', type: 'APEXCARE', status: 'ACTIVE' });
    const user = await User.create({ organizationId: organization._id, name: 'Clinician', email: 'clinician2@test.local', passwordHash: 'x'.repeat(60), roles: ['CLINICIAN'] });
    const patient = await Patient.create({ organizationId: organization._id, medicalRecordNumber: 'LAB-2', name: { first: 'Patient' }, assignedClinicianId: user._id, status: 'ACTIVE' });
    const document = await LabDocument.create({ patientId: patient._id, clinicOrganizationId: organization._id, apexcareOrganizationId: apexcare._id, fileName: 'lab.pdf', mimeType: 'application/pdf', storageKey: 'labs/test2.pdf', sizeBytes: 100, sha256: 'b'.repeat(64), idempotencyKey: 'lab-2', uploadedByUserId: user._id, extractionStatus: 'COMPLETED', extractionVersion: 1, structuringStatus: 'COMPLETED', structuringVersion: 1 });
    await LabResult.create({ organizationId: organization._id, apexcareOrganizationId: apexcare._id, patientId: patient._id, labDocumentId: document._id, testName: 'Creatinine', normalizedTestName: 'CREATININE', valueText: '1.0', abnormalFlag: 'NORMAL', sourceText: 'Creatinine 1.0', extractionConfidence: .9, parserVersion: 1, resultKey: `${document._id}:1:CREATININE:0` });
    setLabInterpretationProviderForTests(async () => ({ clinicianSummary: 'Normal.', patientSummary: 'Normal.', suggestedDiscussionPoints: [], urgentReview: false, confidence: .9 }));

    const result = await processLabInterpretation(String(document._id), { organizationId: String(other._id), patientId: String(patient._id), apexcareOrganizationId: String(apexcare._id) });
    expect(result.idempotent).toBe(true);
    expect(await LabInterpretation.countDocuments({ labDocumentId: document._id })).toBe(0);
    const unchanged = await LabDocument.findById(document._id).lean();
    expect(unchanged?.interpretationStatus).toBe('NOT_STARTED');
  });

  it('returns the document to FAILED when the AI provider fails so a retry can reclaim it', async () => {
    const organization = await Organization.create({ name: 'Clinic', type: 'CLINIC', status: 'ACTIVE' });
    const apexcare = await Organization.create({ name: 'ApexCare', type: 'APEXCARE', status: 'ACTIVE' });
    const user = await User.create({ organizationId: organization._id, name: 'Clinician', email: 'clinician3@test.local', passwordHash: 'x'.repeat(60), roles: ['CLINICIAN'] });
    const patient = await Patient.create({ organizationId: organization._id, medicalRecordNumber: 'LAB-3', name: { first: 'Patient' }, assignedClinicianId: user._id, status: 'ACTIVE' });
    const document = await LabDocument.create({ patientId: patient._id, clinicOrganizationId: organization._id, apexcareOrganizationId: apexcare._id, fileName: 'lab.pdf', mimeType: 'application/pdf', storageKey: 'labs/test3.pdf', sizeBytes: 100, sha256: 'c'.repeat(64), idempotencyKey: 'lab-3', uploadedByUserId: user._id, extractionStatus: 'COMPLETED', extractionVersion: 1, structuringStatus: 'COMPLETED', structuringVersion: 1 });
    await LabResult.create({ organizationId: organization._id, apexcareOrganizationId: apexcare._id, patientId: patient._id, labDocumentId: document._id, testName: 'LDL', normalizedTestName: 'LDL', valueText: '100', abnormalFlag: 'NORMAL', sourceText: 'LDL 100', extractionConfidence: .9, parserVersion: 1, resultKey: `${document._id}:1:LDL:0` });
    setLabInterpretationProviderForTests(async () => { throw new Error('AI_TEMPORARY_FAILURE'); });

    await expect(processLabInterpretation(String(document._id))).rejects.toThrow('AI_TEMPORARY_FAILURE');
    const failed = await LabDocument.findById(document._id).lean();
    expect(failed?.interpretationStatus).toBe('FAILED');
  });
});
