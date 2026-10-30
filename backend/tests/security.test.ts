import bcrypt from 'bcrypt';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../queues.js', async () => {
  const actual = await vi.importActual<typeof import('../queues.js')>('../queues.js');
  return {
    ...actual,
    schedulePrescriptionAnalysis: vi.fn().mockResolvedValue('test-prescription-analysis-job'),
    schedulePrescriptionVerification: vi.fn().mockResolvedValue('test-prescription-verification-job'),
    scheduleHypertensionDraftGeneration: vi.fn().mockResolvedValue('test-care-plan-generation-job'),
  };
});

let mongo: MongoMemoryServer;

let app: (typeof import('../app.js'))['app'];
let connectDatabase: typeof import('../db.js')['connectDatabase'];
let disconnectDatabase: typeof import('../db.js')['disconnectDatabase'];
let issueAccessToken: typeof import('../auth.js')['issueAccessToken'];

let Organization: typeof import('../models.js')['Organization'];
let User: typeof import('../models.js')['User'];
let Patient: typeof import('../models.js')['Patient'];
let Diagnosis: typeof import('../models.js')['Diagnosis'];
let CarePlan: typeof import('../models.js')['CarePlan'];
let CarePlanExecution: typeof import('../models.js')['CarePlanExecution'];
let CarePlanMilestone: typeof import('../models.js')['CarePlanMilestone'];
let ServiceCase: typeof import('../models.js')['ServiceCase'];
let VitalRecord: typeof import('../models.js')['VitalRecord'];
let OpdVisit: typeof import('../models.js')['OpdVisit'];
let Subscription: typeof import('../models.js')['Subscription'];
let ApexCareEnrollment: typeof import('../models.js')['ApexCareEnrollment'];
let DietitianAssessment: typeof import('../models.js')['DietitianAssessment'];
let ApexCareReferral: typeof import('../models.js')['ApexCareReferral'];
let PrescriptionDocument: typeof import('../models.js')['PrescriptionDocument'];
let LabDocument: typeof import('../models.js')['LabDocument'];
let MedicationDraft: typeof import('../models.js')['MedicationDraft'];
let MedicationRecord: typeof import('../models.js')['MedicationRecord'];
let MedicationHistory: typeof import('../models.js')['MedicationHistory'];
let ClinicalReviewCase: typeof import('../models.js')['ClinicalReviewCase'];
let ClinicalReviewEvent: typeof import('../models.js')['ClinicalReviewEvent'];
let PatientClinicRelationship: typeof import('../models.js')['PatientClinicRelationship'];

let organizationId: string;
let organizationBId: string;
let apexcareOrganizationId: string;

let clinicianAId: string;
let clinicianBId: string;
let clinicianCId: string;
let coordinatorId: string;

let patientId: string;
let patientBId: string;

const testPrescriptionImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';

let clinicianAToken: string;
let clinicianBToken: string;
let clinicianCToken: string;
let coordinatorToken: string;
let temporaryClinicianToken: string;

let apexcareCoordinatorId: string;
let apexcareDietitianAId: string;
let apexcareDietitianBId: string;
let apexcareSpecialistAId: string;
let apexcareSpecialistBId: string;
let apexcareDoctorId: string;

let apexcareCoordinatorToken: string;
let apexcareDietitianAToken: string;
let apexcareDietitianBToken: string;
let apexcareSpecialistAToken: string;
let apexcareSpecialistBToken: string;
let apexcareDoctorToken: string;
let apexcareOrganization: any;


beforeAll(async () => {
  mongo = await MongoMemoryServer.create();

  process.env.NODE_ENV = 'test';
  process.env.MONGO_URI = mongo.getUri();
  process.env.JWT_ACCESS_SECRET =
    'test-secret-that-is-at-least-32-characters-long';
  process.env.JWT_ACCESS_TTL = '15m';
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.AI_ENABLED = 'false';
  process.env.PORT = '5001';
  process.env.PRESCRIPTION_STORAGE_DIR = './test-prescriptions';

  ({ app } = await import('../app.js'));
  ({ connectDatabase, disconnectDatabase } = await import('../db.js'));
  ({ issueAccessToken } = await import('../auth.js'));

  ({
    Organization,
    User,
    Patient,
    Diagnosis,
    CarePlan,
    CarePlanExecution,
    CarePlanMilestone,
    ServiceCase,
    VitalRecord,
    OpdVisit,
    Subscription,
    ApexCareEnrollment,
    DietitianAssessment,
    ApexCareReferral,
    PrescriptionDocument,
    LabDocument,
    MedicationDraft,
    MedicationRecord,
    MedicationHistory,
    ClinicalReviewCase,
    ClinicalReviewEvent,
    PatientClinicRelationship,
  } = await import('../models.js'));

  await connectDatabase();
  await Promise.all([CarePlanExecution.init(), CarePlanMilestone.init()]);
});

