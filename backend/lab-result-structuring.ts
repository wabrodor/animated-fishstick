import { LabDocument, LabResult } from './models.js';

export const LAB_RESULT_PARSER_VERSION = 1;
const PROCESSING_LEASE_MS = 10 * 60 * 1000;

const KNOWN_TESTS = [
  { canonical: 'HBA1C', aliases: ['HBA1C', 'HB A1C', 'GLYCATED HEMOGLOBIN', 'GLYCOSYLATED HEMOGLOBIN'] },
  { canonical: 'FASTING_GLUCOSE', aliases: ['FASTING GLUCOSE', 'FASTING BLOOD SUGAR', 'FBS'] },
  { canonical: 'GLUCOSE', aliases: ['GLUCOSE', 'BLOOD GLUCOSE', 'BLOOD SUGAR'] },
  { canonical: 'CREATININE', aliases: ['CREATININE'] },
  { canonical: 'UREA', aliases: ['UREA', 'BLOOD UREA'] },
  { canonical: 'HEMOGLOBIN', aliases: ['HEMOGLOBIN', 'HB'] },
  { canonical: 'WBC', aliases: ['WBC', 'TOTAL LEUCOCYTE COUNT', 'WHITE BLOOD CELL COUNT'] },
  { canonical: 'PLATELET_COUNT', aliases: ['PLATELET COUNT', 'PLATELETS', 'PLATELET'] },
  { canonical: 'TOTAL_CHOLESTEROL', aliases: ['TOTAL CHOLESTEROL', 'CHOLESTEROL TOTAL'] },
  { canonical: 'LDL', aliases: ['LDL', 'LDL CHOLESTEROL'] },
  { canonical: 'HDL', aliases: ['HDL', 'HDL CHOLESTEROL'] },
  { canonical: 'TRIGLYCERIDES', aliases: ['TRIGLYCERIDES', 'TRIGLYCERIDE'] },
  { canonical: 'TSH', aliases: ['TSH', 'THYROID STIMULATING HORMONE'] },
  { canonical: 'ALT', aliases: ['ALT', 'SGPT', 'ALANINE AMINOTRANSFERASE'] },
  { canonical: 'AST', aliases: ['AST', 'SGOT', 'ASPARTATE AMINOTRANSFERASE'] },
] as const;

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findTest(line: string) {
  const normalized = normalizeName(line);
  const matches = KNOWN_TESTS.flatMap((test) => test.aliases.map((alias) => ({ test, alias })))
    .filter(({ alias }) => new RegExp(`(?:^|\\b)${escapeRegExp(alias)}(?:\\b|$)`, 'i').test(normalized))
    .sort((a, b) => b.alias.length - a.alias.length);
  return matches[0] ?? null;
}

function parseNumber(value: string): number | undefined {
  const normalized = value.replace(/,/g, '').trim();
  const match = normalized.match(/^-?\d+(?:\.\d+)?$/);
  return match ? Number(normalized) : undefined;
}

