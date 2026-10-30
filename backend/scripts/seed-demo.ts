import 'dotenv/config';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {
  ApexCareEnrollment,
  ApexCareReferral,
  CarePlan,
  CarePlanDraft,
  CarePlanExecution,
  CarePlanMilestone,
  CareProtocol,
  CareTask,
  ClinicalSignal,
  Diagnosis,
  DietitianAssessment,
  LabDocument,
  LabInterpretation,
  LabResult,
  OpdVisit,
  Organization,
  Patient,
  PatientClinicRelationship,
  PatientReview,
  PatientReviewSummary,
  ProgramConsent,
  ServiceCase,
  Subscription,
  User,
  VitalRecord,
  CoordinatorEscalation,
  ClinicalReviewCase,
  ClinicalReviewEvent,
  MedicationDraft,
  MedicationHistory,
  MedicationRecord,
  OutboxEvent,
  PatientCommunication,
  PrescriptionDocument,
  VisitReview,
} from '../models.js';
import { env } from '../config.js';

/**
 * ApexCare local/demo seed.
 *
 * Safe-by-default behaviour:
 * - Creates/refreshes ONLY the two organisations with the exact demo names below.
 * - Never drops the database.
 * - Set SEED_RESET=false to keep existing demo records and only ensure the accounts/data exist.
 *
 * Run from backend root:
 *   npm run seed:demo
 */

const CLINIC_NAME = 'ApexCare Demo Clinic';
const APEX_NAME = 'ApexCare Demo Team';
const DEMO_PASSWORDS = {
  clinicAdmin: 'ApexClinic!2026',
  clinician: 'ApexDoctor!2026',
  coordinator: 'ApexCoord!2026',
  patient: 'ApexPatient!2026',
  apexCoordinator: 'ApexApexCoord!2026',
  dietitian: 'ApexDietitian!2026',
  specialist: 'ApexSpecialist!2026',
  apexDoctor: 'ApexApexDoctor!2026',
  platformAdmin: 'ApexPlatform!2026',
} as const;

const DEMO_EMAILS = {
  clinicAdmin: 'admin@demo.apexcare.local',
  clinician: 'clinician@demo.apexcare.local',
  coordinator: 'coordinator@demo.apexcare.local',
  patient: 'patient@demo.apexcare.local',
  apexCoordinator: 'coordinator@apex.demo.apexcare.local',
  dietitian: 'dietitian@apex.demo.apexcare.local',
  specialist: 'specialist@apex.demo.apexcare.local',
  apexDoctor: 'doctor@apex.demo.apexcare.local',
  platformAdmin: 'superadmin@apex.demo.apexcare.local',
} as const;

const seedReset = process.env.SEED_RESET !== 'false';

if (!seedReset) {
  throw new Error('This seed intentionally refuses SEED_RESET=false. Use the default SEED_RESET=true so demo data is reproducible without risking partial duplication.');
}

