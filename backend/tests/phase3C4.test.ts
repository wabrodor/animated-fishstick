import { describe, expect, it } from 'vitest';
import { CoordinatorEscalation } from '../models.js';
import { NON_ADHERENCE_COMPLETION_THRESHOLD, NON_ADHERENCE_MISSED_TASK_THRESHOLD, evaluatePatientNonAdherence } from '../coordinator-escalation.js';

describe('Phase 3C.4 coordinator escalation', () => {
  it('uses explicit non-adherence thresholds', () => {
    expect(NON_ADHERENCE_COMPLETION_THRESHOLD).toBe(0.7);
    expect(NON_ADHERENCE_MISSED_TASK_THRESHOLD).toBe(3);
  });

  it('has a unique tenant-scoped logical escalation key', () => {
    const indexes = CoordinatorEscalation.schema.indexes();
    expect(indexes.some(([fields, options]) => fields.organizationId === 1 && fields.escalationKey === 1 && options?.unique === true)).toBe(true);
  });

  it('exposes deterministic evaluation service', () => {
    expect(evaluatePatientNonAdherence).toBeTypeOf('function');
  });
});
