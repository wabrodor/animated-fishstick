import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../queues.js', async () => {
  const actual = await vi.importActual<typeof import('../queues.js')>('../queues.js');
  return {
    ...actual,
    scheduleApexCareReferralEscalation: vi.fn().mockResolvedValue(undefined),
    scheduleCarePlanReviewSla: vi.fn().mockResolvedValue(undefined),
    scheduleCareTaskReminder: vi.fn().mockResolvedValue(undefined),
    scheduleCoordinatorCallSla: vi.fn().mockResolvedValue(undefined),
    scheduleHypertensionDraftGeneration: vi.fn().mockResolvedValue('test-care-plan-generation-job'),
    schedulePrescriptionAnalysis: vi.fn().mockResolvedValue('test-prescription-analysis-job'),
    schedulePrescriptionVerification: vi.fn().mockResolvedValue('test-prescription-verification-job'),
  };
});
import { APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION, APEX_GENERAL_HISTORY_QUESTIONS } from '../apexcare-general-history-questionnaire.js';

let mongo: MongoMemoryServer;
let app: (typeof import('../app.js'))['app'];
let connectDatabase: typeof import('../db.js')['connectDatabase'];
let disconnectDatabase: typeof import('../db.js')['disconnectDatabase'];
let issueAccessToken: typeof import('../auth.js')['issueAccessToken'];
let Organization: typeof import('../models.js')['Organization'];
let User: typeof import('../models.js')['User'];
let Patient: typeof import('../models.js')['Patient'];
let ApexCareEnrollment: typeof import('../models.js')['ApexCareEnrollment'];
let ApexCareGeneralHistory: typeof import('../models.js')['ApexCareGeneralHistory'];
let Diagnosis: typeof import('../models.js')['Diagnosis'];

let apexcareOrganizationId: string;
let clinicOrganizationId: string;
let patientId: string;
let enrollmentId: string;
let coordinatorToken: string;
let doctorToken: string;
let otherOrganizationCoordinatorToken: string;
let clinicClinicianToken: string;
let unassignedClinicClinicianToken: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGO_URI = mongo.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-that-is-at-least-32-characters-long';
  process.env.JWT_ACCESS_TTL = '15m';
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.AI_ENABLED = 'false';
  process.env.PORT = '5001';
  process.env.PRESCRIPTION_STORAGE_DIR = './test-prescriptions';

  ({ app } = await import('../app.js'));
  ({ connectDatabase, disconnectDatabase } = await import('../db.js'));
  ({ issueAccessToken } = await import('../auth.js'));
  ({ Organization, User, Patient, ApexCareEnrollment, ApexCareGeneralHistory, Diagnosis } = await import('../models.js'));
  await connectDatabase();
  await Promise.all([Organization.init(), User.init(), Patient.init(), ApexCareEnrollment.init(), ApexCareGeneralHistory.init()]);
});

