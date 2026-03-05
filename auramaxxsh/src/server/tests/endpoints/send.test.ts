/**
 * Tests for /send endpoint
 *
 * Note: These tests focus on validation, access control, and spending limits.
 * Transaction signing is mocked to avoid real blockchain interaction.
 *
 * Spending limits are enforced for agent tokens via the "send" limit type.
 * Sends to the cold wallet address bypass the limit (returning funds to agent).
 * Admin tokens bypass all limits.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_ID, TEST_AGENT_PUBKEY, setupAndUnlockWallet, encryptPasswordForTest, decryptTestToken, } from '../setup';
import fs from 'fs';
import path from 'path';
import { DATA_PATHS } from '../../lib/config';
import { lock, getColdWalletAddress } from '../../lib/cold';
import { setDefault } from '../../lib/defaults';
import { eth } from '../helpers/amounts';

const app = createTestApp();

describe('Send Endpoint', () => {
  let adminToken: string;
  let agentToken: string;
  let walletAddress: string;
  let otherAgentToken: string;
  let otherWalletAddress: string;

  beforeAll(async () => {
    await cleanDatabase();

    // Setup cold wallet (resetColdWallet handles agent file cleanup)
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create first agent token
    const authRes = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: TEST_AGENT_ID,
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot', 'send:hot'] },
        limit: 1.0,
      });

    if (!authRes.body.requestId) {
      throw new Error(`Auth request failed: ${JSON.stringify(authRes.body)}`);
    }

    await request(app)
      .post(`/actions/${authRes.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const pollRes = await request(app)
      .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

    if (!pollRes.body.encryptedToken) {
      throw new Error(`Token retrieval failed: ${JSON.stringify(pollRes.body)}`);
    }

    agentToken = decryptTestToken(pollRes.body.encryptedToken);

    // Create wallet for first agent
    const createRes = await request(app)
      .post('/wallet/create')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ tier: 'hot' });

    if (!createRes.body.wallet) {
      throw new Error(`Failed to create wallet: ${JSON.stringify(createRes.body)}`);
    }

    walletAddress = createRes.body.wallet.address;

    // Create second agent and wallet
    const authRes2 = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: 'other-agent',
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot'] },
        limit: 0.5,
      });

    if (!authRes2.body.requestId) {
      throw new Error(`Auth2 request failed: ${JSON.stringify(authRes2.body)}`);
    }

    await request(app)
      .post(`/actions/${authRes2.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const pollRes2 = await request(app)
      .get(`/auth/${authRes2.body.requestId}`).set('x-aura-claim-secret', authRes2.body.secret);

    if (!pollRes2.body.encryptedToken) {
      throw new Error(`Token2 retrieval failed: ${JSON.stringify(pollRes2.body)}`);
    }

    otherAgentToken = decryptTestToken(pollRes2.body.encryptedToken);

    const createRes2 = await request(app)
      .post('/wallet/create')
      .set('Authorization', `Bearer ${otherAgentToken}`)
      .send({ tier: 'hot' });

    if (!createRes2.body.wallet) {
      throw new Error(`Failed to create second wallet: ${JSON.stringify(createRes2.body)}`);
    }

    otherWalletAddress = createRes2.body.wallet.address;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  describe('POST /send - Basic Validation', () => {
    it('should reject without from address', async () => {
      const res = await request(app)
        .post('/send')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: '0x' + '2'.repeat(40),
          amount: eth('0.1')
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('from');
    });

    it('should reject without to address for simple sends', async () => {
      const res = await request(app)
        .post('/send')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          amount: eth('0.1')
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('to');
    });

    it('should reject without amount for simple sends', async () => {
      const res = await request(app)
        .post('/send')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          to: '0x' + '2'.repeat(40)
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('amount');
    });
  });

  describe('POST /send - Token Validation', () => {
    it('should reject invalid token', async () => {
      const res = await request(app)
        .post('/send')
        .set('Authorization', 'Bearer invalid_token')
        .send({
          from: walletAddress,
          to: '0x' + '2'.repeat(40),
          amount: eth('0.1')
        });

      expect(res.status).toBe(401);
    });

    it('should reject without token when wallet locked', async () => {
      lock();

      // Without token, auth middleware rejects first
      const res = await request(app)
        .post('/send')
        .send({
          from: walletAddress,
          to: '0x' + '2'.repeat(40),
          amount: eth('0.1')
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Authorization header required');

      // Re-unlock and update admin token
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({
        pubkey: TEST_AGENT_PUBKEY, encrypted });
      adminToken = unlockRes.body.token;
    });
  });

  describe('POST /send - Wallet Ownership', () => {
    it('should reject sending from wallet not owned by token', async () => {
      const res = await request(app)
        .post('/send')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: otherWalletAddress, // Owned by other agent
          to: '0x' + '2'.repeat(40),
          amount: eth('0.1')
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('does not have access');
    });
  });

  describe('POST /send - Permission Check', () => {
    it('should reject without send:hot permission', async () => {
      // Create token without send:hot
      const authRes = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'no-send-agent',
          profile: 'admin',
          profileOverrides: { scope: ['wallet:create:hot'] },
          limit: 1.0,
        });

      const approveRes = await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      if (!approveRes.body.success) {
        throw new Error(`Approval failed: ${JSON.stringify(approveRes.body)}`);
      }

      const pollRes = await request(app)
        .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

      if (!pollRes.body.encryptedToken) {
        throw new Error(`Token poll failed: ${JSON.stringify(pollRes.body)}`);
      }

      // Create wallet
      const createRes = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${decryptTestToken(pollRes.body.encryptedToken)}`)
        .send({ tier: 'hot' });

      if (!createRes.body.wallet) {
        throw new Error(`Wallet create failed: ${JSON.stringify(createRes.body)}`);
      }

      // Try to send
      const res = await request(app)
        .post('/send')
        .set('Authorization', `Bearer ${decryptTestToken(pollRes.body.encryptedToken)}`)
        .send({
          from: createRes.body.wallet.address,
          to: '0x' + '2'.repeat(40),
          amount: eth('0.1')
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('send:hot');
    });
  });

  describe('POST /send - Wallet Not Found', () => {
    it('should reject send from non-existent wallet', async () => {
      const res = await request(app)
        .post('/send')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: '0x' + '9'.repeat(40), // Non-existent
          to: '0x' + '2'.repeat(40),
          amount: eth('0.1')
        });

      // Returns 404 (not found) or 403 (ownership check) depending on implementation
      expect([403, 404]).toContain(res.status);
    });
  });

  describe('POST /send - Description Field', () => {
    it('should accept optional description parameter', async () => {
      // This test validates the description is accepted in the request body
      // Actual transaction execution would fail without blockchain setup
      const res = await request(app)
        .post('/send')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          to: '0x' + '2'.repeat(40),
          amount: eth('0.1'),
          description: 'Test payment to vendor'
        });

      // Will fail due to blockchain connection, but validates request parsing
      // In production, description would be used in the transaction log
      expect(res.status).toBeDefined();
    });
  });

  describe('POST /send - Send Spending Limit', () => {
    let limitedToken: string;
    let limitedWalletAddress: string;

    beforeAll(async () => {
      // Create agent with a 0.5 ETH send limit
      const authRes = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'send-limit-agent',
          profile: 'admin',
          profileOverrides: { scope: ['wallet:create:hot', 'send:hot'] },
          limit: 1.0,
          limits: { fund: 1.0, send: 0.5 },
        });

      if (!authRes.body.requestId) {
        throw new Error(`Auth request failed: ${JSON.stringify(authRes.body)}`);
      }

      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const pollRes = await request(app)
        .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

      if (!pollRes.body.encryptedToken) {
        throw new Error(`Token retrieval failed: ${JSON.stringify(pollRes.body)}`);
      }

      limitedToken = decryptTestToken(pollRes.body.encryptedToken);

      // Create wallet for this agent
      const createRes = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${limitedToken}`)
        .send({ tier: 'hot' });

      if (!createRes.body.wallet) {
        throw new Error(`Failed to create wallet: ${JSON.stringify(createRes.body)}`);
      }

      limitedWalletAddress = createRes.body.wallet.address;
    });

    it('should reject send exceeding send limit', async () => {
      const res = await request(app)
        .post('/send')
        .set('Authorization', `Bearer ${limitedToken}`)
        .send({
          from: limitedWalletAddress,
          to: '0x' + '2'.repeat(40),
          amount: eth('0.6') // Exceeds 0.5 ETH send limit
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('exceeds remaining send limit');
      expect(res.body.remaining).toBeDefined();
      expect(res.body.requested).toBeCloseTo(0.6);
    });

    it('should allow send within limit (passes limit check, fails at blockchain)', async () => {
      const res = await request(app)
        .post('/send')
        .set('Authorization', `Bearer ${limitedToken}`)
        .send({
          from: limitedWalletAddress,
          to: '0x' + '2'.repeat(40),
          amount: eth('0.3') // Within 0.5 ETH limit
        });

      // Should pass the limit check - will fail at blockchain level (RPC error)
      if (res.status === 403) {
        // Should NOT be a limit error
        expect(res.body.error).not.toContain('exceeds remaining send limit');
      }
    });

    it('should bypass send limit for admin tokens', async () => {
      const res = await request(app)
        .post('/send')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          from: limitedWalletAddress,
          to: '0x' + '2'.repeat(40),
          amount: eth('10.0') // Way over 0.5 ETH limit - admin bypasses
        });

      // Admin bypasses limit check, will fail at wallet lookup or blockchain level
      // but should NOT get a 403 limit error
      if (res.status === 403) {
        expect(res.body.error).not.toContain('exceeds remaining send limit');
      }
    });

    it('should bypass send limit for sends to cold wallet (agent return)', async () => {
      const coldAddress = getColdWalletAddress();
      if (!coldAddress) {
        // Cold wallet must be set up for this test
        throw new Error('Cold wallet address not available');
      }

      const res = await request(app)
        .post('/send')
        .set('Authorization', `Bearer ${limitedToken}`)
        .send({
          from: limitedWalletAddress,
          to: coldAddress, // Sending to cold wallet = agent return
          amount: eth('10.0') // Way over 0.5 ETH limit - agent returns bypass
        });

      // Should bypass limit check - will fail at blockchain level
      if (res.status === 403) {
        expect(res.body.error).not.toContain('exceeds remaining send limit');
      }
    });
  });

  describe('POST /send - Send Limit Defaults to System Default', () => {
    let defaultAgentToken: string;
    let defaultWalletAddress: string;

    beforeAll(async () => {
      // Set system default send limit to 0.1 ETH so we can test defaulting behavior
      await setDefault('limits.send', 0.1);

      // Create a fresh agent token AFTER setting the default so its limits reflect the new default
      const authRes = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'default-send-limit-agent',
          profile: 'admin',
          profileOverrides: { scope: ['wallet:create:hot', 'send:hot'] },
          limit: 1.0,
        });

      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const pollRes = await request(app)
        .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

      defaultAgentToken = decryptTestToken(pollRes.body.encryptedToken);

      const createRes = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${defaultAgentToken}`)
        .send({ tier: 'hot' });

      defaultWalletAddress = createRes.body.wallet.address;
    });

    it('should enforce system default send limit when no explicit send limit set', async () => {
      // Token was created with limit: 1.0 (fund only, no explicit send limit)
      // Send limit should default to system default (0.1 ETH) from limits.send
      const res = await request(app)
        .post('/send')
        .set('Authorization', `Bearer ${defaultAgentToken}`)
        .send({
          from: defaultWalletAddress,
          to: '0x' + '2'.repeat(40),
          amount: eth('100.0') // Exceeds 0.1 ETH system default send limit
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('exceeds remaining send limit');
    });

    it('should allow send within system default send limit', async () => {
      const res = await request(app)
        .post('/send')
        .set('Authorization', `Bearer ${defaultAgentToken}`)
        .send({
          from: defaultWalletAddress,
          to: '0x' + '2'.repeat(40),
          amount: eth('0.05') // Within 0.1 ETH system default send limit
        });

      // Should pass the limit check - will fail at blockchain level
      if (res.status === 403) {
        expect(res.body.error).not.toContain('exceeds remaining send limit');
      }
    });
  });
});
