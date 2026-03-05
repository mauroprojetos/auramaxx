import { describe, it, expect } from 'vitest';
import { buildHumanActionSummary } from '../../lib/human-action-summary';

describe('human action readable summary', () => {
  it('derives stable readable fields from metadata + verified summary', () => {
    const summary = buildHumanActionSummary({
      type: 'action',
      summary: 'agent asks to swap',
      metadata: JSON.stringify({
        ttl: 120,
        permissions: ['swap'],
        walletAccess: ['0xabc'],
        verifiedSummary: {
          oneLiner: 'Swap up to 0.1 ETH',
          permissionLabels: ['swap'],
          walletAccessLabels: ['0xabc'],
          ttlLabel: '2m',
        },
      }),
    });

    expect(summary.oneLiner).toBe('Swap up to 0.1 ETH');
    expect(summary.can).toContain('swap');
    expect(summary.scope).toContain('0xabc');
    expect(summary.expiresIn).toBe('2m');
    expect(summary.cannot.length).toBeGreaterThan(0);
  });

  it('extracts profileLabel from metadata profile object', () => {
    const summary = buildHumanActionSummary({
      type: 'auth',
      summary: 'agent token request',
      metadata: JSON.stringify({
        profile: { id: 'dev', version: 'v1', displayName: 'Dev' },
        permissions: ['secret:read'],
      }),
    });
    expect(summary.profileLabel).toBe('Dev');
  });

  it('returns undefined profileLabel when no profile in metadata', () => {
    const summary = buildHumanActionSummary({
      type: 'action',
      summary: 'no profile',
      metadata: JSON.stringify({ permissions: ['swap'] }),
    });
    expect(summary.profileLabel).toBeUndefined();
  });

  it('falls back safely when metadata is absent or malformed', () => {
    const summary = buildHumanActionSummary({
      type: 'send',
      summary: 'send request',
      metadata: '{bad-json',
    });

    expect(summary.oneLiner).toBe('send request');
    expect(summary.can).toEqual([]);
    expect(summary.scope).toEqual([]);
    expect(summary.expiresIn).toBe('default');
  });
});
