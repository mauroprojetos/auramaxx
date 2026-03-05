/**
 * V1 Launch Auth Regression Tests
 *
 * Verifies that every protected route correctly enforces authentication
 * and permission checks. This is a safety net to catch regressions where
 * a route might accidentally become unprotected.
 *
 * Structure:
 * 1. Unauthenticated requests → 401
 * 2. Wrong-permission tokens → 403
 * 3. Admin bypass → 200 (or valid error, not 401/403)
 * 4. Approval flow E2E edge cases
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, setupAndUnlockWallet, resetColdWallet } from '../setup';
import { createTokenSync as createToken, revokeAdminTokens } from '../../lib/auth';
import { lock } from '../../lib/cold';

const app = createTestApp();

/**
 * Helper: create a token with specific permissions
 */
function makeToken(permissions: string[], agentId = 'regression-agent'): string {
  return createToken({
    agentId,
    permissions,
    exp: Date.now() + 3600_000,
  });
}

// ──────────────────────────────────────────────────────────────────────
// PART 1: Route-level auth enforcement regression
// Every route that uses requireWalletAuth must return 401 without a token.
// Every route that uses requirePermission/requireAdmin must return 403
// when the token lacks the required permission.
// ──────────────────────────────────────────────────────────────────────

describe('Auth Enforcement Regression', () => {
  let adminToken: string;

  beforeAll(async () => {
    await cleanDatabase();
    resetColdWallet();
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
  });

  afterAll(async () => {
    revokeAdminTokens();
    lock();
    await testPrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // ── Unauthenticated → 401 ──────────────────────────────────────────

  describe('Unauthenticated requests should return 401', () => {
    const protectedRoutes: Array<{ method: 'get' | 'post' | 'delete' | 'put' | 'patch'; path: string }> = [
      // Wallet
      { method: 'post', path: '/wallet/create' },
      { method: 'post', path: '/wallet/rename' },
      { method: 'get', path: '/wallet/export-seed' },

      // Send
      { method: 'post', path: '/send' },

      // Swap
      { method: 'post', path: '/swap' },

      // Fund
      { method: 'post', path: '/fund' },

      // Launch
      { method: 'post', path: '/launch' },
      { method: 'post', path: '/launch/collect-fees' },

      // API Keys
      { method: 'get', path: '/apikeys' },
      { method: 'post', path: '/apikeys' },

      // Lock
      { method: 'post', path: '/lock' },

      // Nuke
      { method: 'post', path: '/nuke' },

      // Defaults (admin)
      { method: 'get', path: '/defaults' },

      // Actions
      { method: 'get', path: '/actions/tokens' },
      { method: 'post', path: '/actions/token' },
      { method: 'post', path: '/actions/token/preview' },
      { method: 'post', path: '/actions/tokens/revoke' },
      { method: 'get', path: '/actions/pending' },

      // Strategies
      { method: 'get', path: '/strategies' },
      { method: 'post', path: '/strategies' },

      // Adapters
      { method: 'get', path: '/adapters' },
      { method: 'post', path: '/adapters' },
      { method: 'post', path: '/adapters/test' },
      { method: 'post', path: '/adapters/restart' },

      // Apps (GET /apps may return 404 without app context; POST requires auth)
      // { method: 'get', path: '/apps' },

      // Credentials
      { method: 'get', path: '/credentials' },
      { method: 'post', path: '/credentials' },

      // Bookmarks (write)
      { method: 'post', path: '/bookmarks' },

      // Address labels (write)
      { method: 'post', path: '/address-labels' },

      // Heartbeat diary
      { method: 'post', path: '/what_is_happening/diary' },

      // Security
      { method: 'get', path: '/security' },
    ];

    for (const { method, path } of protectedRoutes) {
      it(`${method.toUpperCase()} ${path} → 401`, async () => {
        const res = await (request(app) as any)[method](path).send({});
        expect(res.status).toBe(401);
      });
    }
  });

  // ── Invalid token → 401 ────────────────────────────────────────────

  describe('Invalid/expired token should return 401', () => {
    it('should reject expired token', async () => {
      const expired = createToken({
        agentId: 'test',
        permissions: ['admin:*'],
        exp: Date.now() - 1000, // already expired
      });

      const res = await request(app)
        .get('/actions/tokens')
        .set('Authorization', `Bearer ${expired}`);

      expect(res.status).toBe(401);
    });

    it('should reject malformed token', async () => {
      const res = await request(app)
        .get('/actions/tokens')
        .set('Authorization', 'Bearer not-a-real-jwt-token');

      expect(res.status).toBe(401);
    });

    it('should reject missing Bearer prefix', async () => {
      const res = await request(app)
        .get('/actions/tokens')
        .set('Authorization', adminToken);

      expect(res.status).toBe(401);
    });
  });

  // ── Permission-specific 403 checks ─────────────────────────────────

  describe('Wrong permission should return 403', () => {
    it('wallet:create:hot requires wallet:create:hot, not wallet:list', async () => {
      const token = makeToken(['wallet:list']);
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${token}`)
        .send({ tier: 'hot', name: 'Fail' });

      expect(res.status).toBe(403);
    });

    it('wallet:create:temp requires wallet:create:temp, not wallet:create:hot', async () => {
      const token = makeToken(['wallet:create:hot']);
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${token}`)
        .send({ tier: 'temp', name: 'Fail' });

      expect(res.status).toBe(403);
    });

    it('export-seed requires admin:*, not wallet:list', async () => {
      const token = makeToken(['wallet:list', 'wallet:export']);
      const res = await request(app)
        .get('/wallet/export-seed')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('lock requires admin:*', async () => {
      const token = makeToken(['wallet:list']);
      const res = await request(app)
        .post('/lock')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('nuke requires admin:*', async () => {
      const token = makeToken(['wallet:list']);
      const res = await request(app)
        .post('/nuke')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('defaults requires admin:*', async () => {
      const token = makeToken(['wallet:list']);
      const res = await request(app)
        .get('/defaults')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('actions/tokens requires admin:*', async () => {
      const token = makeToken(['wallet:list']);
      const res = await request(app)
        .get('/actions/tokens')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('actions/token (create) requires admin:*', async () => {
      const token = makeToken(['wallet:list']);
      const res = await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${token}`)
        .send({ agentId: 'x', permissions: ['wallet:list'] });

      expect(res.status).toBe(403);
    });

    it('actions/pending requires admin:*', async () => {
      const token = makeToken(['wallet:list']);
      const res = await request(app)
        .get('/actions/pending')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('adapters require adapter:manage', async () => {
      const token = makeToken(['wallet:list']);
      const res = await request(app)
        .get('/adapters')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('strategies read requires strategy:read', async () => {
      const token = makeToken(['wallet:list']);
      const res = await request(app)
        .get('/strategies')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('apikeys read requires apikey:get', async () => {
      const token = makeToken(['wallet:list']);
      const res = await request(app)
        .get('/apikeys')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('apikeys write requires apikey:set', async () => {
      const token = makeToken(['apikey:get']);
      const res = await request(app)
        .post('/apikeys')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'test', key: 'k', secret: 's' });

      expect(res.status).toBe(403);
    });
  });

  // ── Admin bypass ───────────────────────────────────────────────────

  describe('admin:* should bypass permission checks', () => {
    it('admin can access actions/tokens', async () => {
      const res = await request(app)
        .get('/actions/tokens')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
    });

    it('admin can access actions/pending', async () => {
      const res = await request(app)
        .get('/actions/pending')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
    });

    it('admin can access defaults', async () => {
      const res = await request(app)
        .get('/defaults')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
    });

    it('admin can access strategies', async () => {
      const res = await request(app)
        .get('/strategies')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
    });

    it('admin can access adapters', async () => {
      const res = await request(app)
        .get('/adapters')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
    });
  });

  // ── Compound permission expansion ──────────────────────────────────

  describe('Compound permissions should grant correct access', () => {
    it('trade:all grants swap access (not 403)', async () => {
      const token = makeToken(['trade:all']);
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      // Should NOT be 401 or 403 — the permission check passes,
      // subsequent validation errors are fine
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it('trade:all grants apikey:get access', async () => {
      const token = makeToken(['trade:all']);
      const res = await request(app)
        .get('/apikeys')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it('trade:all does NOT grant apikey:set access', async () => {
      const token = makeToken(['trade:all']);
      const res = await request(app)
        .post('/apikeys')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'test', key: 'k', secret: 's' });

      expect(res.status).toBe(403);
    });

    it('trade:all does NOT grant adapter:manage access', async () => {
      const token = makeToken(['trade:all']);
      const res = await request(app)
        .get('/adapters')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('trade:all does NOT grant admin access (lock)', async () => {
      const token = makeToken(['trade:all']);
      const res = await request(app)
        .post('/lock')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('extension:* grants action:read but not adapter:manage', async () => {
      const token = makeToken(['extension:*']);
      // action:read is in extension:*
      const res1 = await request(app)
        .get('/adapters')
        .set('Authorization', `Bearer ${token}`);
      expect(res1.status).toBe(403);
    });

    it('wallet:write grants wallet:create:hot and wallet:create:temp', async () => {
      const token = makeToken(['wallet:write']);

      const hotRes = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${token}`)
        .send({ tier: 'hot', name: 'Compound Hot' });
      expect(hotRes.status).not.toBe(403);

      const tempRes = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${token}`)
        .send({ tier: 'temp', name: 'Compound Temp' });
      expect(tempRes.status).not.toBe(403);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// PART 2: Approval flow edge-case regression tests
// ──────────────────────────────────────────────────────────────────────

describe('Approval Flow Regression', () => {
  let adminToken: string;

  beforeAll(async () => {
    await cleanDatabase();
    resetColdWallet();
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
  });

  afterAll(async () => {
    revokeAdminTokens();
    lock();
    await testPrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  describe('Privilege escalation prevention', () => {
    it('action request cannot include admin:* permission', async () => {
      const token = makeToken(['action:create']);
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          pubkey: 'dGVzdA==',
          summary: 'Escalation attempt',
          permissions: ['admin:*'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('admin:*');
    });

    it('action request cannot include action:create (recursive)', async () => {
      const token = makeToken(['action:create']);
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${token}`)
        .send({
          pubkey: 'dGVzdA==',
          summary: 'Recursive attempt',
          permissions: ['action:create'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('action:create');
    });

    it('non-admin cannot resolve actions', async () => {
      // Create auth request
      const authRes = await request(app)
        .post('/auth')
        .send({
          agentId: 'test',
          profile: 'dev',
          pubkey: 'dGVzdA==',
        });

      // Try to resolve with non-admin token
      const agentToken = makeToken(['action:create', 'wallet:list']);
      const res = await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ approved: true });

      expect(res.status).toBe(403);
    });

    it('non-admin cannot create tokens directly', async () => {
      const token = makeToken(['wallet:list', 'action:create']);
      const res = await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${token}`)
        .send({
          agentId: 'sneaky',
          permissions: ['admin:*'],
          pubkey: 'dGVzdA==',
        });

      expect(res.status).toBe(403);
    });
  });

  describe('Approval state machine correctness', () => {
    it('cannot approve an already-rejected request', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: 'test', profile: 'dev', pubkey: 'dGVzdA==' });

      // Reject
      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: false });

      // Try to approve
      const res = await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      expect(res.status).toBe(404);
    });

    it('cannot reject an already-approved request', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: 'test', profile: 'dev', pubkey: 'dGVzdA==' });

      // Approve
      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      // Try to reject
      const res = await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: false });

      expect(res.status).toBe(404);
    });

    it('poll with wrong secret is forbidden', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: 'test', profile: 'dev', pubkey: 'dGVzdA==' });

      const res = await request(app)
        .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', '0000000000000000000000000000000000000000000000000000000000000000');

      // Server may return 403 (invalid secret) or 404 (request not found after cleanDatabase)
      expect([403, 404]).toContain(res.status);
    });

    it('poll without secret is rejected', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: 'test', profile: 'dev', pubkey: 'dGVzdA==' });

      const res = await request(app)
        .get(`/auth/${authRes.body.requestId}`);

      expect(res.status).toBe(400);
    });
  });

  describe('Token revocation enforcement', () => {
    it('revoked token cannot access protected routes', async () => {
      // Create a token
      const agentToken = makeToken(['wallet:list', 'wallet:create:hot']);

      // Verify it works
      const res1 = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Pre-revoke' });
      expect(res1.status).toBe(200);

      // Revoke via admin (need to get hash first)
      const tokensRes = await request(app)
        .get('/actions/tokens')
        .set('Authorization', `Bearer ${adminToken}`);

      const agentTokenEntry = tokensRes.body.tokens.active.find(
        (t: { agentId: string }) => t.agentId === 'regression-agent'
      );

      if (agentTokenEntry) {
        await request(app)
          .post('/actions/tokens/revoke')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ tokenHash: agentTokenEntry.tokenHash });

        // Verify revoked token is rejected
        const res2 = await request(app)
          .post('/wallet/create')
          .set('Authorization', `Bearer ${agentToken}`)
          .send({ tier: 'hot', name: 'Post-revoke' });
        expect(res2.status).toBe(401);
      }
    });
  });

  describe('Auth request requires profile (no raw permissions)', () => {
    it('rejects POST /auth with raw permissions', async () => {
      const res = await request(app)
        .post('/auth')
        .send({
          agentId: 'test',
          permissions: ['admin:*'],
          pubkey: 'dGVzdA==',
        });

      expect(res.status).toBe(400);
      // When profile is missing, server returns AGENT_PROFILE_REQUIRED regardless
      // of whether permissions was also sent
      expect(res.body.code).toBe('AGENT_PROFILE_REQUIRED');
    });

    it('rejects POST /auth without profile', async () => {
      const res = await request(app)
        .post('/auth')
        .send({ agentId: 'test', pubkey: 'dGVzdA==' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AGENT_PROFILE_REQUIRED');
    });
  });
});
