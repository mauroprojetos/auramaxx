import { describe, expect, it } from 'vitest';
import { resolveDontAskAgainDefault } from '../../lib/dont-ask-again-policy';

describe('dont-ask-again default policy', () => {
  it('defaults ON for allowlisted excluded fields only', () => {
    const decision = resolveDontAskAgainDefault(['password']);
    expect(decision.defaultOn).toBe(true);
    expect(decision.reason).toBe('ALLOWLIST_EXCLUDED_FIELD');
  });

  it('defaults OFF for sensitive denylisted fields', () => {
    const decision = resolveDontAskAgainDefault(['privateKey']);
    expect(decision.defaultOn).toBe(false);
    expect(decision.reason).toBe('DENYLIST_SENSITIVE_FIELD');
  });

  it('defaults OFF for mixed/unknown fields', () => {
    const decision = resolveDontAskAgainDefault(['password', 'apiToken']);
    expect(decision.defaultOn).toBe(false);
    expect(decision.reason).toBe('MIXED_OR_UNKNOWN');
  });
});