function parseReferenceRange(value: string): { low?: number; high?: number; text?: string } {
  const match = value.match(/(-?\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(-?\d+(?:\.\d+)?)/i);
  if (!match) return {};
  return { low: Number(match[1]), high: Number(match[2]), text: match[0].replace(/\s+/g, ' ').trim() };
}

function abnormalFlag(value: number | undefined, low: number | undefined, high: number | undefined, explicit?: string) {
  if (explicit) {
    const flag = explicit.toUpperCase();
    if (flag === 'H' || flag === 'HIGH') return 'HIGH' as const;
    if (flag === 'L' || flag === 'LOW') return 'LOW' as const;
  }
  if (value === undefined) return 'UNKNOWN' as const;
  if (low !== undefined && value < low) return 'LOW' as const;
  if (high !== undefined && value > high) return 'HIGH' as const;
  if (low !== undefined || high !== undefined) return 'NORMAL' as const;
  return 'UNKNOWN' as const;
}

function parseLine(line: string, occurrence: number) {
  const found = findTest(line);
  if (!found) return null;

  const alias = found.alias;
  const afterName = line.slice(line.toUpperCase().indexOf(alias) + alias.length).trim().replace(/^[:=|-]+\s*/, '');
  const valueMatch = afterName.match(/^(?:[<>]\s*)?(-?\d+(?:,\d{3})*(?:\.\d+)?)\s*(.*)$/);
  if (!valueMatch) return null;

  const value = parseNumber(valueMatch[1]);
  if (value === undefined) return null;
  let rest = valueMatch[2].trim();
  let explicitFlag: string | undefined;
  const flagMatch = rest.match(/(?:^|\s)(HIGH|LOW|H|L)\s*$/i);
  if (flagMatch) {
    explicitFlag = flagMatch[1];
    rest = rest.slice(0, flagMatch.index).trim();
  }

  const rangeMatch = rest.match(/(?:^|\s)(-?\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(-?\d+(?:\.\d+)?)(?:\s|$)/i);
  let referenceLow: number | undefined;
  let referenceHigh: number | undefined;
  let referenceRangeText: string | undefined;
  if (rangeMatch) {
    referenceLow = Number(rangeMatch[1]);
    referenceHigh = Number(rangeMatch[2]);
    referenceRangeText = `${rangeMatch[1]}-${rangeMatch[2]}`;
    rest = `${rest.slice(0, rangeMatch.index)} ${rest.slice((rangeMatch.index ?? 0) + rangeMatch[0].length)}`.trim();
  }

  const unitMatch = rest.match(/^([a-zA-Z%µμ/][a-zA-Z0-9%µμ/._^-]*)/);
  const unit = unitMatch?.[1];
  const flag = abnormalFlag(value, referenceLow, referenceHigh, explicitFlag);
  const sourceText = line.trim().slice(0, 1000);
  return {
    normalizedTestName: found.test.canonical,
    testName: found.alias.replace(/\b\w/g, (c) => c.toUpperCase()),
    valueNumber: value,
    valueText: valueMatch[1].replace(/,/g, ''),
    unit,
    referenceLow,
    referenceHigh,
    referenceRangeText,
    abnormalFlag: flag,
    sourceText,
    extractionConfidence: referenceLow !== undefined || referenceHigh !== undefined || unit ? 0.98 : 0.9,
    occurrence,
  };
}

function splitCandidateLines(extractedText: string): string[] {
  const sourceLines = extractedText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const aliases = KNOWN_TESTS.flatMap((test) => test.aliases)
    .sort((a, b) => b.length - a.length);
  const aliasPattern = new RegExp(
    `(?:^|\\s)(${aliases.map(escapeRegExp).join('|')})(?=\\s*[:=\\-]?\\s*(?:[<>]\\s*)?-?\\d)`,
    'ig',
  );
  const candidates: string[] = [];

  for (const sourceLine of sourceLines) {
    const matches = [...sourceLine.matchAll(aliasPattern)];
    if (matches.length <= 1) {
      candidates.push(sourceLine);
      continue;
    }

    for (let index = 0; index < matches.length; index += 1) {
      const start = matches[index].index ?? 0;
      const end = index + 1 < matches.length
        ? (matches[index + 1].index ?? sourceLine.length)
        : sourceLine.length;
      const candidate = sourceLine.slice(start, end).trim();
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates;
}

export function parseStructuredLabResults(extractedText: string) {
  const lines = splitCandidateLines(extractedText);
  const occurrences = new Map<string, number>();
  const results: Array<NonNullable<ReturnType<typeof parseLine>>> = [];
  for (const line of lines) {
    const base = parseLine(line, 0);
    if (!base) continue;
    const occurrence = occurrences.get(base.normalizedTestName) ?? 0;
    occurrences.set(base.normalizedTestName, occurrence + 1);
    results.push({ ...base, occurrence });
  }
  return results;
}

export async function claimLabResultStructuring(documentId: string, now = new Date()) {
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  return LabDocument.findOneAndUpdate(
    {
      _id: documentId,
      extractionStatus: 'COMPLETED',
      $or: [
        { structuringStatus: { $in: ['NOT_STARTED', 'FAILED'] } },
        { structuringStatus: 'PROCESSING', structuringStartedAt: { $lte: staleBefore } },
      ],
    },
    { $set: { structuringStatus: 'PROCESSING', structuringStartedAt: now, structuringError: undefined } },
    { new: true },
  ).lean();
}

export async function processLabResultStructuring(documentId: string, now = new Date()) {
  const document = await claimLabResultStructuring(documentId, now);
  if (!document) return { processed: false, idempotent: true };

  try {
    const parsed = parseStructuredLabResults(document.extractedText ?? '');
    if (parsed.length === 0) throw new Error('LAB_NO_STRUCTURED_RESULTS');

    const operations = parsed.map((result) => ({
      updateOne: {
        filter: { organizationId: document.clinicOrganizationId, resultKey: `${document._id}:${LAB_RESULT_PARSER_VERSION}:${result.normalizedTestName}:${result.occurrence}` },
        update: {
          $setOnInsert: {
            organizationId: document.clinicOrganizationId,
            apexcareOrganizationId: document.apexcareOrganizationId,
            patientId: document.patientId,
            labDocumentId: document._id,
            testName: result.testName,
            normalizedTestName: result.normalizedTestName,
            valueNumber: result.valueNumber,
            valueText: result.valueText,
            unit: result.unit,
            referenceLow: result.referenceLow,
            referenceHigh: result.referenceHigh,
            referenceRangeText: result.referenceRangeText,
            abnormalFlag: result.abnormalFlag,
            sourceText: result.sourceText,
            extractionConfidence: result.extractionConfidence,
            parserVersion: LAB_RESULT_PARSER_VERSION,
            resultKey: `${document._id}:${LAB_RESULT_PARSER_VERSION}:${result.normalizedTestName}:${result.occurrence}`,
          },
        },
        upsert: true,
      },
    }));
    if (operations.length) await LabResult.bulkWrite(operations, { ordered: false });

    await LabDocument.updateOne(
      { _id: document._id, clinicOrganizationId: document.clinicOrganizationId, extractionStatus: 'COMPLETED', structuringStatus: 'PROCESSING' },
      { $set: { structuringStatus: 'COMPLETED', structuringVersion: LAB_RESULT_PARSER_VERSION, structuredAt: now, structuredResultCount: parsed.length, structuringError: undefined }, $unset: { structuringStartedAt: 1 } },
    );
    return { processed: true, idempotent: false, resultCount: parsed.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'LAB_RESULT_STRUCTURING_FAILED';
    await LabDocument.updateOne(
      { _id: document._id, structuringStatus: 'PROCESSING' },
      { $set: { structuringStatus: 'FAILED', structuringError: message.slice(0, 1000) }, $unset: { structuringStartedAt: 1 } },
    );
    throw error;
  }
}