afterAll(async () => {
  await disconnectDatabase();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    Organization.deleteMany({}), User.deleteMany({}), Patient.deleteMany({}),
    ApexCareEnrollment.deleteMany({}), ApexCareGeneralHistory.deleteMany({}),
  ]);

  const [apex, clinic, otherApex] = await Organization.create([
    { name: 'ApexCare Primary', type: 'APEXCARE', status: 'ACTIVE' },
    { name: 'Partner Clinic', type: 'CLINIC', status: 'ACTIVE' },
    { name: 'ApexCare Other Tenant', type: 'APEXCARE', status: 'ACTIVE' },
  ]);
  apexcareOrganizationId = String(apex._id);
  clinicOrganizationId = String(clinic._id);

  const [clinicClinician, unassignedClinicClinician] = await User.create([
    { organizationId: clinic._id, name: 'Clinic Clinician', email: 'clinic-clinician@test.local', passwordHash: 'not-used', roles: ['CLINICIAN'] },
    { organizationId: clinic._id, name: 'Unassigned Clinic Clinician', email: 'unassigned-clinician@test.local', passwordHash: 'not-used', roles: ['CLINICIAN'] },
  ]);
  const [coordinator, doctor, otherCoordinator] = await User.create([
    { organizationId: apex._id, name: 'Apex Coordinator', email: 'apex-coordinator@test.local', passwordHash: 'not-used', roles: ['APEXCARE_COORDINATOR'] },
    { organizationId: apex._id, name: 'Apex Doctor', email: 'apex-doctor@test.local', passwordHash: 'not-used', roles: ['APEXCARE_DOCTOR'] },
    { organizationId: otherApex._id, name: 'Other Coordinator', email: 'other-coordinator@test.local', passwordHash: 'not-used', roles: ['APEXCARE_COORDINATOR'] },
  ]);

  const patient = await Patient.create({
    organizationId: clinic._id,
    medicalRecordNumber: 'GH-TEST-001',
    name: { first: 'History', last: 'Patient' },
    assignedClinicianId: clinicClinician._id,
    status: 'ACTIVE',
  });
  patientId = String(patient._id);

  const enrollment = await ApexCareEnrollment.create({
    patientId: patient._id,
    clinicOrganizationId: clinic._id,
    apexcareOrganizationId: apex._id,
    status: 'ACTIVE',
    coordinatorCallStatus: 'PENDING',
    coordinatorCallDueAt: new Date(),
  });
  enrollmentId = String(enrollment._id);

  coordinatorToken = issueAccessToken({ userId: String(coordinator._id), organizationId: apexcareOrganizationId, roles: ['APEXCARE_COORDINATOR'] });
  doctorToken = issueAccessToken({ userId: String(doctor._id), organizationId: apexcareOrganizationId, roles: ['APEXCARE_DOCTOR'] });
  otherOrganizationCoordinatorToken = issueAccessToken({ userId: String(otherCoordinator._id), organizationId: String(otherApex._id), roles: ['APEXCARE_COORDINATOR'] });
  clinicClinicianToken = issueAccessToken({ userId: String(clinicClinician._id), organizationId: clinicOrganizationId, roles: ['CLINICIAN'] });
  unassignedClinicClinicianToken = issueAccessToken({ userId: String(unassignedClinicClinician._id), organizationId: clinicOrganizationId, roles: ['CLINICIAN'] });
});

function auth(token: string) { return { Authorization: `Bearer ${token}` }; }

function completeAnswers() {
  return APEX_GENERAL_HISTORY_QUESTIONS.map((question) => ({
    questionId: question.questionId,
    section: question.section,
    question: question.question,
    answer: question.questionId === 'past-diabetes' || question.questionId === 'medicine-allergy' ? 'YES' : 'NO',
    details: question.questionId === 'past-diabetes' ? 'Diagnosed approximately two years ago.' : question.questionId === 'medicine-allergy' ? 'Reported rash after a previous medicine; exact name to verify.' : undefined,
  }));
}

