import 'dotenv/config';
import bcrypt from 'bcrypt';
import mongoose, { type Types } from 'mongoose';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { APEX_GENERAL_HISTORY_QUESTIONS, APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION } from '../apexcare-general-history-questionnaire.js';
import {
  ApexCareEnrollment, ApexCareGeneralHistory, ApexCareReferral, CarePlan, CarePlanDraft,
  CarePlanExecution, CarePlanMilestone, CareTask, Diagnosis,
  DietitianAssessment, Organization, Patient, PatientClinicRelationship, PatientReview,
  ProgramConsent, Subscription, User, VitalRecord, OpdVisit,
} from '../models.js';
import { env } from '../config.js';

const CONFIRM = 'DELETE_ALL_PATIENTS';
const DEMO_COUNT = 20;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const relationFields = [
  'patientId', 'carePlanId', 'executionId', 'milestoneId', 'reviewId', 'enrollmentId',
  'referralId', 'prescriptionDocumentId', 'medicationDraftId', 'medicationRecordId',
  'labDocumentId', 'clinicalReviewCaseId', 'serviceCaseId', 'sourceId', 'aggregateId',
];
const protectedCollections = new Set(['patients', 'users', 'organizations', 'subscriptions', 'careprotocols']);

function assertSafeTarget() {
  const uri = new URL(env.MONGO_URI);
  const databaseName = decodeURIComponent(uri.pathname.replace(/^\//, '').split('/')[0] || '');
  if (process.env.NODE_ENV === 'production' || !LOCAL_HOSTS.has(uri.hostname) || databaseName !== 'apexcare') {
    throw new Error('Demo reset refused: only the local development database apexcare is allowed.');
  }
  if (process.env.APEXCARE_DEMO_RESET_CONFIRM !== CONFIRM) {
    throw new Error(`Demo reset refused: set APEXCARE_DEMO_RESET_CONFIRM=${CONFIRM} for this one-off run.`);
  }
  if (env.PRESCRIPTION_STORAGE_PROVIDER !== 'local') {
    throw new Error('Demo reset refused: cloud prescription storage requires a separately reviewed object cleanup.');
  }
  return databaseName;
}

function addIds(target: Set<string>, values: unknown[]) {
  for (const value of values) if (value) target.add(String(value));
}

async function removePatientLinkedData(patientDocs: Array<{ _id: Types.ObjectId; organizationId: Types.ObjectId }>) {
  if (!patientDocs.length) return;
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection is unavailable.');
  const patientIds = patientDocs.map((item) => item._id);
  const patientIdStrings = patientIds.map(String);
  const relatedIds = new Set(patientIdStrings);
  const patientUsers = await User.find({ patientId: { $in: patientIds } }).select('_id').lean();
  addIds(relatedIds, patientUsers.map((item) => item._id));
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();

  // Expand references without reading or logging patient contents. Multiple passes catch
  // secondary rows (for example, events attached to a review attached to a care plan).
  for (let pass = 0; pass < 5; pass += 1) {
    let added = false;
    for (const { name } of collections) {
      if (protectedCollections.has(name)) continue;
      const or = relationFields.map((field) => ({ [field]: { $in: [...relatedIds] } }));
      const rows = await db.collection(name).find({ $or: or }, { projection: { _id: 1 } }).toArray();
      for (const row of rows) {
        if (row._id && !relatedIds.has(String(row._id))) { relatedIds.add(String(row._id)); added = true; }
      }
    }
    if (!added) break;
  }

  const objectIds = [...relatedIds].filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
  const relationOr = relationFields.map((field) => ({ [field]: { $in: objectIds } }));
  for (const { name } of collections) {
    if (protectedCollections.has(name)) continue;
    await db.collection(name).deleteMany({ $or: relationOr });
  }

  // Outbox event payloads store patient IDs as strings. Remove linked operational
  // notices by patient account and payload reference as well.
  const accountIds = patientUsers.map((item) => item._id);
  const stringIds = patientIdStrings;
  const outbox = db.collection('outboxevents');
  await outbox.deleteMany({ $or: [
    { 'payload.patientId': { $in: stringIds } },
    { 'payload.referralId': { $in: [...relatedIds] } },
  ] });
  await db.collection('notifications').deleteMany({ $or: [
    { recipientUserId: { $in: accountIds } },
    { 'payload.patientId': { $in: stringIds } },
    { aggregateId: { $in: objectIds } },
  ] });
  await User.deleteMany({ patientId: { $in: patientIds } });
  await Patient.deleteMany({ _id: { $in: patientIds } });

  const roots = [
    path.resolve(env.PRESCRIPTION_STORAGE_DIR),
    path.resolve(env.LAB_PDF_STORAGE_DIR),
  ];
  for (const patient of patientDocs) {
    for (const root of roots) {
      const target = path.resolve(root, String(patient.organizationId), String(patient._id));
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Refusing to remove a path outside patient storage.');
      await rm(target, { recursive: true, force: true });
    }
  }
}

async function removeOrphanedPatientRecords() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection is unavailable.');
  const patients = await Patient.find({}).distinct('_id');
  const patientStrings = patients.map(String);
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of collections) {
    if (protectedCollections.has(name)) continue;
    await db.collection(name).deleteMany({ patientId: { $exists: true, $nin: patients } });
  }
  await db.collection('outboxevents').deleteMany({ 'payload.patientId': { $exists: true, $nin: patientStrings } });
  await db.collection('notifications').deleteMany({ 'payload.patientId': { $exists: true, $nin: patientStrings } });
}

