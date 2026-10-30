import { UnrecoverableError, Worker } from 'bullmq';
import { redisConnection, scheduleCarePlanReviewSla } from '../queues.js';
import { ApexCareEnrollment, ApexCareReferral, CarePlanDraft, CareTask, ClinicalReviewCase, ClinicalReviewEvent, MedicationDraft, Patient, PrescriptionDocument } from '../models.js';
import { generateHypertensionCarePlanDraft } from '../ai-care-plan.js';
import { analyzePrescriptionImage, verifySubmittedMedicationList } from '../prescription-analysis.js';
import { openMedicationClinicalReview } from '../clinical-review.js';
import { enqueueOutboxEvent } from '../outbox.js';
import { medicalDocumentStructuring } from '../config.js';
import { PRESCRIPTION_STRUCTURING_PROMPT_VERSION, PRESCRIPTION_STRUCTURING_SCHEMA_VERSION } from '../prescription-analysis.js';

import { connectDatabase, disconnectDatabase } from '../db.js';
import { processOutboxBatch } from '../outbox-dispatcher.js';
import { createCareTaskReminderCommunication } from '../patient-communication.js';
import { processCarePlanMilestone } from '../milestone-orchestrator.js';
import { processLabDocumentExtraction } from '../lab-pdf-extraction.js';
import { processLabResultStructuring } from '../lab-result-structuring.js';
import { processLabInterpretation } from '../lab-interpretation.js';

