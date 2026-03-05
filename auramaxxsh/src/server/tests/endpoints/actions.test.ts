/**
 * Tests for /actions endpoints (token management + action resolution)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { decryptWithPrivateKey } from '../../lib/credential-transport';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_ID, TEST_AGENT_PUBKEY, setupAndUnlockWallet, encryptPasswordForTest } from '../setup';
import { lock } from '../../lib/cold';
import { revokeAdminTokens } from '../../lib/auth';

const app = createTestApp();
const { publicKey: ACTIONS_TEST_PUBKEY_PEM, privateKey: ACTIONS_TEST_PRIVATE_KEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ACTIONS_TEST_PUBKEY = Buffer.from(ACTIONS_TEST_PUBKEY_PEM, 'utf8').toString('base64');

describe('Actions Endpoints', () => {
  let adminToken: string;

  beforeAll(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  describe('POST /actions/token - Direct Token Creation', () => {
    it('should reject without admin auth', async () => {
      const res = await request(app)
        .post('/actions/token')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: TEST_AGENT_ID,
          limit: 0.5
        });

      expect(res.status).toBe(401);
    });

    it('should reject without agentId', async () => {
      const res = await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          limit: 0.5
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('agentId');
    });

    it('should reject direct issuance when neither profile nor permissions is provided', async () => {
      const res = await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          pubkey: ACTIONS_TEST_PUBKEY,
          agentId: TEST_AGENT_ID,
          limit: 0.5,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ISSUANCE_XOR_REQUIRED');
    });

    it('should reject direct issuance when both profile and permissions are provided', async () => {
      const res = await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          pubkey: ACTIONS_TEST_PUBKEY,
          agentId: TEST_AGENT_ID,
          profile: 'dev',
          permissions: ['secret:read'],
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ISSUANCE_XOR_REQUIRED');
    });

    it('should reject profile adjunct fields when profile is missing', async () => {
      const res = await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          pubkey: ACTIONS_TEST_PUBKEY,
          agentId: TEST_AGENT_ID,
          permissions: ['secret:read'],
          profileVersion: 'v1',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PROFILE_FIELDS_WITHOUT_PROFILE');
    });

    it('should create token directly with admin auth', async () => {
      const res = await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          pubkey: ACTIONS_TEST_PUBKEY,
          agentId: TEST_AGENT_ID,
          limit: 0.5,
          permissions: ['wallet:create:hot', 'send:hot'],
          ttl: 7200
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.encryptedToken).toBeDefined();
      expect(res.body.token).toBeUndefined();
      expect(res.body.agentId).toBe(TEST_AGENT_ID);
      expect(res.body.limit).toBe(0.5);
      expect(res.body.expiresIn).toBe(7200);
      const decrypted = decryptWithPrivateKey(res.body.encryptedToken, ACTIONS_TEST_PRIVATE_KEY_PEM);
      expect(typeof decrypted).toBe('string');
      expect(decrypted.length).toBeGreaterThan(10);
    });

    it('should reject when wallet is locked', async () => {
      lock();
      revokeAdminTokens();

      const res = await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: TEST_AGENT_ID,
          limit: 0.5
        });

      expect(res.status).toBe(401);

      // Re-unlock and get new admin token
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({
          pubkey: TEST_AGENT_PUBKEY, encrypted });
      adminToken = unlockRes.body.token;
    });

    it('should require pubkey on token creation requests', async () => {
      const res = await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          agentId: TEST_AGENT_ID,
          permissions: ['wallet:create:hot'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('pubkey');
    });

    it('should accept pubkey when requesting secret:read', async () => {
      const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const res = await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          agentId: TEST_AGENT_ID,
          permissions: ['secret:read'],
          pubkey: Buffer.from(publicKey, 'utf8').toString('base64'),
        });

      expect(res.status).toBe(200);
      expect(res.body.permissions).toContain('secret:read');
      expect(res.body.hasPubkey).toBe(true);
    });

    it('should issue token from profile with deterministic metadata', async () => {
      const res = await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          pubkey: ACTIONS_TEST_PUBKEY,
          agentId: 'profile-agent',
          profile: 'strict',
          profileVersion: 'v1',
          profileOverrides: { ttlSeconds: 600, maxReads: 25 },
        });

      expect(res.status).toBe(200);
      expect(res.body.profile).toEqual({
        id: 'strict',
        version: 'v1',
        displayName: 'Strict',
        rationale: expect.any(String),
      });
      expect(res.body.permissions).toContain('secret:read');
      expect(res.body.expiresIn).toBe(600);
      expect(res.body.overrideDelta).toEqual(['maxReads', 'ttlSeconds']);
      expect(res.body.effectivePolicyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(res.body.credentialAccess.maxReads).toBe(25);
    });
  });

  describe('POST /actions/token/preview', () => {
    it('should require admin auth', async () => {
      const res = await request(app)
        .post('/actions/token/preview')
        .send({ profile: 'strict' });

      expect(res.status).toBe(401);
    });

    it('should return deterministic preview payload', async () => {
      const res = await request(app)
        .post('/actions/token/preview')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          profile: 'strict',
          profileVersion: 'v1',
          profileOverrides: { ttlSeconds: 600, maxReads: 25 },
        });

      expect(res.status).toBe(200);
      expect(res.body.version).toBe('v1');
      expect(res.body.request.profile).toBe('strict');
      expect(res.body.effectivePolicy.permissions).toContain('secret:read');
      expect(res.body.effectivePolicy.ttlSeconds).toBe(600);
      expect(res.body.effectivePolicy.maxReads).toBe(25);
      expect(res.body.effectivePolicy.rateBudget).toEqual({
        state: 'none',
        requests: null,
        windowSeconds: null,
        source: 'none',
      });
      expect(res.body.effectivePolicyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(res.body.overrideDelta).toEqual(['maxReads', 'ttlSeconds']);
      expect(res.body.denyExamples.map((d: { code: string }) => d.code)).toEqual([
        'DENY_PERMISSION_MISSING',
        'DENY_CREDENTIAL_READ_SCOPE',
        'DENY_CREDENTIAL_WRITE_SCOPE',
        'DENY_EXCLUDED_FIELD',
        'DENY_MAX_READS_EXCEEDED',
        'DENY_RATE_LIMIT',
      ]);
    });

    it('should map unknown profile to ERR_PROFILE_NOT_FOUND', async () => {
      const res = await request(app)
        .post('/actions/token/preview')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ profile: 'not-a-real-profile' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ERR_PROFILE_NOT_FOUND');
    });

    it('should map unsupported profile version to ERR_PROFILE_VERSION_UNSUPPORTED', async () => {
      const res = await request(app)
        .post('/actions/token/preview')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ profile: 'strict', profileVersion: 'v99' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ERR_PROFILE_VERSION_UNSUPPORTED');
    });

    it('preview hash should match issued token hash for same profile input', async () => {
      const previewRes = await request(app)
        .post('/actions/token/preview')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          profile: 'strict',
          profileVersion: 'v1',
          profileOverrides: { ttlSeconds: 600, maxReads: 25 },
        });

      const issueRes = await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          pubkey: ACTIONS_TEST_PUBKEY,
          agentId: 'preview-parity-agent',
          profile: 'strict',
          profileVersion: 'v1',
          profileOverrides: { ttlSeconds: 600, maxReads: 25 },
        });

      expect(previewRes.status).toBe(200);
      expect(issueRes.status).toBe(200);
      expect(previewRes.body.effectivePolicyHash).toBe(issueRes.body.effectivePolicyHash);
    });
  });

  describe('GET /actions/tokens - List Tokens', () => {
    it('should return token list', async () => {
      // Create a token
      await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: TEST_AGENT_ID,
          limit: 0.5,
          permissions: ['wallet:list'],
        });

      const res = await request(app)
        .get('/actions/tokens')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.tokens.active.length).toBeGreaterThan(0);
    });
  });

  describe('POST /actions/tokens/revoke - Revoke Token', () => {
    it('should allow admin to revoke any token', async () => {
      await request(app)
        .post('/actions/token')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: TEST_AGENT_ID,
          limit: 0.5,
          permissions: ['wallet:list'],
        });

      // Get token hash from tokens list
      const tokensRes = await request(app)
        .get('/actions/tokens')
        .set('Authorization', `Bearer ${adminToken}`);
      const tokenHash = tokensRes.body.tokens.active[0]?.tokenHash;

      const res = await request(app)
        .post('/actions/tokens/revoke')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tokenHash });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should allow agent to revoke own token', async () => {
      // Create token via auth flow
      const authRes = await request(app)
        .post('/auth')
        .send({
          pubkey: ACTIONS_TEST_PUBKEY,
          agentId: TEST_AGENT_ID,
          profile: 'dev',
        });

      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const pollRes = await request(app)
        .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

      const token = decryptWithPrivateKey(pollRes.body.encryptedToken, ACTIONS_TEST_PRIVATE_KEY_PEM);

      // Agent revokes own token
      const res = await request(app)
        .post('/actions/tokens/revoke')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should reject agent revoking other token', async () => {
      // Create first token
      const authRes1 = await request(app)
        .post('/auth')
        .send({
          pubkey: ACTIONS_TEST_PUBKEY,
          agentId: 'agent1',
          profile: 'dev',
        });

      await request(app)
        .post(`/actions/${authRes1.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const pollRes1 = await request(app)
        .get(`/auth/${authRes1.body.requestId}`).set('x-aura-claim-secret', authRes1.body.secret);

      // Create second token
      const authRes2 = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'agent2',
          profile: 'dev',
        });

      await request(app)
        .post(`/actions/${authRes2.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      // Get token hash of second token
      const tokensRes = await request(app)
        .get('/actions/tokens')
        .set('Authorization', `Bearer ${adminToken}`);
      // Token may be in active, depleted, or inactive depending on profile limits
      const allTokens = [
        ...(tokensRes.body.tokens.active || []),
        ...(tokensRes.body.tokens.depleted || []),
        ...(tokensRes.body.tokens.inactive || []),
      ];
      const otherTokenHash = allTokens.find(
        (t: { agentId: string }) => t.agentId === 'agent2'
      )?.tokenHash;
      expect(otherTokenHash).toBeDefined();

      // First agent tries to revoke second token
      const res = await request(app)
        .post('/actions/tokens/revoke')
        .set('Authorization', `Bearer ${decryptWithPrivateKey(pollRes1.body.encryptedToken, ACTIONS_TEST_PRIVATE_KEY_PEM)}`)
        .send({ tokenHash: otherTokenHash });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /actions/:id/resolve - Unified Action Resolution', () => {
    it('should approve auth request and generate token via unified endpoint', async () => {
      // Create pending auth request
      const authRes = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: TEST_AGENT_ID,
          limit: 0.5,
          profile: 'dev',
        });

      // Approve via unified endpoint
      const res = await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.agentId).toBe(TEST_AGENT_ID);
      expect(res.body.limit).toBe(0.5);
      expect(res.body.permissions).toEqual(expect.arrayContaining(['wallet:list', 'secret:read']));
    });

    it('should reject request via unified endpoint', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: TEST_AGENT_ID,
          profile: 'dev',
        });

      const res = await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: false });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.approved).toBe(false);

      // Verify DB status
      const dbRequest = await testPrisma.humanAction.findUnique({
        where: { id: authRes.body.requestId }
      });
      expect(dbRequest?.status).toBe('rejected');
    });

    it('should return 401 when wallet is locked', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: TEST_AGENT_ID,
          profile: 'dev',
        });

      lock();
      revokeAdminTokens();

      const res = await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      expect(res.status).toBe(401);

      // Re-unlock and get new admin token
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({
          pubkey: TEST_AGENT_PUBKEY, encrypted });
      adminToken = unlockRes.body.token;
    });

    it('should return 404 for non-existent action', async () => {
      const res = await request(app)
        .post('/actions/nonexistent/resolve')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      expect(res.status).toBe(404);
    });

    it('should return 400 when approved field is missing', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: TEST_AGENT_ID,
          profile: 'dev',
        });

      const res = await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('approved');
    });

    it('should return 404 for already resolved action', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: TEST_AGENT_ID,
          profile: 'dev',
        });

      // Approve first time
      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      // Try again
      const res = await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      expect(res.status).toBe(404);
    });

    it('should create log entry on approval via unified endpoint', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: TEST_AGENT_ID,
          profile: 'dev',
        });

      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const logs = await testPrisma.log.findMany({
        where: { title: { contains: 'Approved' } }
      });

      expect(logs.length).toBeGreaterThan(0);
    });

    it('should list pending actions via GET /actions/pending', async () => {
      await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'agent1',
          profile: 'dev',
        });

      await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'agent2',
          profile: 'dev',
        });

      const res = await request(app)
        .get('/actions/pending')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.actions.length).toBe(2);
    });
  });

  describe('POST /actions - Human Action Requests', () => {
    let agentToken: string;

    beforeEach(async () => {
      // Create a token with action:create permission for testing
      const { createTokenSync } = await import('../../lib/auth');
      agentToken = createTokenSync({
        agentId: 'app:test-app',
        permissions: ['action:create', 'app:storage'],
        exp: Date.now() + 3600_000,
      });
    });

    it('should reject without auth (401)', async () => {
      const res = await request(app)
        .post('/actions')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Buy $DOGE2 for 0.005 ETH',
          permissions: ['swap'],
        });

      expect(res.status).toBe(401);
    });

    it('should reject without action:create permission (403)', async () => {
      // Create a token WITHOUT action:create
      const { createTokenSync } = await import('../../lib/auth');
      const noPermToken = createTokenSync({
        agentId: 'app:no-perm',
        permissions: ['app:storage'],
        exp: Date.now() + 3600_000,
      });

      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${noPermToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Buy $DOGE2 for 0.005 ETH',
          permissions: ['swap'],
        });

      expect(res.status).toBe(403);
    });

    it('should reject admin:* in requested permissions (400)', async () => {
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Escalate privileges',
          permissions: ['swap', 'admin:*'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('admin:*');
    });

    it('should reject wildcard * in requested permissions (400)', async () => {
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Escalate wildcard privileges',
          permissions: ['*'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('*');
    });

    it('should reject action:create in requested permissions (400)', async () => {
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Recursive action',
          permissions: ['action:create'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('action:create');
    });

    it('should reject missing summary (400)', async () => {
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          permissions: ['swap'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('summary');
    });

    it('should reject empty permissions array (400)', async () => {
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Do something',
          permissions: [],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('permissions');
    });

    it('should create action request successfully', async () => {
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Buy $DOGE2 for 0.005 ETH',
          permissions: ['swap'],
          limits: { swap: 0.005 },
          ttl: 60,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.requestId).toBeDefined();
      expect(res.body.secret).toBeDefined();
      expect(res.body.message).toBe('Action escalated — waiting for human approval');
    });

    it('should create pending request in DB with action type', async () => {
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Swap test',
          permissions: ['swap'],
        });

      const dbRequest = await testPrisma.humanAction.findUnique({
        where: { id: res.body.requestId },
      });

      expect(dbRequest).not.toBeNull();
      expect(dbRequest!.type).toBe('action');
      expect(dbRequest!.status).toBe('pending');

      const metadata = JSON.parse(dbRequest!.metadata!);
      expect(metadata.summary).toBe('Swap test');
      expect(metadata.agentId).toBe('app:test-app');
      expect(metadata.permissions).toEqual(['swap']);
    });

    it('full E2E: create → approve → poll for token', async () => {
      // Step 1: Create action request
      const createRes = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Buy $DOGE2 for 0.005 ETH',
          permissions: ['swap'],
          limits: { swap: 0.005 },
          ttl: 60,
        });

      expect(createRes.status).toBe(200);
      const { requestId, secret } = createRes.body;

      // Step 2: Poll — should be pending
      const pendingRes = await request(app)
        .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);
      expect(pendingRes.body.status).toBe('pending');

      // Step 3: Approve
      const approveRes = await request(app)
        .post(`/actions/${requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      expect(approveRes.status).toBe(200);
      expect(approveRes.body.success).toBe(true);
      expect(approveRes.body.token).toBeDefined();
      expect(approveRes.body.permissions).toEqual(['swap']);
      expect(approveRes.body.expiresIn).toBe(60);

      // Step 4: Poll for token — should be approved with encrypted token
      const pollRes = await request(app)
        .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);

      expect(pollRes.status).toBe(200);
      expect(pollRes.body.status).toBe('approved');
      expect(pollRes.body.encryptedToken).toBeDefined();
      expect(pollRes.body.token).toBeUndefined();
      expect(pollRes.body.permissions).toEqual(['swap']);
    });

    it('rejection updates DB status', async () => {
      const createRes = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Should be rejected',
          permissions: ['swap'],
        });

      const { requestId, secret } = createRes.body;

      // Reject
      const rejectRes = await request(app)
        .post(`/actions/${requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: false });

      expect(rejectRes.status).toBe(200);
      expect(rejectRes.body.approved).toBe(false);

      // DB should be rejected
      const dbRequest = await testPrisma.humanAction.findUnique({
        where: { id: requestId },
      });
      expect(dbRequest!.status).toBe('rejected');

      // Poll should return rejected
      const pollRes = await request(app)
        .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);
      expect(pollRes.body.status).toBe('rejected');
    });

    it('should default TTL to 3600 when not specified', async () => {
      const createRes = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Default TTL test',
          permissions: ['swap'],
        });

      const { requestId } = createRes.body;

      // Approve and check TTL
      const approveRes = await request(app)
        .post(`/actions/${requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      expect(approveRes.body.expiresIn).toBe(3600);
    });

    it('should store pre-computed action in metadata', async () => {
      const createRes = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Swap 0.01 ETH for USDC',
          permissions: ['swap'],
          limits: { swap: 0.01 },
          metadata: {
            action: {
              endpoint: '/swap',
              method: 'POST',
              body: { from: '0x123', amount: '0.01' },
            },
          },
        });

      expect(createRes.status).toBe(200);
      const { requestId } = createRes.body;

      const dbRequest = await testPrisma.humanAction.findUnique({
        where: { id: requestId },
      });
      const metadata = JSON.parse(dbRequest!.metadata!);
      expect(metadata.action).toBeDefined();
      expect(metadata.action.endpoint).toBe('/swap');
      expect(metadata.action.method).toBe('POST');
      expect(metadata.action.body.from).toBe('0x123');
    });

    it('should work without metadata.action (backwards compat)', async () => {
      const createRes = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Simple swap',
          permissions: ['swap'],
        });

      expect(createRes.status).toBe(200);
      const { requestId } = createRes.body;

      const dbRequest = await testPrisma.humanAction.findUnique({
        where: { id: requestId },
      });
      const metadata = JSON.parse(dbRequest!.metadata!);
      expect(metadata.action).toBeUndefined();
    });

    it('should reject summary longer than 500 characters (400)', async () => {
      const longSummary = 'A'.repeat(501);
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: longSummary,
          permissions: ['swap'],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('500');
    });

    it('should accept summary of exactly 500 characters', async () => {
      const maxSummary = 'A'.repeat(500);
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: maxSummary,
          permissions: ['swap'],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should include verifiedSummary in DB metadata', async () => {
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Swap 0.01 ETH for USDC',
          permissions: ['swap'],
          limits: { swap: 0.01 },
          metadata: {
            action: {
              endpoint: '/swap',
              method: 'POST',
              body: { amount: '10000000000000000', token: '0xusdc', direction: 'buy', chain: 'base' },
            },
          },
        });

      expect(res.status).toBe(200);
      const { requestId } = res.body;

      const dbRequest = await testPrisma.humanAction.findUnique({
        where: { id: requestId },
      });
      const metadata = JSON.parse(dbRequest!.metadata!);

      expect(metadata.verifiedSummary).toBeDefined();
      expect(metadata.verifiedSummary.oneLiner).toBeDefined();
      expect(metadata.verifiedSummary.action).toBe('/swap');
      expect(metadata.verifiedSummary.facts.length).toBeGreaterThan(0);
      expect(metadata.verifiedSummary.verified).toBe(true);
      expect(metadata.verifiedSummary.generatedAt).toBeDefined();
    });

    it('should generate verifiedSummary.oneLiner for send actions', async () => {
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Send 0.5 ETH',
          permissions: ['send:hot'],
          metadata: {
            action: {
              endpoint: '/send',
              method: 'POST',
              body: { from: '0xabc', to: '0xdef', amount: '500000000000000000', chain: 'base' },
            },
          },
        });

      expect(res.status).toBe(200);
      const dbRequest = await testPrisma.humanAction.findUnique({
        where: { id: res.body.requestId },
      });
      const metadata = JSON.parse(dbRequest!.metadata!);

      expect(metadata.verifiedSummary.oneLiner).toContain('Send');
      expect(metadata.verifiedSummary.oneLiner).toContain('0.5');
      expect(metadata.verifiedSummary.action).toBe('/send');
    });

    it('should generate verifiedSummary.oneLiner for fund actions', async () => {
      const res = await request(app)
        .post('/actions')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          summary: 'Fund wallet',
          permissions: ['fund'],
          metadata: {
            action: {
              endpoint: '/fund',
              method: 'POST',
              body: { to: '0xabc', amount: '1000000000000000000', chain: 'base' },
            },
          },
        });

      expect(res.status).toBe(200);
      const dbRequest = await testPrisma.humanAction.findUnique({
        where: { id: res.body.requestId },
      });
      const metadata = JSON.parse(dbRequest!.metadata!);

      expect(metadata.verifiedSummary.oneLiner).toContain('Fund');
      expect(metadata.verifiedSummary.oneLiner).toContain('1.0');
      expect(metadata.verifiedSummary.action).toBe('/fund');
    });
  });

  describe('/approve routes are gone (404)', () => {
    it('should return 404 for POST /approve', async () => {
      const res = await request(app)
        .post('/approve')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ agentId: TEST_AGENT_ID, limit: 0.5 });

      expect(res.status).toBe(404);
    });

    it('should return 404 for GET /approve/tokens', async () => {
      const res = await request(app)
        .get('/approve/tokens')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
    });
  });
});
