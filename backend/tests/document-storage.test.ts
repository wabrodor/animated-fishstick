import { afterAll, describe, expect, it } from 'vitest';

process.env.DOCUMENT_STORAGE_PROVIDER = 'local';
process.env.PRESCRIPTION_STORAGE_PROVIDER = 'local';
process.env.LAB_PDF_STORAGE_DIR = './test-lab-storage-pipeline';
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/apexcare-tests';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const storage = await import('../storage.js');
const pdf = Buffer.from('%PDF-1.7\nmedical report fixture\n%%EOF');

describe('medical document storage adapter', () => {
  let createdKey: string | undefined;

  afterAll(async () => {
    if (createdKey) await storage.deleteLabPdf(createdKey, 'local').catch(() => undefined);
  });

  it('stores lab originals under opaque keys and reads/deletes through the adapter', async () => {
    const stored = await storage.saveLabPdf(pdf, 'clinic-id-must-not-be-in-key', 'patient-id-must-not-be-in-key', storage.hashLabPdf(pdf));
    createdKey = stored.storageKey;

    expect(stored.storageProvider).toBe('local');
    expect(stored.storageKey).toMatch(/^labs\/[0-9a-f-]+\.pdf$/i);
    expect(stored.storageKey).not.toContain('clinic-id-must-not-be-in-key');
    expect(stored.storageKey).not.toContain('patient-id-must-not-be-in-key');
    expect(await storage.readLabPdf(stored.storageKey, stored.storageProvider)).toEqual(pdf);

    await storage.deleteLabPdf(stored.storageKey, stored.storageProvider);
    createdKey = undefined;
  });
});
