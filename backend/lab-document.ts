import { enqueueOutboxEvent } from './outbox.js';
import { LabDocument } from './models.js';
import { deleteLabPdf, hashLabPdf, saveLabPdf } from './storage.js';

export type CreateLabDocumentInput = {
  clinicOrganizationId: string;
  apexcareOrganizationId: string;
  patientId: string;
  uploadedByUserId: string;
  fileName: string;
  idempotencyKey: string;
  buffer: Buffer;
};

export async function createLabDocument(input: CreateLabDocumentInput) {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error('Idempotency-Key is required.');
  const fileName = input.fileName.trim().slice(0, 255) || 'lab-report.pdf';
  const sha256 = hashLabPdf(input.buffer);

  const existingByKey = await LabDocument.findOne({
    clinicOrganizationId: input.clinicOrganizationId,
    idempotencyKey,
  }).lean();
  if (existingByKey) {
    if (existingByKey.sha256 !== sha256 || String(existingByKey.patientId) !== input.patientId) {
      const error = new Error('Idempotency key was already used for a different lab document.');
      (error as Error & { code?: string }).code = 'IDEMPOTENCY_KEY_REUSE';
      throw error;
    }
    await ensureLabDocumentOutbox(existingByKey);
    return { document: existingByKey, idempotent: true };
  }

  const existingByHash = await LabDocument.findOne({
    clinicOrganizationId: input.clinicOrganizationId,
    patientId: input.patientId,
    sha256,
  }).lean();
  if (existingByHash) {
    await ensureLabDocumentOutbox(existingByHash);
    return { document: existingByHash, idempotent: true };
  }

  const stored = await saveLabPdf(input.buffer, input.clinicOrganizationId, input.patientId, sha256);
  let document;
  try {
    document = await LabDocument.create({
      patientId: input.patientId,
      clinicOrganizationId: input.clinicOrganizationId,
      apexcareOrganizationId: input.apexcareOrganizationId,
      source: 'LAB_PDF',
      status: 'UPLOADED',
      processingStage: 'QUEUED',
      fileName,
      mimeType: 'application/pdf',
      storageKey: stored.storageKey,
      storageProvider: stored.storageProvider,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      idempotencyKey,
      uploadedByUserId: input.uploadedByUserId,
      uploadedAt: new Date(),
      extractionStatus: 'NOT_STARTED',
    });
  } catch (error) {
    const duplicateKey = (error as { code?: number })?.code === 11000;
    if (duplicateKey) {
      const recovered = await LabDocument.findOne({
        clinicOrganizationId: input.clinicOrganizationId,
        $or: [{ idempotencyKey }, { patientId: input.patientId, sha256 }],
      }).lean();
      if (recovered) {
        await cleanupStoredObject(stored.storageKey, stored.storageProvider);
        if (recovered.idempotencyKey === idempotencyKey && (String(recovered.patientId) !== input.patientId || recovered.sha256 !== sha256)) {
          const reuseError = new Error('Idempotency key was already used for a different lab document.');
          (reuseError as Error & { code?: string }).code = 'IDEMPOTENCY_KEY_REUSE';
          throw reuseError;
        }
        if (String(recovered.patientId) !== input.patientId || recovered.sha256 !== sha256) throw error;
        await ensureLabDocumentOutbox(recovered);
        return { document: recovered, idempotent: true };
      }
    }
    await cleanupStoredObject(stored.storageKey, stored.storageProvider);
    throw error;
  }

  // Keep the object if outbox persistence fails: MongoDB already owns the source record,
  // and a retry/reconciliation may safely publish the event later.
  await ensureLabDocumentOutbox(document.toObject());
  return { document: document.toObject(), idempotent: false };
}

async function cleanupStoredObject(storageKey: string, storageProvider: 'local' | 's3') {
  try {
    await deleteLabPdf(storageKey, storageProvider);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    console.error('Medical document orphan cleanup failed', { errorCode: typeof code === 'string' ? code : 'STORAGE_DELETE_FAILED' });
  }
}

async function ensureLabDocumentOutbox(document: { _id: unknown; clinicOrganizationId: unknown; patientId: unknown; apexcareOrganizationId: unknown; processingVersion?: number }) {
  const organizationId = String(document.clinicOrganizationId);
  const documentId = String(document._id);
  await enqueueOutboxEvent({
    organizationId,
    eventKey: `LAB_DOCUMENT_UPLOADED:${documentId}`,
    eventType: 'LAB_DOCUMENT_UPLOADED',
    aggregateType: 'LabDocument',
    aggregateId: documentId,
    payload: {
      documentId,
      patientId: String(document.patientId),
      clinicOrganizationId: organizationId,
      apexcareOrganizationId: String(document.apexcareOrganizationId),
      processingVersion: document.processingVersion ?? 1,
    },
  });
}

export async function getLabDocumentForClinic(documentId: string, clinicOrganizationId: string) {
  return LabDocument.findOne({ _id: documentId, clinicOrganizationId }).lean();
}
