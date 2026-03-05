/**
 * Tests for address-keyed (multi-currency) spending limits
 *
 * Tests:
 * - Plain number limits (backward compat)
 * - Address-keyed limits (new multi-currency)
 * - Mixed limit types
 * - Currency-specific spending tracking
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSession,
  checkLimitByType,
  recordSpendByType,
  getRemainingByType,
  clearSessions,
  resolveLimit,
} from '../../lib/sessions';
import { createTokenSync as createToken, getTokenHash } from '../../lib/auth';
import { cleanDatabase } from '../setup';

describe('Multi-Currency Spending Limits', () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  describe('resolveLimit()', () => {
    it('should return plain number as-is', () => {
      expect(resolveLimit(1.0)).toBe(1.0);
      expect(resolveLimit(1.0, 'any-currency')).toBe(1.0);
    });

    it('should look up by currency in Record', () => {
      const limit = { '0x0000': 1.0, 'So111': 10.0 };
      expect(resolveLimit(limit, '0x0000')).toBe(1.0);
      expect(resolveLimit(limit, 'So111')).toBe(10.0);
    });

    it('should return undefined for missing currency in Record', () => {
      const limit = { '0x0000': 1.0 };
      expect(resolveLimit(limit, 'So111')).toBeUndefined();
    });

    it('should return undefined for undefined limit', () => {
      expect(resolveLimit(undefined)).toBeUndefined();
      expect(resolveLimit(undefined, 'any')).toBeUndefined();
    });
  });

  describe('Backward Compatibility - Plain Number Limits', () => {
    it('should work with plain number fund limit', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: 1.0 },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);
      getSession(tokenHash, payload);

      // No currency param - backward compat
      expect(checkLimitByType(tokenHash, payload, 'fund', 0.5)).toBe(true);
      expect(checkLimitByType(tokenHash, payload, 'fund', 1.5)).toBe(false);
      expect(getRemainingByType(tokenHash, payload, 'fund')).toBeCloseTo(1.0);
    });

    it('should work with plain number + currency param (backward compat)', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: 1.0 },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);
      getSession(tokenHash, payload);

      // Currency param with plain number limit - should still use the number
      expect(checkLimitByType(tokenHash, payload, 'fund', 0.5, '0x0000')).toBe(true);
      expect(checkLimitByType(tokenHash, payload, 'fund', 1.5, '0x0000')).toBe(false);
    });
  });

  describe('Address-Keyed Limits', () => {
    it('should enforce separate limits per currency', () => {
      const ETH_ADDR = '0x0000000000000000000000000000000000000000';
      const SOL_ADDR = 'So11111111111111111111111111111111111111112';

      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: { [ETH_ADDR]: 1.0, [SOL_ADDR]: 10.0 } },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);
      getSession(tokenHash, payload);

      // ETH limit is 1.0
      expect(checkLimitByType(tokenHash, payload, 'fund', 0.5, ETH_ADDR)).toBe(true);
      expect(checkLimitByType(tokenHash, payload, 'fund', 1.5, ETH_ADDR)).toBe(false);

      // SOL limit is 10.0
      expect(checkLimitByType(tokenHash, payload, 'fund', 5.0, SOL_ADDR)).toBe(true);
      expect(checkLimitByType(tokenHash, payload, 'fund', 11.0, SOL_ADDR)).toBe(false);
    });

    it('should track spending independently per currency', async () => {
      const ETH_ADDR = '0x0000000000000000000000000000000000000000';
      const SOL_ADDR = 'So11111111111111111111111111111111111111112';

      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: { [ETH_ADDR]: 1.0, [SOL_ADDR]: 10.0 } },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);
      getSession(tokenHash, payload);

      // Spend 0.8 ETH
      await recordSpendByType(tokenHash, 'fund', 0.8, ETH_ADDR);

      // ETH remaining should be 0.2
      expect(getRemainingByType(tokenHash, payload, 'fund', ETH_ADDR)).toBeCloseTo(0.2);

      // SOL remaining should still be 10.0
      expect(getRemainingByType(tokenHash, payload, 'fund', SOL_ADDR)).toBeCloseTo(10.0);

      // Spend 3 SOL
      await recordSpendByType(tokenHash, 'fund', 3.0, SOL_ADDR);

      // SOL remaining should be 7.0
      expect(getRemainingByType(tokenHash, payload, 'fund', SOL_ADDR)).toBeCloseTo(7.0);

      // ETH remaining unchanged
      expect(getRemainingByType(tokenHash, payload, 'fund', ETH_ADDR)).toBeCloseTo(0.2);
    });

    it('should treat address-keyed fund limits without currency as unlimited for fund checks', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: {
          fund: {
            '0x0000000000000000000000000000000000000000': 1.0,
          },
        },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);

      getSession(tokenHash, payload);

      // Without currency context for multi-currency fund limits, behavior remains permissive.
      expect(checkLimitByType(tokenHash, payload, 'fund', 0.5)).toBe(true);
      expect(getRemainingByType(tokenHash, payload, 'fund')).toBe(Infinity);
    });

    it('should return unlimited for currencies not in the Record', () => {
      const ETH_ADDR = '0x0000000000000000000000000000000000000000';
      const UNKNOWN = '0xdeadbeef';

      const payload = {
        agentId: 'test-agent',
        permissions: ['fund'],
        limits: { fund: { [ETH_ADDR]: 1.0 } },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);
      getSession(tokenHash, payload);

      // Unknown currency should be unlimited
      expect(checkLimitByType(tokenHash, payload, 'fund', 1000, UNKNOWN)).toBe(true);
      expect(getRemainingByType(tokenHash, payload, 'fund', UNKNOWN)).toBe(Infinity);
    });
  });

  describe('Mixed Limit Types', () => {
    it('should support plain number for some types and Record for others', async () => {
      const SOL_ADDR = 'So11111111111111111111111111111111111111112';

      const payload = {
        agentId: 'test-agent',
        permissions: ['fund', 'send:hot'],
        limits: {
          fund: { [SOL_ADDR]: 10.0 }, // Address-keyed
          send: 5.0,                   // Plain number
        },
        exp: Date.now() + 3600000,
      };
      const token = createToken(payload);
      const tokenHash = getTokenHash(token);
      getSession(tokenHash, payload);

      // Fund limit is address-keyed
      expect(checkLimitByType(tokenHash, payload, 'fund', 8.0, SOL_ADDR)).toBe(true);
      expect(getRemainingByType(tokenHash, payload, 'fund', SOL_ADDR)).toBeCloseTo(10.0);

      // Send limit is plain number
      expect(checkLimitByType(tokenHash, payload, 'send', 3.0)).toBe(true);
      expect(checkLimitByType(tokenHash, payload, 'send', 6.0)).toBe(false);
      expect(getRemainingByType(tokenHash, payload, 'send')).toBeCloseTo(5.0);
    });
  });
});