const firstNames = ['Demo Patient 01', 'Demo Patient 02', 'Demo Patient 03', 'Demo Patient 04', 'Demo Patient 05', 'Demo Patient 06', 'Demo Patient 07', 'Demo Patient 08', 'Demo Patient 09', 'Demo Patient 10', 'Demo Patient 11', 'Demo Patient 12', 'Demo Patient 13', 'Demo Patient 14', 'Demo Patient 15', 'Demo Patient 16', 'Demo Patient 17', 'Demo Patient 18', 'Demo Patient 19', 'Demo Patient 20'];

async function seedDemo(clinic: InstanceType<typeof Organization>, apexcare: InstanceType<typeof Organization>, clinician: InstanceType<typeof User>, coordinator: InstanceType<typeof User>, dietitian: InstanceType<typeof User>, seededIds: Types.ObjectId[]) {
  const now = new Date();
  const demoPasswordHash = await bcrypt.hash('DemoPatient@2026!', 10);
  const stageCounts = { referral: 0, coordinatorIntake: 0, clinicianDraftReview: 0, activeCare: 0 };

  for (let index = 0; index < DEMO_COUNT; index += 1) {
    const number = index + 1;
    const referralStage = index < 5;
    const intakeStage = index >= 5 && index < 10;
    const draftStage = index >= 10 && index < 14;
    const activeStage = index >= 14;
    const enrolled = !referralStage;
    const historyRecorded = draftStage || activeStage;
    const age = 28 + ((index * 3) % 42);
    const dob = new Date(Date.UTC(now.getUTCFullYear() - age, index % 12, 8 + (index % 18)));
    const first = firstNames[index];
    const patient = await Patient.create({
      organizationId: clinic._id,
      medicalRecordNumber: `DEMO-HTN-${String(number).padStart(3, '0')}`,
      name: { first, last: 'SYNTHETIC' },
      ageAtRegistration: age,
      ...(enrolled ? { dateOfBirth: dob } : {}),
      sexAtBirth: 'NOT_RECORDED',
      phone: `+91 00000 ${String(number).padStart(5, '0')}`,
      preferredLanguage: index % 2 ? 'ml' : 'en',
      preferredContactChannel: 'APP',
      assignedClinicianId: clinician._id,
      enrolledByUserId: enrolled ? coordinator._id : undefined,
      enrollmentStatus: referralStage ? 'NOT_ENROLLED' : intakeStage ? 'ENROLLED' : draftStage ? 'CARE_PLAN_REVIEW' : 'ACTIVE_CARE',
      conditions: [{ code: 'HYPERTENSION', status: 'CONFIRMED', diagnosedAt: new Date(now.getTime() - (number + 30) * 86400000) }],
      programmeConsent: enrolled ? { acceptedAt: now, acceptedByUserId: coordinator._id, communicationConsent: false } : undefined,
      status: 'ACTIVE',
    });
    seededIds.push(patient._id);

    await User.create({
      organizationId: clinic._id,
      name: first,
      email: `patient${String(number).padStart(2, '0')}@demo.apexcare.local`,
      passwordHash: demoPasswordHash,
      roles: ['PATIENT'],
      status: 'ACTIVE',
      mustChangePassword: false,
      patientId: patient._id,
    });
    await Diagnosis.create({ organizationId: clinic._id, patientId: patient._id, condition: 'HYPERTENSION', status: 'CONFIRMED', diagnosedAt: patient.conditions[0].diagnosedAt, diagnosedByUserId: clinician._id, source: 'CLINICIAN', notes: 'DEMO ONLY — fictional record; not a real diagnosis.' });

    await ApexCareReferral.create({
      patientId: patient._id, clinicOrganizationId: clinic._id, apexcareOrganizationId: apexcare._id,
      referredByUserId: clinician._id, condition: 'HYPERTENSION', status: referralStage ? 'PENDING_STAFF' : 'ENROLLED',
      referredAt: new Date(now.getTime() - (number + 2) * 86400000),
      staffEscalationDueAt: new Date(now.getTime() - (number - 2) * 86400000),
      ...(enrolled ? { enrolledAt: now, enrolledByUserId: coordinator._id } : {}),
    });

    if (referralStage) { stageCounts.referral += 1; continue; }

    const callStatus = intakeStage ? (index % 2 ? 'NO_ANSWER' : 'PENDING') : 'CONTACTED';
    const enrollment = await ApexCareEnrollment.create({
      patientId: patient._id, clinicOrganizationId: clinic._id, apexcareOrganizationId: apexcare._id,
      status: 'ACTIVE', enrolledAt: new Date(now.getTime() - (number - 4) * 86400000), enrolledByUserId: coordinator._id,
      coordinatorCallDueAt: new Date(now.getTime() - (number - 5) * 86400000),
      coordinatorCallStatus: callStatus,
      ...(callStatus === 'CONTACTED' ? { coordinatorCalledAt: new Date(now.getTime() - (number - 4) * 86400000) } : {}),
      generalHistoryStatus: historyRecorded ? 'RECORDED' : 'NOT_STARTED',
      ...(historyRecorded ? { generalHistoryRecordedAt: new Date(now.getTime() - 86400000) } : {}),
      dietitianAssessmentStatus: activeStage ? 'COMPLETED' : 'PENDING',
      carePlanGenerationStatus: historyRecorded ? 'COMPLETED' : 'NOT_STARTED',
      carePlanGenerationAttempt: historyRecorded ? 1 : 0,
    });
    await PatientClinicRelationship.create({ patientId: patient._id, clinicOrganizationId: clinic._id, relationshipType: 'PRIMARY', status: 'ACTIVE', startedAt: enrollment.enrolledAt });
    await ProgramConsent.create({ organizationId: clinic._id, patientId: patient._id, program: 'APEXCARE_CHRONIC_CARE', consentGiven: true, consentAt: enrollment.enrolledAt!, method: 'DIGITAL', recordedByUserId: coordinator._id, consentVersion: 'DEMO-ONLY', communicationConsent: false });
    await VitalRecord.create({ organizationId: clinic._id, patientId: patient._id, recordedAt: new Date(now.getTime() - 86400000), recordedByUserId: coordinator._id, source: 'OPD', bloodPressure: { systolic: 120 + (index % 15), diastolic: 75 + (index % 10), pulse: 70 + (index % 15) }, symptoms: [], notes: 'DEMO ONLY — synthetic measurement, not a real patient value.' });

    if (historyRecorded) {
      const history = await ApexCareGeneralHistory.create({
        enrollmentId: enrollment._id, patientId: patient._id, clinicOrganizationId: clinic._id, apexcareOrganizationId: apexcare._id,
        status: 'RECORDED', questionnaireVersion: APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION,
        answers: APEX_GENERAL_HISTORY_QUESTIONS.map((question) => ({ questionId: question.questionId, section: question.section, question: question.question, answer: 'UNKNOWN' })),
        notes: 'DEMO ONLY — all answers are synthetic unknown values.', collectedByUserId: coordinator._id, lastUpdatedByUserId: coordinator._id,
        collectedAt: new Date(now.getTime() - 86400000), recordedAt: new Date(now.getTime() - 86400000),
        events: [{ eventType: 'RECORDED', actorUserId: coordinator._id, actorRole: 'APEXCARE_COORDINATOR', createdAt: new Date(now.getTime() - 86400000) }],
      });
      enrollment.generalHistoryId = history._id;
      enrollment.carePlanGenerationAssessmentId = history._id;
      await enrollment.save();
    }

    if (intakeStage) {
      stageCounts.coordinatorIntake += 1;
      continue;
    }

    if (draftStage) {
      stageCounts.clinicianDraftReview += 1;
      const draft = await CarePlanDraft.create({
        organizationId: clinic._id, patientId: patient._id, condition: 'HYPERTENSION', status: 'CLINICIAN_REVIEW', generatedByUserId: clinician._id,
        clinicianReviewDueAt: new Date(now.getTime() + 86400000), fallbackEligibleAt: new Date(now.getTime() + 86400000),
        source: 'RULES', inputSnapshot: { demoOnly: true, coordinatorHistory: 'Synthetic UNKNOWN answers only.', ageYears: null, sexAtBirth: 'NOT_RECORDED', latestBloodPressure: { systolic: 128, diastolic: 82, recordedAt: new Date(now.getTime() - 86400000).toISOString(), source: 'Synthetic demo value — not patient data' }, dataCompleteness: { score: 50, known: ['diagnosis', 'coordinatorGeneralHistory', 'bloodPressure'], missing: ['age', 'sex', 'weight', 'opdHistory', 'medicationAdherence', 'laboratoryResults'] } },
        plan: { summary: 'DEMO ONLY — synthetic 90-day draft for clinician review; not clinical guidance. Confirm all source facts and tailor the plan before approval.', goals: [{ title: 'Maintain a verified blood pressure record', target: 'Use the measurement schedule approved by the clinician', rationale: 'Trend data supports clinical review; no target value is inferred.' }, { title: 'Attend the planned clinician review', target: 'Complete the scheduled OPD appointment', rationale: 'The clinician will assess current status and next steps.' }], tasks: [{ type: 'VITALS', title: 'Record blood pressure and weight', dueDay: 0, rationale: 'Refresh baseline measurements; record only measured values.' }, { type: 'FOLLOW_UP', title: 'Coordinator check-in', dueDay: 14, rationale: 'Check access and appointment barriers.' }, { type: 'OPD_VISIT', title: 'Clinician review', dueDay: 30, rationale: 'Assigned clinician reviews symptoms, verified measurements and treatment.' }, { type: 'OPD_VISIT', title: '90-day clinician review', dueDay: 90, rationale: 'Assigned clinician reviews progress and decides follow-up.' }], clinicalInterventionNeeded: true, confidence: 0, safetyNotes: ['DEMO ONLY — do not use for patient care.', 'Medication adherence, medication details and laboratory results are unknown and require verification.', 'AI output is a draft only; clinician approval is required before activation.'] },
      });
      enrollment.carePlanDraftId = draft._id;
      await enrollment.save();
      await DietitianAssessment.create({ patientId: patient._id, clinicOrganizationId: clinic._id, apexcareOrganizationId: apexcare._id, apexCareEnrollmentId: enrollment._id, dietitianUserId: dietitian._id, remarks: 'DEMO ONLY — synthetic dietitian chart awaiting review.', assessmentData: { schemaVersion: 1, dietaryPattern: 'Unknown (synthetic demo)', nutritionGoals: 'To be documented by dietitian' } });
      continue;
    }

    stageCounts.activeCare += 1;
    const draft = await CarePlanDraft.create({
      organizationId: clinic._id, patientId: patient._id, condition: 'HYPERTENSION', status: 'APPROVED', generatedByUserId: clinician._id,
      approvedByUserId: clinician._id, approvedAt: new Date(now.getTime() - 3 * 86400000), source: 'RULES',
      inputSnapshot: { demoOnly: true, coordinatorHistory: 'Synthetic UNKNOWN answers only.' },
      plan: { summary: 'DEMO ONLY — synthetic plan record; not clinical guidance.', goals: [{ title: 'Clinician-reviewed care coordination plan.' }], tasks: [{ type: 'FOLLOW_UP', title: 'Complete scheduled care coordination follow-up', dueDay: 14 }], clinicalInterventionNeeded: false, confidence: 0, safetyNotes: ['DEMO ONLY — fictional record.'] },
    });
    const planStart = new Date(now.getTime() - (index - 12) * 86400000);
    const plan = await CarePlan.create({ organizationId: clinic._id, patientId: patient._id, condition: 'HYPERTENSION', status: 'ACTIVE', startDate: planStart, endDate: new Date(planStart.getTime() + 90 * 86400000), goals: [{ title: 'Clinician-reviewed care coordination follow-up.' }], version: 1, createdByUserId: clinician._id, approvedByUserId: clinician._id, approvedAt: draft.approvedAt });
    const execution = await CarePlanExecution.create({ organizationId: clinic._id, patientId: patient._id, carePlanId: plan._id, condition: 'HYPERTENSION', protocolKey: 'HTN-90-DAY-IN', protocolVersion: 'DEMO', status: 'ACTIVE', startDate: planStart, endDate: plan.endDate, activationKey: `DEMO-HTN90:${patient._id}` });
    enrollment.carePlanDraftId = draft._id;
    await enrollment.save();
    const milestoneItems = [{ key: 'DAY_0_BASELINE', day: 0 }, { key: 'DAY_7_EARLY_CHECK', day: 7 }, { key: 'DAY_14_REVIEW', day: 14 }, { key: 'DAY_30_REVIEW', day: 30 }, { key: 'DAY_60_REVIEW', day: 60 }, { key: 'DAY_90_OUTCOME', day: 90 }];
    const milestones = await CarePlanMilestone.insertMany(milestoneItems.map((item) => {
      const dueAt = new Date(planStart.getTime() + item.day * 86400000);
      return { organizationId: clinic._id, patientId: patient._id, carePlanId: plan._id, executionId: execution._id, key: item.key, day: item.day, offsetDays: item.day, dueAt, status: item.day === 0 ? 'COMPLETED' : dueAt < now ? 'DUE' : 'PLANNED', reviewRequired: item.day > 0 && item.day % 7 === 0, ...(item.day === 0 ? { completedAt: dueAt, completedByUserId: clinician._id } : {}) };
    }));
    await CareTask.insertMany([
      { organizationId: clinic._id, patientId: patient._id, carePlanId: plan._id, executionId: execution._id, milestoneId: milestones[2]._id, taskKey: `DEMO-FOLLOWUP-${number}`, type: 'FOLLOW_UP', title: 'DEMO ONLY — scheduled coordinator follow-up', dueAt: new Date(now.getTime() + (index % 3) * 86400000), status: index % 2 ? 'PENDING' : 'COMPLETED', ...(index % 2 ? {} : { completedAt: now, completedByUserId: coordinator._id }) },
      { organizationId: clinic._id, patientId: patient._id, carePlanId: plan._id, executionId: execution._id, milestoneId: milestones[3]._id, taskKey: `DEMO-VITALS-${number}`, type: 'VITALS', title: 'DEMO ONLY — record demo measurement', dueAt: new Date(now.getTime() - 2 * 86400000), status: 'OVERDUE', contactStatus: 'UNANSWERED', lastContactedAt: new Date(now.getTime() - 86400000), lastContactedByUserId: coordinator._id, contactNotes: 'DEMO ONLY — synthetic contact outcome.' },
    ]);
    if (index % 2 === 0) await PatientReview.create({ organizationId: clinic._id, patientId: patient._id, carePlanId: plan._id, executionId: execution._id, milestoneId: milestones[2]._id, reviewKey: `DEMO-REVIEW-${patient._id}`, status: 'OPEN', dueAt: milestones[2].dueAt, contactStatus: 'NOT_CONTACTED', questions: [], notes: 'DEMO ONLY — synthetic review task.' });
    await OpdVisit.create({ organizationId: clinic._id, patientId: patient._id, visitAt: planStart, recordedByUserId: clinician._id, clinicianId: clinician._id, reason: 'DEMO ONLY — synthetic visit.', assessment: 'Synthetic workflow demonstration; no real clinical assessment.' });
    await DietitianAssessment.create({ patientId: patient._id, clinicOrganizationId: clinic._id, apexcareOrganizationId: apexcare._id, apexCareEnrollmentId: enrollment._id, dietitianUserId: dietitian._id, remarks: 'DEMO ONLY — synthetic dietitian-managed chart.', assessmentData: { schemaVersion: 1, dietaryPattern: 'Unknown (synthetic demo)', nutritionGoals: 'To be documented by dietitian' } });
  }
  return stageCounts;
}

