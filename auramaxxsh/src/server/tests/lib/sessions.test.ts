/**
 * Tests for session management and spending limits
 *
 * Tests:
 * - Session creation and tracking
 * - Spending limit enforcement
 * - Per-type spending tracking (fund, send, swap)
 * - Token revocation
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSession,
  checkLimitByType,
  recordSpendByType,
  getRemainingByType,
  revokeToken,
  isRevoked,
  clearSessions,
  listSessions,
} from '../../lib/sessions';
import { createTokenSync as createToken, getTokenHash } from '../../lib/auth';
import { cleanDatabase } from '../setup';

describe('Session Management', () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  describe('getSession()', () => {
    it('should create a session for a new token', () => {
      const token = createToken({
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: 1.0 },
        exp: Date.now() + 3600000,
      });
      const tokenHash = getTokenHash(token);

      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: 1.0 },
        exp: Date.now() + 3600000,
      };

      const session = getSession(tokenHash, payload);

      expect(session).toBeDefined();
      expect(session.token).toEqual(payload);
      expect(session.spent).toBe(0);
      expect(session.spentByType).toEqual({ fund: 0, send: 0, swap: 0 });
    });

    it('should return same session for same token hash', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: 1.0 },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);

      const session1 = getSession(tokenHash, payload);
      const session2 = getSession(tokenHash, payload);

      expect(session1).toBe(session2);
    });
  });

  describe('Spending Limits', () => {
    it('should allow spending within limit', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: 1.0 },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);

      // Initialize session
      getSession(tokenHash, payload);

      // Check limit for 0.5 ETH - should pass
      const canSpend = checkLimitByType(tokenHash, payload, 'fund', 0.5);
      expect(canSpend).toBe(true);
    });

    it('should reject spending over limit', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: 1.0 },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);

      getSession(tokenHash, payload);

      // Check limit for 1.5 ETH - should fail
      const canSpend = checkLimitByType(tokenHash, payload, 'fund', 1.5);
      expect(canSpend).toBe(false);
    });

    it('should track cumulative spending', async () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: 1.0 },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);

      getSession(tokenHash, payload);

      // First spend
      await recordSpendByType(tokenHash, 'fund', 0.5);

      // Check remaining
      const remaining = getRemainingByType(tokenHash, payload, 'fund');
      expect(remaining).toBeCloseTo(0.5);

      // Second spend should fail if over limit
      const canSpend = checkLimitByType(tokenHash, payload, 'fund', 0.6);
      expect(canSpend).toBe(false);

      // But 0.4 should still work
      const canSpendLess = checkLimitByType(tokenHash, payload, 'fund', 0.4);
      expect(canSpendLess).toBe(true);
    });

    it('should track spending per type independently', async () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['fund', 'send:hot'],
        limits: { fund: 1.0, send: 2.0 },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);

      getSession(tokenHash, payload);

      // Spend from fund
      await recordSpendByType(tokenHash, 'fund', 0.8);

      // Fund should have 0.2 remaining
      expect(getRemainingByType(tokenHash, payload, 'fund')).toBeCloseTo(0.2);

      // Send should still have full 2.0
      expect(getRemainingByType(tokenHash, payload, 'send')).toBeCloseTo(2.0);
    });

    it('should include fund spent from spentByType in listSessions', async () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: 1.0 },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);

      const session = getSession(tokenHash, payload);
      session.spentByType = { fund: 0.4, send: 0, swap: 0 };
      session.spent = 0;

      const sessions = listSessions();
      const [row] = sessions.filter(s => s.tokenHash === tokenHash);

      expect(row.spent).toBe(0.4);
      expect(row.remaining).toBe(0.6);
    });

    it('should aggregate fund spend across currencies in listSessions when spent is currency-keyed', async () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: 2.5 },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);

      const session = getSession(tokenHash, payload);
      session.spentByType = {
        fund: { '0xaaa': 1.0, '0xbbb': 0.5 },
        send: 0,
        swap: 0,
      };
      session.spent = 0;

      const sessions = listSessions();
      const [row] = sessions.filter(s => s.tokenHash === tokenHash);

      expect(row.spent).toBe(1.5);
      expect(row.remaining).toBe(1.0);
    });

    it('should allow unlimited spending when no limit set at all', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['send:hot'],
        // No limits set, no fund limit
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);

      getSession(tokenHash, payload);

      // Should allow any amount (no fund limit = no send limit)
      const canSpend = checkLimitByType(tokenHash, payload, 'send', 1000000);
      expect(canSpend).toBe(true);

      // Remaining should be Infinity
      expect(getRemainingByType(tokenHash, payload, 'send')).toBe(Infinity);
    });

    it('should default send limit to fund limit when send not explicitly set', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['send:hot', 'fund'],
        limit: 1.0, // Fund limit of 1.0 ETH, no explicit send limit
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);

      getSession(tokenHash, payload);

      // Send limit should default to fund limit (1.0)
      expect(checkLimitByType(tokenHash, payload, 'send', 0.5)).toBe(true);
      expect(checkLimitByType(tokenHash, payload, 'send', 1.5)).toBe(false);
      expect(getRemainingByType(tokenHash, payload, 'send')).toBeCloseTo(1.0);
    });

    it('should use explicit send limit over fund limit when both set', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['send:hot', 'fund'],
        limits: { fund: 2.0, send: 0.5 }, // Explicit send limit lower than fund
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);

      getSession(tokenHash, payload);

      // Send limit should be 0.5, not 2.0
      expect(checkLimitByType(tokenHash, payload, 'send', 0.3)).toBe(true);
      expect(checkLimitByType(tokenHash, payload, 'send', 0.6)).toBe(false);
      expect(getRemainingByType(tokenHash, payload, 'send')).toBeCloseTo(0.5);

      // Fund limit should still be 2.0
      expect(getRemainingByType(tokenHash, payload, 'fund')).toBeCloseTo(2.0);
    });
  });

  describe('Token Revocation', () => {
    it('should mark token as revoked', () => {
      const token = createToken({
        agentId: 'test-agent',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
      });
      const tokenHash = getTokenHash(token);

      expect(isRevoked(tokenHash)).toBe(false);

      revokeToken(tokenHash);

      expect(isRevoked(tokenHash)).toBe(true);
    });

    it('should persist revocation across session lookups', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);

      // Create session
      getSession(tokenHash, payload);

      // Revoke
      revokeToken(tokenHash);

      // Should still be revoked
      expect(isRevoked(tokenHash)).toBe(true);
    });
  });

  describe('clearSessions()', () => {
    it('should clear all sessions and spending', async () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: 1.0 },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);

      getSession(tokenHash, payload);
      await recordSpendByType(tokenHash, 'fund', 0.5);

      // Clear sessions
      clearSessions();

      // New session should have fresh spending
      const newSession = getSession(tokenHash, payload);
      expect(newSession.spent).toBe(0);
      expect(getRemainingByType(tokenHash, payload, 'fund')).toBe(1.0);
    });
  });
});
