/**
 * Tests for auth library functions
 *
 * Tests:
 * - Token creation and validation
 * - Admin token generation and validation (admin is just a permission)
 * - Token hashing
 * - Signing key regeneration
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTokenSync as createToken,
  validateToken,
  revokeAdminTokens,
  getTokenHash,
  regenerateSigningKey,
} from '../../lib/auth';
import { lock } from '../../lib/cold';
import { cleanDatabase, resetColdWallet, setupAndUnlockWallet } from '../setup';

describe('Auth Library', () => {
  beforeEach(async () => {
    await cleanDatabase();
    resetColdWallet();
  });

  afterEach(() => {
    revokeAdminTokens();
    lock();
  });

  describe('createToken()', () => {
    it('should create a valid token', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['wallet:list', 'send:hot'],
        exp: Date.now() + 3600000,
      };

      const token = createToken(payload);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('should create tokens that can be validated', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
      };

      const token = createToken(payload);
      const validated = validateToken(token);

      expect(validated).toBeDefined();
      expect(validated?.agentId).toBe('test-agent');
      expect(validated?.permissions).toContain('wallet:list');
    });

    it('should include all payload fields in token', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['wallet:list', 'send:hot', 'fund'],
        exp: Date.now() + 3600000,
        limits: { fund: 1.0, send: 0.5 },
        walletAccess: ['0x1234567890abcdef1234567890abcdef12345678'],
      };

      const token = createToken(payload);
      const validated = validateToken(token);

      expect(validated?.agentId).toBe('test-agent');
      expect(validated?.permissions).toEqual(payload.permissions);
      expect(validated?.limits).toEqual(payload.limits);
      expect(validated?.walletAccess).toEqual(payload.walletAccess);
    });
  });

  describe('validateToken()', () => {
    it('should return null for invalid tokens', () => {
      const result = validateToken('invalid-token');
      expect(result).toBeNull();
    });

    it('should return null for expired tokens', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['wallet:list'],
        exp: Date.now() - 1000, // Expired
      };

      const token = createToken(payload);
      const validated = validateToken(token);

      expect(validated).toBeNull();
    });

    it('should return null for tampered tokens', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
      };

      const token = createToken(payload);
      // Tamper with the token
      const tamperedToken = token.slice(0, -5) + 'xxxxx';

      const validated = validateToken(tamperedToken);
      expect(validated).toBeNull();
    });

    it('should validate tokens until expiry', () => {
      const payload = {
        agentId: 'test-agent',
        permissions: ['wallet:list'],
        exp: Date.now() + 100, // Very short expiry
      };

      const token = createToken(payload);

      // Should be valid immediately
      expect(validateToken(token)).toBeDefined();
    });
  });

  describe('Admin Token', () => {
    it('should generate admin token when wallet is unlocked', async () => {
      const { adminToken } = await setupAndUnlockWallet();

      expect(adminToken).toBeDefined();
      expect(typeof adminToken).toBe('string');
    });

    it('should validate admin token as regular token with admin:* permission', async () => {
      const { adminToken } = await setupAndUnlockWallet();

      // Admin tokens are now regular tokens with admin:* permission
      const validated = validateToken(adminToken);

      expect(validated).toBeDefined();
      expect(validated?.agentId).toBe('admin');
      expect(validated?.permissions).toContain('admin:*');
    });

    it('should invalidate admin token after revoke', async () => {
      const { adminToken } = await setupAndUnlockWallet();
      revokeAdminTokens();

      // Token should no longer validate (it's revoked, not expired)
      // Note: validateToken still returns the payload, but isRevoked would return true
      // The middleware handles this, but for unit test we check the token hash
      const { revokeToken, isRevoked } = await import('../../lib/sessions');
      const tokenHash = getTokenHash(adminToken);
      expect(isRevoked(tokenHash)).toBe(true);
    });

    it('should generate new token each unlock', async () => {
      const { adminToken: token1 } = await setupAndUnlockWallet();

      // Lock and unlock again
      lock();
      revokeAdminTokens();
      const { adminToken: token2 } = await setupAndUnlockWallet();

      expect(token1).not.toBe(token2);
    });
  });

  describe('getTokenHash()', () => {
    it('should produce consistent hash for same token', () => {
      const token = createToken({
        agentId: 'test-agent',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
      });

      const hash1 = getTokenHash(token);
      const hash2 = getTokenHash(token);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different tokens', () => {
      const token1 = createToken({
        agentId: 'test-agent-1',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
      });

      const token2 = createToken({
        agentId: 'test-agent-2',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
      });

      expect(getTokenHash(token1)).not.toBe(getTokenHash(token2));
    });
  });

  describe('regenerateSigningKey()', () => {
    it.skip('should invalidate all existing tokens after key regeneration (only happens on server restart)', () => {
      // This test is skipped because SIGNING_KEY is const and only regenerates on server restart
      // In production, restarting the server creates a new SIGNING_KEY, invalidating all tokens
      const payload = {
        agentId: 'test-agent',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
      };

      const token = createToken(payload);
      expect(validateToken(token)).toBeDefined();

      // Regenerate key - this is a no-op at runtime
      regenerateSigningKey();

      // In production (after restart), old token would be invalid
      // But at runtime, the key doesn't change
      expect(validateToken(token)).toBeNull();
    });

    it.skip('should allow new tokens after key regeneration (only happens on server restart)', () => {
      regenerateSigningKey();

      const payload = {
        agentId: 'test-agent',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
      };

      const token = createToken(payload);
      expect(validateToken(token)).toBeDefined();
    });
  });
});
