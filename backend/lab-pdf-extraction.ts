import { inflateSync, inflateRawSync } from 'node:zlib';
import { LabDocument } from './models.js';
import { enqueueOutboxEvent } from './outbox.js';
import { readLabPdf } from './storage.js';
import { runMedicalDocumentOcr } from './medical-document-ocr.js';

export const LAB_PDF_EXTRACTION_VERSION = 2;
const PROCESSING_LEASE_MS = 10 * 60 * 1000;
const MAX_EXTRACTED_TEXT = 100_000;

function decodePdfLiteral(value: string): string {
  let output = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== '\\') {
      output += char;
      continue;
    }
    const next = value[++i];
    if (next === undefined) break;
    const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    if (escapes[next] !== undefined) {
      output += escapes[next];
      continue;
    }
    if (/^[0-7]$/.test(next)) {
      let octal = next;
      for (let j = 0; j < 2 && i + 1 < value.length && /^[0-7]$/.test(value[i + 1]); j += 1) octal += value[++i];
      output += String.fromCharCode(parseInt(octal, 8));
      continue;
    }
    output += next;
  }
  return output;
}

function decodePdfHex(value: string): string {
  const clean = value.replace(/\s+/g, '');
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  try {
    return Buffer.from(padded, 'hex').toString('utf8');
  } catch {
    return '';
  }
}

function decodeStream(raw: Buffer, flate: boolean): Buffer {
  if (!flate) return raw;
  try {
    return inflateSync(raw);
  } catch {
    return inflateRawSync(raw);
  }
}

function extractTextOperators(stream: string): string[] {
  const chunks: string[] = [];
  const literalTj = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = literalTj.exec(stream))) chunks.push(decodePdfLiteral(match[1]));

  const hexTj = /<([0-9A-Fa-f\s]+)>\s*Tj/g;
  while ((match = hexTj.exec(stream))) chunks.push(decodePdfHex(match[1]));

  const arrays = /\[([\s\S]*?)\]\s*TJ/g;
  while ((match = arrays.exec(stream))) {
    const body = match[1];
    const literal = /\(((?:\\.|[^\\)])*)\)/g;
    let item: RegExpExecArray | null;
    while ((item = literal.exec(body))) chunks.push(decodePdfLiteral(item[1]));
    const hex = /<([0-9A-Fa-f\s]+)>/g;
    while ((item = hex.exec(body))) chunks.push(decodePdfHex(item[1]));
  }
  return chunks;
}

/**
 * Extracts text from text-based PDFs without OCR. It supports ordinary PDF text
 * operators and Flate-compressed content streams. Scanned/image-only PDFs are
 * deliberately rejected for the 3D.2 deterministic extraction layer.
 */