afterAll(async () => {
  await disconnectDatabase();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    Organization.deleteMany({}),
    User.deleteMany({}),
    Patient.deleteMany({}),
    Diagnosis.deleteMany({}),
    CarePlan.deleteMany({}),
    CarePlanExecution.deleteMany({}),
    CarePlanMilestone.deleteMany({}),
    ServiceCase.deleteMany({}),
    VitalRecord.deleteMany({}),
    OpdVisit.deleteMany({}),
    Subscription.deleteMany({}),
    ApexCareEnrollment.deleteMany({}),
    DietitianAssessment.deleteMany({}),
    ApexCareReferral.deleteMany({}),
    PrescriptionDocument.deleteMany({}),
    LabDocument.deleteMany({}),
    MedicationDraft.deleteMany({}),
    MedicationRecord.deleteMany({}),
    MedicationHistory.deleteMany({}),
    ClinicalReviewCase.deleteMany({}),
    ClinicalReviewEvent.deleteMany({}),
    PatientClinicRelationship.deleteMany({}),
  ]);

  /*
   * ------------------------------------------------------------
   * ORGANIZATION A
   * ------------------------------------------------------------
   */

  const organization = await Organization.create({
    name: 'Security Test Clinic A',
    type: 'CLINIC',
    status: 'ACTIVE',
  });

  organizationId = String(organization._id);

  const now = new Date();

   await Subscription.create({
  organizationId: organization._id,

  status: 'ACTIVE',

  planCode: 'BASIC',

  activePatientLimit: 100,

  activePatientCount: 0,

  currentPeriodStart: new Date(
    now.getTime() -
      24 * 60 * 60 * 1000,
  ),

  currentPeriodEnd: new Date(
    now.getTime() +
      30 * 24 * 60 * 60 * 1000,
  ),
});

  /*
   * ------------------------------------------------------------
   * ORGANIZATION B
   * ------------------------------------------------------------
   */

  const organizationB = await Organization.create({
    name: 'Security Test Clinic B',
    type: 'CLINIC',
    status: 'ACTIVE',
  });

  organizationBId = String(organizationB._id);

  apexcareOrganization = await Organization.create({
    name: 'ApexCare',
    type: 'APEXCARE',
    status: 'ACTIVE',
  });
  apexcareOrganizationId = String(apexcareOrganization._id);

  const passwordHash = await bcrypt.hash('TestPassword@123', 4);

  /*
   * ------------------------------------------------------------
   * CLINIC A USERS
   * ------------------------------------------------------------
   */

  const [
    clinicianA,
    clinicianB,
    coordinator,
    temporaryClinician,
  ] = await User.create([
    {
      organizationId: organization._id,
      name: 'Clinician A',
      email: 'clinician-a@test.local',
      passwordHash,
      roles: ['CLINICIAN'],
    },
    {
      organizationId: organization._id,
      name: 'Clinician B',
      email: 'clinician-b@test.local',
      passwordHash,
      roles: ['CLINICIAN'],
    },
    {
      organizationId: organization._id,
      name: 'Coordinator',
      email: 'coordinator@test.local',
      passwordHash,
      roles: ['CLINIC_COORDINATOR'],
    },
    {
      organizationId: organization._id,
      name: 'Temporary Clinician',
      email: 'temporary@test.local',
      passwordHash,
      roles: ['CLINICIAN'],
      mustChangePassword: true,
    },
  ]);

  /*
   * ------------------------------------------------------------
   * CLINIC B USER
   * ------------------------------------------------------------
   */

  const clinicianC = await User.create({
    organizationId: organizationB._id,
    name: 'Clinician C',
    email: 'clinician-c@test.local',
    passwordHash,
    roles: ['CLINICIAN'],
  });

  clinicianAId = String(clinicianA._id);
  clinicianBId = String(clinicianB._id);
  clinicianCId = String(clinicianC._id);
  coordinatorId = String(coordinator._id);

  /*
   * ------------------------------------------------------------
   * PATIENT A
   * ------------------------------------------------------------
   */

  const patient = await Patient.create({
    organizationId: organization._id,
    medicalRecordNumber: 'SEC-A-0001',
    name: {
      first: 'Security',
      last: 'Patient A',
    },
    phone: '9999999999',
    assignedClinicianId: clinicianA._id,
    conditions: [
      {
        code: 'HYPERTENSION',
        status: 'CONFIRMED',
        diagnosedAt: new Date(),
      },
    ],
    enrollmentStatus: 'NOT_ENROLLED',
    status: 'ACTIVE',
  });

  patientId = String(patient._id);

  await PatientClinicRelationship.create({
    patientId: patient._id,
    clinicOrganizationId: organization._id,
    relationshipType: 'PRIMARY',
    status: 'ACTIVE',
    startedAt: new Date(),
  });

  /*
   * ------------------------------------------------------------
   * PATIENT A DIAGNOSIS
   * ------------------------------------------------------------
   */

  await Diagnosis.create({
    organizationId: organization._id,
    patientId: patient._id,
    condition: 'HYPERTENSION',
    status: 'CONFIRMED',
    diagnosedAt: new Date(),
    diagnosedByUserId: clinicianA._id,
    source: 'CLINICIAN',
  });

  const apexcareDoctor = await User.create({
    organizationId: apexcareOrganization._id,
    name: 'ApexCare Doctor',
    email: 'apexcare-doctor@test.local',
    passwordHash,
    roles: ['APEXCARE_DOCTOR'],
  });
  apexcareDoctorId = String(apexcareDoctor._id);

  const referralAt = new Date();
  await ApexCareReferral.create({
    patientId: patient._id,
    clinicOrganizationId: organization._id,
    apexcareOrganizationId: apexcareOrganization._id,
    referredByUserId: clinicianA._id,
    condition: 'HYPERTENSION',
    status: 'PENDING_STAFF',
    referredAt: referralAt,
    staffEscalationDueAt: new Date(referralAt.getTime() + 12 * 60 * 60 * 1000),
  });

  /*
   * ------------------------------------------------------------
   * PATIENT B
   * ------------------------------------------------------------
   *
   * This patient belongs to Organization B.
   * Clinic A must never be able to access this patient.
   */

  const patientB = await Patient.create({
    organizationId: organizationB._id,
    medicalRecordNumber: 'SEC-B-0001',
    name: {
      first: 'Security',
      last: 'Patient B',
    },
    phone: '8888888888',
    assignedClinicianId: clinicianC._id,
    conditions: [
      {
        code: 'HYPERTENSION',
        status: 'CONFIRMED',
        diagnosedAt: new Date(),
      },
    ],
    enrollmentStatus: 'NOT_ENROLLED',
    status: 'ACTIVE',
  });

  patientBId = String(patientB._id);

  await PatientClinicRelationship.create({
    patientId: patientB._id,
    clinicOrganizationId: organizationB._id,
    relationshipType: 'PRIMARY',
    status: 'ACTIVE',
    startedAt: new Date(),
  });

  /*
   * ------------------------------------------------------------
   * PATIENT B DIAGNOSIS
   * ------------------------------------------------------------
   *
   * Deliberately create real clinical data so that an empty
   * result cannot make a tenant-isolation test pass accidentally.
   */

  await Diagnosis.create({
    organizationId: organizationB._id,
    patientId: patientB._id,
    condition: 'HYPERTENSION',
    status: 'CONFIRMED',
    diagnosedAt: new Date(),
    diagnosedByUserId: clinicianC._id,
    source: 'CLINICIAN',
  });

  /*
   * ------------------------------------------------------------
   * TOKENS
   * ------------------------------------------------------------
   */

  clinicianAToken = issueAccessToken({
    userId: clinicianAId,
    organizationId,
    roles: ['CLINICIAN'],
  });

  clinicianBToken = issueAccessToken({
    userId: clinicianBId,
    organizationId,
    roles: ['CLINICIAN'],
  });

  clinicianCToken = issueAccessToken({
    userId: clinicianCId,
    organizationId: organizationBId,
    roles: ['CLINICIAN'],
  });

  coordinatorToken = issueAccessToken({
    userId: String(coordinator._id),
    organizationId,
    roles: ['CLINIC_COORDINATOR'],
  });

  temporaryClinicianToken = issueAccessToken({
    userId: String(temporaryClinician._id),
    organizationId,
    roles: ['CLINICIAN'],
  });

  apexcareDoctorToken = issueAccessToken({
    userId: apexcareDoctorId,
    organizationId: apexcareOrganizationId,
    roles: ['APEXCARE_DOCTOR'],
  });
});

/*
 * ============================================================
 * SECURITY BOUNDARIES
 * ============================================================
 */

