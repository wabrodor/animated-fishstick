import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { documentStorageProvider, env } from './config.js';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const allowedMimeTypes = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

export type StorageProvider = 'local' | 's3';
export type StoredObject = { storageKey: string; sizeBytes: number; sha256: string; storageProvider: StorageProvider };

export interface PrescriptionStorageAdapter {
  save(buffer: Buffer, mimeType: string, clinicOrganizationId: string, patientId: string): Promise<StoredObject>;
  read(storageKey: string, provider?: StorageProvider | null): Promise<Buffer>;
  delete(storageKey: string, provider?: StorageProvider | null): Promise<void>;
}

function validatePrescriptionImage(buffer: Buffer, mimeType: string): void {
  const extension = allowedMimeTypes.get(mimeType);
  if (!extension) throw new Error('Unsupported prescription image type.');
  if (buffer.length === 0 || buffer.length > env.PRESCRIPTION_MAX_UPLOAD_BYTES) throw new Error('Prescription image size is invalid.');
  const isJpeg = mimeType === 'image/jpeg' && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = mimeType === 'image/png' && buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isWebp = mimeType === 'image/webp' && buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!(isJpeg || isPng || isWebp)) throw new Error('Prescription image content does not match its MIME type.');
}


class S3DocumentStorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    if (!env.PRESCRIPTION_S3_ENDPOINT || !env.PRESCRIPTION_S3_BUCKET || !env.PRESCRIPTION_S3_ACCESS_KEY_ID || !env.PRESCRIPTION_S3_SECRET_ACCESS_KEY) {
      throw new Error('S3 prescription storage is selected but its endpoint, bucket, access key and secret key are not configured.');
    }
    this.bucket = env.PRESCRIPTION_S3_BUCKET;
    this.client = new S3Client({
      region: env.PRESCRIPTION_S3_REGION,
      endpoint: env.PRESCRIPTION_S3_ENDPOINT,
      forcePathStyle: env.PRESCRIPTION_S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.PRESCRIPTION_S3_ACCESS_KEY_ID, secretAccessKey: env.PRESCRIPTION_S3_SECRET_ACCESS_KEY },
    });
  }

  async save(buffer: Buffer, storageKey: string, mimeType: string): Promise<StoredObject> {
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: storageKey, Body: buffer, ContentType: mimeType, ServerSideEncryption: 'AES256', Metadata: { sha256 } }));
    return { storageKey, sizeBytes: buffer.length, sha256, storageProvider: 's3' };
  }

  async read(storageKey: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }));
    if (!result.Body) throw new Error('Prescription object was not found.');
    const bytes = await result.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async delete(storageKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }));
  }
}

let s3DocumentStorage: S3DocumentStorageAdapter | undefined;
function getS3DocumentStorage(): S3DocumentStorageAdapter {
  s3DocumentStorage ??= new S3DocumentStorageAdapter();
  return s3DocumentStorage;
}

class LocalPrescriptionStorageAdapter implements PrescriptionStorageAdapter {
  async save(buffer: Buffer, mimeType: string, clinicOrganizationId: string, patientId: string): Promise<StoredObject> {
    validatePrescriptionImage(buffer, mimeType);
    const extension = allowedMimeTypes.get(mimeType)!;
    const relativeKey = path.posix.join('prescriptions', `${randomUUID()}${extension}`);
    const absolutePath = path.resolve(env.PRESCRIPTION_STORAGE_DIR, relativeKey);
    const root = path.resolve(env.PRESCRIPTION_STORAGE_DIR);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error('Invalid storage path.');
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, buffer, { flag: 'wx' });
    return { storageKey: relativeKey, sizeBytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), storageProvider: 'local' };
  }

  async read(storageKey: string, provider?: StorageProvider | null): Promise<Buffer> {
    if (provider === 's3') return getS3DocumentStorage().read(storageKey);
    const root = path.resolve(env.PRESCRIPTION_STORAGE_DIR);
    const absolutePath = path.resolve(root, storageKey);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error('Invalid storage path.');
    return readFile(absolutePath);
  }

  async delete(storageKey: string, provider?: StorageProvider | null): Promise<void> {
    if (provider === 's3') return getS3DocumentStorage().delete(storageKey);
    const root = path.resolve(env.PRESCRIPTION_STORAGE_DIR);
    const absolutePath = path.resolve(root, storageKey);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error('Invalid storage path.');
    await unlink(absolutePath);
  }
}