export function extractPdfText(buffer: Buffer): string {
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('LAB_PDF_INVALID_FORMAT');
  }

  const chunks: string[] = [];
  const streamPattern = /<<(?:[\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(buffer.toString('latin1')))) {
    const dictionary = match[0].slice(0, match[0].indexOf('stream'));
    const raw = Buffer.from(match[1], 'latin1');
    const flate = /\/Filter\s*\/FlateDecode(?:\s|\/|>)/.test(dictionary) || /\/Filter\s*\[\s*\/FlateDecode/.test(dictionary);
    let decoded: Buffer;
    try {
      decoded = decodeStream(raw, flate);
    } catch {
      continue;
    }
    chunks.push(...extractTextOperators(decoded.toString('latin1')));
  }

  // A minimal fallback for small uncompressed fixtures/PDFs whose content is
  // outside a conventional stream block.
  if (chunks.length === 0) chunks.push(...extractTextOperators(buffer.toString('latin1')));

  const text = chunks
    .map((chunk) => chunk.replace(/[\u0000\r]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!text) throw new Error('LAB_PDF_NO_TEXT_CONTENT');
  return text.slice(0, MAX_EXTRACTED_TEXT);
}

export async function claimLabDocumentExtraction(documentId: string, now = new Date(), processingVersion = 1) {
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  const generationFilter = processingVersion === 1 ? { $or: [{ processingVersion: 1 }, { processingVersion: { $exists: false } }] } : { processingVersion };
  return LabDocument.findOneAndUpdate(
    {
      _id: documentId,
      $and: [generationFilter],
      $or: [
        { extractionStatus: { $in: ['NOT_STARTED', 'QUEUED', 'FAILED'] } },
        { extractionStatus: 'PROCESSING', extractionStartedAt: { $lte: staleBefore } },
      ],
    },
    {
      $set: {
        status: 'PROCESSING',
        extractionStatus: 'PROCESSING',
        processingStage: 'OCR',
        extractionStartedAt: now,
        extractionError: undefined,
      },
      $inc: { processingAttempts: 1 },
    },
    { new: true },
  ).lean();
}

async function ensureLabExtractionOutbox(document: { _id: unknown; clinicOrganizationId: unknown; patientId: unknown; apexcareOrganizationId: unknown; sha256: string; processingVersion?: number }) {
  await enqueueOutboxEvent({
    organizationId: String(document.clinicOrganizationId),
    eventKey: `LAB_DOCUMENT_EXTRACTED:${String(document._id)}:v${document.processingVersion ?? 1}:ocr${LAB_PDF_EXTRACTION_VERSION}`,
    eventType: 'LAB_DOCUMENT_EXTRACTED',
    aggregateType: 'LabDocument',
    aggregateId: String(document._id),
    payload: {
      documentId: String(document._id),
      patientId: String(document.patientId),
      clinicOrganizationId: String(document.clinicOrganizationId),
      apexcareOrganizationId: String(document.apexcareOrganizationId),
      sha256: document.sha256,
      processingVersion: document.processingVersion ?? 1,
    },
  });
}

export async function processLabDocumentExtraction(documentId: string, now = new Date(), processingVersion = 1) {
  const document = await claimLabDocumentExtraction(documentId, now, processingVersion);
  if (!document) {
    const completed = await LabDocument.findOne({ _id: documentId, ...(processingVersion === 1 ? { $or: [{ processingVersion: 1 }, { processingVersion: { $exists: false } }] } : { processingVersion }), extractionStatus: 'COMPLETED' }).select('_id clinicOrganizationId patientId apexcareOrganizationId sha256 processingVersion').lean();
    if (completed) await ensureLabExtractionOutbox(completed);
    return { processed: false, idempotent: true };
  }

  let extractionPersisted = false;
  try {
    const pdf = await readLabPdf(document.storageKey, document.storageProvider);
    const ocr = await runMedicalDocumentOcr(pdf, 'application/pdf');
    if (ocr.status === 'FAILED') throw new Error('PADDLEOCR_REQUEST_FAILED');
    const extractedText = ocr.status === 'COMPLETED' ? (ocr.rawText ?? '') : extractPdfText(pdf);
    const legacyPdfFallback = ocr.status === 'UNAVAILABLE';
    const updated = await LabDocument.updateOne(
      {
        _id: document._id,
        $and: [processingVersion === 1 ? { $or: [{ processingVersion: 1 }, { processingVersion: { $exists: false } }] } : { processingVersion }],
        clinicOrganizationId: document.clinicOrganizationId,
        patientId: document.patientId,
        sha256: document.sha256,
        extractionStatus: 'PROCESSING',
      },
      {
        $set: {
          status: 'EXTRACTED',
          extractionStatus: 'COMPLETED',
          extractedText,
          ocrLines: ocr.lines ?? [],
          ocrEngine: legacyPdfFallback ? 'LOCAL_PDF_TEXT' : 'PADDLEOCR',
          ocrEngineVersion: legacyPdfFallback ? 'legacy-parser-v1' : '2.9.1',
          ocrProcessedAt: new Date(),
          ocrWarningCode: ocr.warningCode ?? (legacyPdfFallback ? 'PADDLEOCR_NOT_CONFIGURED' : undefined),
          extractionWarningCode: ocr.warningCode ?? (legacyPdfFallback ? 'PADDLEOCR_NOT_CONFIGURED' : undefined),
          processingStage: 'AI_EXTRACTION',
          safeLastErrorCode: undefined,
          extractionVersion: LAB_PDF_EXTRACTION_VERSION,
          extractionError: undefined,
        },
        $unset: { extractionStartedAt: 1 },
      },
    );
    if (updated.modifiedCount !== 1) throw new Error('LAB_PDF_EXTRACTION_COMPLETION_NOT_PERSISTED');
    extractionPersisted = true;
    await ensureLabExtractionOutbox(document);
    return { processed: true, idempotent: false, documentId: String(document._id), textLength: extractedText.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'LAB_PDF_EXTRACTION_FAILED';
    if (!extractionPersisted) {
      await LabDocument.updateOne(
        { _id: document._id, $and: [processingVersion === 1 ? { $or: [{ processingVersion: 1 }, { processingVersion: { $exists: false } }] } : { processingVersion }], extractionStatus: 'PROCESSING' },
        { $set: { status: 'FAILED', extractionStatus: 'FAILED', extractionError: /^[A-Z0-9_:-]+$/.test(message) ? message.slice(0, 100) : 'LAB_PDF_EXTRACTION_FAILED', processingStage: 'FAILED', safeLastErrorCode: 'LAB_OCR_FAILED' }, $unset: { extractionStartedAt: 1 } },
      );
    }
    throw error;
  }
}