async function startWorkers() {
  await connectDatabase();

  console.log('[WORKER] MongoDB connected');
  console.log('[WORKER] Starting BullMQ workers...');

  const worker = new Worker(
    'apexcare-reminders',
    async (job) => {
      if (job.name !== 'care-task-due') return;

      const task = await CareTask.findOne({
        _id: job.data.taskId,
        organizationId: job.data.organizationId,
        patientId: job.data.patientId,
      }).lean();

      if (!task || !['PENDING', 'OVERDUE'].includes(task.status)) {
        return;
      }

      const communication = await createCareTaskReminderCommunication({
        organizationId: String(task.organizationId),
        taskId: String(task._id),
      });

      console.log(JSON.stringify({
        type: 'CARE_TASK_REMINDER_DUE',
        taskId: String(task._id),
        patientId: String(task.patientId),
        organizationId: String(task.organizationId),
        dueAt: task.dueAt,
        taskType: task.type,
        communicationId: communication ? String(communication.communication._id) : null,
        idempotent: communication?.idempotent ?? false,
      }));
    },
    { connection: redisConnection },
  );

  const prescriptionWorker = new Worker(
    'apexcare-prescription-analysis',
    async (job) => {
      if (job.name === 'analyze-prescription-image') {
        const document = await PrescriptionDocument.findOne({ _id: job.data.documentId, source: 'IMAGE', analysisStatus: 'PENDING', status: 'ANALYZING' });
        if (!document) return;
        document.processingStage = 'OCR';
        document.processingAttempts = (document.processingAttempts ?? 0) + 1;
        await document.save();

        const draft = await MedicationDraft.findOne({ prescriptionDocumentId: document._id }).sort({ createdAt: -1 });
        if (!draft) {
          throw new Error(`Medication draft missing for prescription document ${String(document._id)}`);
        }
        if (draft.status !== 'DRAFT') {
          document.analysisStatus = draft.clinicalReviewRequired ? 'FAILED' : 'COMPLETED';
          document.status = draft.clinicalReviewRequired ? 'NEEDS_CLINICAL_REVIEW' : 'VERIFICATION_REQUIRED';
          document.clinicalReviewReason = draft.clinicalReviewReason;
          await document.save();
          return;
        }

        const analysis = await analyzePrescriptionImage(document.storageKey, document.mimeType, document.storageProvider);
        draft.rawText = analysis.rawText;
        draft.medications = analysis.medications;
        draft.status = 'VERIFICATION_REQUIRED';
        draft.clinicalReviewRequired = true;
        draft.clinicalReviewReason = analysis.clinicalReviewRequired
          ? analysis.clinicalReviewReason
          : 'OCR extraction completed. Clinician verification is required before this prescription can become an active medication record.';
        await draft.save();

        document.analysisStatus = analysis.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
        document.status = analysis.status === 'COMPLETED' ? 'VERIFICATION_REQUIRED' : 'NEEDS_CLINICAL_REVIEW';
        document.clinicalReviewReason = draft.clinicalReviewReason;
        document.ocrLines = analysis.ocrLines ?? [];
        document.ocrFullText = analysis.rawText;
        document.ocrWarningCode = analysis.ocrWarningCode;
        document.ocrEngine = analysis.status === 'UNAVAILABLE' ? undefined : 'PADDLEOCR';
        document.ocrEngineVersion = analysis.status === 'UNAVAILABLE' ? undefined : '2.9.1';
        document.ocrProcessedAt = analysis.status === 'UNAVAILABLE' ? undefined : new Date();
        document.structuringProvider = medicalDocumentStructuring.enabled && Boolean(analysis.rawText) ? 'DEEPSEEK' : undefined;
        document.structuringModel = document.structuringProvider ? medicalDocumentStructuring.model : undefined;
        document.structuringPromptVersion = document.structuringProvider ? PRESCRIPTION_STRUCTURING_PROMPT_VERSION : undefined;
        document.structuringSchemaVersion = document.structuringProvider ? PRESCRIPTION_STRUCTURING_SCHEMA_VERSION : undefined;
        document.processingStage = analysis.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
        document.safeLastErrorCode = analysis.status === 'COMPLETED' ? undefined : 'OCR_OR_STRUCTURING_FAILED';
        await document.save();
        const analyzedPatient = await Patient.findOne({ _id: document.patientId, organizationId: document.clinicOrganizationId, status: 'ACTIVE' }).select('assignedClinicianId name').lean();
        if (analyzedPatient?.assignedClinicianId) {
          await enqueueOutboxEvent({
            organizationId: String(document.clinicOrganizationId),
            eventKey: `prescription-ocr-completed:${document._id}`,
            eventType: 'PRESCRIPTION_OCR_COMPLETED',
            aggregateType: 'PrescriptionDocument',
            aggregateId: document._id,
            payload: { patientId: String(document.patientId), patientName: `${analyzedPatient.name.first} ${analyzedPatient.name.last ?? ''}`.trim(), prescriptionDocumentId: String(document._id), clinicianId: String(analyzedPatient.assignedClinicianId), clinicalReviewRequired: draft.clinicalReviewRequired },
          });
        }
        if (analysis.status === 'COMPLETED' || draft.clinicalReviewRequired) {
          const patient = await Patient.findOne({ _id: document.patientId, organizationId: document.clinicOrganizationId, status: 'ACTIVE' }).select('assignedClinicianId').lean();
          if (patient?.assignedClinicianId) {
            await openMedicationClinicalReview({
              patientId: String(document.patientId),
              clinicOrganizationId: String(document.clinicOrganizationId),
              apexcareOrganizationId: String(document.apexcareOrganizationId),
              prescriptionDocumentId: String(document._id),
              medicationDraftId: String(draft._id),
              clinicClinicianId: String(patient.assignedClinicianId),
              reasonCode: analysis.clinicalReviewRequired ? 'AI_DISCREPANCY' : 'AI_VERIFICATION_REQUIRED',
              reason: analysis.clinicalReviewReason || 'OCR extraction completed. Clinician verification is required before this prescription can become an active medication record.',
            });
          }
        }
        return;
      }

      if (job.name === 'verify-prescription-medications') {
        const document = await PrescriptionDocument.findOne({ _id: job.data.documentId, source: 'IMAGE' });
        const draft = await MedicationDraft.findOne({ _id: job.data.draftId, prescriptionDocumentId: job.data.documentId, status: 'VERIFYING' });
        if (!document || !draft) return;

        const verification = await verifySubmittedMedicationList(
          document.storageKey,
          document.mimeType,
          draft.medications.map((medication) => ({
            name: medication.name,
            strength: medication.strength,
            dose: medication.dose,
            route: medication.route,
            frequency: medication.frequency,
            duration: medication.duration,
            instructions: medication.instructions,
            confidence: medication.confidence,
            sourceText: medication.sourceText,
          })),
          document.storageProvider,
        );

        draft.clinicalReviewRequired = verification.clinicalReviewRequired || verification.status !== 'COMPLETED';
        draft.clinicalReviewReason = verification.clinicalReviewReason;
        if (draft.clinicalReviewRequired) {
          draft.status = 'VERIFICATION_REQUIRED';
        } else {
          draft.status = 'VERIFIED';
          draft.verifiedByUserId = draft.staffSubmittedByUserId;
          draft.verifiedAt = new Date();
        }
        await draft.save();

        document.status = draft.clinicalReviewRequired ? 'NEEDS_CLINICAL_REVIEW' : 'VERIFIED';
        document.analysisStatus = verification.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
        document.clinicalReviewReason = verification.clinicalReviewReason;
        document.verifiedByUserId = draft.status === 'VERIFIED' ? draft.staffSubmittedByUserId : undefined;
        document.verifiedAt = draft.status === 'VERIFIED' ? new Date() : undefined;
        await document.save();
        if (draft.clinicalReviewRequired) {
          const patient = await Patient.findOne({ _id: document.patientId, organizationId: document.clinicOrganizationId, status: 'ACTIVE' }).select('assignedClinicianId').lean();
          if (patient?.assignedClinicianId) {
            await openMedicationClinicalReview({
              patientId: String(document.patientId),
              clinicOrganizationId: String(document.clinicOrganizationId),
              apexcareOrganizationId: String(document.apexcareOrganizationId),
              prescriptionDocumentId: String(document._id),
              medicationDraftId: String(draft._id),
              clinicClinicianId: String(patient.assignedClinicianId),
              reasonCode: verification.status === 'COMPLETED' ? 'AI_DISCREPANCY' : 'AI_VERIFICATION_FAILURE',
              reason: verification.clinicalReviewReason || 'AI verification identified a medication discrepancy requiring clinical review.',
            });
          }
        }
      }
    },
    { connection: redisConnection },
  );

  prescriptionWorker.on('completed', (job) => {
    console.log(`Prescription AI job completed: ${job.id}`);
  });

  prescriptionWorker.on('failed', async (job, error) => {
    console.error(`Prescription AI job failed: ${job?.id}`, error);
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;

    try {
      if (job.name === 'analyze-prescription-image') {
        const document = await PrescriptionDocument.findOne({ _id: job.data.documentId, status: 'ANALYZING' });
        if (!document) return;
        const reason = 'Prescription AI processing failed after all retries. Manual clinical review is required.';
        await PrescriptionDocument.updateOne(
          { _id: job.data.documentId, status: 'ANALYZING' },
          { $set: { analysisStatus: 'FAILED', status: 'NEEDS_CLINICAL_REVIEW', clinicalReviewReason: reason } },
        );
        const draft = await MedicationDraft.findOne({ prescriptionDocumentId: job.data.documentId, status: 'DRAFT' });
        if (!draft) return;
        await MedicationDraft.updateOne(
          { _id: draft._id, status: 'DRAFT' },
          { $set: { status: 'VERIFICATION_REQUIRED', clinicalReviewRequired: true, clinicalReviewReason: reason } },
        );
        const failedPatient = await Patient.findOne({ _id: document.patientId, organizationId: document.clinicOrganizationId, status: 'ACTIVE' }).select('assignedClinicianId name').lean();
        if (failedPatient?.assignedClinicianId) {
          await enqueueOutboxEvent({
            organizationId: String(document.clinicOrganizationId),
            eventKey: `prescription-ocr-completed:${document._id}:failed`,
            eventType: 'PRESCRIPTION_OCR_COMPLETED',
            aggregateType: 'PrescriptionDocument',
            aggregateId: document._id,
            payload: { patientId: String(document.patientId), patientName: `${failedPatient.name.first} ${failedPatient.name.last ?? ''}`.trim(), prescriptionDocumentId: String(document._id), clinicianId: String(failedPatient.assignedClinicianId), clinicalReviewRequired: true },
          });
        }
        const patient = await Patient.findOne({ _id: document.patientId, organizationId: document.clinicOrganizationId, status: 'ACTIVE' }).select('assignedClinicianId').lean();
        if (patient?.assignedClinicianId) {
          await openMedicationClinicalReview({
            patientId: String(document.patientId),
            clinicOrganizationId: String(document.clinicOrganizationId),
            apexcareOrganizationId: String(document.apexcareOrganizationId),
            prescriptionDocumentId: String(document._id),
            medicationDraftId: String(draft._id),
            clinicClinicianId: String(patient.assignedClinicianId),
            reasonCode: 'AI_ANALYSIS_FAILURE',
            reason,
          });
        }
      }

      if (job.name === 'verify-prescription-medications') {
        const reason = 'Prescription verification failed after all retries. Manual clinical review is required.';
        const draft = await MedicationDraft.findOne({ _id: job.data.draftId, status: 'VERIFYING' });
        const document = await PrescriptionDocument.findOne({ _id: job.data.documentId });
        if (!draft || !document) return;
        await MedicationDraft.updateOne(
          { _id: draft._id, status: 'VERIFYING' },
          { $set: { status: 'VERIFICATION_REQUIRED', clinicalReviewRequired: true, clinicalReviewReason: reason } },
        );
        await PrescriptionDocument.updateOne(
          { _id: job.data.documentId },
          { $set: { status: 'NEEDS_CLINICAL_REVIEW', analysisStatus: 'FAILED', clinicalReviewReason: reason } },
        );
        const patient = await Patient.findOne({ _id: document.patientId, organizationId: document.clinicOrganizationId, status: 'ACTIVE' }).select('assignedClinicianId').lean();
        if (patient?.assignedClinicianId) {
          await openMedicationClinicalReview({
            patientId: String(document.patientId),
            clinicOrganizationId: String(document.clinicOrganizationId),
            apexcareOrganizationId: String(document.apexcareOrganizationId),
            prescriptionDocumentId: String(document._id),
            medicationDraftId: String(draft._id),
            clinicClinicianId: String(patient.assignedClinicianId),
            reasonCode: 'AI_VERIFICATION_FAILURE',
            reason,
          });
        }
      }
    } catch (finalizationError) {
      console.error('Prescription AI terminal-failure update failed.', finalizationError);
    }
  });

  const labWorker = new Worker(
    'apexcare-lab-processing',
    async (job) => {
      if (job.name === 'extract-lab-pdf') {
        return processLabDocumentExtraction(String(job.data.documentId), new Date(), Number(job.data.processingVersion ?? 1));
      }
      if (job.name === 'structure-lab-results') {
        return processLabResultStructuring(String(job.data.documentId), new Date(), Number(job.data.processingVersion ?? 1));
      }
      if (job.name === 'interpret-lab-results') {
        return processLabInterpretation(String(job.data.documentId), { organizationId: String(job.data.organizationId), patientId: String(job.data.patientId), apexcareOrganizationId: String(job.data.apexcareOrganizationId) });
      }
      return;
    },
    { connection: redisConnection },
  );

  labWorker.on('completed', (job) => {
    console.log(`Lab PDF extraction job completed: ${job.id}`);
  });

  labWorker.on('failed', (job, error) => {
    console.error(`Lab PDF extraction job failed: ${job?.id}`, error);
  });

  const operationalWorker = new Worker(
    'apexcare-operational',
    async (job) => {
      if (job.name === 'care-plan-milestone-due') {
        const result = await processCarePlanMilestone({
          organizationId: String(job.data.organizationId),
          patientId: String(job.data.patientId),
          executionId: String(job.data.executionId),
          milestoneId: String(job.data.milestoneId),
        });
        console.log(JSON.stringify({ type: 'CARE_PLAN_MILESTONE_ORCHESTRATED', jobId: String(job.id), ...result }));
        return result;
      }

      if (job.name === 'referral-staff-sla') {
        const referral = await ApexCareReferral.findOne({ _id: job.data.referralId, status: 'PENDING_STAFF', staffEscalatedAt: { $exists: false } });
        if (!referral) return;
        referral.staffEscalatedAt = new Date();
        await referral.save();
        console.log(JSON.stringify({ type: 'APEXCARE_CLINIC_REFERRAL_ESCALATION', referralId: String(referral._id), clinicOrganizationId: String(referral.clinicOrganizationId), patientId: String(referral.patientId) }));
        return;
      }
      if (job.name === 'coordinator-call-sla') {
        const enrollment = await ApexCareEnrollment.findOne({ _id: job.data.enrollmentId, status: 'ACTIVE', coordinatorCallStatus: 'PENDING' });
        if (!enrollment) return;
        enrollment.coordinatorCallStatus = 'ESCALATED';
        await enrollment.save();
        console.log(JSON.stringify({ type: 'APEXCARE_COORDINATOR_CALL_ESCALATION', enrollmentId: String(enrollment._id), apexcareOrganizationId: String(enrollment.apexcareOrganizationId), patientId: String(enrollment.patientId) }));
        return;
      }
      if (job.name === 'care-plan-review-sla') {
        const draft = await CarePlanDraft.findOne({ _id: job.data.draftId, status: { $in: ['GENERATED', 'CLINICIAN_REVIEW'] }, fallbackEligibleAt: { $lte: new Date() } }).lean();
        if (!draft) return;
        console.log(JSON.stringify({ type: 'APEXCARE_CARE_PLAN_FALLBACK_ELIGIBLE', draftId: String(draft._id), clinicOrganizationId: String(draft.organizationId), patientId: String(draft.patientId) }));
        return;
      }
      if (job.name === 'clinical-review-sla') {
        const reviewCase = await ClinicalReviewCase.findOneAndUpdate(
          { _id: job.data.reviewCaseId, status: 'CLINICIAN_REVIEW', clinicReviewDueAt: { $lte: new Date() } },
          { $set: { status: 'APEXCARE_REVIEW', decision: 'ESCALATED', decisionReason: 'Clinic clinician review window expired.', apexcareEscalatedAt: new Date() } },
          { new: true },
        );
        if (!reviewCase) return;
        await ClinicalReviewEvent.create({
          clinicalReviewCaseId: reviewCase._id,
          patientId: reviewCase.patientId,
          clinicOrganizationId: reviewCase.clinicOrganizationId,
          apexcareOrganizationId: reviewCase.apexcareOrganizationId,
          eventType: 'ESCALATED',
          fromStatus: 'CLINICIAN_REVIEW',
          toStatus: 'APEXCARE_REVIEW',
          actorType: 'SYSTEM',
          decision: 'ESCALATED',
          reason: 'Clinic clinician review window expired.',
        });
        console.log(JSON.stringify({ type: 'APEXCARE_CLINICAL_REVIEW_ESCALATED', reviewCaseId: String(reviewCase._id), apexcareOrganizationId: String(reviewCase.apexcareOrganizationId), patientId: String(reviewCase.patientId) }));
        return;
      }
    },
    { connection: redisConnection },
  );

  operationalWorker.on('completed', (job) => {
    console.log(`Operational job completed: ${job.id}`);
  });

  operationalWorker.on('failed', (job, error) => {
    console.error(`Operational job failed: ${job?.id}`, error);
  });

  worker.on('completed', (job) => {
    console.log(`Reminder job completed: ${job.id}`);
  });

  worker.on('failed', (job, error) => {
    console.error(`Reminder job failed: ${job?.id}`, error);
  });

  const aiWorker = new Worker(
    'apexcare-ai-care-plans',
    async (job) => {
      if (job.name !== 'generate-hypertension-draft') return;

      const {
        patientId,
        clinicOrganizationId,
        apexcareOrganizationId,
        clinicianId,
        enrollmentId,
        assessmentId,
        attempt,
      } = job.data as {
        patientId: string;
        clinicOrganizationId: string;
        apexcareOrganizationId: string;
        clinicianId: string;
        enrollmentId: string;
        assessmentId: string;
        attempt: number;
      };

      const enrollment = await ApexCareEnrollment.findOneAndUpdate(
        {
          _id: enrollmentId,
          patientId,
          clinicOrganizationId,
          apexcareOrganizationId,
          status: 'ACTIVE',
          carePlanGenerationAssessmentId: assessmentId,
          carePlanGenerationAttempt: attempt,
          carePlanGenerationJobId: String(job.id),
          carePlanGenerationStatus: { $in: ['QUEUED', 'PROCESSING'] },
        },
        { $set: { carePlanGenerationStatus: 'PROCESSING', carePlanGenerationError: null } },
        { new: true },
      ).lean();

      if (!enrollment) {
        const completed = await ApexCareEnrollment.findOne({
          _id: enrollmentId,
          patientId,
          clinicOrganizationId,
          apexcareOrganizationId,
          carePlanGenerationAssessmentId: assessmentId,
          carePlanGenerationAttempt: attempt,
          carePlanGenerationStatus: 'COMPLETED',
          carePlanDraftId: { $exists: true },
        }).select('carePlanDraftId').lean();
        if (completed?.carePlanDraftId) return;
        throw new UnrecoverableError('Care-plan generation context is no longer valid.');
      }

      const patient = await Patient.findOne({ _id: patientId, organizationId: clinicOrganizationId, status: 'ACTIVE', assignedClinicianId: clinicianId }).select('_id').lean();
      if (!patient) throw new UnrecoverableError('Assigned clinician or patient context is no longer valid.');

      const result = await generateHypertensionCarePlanDraft(
        apexcareOrganizationId,
        clinicOrganizationId,
        patientId,
        clinicianId,
        enrollmentId,
        assessmentId,
      );
      if (!result || 'error' in result) {
        const failureCode = result && 'error' in result ? result.error : 'NOT_GENERATED';
        // Enrollment/history writes may become visible just after a queued job starts.
        // Keep the context gate strict, but let BullMQ's bounded retry policy re-check it.
        if (failureCode === 'CARE_PLAN_GENERATION_CONTEXT_INVALID') {
          throw new Error(`Care-plan generation failed: ${failureCode}`);
        }
        throw new UnrecoverableError(`Care-plan generation failed: ${failureCode}`);
      }

      const updated = await ApexCareEnrollment.updateOne(
        {
          _id: enrollmentId,
          patientId,
          clinicOrganizationId,
          apexcareOrganizationId,
          carePlanGenerationAssessmentId: assessmentId,
          carePlanGenerationAttempt: attempt,
          carePlanGenerationJobId: String(job.id),
          carePlanGenerationStatus: 'PROCESSING',
        },
        { $set: { carePlanDraftId: result._id, carePlanGenerationStatus: 'COMPLETED', carePlanGenerationError: null } },
      );

      if (updated.modifiedCount === 0) {
        const current = await ApexCareEnrollment.findOne({ _id: enrollmentId, carePlanDraftId: result._id, carePlanGenerationStatus: 'COMPLETED' }).select('_id').lean();
        if (!current) throw new Error('Care-plan generation completion could not be persisted.');
      }

      await Patient.updateOne(
        { _id: patientId, organizationId: clinicOrganizationId, status: 'ACTIVE' },
        { $set: { enrollmentStatus: 'CARE_PLAN_REVIEW' } },
      );
      if (result.clinicianReviewDueAt) {
        await scheduleCarePlanReviewSla(String(result._id), result.clinicianReviewDueAt);
      }
    },
    { connection: redisConnection },
  );

  aiWorker.on('completed', (job) => {
    console.log(`AI care-plan job completed: ${job.id}`);
  });

  aiWorker.on('failed', async (job, error) => {
    console.error(`AI care-plan job failed: ${job?.id}`, error);
    if (!job) return;
    if (job.name !== 'generate-hypertension-draft') return;
    if (!(error instanceof UnrecoverableError) && job.attemptsMade < (job.opts.attempts ?? 1)) return;
    const data = job.data as { enrollmentId?: string; assessmentId?: string; attempt?: number; patientId?: string; clinicOrganizationId?: string; apexcareOrganizationId?: string };
    if (!data.enrollmentId || !data.assessmentId || data.attempt === undefined) return;
    await ApexCareEnrollment.updateOne(
      {
        _id: data.enrollmentId,
        patientId: data.patientId,
        clinicOrganizationId: data.clinicOrganizationId,
        apexcareOrganizationId: data.apexcareOrganizationId,
        carePlanGenerationAssessmentId: data.assessmentId,
        carePlanGenerationAttempt: data.attempt,
        carePlanGenerationJobId: String(job.id),
        carePlanGenerationStatus: { $in: ['QUEUED', 'PROCESSING'] },
      },
      { $set: { carePlanGenerationStatus: 'FAILED', carePlanGenerationError: error.message.slice(0, 1000) } },
    );
  });

  let outboxStopped = false;
  let outboxTimer: ReturnType<typeof setTimeout> | undefined;
  let outboxDelayMs = 1000;

  const runOutboxCycle = async () => {
    if (outboxStopped) return;

    try {
      const processed = await processOutboxBatch();
      // Stay responsive while work exists; back off when the outbox is idle.
      outboxDelayMs = processed > 0 ? 1000 : Math.min(30_000, Math.max(5_000, outboxDelayMs * 2));
    } catch (error) {
      console.error('[OUTBOX] Dispatcher cycle failed:', error);
      outboxDelayMs = Math.min(30_000, Math.max(5_000, outboxDelayMs * 2));
    }

    if (!outboxStopped) {
      outboxTimer = setTimeout(() => void runOutboxCycle(), outboxDelayMs);
    }
  };

  void runOutboxCycle();

  const shutdown = async () => {
    console.log('[WORKER] Shutting down...');
    outboxStopped = true;
    if (outboxTimer) clearTimeout(outboxTimer);

    await worker.close();
    await operationalWorker.close();
    await aiWorker.close();
    await prescriptionWorker.close();
    await labWorker.close();
    await redisConnection.quit();
    await disconnectDatabase();

    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  console.log('[WORKER] Workers ready');
}

startWorkers().catch((error) => {
  console.error('[WORKER] Startup failed:', error);
  process.exit(1);
});
