/**
 * Tests for permission system
 *
 * Tests:
 * - isAdmin() function
 * - hasAnyPermission() function
 * - hasAllPermissions() function
 * - requirePermission() middleware
 * - requireAdmin() middleware
 * - Permission helper functions
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, resetColdWallet, setupAndUnlockWallet } from '../setup';
import {
  isAdmin,
  hasAnyPermission,
  hasAllPermissions,
  getWalletCreatePermission,
  getSendPermission,
  expandPermissions,
  getCompoundPermissions,
} from '../../lib/permissions';
import { revokeAdminTokens, createTokenSync as createToken } from '../../lib/auth';
import { lock } from '../../lib/cold';

describe('Permission System', () => {
  describe('isAdmin()', () => {
    it('should return true when token has admin:* permission', () => {
      const auth = {
        token: { permissions: ['admin:*'] }
      };
      expect(isAdmin(auth)).toBe(true);
    });

    it('should return false when token does not have admin:* permission', () => {
      const auth = {
        token: { permissions: ['wallet:list', 'send:hot'] }
      };
      expect(isAdmin(auth)).toBe(false);
    });

    it('should return false for empty permissions', () => {
      const auth = {
        token: { permissions: [] }
      };
      expect(isAdmin(auth)).toBe(false);
    });

    it('should handle admin:* among other permissions', () => {
      const auth = {
        token: { permissions: ['wallet:list', 'admin:*', 'send:hot'] }
      };
      expect(isAdmin(auth)).toBe(true);
    });
  });

  describe('hasAnyPermission()', () => {
    it('should return true if token has any of the required permissions', () => {
      const tokenPerms = ['wallet:list', 'send:hot'];
      const required = ['send:hot', 'send:temp'];
      expect(hasAnyPermission(tokenPerms, required)).toBe(true);
    });

    it('should return false if token has none of the required permissions', () => {
      const tokenPerms = ['wallet:list', 'wallet:create:hot'];
      const required = ['send:hot', 'send:temp'];
      expect(hasAnyPermission(tokenPerms, required)).toBe(false);
    });

    it('should return true for admin:* regardless of required permissions', () => {
      const tokenPerms = ['admin:*'];
      const required = ['send:hot', 'send:temp', 'fund'];
      expect(hasAnyPermission(tokenPerms, required)).toBe(true);
    });

    it('should handle empty required permissions', () => {
      const tokenPerms = ['wallet:list'];
      const required: string[] = [];
      expect(hasAnyPermission(tokenPerms, required)).toBe(false);
    });

    it('should handle empty token permissions', () => {
      const tokenPerms: string[] = [];
      const required = ['wallet:list'];
      expect(hasAnyPermission(tokenPerms, required)).toBe(false);
    });

    it('should expand compound permission trade:all to include apikey:get', () => {
      const tokenPerms = ['trade:all'];
      const required = ['apikey:get'];
      expect(hasAnyPermission(tokenPerms, required)).toBe(true);
    });

    it('should expand compound permission trade:all to include fund', () => {
      const tokenPerms = ['trade:all'];
      const required = ['fund'];
      expect(hasAnyPermission(tokenPerms, required)).toBe(true);
    });

    it('should expand compound permission trade:all to include wallet:list', () => {
      const tokenPerms = ['trade:all'];
      const required = ['wallet:list'];
      expect(hasAnyPermission(tokenPerms, required)).toBe(true);
    });

    it('should expand compound permission trade:all to include swap', () => {
      const tokenPerms = ['trade:all'];
      const required = ['swap'];
      expect(hasAnyPermission(tokenPerms, required)).toBe(true);
    });

    it('should not expand trade:all to include apikey:set', () => {
      const tokenPerms = ['trade:all'];
      const required = ['apikey:set'];
      expect(hasAnyPermission(tokenPerms, required)).toBe(false);
    });
  });

  describe('Compound Permissions', () => {
    it('expandPermissions should expand trade:all', () => {
      const expanded = expandPermissions(['trade:all']);

      expect(expanded).toContain('wallet:list');
      expect(expanded).toContain('wallet:create:hot');
      expect(expanded).toContain('wallet:create:temp');
      expect(expanded).toContain('send:hot');
      expect(expanded).toContain('send:temp');
      expect(expanded).toContain('swap');
      expect(expanded).toContain('fund');
      expect(expanded).toContain('apikey:get');
      // Should also include the original compound permission
      expect(expanded).toContain('trade:all');
    });

    it('expandPermissions should expand wallet:write', () => {
      const expanded = expandPermissions(['wallet:write']);

      expect(expanded).toContain('wallet:create:hot');
      expect(expanded).toContain('wallet:create:temp');
      expect(expanded).toContain('wallet:rename');
      expect(expanded).toContain('wallet:tx:add');
      expect(expanded).toContain('wallet:asset:add');
      expect(expanded).toContain('wallet:write');
    });

    it('expandPermissions should deduplicate permissions', () => {
      const expanded = expandPermissions(['trade:all', 'wallet:list', 'fund']);

      // Count occurrences of wallet:list
      const walletListCount = expanded.filter(p => p === 'wallet:list').length;
      expect(walletListCount).toBe(1);
    });

    it('expandPermissions should handle multiple compound permissions', () => {
      // If we add more compound permissions in the future
      const expanded = expandPermissions(['trade:all']);
      expect(expanded.length).toBeGreaterThan(1);
    });

    it('getCompoundPermissions should return trade:all mapping', () => {
      const compounds = getCompoundPermissions();

      expect(compounds['trade:all']).toBeDefined();
      expect(compounds['trade:all']).toContain('apikey:get');
      expect(compounds['trade:all']).toContain('fund');
    });

    it('getCompoundPermissions should return wallet:write mapping', () => {
      const compounds = getCompoundPermissions();

      expect(compounds['wallet:write']).toBeDefined();
      expect(compounds['wallet:write']).toContain('wallet:tx:add');
      expect(compounds['wallet:write']).toContain('wallet:asset:add');
    });

    it('hasAllPermissions should work with compound permissions', () => {
      const tokenPerms = ['trade:all'];
      const required = ['wallet:list', 'send:hot', 'fund', 'apikey:get'];
      expect(hasAllPermissions(tokenPerms, required)).toBe(true);
    });

    it('hasAllPermissions should fail if compound does not cover all required', () => {
      const tokenPerms = ['trade:all'];
      const required = ['wallet:list', 'apikey:set']; // apikey:set is NOT in trade:all
      expect(hasAllPermissions(tokenPerms, required)).toBe(false);
    });

    it('hasAnyPermission should work with wallet:write for tx:add', () => {
      const tokenPerms = ['wallet:write'];
      const required = ['wallet:tx:add'];
      expect(hasAnyPermission(tokenPerms, required)).toBe(true);
    });

    it('hasAnyPermission should work with wallet:write for asset:add', () => {
      const tokenPerms = ['wallet:write'];
      const required = ['wallet:asset:add'];
      expect(hasAnyPermission(tokenPerms, required)).toBe(true);
    });
  });

  describe('hasAllPermissions()', () => {
    it('should return true if token has all required permissions', () => {
      const tokenPerms = ['wallet:list', 'send:hot', 'fund'];
      const required = ['wallet:list', 'send:hot'];
      expect(hasAllPermissions(tokenPerms, required)).toBe(true);
    });

    it('should return false if token is missing any required permission', () => {
      const tokenPerms = ['wallet:list', 'send:hot'];
      const required = ['wallet:list', 'send:hot', 'fund'];
      expect(hasAllPermissions(tokenPerms, required)).toBe(false);
    });

    it('should return true for admin:* regardless of required permissions', () => {
      const tokenPerms = ['admin:*'];
      const required = ['wallet:list', 'send:hot', 'fund'];
      expect(hasAllPermissions(tokenPerms, required)).toBe(true);
    });

    it('should return true for empty required permissions', () => {
      const tokenPerms = ['wallet:list'];
      const required: string[] = [];
      expect(hasAllPermissions(tokenPerms, required)).toBe(true);
    });
  });

  describe('Permission Helper Functions', () => {
    it('getWalletCreatePermission should return correct permission for hot tier', () => {
      expect(getWalletCreatePermission('hot')).toBe('wallet:create:hot');
    });

    it('getWalletCreatePermission should return correct permission for temp tier', () => {
      expect(getWalletCreatePermission('temp')).toBe('wallet:create:temp');
    });

    it('getSendPermission should return correct permission for hot tier', () => {
      expect(getSendPermission('hot')).toBe('send:hot');
    });

    it('getSendPermission should return correct permission for temp tier', () => {
      expect(getSendPermission('temp')).toBe('send:temp');
    });
  });
});

describe('Permission Middleware Integration', () => {
  const app = createTestApp();

  beforeEach(async () => {
    await cleanDatabase();
    resetColdWallet();
  });

  afterEach(() => {
    revokeAdminTokens();
    lock();
  });

  describe('requirePermission middleware', () => {
    it('should allow access with correct permission', async () => {
      await setupAndUnlockWallet();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['wallet:create:hot'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${token}`)
        .send({ tier: 'hot', name: 'Test' })
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('should deny access with wrong permission', async () => {
      await setupAndUnlockWallet();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['wallet:list'], // Missing wallet:create:hot
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${token}`)
        .send({ tier: 'hot', name: 'Test' })
        .expect(403);

      expect(res.body.error).toContain('permission');
    });

    it('should allow admin:* to bypass permission checks', async () => {
      const { adminToken } = await setupAndUnlockWallet();

      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tier: 'hot', name: 'Admin Test' })
        .expect(200);

      expect(res.body.success).toBe(true);
    });
  });

  describe('requireAdmin middleware', () => {
    it('should allow admin token access', async () => {
      const { adminToken } = await setupAndUnlockWallet();

      const res = await request(app)
        .get('/actions/tokens')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('should deny agent token access to admin routes', async () => {
      await setupAndUnlockWallet();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['wallet:list', 'send:hot'], // No admin:*
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/actions/tokens')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      expect(res.body.error).toBe('Admin access required');
    });

    it('should deny unauthenticated access to admin routes', async () => {
      await setupAndUnlockWallet();

      const res = await request(app)
        .get('/actions/tokens')
        .expect(401);

      expect(res.body.error).toBe('Authorization header required');
    });
  });

  describe('Wallet Tier Permissions', () => {
    it('should require wallet:create:hot for hot wallet creation', async () => {
      await setupAndUnlockWallet();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['wallet:create:temp'], // Only temp, not hot
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${token}`)
        .send({ tier: 'hot', name: 'Should Fail' })
        .expect(403);

      expect(res.body.error).toContain('wallet:create:hot');
    });

    it('should require wallet:create:temp for temp wallet creation', async () => {
      await setupAndUnlockWallet();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['wallet:create:hot'], // Only hot, not temp
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${token}`)
        .send({ tier: 'temp', name: 'Should Fail' })
        .expect(403);

      expect(res.body.error).toContain('wallet:create:temp');
    });
  });
});
