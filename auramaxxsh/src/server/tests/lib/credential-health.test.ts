import { describe, expect, it } from 'vitest';
import {
  analyzeSecretWeakness,
  deriveCredentialHealthStatus,
  redactHealthLogMetadata,
  shouldScanSensitiveField,
  summarizeCredentialHealthFlags,
  type CredentialHealthFlags,
} from '../../lib/credential-health';

describe('credential health contracts', () => {
  describe('deriveCredentialHealthStatus()', () => {
    it('follows frozen precedence for non-unknown combinations', () => {
      expect(deriveCredentialHealthStatus({ weak: true, reused: true, breached: true, unknown: false }))
        .toBe('weak_reused_breached');
      expect(deriveCredentialHealthStatus({ weak: false, reused: true, breached: true, unknown: false }))
        .toBe('reused_breached');
      expect(deriveCredentialHealthStatus({ weak: true, reused: false, breached: true, unknown: false }))
        .toBe('weak_breached');
      expect(deriveCredentialHealthStatus({ weak: true, reused: true, breached: false, unknown: false }))
        .toBe('weak_reused');
      expect(deriveCredentialHealthStatus({ weak: false, reused: false, breached: true, unknown: false }))
        .toBe('breached');
      expect(deriveCredentialHealthStatus({ weak: false, reused: true, breached: false, unknown: false }))
        .toBe('reused');
      expect(deriveCredentialHealthStatus({ weak: true, reused: false, breached: false, unknown: false }))
        .toBe('weak');
      expect(deriveCredentialHealthStatus({ weak: false, reused: false, breached: false, unknown: false }))
        .toBe('safe');
    });

    it('reserves unknown status for strict all-dimensions-unavailable case', () => {
      const flags: CredentialHealthFlags = { weak: true, reused: false, breached: false, unknown: true };
      expect(deriveCredentialHealthStatus(flags)).toBe('weak');
      expect(deriveCredentialHealthStatus(flags, { allDimensionsUnavailable: true })).toBe('unknown');
    });
  });

  describe('summarizeCredentialHealthFlags()', () => {
    it('counts weak/reused/breached/unknown as non-exclusive flags', () => {
      const summary = summarizeCredentialHealthFlags([
        { weak: true, reused: false, breached: false, unknown: false },
        { weak: true, reused: true, breached: false, unknown: false },
        { weak: false, reused: true, breached: true, unknown: true },
        { weak: false, reused: false, breached: false, unknown: false },
      ]);

      expect(summary).toEqual({
        total: 4,
        safe: 1,
        weak: 2,
        reused: 2,
        breached: 1,
        unknown: 1,
      });
    });
  });

  describe('shouldScanSensitiveField()', () => {
    it('supports strict defaults and gated expanded custom keys', () => {
      expect(shouldScanSensitiveField('login', 'password')).toBe(true);
      expect(shouldScanSensitiveField('card', 'pin')).toBe(true);
      expect(shouldScanSensitiveField('api', 'passphrase')).toBe(true);

      expect(shouldScanSensitiveField('custom', 'password')).toBe(true);
      expect(shouldScanSensitiveField('custom', 'PASSWD')).toBe(true);
      expect(shouldScanSensitiveField('custom', 'token')).toBe(false);
      expect(shouldScanSensitiveField('custom', 'token', { expandedCustomSensitiveKeys: true })).toBe(true);
      expect(shouldScanSensitiveField('custom', 'secret', { expandedCustomSensitiveKeys: true })).toBe(true);
    });
  });

  describe('analyzeSecretWeakness()', () => {
    it('does not trim whitespace and reports deterministic weakness reasons', () => {
      const weak = analyzeSecretWeakness(' abcdefghij');
      expect(weak.codePointLength).toBe(11);
      expect(weak.reasons).toContain('short_length');
      expect(weak.reasons).toContain('low_charset_diversity');

      const strong = analyzeSecretWeakness('Ab3$LongerPassphrase!42');
      expect(strong.reasons).not.toContain('short_length');
      expect(strong.reasons).not.toContain('low_charset_diversity');
      expect(strong.entropyBitsRounded).toBe(Math.round(strong.entropyBits * 100) / 100);
    });
  });

  describe('redactHealthLogMetadata()', () => {
    it('keeps allowlisted operational metadata and strips secret-derived fields', () => {
      const redacted = redactHealthLogMetadata({
        credentialId: 'cred-123',
        agentId: 'primary',
        phase: 'hibp_fetch',
        processed: 3,
        total: 10,
        secret: 'dont-log-me',
        sha1: 'DA39A3EE5E6B4B0D3255BFEF95601890AFD80709',
        prefix: 'DA39A',
        suffix: '3EE5E6B4B0D3255BFEF95601890AFD80709',
      });

      expect(redacted).toEqual({
        credentialId: 'cred-123',
        agentId: 'primary',
        phase: 'hibp_fetch',
        processed: 3,
        total: 10,
      });
    });
  });
});
