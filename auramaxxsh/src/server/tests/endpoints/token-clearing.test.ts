/**
 * Tests for in-memory token escrow (P0 #5)
 *
 * When an agent polls GET /auth/:requestId after approval, the server returns
 * the token from an in-memory escrow and deletes it. The raw token is NEVER
 * stored in the database — only a tokenHash is persisted for audit/display.
 *
 * Flow:
 *   1. POST /auth          -> creates pending request, returns requestId + secret
 *   2. POST /actions/:id/resolve -> admin approves, token escrowed in memory, tokenHash in DB
 *   3. GET /auth/:id       -> first retrieval claims token from escrow
 *   4. GET /auth/:id       -> second retrieval returns 410 (already claimed)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_ID, TEST_AGENT_PUBKEY, setupAndUnlockWallet, wait, decryptTestToken } from '../setup';

const app = createTestApp();

describe('In-Memory Token Escrow (P0 #5)', () => {
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
    // Clean pending requests between tests
    await testPrisma.notification.deleteMany();
    await testPrisma.humanAction.deleteMany();
  });

  /**
   * Helper: creates an auth request, approves it, and returns the
   * requestId, secret, and admin-visible token from the approve response.
   */
  async function createAndApproveAuthRequest(agentId: string = TEST_AGENT_ID) {
    // Step 1: Agent requests auth
    const authRes = await request(app)
      .post('/auth')
      .send({
        agentId,
        limit: 0.5,
        profile: 'admin',
        pubkey: TEST_AGENT_PUBKEY,
      });

    expect(authRes.status).toBe(200);
    expect(authRes.body.requestId).toBeDefined();
    expect(authRes.body.secret).toBeDefined();

    const { requestId, secret } = authRes.body;

    // Step 2: Admin approves
    const approveRes = await request(app)
      .post(`/actions/${requestId}/resolve`)
      .send({ approved: true })
      .set('Authorization', `Bearer ${adminToken}`);

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);
    expect(approveRes.body.token).toBeDefined();

    return { requestId, secret, approveToken: approveRes.body.token };
  }

  describe('First retrieval returns token', () => {
    it('should return the signed token on first GET /auth/:id after approval', async () => {
      const { requestId, secret } = await createAndApproveAuthRequest();

      const res = await request(app)
        .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
      expect(res.body.encryptedToken).toBeDefined();
      const token = decryptTestToken(res.body.encryptedToken);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(50); // JWT is long
      expect(res.body.agentId).toBe(TEST_AGENT_ID);
      expect(res.body.limit).toBe(0.5);
    });
  });

  describe('Token never stored in DB metadata', () => {
    it('should store tokenHash (not raw token) in DB metadata after approval', async () => {
      const { requestId } = await createAndApproveAuthRequest();

      // Verify raw token is NOT in DB — only tokenHash
      const dbRecord = await testPrisma.humanAction.findUnique({
        where: { id: requestId }
      });
      const metadataBefore = JSON.parse(dbRecord!.metadata!);
      expect(metadataBefore.token).toBeUndefined();
      expect(metadataBefore.tokenHash).toBeDefined();
      expect(typeof metadataBefore.tokenHash).toBe('string');
    });
  });

  describe('Second retrieval returns 410', () => {
    it('should return 410 error on second GET /auth/:id since token was already claimed', async () => {
      const { requestId, secret } = await createAndApproveAuthRequest();

      // First retrieval - gets the token
      const firstRes = await request(app)
        .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);
      expect(firstRes.status).toBe(200);
      expect(firstRes.body.encryptedToken).toBeDefined();

      // Second retrieval - token already claimed from escrow
      const secondRes = await request(app)
        .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);

      expect(secondRes.status).toBe(410);
      expect(secondRes.body.error).toContain('Token already claimed or expired');
    });

    it('should not leak token on repeated polling attempts', async () => {
      const { requestId, secret } = await createAndApproveAuthRequest('leak-test-agent');

      // First retrieval
      const firstRes = await request(app)
        .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);
      expect(firstRes.status).toBe(200);
      const retrievedToken = decryptTestToken(firstRes.body.encryptedToken);
      expect(retrievedToken).toBeDefined();

      // Multiple subsequent attempts should all fail with 410
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);

        expect(res.status).toBe(410);
        expect(res.body.error).toContain('Token already claimed or expired');
        // The response must never include the token
        expect(res.body.encryptedToken).toBeUndefined();
      }
    });
  });

  describe('Token returned on first retrieval is valid', () => {
    it('should return a token that can be used for authenticated requests', async () => {
      const { requestId, secret } = await createAndApproveAuthRequest('auth-valid-agent');

      // Retrieve token
      const res = await request(app)
        .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);
      expect(res.status).toBe(200);

      const token = decryptTestToken(res.body.encryptedToken);
      expect(token).toBeDefined();

      // Use the token to make an authenticated request (list wallets)
      // The /wallets endpoint returns { wallets, unlocked } (no success field)
      const walletsRes = await request(app)
        .get('/wallets')
        .set('Authorization', `Bearer ${token}`);

      expect(walletsRes.status).toBe(200);
      expect(walletsRes.body.wallets).toBeDefined();
      expect(Array.isArray(walletsRes.body.wallets)).toBe(true);
    });
  });

  describe('Secret still required after token claiming', () => {
    it('should still reject requests without correct secret after token is claimed', async () => {
      const { requestId, secret } = await createAndApproveAuthRequest('secret-test-agent');

      // First retrieval with correct secret
      const firstRes = await request(app)
        .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);
      expect(firstRes.status).toBe(200);
      expect(firstRes.body.encryptedToken).toBeDefined();

      // Try with wrong secret - should get 403, not 410
      const wrongSecretRes = await request(app)
        .get(`/auth/${requestId}`).set('x-aura-claim-secret', 'wrongsecret');
      expect(wrongSecretRes.status).toBe(403);
      expect(wrongSecretRes.body.error).toContain('Invalid secret');

      // Try without secret - should get 400
      const noSecretRes = await request(app)
        .get(`/auth/${requestId}`);
      expect(noSecretRes.status).toBe(400);
      expect(noSecretRes.body.error).toContain('secret');
    });
  });

  describe('Approval metadata preserved after claiming', () => {
    it('should preserve non-token metadata fields in the DB', async () => {
      const { requestId, secret } = await createAndApproveAuthRequest('metadata-test-agent');

      // Retrieve token (claims from escrow)
      await request(app)
        .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);

      // Check DB directly
      const dbRecord = await testPrisma.humanAction.findUnique({
        where: { id: requestId }
      });

      expect(dbRecord).not.toBeNull();
      expect(dbRecord!.status).toBe('approved');

      const metadata = JSON.parse(dbRecord!.metadata!);

      // Raw token should never have been in DB
      expect(metadata.token).toBeUndefined();

      // tokenHash should be present for audit/display
      expect(metadata.tokenHash).toBeDefined();
      expect(typeof metadata.tokenHash).toBe('string');

      // These should all still be present for audit/display purposes
      expect(metadata.agentId).toBe('metadata-test-agent');
      expect(metadata.limit).toBe(0.5);
      expect(Array.isArray(metadata.permissions)).toBe(true);
      expect(metadata.permissions).toEqual(expect.arrayContaining(['wallet:create:hot', 'send:hot']));
      expect(metadata.secretHash).toBeDefined();
      expect(typeof metadata.secretHash).toBe('string');
    });
  });
});
