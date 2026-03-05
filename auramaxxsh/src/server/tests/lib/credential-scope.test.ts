/**
 * Tests for credential scope matching and field exclusion resolution
 *
 * Tests:
 * - normalizeScope: trim, lowercase, NFKC
 * - matchesScope: wildcard, ID, tag, agent, multiple scopes, empty scopes, case-insensitive
 * - resolveExcludeFields: explicit token values, empty override, undefined falls to type default
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeScope,
  matchesScope,
  resolveExcludeFields,
} from '../../lib/credential-scope';
import { CredentialFile, EncryptedData } from '../../types';

function makeCredential(overrides: Partial<CredentialFile> = {}): CredentialFile {
  return {
    id: 'cred-abc12345',
    agentId: 'primary',
    type: 'login',
    name: 'Test Login',
    meta: { tags: ['work', 'dev'] },
    encrypted: { ciphertext: '', iv: '', salt: '', mac: '' } as EncryptedData,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Credential Scope', () => {
  describe('normalizeScope()', () => {
    it('should trim whitespace', () => {
      expect(normalizeScope('  hello  ')).toBe('hello');
    });

    it('should lowercase', () => {
      expect(normalizeScope('Hello World')).toBe('hello world');
    });

    it('should apply NFKC normalization', () => {
      // NFKC normalizes compatibility characters
      // ﬁ (U+FB01) → fi
      expect(normalizeScope('\uFB01le')).toBe('file');
    });

    it('should handle combined operations', () => {
      expect(normalizeScope('  TAG:Work  ')).toBe('tag:work');
    });
  });

  describe('matchesScope()', () => {
    const cred = makeCredential();

    it('should match wildcard *', () => {
      expect(matchesScope(cred, ['*'])).toBe(true);
    });

    it('should match exact credential ID', () => {
      expect(matchesScope(cred, ['cred-abc12345'])).toBe(true);
    });

    it('should match credential ID case-insensitively', () => {
      expect(matchesScope(cred, ['CRED-ABC12345'])).toBe(true);
    });

    it('should match tag: scope', () => {
      expect(matchesScope(cred, ['tag:work'])).toBe(true);
      expect(matchesScope(cred, ['tag:dev'])).toBe(true);
    });

    it('should match tag: scope case-insensitively', () => {
      expect(matchesScope(cred, ['tag:WORK'])).toBe(true);
    });

    it('should not match non-existent tag', () => {
      expect(matchesScope(cred, ['tag:personal'])).toBe(false);
    });

    it('should match tag:* wildcard scope when tags exist', () => {
      expect(matchesScope(cred, ['tag:*'])).toBe(true);
    });

    it('should match tag prefix wildcard scope', () => {
      expect(matchesScope(cred, ['tag:wo*'])).toBe(true);
    });

    it('should match tag path-style wildcard scope', () => {
      const namespaced = makeCredential({ meta: { tags: ['generated/github'] } });
      expect(matchesScope(namespaced, ['tag:generated/*'])).toBe(true);
    });

    it('should match agent: scope', () => {
      expect(matchesScope(cred, ['agent:primary'])).toBe(true);
    });

    it('should match agent:* wildcard scope', () => {
      expect(matchesScope(cred, ['agent:*'])).toBe(true);
    });

    it('should match agent prefix wildcard scope', () => {
      expect(matchesScope(cred, ['agent:pri*'])).toBe(true);
    });

    it('should match agent: scope case-insensitively', () => {
      expect(matchesScope(cred, ['agent:PRIMARY'])).toBe(true);
    });

    it('should not match wrong agent', () => {
      expect(matchesScope(cred, ['agent:other'])).toBe(false);
    });

    it('should match if any scope matches (multiple scopes)', () => {
      expect(matchesScope(cred, ['tag:nope', 'tag:work'])).toBe(true);
    });

    it('should return false for empty scopes', () => {
      expect(matchesScope(cred, [])).toBe(false);
    });

    it('should return false when no scope matches', () => {
      expect(matchesScope(cred, ['tag:nope', 'agent:other', 'cred-wrong'])).toBe(false);
    });

    it('should handle credential with no tags', () => {
      const noTags = makeCredential({ meta: {} });
      expect(matchesScope(noTags, ['tag:anything'])).toBe(false);
      expect(matchesScope(noTags, ['tag:*'])).toBe(false);
      expect(matchesScope(noTags, ['*'])).toBe(true);
    });
  });

  describe('resolveExcludeFields()', () => {
    it('should return token explicit excludeFields', () => {
      expect(resolveExcludeFields(['api_key'], 'login')).toEqual(['api_key']);
    });

    it('should return empty array when token explicitly sets []', () => {
      // Empty array means "show everything" — explicit override
      expect(resolveExcludeFields([], 'card')).toEqual([]);
    });

    it('should use type default for card when token is undefined', () => {
      const result = resolveExcludeFields(undefined, 'card');
      expect(result).toEqual(['cvv']);
    });

    it('should use type default for login when token is undefined', () => {
      const result = resolveExcludeFields(undefined, 'login');
      expect(result).toEqual(['password']);
    });

    it('should use type default for note when token is undefined', () => {
      const result = resolveExcludeFields(undefined, 'note');
      expect(result).toEqual([]);
    });

    it('should fall back to empty array for unknown type', () => {
      const result = resolveExcludeFields(undefined, 'custom');
      expect(result).toEqual([]);
    });
  });
});
