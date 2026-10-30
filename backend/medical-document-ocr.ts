import { env } from './config.js';

export type MedicalOcrLine = {
  text: string;
  confidence?: number;
  page: number;
  boundingBox?: number[][];
};

export type MedicalOcrResult = {
  status: 'COMPLETED' | 'FAILED' | 'UNAVAILABLE';
  rawText?: string;
  lines?: MedicalOcrLine[];
  reason?: string;
  warningCode?: 'NO_TEXT_DETECTED';
};

/** Calls the private plain PaddleOCR service; OCR text is returned only to the worker. */
export async function runMedicalDocumentOcr(buffer: Buffer, mimeType: string): Promise<MedicalOcrResult> {
  if (!env.PRESCRIPTION_OCR_ENABLED || !env.PRESCRIPTION_OCR_BASE_URL) {
    return { status: 'UNAVAILABLE', reason: 'PaddleOCR service is not enabled or configured.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.PRESCRIPTION_OCR_TIMEOUT_MS);
  try {
    const baseUrl = env.PRESCRIPTION_OCR_BASE_URL.replace(/\/+$/, '').replace(/\/ocr$/i, '');
    const response = await fetch(`${baseUrl}/ocr`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.PRESCRIPTION_OCR_API_KEY}`,
      },
      body: JSON.stringify({ file: buffer.toString('base64'), fileType: mimeType === 'application/pdf' ? 2 : 1, visualize: false }),
    });
    const payload = await response.json().catch(() => null) as {
      errorCode?: number;
      result?: { ocrResults?: Array<{ prunedResult?: { rec_texts?: unknown; rec_scores?: unknown; dt_polys?: unknown } }> };
    } | null;
    if (!response.ok || !payload || (typeof payload.errorCode === 'number' && payload.errorCode !== 0)) {
      return { status: 'FAILED', reason: `PaddleOCR request failed (code ${payload?.errorCode ?? response.status}).` };
    }

    const lines: MedicalOcrLine[] = [];
    let characterCount = 0;
    for (const [pageIndex, page] of (payload.result?.ocrResults ?? []).entries()) {
      const result = page.prunedResult;
      const texts = Array.isArray(result?.rec_texts) ? result.rec_texts : [];
      const scores = Array.isArray(result?.rec_scores) ? result.rec_scores : [];
      const polygons = Array.isArray(result?.dt_polys) ? result.dt_polys : [];
      for (let index = 0; index < texts.length && lines.length < 1000; index += 1) {
        const rawLine = texts[index];
        if (typeof rawLine !== 'string' || !rawLine.trim()) continue;
        const text = rawLine.trim().slice(0, Math.max(0, 20_000 - characterCount));
        if (!text) break;
        characterCount += text.length + 1;
        const score = scores[index];
        const rawBox = polygons[index];
        const boundingBox = Array.isArray(rawBox)
          ? rawBox.filter((point): point is number[] => Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))).map((point) => point.slice(0, 2))
          : undefined;
        lines.push({
          text,
          page: pageIndex + 1,
          ...(typeof score === 'number' && Number.isFinite(score) ? { confidence: Math.max(0, Math.min(1, score)) } : {}),
          ...(boundingBox?.length ? { boundingBox } : {}),
        });
      }
      if (characterCount >= 20_000) break;
    }
    const rawText = lines.map((line) => line.text).join('\n');
    return { status: 'COMPLETED', rawText, lines, ...(!rawText ? { warningCode: 'NO_TEXT_DETECTED' as const } : {}) };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? `PaddleOCR timed out after ${env.PRESCRIPTION_OCR_TIMEOUT_MS} ms.`
      : 'PaddleOCR service could not be reached.';
    return { status: 'FAILED', reason };
  } finally {
    clearTimeout(timeout);
  }
}
