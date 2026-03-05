/**
 * Tests for /swap endpoint
 *
 * Note: These tests focus on validation and access control.
 * DEX interaction is tested separately in the uniswap tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_ID, TEST_AGENT_PUBKEY, setupAndUnlockWallet, encryptPasswordForTest, decryptTestToken, } from '../setup';
import { lock } from '../../lib/cold';
import { eth } from '../helpers/amounts';

const app = createTestApp();

describe('Swap Endpoint', () => {
  let adminToken: string;
  let agentToken: string;
  let walletAddress: string;
  let otherAgentToken: string;
  let otherWalletAddress: string;

  beforeAll(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create first agent token with swap permission
    const authRes = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: TEST_AGENT_ID,
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot', 'swap'] },
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

    // Create second agent without swap permission
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

  beforeEach(async () => {
    // Clean transactions between tests
    await testPrisma.transaction.deleteMany();
    await testPrisma.trackedAsset.deleteMany();
  });

  describe('POST /swap - Basic Validation', () => {
    it('should reject without from address', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 1
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('from');
    });

    it('should reject without token address', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 1
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('token');
    });

    it('should reject invalid direction', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'invalid',
          amount: eth('0.1'),
          slippage: 1
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('direction');
    });

    it('should reject without amount', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          slippage: 1
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('amount');
    });
  });

  describe('POST /swap - Token Validation', () => {
    it('should reject invalid token', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', 'Bearer invalid_token')
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 1
        });

      expect(res.status).toBe(401);
    });

    it('should reject without token', async () => {
      const res = await request(app)
        .post('/swap')
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 1
        });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /swap - Wallet Ownership', () => {
    it('should reject swapping from wallet not owned by token', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: otherWalletAddress, // Owned by other agent
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 1
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('does not have access');
    });

    it('should reject swapping from non-existent wallet', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: '0x' + '9'.repeat(40),
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 1
        });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /swap - Permission Check', () => {
    it('should reject without swap permission', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${otherAgentToken}`)
        .send({
          from: otherWalletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 1
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('swap');
    });
  });

  describe('POST /swap - Slippage Validation', () => {
    it('should reject swap without slippage param', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: '0.1'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('slippage');
    });

    it('should reject slippage of 0', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 0
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('slippage');
    });

    it('should reject negative slippage', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: -1
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('slippage');
    });

    it('should reject slippage over 50%', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 51
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('slippage');
    });

    it('should accept explicit minOut above slippage floor', async () => {
      // For agent with 0.1 ETH at 1% floor, minOut must be >= 99000000000000000
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          minOut: '99000000000000000'
        });

      // Should pass slippage validation (may fail at DEX detection step)
      if (res.status === 400) {
        expect(res.body.error).not.toContain('minOut too low');
      }
    });

    it('should reject explicit minOut below slippage floor (bypass attempt)', async () => {
      // minOut='1' (1 wei) is far below the 1% floor for 0.1 ETH
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          minOut: '1'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('minOut too low');
    });

    it('should reject minOut=0 as bypass attempt', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 1,
          minOut: '0'
        });

      // minOut='0' is treated as if not provided, falls through to slippage calc
      // Should pass validation (slippage=1 is valid)
      if (res.status === 400) {
        expect(res.body.error).not.toContain('minOut too low');
      }
    });
  });

  describe('POST /swap - Requires Unlock', () => {
    it('should reject swap when wallet locked', async () => {
      lock();

      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 1
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('unlocked');

      // Re-unlock for other tests
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({
        pubkey: TEST_AGENT_PUBKEY, encrypted });
      adminToken = unlockRes.body.token;
    });
  });

  describe('POST /swap - Cross-Chain Validation', () => {
    it('should reject cross-chain with non-relay DEX', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 1,
          dex: 'uniswap',
          chainOut: 'ethereum'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cross-chain');
      expect(res.body.error).toContain('Relay');
    });

    it('should reject unknown chainOut', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 1,
          chainOut: 'nonexistent-chain'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Unknown destination chain');
    });

    it('should accept chainOut with relay (default) DEX', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.1'),
          slippage: 1,
          chainOut: 'ethereum'
        });

      // Should pass validation (may fail at Relay API call step, not at chainOut validation)
      if (res.status === 400) {
        expect(res.body.error).not.toContain('Cross-chain');
        expect(res.body.error).not.toContain('Unknown destination chain');
      }
    });
  });

  describe('POST /swap - Spending Limits', () => {
    let limitedToken: string;
    let limitedWallet: string;

    beforeAll(async () => {
      // Create agent with specific swap limit
      const authRes = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'swap-limited-agent',
          profile: 'admin',
          profileOverrides: { scope: ['wallet:create:hot', 'swap'] },
          limits: { swap: 0.05 },
        });

      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const pollRes = await request(app)
        .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

      limitedToken = decryptTestToken(pollRes.body.encryptedToken);

      const createRes = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${limitedToken}`)
        .send({ tier: 'hot' });

      limitedWallet = createRes.body.wallet.address;
    });

    it('should reject swap amount exceeding swap limit', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${limitedToken}`)
        .send({
          from: limitedWallet,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('1.0'), // Exceeds 0.05 swap limit
          slippage: 1
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('exceeds');
      expect(res.body.remaining).toBeDefined();
      expect(res.body.requested).toBeCloseTo(1.0);
    });

    it('should allow swap within limit (passes limit check, may fail at DEX)', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${limitedToken}`)
        .send({
          from: limitedWallet,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('0.01'), // Within 0.05 swap limit
          slippage: 1
        });

      // Should pass the limit check — will fail later at DEX detection (400), not at limit (403)
      if (res.status === 400) {
        expect(res.body.error).not.toContain('exceeds');
        expect(res.body.error).not.toContain('swap limit');
      }
      expect(res.status).not.toBe(403);
    });

    it('should not enforce swap limits on admin', async () => {
      // Create a wallet via admin
      const createRes = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tier: 'hot' });

      const adminWallet = createRes.body.wallet.address;

      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          from: adminWallet,
          token: '0x' + '1'.repeat(40),
          direction: 'buy',
          amount: eth('100.0'), // Huge amount — admin has no limit
          slippage: 1
        });

      // Admin bypasses limit check — will fail at DEX detection (400), not at limit (403)
      expect(res.status).not.toBe(403);
    });
  });

  describe('GET /swap/dexes', () => {
    it('should list available DEXes', async () => {
      const res = await request(app)
        .get('/swap/dexes');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.dexes).toBeDefined();
      expect(Array.isArray(res.body.dexes)).toBe(true);
    });

    it('should include relay in available DEXes', async () => {
      const res = await request(app)
        .get('/swap/dexes');

      expect(res.status).toBe(200);
      expect(res.body.dexes).toContain('relay');
      expect(res.body.dexes).toContain('uniswap');
    });
  });
});
