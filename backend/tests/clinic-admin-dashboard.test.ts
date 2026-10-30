import bcrypt from 'bcrypt';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../queues.js', async () => {
  const actual = await vi.importActual<typeof import('../queues.js')>('../queues.js');
  return { ...actual };
});

let mongo: MongoMemoryServer;
let app: (typeof import('../app.js'))['app'];
let connectDatabase: typeof import('../db.js')['connectDatabase'];
let disconnectDatabase: typeof import('../db.js')['disconnectDatabase'];
let issueAccessToken: typeof import('../auth.js')['issueAccessToken'];
let Organization: typeof import('../models.js')['Organization'];
let User: typeof import('../models.js')['User'];
let Patient: typeof import('../models.js')['Patient'];
let Subscription: typeof import('../models.js')['Subscription'];
let CarePlan: typeof import('../models.js')['CarePlan'];
let CareTask: typeof import('../models.js')['CareTask'];
let PatientReview: typeof import('../models.js')['PatientReview'];
let ApexCareReferral: typeof import('../models.js')['ApexCareReferral'];

let organizationId: string;
let adminToken: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.NODE_ENV = 'test';
  process.env.MONGO_URI = mongo.getUri();
  process.env.JWT_ACCESS_SECRET = 'test-secret-that-is-at-least-32-characters-long';
  process.env.JWT_ACCESS_TTL = '15m';
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.AI_ENABLED = 'false';
  process.env.PORT = '5002';

  ({ app } = await import('../app.js'));
  ({ connectDatabase, disconnectDatabase } = await import('../db.js'));
  ({ issueAccessToken } = await import('../auth.js'));
  ({ Organization, User, Patient, Subscription, CarePlan, CareTask, PatientReview, ApexCareReferral } = await import('../models.js'));

  await connectDatabase();
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
    Subscription.deleteMany({}),
    CarePlan.deleteMany({}),
    CareTask.deleteMany({}),
    PatientReview.deleteMany({}),
    ApexCareReferral.deleteMany({}),
  ]);

  const organization = await Organization.create({ name: 'Dashboard Clinic', type: 'CLINIC', status: 'ACTIVE' });
  organizationId = String(organization._id);

  const passwordHash = await bcrypt.hash('TestPassword@123', 4);
  const admin = await User.create({
    organizationId: organization._id,
    name: 'Clinic Admin',
    email: 'admin@dashboard.test',
    passwordHash,
    roles: ['CLINIC_ADMIN'],
  });
  const clinician = await User.create({
    organizationId: organization._id,
    name: 'Clinician',
    email: 'clinician@dashboard.test',
    passwordHash,
    roles: ['CLINICIAN'],
  });
  await User.create({
    organizationId: organization._id,
    name: 'Coordinator',
    email: 'coordinator@dashboard.test',
    passwordHash,
    roles: ['CLINIC_COORDINATOR'],
  });

  adminToken = issueAccessToken({ userId: String(admin._id), organizationId, roles: ['CLINIC_ADMIN'] });

  await Subscription.create({
    organizationId: organization._id,
    planCode: 'GROWTH',
    status: 'ACTIVE',
    activePatientLimit: 100,
    activePatientCount: 3,
    currentPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
  });

  const patients = await Patient.create([
    {
      organizationId: organization._id,
      medicalRecordNumber: 'AC-DASH-001',
      name: { first: 'Anjali', last: 'Nair' },
      assignedClinicianId: clinician._id,
      enrollmentStatus: 'ACTIVE_CARE',
      status: 'ACTIVE',
    },
    {
      organizationId: organization._id,
      medicalRecordNumber: 'AC-DASH-002',
      name: { first: 'Rahul', last: 'Menon' },
      assignedClinicianId: clinician._id,
      enrollmentStatus: 'ENROLLED',
      status: 'ACTIVE',
    },
    {
      organizationId: organization._id,
      medicalRecordNumber: 'AC-DASH-003',
      name: { first: 'Maya', last: 'Thomas' },
      assignedClinicianId: clinician._id,
      enrollmentStatus: 'ACTIVE_CARE',
      status: 'ACTIVE',
    },
  ]);

  const plan = await CarePlan.create({
    organizationId: organization._id,
    patientId: patients[0]._id,
    condition: 'HYPERTENSION',
    status: 'ACTIVE',
    startDate: new Date('2026-09-01T00:00:00.000Z'),
    endDate: new Date('2026-12-01T00:00:00.000Z'),
    goals: [],
    createdByUserId: clinician._id,
  });

  await CareTask.create({
    organizationId: organization._id,
    patientId: patients[0]._id,
    carePlanId: plan._id,
    type: 'FOLLOW_UP',
    title: 'Overdue follow-up',
    dueAt: new Date('2026-09-01T00:00:00.000Z'),
    status: 'OVERDUE',
  });

  await PatientReview.create({
    organizationId: organization._id,
    patientId: patients[0]._id,
    carePlanId: plan._id,
    executionId: new (await import('mongoose')).Types.ObjectId(),
    milestoneId: new (await import('mongoose')).Types.ObjectId(),
    reviewKey: `DASHBOARD_REVIEW:${Date.now()}`,
    status: 'OPEN',
    dueAt: new Date('2026-09-30T00:00:00.000Z'),
    questions: [],
  });

  await ApexCareReferral.create({
    patientId: patients[1]._id,
    clinicOrganizationId: organization._id,
    apexcareOrganizationId: new (await import('mongoose')).Types.ObjectId(),
    referredByUserId: clinician._id,
    condition: 'HYPERTENSION',
    status: 'PENDING_STAFF',
    referredAt: new Date(),
    staffEscalationDueAt: new Date(Date.now() + 3600000),
  });
});

describe('Clinic Admin dashboard', () => {
  it('returns organization-scoped business aggregates', async () => {
    const response = await request(app)
      .get('/api/v1/clinic/dashboard')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(response.body.data.patients.active).toBe(3);
    expect(response.body.data.team.clinicians).toBe(1);
    expect(response.body.data.team.coordinators).toBe(1);
    expect(response.body.data.team.active).toBe(2);
    expect(response.body.data.care.activeCarePlans).toBe(1);
    expect(response.body.data.care.pendingReviews).toBe(1);
    expect(response.body.data.care.overdueTasks).toBe(1);
    expect(response.body.data.care.pendingApexCareReferrals).toBe(1);
    expect(response.body.data.capacity.available).toBe(97);
    expect(response.body.data.capacity.utilizationPercent).toBe(3);
    expect(response.body.data.recentPatients).toHaveLength(3);
  });

  it('rejects non-admin clinic roles', async () => {
    const clinician = await User.findOne({ email: 'clinician@dashboard.test' }).lean();
    const token = issueAccessToken({ userId: String(clinician?._id), organizationId, roles: ['CLINICIAN'] });

    await request(app)
      .get('/api/v1/clinic/dashboard')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