function dateDaysFromNow(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function deleteDemoOrgData(orgId: mongoose.Types.ObjectId) {
  const id = orgId;
  const scopedModels: Array<{ model: mongoose.Model<any>; fields: string[] }> = [
    { model: User, fields: ['organizationId'] },
    { model: Patient, fields: ['organizationId'] },
    { model: PatientClinicRelationship, fields: ['clinicOrganizationId'] },
    { model: ApexCareEnrollment, fields: ['clinicOrganizationId', 'apexcareOrganizationId'] },
    { model: ApexCareReferral, fields: ['clinicOrganizationId', 'apexcareOrganizationId'] },
    { model: PrescriptionDocument, fields: ['clinicOrganizationId', 'apexcareOrganizationId'] },
    { model: LabDocument, fields: ['clinicOrganizationId', 'apexcareOrganizationId'] },
    { model: LabResult, fields: ['organizationId', 'apexcareOrganizationId'] },
    { model: LabInterpretation, fields: ['organizationId', 'apexcareOrganizationId'] },
    { model: MedicationDraft, fields: ['clinicOrganizationId', 'apexcareOrganizationId'] },
    { model: MedicationRecord, fields: ['clinicOrganizationId', 'apexcareOrganizationId'] },
    { model: MedicationHistory, fields: ['clinicOrganizationId', 'apexcareOrganizationId'] },
    { model: DietitianAssessment, fields: ['clinicOrganizationId', 'apexcareOrganizationId'] },
    { model: Diagnosis, fields: ['organizationId'] },
    { model: ProgramConsent, fields: ['organizationId'] },
    { model: CarePlan, fields: ['organizationId'] },
    { model: CarePlanDraft, fields: ['organizationId'] },
    { model: CareProtocol, fields: [] },
    { model: CareTask, fields: ['organizationId'] },
    { model: CarePlanExecution, fields: ['organizationId'] },
    { model: CarePlanMilestone, fields: ['organizationId'] },
    { model: PatientReview, fields: ['organizationId'] },
    { model: PatientReviewSummary, fields: ['organizationId'] },
    { model: CoordinatorEscalation, fields: ['organizationId'] },
    { model: ClinicalSignalModel, fields: ['organizationId'] },
    { model: VisitReview, fields: ['organizationId'] },
    { model: Subscription, fields: ['organizationId'] },
    { model: OutboxEvent, fields: ['organizationId'] },
    { model: PatientCommunication, fields: ['organizationId'] },
    { model: ClinicalReviewCase, fields: ['clinicOrganizationId', 'apexcareOrganizationId'] },
    { model: ClinicalReviewEvent, fields: ['clinicOrganizationId', 'apexcareOrganizationId'] },
    { model: ServiceCase, fields: ['organizationId', 'clinicOrganizationId', 'apexcareOrganizationId'] },
    { model: VitalRecord, fields: ['organizationId'] },
    { model: OpdVisit, fields: ['organizationId'] },
  ];

  for (const entry of scopedModels) {
    if (entry.fields.length === 0) continue;
    await entry.model.deleteMany({ $or: entry.fields.map((field) => ({ [field]: id })) });
  }
}

async function createUser(
  organizationId: mongoose.Types.ObjectId,
  name: string,
  email: string,
  password: string,
  roles: string[],
  patientId?: mongoose.Types.ObjectId,
) {
  const passwordHash = await bcrypt.hash(password, 12);
  return User.create({
    organizationId,
    name,
    email,
    passwordHash,
    roles,
    status: 'ACTIVE',
    mustChangePassword: false,
    ...(patientId ? { patientId } : {}),
  });
}

async function main() {
  await mongoose.connect(env.MONGO_URI);
  console.log(`Connected to ${env.MONGO_URI}`);

  const existingClinic = await Organization.findOne({ name: CLINIC_NAME, type: 'CLINIC' });
  const existingApex = await Organization.findOne({ name: APEX_NAME, type: 'APEXCARE' });

  if (seedReset) {
    if (existingClinic) {
      await deleteDemoOrgData(existingClinic._id);
      await Organization.deleteOne({ _id: existingClinic._id });
    }
    if (existingApex) {
      await deleteDemoOrgData(existingApex._id);
      await Organization.deleteOne({ _id: existingApex._id });
    }
    await CareProtocol.deleteMany({ protocolKey: 'HTN_90_DAY_DEMO' });
  }

  const clinic = await Organization.create({ name: CLINIC_NAME, type: 'CLINIC', status: 'ACTIVE' });
  const apex = await Organization.create({ name: APEX_NAME, type: 'APEXCARE', status: 'ACTIVE' });

  const periodStart = new Date();
  const periodEnd = dateDaysFromNow(30);
  await Subscription.create({
    organizationId: clinic._id,
    planCode: 'TRIAL_100',
    status: 'TRIAL',
    activePatientLimit: 100,
    activePatientCount: 3,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    billingInterval: 'MONTHLY',
  });

  const clinicAdmin = await createUser(clinic._id, 'Dr. Clinic Admin', DEMO_EMAILS.clinicAdmin, DEMO_PASSWORDS.clinicAdmin, ['CLINIC_ADMIN']);
  const clinician = await createUser(clinic._id, 'Dr. Ananya Menon', DEMO_EMAILS.clinician, DEMO_PASSWORDS.clinician, ['CLINICIAN']);
  const coordinator = await createUser(clinic._id, 'Meera Nair — Care Coordinator', DEMO_EMAILS.coordinator, DEMO_PASSWORDS.coordinator, ['CLINIC_COORDINATOR']);

  clinic.adminUserId = clinicAdmin._id;
  clinic.subscriptionId = (await Subscription.findOne({ organizationId: clinic._id }))!._id;
  await clinic.save();

  const apexCoordinator = await createUser(apex._id, 'ApexCare Coordinator', DEMO_EMAILS.apexCoordinator, DEMO_PASSWORDS.apexCoordinator, ['APEXCARE_COORDINATOR']);
  const dietitian = await createUser(apex._id, 'Dr. Neha Varma — Dietitian', DEMO_EMAILS.dietitian, DEMO_PASSWORDS.dietitian, ['APEXCARE_DIETITIAN']);
  const specialist = await createUser(apex._id, 'Dr. Rahul Iyer — Specialist', DEMO_EMAILS.specialist, DEMO_PASSWORDS.specialist, ['APEXCARE_SPECIALIST']);
  const apexDoctor = await createUser(apex._id, 'Dr. Arjun Rao — ApexCare Doctor', DEMO_EMAILS.apexDoctor, DEMO_PASSWORDS.apexDoctor, ['APEXCARE_DOCTOR']);
  await createUser(apex._id, 'ApexCare Superadmin (Demo)', DEMO_EMAILS.platformAdmin, DEMO_PASSWORDS.platformAdmin, ['PLATFORM_ADMIN']);

  const patient1 = await Patient.create({
    organizationId: clinic._id,
    medicalRecordNumber: 'APX-DEMO-001',
    name: { first: 'Rahul', last: 'Krishnan' },
    dateOfBirth: new Date('1978-05-14'),
    sexAtBirth: 'MALE',
    phone: '+919876540001',
    whatsapp: '+919876540001',
    preferredLanguage: 'en',
    preferredContactChannel: 'WHATSAPP',
    assignedClinicianId: clinician._id,
    enrolledByUserId: coordinator._id,
    enrollmentStatus: 'ACTIVE_CARE',
    conditions: [{ code: 'HYPERTENSION', status: 'CONFIRMED', diagnosedAt: dateDaysFromNow(-45) }],
    programmeConsent: { acceptedAt: dateDaysFromNow(-42), acceptedByUserId: coordinator._id, communicationConsent: true },
    status: 'ACTIVE',
  });

  const patient2 = await Patient.create({
    organizationId: clinic._id,
    medicalRecordNumber: 'APX-DEMO-002',
    name: { first: 'Anjali', last: 'Suresh' },
    dateOfBirth: new Date('1991-11-02'),
    sexAtBirth: 'FEMALE',
    phone: '+919876540002',
    whatsapp: '+919876540002',
    preferredLanguage: 'ml',
    preferredContactChannel: 'WHATSAPP',
    assignedClinicianId: clinician._id,
    enrolledByUserId: clinician._id,
    enrollmentStatus: 'NOT_ENROLLED',
    conditions: [{ code: 'HYPERTENSION', status: 'CONFIRMED', diagnosedAt: dateDaysFromNow(-2) }],
    status: 'ACTIVE',
  });

  const patient3 = await Patient.create({
    organizationId: clinic._id,
    medicalRecordNumber: 'APX-DEMO-003',
    name: { first: 'Mohammed', last: 'Faisal' },
    dateOfBirth: new Date('1968-02-20'),
    sexAtBirth: 'MALE',
    phone: '+919876540003',
    whatsapp: '+919876540003',
    preferredLanguage: 'en',
    preferredContactChannel: 'PHONE',
    assignedClinicianId: clinician._id,
    enrolledByUserId: coordinator._id,
    enrollmentStatus: 'ACTIVE_CARE',
    conditions: [
      { code: 'HYPERTENSION', status: 'CONFIRMED', diagnosedAt: dateDaysFromNow(-120) },
      { code: 'DYSLIPIDEMIA', status: 'CONFIRMED', diagnosedAt: dateDaysFromNow(-110) },
    ],
    programmeConsent: { acceptedAt: dateDaysFromNow(-100), acceptedByUserId: coordinator._id, communicationConsent: true },
    status: 'ACTIVE',
  });

  const patientUser = await createUser(clinic._id, 'Rahul Krishnan — Patient', DEMO_EMAILS.patient, DEMO_PASSWORDS.patient, ['PATIENT'], patient1._id);

  await PatientClinicRelationship.create({ patientId: patient1._id, clinicOrganizationId: clinic._id, relationshipType: 'PRIMARY', status: 'ACTIVE', startedAt: dateDaysFromNow(-45) });
  await PatientClinicRelationship.create({ patientId: patient2._id, clinicOrganizationId: clinic._id, relationshipType: 'PRIMARY', status: 'ACTIVE', startedAt: dateDaysFromNow(-2) });
  await PatientClinicRelationship.create({ patientId: patient3._id, clinicOrganizationId: clinic._id, relationshipType: 'PRIMARY', status: 'ACTIVE', startedAt: dateDaysFromNow(-120) });

  await Diagnosis.create({ organizationId: clinic._id, patientId: patient1._id, condition: 'HYPERTENSION', status: 'CONFIRMED', diagnosedAt: dateDaysFromNow(-45), diagnosedByUserId: clinician._id, source: 'CLINICIAN', notes: 'Demo confirmed hypertension diagnosis.' });
  await Diagnosis.create({ organizationId: clinic._id, patientId: patient2._id, condition: 'HYPERTENSION', status: 'CONFIRMED', diagnosedAt: dateDaysFromNow(-2), diagnosedByUserId: clinician._id, source: 'CLINICIAN', notes: 'New diagnosis — ideal for coordinator onboarding demo.' });
  await Diagnosis.create({ organizationId: clinic._id, patientId: patient3._id, condition: 'HYPERTENSION', status: 'CONFIRMED', diagnosedAt: dateDaysFromNow(-120), diagnosedByUserId: clinician._id, source: 'CLINICIAN' });
  await Diagnosis.create({ organizationId: clinic._id, patientId: patient3._id, condition: 'DYSLIPIDEMIA', status: 'CONFIRMED', diagnosedAt: dateDaysFromNow(-110), diagnosedByUserId: clinician._id, source: 'CLINICIAN' });

  await ProgramConsent.create({ organizationId: clinic._id, patientId: patient1._id, program: 'APEXCARE_CHRONIC_CARE', consentGiven: true, consentAt: dateDaysFromNow(-42), method: 'VERBAL', recordedByUserId: coordinator._id, consentVersion: '2026-08-v1', communicationConsent: true });
  await ProgramConsent.create({ organizationId: clinic._id, patientId: patient3._id, program: 'APEXCARE_CHRONIC_CARE', consentGiven: true, consentAt: dateDaysFromNow(-100), method: 'DIGITAL', recordedByUserId: coordinator._id, consentVersion: '2026-08-v1', communicationConsent: true });

  const enrollment1 = await ApexCareEnrollment.create({
    patientId: patient1._id,
    clinicOrganizationId: clinic._id,
    apexcareOrganizationId: apex._id,
    status: 'ACTIVE',
    enrolledAt: dateDaysFromNow(-40),
    enrolledByUserId: coordinator._id,
    coordinatorCallDueAt: dateDaysFromNow(-35),
    coordinatorCallStatus: 'CONTACTED',
    coordinatorCalledAt: dateDaysFromNow(-34),
    dietitianAssessmentStatus: 'COMPLETED',
  });
  const enrollment3 = await ApexCareEnrollment.create({
    patientId: patient3._id,
    clinicOrganizationId: clinic._id,
    apexcareOrganizationId: apex._id,
    status: 'ACTIVE',
    enrolledAt: dateDaysFromNow(-95),
    enrolledByUserId: coordinator._id,
    coordinatorCallDueAt: dateDaysFromNow(-90),
    coordinatorCallStatus: 'CONTACTED',
    coordinatorCalledAt: dateDaysFromNow(-89),
    dietitianAssessmentStatus: 'COMPLETED',
  });

  await DietitianAssessment.create({
    patientId: patient1._id,
    clinicOrganizationId: clinic._id,
    apexcareOrganizationId: apex._id,
    dietitianUserId: dietitian._id,
    apexCareEnrollmentId: enrollment1._id,
    remarks: 'Demo assessment: reduce sodium, increase vegetables and maintain consistent meal timing.',
    assessmentData: { sodiumReduction: true, localCuisine: 'Kerala', activityMinutesPerWeek: 120 },
    completedAt: dateDaysFromNow(-30),
  });
  await DietitianAssessment.create({
    patientId: patient3._id,
    clinicOrganizationId: clinic._id,
    apexcareOrganizationId: apex._id,
    dietitianUserId: dietitian._id,
    apexCareEnrollmentId: enrollment3._id,
    remarks: 'Demo assessment completed.',
    assessmentData: { sodiumReduction: true, activityMinutesPerWeek: 150 },
    completedAt: dateDaysFromNow(-80),
  });

  await ServiceCase.create({
    organizationId: clinic._id,
    clinicOrganizationId: clinic._id,
    apexcareOrganizationId: apex._id,
    patientId: patient1._id,
    requestedByUserId: clinician._id,
    service: 'DIETITIAN',
    status: 'ASSIGNED',
    assignedApexcareUserId: dietitian._id,
    reason: 'Lifestyle and sodium-reduction support for hypertension.',
    handoffSummary: 'Please reinforce Kerala-friendly low-sodium meal choices and adherence barriers.',
  });

  const existingHypertensionProtocol = await CareProtocol.findOne({ condition: 'HYPERTENSION', jurisdiction: 'IN', status: 'ACTIVE' }).lean();
  const protocol = existingHypertensionProtocol ?? await CareProtocol.create({
    protocolKey: 'HTN_90_DAY_DEMO',
    version: '1.0.0',
    condition: 'HYPERTENSION',
    status: 'ACTIVE',
    jurisdiction: 'IN',
    durationDays: 90,
    milestones: [
      { key: 'DAY_0', label: 'Baseline review', offsetDays: 0, sequence: 1, reviewRequired: true },
      { key: 'DAY_14', label: 'Early adherence check', offsetDays: 14, sequence: 2, reviewRequired: false },
      { key: 'DAY_30', label: '30-day clinical review', offsetDays: 30, sequence: 3, reviewRequired: true },
      { key: 'DAY_90', label: '90-day outcome review', offsetDays: 90, sequence: 4, reviewRequired: true },
    ],
  });

  const plan1 = await CarePlan.create({
    organizationId: clinic._id,
    patientId: patient1._id,
    condition: 'HYPERTENSION',
    status: 'ACTIVE',
    startDate: dateDaysFromNow(-35),
    endDate: dateDaysFromNow(55),
    goals: [
      { title: 'Track blood pressure', target: '3', unit: 'readings/week' },
      { title: 'Reduce sodium intake', target: 'consistent', unit: 'days/week' },
      { title: 'Complete scheduled follow-ups', target: '100', unit: '%' },
    ],
    version: 1,
    createdByUserId: clinician._id,
    approvedByUserId: clinician._id,
    approvedAt: dateDaysFromNow(-34),
  });

  const plan3 = await CarePlan.create({
    organizationId: clinic._id,
    patientId: patient3._id,
    condition: 'HYPERTENSION',
    status: 'ACTIVE',
    startDate: dateDaysFromNow(-90),
    endDate: dateDaysFromNow(0),
    goals: [{ title: 'Maintain home BP log', target: '3', unit: 'readings/week' }],
    version: 1,
    createdByUserId: clinician._id,
    approvedByUserId: clinician._id,
    approvedAt: dateDaysFromNow(-89),
  });

  const execution1 = await CarePlanExecution.create({
    organizationId: clinic._id,
    patientId: patient1._id,
    carePlanId: plan1._id,
    condition: 'HYPERTENSION',
    protocolKey: protocol.protocolKey,
    protocolVersion: protocol.version,
    status: 'ACTIVE',
    startDate: plan1.startDate,
    endDate: plan1.endDate,
    activationKey: `demo-care-plan-execution:${plan1._id}`,
  });

  const execution3 = await CarePlanExecution.create({
    organizationId: clinic._id,
    patientId: patient3._id,
    carePlanId: plan3._id,
    condition: 'HYPERTENSION',
    protocolKey: protocol.protocolKey,
    protocolVersion: protocol.version,
    status: 'COMPLETED',
    startDate: plan3.startDate,
    endDate: plan3.endDate,
    activationKey: `demo-care-plan-execution:${plan3._id}`,
  });

  const milestone1 = await CarePlanMilestone.create({
    organizationId: clinic._id,
    patientId: patient1._id,
    carePlanId: plan1._id,
    executionId: execution1._id,
    key: 'DAY_30',
    offsetDays: 30,
    day: 30,
    dueAt: dateDaysFromNow(-5),
    status: 'DUE',
    reviewRequired: true,
  });
  await CarePlanMilestone.create({
    organizationId: clinic._id,
    patientId: patient3._id,
    carePlanId: plan3._id,
    executionId: execution3._id,
    key: 'DAY_90',
    offsetDays: 90,
    day: 90,
    dueAt: dateDaysFromNow(-1),
    status: 'COMPLETED',
    reviewRequired: true,
    completedAt: dateDaysFromNow(-1),
    completedByUserId: clinician._id,
  });

  const overdueTask = await CareTask.create({
    organizationId: clinic._id,
    patientId: patient1._id,
    carePlanId: plan1._id,
    executionId: execution1._id,
    milestoneId: milestone1._id,
    taskKey: 'demo-vitals-overdue-001',
    type: 'VITALS',
    title: 'Record home blood pressure',
    dueAt: dateDaysFromNow(-2),
    status: 'OVERDUE',
  });
  await CareTask.create({
    organizationId: clinic._id,
    patientId: patient1._id,
    carePlanId: plan1._id,
    executionId: execution1._id,
    milestoneId: milestone1._id,
    taskKey: 'demo-lab-pending-001',
    type: 'LAB',
    title: 'Complete scheduled lipid panel',
    dueAt: dateDaysFromNow(2),
    status: 'PENDING',
  });
  await CareTask.create({
    organizationId: clinic._id,
    patientId: patient1._id,
    carePlanId: plan1._id,
    executionId: execution1._id,
    taskKey: 'demo-followup-pending-001',
    type: 'FOLLOW_UP',
    title: 'Coordinator follow-up call',
    dueAt: dateDaysFromNow(1),
    status: 'PENDING',
  });
  await CareTask.create({
    organizationId: clinic._id,
    patientId: patient3._id,
    carePlanId: plan3._id,
    executionId: execution3._id,
    taskKey: 'demo-completed-task-001',
    type: 'VITALS',
    title: 'Record monthly blood pressure',
    dueAt: dateDaysFromNow(-3),
    status: 'COMPLETED',
    completedAt: dateDaysFromNow(-4),
    completedByUserId: coordinator._id,
  });

  await VitalRecord.create({ organizationId: clinic._id, patientId: patient1._id, recordedAt: dateDaysFromNow(-14), recordedByUserId: coordinator._id, source: 'HOME', bloodPressure: { systolic: 152, diastolic: 96, pulse: 82 }, weightKg: 84, notes: 'Demo elevated reading.' });
  await VitalRecord.create({ organizationId: clinic._id, patientId: patient1._id, recordedAt: dateDaysFromNow(-3), recordedByUserId: coordinator._id, source: 'HOME', bloodPressure: { systolic: 146, diastolic: 92, pulse: 78 }, weightKg: 83.5, notes: 'Demo follow-up reading.' });
  await VitalRecord.create({ organizationId: clinic._id, patientId: patient3._id, recordedAt: dateDaysFromNow(-4), recordedByUserId: coordinator._id, source: 'OPD', bloodPressure: { systolic: 128, diastolic: 78, pulse: 72 }, weightKg: 76 });

  await OpdVisit.create({ organizationId: clinic._id, patientId: patient1._id, visitAt: dateDaysFromNow(-3), recordedByUserId: coordinator._id, clinicianId: clinician._id, reason: 'Hypertension follow-up', assessment: 'BP remains above target; continue monitoring and review adherence.', planAdjustment: 'Reinforce home BP logging and sodium reduction.', vitalsRecordId: undefined });

  const labText = 'Total Cholesterol 218 mg/dL; LDL 142 mg/dL; HDL 44 mg/dL; Triglycerides 160 mg/dL.';
  const labDoc = await LabDocument.create({
    patientId: patient1._id,
    clinicOrganizationId: clinic._id,
    apexcareOrganizationId: apex._id,
    source: 'LAB_PDF',
    status: 'EXTRACTED',
    fileName: 'rahul-lipid-panel-demo.pdf',
    mimeType: 'application/pdf',
    storageKey: 'demo/rahul-lipid-panel-demo.pdf',
    sizeBytes: 1024,
    sha256: sha256('rahul-lipid-panel-demo-v1'),
    idempotencyKey: 'demo-lab-rahul-001',
    uploadedByUserId: coordinator._id,
    uploadedAt: dateDaysFromNow(-4),
    extractionStatus: 'COMPLETED',
    extractedText: labText,
    extractionVersion: 1,
    structuringStatus: 'COMPLETED',
    structuringVersion: 1,
    structuredAt: dateDaysFromNow(-4),
    structuredResultCount: 4,
    interpretationStatus: 'COMPLETED',
    interpretationVersion: 1,
    interpretedAt: dateDaysFromNow(-3),
  });

  await LabResult.create([
    { organizationId: clinic._id, apexcareOrganizationId: apex._id, patientId: patient1._id, labDocumentId: labDoc._id, testName: 'Total Cholesterol', normalizedTestName: 'total_cholesterol', valueNumber: 218, valueText: '218', unit: 'mg/dL', referenceLow: 0, referenceHigh: 200, referenceRangeText: '<200', abnormalFlag: 'HIGH', specimen: 'SERUM', sourceText: 'Total Cholesterol 218 mg/dL', extractionConfidence: 0.99, parserVersion: 1, resultKey: `demo-lab-result:${labDoc._id}:total_cholesterol` },
    { organizationId: clinic._id, apexcareOrganizationId: apex._id, patientId: patient1._id, labDocumentId: labDoc._id, testName: 'LDL Cholesterol', normalizedTestName: 'ldl_cholesterol', valueNumber: 142, valueText: '142', unit: 'mg/dL', referenceLow: 0, referenceHigh: 100, referenceRangeText: '<100', abnormalFlag: 'HIGH', specimen: 'SERUM', sourceText: 'LDL 142 mg/dL', extractionConfidence: 0.98, parserVersion: 1, resultKey: `demo-lab-result:${labDoc._id}:ldl` },
    { organizationId: clinic._id, apexcareOrganizationId: apex._id, patientId: patient1._id, labDocumentId: labDoc._id, testName: 'HDL Cholesterol', normalizedTestName: 'hdl_cholesterol', valueNumber: 44, valueText: '44', unit: 'mg/dL', referenceLow: 40, referenceHigh: 60, referenceRangeText: '40-60', abnormalFlag: 'NORMAL', specimen: 'SERUM', sourceText: 'HDL 44 mg/dL', extractionConfidence: 0.99, parserVersion: 1, resultKey: `demo-lab-result:${labDoc._id}:hdl` },
    { organizationId: clinic._id, apexcareOrganizationId: apex._id, patientId: patient1._id, labDocumentId: labDoc._id, testName: 'Triglycerides', normalizedTestName: 'triglycerides', valueNumber: 160, valueText: '160', unit: 'mg/dL', referenceLow: 0, referenceHigh: 150, referenceRangeText: '<150', abnormalFlag: 'HIGH', specimen: 'SERUM', sourceText: 'Triglycerides 160 mg/dL', extractionConfidence: 0.97, parserVersion: 1, resultKey: `demo-lab-result:${labDoc._id}:triglycerides` },
  ]);

  const interpretation = await LabInterpretation.create({
    organizationId: clinic._id,
    apexcareOrganizationId: apex._id,
    patientId: patient1._id,
    labDocumentId: labDoc._id,
    interpretationKey: `demo-lab-interpretation:${labDoc._id}:v1`,
    interpretationVersion: 1,
    provider: 'RULES',
    model: 'demo-seed',
    patientLanguage: 'en',
    clinicianSummary: 'Lipid panel shows elevated total cholesterol, LDL and triglycerides. Review cardiovascular risk context and treatment plan; this summary is seeded demo data, not a diagnosis.',
    patientSummary: 'Your cholesterol results include a few values above the usual reference range. This does not by itself tell you what treatment you need. Your clinician should review the results together with your other health information.',
    suggestedDiscussionPoints: ['Review cardiovascular risk factors.', 'Discuss diet and activity goals.', 'Consider whether repeat testing or treatment adjustment is appropriate.'],
    urgentReview: false,
    confidence: 0.97,
    status: 'READY',
    clinicianReviewStatus: 'APPROVED',
    clinicianReviewedByUserId: clinician._id,
    clinicianReviewedAt: dateDaysFromNow(-2),
    clinicianApprovedSummary: 'Reviewed for demo; discuss lipid management at next clinical review.',
    patientApprovedSummary: 'Your clinician has reviewed these results. A few cholesterol values are higher than the usual range; your clinician will discuss what they mean for you.',
  });

  await ClinicalSignal.create({
    organizationId: clinic._id,
    patientId: patient1._id,
    sourceType: 'LAB_INTERPRETATION',
    sourceId: interpretation._id,
    signalKey: `demo-signal:${interpretation._id}:ABNORMAL_LAB`,
    kind: 'ABNORMAL_LAB',
    priority: 'MEDIUM',
    status: 'OPEN',
    summary: 'Demo signal: lipid panel contains elevated LDL and triglycerides requiring clinician review.',
    evidence: { abnormalTests: ['LDL Cholesterol', 'Triglycerides', 'Total Cholesterol'], interpretationId: String(interpretation._id) },
  });

  await CarePlanDraft.create({
    organizationId: clinic._id,
    patientId: patient2._id,
    condition: 'HYPERTENSION',
    status: 'CLINICIAN_REVIEW',
    generatedByUserId: clinician._id,
    clinicianReviewDueAt: dateDaysFromNow(1),
    fallbackEligibleAt: dateDaysFromNow(2),
    source: 'RULES',
    provider: 'RULES',
    model: 'demo-seed',
    inputSnapshot: { source: 'demo-seed', note: 'Synthetic demonstration data only.' },
    plan: {
      summary: 'Demo draft for a newly diagnosed hypertension patient awaiting clinician review.',
      goals: [
        { title: 'Home BP monitoring', target: '3', unit: 'readings/week', rationale: 'Establish baseline home readings.' },
        { title: 'Reduce sodium', target: 'most days', unit: 'days/week', rationale: 'Support blood-pressure control.' },
      ],
      tasks: [
        { type: 'VITALS', title: 'Record home BP', dueDay: 7, rationale: 'Create baseline trend.' },
        { type: 'FOLLOW_UP', title: 'Clinic follow-up', dueDay: 14, rationale: 'Review response and adherence.' },
      ],
      clinicalInterventionNeeded: true,
      confidence: 0.82,
      safetyNotes: ['Demo data only.', 'Clinician approval is required before activation.'],
    },
  });

  await ApexCareReferral.create({
    patientId: patient2._id,
    clinicOrganizationId: clinic._id,
    apexcareOrganizationId: apex._id,
    referredByUserId: clinician._id,
    condition: 'HYPERTENSION',
    status: 'PENDING_STAFF',
    referredAt: dateDaysFromNow(-1),
    staffEscalationDueAt: dateDaysFromNow(0),
  });

  await ApexCareReferral.create({
    patientId: patient1._id,
    clinicOrganizationId: clinic._id,
    apexcareOrganizationId: apex._id,
    referredByUserId: clinician._id,
    condition: 'HYPERTENSION',
    status: 'ENROLLED',
    referredAt: dateDaysFromNow(-40),
    staffEscalationDueAt: dateDaysFromNow(-39),
    enrolledAt: dateDaysFromNow(-40),
    enrolledByUserId: coordinator._id,
  });


  console.log('\nApexCare demo seed completed.\n');
  console.log('Clinic login:');
  console.log(`  Admin       ${DEMO_EMAILS.clinicAdmin} / ${DEMO_PASSWORDS.clinicAdmin}`);
  console.log(`  Clinician   ${DEMO_EMAILS.clinician} / ${DEMO_PASSWORDS.clinician}`);
  console.log(`  Coordinator ${DEMO_EMAILS.coordinator} / ${DEMO_PASSWORDS.coordinator}`);
  console.log(`  Patient     ${DEMO_EMAILS.patient} / ${DEMO_PASSWORDS.patient}`);
  console.log('\nApexCare login:');
  console.log(`  Coordinator ${DEMO_EMAILS.apexCoordinator} / ${DEMO_PASSWORDS.apexCoordinator}`);
  console.log(`  Dietitian   ${DEMO_EMAILS.dietitian} / ${DEMO_PASSWORDS.dietitian}`);
  console.log(`  Specialist  ${DEMO_EMAILS.specialist} / ${DEMO_PASSWORDS.specialist}`);
  console.log(`  Doctor      ${DEMO_EMAILS.apexDoctor} / ${DEMO_PASSWORDS.apexDoctor}`);
  console.log(`  Superadmin  ${DEMO_EMAILS.platformAdmin} / ${DEMO_PASSWORDS.platformAdmin}`);
  console.log('\nSeeded patients:');
  console.log('  APX-DEMO-001 Rahul Krishnan — active care, overdue task, lab interpretation + open clinical signal');
  console.log('  APX-DEMO-002 Anjali Suresh — new diagnosis, ApexCare referral pending, care-plan draft awaiting clinician review');
  console.log('  APX-DEMO-003 Mohammed Faisal — completed care cycle with historical vitals');
  console.log(`\nProtocol seeded: ${protocol.protocolKey} ${protocol.version}`);
  console.log(`Demo patient user linked to: ${patientUser.email}`);

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
