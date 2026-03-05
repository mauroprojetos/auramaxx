/**
 * Tests for auth middleware
 *
 * Tests:
 * - requireWalletAuth: token validation and attachment
 * - optionalWalletAuth: optional auth handling
 * - Admin token recognition
 * - Token expiry handling
 * - Revoked token handling
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, TEST_PASSWORD, resetColdWallet, setupColdWallet, setupAndUnlockWallet } from '../setup';
import { revokeAdminTokens, createTokenSync as createToken, getTokenHash } from '../../lib/auth';
import { revokeToken } from '../../lib/sessions';
import { lock } from '../../lib/cold';

describe('Auth Middleware', () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanDatabase();
    resetColdWallet();
  });

  afterEach(() => {
    revokeAdminTokens();
    lock();
  });

  describe('requireWalletAuth', () => {
    it('should reject requests without Authorization header', async () => {
      // Use wallet create which requires auth
      const createRes = await request(app)
        .post('/wallet/create')
        .send({ tier: 'hot', name: 'Test' })
        .expect(401);

      expect(createRes.body.error).toBe('Authorization header required');
    });

    it('should reject requests with invalid Bearer prefix', async () => {
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', 'Basic sometoken')
        .send({ tier: 'hot', name: 'Test' })
        .expect(401);

      expect(res.body.error).toBe('Authorization header required');
    });

    it('should reject invalid tokens', async () => {
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', 'Bearer invalidtoken123')
        .send({ tier: 'hot', name: 'Test' })
        .expect(401);

      expect(res.body.error).toBe('Invalid or expired token');
    });

    it('should accept valid admin token', async () => {
      // Setup and unlock wallet first
      const { adminToken } = await setupAndUnlockWallet();

      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tier: 'hot', name: 'Admin Test Wallet' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.wallet).toBeDefined();
      expect(res.body.wallet.address).toBeDefined();
    });

    it('should accept valid agent token with correct permissions', async () => {
      // Setup wallet
      await setupAndUnlockWallet();

      // Create an agent token with wallet:create:hot permission
      const agentToken = createToken({
        agentId: 'test-agent',
        permissions: ['wallet:create:hot'],
        exp: Date.now() + 3600000, // 1 hour
      });

      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Agent Test Wallet' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.wallet).toBeDefined();
      expect(res.body.wallet.address).toBeDefined();
    });

    it('should reject expired tokens', async () => {
      await setupAndUnlockWallet();

      // Create an expired token
      const expiredToken = createToken({
        agentId: 'test-agent',
        permissions: ['wallet:create:hot'],
        exp: Date.now() - 1000, // Already expired
      });

      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${expiredToken}`)
        .send({ tier: 'hot', name: 'Should Fail' })
        .expect(401);

      expect(res.body.error).toBe('Invalid or expired token');
    });

    it('should reject revoked tokens', async () => {
      await setupAndUnlockWallet();

      // Create a valid token
      const agentToken = createToken({
        agentId: 'test-agent',
        permissions: ['wallet:create:hot'],
        exp: Date.now() + 3600000,
      });

      // Revoke it
      revokeToken(getTokenHash(agentToken));

      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Should Fail' })
        .expect(401);

      expect(res.body.error).toBe('Token has been revoked');
    });
  });

  describe('optionalWalletAuth', () => {
    it('should allow requests without auth for endpoints with optional auth', async () => {
      await setupAndUnlockWallet();

      // /wallets/search uses optionalWalletAuth
      const res = await request(app)
        .get('/wallets/search')
        .query({ q: 'test' })
        .expect(200);

      // Should return results object with wallets array
      expect(res.body.wallets).toBeDefined();
      expect(Array.isArray(res.body.wallets)).toBe(true);
    });

    it('should attach auth info when valid token provided', async () => {
      const { adminToken } = await setupAndUnlockWallet();

      // Create a wallet first
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tier: 'hot', name: 'SearchableWallet' });

      // Search with auth - should work
      const res = await request(app)
        .get('/wallets/search')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ q: 'Searchable' })
        .expect(200);

      expect(res.body.wallets).toBeDefined();
      expect(Array.isArray(res.body.wallets)).toBe(true);
    });

    it('should silently ignore invalid tokens and continue without auth', async () => {
      await setupAndUnlockWallet();

      // Search with invalid token - should still work but without auth
      const res = await request(app)
        .get('/wallets/search')
        .set('Authorization', 'Bearer invalidtoken')
        .query({ q: 'test' })
        .expect(200);

      expect(res.body.wallets).toBeDefined();
      expect(Array.isArray(res.body.wallets)).toBe(true);
    });
  });

  describe('Admin Token Handling', () => {
    it('should recognize admin token by admin:* permission', async () => {
      const { adminToken } = await setupAndUnlockWallet();

      // Admin should be able to access any protected route
      const res = await request(app)
        .get('/actions/tokens')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('should reject wildcard-only token on admin middleware routes', async () => {
      await setupAndUnlockWallet();
      const wildcardToken = createToken({
        agentId: 'wildcard-agent',
        permissions: ['*'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/security/credential-access/recent')
        .set('Authorization', `Bearer ${wildcardToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Admin access required');
    });

    it('should invalidate admin token after lock', async () => {
      const { adminToken } = await setupAndUnlockWallet();

      // Lock the wallet (revokes admin token)
      lock();
      revokeAdminTokens();

      // Admin token should now be revoked
      const res = await request(app)
        .get('/actions/tokens')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(401);

      expect(res.body.error).toBe('Token has been revoked');
    });
  });
});
