import bcrypt from 'bcrypt';
import mongoose from 'mongoose';

import {
  Organization,
  User,
  Patient,
  PatientClinicRelationship,
  ApexCareEnrollment,
  ApexCareReferral,
  PrescriptionDocument,
  MedicationDraft,
  MedicationRecord,
  Diagnosis,
  ProgramConsent,
  CarePlan,
  CareTask,
  CarePlanExecution,
  CarePlanMilestone,
  VitalRecord,
} from '../models';

const MONGO_URI =
  process.env.MONGO_URI ?? 'mongodb://localhost:27017/apexcare';

async function seed() {
  await mongoose.connect(MONGO_URI);

  /*
   * ---------------------------------------------------------
   * 1. ORGANIZATIONS
   * ---------------------------------------------------------
   */

  const clinic = await Organization.findOneAndUpdate(
    { name: 'Apex Demo Clinic' },
    {
      $setOnInsert: {
        name: 'Apex Demo Clinic',
        type: 'CLINIC',
        status: 'ACTIVE',
      },
    },
    { upsert: true, new: true },
  );

  const apexcare = await Organization.findOneAndUpdate(
    { name: 'ApexCare Demo' },
    {
      $setOnInsert: {
        name: 'ApexCare Demo',
        type: 'APEXCARE',
        status: 'ACTIVE',
      },
    },
    { upsert: true, new: true },
  );

  /*
   * ---------------------------------------------------------
   * 2. CLINIC USERS
   * ---------------------------------------------------------
   */

  const passwordHash = await bcrypt.hash('Patient@123', 12);

  const clinician = await User.findOneAndUpdate(
    { email: 'dr.arjun.menon@apexcare.local' },
    {
      $set: {
        organizationId: clinic._id,
        name: 'Dr. Arjun Menon',
        email: 'dr.arjun.menon@apexcare.local',
        roles: ['CLINICIAN'],
        status: 'ACTIVE',
        mustChangePassword: false,
      },
      $setOnInsert: {
        passwordHash: await bcrypt.hash('Clinician@123', 12),
      },
    },
    { upsert: true, new: true },
  );

  const coordinator = await User.findOneAndUpdate(
    { email: 'coordinator@apexcare.local' },
    {
      $set: {
        organizationId: clinic._id,
        name: 'Meera Thomas',
        email: 'coordinator@apexcare.local',
        roles: ['CLINIC_COORDINATOR'],
        status: 'ACTIVE',
        mustChangePassword: false,
      },
      $setOnInsert: {
        passwordHash: await bcrypt.hash('Coordinator@123', 12),
      },
    },
    { upsert: true, new: true },
  );

  /*
   * ---------------------------------------------------------
   * 3. PATIENT
   * ---------------------------------------------------------
   */

  const patient = await Patient.findOneAndUpdate(
    {
      organizationId: clinic._id,
      medicalRecordNumber: 'AC-HTN-0001',
    },
    {
      $set: {
        organizationId: clinic._id,
        medicalRecordNumber: 'AC-HTN-0001',

        name: {
          first: 'Anjali',
          last: 'Nair',
        },

        dateOfBirth: new Date('1981-04-18'),
        sexAtBirth: 'FEMALE',

        phone: '+919876543210',
        preferredLanguage: 'en',
        preferredContactChannel: 'APP',

        assignedClinicianId: clinician._id,
        enrolledByUserId: coordinator._id,

        enrollmentStatus: 'ACTIVE_CARE',

        conditions: [
          {
            code: 'HYPERTENSION',
            status: 'CONFIRMED',
            diagnosedAt: new Date('2026-07-02'),
          },
        ],

        programmeConsent: {
          acceptedAt: new Date('2026-07-03T10:15:00.000Z'),
          acceptedByUserId: coordinator._id,
          communicationConsent: true,
        },

        status: 'ACTIVE',
      },
    },
    {
      upsert: true,
      new: true,
    },
  );

  /*
   * ---------------------------------------------------------
   * 4. PATIENT LOGIN ACCOUNT
   *
   * THIS IS CRITICAL FOR /patient/care
   * ---------------------------------------------------------
   */

  await User.findOneAndUpdate(
    { email: 'anjali.nair.demo@apexcare.local' },
    {
      $set: {
        organizationId: clinic._id,
        name: 'Anjali Nair',
        email: 'anjali.nair.demo@apexcare.local',
        roles: ['PATIENT'],
        status: 'ACTIVE',
        mustChangePassword: false,
        patientId: patient._id,
      },
      $setOnInsert: {
        passwordHash,
      },
    },
    {
      upsert: true,
      new: true,
    },
  );

  /*
   * ---------------------------------------------------------
   * 5. CLINIC ↔ PATIENT RELATIONSHIP
   * ---------------------------------------------------------
   */

  await PatientClinicRelationship.findOneAndUpdate(
    {
      patientId: patient._id,
      clinicOrganizationId: clinic._id,
    },
    {
      $set: {
        patientId: patient._id,
        clinicOrganizationId: clinic._id,
        relationshipType: 'PRIMARY',
        status: 'ACTIVE',
        startedAt: new Date('2026-07-03'),
      },
    },
    {
      upsert: true,
      new: true,
    },
  );

  /*
   * ---------------------------------------------------------
   * 6. DIAGNOSIS
   * ---------------------------------------------------------
   */

  await Diagnosis.findOneAndUpdate(
    {
      organizationId: clinic._id,
      patientId: patient._id,
      condition: 'HYPERTENSION',
      status: 'CONFIRMED',
    },
    {
      $set: {
        organizationId: clinic._id,
        patientId: patient._id,
        condition: 'HYPERTENSION',
        status: 'CONFIRMED',
        diagnosedAt: new Date('2026-07-02'),
        diagnosedByUserId: clinician._id,
        source: 'CLINICIAN',
        notes: 'Confirmed hypertension during clinic assessment.',
      },
    },
    {
      upsert: true,
      new: true,
    },
  );

  /*
   * ---------------------------------------------------------
   * 7. PROGRAM CONSENT
   * ---------------------------------------------------------
   */

  await ProgramConsent.findOneAndUpdate(
    {
      organizationId: clinic._id,
      patientId: patient._id,
      program: 'APEXCARE_CHRONIC_CARE',
    },
    {
      $set: {
        organizationId: clinic._id,
        patientId: patient._id,
        program: 'APEXCARE_CHRONIC_CARE',
        consentGiven: true,
        consentAt: new Date('2026-07-03T10:15:00.000Z'),
        method: 'VERBAL',
        recordedByUserId: coordinator._id,
        consentVersion: '1.0',
        communicationConsent: true,
      },
    },
    {
      upsert: true,
      new: true,
    },
  );

  /*
   * ---------------------------------------------------------
   * 8. INITIAL VITAL
   * ---------------------------------------------------------
   */

  const existingVital = await VitalRecord.findOne({
    organizationId: clinic._id,
    patientId: patient._id,
    source: 'OPD',
  });

  if (!existingVital) {
    await VitalRecord.create({
      organizationId: clinic._id,
      patientId: patient._id,

      recordedAt: new Date('2026-07-03T09:30:00.000Z'),
      recordedByUserId: coordinator._id,

      source: 'OPD',

      bloodPressure: {
        systolic: 148,
        diastolic: 92,
        pulse: 82,
      },

      weightKg: 74,
      symptoms: [],
      notes: 'Baseline clinic measurement.',
    });
  }

  /*
   * ---------------------------------------------------------
   * 9. APEXCARE ENROLLMENT
   * ---------------------------------------------------------
   */

  await ApexCareEnrollment.findOneAndUpdate(
    {
      patientId: patient._id,
      apexcareOrganizationId: apexcare._id,
    },
    {
      $set: {
        patientId: patient._id,
        clinicOrganizationId: clinic._id,
        apexcareOrganizationId: apexcare._id,

        status: 'ACTIVE',

        enrolledAt: new Date('2026-07-03T10:20:00.000Z'),
        enrolledByUserId: coordinator._id,

        coordinatorCallDueAt: new Date('2026-07-04T10:00:00.000Z'),
        coordinatorCallStatus: 'CONTACTED',
        coordinatorCalledAt: new Date('2026-07-04T10:05:00.000Z'),

        dietitianAssessmentStatus: 'PENDING',

        carePlanGenerationStatus: 'COMPLETED',
      },
    },
    {
      upsert: true,
      new: true,
    },
  );

  /*
   * ---------------------------------------------------------
   * 10. REFERRAL
   * ---------------------------------------------------------
   */

  await ApexCareReferral.findOneAndUpdate(
    {
      patientId: patient._id,
      clinicOrganizationId: clinic._id,
      condition: 'HYPERTENSION',
    },
    {
      $set: {
        patientId: patient._id,
        clinicOrganizationId: clinic._id,
        apexcareOrganizationId: apexcare._id,

        referredByUserId: clinician._id,

        condition: 'HYPERTENSION',
        status: 'ENROLLED',

        referredAt: new Date('2026-07-02T12:00:00.000Z'),
        staffEscalationDueAt: new Date('2026-07-03T12:00:00.000Z'),

        enrolledAt: new Date('2026-07-03T10:20:00.000Z'),
        enrolledByUserId: coordinator._id,
      },
    },
    {
      upsert: true,
      new: true,
    },
  );

  /*
   * ---------------------------------------------------------
   * 11. 90-DAY ACTIVE CARE PLAN
   * ---------------------------------------------------------
   */

  const startDate = new Date('2026-07-03T00:00:00.000Z');
  const endDate = new Date('2026-10-01T00:00:00.000Z');

  const carePlan = await CarePlan.findOneAndUpdate(
    {
      organizationId: clinic._id,
      patientId: patient._id,
      condition: 'HYPERTENSION',
      status: 'ACTIVE',
    },
    {
      $set: {
        organizationId: clinic._id,
        patientId: patient._id,
        condition: 'HYPERTENSION',

        status: 'ACTIVE',

        startDate,
        endDate,

        goals: [
          {
            title: 'Monitor blood pressure regularly',
            target: 'At least 5 home readings per week',
            unit: 'readings/week',
          },
          {
            title: 'Improve blood pressure control',
            target: 'Average home BP below clinician-defined target',
            unit: 'mmHg',
          },
          {
            title: 'Maintain medication continuity',
            target: 'Take prescribed medication as directed',
            unit: 'adherence',
          },
        ],

        version: 1,

        createdByUserId: clinician._id,
        approvedByUserId: clinician._id,
        approvedAt: new Date('2026-07-03T14:00:00.000Z'),
      },
    },
    {
      upsert: true,
      new: true,
    },
  );

  /*
   * ---------------------------------------------------------
   * 12. CARE PLAN EXECUTION
   * ---------------------------------------------------------
   */

  const execution = await CarePlanExecution.findOneAndUpdate(
    {
      organizationId: clinic._id,
      patientId: patient._id,
      carePlanId: carePlan._id,
    },
    {
      $set: {
        organizationId: clinic._id,
        patientId: patient._id,
        carePlanId: carePlan._id,

        condition: 'HYPERTENSION',

        protocolKey: 'HTN-90-DAY-IN',
        protocolVersion: '1.0',

        status: 'ACTIVE',

        startDate,
        endDate,

        activationKey: `HTN90:${patient._id}`,
      },
    },
    {
      upsert: true,
      new: true,
    },
  );

  /*
   * ---------------------------------------------------------
   * 13. MILESTONES
   * ---------------------------------------------------------
   */

  const milestones = [
    {
      key: 'DAY_0_BASELINE',
      day: 0,
      offsetDays: 0,
      reviewRequired: false,
    },
    {
      key: 'DAY_7_EARLY_CHECK',
      day: 7,
      offsetDays: 7,
      reviewRequired: false,
    },
    {
      key: 'DAY_14_REVIEW',
      day: 14,
      offsetDays: 14,
      reviewRequired: true,
    },
    {
      key: 'DAY_30_REVIEW',
      day: 30,
      offsetDays: 30,
      reviewRequired: true,
    },
    {
      key: 'DAY_60_REVIEW',
      day: 60,
      offsetDays: 60,
      reviewRequired: true,
    },
    {
      key: 'DAY_90_OUTCOME',
      day: 90,
      offsetDays: 90,
      reviewRequired: true,
    },
  ];

  for (const item of milestones) {
    const dueAt = new Date(startDate);
    dueAt.setUTCDate(dueAt.getUTCDate() + item.day);

    await CarePlanMilestone.findOneAndUpdate(
      {
        executionId: execution._id,
        key: item.key,
      },
      {
        $set: {
          organizationId: clinic._id,
          patientId: patient._id,
          carePlanId: carePlan._id,
          executionId: execution._id,

          key: item.key,
          offsetDays: item.offsetDays,
          day: item.day,
          dueAt,

          status: item.day === 0 ? 'COMPLETED' : 'PLANNED',
          reviewRequired: item.reviewRequired,

          ...(item.day === 0
            ? {
                completedAt: new Date('2026-07-03T14:00:00.000Z'),
                completedByUserId: clinician._id,
              }
            : {}),
        },
      },
      {
        upsert: true,
        new: true,
      },
    );
  }

  /*
   * ---------------------------------------------------------
   * 14. PATIENT TASKS
   *
   * These are deliberately execution-oriented.
   * ---------------------------------------------------------
   */

  const tasks = [
    {
      taskKey: 'DAY7_HOME_BP',
      type: 'VITALS',
      title: 'Record your blood pressure',
      dueAt: new Date('2026-07-10T10:00:00.000Z'),
    },
    {
      taskKey: 'DAY7_MEDICATION',
      type: 'MEDICATION',
      title: 'Confirm today’s medication',
      dueAt: new Date('2026-07-10T20:00:00.000Z'),
    },
    {
      taskKey: 'DAY7_FOLLOW_UP',
      type: 'FOLLOW_UP',
      title: 'Tell us how you are feeling',
      dueAt: new Date('2026-07-10T20:30:00.000Z'),
    },
    {
      taskKey: 'DAY14_HOME_BP',
      type: 'VITALS',
      title: 'Record your blood pressure',
      dueAt: new Date('2026-07-17T10:00:00.000Z'),
    },
    {
      taskKey: 'DAY14_REVIEW',
      type: 'FOLLOW_UP',
      title: 'Complete your 2-week check-in',
      dueAt: new Date('2026-07-17T18:00:00.000Z'),
    },
    {
      taskKey: 'DAY30_CLINIC_REVIEW',
      type: 'OPD_VISIT',
      title: 'Hypertension review',
      dueAt: new Date('2026-08-02T10:00:00.000Z'),
    },
    {
      taskKey: 'DAY30_LAB',
      type: 'LAB',
      title: 'Complete your scheduled blood test',
      dueAt: new Date('2026-08-01T10:00:00.000Z'),
    },
  ];

  for (const task of tasks) {
    await CareTask.findOneAndUpdate(
      {
        executionId: execution._id,
        taskKey: task.taskKey,
      },
      {
        $set: {
          organizationId: clinic._id,
          patientId: patient._id,
          carePlanId: carePlan._id,
          executionId: execution._id,

          taskKey: task.taskKey,
          type: task.type,
          title: task.title,
          dueAt: task.dueAt,

          status: 'PENDING',
        },
      },
      {
        upsert: true,
        new: true,
      },
    );
  }

  /*
   * ---------------------------------------------------------
   * COMPLETE
   * ---------------------------------------------------------
   */

  console.log('\n==========================================');
  console.log('APEXCARE PATIENT SEED READY');
  console.log('==========================================');

  console.log({
    clinicOrganizationId: String(clinic._id),
    apexcareOrganizationId: String(apexcare._id),

    patientId: String(patient._id),
    medicalRecordNumber: patient.medicalRecordNumber,

    patientLogin: {
      email: 'anjali.nair.demo@apexcare.local',
      password: 'Patient@123',
      role: 'PATIENT',
    },

    clinician: {
      id: String(clinician._id),
      email: clinician.email,
    },

    coordinator: {
      id: String(coordinator._id),
      email: coordinator.email,
    },

    enrollmentStatus: patient.enrollmentStatus,

    carePlanId: String(carePlan._id),
    executionId: String(execution._id),

    condition: 'HYPERTENSION',
  });

  await mongoose.disconnect();
}

seed().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});