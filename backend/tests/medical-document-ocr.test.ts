import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.PRESCRIPTION_OCR_ENABLED = 'true';
process.env.PRESCRIPTION_OCR_BASE_URL = 'http://ocr.internal:8080';
process.env.PRESCRIPTION_OCR_API_KEY = 'unit-test-internal-token';
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/apexcare-tests';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const { runMedicalDocumentOcr } = await import('../medical-document-ocr.js');

afterEach(() => vi.unstubAllGlobals());

describe('PaddleOCR service client', () => {
  it('authenticates the internal request and returns bounded text with source coordinates', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errorCode: 0,
      result: { ocrResults: [{ prunedResult: { rec_texts: ['BP 128/82'], rec_scores: [0.97], dt_polys: [[[1, 2], [3, 2], [3, 4], [1, 4]]] } }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runMedicalDocumentOcr(Buffer.from('synthetic image bytes'), 'image/png');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer unit-test-internal-token');
    expect(result).toMatchObject({ status: 'COMPLETED', rawText: 'BP 128/82', lines: [{ confidence: 0.97, page: 1, boundingBox: [[1, 2], [3, 2], [3, 4], [1, 4]] }] });
  });

  it('does not convert provider failure details into patient-facing text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ errorCode: 1 }), { status: 503 })));

    const result = await runMedicalDocumentOcr(Buffer.from('synthetic image bytes'), 'image/png');

    expect(result).toMatchObject({ status: 'FAILED', reason: 'PaddleOCR request failed (code 1).' });
  });
});