describe('security boundaries', () => {
  it('blocks a clinic coordinator from fetching another clinic lab source file', async () => {
    const foreignPatient = await Patient.findById(patientBId).lean();
    expect(foreignPatient).toBeTruthy();
    const document = await LabDocument.create({
      patientId: patientBId,
      clinicOrganizationId: organizationBId,
      apexcareOrganizationId,
      source: 'LAB_PDF',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      storageKey: 'labs/not-a-real-object.pdf',
      storageProvider: 'local',
      sizeBytes: 8,
      sha256: 'a'.repeat(64),
      idempotencyKey: `foreign-${Date.now()}`,
      uploadedByUserId: clinicianCId,
    });

    const response = await request(app)
      .get(`/api/v1/patients/${patientBId}/lab-documents/${String(document._id)}/file`)
      .set('Authorization', `Bearer ${coordinatorToken}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PATIENT_NOT_FOUND');
  });

  /*
   * ----------------------------------------------------------
   * EXISTING CLINIC-LEVEL TESTS
   * ----------------------------------------------------------
   */

  it('allows the assigned clinician to read diagnoses', async () => {
    const response = await request(app)
      .get(`/api/v1/patients/${patientId}/diagnoses`)
      .set('Authorization', `Bearer ${clinicianAToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
  });

  it('prevents another clinician from reading diagnoses for an unassigned patient', async () => {
    const response = await request(app)
      .get(`/api/v1/patients/${patientId}/diagnoses`)
      .set('Authorization', `Bearer ${clinicianBToken}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PATIENT_NOT_FOUND');
  });

  it('prevents another clinician from reading care plans for an unassigned patient', async () => {
    const response = await request(app)
      .get(`/api/v1/patients/${patientId}/care-plans`)
      .set('Authorization', `Bearer ${clinicianBToken}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PATIENT_NOT_FOUND');
  });

  it('prevents a coordinator from creating a clinical ApexCare service request', async () => {
    const response = await request(app)
      .post(`/api/v1/patients/${patientId}/service-cases`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({
        service: 'DIETITIAN',
        reason: 'Lifestyle counselling requested.',
      });

    expect(response.status).toBe(403);
  });

  it('allows the assigned clinician to create an ApexCare service request', async () => {
    await ApexCareEnrollment.create({
      patientId,
      clinicOrganizationId: organizationId,
      apexcareOrganizationId,
      status: 'ACTIVE',
      enrolledAt: new Date(),
      enrolledByUserId: coordinatorId,
    });

    const response = await request(app)
      .post(`/api/v1/patients/${patientId}/service-cases`)
      .set('Authorization', `Bearer ${clinicianAToken}`)
      .send({
        service: 'DIETITIAN',
        reason: 'Lifestyle counselling requested.',
      });

    expect(response.status).toBe(201);
    expect(response.body.data.requestedByUserId).toBe(clinicianAId);
  });

  it('prevents another clinician from creating a service request for an unassigned patient', async () => {
    const response = await request(app)
      .post(`/api/v1/patients/${patientId}/service-cases`)
      .set('Authorization', `Bearer ${clinicianBToken}`)
      .send({
        service: 'ENDOCRINOLOGY',
        reason: 'Specialist review requested.',
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('PATIENT_NOT_ASSIGNED');
  });

  it('blocks temporary-password users from clinical routes until the password is changed', async () => {
    const response = await request(app)
      .get('/api/v1/patients')
      .set('Authorization', `Bearer ${temporaryClinicianToken}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('does not allow care-plan draft generation before ApexCare enrolment', async () => {
    const response = await request(app)
      .post(`/api/v1/patients/${patientId}/hypertension/care-plan-drafts`)
      .set('Authorization', `Bearer ${clinicianAToken}`)
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CARE_PLAN_GENERATION_OWNED_BY_APEXCARE');
  });

  /*
   * ----------------------------------------------------------
   * TENANT ISOLATION
   * ----------------------------------------------------------
   *
   * Clinic A must never access Clinic B's patient data.
   */

  it('prevents a clinician from another organization from reading a patient', async () => {
    const response = await request(app)
      .get(`/api/v1/patients/${patientBId}`)
      .set('Authorization', `Bearer ${clinicianAToken}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PATIENT_NOT_FOUND');
  });

  it('prevents cross-organization diagnosis access', async () => {
    const response = await request(app)
      .get(`/api/v1/patients/${patientBId}/diagnoses`)
      .set('Authorization', `Bearer ${clinicianAToken}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PATIENT_NOT_FOUND');
  });

  it('prevents cross-organization care-plan access', async () => {
    /*
     * Create an actual care plan in Organization B.
     * This ensures we are testing isolation rather than absence of data.
     */
    await CarePlan.create({
      organizationId: organizationBId,
      patientId: patientBId,
      condition: 'HYPERTENSION',
      status: 'ACTIVE',
      startDate: new Date(),
      endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      goals: [
        {
          title: 'Monitor blood pressure',
          target: 'Daily',
        },
      ],
      version: 1,
      createdByUserId: clinicianCId,
      approvedByUserId: clinicianCId,
      approvedAt: new Date(),
    });

    const response = await request(app)
      .get(`/api/v1/patients/${patientBId}/care-plans`)
      .set('Authorization', `Bearer ${clinicianAToken}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PATIENT_NOT_FOUND');
  });

  it('prevents cross-organization vital-record access', async () => {
    await VitalRecord.create({
      organizationId: organizationBId,
      patientId: patientBId,
      recordedAt: new Date(),
      recordedByUserId: clinicianCId,
      source: 'OPD',
      bloodPressure: {
        systolic: 140,
        diastolic: 90,
        pulse: 78,
      },
    });

    const response = await request(app)
      .get(`/api/v1/patients/${patientBId}/vitals`)
      .set('Authorization', `Bearer ${clinicianAToken}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PATIENT_NOT_FOUND');
  });

  it('prevents cross-organization OPD access', async () => {
    await OpdVisit.create({
      organizationId: organizationBId,
      patientId: patientBId,
      visitAt: new Date(),
      recordedByUserId: clinicianCId,
      clinicianId: clinicianCId,
      reason: 'Security isolation test',
    });

    const response = await request(app)
      .get(`/api/v1/patients/${patientBId}/opd-visits`)
      .set('Authorization', `Bearer ${clinicianAToken}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PATIENT_NOT_FOUND');
  });

  it('prevents a clinician from another organization from creating a service request', async () => {
    const response = await request(app)
      .post(`/api/v1/patients/${patientBId}/service-cases`)
      .set('Authorization', `Bearer ${clinicianAToken}`)
      .send({
        service: 'DIETITIAN',
        reason: 'Cross-organization security test.',
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PATIENT_NOT_FOUND');

    /*
     * Verify that no unauthorized service case was created.
     */
    const createdCases = await ServiceCase.find({
      organizationId: organizationBId,
      patientId: patientBId,
    }).lean();

    expect(createdCases).toHaveLength(0);
  });

  /*
   * ----------------------------------------------------------
   * POSITIVE CROSS-TENANT CONTROL
   * ----------------------------------------------------------
   *
   * Clinic B's assigned clinician must still be able to access
   * Clinic B's own patient. This prevents a false-positive test
   * where the route simply blocks everyone.
   */

  it('allows the correct clinician from organization B to read organization B patient data', async () => {
    const response = await request(app)
      .get(`/api/v1/patients/${patientBId}/diagnoses`)
      .set('Authorization', `Bearer ${clinicianCToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
  });
});

describe('ApexCare provider security boundaries', () => {

  it('exposes coordinator-contacted enrollments in the dietitian care-plan queue', async () => {
    await ApexCareEnrollment.updateOne(
      { patientId, apexcareOrganizationId },
      { $set: {
        status: 'ACTIVE',
        enrolledAt: new Date(),
        enrolledByUserId: coordinatorId,
        coordinatorCallStatus: 'CONTACTED',
        dietitianAssessmentStatus: 'PENDING',
        carePlanGenerationStatus: 'NOT_STARTED',
        carePlanGenerationAttempt: 0,
        carePlanGenerationAssessmentId: undefined,
        carePlanGenerationError: undefined,
      } },
    );
    await Patient.updateOne({ _id: patientId, organizationId }, { $set: { enrollmentStatus: 'ENROLLED' } });

    const response = await request(app)
      .get('/api/v1/apexcare/dietitian-queue')
      .set('Authorization', `Bearer ${apexcareDietitianAToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data.some((item: { patientId: string }) => item.patientId === patientId)).toBe(true);
    const handedOff = response.body.data.find((item: { patientId: string }) => item.patientId === patientId);
    expect(handedOff.coordinatorCallStatus).toBe('CONTACTED');
    expect(handedOff.patient._id).toBe(patientId);
    expect(handedOff.carePlanGenerationStatus).toBe('NOT_STARTED');
  });

  it('does not allow the ApexCare coordinator role to read the dietitian queue endpoint', async () => {
    const response = await request(app)
      .get('/api/v1/apexcare/dietitian-queue')
      .set('Authorization', `Bearer ${apexcareCoordinatorToken}`);
    expect(response.status).toBe(403);
  });

  it('requires coordinator contact before dietitian assessment', async () => {
    await ApexCareEnrollment.updateOne(
      { patientId, apexcareOrganizationId },
      {
        $set: {
          status: 'ACTIVE',
          enrolledAt: new Date(),
          enrolledByUserId: coordinatorId,
          coordinatorCallStatus: 'PENDING',
          dietitianAssessmentStatus: 'PENDING',
          carePlanGenerationStatus: 'NOT_STARTED',
          carePlanGenerationAttempt: 0,
          carePlanGenerationAssessmentId: undefined,
          carePlanGenerationError: undefined,
        },
      },
    );
    await Patient.updateOne({ _id: patientId, organizationId }, { $set: { enrollmentStatus: 'ENROLLED' } });

    const response = await request(app)
      .post(`/api/v1/apexcare/patients/${patientId}/dietitian-assessment`)
      .set('Authorization', `Bearer ${apexcareDietitianAToken}`)
      .send({ remarks: 'Diet assessment completed.' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('COORDINATOR_CALL_REQUIRED');
  });

  it('queues one idempotent care-plan generation job for one dietitian assessment', async () => {
    await ApexCareEnrollment.updateOne(
      { patientId, apexcareOrganizationId },
      {
        $set: {
          status: 'ACTIVE',
          enrolledAt: new Date(),
          enrolledByUserId: coordinatorId,
          coordinatorCallStatus: 'CONTACTED',
          dietitianAssessmentStatus: 'PENDING',
          carePlanGenerationStatus: 'NOT_STARTED',
          carePlanGenerationAttempt: 0,
          carePlanGenerationAssessmentId: undefined,
          carePlanGenerationError: undefined,
        },
      },
    );
    await Patient.updateOne({ _id: patientId, organizationId }, { $set: { enrollmentStatus: 'ENROLLED' } });

    const queues = await import('../queues.js');
    const schedule = vi.mocked(queues.scheduleHypertensionDraftGeneration);

    const first = await request(app)
      .post(`/api/v1/apexcare/patients/${patientId}/dietitian-assessment`)
      .set('Authorization', `Bearer ${apexcareDietitianAToken}`)
      .send({ remarks: 'Diet assessment completed.' });

    expect(first.status).toBe(202);
    expect(first.body.data.carePlanGenerationStatus).toBe('QUEUED');
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0]).toMatchObject({
      patientId,
      clinicOrganizationId: organizationId,
      apexcareOrganizationId,
      enrollmentId: expect.any(String),
      assessmentId: expect.any(String),
      attempt: 1,
    });

    const second = await request(app)
      .post(`/api/v1/apexcare/patients/${patientId}/dietitian-assessment`)
      .set('Authorization', `Bearer ${apexcareDietitianAToken}`)
      .send({ remarks: 'Same assessment retried by the client.' });

    expect(second.status).toBe(202);
    expect(second.body.data.assessment._id).toBe(first.body.data.assessment._id);
    expect(second.body.data.jobId).toBe(first.body.data.jobId);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(await DietitianAssessment.countDocuments({ patientId })).toBe(1);

  });

  it('creates a new generation attempt after a failed job without creating another assessment', async () => {
    const enrollment = await ApexCareEnrollment.findOneAndUpdate(
      { patientId, apexcareOrganizationId },
      {
        $set: {
          status: 'ACTIVE',
          enrolledAt: new Date(),
          enrolledByUserId: coordinatorId,
          coordinatorCallStatus: 'CONTACTED',
          dietitianAssessmentStatus: 'COMPLETED',
          carePlanGenerationStatus: 'FAILED',
          carePlanGenerationAttempt: 1,
          carePlanGenerationAssessmentId: undefined,
          carePlanGenerationError: 'Transient failure',
        },
      },
      { new: true },
    );
    if (!enrollment) throw new Error('Expected test enrollment to exist.');
    await Patient.updateOne({ _id: patientId, organizationId }, { $set: { enrollmentStatus: 'ENROLLED' } });
    const assessment = await DietitianAssessment.create({
      patientId,
      clinicOrganizationId: organizationId,
      apexcareOrganizationId,
      apexCareEnrollmentId: enrollment._id,
      dietitianUserId: apexcareDietitianAId,
      remarks: 'Existing completed assessment.',
    });
    await ApexCareEnrollment.updateOne({ _id: enrollment._id }, { $set: { carePlanGenerationAssessmentId: assessment._id } });

    const queues = await import('../queues.js');
    const schedule = vi.mocked(queues.scheduleHypertensionDraftGeneration);
    const scheduleCallsBeforeRetry = schedule.mock.calls.length;
    const response = await request(app)
      .post(`/api/v1/apexcare/patients/${patientId}/dietitian-assessment`)
      .set('Authorization', `Bearer ${apexcareDietitianAToken}`)
      .send({ remarks: 'Retry request.' });

    expect(response.status).toBe(202);
    expect(response.body.data.assessment._id).toBe(String(assessment._id));
    expect(schedule.mock.calls.length).toBe(scheduleCallsBeforeRetry + 1);
    expect(schedule.mock.calls[schedule.mock.calls.length - 1][0].attempt).toBe(2);
    expect(await DietitianAssessment.countDocuments({ apexCareEnrollmentId: enrollment._id })).toBe(1);
  });

  let dietitianCaseId: string;
  let endocrinologyCaseId: string;

  beforeEach(async () => {
    const passwordHash = await bcrypt.hash('TestPassword@123', 4);

    const [
      apexcareCoordinator,
      apexcareDietitianA,
      apexcareDietitianB,
      apexcareSpecialistA,
      apexcareSpecialistB,
    ] = await User.create([
      {
        organizationId: apexcareOrganization._id,
        name: 'ApexCare Coordinator',
        email: 'apexcare-coordinator@test.local',
        passwordHash,
        roles: ['APEXCARE_COORDINATOR'],
      },
      {
        organizationId: apexcareOrganization._id,
        name: 'ApexCare Dietitian A',
        email: 'apexcare-dietitian-a@test.local',
        passwordHash,
        roles: ['APEXCARE_DIETITIAN'],
      },
      {
        organizationId: apexcareOrganization._id,
        name: 'ApexCare Dietitian B',
        email: 'apexcare-dietitian-b@test.local',
        passwordHash,
        roles: ['APEXCARE_DIETITIAN'],
      },
      {
        organizationId: apexcareOrganization._id,
        name: 'ApexCare Specialist A',
        email: 'apexcare-specialist-a@test.local',
        passwordHash,
        roles: ['APEXCARE_SPECIALIST'],
      },
      {
        organizationId: apexcareOrganization._id,
        name: 'ApexCare Specialist B',
        email: 'apexcare-specialist-b@test.local',
        passwordHash,
        roles: ['APEXCARE_SPECIALIST'],
      },
    ]);

    apexcareCoordinatorId = String(apexcareCoordinator._id);
    apexcareDietitianAId = String(apexcareDietitianA._id);
    apexcareDietitianBId = String(apexcareDietitianB._id);
    apexcareSpecialistAId = String(apexcareSpecialistA._id);
    apexcareSpecialistBId = String(apexcareSpecialistB._id);

    apexcareCoordinatorToken = issueAccessToken({
      userId: apexcareCoordinatorId,
      organizationId: apexcareOrganizationId,
      roles: ['APEXCARE_COORDINATOR'],
    });

    apexcareDietitianAToken = issueAccessToken({
      userId: apexcareDietitianAId,
      organizationId: apexcareOrganizationId,
      roles: ['APEXCARE_DIETITIAN'],
    });

    apexcareDietitianBToken = issueAccessToken({
      userId: apexcareDietitianBId,
      organizationId: apexcareOrganizationId,
      roles: ['APEXCARE_DIETITIAN'],
    });

    apexcareSpecialistAToken = issueAccessToken({
      userId: apexcareSpecialistAId,
      organizationId: apexcareOrganizationId,
      roles: ['APEXCARE_SPECIALIST'],
    });

    apexcareSpecialistBToken = issueAccessToken({
      userId: apexcareSpecialistBId,
      organizationId: apexcareOrganizationId,
      roles: ['APEXCARE_SPECIALIST'],
    });

    await ApexCareEnrollment.create({
      patientId,
      clinicOrganizationId: organizationId,
      apexcareOrganizationId,
      status: 'ACTIVE',
      enrolledAt: new Date(),
      enrolledByUserId: coordinatorId,
    });

    /*
     * --------------------------------------------------------
     * DIETITIAN CASE
     * --------------------------------------------------------
     */

    const dietitianCase = await ServiceCase.create({
      organizationId,
      clinicOrganizationId: organizationId,
      apexcareOrganizationId,
      patientId,
      requestedByUserId: clinicianAId,
      service: 'DIETITIAN',
      status: 'ASSIGNED',
      assignedApexcareUserId: apexcareDietitianAId,
      reason: 'Dietary counselling required.',
    });

    dietitianCaseId = String(dietitianCase._id);

    /*
     * --------------------------------------------------------
     * ENDOCRINOLOGY CASE
     * --------------------------------------------------------
     */

    const endocrinologyCase = await ServiceCase.create({
      organizationId,
      clinicOrganizationId: organizationId,
      apexcareOrganizationId,
      patientId,
      requestedByUserId: clinicianAId,
      service: 'ENDOCRINOLOGY',
      status: 'ASSIGNED',
      assignedApexcareUserId: apexcareSpecialistAId,
      reason: 'Specialist review required.',
    });

    endocrinologyCaseId = String(endocrinologyCase._id);
  });

  /*
   * ----------------------------------------------------------
   * COORDINATOR QUEUE
   * ----------------------------------------------------------
   */

  it('allows the ApexCare coordinator to see all service cases', async () => {
    const response = await request(app)
      .get('/api/v1/apexcare/service-cases')
      .set('Authorization', `Bearer ${apexcareCoordinatorToken}`);

    expect(response.status).toBe(200);

    expect(response.body.data).toHaveLength(2);

    const services = response.body.data.map(
      (serviceCase: { service: string }) => serviceCase.service,
    );

    expect(services).toContain('DIETITIAN');
    expect(services).toContain('ENDOCRINOLOGY');
  });

  /*
   * ----------------------------------------------------------
   * DIETITIAN QUEUE
   * ----------------------------------------------------------
   */

  it('allows a dietitian to see only assigned dietitian cases', async () => {
    const response = await request(app)
      .get('/api/v1/apexcare/service-cases')
      .set('Authorization', `Bearer ${apexcareDietitianAToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);

    expect(response.body.data[0]._id).toBe(dietitianCaseId);
    expect(response.body.data[0].service).toBe('DIETITIAN');
    expect(response.body.data[0].assignedApexcareUserId).toBe(
      apexcareDietitianAId,
    );
  });

  it('prevents a dietitian from seeing another dietitian assigned case', async () => {
    await ServiceCase.findByIdAndUpdate(dietitianCaseId, {
      assignedApexcareUserId: apexcareDietitianBId,
    });

    const response = await request(app)
      .get('/api/v1/apexcare/service-cases')
      .set('Authorization', `Bearer ${apexcareDietitianAToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('prevents a dietitian from seeing endocrinology cases', async () => {
    const response = await request(app)
      .get('/api/v1/apexcare/service-cases')
      .set('Authorization', `Bearer ${apexcareDietitianAToken}`);

    expect(response.status).toBe(200);

    for (const serviceCase of response.body.data) {
      expect(serviceCase.service).toBe('DIETITIAN');
    }

    expect(
      response.body.data.some(
        (serviceCase: { _id: string }) =>
          serviceCase._id === endocrinologyCaseId,
      ),
    ).toBe(false);
  });

  /*
   * ----------------------------------------------------------
   * SPECIALIST QUEUE
   * ----------------------------------------------------------
   */

  it('allows a specialist to see only assigned endocrinology cases', async () => {
    const response = await request(app)
      .get('/api/v1/apexcare/service-cases')
      .set('Authorization', `Bearer ${apexcareSpecialistAToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);

    expect(response.body.data[0]._id).toBe(endocrinologyCaseId);
    expect(response.body.data[0].service).toBe('ENDOCRINOLOGY');
    expect(response.body.data[0].assignedApexcareUserId).toBe(
      apexcareSpecialistAId,
    );
  });

  it('prevents a specialist from seeing another specialist assigned case', async () => {
    await ServiceCase.findByIdAndUpdate(endocrinologyCaseId, {
      assignedApexcareUserId: apexcareSpecialistBId,
    });

    const response = await request(app)
      .get('/api/v1/apexcare/service-cases')
      .set('Authorization', `Bearer ${apexcareSpecialistAToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('prevents a specialist from seeing dietitian cases', async () => {
    const response = await request(app)
      .get('/api/v1/apexcare/service-cases')
      .set('Authorization', `Bearer ${apexcareSpecialistAToken}`);

    expect(response.status).toBe(200);

    for (const serviceCase of response.body.data) {
      expect(serviceCase.service).toBe('ENDOCRINOLOGY');
    }

    expect(
      response.body.data.some(
        (serviceCase: { _id: string }) =>
          serviceCase._id === dietitianCaseId,
      ),
    ).toBe(false);
  });

  /*
   * ----------------------------------------------------------
   * INDIVIDUAL CASE ACCESS
   * ----------------------------------------------------------
   */

  it('allows the assigned dietitian to open their service case', async () => {
    const response = await request(app)
      .get(`/api/v1/apexcare/service-cases/${dietitianCaseId}`)
      .set('Authorization', `Bearer ${apexcareDietitianAToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data.serviceCase._id).toBe(dietitianCaseId);
    expect(response.body.data.serviceCase.service).toBe('DIETITIAN');
  });

  it('prevents an unassigned dietitian from opening another dietitian case', async () => {
    const response = await request(app)
      .get(`/api/v1/apexcare/service-cases/${dietitianCaseId}`)
      .set('Authorization', `Bearer ${apexcareDietitianBToken}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('allows the assigned specialist to open their service case', async () => {
    const response = await request(app)
      .get(`/api/v1/apexcare/service-cases/${endocrinologyCaseId}`)
      .set('Authorization', `Bearer ${apexcareSpecialistAToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data.serviceCase._id).toBe(endocrinologyCaseId);
    expect(response.body.data.serviceCase.service).toBe('ENDOCRINOLOGY');
  });

  it('prevents an unassigned specialist from opening another specialist case', async () => {
    const response = await request(app)
      .get(`/api/v1/apexcare/service-cases/${endocrinologyCaseId}`)
      .set('Authorization', `Bearer ${apexcareSpecialistBToken}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  /*
   * ----------------------------------------------------------
   * STATUS UPDATE
   * ----------------------------------------------------------
   */

  it('allows the assigned dietitian to update their service case', async () => {
    const response = await request(app)
      .patch(`/api/v1/apexcare/service-cases/${dietitianCaseId}/status`)
      .set('Authorization', `Bearer ${apexcareDietitianAToken}`)
      .send({
        status: 'SCHEDULED',
        handoffSummary: 'Dietitian consultation scheduled.',
      });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('SCHEDULED');
  });

  it('prevents an unassigned dietitian from updating another dietitian case', async () => {
    const response = await request(app)
      .patch(`/api/v1/apexcare/service-cases/${dietitianCaseId}/status`)
      .set('Authorization', `Bearer ${apexcareDietitianBToken}`)
      .send({
        status: 'COMPLETED',
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('allows the assigned specialist to update their service case', async () => {
    const response = await request(app)
      .patch(`/api/v1/apexcare/service-cases/${endocrinologyCaseId}/status`)
      .set('Authorization', `Bearer ${apexcareSpecialistAToken}`)
      .send({
        status: 'SCHEDULED',
      });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('SCHEDULED');
  });

  it('prevents an unassigned specialist from updating another specialist case', async () => {
    const response = await request(app)
      .patch(`/api/v1/apexcare/service-cases/${endocrinologyCaseId}/status`)
      .set('Authorization', `Bearer ${apexcareSpecialistBToken}`)
      .send({
        status: 'COMPLETED',
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  /*
   * ----------------------------------------------------------
   * ASSIGNMENT AUTHORIZATION
   * ----------------------------------------------------------
   */

  it('allows the ApexCare coordinator to assign a dietitian to a dietitian case', async () => {
    const response = await request(app)
      .patch(`/api/v1/apexcare/service-cases/${dietitianCaseId}/assign`)
      .set('Authorization', `Bearer ${apexcareCoordinatorToken}`)
      .send({
        assignedApexcareUserId: apexcareDietitianBId,
      });

    expect(response.status).toBe(200);
    expect(response.body.data.assignedApexcareUserId).toBe(
      apexcareDietitianBId,
    );
    expect(response.body.data.status).toBe('ASSIGNED');
  });

  it('allows the ApexCare coordinator to assign a specialist to an endocrinology case', async () => {
    const response = await request(app)
      .patch(`/api/v1/apexcare/service-cases/${endocrinologyCaseId}/assign`)
      .set('Authorization', `Bearer ${apexcareCoordinatorToken}`)
      .send({
        assignedApexcareUserId: apexcareSpecialistBId,
      });

    expect(response.status).toBe(200);
    expect(response.body.data.assignedApexcareUserId).toBe(
      apexcareSpecialistBId,
    );
    expect(response.body.data.status).toBe('ASSIGNED');
  });

  it('prevents assigning a specialist to a dietitian case', async () => {
    const response = await request(app)
      .patch(`/api/v1/apexcare/service-cases/${dietitianCaseId}/assign`)
      .set('Authorization', `Bearer ${apexcareCoordinatorToken}`)
      .send({
        assignedApexcareUserId: apexcareSpecialistAId,
      });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INVALID_APEXCARE_ASSIGNEE');
  });

  it('prevents assigning a dietitian to an endocrinology case', async () => {
    const response = await request(app)
      .patch(`/api/v1/apexcare/service-cases/${endocrinologyCaseId}/assign`)
      .set('Authorization', `Bearer ${apexcareCoordinatorToken}`)
      .send({
        assignedApexcareUserId: apexcareDietitianAId,
      });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INVALID_APEXCARE_ASSIGNEE');
  });

  it('prevents a clinic clinician from assigning an ApexCare provider', async () => {
    const response = await request(app)
      .patch(`/api/v1/apexcare/service-cases/${dietitianCaseId}/assign`)
      .set('Authorization', `Bearer ${clinicianAToken}`)
      .send({
        assignedApexcareUserId: apexcareDietitianAId,
      });

    expect(response.status).toBe(403);
  });
});

it(
  'allows a coordinator to view new diagnoses awaiting enrolment',
  async () => {
    const response = await request(app)
      .get(
        '/api/v1/care-queue/new-diagnoses',
      )
      .set(
        'Authorization',
        `Bearer ${coordinatorToken}`,
      );

    expect(response.status).toBe(200);
    expect(
      Array.isArray(
        response.body.data,
      ),
    ).toBe(true);
  },
);

it(
  'prevents a clinician from viewing the coordinator new-diagnosis queue',
  async () => {
    const response = await request(app)
      .get(
        '/api/v1/care-queue/new-diagnoses',
      )
      .set(
        'Authorization',
        `Bearer ${clinicianAToken}`,
      );

    expect(response.status).toBe(403);
  },
);

it(
  'does not expose an enrolled patient in the new-diagnosis queue',
  async () => {
    const response = await request(app)
      .get(
        '/api/v1/care-queue/new-diagnoses',
      )
      .set(
        'Authorization',
        `Bearer ${coordinatorToken}`,
      );
    


    expect(response.status).toBe(200);

      console.log(
  'ENROL RESPONSE:',
  response.status,
  response.body,
);
    expect(
      response.body.data.every(
        (item: {
          enrollmentStatus: string;
        }) =>
          item.enrollmentStatus ===
          'NOT_ENROLLED',
      ),
    ).toBe(true);
  },
);

it(
  'allows a coordinator to enrol a referred patient after capturing vitals, prescription and consent',
  async () => {
    const vitalResponse = await request(app)
      .post(`/api/v1/patients/${patientId}/vitals`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({
        source: 'OPD',
        bloodPressure: { systolic: 148, diastolic: 92, pulse: 82 },
        weightKg: 74,
      });

    expect(vitalResponse.status).toBe(201);

    const prescriptionResponse = await request(app)
      .post(`/api/v1/patients/${patientId}/prescription-documents/upload`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ fileName: 'prescription.png', mimeType: 'image/png', imageBase64: testPrescriptionImageBase64 });

    expect(prescriptionResponse.status).toBe(202);
    expect(prescriptionResponse.body.data.prescriptionDocument.storageKey).toBeTruthy();

    const response = await request(app)
      .post(`/api/v1/patients/${patientId}/enrol`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({
        communicationConsent: true,
        consentMethod: 'VERBAL',
        consentVersion: '1.0',
      });

    expect(response.status).toBe(202);
    expect(response.body.data.patientId).toBe(patientId);
    expect(response.body.data.enrollmentStatus).toBe('ENROLLED');

    const enrollment = await ApexCareEnrollment.findOne({ patientId }).lean();
    expect(enrollment?.status).toBe('ACTIVE');
    expect(enrollment?.coordinatorCallStatus).toBe('PENDING');
    expect(enrollment?.coordinatorCallDueAt).toBeInstanceOf(Date);

    const referral = await ApexCareReferral.findOne({ patientId }).lean();
    expect(referral?.status).toBe('ENROLLED');
    expect(referral?.enrolledByUserId?.toString()).toBe(coordinatorId);
  },
);

it('rejects ApexCare enrolment until staff has captured a prescription and vitals', async () => {
  const response = await request(app)
    .post(`/api/v1/patients/${patientId}/enrol`)
    .set('Authorization', `Bearer ${coordinatorToken}`)
    .send({
      communicationConsent: true,
      consentMethod: 'VERBAL',
      consentVersion: '1.0',
    });

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe('PRESCRIPTION_REQUIRED');

  const prescriptionResponse = await request(app)
    .post(`/api/v1/patients/${patientId}/prescription-documents/upload`)
    .set('Authorization', `Bearer ${coordinatorToken}`)
    .send({ fileName: 'emr-screenshot.png', mimeType: 'image/png', imageBase64: testPrescriptionImageBase64 });

  expect(prescriptionResponse.status).toBe(202);

  const withoutVitals = await request(app)
    .post(`/api/v1/patients/${patientId}/enrol`)
    .set('Authorization', `Bearer ${coordinatorToken}`)
    .send({
      communicationConsent: true,
      consentMethod: 'VERBAL',
      consentVersion: '1.0',
    });

  expect(withoutVitals.status).toBe(422);
  expect(withoutVitals.body.error.code).toBe('VITALS_REQUIRED');
});

it('rejects direct EMR integration as a version-1 prescription source', async () => {
  const response = await request(app)
    .post(`/api/v1/patients/${patientId}/prescription-documents`)
    .set('Authorization', `Bearer ${coordinatorToken}`)
    .send({
      source: 'EMR_INTEGRATION',
      fileName: 'prescription.json',
      mimeType: 'application/pdf',
      storageKey: `test/${patientId}/prescription.json`,
    });

  expect(response.status).toBe(422);
});

it(
  'rejects coordinator enrolment without consent',
  async () => {
    const response = await request(app)
      .post(
        `/api/v1/patients/${patientId}/enrol`,
      )
      .set(
        'Authorization',
        `Bearer ${coordinatorToken}`,
      )
      .send({
        communicationConsent: false,
        consentMethod: 'VERBAL',
        consentVersion: '1.0',
      });

    expect(response.status).toBe(422);
  },
);

it(
  'rejects coordinator enrolment without consent',
  async () => {
    const response = await request(app)
      .post(
        `/api/v1/patients/${patientId}/enrol`,
      )
      .set(
        'Authorization',
        `Bearer ${coordinatorToken}`,
      )
      .send({
        communicationConsent: false,
        consentMethod: 'VERBAL',
        consentVersion: '1.0',
      });

    expect(response.status).toBe(422);
  },
);


it('queues uploaded prescription analysis and returns before vision inference completes', async () => {
  const prescriptionResponse = await request(app)
    .post(`/api/v1/patients/${patientId}/prescription-documents/upload`)
    .set('Authorization', `Bearer ${coordinatorToken}`)
    .send({ fileName: 'prescription.png', mimeType: 'image/png', imageBase64: testPrescriptionImageBase64 });
  expect(prescriptionResponse.status).toBe(202);
  expect(prescriptionResponse.body.data.analysisStatus).toBe('PENDING');
  expect(prescriptionResponse.body.data.jobId).toBe('test-prescription-analysis-job');
  expect(prescriptionResponse.body.data.prescriptionDocument.status).toBe('ANALYZING');
  expect(prescriptionResponse.body.data.medicationDraft.status).toBe('DRAFT');
});

it('waits for prescription analysis before accepting medication submission', async () => {
  const prescriptionResponse = await request(app)
    .post(`/api/v1/patients/${patientId}/prescription-documents/upload`)
    .set('Authorization', `Bearer ${coordinatorToken}`)
    .send({ fileName: 'pending-prescription.png', mimeType: 'image/png', imageBase64: testPrescriptionImageBase64 });
  const documentId = prescriptionResponse.body.data.prescriptionDocument._id;
  const draftId = prescriptionResponse.body.data.medicationDraft._id;

  const response = await request(app)
    .post(`/api/v1/patients/${patientId}/prescription-documents/${documentId}/medication-drafts/${draftId}/submit`)
    .set('Authorization', `Bearer ${coordinatorToken}`)
    .send({ medications: [{ name: 'Amlodipine', strength: '5 mg', frequency: 'once daily' }] });

  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('MEDICATION_DRAFT_ANALYSIS_PENDING');
});

it('does not allow medication submission after prescription analysis has failed', async () => {
  const prescriptionResponse = await request(app)
    .post(`/api/v1/patients/${patientId}/prescription-documents/upload`)
    .set('Authorization', `Bearer ${coordinatorToken}`)
    .send({ fileName: 'failed-analysis-prescription.png', mimeType: 'image/png', imageBase64: testPrescriptionImageBase64 });
  expect(prescriptionResponse.status).toBe(202);

  const documentId = prescriptionResponse.body.data.prescriptionDocument._id;
  const draftId = prescriptionResponse.body.data.medicationDraft._id;

  await PrescriptionDocument.updateOne(
    { _id: documentId },
    { $set: { analysisStatus: 'FAILED', status: 'NEEDS_CLINICAL_REVIEW' } },
  );
  await MedicationDraft.updateOne(
    { _id: draftId },
    { $set: { status: 'VERIFICATION_REQUIRED', clinicalReviewRequired: true } },
  );

  const response = await request(app)
    .post(`/api/v1/patients/${patientId}/prescription-documents/${documentId}/medication-drafts/${draftId}/submit`)
    .set('Authorization', `Bearer ${coordinatorToken}`)
    .send({ medications: [{ name: 'Amlodipine', strength: '5 mg', frequency: 'once daily' }] });

  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('PRESCRIPTION_ANALYSIS_FAILED');
});

it('creates immutable medication history from a verified medication draft', async () => {
  const prescriptionResponse = await request(app)
    .post(`/api/v1/patients/${patientId}/prescription-documents/upload`)
    .set('Authorization', `Bearer ${coordinatorToken}`)
    .send({ fileName: 'verified-prescription.png', mimeType: 'image/png', imageBase64: testPrescriptionImageBase64 });
  expect(prescriptionResponse.status).toBe(202);
  const documentId = prescriptionResponse.body.data.prescriptionDocument._id;
  const draftId = prescriptionResponse.body.data.medicationDraft._id;

  await MedicationDraft.updateOne({ _id: draftId }, { $set: { status: 'VERIFIED', clinicalReviewRequired: false, medications: [{ name: 'Amlodipine', strength: '5 mg', frequency: 'once daily' }] } });

  const finalizeResponse = await request(app)
    .post(`/api/v1/patients/${patientId}/prescription-documents/${documentId}/medication-drafts/${draftId}/finalize`)
    .set('Authorization', `Bearer ${coordinatorToken}`)
    .send({ reason: 'Verified against original prescription image.' });

  expect(finalizeResponse.status).toBe(201);
  const records = await MedicationRecord.find({ patientId, medicationDraftId: draftId }).lean();
  expect(records).toHaveLength(1);
  expect(records[0].status).toBe('ACTIVE');
  const history = await MedicationHistory.find({ medicationRecordId: records[0]._id }).lean();
  expect(history).toHaveLength(1);
  expect(history[0].version).toBe(1);
  expect(history[0].action).toBe('CREATED');
});

it('prevents cross-organization medication-draft access', async () => {
  const prescriptionResponse = await request(app)
    .post(`/api/v1/patients/${patientId}/prescription-documents/upload`)
    .set('Authorization', `Bearer ${coordinatorToken}`)
    .send({ fileName: 'prescription.png', mimeType: 'image/png', imageBase64: testPrescriptionImageBase64 });
  expect(prescriptionResponse.status).toBe(202);
  const documentId = prescriptionResponse.body.data.prescriptionDocument._id;

  const foreignGet = await request(app)
    .get(`/api/v1/patients/${patientId}/prescription-documents/${documentId}/medication-drafts`)
    .set('Authorization', `Bearer ${clinicianCToken}`);
  expect(foreignGet.status).toBe(404);
});

it('prevents a clinic coordinator from uploading a prescription for another clinic patient', async () => {
  const response = await request(app)
    .post(`/api/v1/patients/${patientBId}/prescription-documents/upload`)
    .set('Authorization', `Bearer ${coordinatorToken}`)
    .send({ fileName: 'foreign.png', mimeType: 'image/png', imageBase64: testPrescriptionImageBase64 });

  expect(response.status).toBe(404);
});

describe('Phase 2D clinical review boundaries', () => {
  async function createClinicalReviewFixture(status: 'CLINICIAN_REVIEW' | 'APEXCARE_REVIEW' = 'CLINICIAN_REVIEW') {
    const document = await PrescriptionDocument.create({
      patientId,
      clinicOrganizationId: organizationId,
      apexcareOrganizationId,
      source: 'IMAGE',
      status: 'NEEDS_CLINICAL_REVIEW',
      fileName: 'clinical-review.png',
      mimeType: 'image/png',
      storageKey: `prescriptions/${organizationId}/${patientId}/clinical-review.png`,
      sizeBytes: 68,
      sha256: 'a'.repeat(64),
      analysisStatus: 'FAILED',
      clinicalReviewReason: 'AI discrepancy requires clinician review.',
      capturedByUserId: clinicianAId,
    });
    const draft = await MedicationDraft.create({
      patientId,
      clinicOrganizationId: organizationId,
      apexcareOrganizationId,
      prescriptionDocumentId: document._id,
      extractionSource: 'OCR',
      status: 'VERIFICATION_REQUIRED',
      medications: [{ name: 'Amlodipine', strength: '5 mg', frequency: 'once daily' }],
      extractedByUserId: coordinatorId,
      clinicalReviewRequired: true,
      clinicalReviewReason: 'AI discrepancy requires clinician review.',
    });
    const reviewCase = await ClinicalReviewCase.create({
      patientId,
      clinicOrganizationId: organizationId,
      apexcareOrganizationId,
      prescriptionDocumentId: document._id,
      medicationDraftId: draft._id,
      clinicClinicianId: clinicianAId,
      reasonCode: 'AI_DISCREPANCY',
      reason: 'AI discrepancy requires clinician review.',
      status,
      clinicReviewDueAt: new Date(Date.now() - 1000),
      apexcareEscalatedAt: status === 'APEXCARE_REVIEW' ? new Date() : undefined,
      decision: status === 'APEXCARE_REVIEW' ? 'ESCALATED' : undefined,
    });
    return { document, draft, reviewCase };
  }

  it('allows only the assigned clinician to see the Phase 2D review queue', async () => {
    await createClinicalReviewFixture();

    const assigned = await request(app)
      .get('/api/v1/clinical-review-queue')
      .set('Authorization', `Bearer ${clinicianAToken}`);
    expect(assigned.status).toBe(200);
    expect(assigned.body.data).toHaveLength(1);

    const otherClinician = await request(app)
      .get('/api/v1/clinical-review-queue')
      .set('Authorization', `Bearer ${clinicianBToken}`);
    expect(otherClinician.status).toBe(200);
    expect(otherClinician.body.data).toHaveLength(0);

    const coordinator = await request(app)
      .get('/api/v1/clinical-review-queue')
      .set('Authorization', `Bearer ${coordinatorToken}`);
    expect(coordinator.status).toBe(403);
  });

  it('allows the assigned clinician to approve a medication clinical review and clears the clinical-review gate', async () => {
    const { draft, reviewCase } = await createClinicalReviewFixture();

    const response = await request(app)
      .patch(`/api/v1/clinical-review-cases/${reviewCase._id}/decision`)
      .set('Authorization', `Bearer ${clinicianAToken}`)
      .send({ decision: 'APPROVE' });

    expect(response.status).toBe(200);
    const updatedDraft = await MedicationDraft.findById(draft._id).lean();
    expect(updatedDraft?.status).toBe('VERIFIED');
    expect(updatedDraft?.clinicalReviewRequired).toBe(false);

    const updatedCase = await ClinicalReviewCase.findById(reviewCase._id).lean();
    expect(updatedCase?.status).toBe('APPROVED');
    expect(updatedCase?.reviewedByUserId?.toString()).toBe(clinicianAId);

    const events = await ClinicalReviewEvent.find({ clinicalReviewCaseId: reviewCase._id }).sort({ createdAt: 1 }).lean();
    expect(events.map((event) => event.eventType)).toEqual(['DECISION']);
    expect(events[0].toStatus).toBe('APPROVED');
  });

  it('prevents finalization while an unresolved clinical review case exists', async () => {
    const prescriptionResponse = await request(app)
      .post(`/api/v1/patients/${patientId}/prescription-documents/upload`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ fileName: 'pending-review.png', mimeType: 'image/png', imageBase64: testPrescriptionImageBase64 });
    expect(prescriptionResponse.status).toBe(202);
    const documentId = prescriptionResponse.body.data.prescriptionDocument._id;
    const draftId = prescriptionResponse.body.data.medicationDraft._id;

    await MedicationDraft.updateOne({ _id: draftId }, { $set: { status: 'VERIFIED', clinicalReviewRequired: false, medications: [{ name: 'Amlodipine', strength: '5 mg', frequency: 'once daily' }] } });
    await ClinicalReviewCase.create({
      patientId,
      clinicOrganizationId: organizationId,
      apexcareOrganizationId,
      prescriptionDocumentId: documentId,
      medicationDraftId: draftId,
      clinicClinicianId: clinicianAId,
      reasonCode: 'AI_DISCREPANCY',
      reason: 'Unresolved discrepancy.',
      status: 'CLINICIAN_REVIEW',
      clinicReviewDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const response = await request(app)
      .post(`/api/v1/patients/${patientId}/prescription-documents/${documentId}/medication-drafts/${draftId}/finalize`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ reason: 'Attempted before clinical review.' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CLINICAL_REVIEW_PENDING');
  });

  it('allows an ApexCare doctor to claim and approve an escalated clinical review', async () => {
    const { reviewCase } = await createClinicalReviewFixture('APEXCARE_REVIEW');

    const queue = await request(app)
      .get('/api/v1/apexcare/clinical-review-queue')
      .set('Authorization', `Bearer ${apexcareDoctorToken}`);
    expect(queue.status).toBe(200);
    expect(queue.body.data).toHaveLength(1);

    const claim = await request(app)
      .patch(`/api/v1/apexcare/clinical-review-cases/${reviewCase._id}/claim`)
      .set('Authorization', `Bearer ${apexcareDoctorToken}`);
    expect(claim.status).toBe(200);

    const decision = await request(app)
      .patch(`/api/v1/apexcare/clinical-review-cases/${reviewCase._id}/decision`)
      .set('Authorization', `Bearer ${apexcareDoctorToken}`)
      .send({ decision: 'APPROVE', protocolSafe: true });
    expect(decision.status).toBe(200);

    const updatedCase = await ClinicalReviewCase.findById(reviewCase._id).lean();
    expect(updatedCase?.status).toBe('APPROVED');
    expect(updatedCase?.apexcareAssignedUserId?.toString()).toBe(apexcareDoctorId);
  });

  it('prevents a clinic clinician from accessing ApexCare clinical-review cases', async () => {
    const { reviewCase } = await createClinicalReviewFixture('APEXCARE_REVIEW');

    const response = await request(app)
      .get(`/api/v1/apexcare/clinical-review-cases/${reviewCase._id}`)
      .set('Authorization', `Bearer ${clinicianAToken}`);
    expect(response.status).toBe(403);
  });

  it('prevents an ApexCare doctor from accessing a case owned by another ApexCare organization', async () => {
    const { reviewCase } = await createClinicalReviewFixture('APEXCARE_REVIEW');
    const foreignApexCare = await Organization.create({ name: 'Foreign ApexCare', type: 'APEXCARE', status: 'ACTIVE' });
    const passwordHash = await bcrypt.hash('TestPassword@123', 4);
    const foreignDoctor = await User.create({
      organizationId: foreignApexCare._id,
      name: 'Foreign ApexCare Doctor',
      email: 'foreign-apexcare-doctor@test.local',
      passwordHash,
      roles: ['APEXCARE_DOCTOR'],
    });
    const foreignToken = issueAccessToken({
      userId: String(foreignDoctor._id),
      organizationId: String(foreignApexCare._id),
      roles: ['APEXCARE_DOCTOR'],
    });

    const response = await request(app)
      .get(`/api/v1/apexcare/clinical-review-cases/${reviewCase._id}`)
      .set('Authorization', `Bearer ${foreignToken}`);
    expect(response.status).toBe(404);
  });
});

describe('ApexCare organization isolation', () => {
  let isolationApexCareCoordinatorToken: string;
  let isolationDietitianCaseId: string;

  beforeEach(async () => {
    const passwordHash = await bcrypt.hash('TestPassword@123', 4);

    const apexcareCoordinator = await User.create({
      organizationId: apexcareOrganizationId,
      name: 'Isolation ApexCare Coordinator',
      email: 'isolation-apexcare-coordinator@test.local',
      passwordHash,
      roles: ['APEXCARE_COORDINATOR'],
    });

    const apexcareDietitian = await User.create({
      organizationId: apexcareOrganizationId,
      name: 'Isolation ApexCare Dietitian',
      email: 'isolation-apexcare-dietitian@test.local',
      passwordHash,
      roles: ['APEXCARE_DIETITIAN'],
    });

    isolationApexCareCoordinatorToken = issueAccessToken({
      userId: String(apexcareCoordinator._id),
      organizationId: apexcareOrganizationId,
      roles: ['APEXCARE_COORDINATOR'],
    });

    const isolationDietitianCase = await ServiceCase.create({
      organizationId,
      clinicOrganizationId: organizationId,
      apexcareOrganizationId,
      patientId,
      requestedByUserId: clinicianAId,
      service: 'DIETITIAN',
      status: 'ASSIGNED',
      assignedApexcareUserId: apexcareDietitian._id,
      reason: 'ApexCare organization isolation assignment test.',
    });

    isolationDietitianCaseId = String(isolationDietitianCase._id);
  });

  it('rejects a clinic user from accessing ApexCare service-case routes', async () => {
    const response = await request(app)
      .get('/api/v1/apexcare/service-cases')
      .set('Authorization', `Bearer ${clinicianAToken}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ORGANIZATION_TYPE_FORBIDDEN');
  });

  it('rejects an ApexCare role if the user belongs to a clinic organization', async () => {
    const passwordHash = await bcrypt.hash('TestPassword@123', 4);
    const invalidUser = await User.create({
      organizationId,
      name: 'Invalid ApexCare Role User',
      email: 'invalid-apexcare-role@test.local',
      passwordHash,
      roles: ['APEXCARE_COORDINATOR'],
    });
    const invalidToken = issueAccessToken({
      userId: String(invalidUser._id),
      organizationId,
      roles: ['APEXCARE_COORDINATOR'],
    });

    const response = await request(app)
      .get('/api/v1/apexcare/service-cases')
      .set('Authorization', `Bearer ${invalidToken}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ORGANIZATION_TYPE_FORBIDDEN');
  });

  it('prevents a clinician from reading a care-plan execution in another clinic', async () => {
    const plan = await CarePlan.create({
      organizationId,
      patientId,
      condition: 'HYPERTENSION',
      status: 'ACTIVE',
      startDate: new Date(),
      endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      goals: [],
      createdByUserId: clinicianAId,
    });
    const execution = await CarePlanExecution.create({
      organizationId,
      patientId,
      carePlanId: plan._id,
      condition: 'HYPERTENSION',
      status: 'ACTIVE',
      startDate: plan.startDate,
      endDate: plan.endDate,
      activationKey: `care-plan-execution:${plan._id}`,
    });
    await CarePlanMilestone.create({
      organizationId,
      patientId,
      carePlanId: plan._id,
      executionId: execution._id,
      key: 'DAY_0',
      day: 0,
      dueAt: plan.startDate,
      status: 'PLANNED',
    });

    const response = await request(app)
      .get(`/api/v1/patients/${patientId}/care-plans/${plan._id}/execution`)
      .set('Authorization', `Bearer ${clinicianCToken}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PATIENT_NOT_FOUND');
  });

  it('allows a clinic coordinator to complete an accessible milestone but blocks an ApexCare doctor', async () => {
    const plan = await CarePlan.create({
      organizationId,
      patientId,
      condition: 'HYPERTENSION',
      status: 'ACTIVE',
      startDate: new Date(),
      endDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      goals: [],
      createdByUserId: clinicianAId,
    });
    const execution = await CarePlanExecution.create({
      organizationId,
      patientId,
      carePlanId: plan._id,
      condition: 'HYPERTENSION',
      status: 'ACTIVE',
      startDate: plan.startDate,
      endDate: plan.endDate,
      activationKey: `care-plan-execution:${plan._id}`,
    });
    const milestone = await CarePlanMilestone.create({
      organizationId,
      patientId,
      carePlanId: plan._id,
      executionId: execution._id,
      key: 'DAY_3',
      day: 3,
      dueAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      status: 'PLANNED',
    });

    const denied = await request(app)
      .patch(`/api/v1/patients/${patientId}/care-plans/${plan._id}/execution/milestones/${milestone._id}`)
      .set('Authorization', `Bearer ${apexcareDoctorToken}`)
      .send({ action: 'COMPLETE' });
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .patch(`/api/v1/patients/${patientId}/care-plans/${plan._id}/execution/milestones/${milestone._id}`)
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ action: 'COMPLETE' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.status).toBe('COMPLETED_EARLY');
  });

  it('does not expose a service case belonging to a different ApexCare organization', async () => {
    const otherApexCare = await Organization.create({
      name: 'Other ApexCare',
      type: 'APEXCARE',
      status: 'ACTIVE',
    });

    const foreignCase = await ServiceCase.create({
      organizationId,
      clinicOrganizationId: organizationId,
      apexcareOrganizationId: otherApexCare._id,
      patientId,
      requestedByUserId: clinicianAId,
      service: 'DIETITIAN',
      status: 'ASSIGNED',
      assignedApexcareUserId: apexcareDietitianAId,
      reason: 'Foreign ApexCare isolation test.',
    });

    const response = await request(app)
      .get(`/api/v1/apexcare/service-cases/${foreignCase._id}`)
      .set('Authorization', `Bearer ${isolationApexCareCoordinatorToken}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SERVICE_CASE_NOT_FOUND');
  });

  it('prevents assignment to an ApexCare user from another ApexCare organization', async () => {
    const otherApexCare = await Organization.create({
      name: 'Other ApexCare Assignment',
      type: 'APEXCARE',
      status: 'ACTIVE',
    });
    const passwordHash = await bcrypt.hash('TestPassword@123', 4);
    const foreignDietitian = await User.create({
      organizationId: otherApexCare._id,
      name: 'Foreign Dietitian',
      email: 'foreign-dietitian@test.local',
      passwordHash,
      roles: ['APEXCARE_DIETITIAN'],
    });

    const response = await request(app)
      .patch(`/api/v1/apexcare/service-cases/${isolationDietitianCaseId}/assign`)
      .set('Authorization', `Bearer ${isolationApexCareCoordinatorToken}`)
      .send({ assignedApexcareUserId: String(foreignDietitian._id) });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INVALID_APEXCARE_ASSIGNEE');
  });
});
