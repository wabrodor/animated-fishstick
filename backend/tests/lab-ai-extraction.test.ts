import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.MEDICAL_DOCUMENT_STRUCTURING_ENABLED = 'true';
process.env.MEDICAL_DOCUMENT_STRUCTURING_API_KEY = 'unit-test-deepseek-token';
process.env.MEDICAL_DOCUMENT_STRUCTURING_BASE_URL = 'https://deepseek.test';
process.env.MEDICAL_DOCUMENT_STRUCTURING_MODEL = 'test-model';
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/apexcare-tests';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-that-is-at-least-32-characters-long';

const { extractLabCandidatesWithDeepSeek } = await import('../lab-ai-extraction.js');
afterEach(() => vi.unstubAllGlobals());

const line = 'Hemoglobin 12.8 g/dL (11.5-15.5)';
const responseFor = (result: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: [result] }) } }] }), { status: 200 });

describe('DeepSeek lab candidate extraction', () => {
  it('keeps exact OCR evidence and does not accept an unsupported AI flag', async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseFor({ testName: 'Hemoglobin', valueText: '12.8', valueNumber: 12.8, unit: 'g/dL', referenceLow: 11.5, referenceHigh: 15.5, referenceRangeText: '11.5-15.5', abnormalFlag: 'HIGH', sourceText: line }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractLabCandidatesWithDeepSeek(line, [{ text: line, confidence: 0.93, page: 1 }]);

    expect(result).toMatchObject([{ normalizedTestName: 'HEMOGLOBIN', abnormalFlag: 'UNKNOWN', sourceText: line, sourcePage: 1, extractionConfidence: 0.93 }]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer unit-test-deepseek-token');
  });

  it('rejects a value or range that cannot be supported by the source text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseFor({ testName: 'Hemoglobin', valueText: '12.8', valueNumber: 12.8, unit: 'g/dL', referenceLow: 11.5, referenceHigh: 15.5, referenceRangeText: '11.5-15.5', abnormalFlag: 'UNKNOWN', sourceText: 'Hemoglobin 12.8 g/dL' })));

    await expect(extractLabCandidatesWithDeepSeek(line, [])).rejects.toThrow('LAB_EXTRACTION_SOURCE_EVIDENCE_MISMATCH');
  });

  it('does not send empty OCR text to DeepSeek', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await extractLabCandidatesWithDeepSeek('  ', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
