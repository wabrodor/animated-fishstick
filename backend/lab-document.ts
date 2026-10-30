import { enqueueOutboxEvent } from './outbox.js';
import { LabDocument } from './models.js';
import { hashLabPdf, saveLabPdf } from './storage.js';

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
  try {
    const document = await LabDocument.create({
      patientId: input.patientId,
      clinicOrganizationId: input.clinicOrganizationId,
      apexcareOrganizationId: input.apexcareOrganizationId,
      source: 'LAB_PDF',
      status: 'UPLOADED',
      fileName,
      mimeType: 'application/pdf',
      storageKey: stored.storageKey,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      idempotencyKey,
      uploadedByUserId: input.uploadedByUserId,
      uploadedAt: new Date(),
      extractionStatus: 'NOT_STARTED',
    });
    await ensureLabDocumentOutbox(document.toObject());
    return { document: document.toObject(), idempotent: false };
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    const recovered = await LabDocument.findOne({
      clinicOrganizationId: input.clinicOrganizationId,
      $or: [{ idempotencyKey }, { patientId: input.patientId, sha256 }],
    }).lean();
    if (!recovered) throw error;
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

async function ensureLabDocumentOutbox(document: { _id: unknown; clinicOrganizationId: unknown; patientId: unknown; apexcareOrganizationId: unknown; fileName: string; sha256: string; storageKey: string }) {
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
      fileName: document.fileName,
      sha256: document.sha256,
      storageKey: document.storageKey,
    },
  });
}

export async function getLabDocumentForClinic(documentId: string, clinicOrganizationId: string) {
  return LabDocument.findOne({ _id: documentId, clinicOrganizationId }).lean();
}
