/**
 * Tests for /auth endpoint
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import * as credentialTransport from '../../lib/credential-transport';
import { createTestApp, cleanDatabase, testPrisma, TEST_AGENT_ID, setupAndUnlockWallet } from '../setup';
import * as authLib from '../../lib/auth';

const app = createTestApp();
const { publicKey: AUTH_TEST_PUBKEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const AUTH_TEST_PUBKEY = Buffer.from(AUTH_TEST_PUBKEY_PEM, 'utf8').toString('base64');

describe('Auth Endpoints', () => {
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

  describe('POST /auth - Request Token', () => {
    it('should reject request without agentId', async () => {
      const res = await request(app)
        .post('/auth')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('agentId');
    });

    it('should create auth request and return requestId and secret', async () => {
      const res = await request(app)
        .post('/auth')
        .send({
          agentId: TEST_AGENT_ID,
          profile: 'dev',
          limit: 0.5,
          pubkey: AUTH_TEST_PUBKEY,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.requestId).toBeDefined();
      expect(res.body.reqId).toBe(res.body.requestId);
      expect(res.body.secret).toBeDefined();
      expect(res.body.secret.length).toBe(64); // 32 bytes hex = 64 chars
      expect(res.body.message).toContain('approval');
      expect(res.body.agentId).toBe(TEST_AGENT_ID);
      expect(res.body.limit).toBe(0.5);
      expect(res.body.requiresHumanApproval).toBe(true);
      expect(res.body.approvalScope).toBe('session_token');
      expect(res.body.claimStatus).toBe('pending');
      expect(res.body.retryReady).toBe(false);
      expect(res.body.claimAction).toMatchObject({
        transport: 'http',
        kind: 'request',
        method: 'GET',
      });
      expect(res.body.retryAction).toMatchObject({
        transport: 'http',
        kind: 'request',
        method: 'POST',
        args: { reqId: res.body.requestId },
      });
      expect(Array.isArray(res.body.instructions)).toBe(true);
      expect(res.body.instructions.length).toBeGreaterThan(0);
      expect(res.body.policyHash).toBe(res.body.effectivePolicyHash);
      expect(res.body.compilerVersion).toBe('profile.v1');
    });

    it('should derive request limit from limits.fund when provided', async () => {
      const res = await request(app)
        .post('/auth')
        .send({
          agentId: TEST_AGENT_ID,
          profile: 'dev',
          limits: { fund: 1.75, send: 0.25 },
          pubkey: AUTH_TEST_PUBKEY,
        });

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(1.75);
      expect(res.body.requestedLimitExplicit).toBe(true);
      expect(res.body.limits.fund).toBe(1.75);
      expect(res.body.limits.send).toBe(0.25);

      const created = await testPrisma.humanAction.findUnique({
        where: { id: res.body.requestId },
      });
      expect(created).toBeTruthy();

      const metadata = JSON.parse(created!.metadata || '{}');
      expect(metadata.limit).toBe(1.75);
      expect(metadata.requestedLimitExplicit).toBe(true);
      expect(metadata.limits.fund).toBe(1.75);
      expect(metadata.summary).toContain('1.75 ETH access');
    });

    it('should reject request when profile is missing', async () => {
      const res = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, pubkey: AUTH_TEST_PUBKEY });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AGENT_PROFILE_REQUIRED');
    });

    it('should reject raw permission issuance payloads', async () => {
      const res = await request(app)
        .post('/auth')
        .send({
          agentId: TEST_AGENT_ID,
          profile: 'dev',
          permissions: ['secret:read'],
          pubkey: AUTH_TEST_PUBKEY,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AGENT_PROFILE_ONLY');
    });

    it('should use profile defaults when optional values are omitted', async () => {
      const res = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      expect(res.status).toBe(200);
      expect(res.body.permissions).toContain('wallet:list');
      expect(res.body.permissions).toContain('secret:read');
      expect(res.body.ttl).toBe(604800);
    });

    it('should create notification for pending request', async () => {
      await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      const notifications = await testPrisma.notification.findMany({
        where: { type: 'pending_approval' }
      });

      expect(notifications.length).toBe(1);
      expect(notifications[0].title).toContain('Auth');
    });

    it('should require pubkey for token requests', async () => {
      const res = await request(app)
        .post('/auth')
        .send({
          agentId: TEST_AGENT_ID,
          profile: 'dev',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('pubkey');
    });

    it('should accept pubkey with explicit secret:read permission', async () => {
      const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const res = await request(app)
        .post('/auth')
        .send({
          agentId: TEST_AGENT_ID,
          profile: 'strict',
          pubkey: Buffer.from(publicKey, 'utf8').toString('base64'),
        });

      expect(res.status).toBe(200);
      expect(res.body.permissions).toContain('secret:read');
    });

    it('should resolve profile-based auth requests with deterministic metadata', async () => {
      const res = await request(app)
        .post('/auth')
        .send({
          agentId: TEST_AGENT_ID,
          profile: 'strict',
          profileVersion: 'v1',
          profileOverrides: { ttlSeconds: 600, maxReads: 25 },
          pubkey: AUTH_TEST_PUBKEY,
        });

      expect(res.status).toBe(200);
      expect(res.body.permissions).toContain('secret:read');
      expect(res.body.profile).toEqual(expect.objectContaining({ id: 'strict', version: 'v1' }));
      expect(res.body.effectivePolicyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(res.body.overrideDelta).toEqual(['maxReads', 'ttlSeconds']);
      expect(res.body.credentialAccess.maxReads).toBe(25);
      expect(res.body.ttl).toBe(600);
    });
  });

  describe('GET /auth/:requestId - Poll for Token', () => {
    it('should reject without secret', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      const res = await request(app)
        .get(`/auth/${authRes.body.requestId}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('secret');
    });

    it('should accept x-aura-claim-secret header', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      const res = await request(app)
        .get(`/auth/${authRes.body.requestId}`)
        .set('x-aura-claim-secret', authRes.body.secret);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.headers['preference-applied']).toBe('x-aura-claim-secret');
      expect(res.headers.deprecation).toBeUndefined();
    });

    it('should prefer header secret over query secret when both are provided', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      const res = await request(app)
        .get(`/auth/${authRes.body.requestId}?secret=wrongsecret`)
        .set('x-aura-claim-secret', authRes.body.secret);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.headers['preference-applied']).toBe('x-aura-claim-secret');
      expect(res.headers.deprecation).toBeUndefined();
    });

    it('should allow query fallback with deprecation headers', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      const res = await request(app)
        .get(`/auth/${authRes.body.requestId}?secret=${authRes.body.secret}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.headers.deprecation).toBe('true');
      expect(res.headers.sunset).toBe('Tue, 30 Jun 2026 00:00:00 GMT');
      expect(res.headers['preference-applied']).toBe('x-aura-claim-secret; fallback=secret');
    });

    it('should reject with wrong secret', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      const res = await request(app)
        .get(`/auth/${authRes.body.requestId}?secret=wrongsecret`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Invalid secret');
    });

    it('should return pending status before approval', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      const res = await request(app)
        .get(`/auth/${authRes.body.requestId}?secret=${authRes.body.secret}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.body.reqId).toBe(authRes.body.requestId);
      expect(res.body.claimStatus).toBe('pending');
      expect(res.body.retryReady).toBe(false);
      expect(res.body.claimAction).toMatchObject({
        transport: 'http',
        kind: 'request',
        method: 'GET',
      });
      expect(res.body.retryAction).toMatchObject({
        transport: 'http',
        kind: 'request',
        method: 'POST',
        args: { reqId: authRes.body.requestId },
      });
    });

    it('should return token after approval', async () => {
      // Create auth request
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, limit: 0.5, profile: 'strict', pubkey: AUTH_TEST_PUBKEY });

      // Approve with admin token
      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      // Poll for token
      const res = await request(app)
        .get(`/auth/${authRes.body.requestId}?secret=${authRes.body.secret}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
      expect(res.body.encryptedToken).toBeDefined();
      expect(res.body.encryptedToken.length).toBeGreaterThan(50);
      expect(res.body.token).toBeUndefined();
      expect(res.body.agentId).toBe(TEST_AGENT_ID);
      expect(res.body.limit).toBe(0.5);
      expect(res.body.ttl).toBe(3600);
      expect(res.body.profile).toEqual(expect.objectContaining({ id: 'strict', version: 'v1' }));
      expect(res.body.effectivePolicyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(res.body.policyHash).toBe(res.body.effectivePolicyHash);
      expect(res.body.compilerVersion).toBe('profile.v1');
    });

    it('should include exact retryCommand derived from stored original command', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'strict', pubkey: AUTH_TEST_PUBKEY });

      const created = await testPrisma.humanAction.findUnique({
        where: { id: authRes.body.requestId },
      });
      expect(created).toBeTruthy();

      const metadata = JSON.parse(created!.metadata || '{}');
      metadata.originalCommand = 'npx auramaxx get github';
      await testPrisma.humanAction.update({
        where: { id: authRes.body.requestId },
        data: { metadata: JSON.stringify(metadata) },
      });

      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const claim = await request(app)
        .get(`/auth/${authRes.body.requestId}?secret=${authRes.body.secret}`);

      expect(claim.status).toBe(200);
      expect(claim.body.status).toBe('approved');
      expect(claim.body.retryCommand).toBe(`npx auramaxx get github --reqId ${authRes.body.requestId}`);
      expect(Array.isArray(claim.body.instructions)).toBe(true);
      expect(claim.body.instructions[0]).toBe(
        `Run this exact command now: npx auramaxx get github --reqId ${authRes.body.requestId}`,
      );
    });

    it('should allow only one successful claim when claimed concurrently', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const [claimA, claimB] = await Promise.all([
        request(app).get(`/auth/${authRes.body.requestId}?secret=${authRes.body.secret}`),
        request(app).get(`/auth/${authRes.body.requestId}?secret=${authRes.body.secret}`),
      ]);

      const statuses = [claimA.status, claimB.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 410]);

      const approved = claimA.status === 200 ? claimA : claimB;
      const expired = claimA.status === 410 ? claimA : claimB;
      expect(approved.body.status).toBe('approved');
      expect(typeof approved.body.encryptedToken).toBe('string');
      expect(expired.body.errorCode).toBe('missing_or_expired_claim');
    });

    it('should keep escrowed token claimable when delivery encryption fails', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const realEncrypt = credentialTransport.encryptToAgentPubkey;
      const encryptSpy = vi.spyOn(credentialTransport, 'encryptToAgentPubkey')
        .mockImplementationOnce(() => {
          throw new Error('simulated encryption failure');
        })
        .mockImplementation((token, pubkey) => realEncrypt(token, pubkey));

      const failedClaim = await request(app)
        .get(`/auth/${authRes.body.requestId}?secret=${authRes.body.secret}`);
      expect(failedClaim.status).toBe(500);
      expect(failedClaim.body.error).toContain('Failed to encrypt token for delivery');

      const retryClaim = await request(app)
        .get(`/auth/${authRes.body.requestId}?secret=${authRes.body.secret}`);
      expect(retryClaim.status).toBe(200);
      expect(retryClaim.body.status).toBe('approved');
      expect(typeof retryClaim.body.encryptedToken).toBe('string');

      encryptSpy.mockRestore();
    });

    it('should validate pubkey before claiming escrowed token', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const created = await testPrisma.humanAction.findUnique({
        where: { id: authRes.body.requestId },
      });
      expect(created).toBeTruthy();

      const metadata = JSON.parse(created!.metadata || '{}');
      delete metadata.pubkey;
      await testPrisma.humanAction.update({
        where: { id: authRes.body.requestId },
        data: { metadata: JSON.stringify(metadata) },
      });

      const claimSpy = vi.spyOn(authLib, 'claimEscrowedToken');

      const missingPubkeyClaim = await request(app)
        .get(`/auth/${authRes.body.requestId}?secret=${authRes.body.secret}`);
      expect(missingPubkeyClaim.status).toBe(500);
      expect(missingPubkeyClaim.body.error).toContain('No pubkey available');
      expect(claimSpy).not.toHaveBeenCalled();

      claimSpy.mockRestore();
    });

    it('should return deterministic expired-claim payload when token is already consumed', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const firstClaim = await request(app)
        .get(`/auth/${authRes.body.requestId}?secret=${authRes.body.secret}`);
      expect(firstClaim.status).toBe(200);
      expect(firstClaim.body.status).toBe('approved');
      expect(typeof firstClaim.body.encryptedToken).toBe('string');

      const secondClaim = await request(app)
        .get(`/auth/${authRes.body.requestId}?secret=${authRes.body.secret}`);
      expect(secondClaim.status).toBe(410);
      expect(secondClaim.body.errorCode).toBe('missing_or_expired_claim');
      expect(secondClaim.body.reqId).toBe(authRes.body.requestId);
      expect(secondClaim.body.requestId).toBe(authRes.body.requestId);
      expect(secondClaim.body.claimStatus).toBe('expired');
      expect(secondClaim.body.retryReady).toBe(false);
      expect(secondClaim.body.requiresHumanApproval).toBe(false);
      expect(secondClaim.body.claimAction).toMatchObject({
        transport: 'http',
        kind: 'request',
        method: 'GET',
      });
      expect(secondClaim.body.retryAction).toMatchObject({
        transport: 'http',
        kind: 'request',
        method: 'POST',
        args: { reqId: authRes.body.requestId },
      });
      expect(Array.isArray(secondClaim.body.instructions)).toBe(true);
      expect(secondClaim.body.instructions.length).toBeGreaterThan(0);
      expect(secondClaim.body.policyHash).toBeDefined();
      expect(secondClaim.body.compilerVersion).toBeDefined();
    });

    it('should return rejected status after rejection', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      // Reject with admin token
      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: false });

      const res = await request(app)
        .get(`/auth/${authRes.body.requestId}?secret=${authRes.body.secret}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
    });

    it('should return 404 for non-existent request', async () => {
      const res = await request(app)
        .get('/auth/nonexistent?secret=somesecret');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /auth/pending - List Pending Requests', () => {
    it('should return empty array when no pending requests', async () => {
      const res = await request(app).get('/auth/pending');

      expect(res.status).toBe(200);
      expect(res.body.requests).toEqual([]);
    });

    it('should list pending auth requests', async () => {
      await request(app)
        .post('/auth')
        .send({ agentId: 'agent1', profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      await request(app)
        .post('/auth')
        .send({ agentId: 'agent2', profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      const res = await request(app).get('/auth/pending');

      expect(res.status).toBe(200);
      expect(res.body.requests.length).toBe(2);
    });

    it('should not expose secretHash in response', async () => {
      await request(app)
        .post('/auth')
        .send({ agentId: TEST_AGENT_ID, profile: 'dev', pubkey: AUTH_TEST_PUBKEY });

      const res = await request(app).get('/auth/pending');

      expect(res.body.requests[0].metadata.secretHash).toBeUndefined();
    });
  });

});