// Prescription images and lab PDFs share the configured S3/local selection.
export const prescriptionStorage: PrescriptionStorageAdapter = documentStorageProvider === 's3'
  ? {
      save: async (buffer, mimeType) => {
        validatePrescriptionImage(buffer, mimeType);
        const extension = allowedMimeTypes.get(mimeType)!;
        return getS3DocumentStorage().save(buffer, `prescriptions/${randomUUID()}${extension}`, mimeType);
      },
      read: (storageKey, provider) => provider === 'local' ? new LocalPrescriptionStorageAdapter().read(storageKey) : getS3DocumentStorage().read(storageKey),
      delete: (storageKey, provider) => provider === 'local' ? new LocalPrescriptionStorageAdapter().delete(storageKey) : getS3DocumentStorage().delete(storageKey),
    }
  : new LocalPrescriptionStorageAdapter();

export const savePrescriptionImage = (buffer: Buffer, mimeType: string, clinicOrganizationId: string, patientId: string) =>
  prescriptionStorage.save(buffer, mimeType, clinicOrganizationId, patientId);

export const readPrescriptionImage = (storageKey: string, provider?: StorageProvider | null) => prescriptionStorage.read(storageKey, provider);
export const deletePrescriptionImage = (storageKey: string, provider?: StorageProvider | null) => prescriptionStorage.delete(storageKey, provider);


const LAB_PDF_MIME_TYPE = 'application/pdf';

export interface LabPdfStorageAdapter {
  save(buffer: Buffer, clinicOrganizationId: string, patientId: string, sha256: string): Promise<StoredObject>;
  read(storageKey: string, provider?: StorageProvider | null): Promise<Buffer>;
  delete(storageKey: string, provider?: StorageProvider | null): Promise<void>;
}

function validateLabPdf(buffer: Buffer): void {
  if (buffer.length === 0 || buffer.length > env.LAB_PDF_MAX_UPLOAD_BYTES) {
    throw new Error('Lab PDF size is invalid.');
  }
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('Lab document content does not match PDF format.');
  }
}

class LocalLabPdfStorageAdapter implements LabPdfStorageAdapter {
  async save(buffer: Buffer, clinicOrganizationId: string, patientId: string, sha256: string): Promise<StoredObject> {
    validateLabPdf(buffer);
    const relativeKey = path.posix.join('labs', `${randomUUID()}.pdf`);
    const absolutePath = path.resolve(env.LAB_PDF_STORAGE_DIR, relativeKey);
    const root = path.resolve(env.LAB_PDF_STORAGE_DIR);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error('Invalid lab storage path.');
    await mkdir(path.dirname(absolutePath), { recursive: true });
    try {
      await writeFile(absolutePath, buffer, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return { storageKey: relativeKey, sizeBytes: buffer.length, sha256, storageProvider: 'local' };
  }

  async read(storageKey: string, provider?: StorageProvider | null): Promise<Buffer> {
    if (provider === 's3') return getS3DocumentStorage().read(storageKey);
    const root = path.resolve(env.LAB_PDF_STORAGE_DIR);
    const absolutePath = path.resolve(root, storageKey);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error('Invalid lab storage path.');
    return readFile(absolutePath);
  }

  async delete(storageKey: string, provider?: StorageProvider | null): Promise<void> {
    if (provider === 's3') return getS3DocumentStorage().delete(storageKey);
    const root = path.resolve(env.LAB_PDF_STORAGE_DIR);
    const absolutePath = path.resolve(root, storageKey);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error('Invalid lab storage path.');
    await unlink(absolutePath);
  }
}

export const labPdfStorage: LabPdfStorageAdapter = documentStorageProvider === 's3'
  ? {
      save: async (buffer, _clinicOrganizationId, _patientId, sha256) => {
        validateLabPdf(buffer);
        return getS3DocumentStorage().save(buffer, `labs/${randomUUID()}.pdf`, LAB_PDF_MIME_TYPE).then((stored) => ({ ...stored, sha256 }));
      },
      read: (storageKey, provider) => provider === 'local' ? new LocalLabPdfStorageAdapter().read(storageKey) : getS3DocumentStorage().read(storageKey),
      delete: (storageKey, provider) => provider === 'local' ? new LocalLabPdfStorageAdapter().delete(storageKey) : getS3DocumentStorage().delete(storageKey),
    }
  : new LocalLabPdfStorageAdapter();

export const saveLabPdf = (buffer: Buffer, clinicOrganizationId: string, patientId: string, sha256: string) =>
  labPdfStorage.save(buffer, clinicOrganizationId, patientId, sha256);

export const readLabPdf = (storageKey: string, provider?: StorageProvider | null) => labPdfStorage.read(storageKey, provider);
export const deleteLabPdf = (storageKey: string, provider?: StorageProvider | null) => labPdfStorage.delete(storageKey, provider);

export function hashLabPdf(buffer: Buffer): string {
  validateLabPdf(buffer);
  return createHash('sha256').update(buffer).digest('hex');
}

export { LAB_PDF_MIME_TYPE };
