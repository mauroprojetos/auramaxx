/**
 * Tests for /fund endpoint
 *
 * The /fund endpoint allows agents to transfer funds from the cold wallet
 * to their hot wallet. This executes immediately (no human approval needed)
 * as long as the cold wallet is unlocked and the amount is within the token's limit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_ID, TEST_AGENT_PUBKEY, setupAndUnlockWallet, encryptPasswordForTest, decryptTestToken, } from '../setup';
import { lock } from '../../lib/cold';
import { eth } from '../helpers/amounts';

const app = createTestApp();

describe('Fund Endpoint', () => {
  let adminToken: string;
  let agentToken: string;
  let walletAddress: string;
  let otherAgentToken: string;
  let otherWalletAddress: string;

  beforeAll(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create first agent token with 1.0 ETH limit
    const authRes = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: TEST_AGENT_ID,
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot', 'fund'] },
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
        profileOverrides: { scope: ['wallet:create:hot', 'fund'] },
        limit: 0.5,
      });

    await request(app)
      .post(`/actions/${authRes2.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const pollRes2 = await request(app)
      .get(`/auth/${authRes2.body.requestId}`).set('x-aura-claim-secret', authRes2.body.secret);

    otherAgentToken = decryptTestToken(pollRes2.body.encryptedToken);

    const createRes2 = await request(app)
      .post('/wallet/create')
      .set('Authorization', `Bearer ${otherAgentToken}`)
      .send({ tier: 'hot' });

    otherWalletAddress = createRes2.body.wallet.address;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  describe('POST /fund - Basic Validation', () => {
    it('should reject without bearer token', async () => {
      const res = await request(app)
        .post('/fund')
        .send({
          to: walletAddress,
          amount: eth('0.1')
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Authorization header required');
    });

    it('should reject with invalid token', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', 'Bearer invalid_token')
        .send({
          to: walletAddress,
          amount: eth('0.1')
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid or expired');
    });

    it('should reject without to address', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          amount: eth('0.1')
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('to');
    });

    it('should reject without amount', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('amount');
    });

    it('should reject negative amount', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress,
          amount: '-100000000000000000' // negative wei
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('positive');
    });

    it('should reject zero amount', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress,
          amount: '0'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('positive');
    });
  });

  describe('POST /fund - Wallet Ownership', () => {
    it('should reject funding wallet not owned by token', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: otherWalletAddress, // Owned by other agent
          amount: eth('0.1')
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('does not have access');
    });

    it('should reject funding non-existent wallet', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: '0x' + '9'.repeat(40), // Non-existent
          amount: eth('0.1')
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('does not have access');
    });
  });

  describe('POST /fund - Spending Limits', () => {
    it('should reject amount exceeding remaining limit', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress,
          amount: eth('5.0') // Exceeds 1.0 ETH limit
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('exceeds');
      expect(res.body.remaining).toBeDefined();
      expect(res.body.requested).toBe(5.0);
    });
  });

  describe('POST /fund - Cold Wallet State', () => {
    it('should reject when cold wallet is locked', async () => {
      // Lock the wallet
      lock();

      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress,
          amount: eth('0.1')
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('locked');

      // Re-unlock for other tests
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      await request(app)
        .post('/unlock')
        .send({
        pubkey: TEST_AGENT_PUBKEY, encrypted });
    });
  });

  describe('POST /fund - Chain Configuration', () => {
    it('should reject unknown chain', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress,
          amount: eth('0.1'),
          chain: 'nonexistent'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Unknown chain');
    });
  });

  describe('POST /fund - Amount Formats', () => {
    it('should accept string amounts (passes validation)', async () => {
      // This will fail at the blockchain level but should pass validation
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress,
          amount: eth('0.05')
        });

      // Will fail at blockchain level (400) but error should not be validation-related
      expect(res.status).toBe(400);
      expect(res.body.error).not.toContain('amount is required');
      expect(res.body.error).not.toContain('positive');
    });

    it('should accept numeric amounts (passes validation)', async () => {
      // This will fail at the blockchain level but should pass validation
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress,
          amount: 50000000000000000 // 0.05 ETH in wei (as number)
        });

      // Will fail at blockchain level (400) but error should not be validation-related
      expect(res.status).toBe(400);
      expect(res.body.error).not.toContain('amount is required');
      expect(res.body.error).not.toContain('positive');
    });
  });
});
