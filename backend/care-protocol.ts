import { CareProtocol } from './models.js';

export type ChronicCondition = 'HYPERTENSION' | 'TYPE_2_DIABETES' | 'DYSLIPIDEMIA' | 'PCOS';

export type CareProtocolMilestoneDefinition = {
  key: string;
  label: string;
  offsetDays: number;
  sequence: number;
  reviewRequired?: boolean;
};

export type CareProtocolDefinition = {
  protocolKey: string;
  version: string;
  condition: ChronicCondition;
  jurisdiction: string;
  durationDays: number;
  milestones: CareProtocolMilestoneDefinition[];
};

// Seed only the protocol that is currently defined by the Phase 3 clinical workflow.
// Additional disease protocols should be added as versioned database records after
// their clinical schedules are approved; do not invent review intervals here.
const DEFAULT_PROTOCOLS: CareProtocolDefinition[] = [
  {
    protocolKey: 'HYPERTENSION',
    version: '1.0',
    condition: 'HYPERTENSION',
    jurisdiction: 'IN',
    durationDays: 90,
    milestones: [
      { key: 'DAY_0_BASELINE', label: 'Day 0 baseline', offsetDays: 0, sequence: 1, reviewRequired: true },
      { key: 'DAY_3_LAB_MILESTONE', label: 'Day 3 laboratory milestone', offsetDays: 3, sequence: 1, reviewRequired: true },
      { key: 'DAY_7_EARLY_REVIEW', label: 'Day 7 early execution review', offsetDays: 7, sequence: 1, reviewRequired: true },
      { key: 'DAY_14_RESPONSE_REVIEW', label: 'Day 14 response review', offsetDays: 14, sequence: 1, reviewRequired: true },
      { key: 'DAY_30_MAJOR_CHECKPOINT', label: 'Day 30 major checkpoint', offsetDays: 30, sequence: 1, reviewRequired: true },
      { key: 'DAY_60_OPTIMIZATION', label: 'Day 60 optimization review', offsetDays: 60, sequence: 1, reviewRequired: true },
      { key: 'DAY_90_OUTCOME', label: 'Day 90 outcome', offsetDays: 90, sequence: 1, reviewRequired: true },
    ],
  },
];

export async function resolveCareProtocol(condition: ChronicCondition, version?: string) {
  const query = version
    ? { condition, version }
    : { condition, status: 'ACTIVE' as const };

  const existing = await CareProtocol.findOne(query).lean();
  if (existing) return existing;

  const fallback = DEFAULT_PROTOCOLS.find((protocol) => protocol.condition === condition && (!version || protocol.version === version));
  if (!fallback) throw new Error(`CARE_PROTOCOL_NOT_CONFIGURED:${condition}${version ? `:${version}` : ''}`);

  try {
    await CareProtocol.updateOne(
      { protocolKey: fallback.protocolKey, version: fallback.version },
      { $setOnInsert: fallback },
      { upsert: true },
    );
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
  }

  const seeded = await CareProtocol.findOne({ protocolKey: fallback.protocolKey, version: fallback.version, status: 'ACTIVE' }).lean();
  if (!seeded) throw new Error(`CARE_PROTOCOL_RESOLUTION_FAILED:${condition}`);
  return seeded;
}