describe('ApexCare general-history recording and Patient 360 snapshot', () => {
  it('rejects clinician patient registration when age is missing', async () => {
    const response = await request(app)
      .post('/api/v1/patients')
      .set(auth(clinicClinicianToken))
      .send({ medicalRecordNumber: 'AGE-MISSING-001', name: { first: 'Test' }, diagnosis: { condition: 'HYPERTENSION' } });
    expect(response.status).toBe(400);
    expect(await Patient.countDocuments({ organizationId: clinicOrganizationId, medicalRecordNumber: 'AGE-MISSING-001' })).toBe(0);
  });

  it('blocks enrollment until clinic coordinator records date of birth', async () => {
    const patient = await Patient.findById(patientId).lean();
    expect(patient?.assignedClinicianId).toBeTruthy();
    await Patient.updateOne({ _id: patientId, organizationId: clinicOrganizationId }, { $set: { phone: '+919876543210' } });
    await Diagnosis.create({
      organizationId: clinicOrganizationId,
      patientId,
      condition: 'HYPERTENSION',
      status: 'CONFIRMED',
      diagnosedAt: new Date(),
      diagnosedByUserId: patient!.assignedClinicianId,
      source: 'CLINICIAN',
    });

    const response = await request(app)
      .post(`/api/v1/patients/${patientId}/enrol`)
      .set(auth(clinicClinicianToken))
      .send({ communicationConsent: true, consentMethod: 'VERBAL', consentVersion: 'test-v1' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('PATIENT_DOB_REQUIRED');
    expect((await Patient.findById(patientId).lean())?.enrollmentStatus).toBe('NOT_ENROLLED');
  });

  it('keeps a contacted patient in the coordinator queue until history is recorded', async () => {
    const contact = await request(app).patch(`/api/v1/apexcare/enrollments/${enrollmentId}/coordinator-call`).set(auth(coordinatorToken)).send({ status: 'CONTACTED' });
    expect(contact.status).toBe(200);

    const queue = await request(app).get('/api/v1/apexcare/coordinator-queue').set(auth(coordinatorToken));
    expect(queue.status).toBe(200);
    expect(queue.body.data).toHaveLength(1);
    expect(queue.body.data[0].coordinatorCallStatus).toBe('CONTACTED');
    expect(queue.body.data[0].generalHistoryStatus).toBe('NOT_STARTED');
  });

  it('saves a draft and restores it through the coordinator history endpoint', async () => {
    const answer = completeAnswers()[0];
    const saved = await request(app)
      .put(`/api/v1/apexcare/enrollments/${enrollmentId}/general-history`)
      .set(auth(coordinatorToken))
      .send({ questionnaireVersion: APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION, answers: [answer], notes: 'Patient reached by phone.' });
    expect(saved.status).toBe(200);
    expect(saved.body.data.status).toBe('IN_PROGRESS');
    expect(saved.body.data.collectedByUserId).toBeTruthy();
    expect(saved.body.data.events.at(-1).eventType).toBe('DRAFT_SAVED');

    const loaded = await request(app).get(`/api/v1/apexcare/enrollments/${enrollmentId}/general-history`).set(auth(coordinatorToken));
    expect(loaded.status).toBe(200);
    expect(loaded.body.data.answers).toHaveLength(1);
    expect(loaded.body.data.notes).toBe('Patient reached by phone.');

    const queue = await request(app).get('/api/v1/apexcare/coordinator-queue').set(auth(coordinatorToken));
    expect(queue.body.data).toHaveLength(1);
    expect(queue.body.data[0].generalHistoryStatus).toBe('IN_PROGRESS');
  });

  it('rejects incomplete recording, then records complete patient-reported history without clinician approval', async () => {
    await request(app)
      .patch(`/api/v1/apexcare/enrollments/${enrollmentId}/coordinator-call`)
      .set(auth(coordinatorToken))
      .send({ status: 'CONTACTED' });

    const incomplete = await request(app)
      .put(`/api/v1/apexcare/enrollments/${enrollmentId}/general-history`)
      .set(auth(coordinatorToken))
      .send({ questionnaireVersion: APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION, answers: [completeAnswers()[0]], record: true });
    expect(incomplete.status).toBe(422);

    const recorded = await request(app)
      .put(`/api/v1/apexcare/enrollments/${enrollmentId}/general-history`)
      .set(auth(coordinatorToken))
      .send({ questionnaireVersion: APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION, answers: completeAnswers(), record: true });
    expect(recorded.status).toBe(200);
    expect(recorded.body.data.status).toBe('RECORDED');
    expect(recorded.body.data.recordedAt).toBeTruthy();
    expect(recorded.body.data.events.at(-1).eventType).toBe('RECORDED');
    expect(recorded.body.data.events.at(-1).actorRole).toBe('APEXCARE_COORDINATOR');

    const enrollment = await ApexCareEnrollment.findById(enrollmentId).lean();
    expect(enrollment?.generalHistoryStatus).toBe('RECORDED');
    expect(enrollment?.generalHistoryRecordedAt).toBeTruthy();
    expect(enrollment?.coordinatorCallStatus).toBe('CONTACTED');
    expect(enrollment?.coordinatorCalledAt).toBeTruthy();
    expect(await ApexCareGeneralHistory.countDocuments({ enrollmentId })).toBe(1);

    const coordinatorQueue = await request(app).get('/api/v1/apexcare/coordinator-queue').set(auth(coordinatorToken));
    expect(coordinatorQueue.body.data).toHaveLength(0);

    const legacyReviewQueue = await request(app).get('/api/v1/apexcare/general-history-review-queue').set(auth(doctorToken));
    expect(legacyReviewQueue.status).toBe(404);
  });

  it('serves a read-only history snapshot to the assigned clinic clinician in Patient 360', async () => {
    const beforeRecording = await request(app)
      .get(`/api/v1/patients/${patientId}/apexcare/general-history`)
      .set(auth(clinicClinicianToken));
    expect(beforeRecording.status).toBe(200);
    expect(beforeRecording.body.data).toBeNull();

    const draft = await request(app)
      .put(`/api/v1/apexcare/enrollments/${enrollmentId}/general-history`)
      .set(auth(coordinatorToken))
      .send({ questionnaireVersion: APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION, answers: [completeAnswers()[0]], notes: 'Draft only; not yet recorded.' });
    expect(draft.status).toBe(200);
    expect(draft.body.data.status).toBe('IN_PROGRESS');

    const draftSnapshot = await request(app)
      .get(`/api/v1/patients/${patientId}/apexcare/general-history`)
      .set(auth(clinicClinicianToken));
    expect(draftSnapshot.status).toBe(200);
    expect(draftSnapshot.body.data).toBeNull();

    const recorded = await request(app)
      .put(`/api/v1/apexcare/enrollments/${enrollmentId}/general-history`)
      .set(auth(coordinatorToken))
      .send({ questionnaireVersion: APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION, answers: completeAnswers(), notes: 'Patient-reported baseline.', record: true });
    expect(recorded.status).toBe(200);

    const snapshot = await request(app)
      .get(`/api/v1/patients/${patientId}/apexcare/general-history`)
      .set(auth(clinicClinicianToken));
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.data.status).toBe('RECORDED');
    expect(snapshot.body.data.source).toBe('APEXCARE_COORDINATOR');
    expect(snapshot.body.data.answers).toHaveLength(APEX_GENERAL_HISTORY_QUESTIONS.length);
    expect(snapshot.body.data.collectedByName).toBe('Apex Coordinator');
    expect(snapshot.body.data.notes).toBe('Patient-reported baseline.');
    expect(snapshot.body.data.reviewedByUserId).toBeUndefined();
  });

  it('locks an already recorded history to prevent silent overwrites', async () => {
    const recorded = await request(app)
      .put(`/api/v1/apexcare/enrollments/${enrollmentId}/general-history`)
      .set(auth(coordinatorToken))
      .send({ questionnaireVersion: APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION, answers: completeAnswers(), record: true });
    expect(recorded.status).toBe(200);

    const attemptedEdit = await request(app)
      .put(`/api/v1/apexcare/enrollments/${enrollmentId}/general-history`)
      .set(auth(coordinatorToken))
      .send({ questionnaireVersion: APEX_GENERAL_HISTORY_QUESTIONNAIRE_VERSION, answers: completeAnswers(), record: false });
    expect(attemptedEdit.status).toBe(409);
    expect(attemptedEdit.body.error.code).toBe('GENERAL_HISTORY_ALREADY_RECORDED');
  });

  it('allows cross-origin browser preflight for the draft-save PUT request', async () => {
    const response = await request(app)
      .options(`/api/v1/apexcare/enrollments/${enrollmentId}/general-history`)
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-methods']).toContain('PUT');
  });

  it('enforces role, tenant and assigned-clinician isolation', async () => {
    const doctorOnCoordinatorEndpoint = await request(app)
      .get(`/api/v1/apexcare/enrollments/${enrollmentId}/general-history`)
      .set(auth(doctorToken));
    expect(doctorOnCoordinatorEndpoint.status).toBe(403);

    const apexDoctorOnClinicSnapshot = await request(app)
      .get(`/api/v1/patients/${patientId}/apexcare/general-history`)
      .set(auth(doctorToken));
    expect(apexDoctorOnClinicSnapshot.status).toBe(403);

    const unassignedClinicianRead = await request(app)
      .get(`/api/v1/patients/${patientId}/apexcare/general-history`)
      .set(auth(unassignedClinicClinicianToken));
    expect(unassignedClinicianRead.status).toBe(404);

    const otherTenantRead = await request(app)
      .get(`/api/v1/apexcare/enrollments/${enrollmentId}/general-history`)
      .set(auth(otherOrganizationCoordinatorToken));
    expect(otherTenantRead.status).toBe(404);

    const removedReviewEndpoint = await request(app)
      .patch('/api/v1/apexcare/general-histories/507f1f77bcf86cd799439011/review')
      .set(auth(doctorToken))
      .send({ decision: 'APPROVE' });
    expect(removedReviewEndpoint.status).toBe(404);
  });
});