async function main() {
  const databaseName = assertSafeTarget();
  await mongoose.connect(env.MONGO_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000 });
  const partialDemoPatients = await Patient.find({ medicalRecordNumber: /^DEMO-HTN-/ }).select('_id organizationId').lean();
  await removePatientLinkedData(partialDemoPatients);
  const oldPatients = await Patient.find({}).select('_id organizationId').lean();
  const oldPatientUsers = await User.find({ roles: 'PATIENT' }).select('_id').lean();
  const clinic = await Organization.findOneAndUpdate({ name: 'Apex Demo Clinic', type: 'CLINIC' }, { $set: { status: 'ACTIVE' }, $setOnInsert: { name: 'Apex Demo Clinic', type: 'CLINIC' } }, { upsert: true, new: true });
  const apexcare = await Organization.findOneAndUpdate({ name: 'ApexCare Demo', type: 'APEXCARE' }, { $set: { status: 'ACTIVE' }, $setOnInsert: { name: 'ApexCare Demo', type: 'APEXCARE' } }, { upsert: true, new: true });
  const passwordHash = await bcrypt.hash('DemoStaff@2026!', 10);
  const clinician = await User.findOneAndUpdate({ email: 'clinician@demo.apexcare.local' }, { $set: { organizationId: clinic._id, name: 'Demo Clinician', roles: ['CLINICIAN'], status: 'ACTIVE', mustChangePassword: false }, $setOnInsert: { email: 'clinician@demo.apexcare.local', passwordHash } }, { upsert: true, new: true });
  const coordinator = await User.findOneAndUpdate({ email: 'coordinator@demo.apexcare.local' }, { $set: { organizationId: clinic._id, name: 'Demo Coordinator', roles: ['CLINIC_COORDINATOR'], status: 'ACTIVE', mustChangePassword: false }, $setOnInsert: { email: 'coordinator@demo.apexcare.local', passwordHash } }, { upsert: true, new: true });
  const apexCoordinator = await User.findOneAndUpdate({ email: 'apex-coordinator@demo.apexcare.local' }, { $set: { organizationId: apexcare._id, name: 'Demo ApexCare Coordinator', roles: ['APEXCARE_COORDINATOR'], status: 'ACTIVE', mustChangePassword: false }, $setOnInsert: { email: 'apex-coordinator@demo.apexcare.local', passwordHash } }, { upsert: true, new: true });
  const dietitian = await User.findOneAndUpdate({ email: 'dietitian@demo.apexcare.local' }, { $set: { organizationId: apexcare._id, name: 'Demo Dietitian', roles: ['APEXCARE_DIETITIAN'], status: 'ACTIVE', mustChangePassword: false }, $setOnInsert: { email: 'dietitian@demo.apexcare.local', passwordHash } }, { upsert: true, new: true });
  void apexCoordinator;

  const seededIds: Types.ObjectId[] = [];
  try {
    const stageCounts = await seedDemo(clinic, apexcare, clinician, coordinator, dietitian, seededIds);
    await removePatientLinkedData(oldPatients);
    if (oldPatientUsers.length) await User.deleteMany({ _id: { $in: oldPatientUsers.map((item) => item._id) } });
    await removeOrphanedPatientRecords();
    const periodStart = new Date();
    const periodEnd = new Date(periodStart.getTime() + 365 * 24 * 60 * 60 * 1000);
    const subscription = await Subscription.findOneAndUpdate(
      { organizationId: clinic._id },
      { $set: { organizationId: clinic._id, planCode: 'TRIAL_100', status: 'TRIAL', activePatientLimit: 100, activePatientCount: DEMO_COUNT, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, billingInterval: 'MONTHLY' } },
      { upsert: true, new: true, runValidators: true },
    );
    clinic.subscriptionId = subscription._id;
    await clinic.save();
    console.log(JSON.stringify({ result: 'success', database: databaseName, removedExistingPatients: oldPatients.length, seededPatients: seededIds.length, stages: stageCounts, contactConsent: 'disabled for all demo patients', demoOnly: true }));
  } catch (error) {
    if (seededIds.length) {
      const justSeeded = await Patient.find({ _id: { $in: seededIds } }).select('_id organizationId').lean();
      await removePatientLinkedData(justSeeded);
    }
    throw error;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Demo reset failed.');
  process.exitCode = 1;
});
