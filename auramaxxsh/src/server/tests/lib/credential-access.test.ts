/**
 * Tests for credential access tracking (TTL, maxReads, iat)
 *
 * Tests:
 * - checkCredentialAccess: no restrictions, TTL pass/fail, maxReads pass/fail, combined
 * - recordCredentialRead: increments count
 * - iat set on tokens
 * - Default credentialAccess populated for secret:read tokens
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTokenSync as createToken,
  validateToken,
} from '../../lib/auth';
import {
  getSession,
  clearSessions,
  checkCredentialAccess,
  recordCredentialRead,
} from '../../lib/sessions';
import { getTokenHash } from '../../lib/auth';
import { AgentTokenPayload } from '../../types';

describe('Credential Access Tracking', () => {
  beforeEach(() => {
    clearSessions();
  });

  describe('iat on tokens', () => {
    it('should set iat on created tokens', () => {
      const before = Date.now();
      const token = createToken({
        agentId: 'test',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
      });
      const after = Date.now();

      const validated = validateToken(token);
      expect(validated?.iat).toBeDefined();
      expect(validated!.iat!).toBeGreaterThanOrEqual(before);
      expect(validated!.iat!).toBeLessThanOrEqual(after);
    });

    it('should allow explicit iat override', () => {
      const customIat = Date.now() - 5000;
      const token = createToken({
        agentId: 'test',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
        iat: customIat,
      });

      const validated = validateToken(token);
      expect(validated?.iat).toBe(customIat);
    });
  });

  describe('checkCredentialAccess()', () => {
    it('should allow access with no restrictions', () => {
      const token: AgentTokenPayload = {
        agentId: 'test',
        permissions: ['secret:read'],
        exp: Date.now() + 3600000,
        iat: Date.now(),
      };
      const hash = 'test-hash-1';
      getSession(hash, token);

      const result = checkCredentialAccess(hash, token);
      expect(result).toEqual({ ok: true });
    });

    it('should allow access when TTL has not expired', () => {
      const token: AgentTokenPayload = {
        agentId: 'test',
        permissions: ['secret:read'],
        exp: Date.now() + 3600000,
        iat: Date.now(),
        credentialAccess: { ttl: 3600 },
      };
      const hash = 'test-hash-2';
      getSession(hash, token);

      const result = checkCredentialAccess(hash, token);
      expect(result).toEqual({ ok: true });
    });

    it('should deny access when TTL has expired', () => {
      const token: AgentTokenPayload = {
        agentId: 'test',
        permissions: ['secret:read'],
        exp: Date.now() + 3600000,
        iat: Date.now() - 10000, // 10 seconds ago
        credentialAccess: { ttl: 5 }, // 5 second TTL
      };
      const hash = 'test-hash-3';
      getSession(hash, token);

      const result = checkCredentialAccess(hash, token);
      expect(result).toEqual({ ok: false, reason: 'Credential access TTL expired' });
    });

    it('should allow access when under maxReads', () => {
      const token: AgentTokenPayload = {
        agentId: 'test',
        permissions: ['secret:read'],
        exp: Date.now() + 3600000,
        iat: Date.now(),
        credentialAccess: { maxReads: 5 },
      };
      const hash = 'test-hash-4';
      getSession(hash, token);

      const result = checkCredentialAccess(hash, token);
      expect(result).toEqual({ ok: true });
    });

    it('should deny access when maxReads reached', () => {
      const token: AgentTokenPayload = {
        agentId: 'test',
        permissions: ['secret:read'],
        exp: Date.now() + 3600000,
        iat: Date.now(),
        credentialAccess: { maxReads: 2 },
      };
      const hash = 'test-hash-5';
      getSession(hash, token);

      // Record 2 reads
      recordCredentialRead(hash);
      recordCredentialRead(hash);

      const result = checkCredentialAccess(hash, token);
      expect(result).toEqual({ ok: false, reason: 'Credential read limit reached' });
    });

    it('should enforce both TTL and maxReads together', () => {
      // TTL ok, maxReads exceeded
      const token1: AgentTokenPayload = {
        agentId: 'test',
        permissions: ['secret:read'],
        exp: Date.now() + 3600000,
        iat: Date.now(),
        credentialAccess: { ttl: 3600, maxReads: 1 },
      };
      const hash1 = 'test-hash-6';
      getSession(hash1, token1);
      recordCredentialRead(hash1);

      expect(checkCredentialAccess(hash1, token1)).toEqual({
        ok: false,
        reason: 'Credential read limit reached',
      });

      // TTL expired, maxReads ok
      const token2: AgentTokenPayload = {
        agentId: 'test',
        permissions: ['secret:read'],
        exp: Date.now() + 3600000,
        iat: Date.now() - 10000,
        credentialAccess: { ttl: 5, maxReads: 100 },
      };
      const hash2 = 'test-hash-7';
      getSession(hash2, token2);

      expect(checkCredentialAccess(hash2, token2)).toEqual({
        ok: false,
        reason: 'Credential access TTL expired',
      });
    });
  });

  describe('recordCredentialRead()', () => {
    it('should increment credential read count', () => {
      const token: AgentTokenPayload = {
        agentId: 'test',
        permissions: ['secret:read'],
        exp: Date.now() + 3600000,
        iat: Date.now(),
      };
      const hash = 'test-hash-8';
      const session = getSession(hash, token);

      expect(session.credentialReads).toBe(0);

      recordCredentialRead(hash);
      expect(session.credentialReads).toBe(1);

      recordCredentialRead(hash);
      expect(session.credentialReads).toBe(2);
    });
  });

  describe('default credentialAccess population', () => {
    it('should populate credentialAccess for tokens with secret:read', () => {
      const token = createToken({
        agentId: 'test',
        permissions: ['secret:read'],
        exp: Date.now() + 3600000,
      });

      const validated = validateToken(token);
      expect(validated?.credentialAccess).toBeDefined();
      expect(validated!.credentialAccess!.read).toEqual(['*']);
      expect(validated!.credentialAccess!.write).toEqual(['*']);
    });

    it('should populate credentialAccess for tokens with secret:write', () => {
      const token = createToken({
        agentId: 'test',
        permissions: ['secret:write'],
        exp: Date.now() + 3600000,
      });

      const validated = validateToken(token);
      expect(validated?.credentialAccess).toBeDefined();
    });

    it('should not populate credentialAccess for tokens without secret permissions', () => {
      const token = createToken({
        agentId: 'test',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
      });

      const validated = validateToken(token);
      expect(validated?.credentialAccess).toBeUndefined();
    });

    it('should preserve explicit credentialAccess when provided', () => {
      const token = createToken({
        agentId: 'test',
        permissions: ['secret:read'],
        exp: Date.now() + 3600000,
        credentialAccess: { read: ['tag:api'], maxReads: 10 },
      });

      const validated = validateToken(token);
      expect(validated!.credentialAccess!.read).toEqual(['tag:api']);
      expect(validated!.credentialAccess!.maxReads).toBe(10);
    });
  });
});
