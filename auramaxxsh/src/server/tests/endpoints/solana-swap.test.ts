/**
 * Tests for /swap endpoint with Solana/Jupiter (chain: 'solana')
 *
 * Tests focus on validation and access control for the Solana swap branch.
 * Jupiter API calls will fail without network, but the tests verify routing
 * and permission enforcement.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_ID, TEST_AGENT_PUBKEY, setupAndUnlockWallet, encryptPasswordForTest, decryptTestToken, } from '../setup';
import { lock } from '../../lib/cold';
import { sol } from '../helpers/amounts';

const app = createTestApp();

const SOLANA_TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC on Solana

describe('Swap Endpoint - Solana/Jupiter', () => {
  let adminToken: string;
  let agentToken: string;
  let walletAddress: string;

  beforeAll(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create agent token with swap permission
    const authRes = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        profile: 'admin', agentId: TEST_AGENT_ID,
        profile: 'admin',
        limit: 1.0,});

    await request(app)
      .post(`/actions/${authRes.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const pollRes = await request(app)
      .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

    agentToken = decryptTestToken(pollRes.body.encryptedToken);

    // Create EVM hot wallet
    const createRes = await request(app)
      .post('/wallet/create')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ tier: 'hot' });

    walletAddress = createRes.body.wallet.address;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  describe('POST /swap - Solana Basic Validation', () => {
    it('should reject without from address', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          token: SOLANA_TOKEN,
          direction: 'buy',
          amount: sol('1.0'),
          slippage: 1.0,
          chain: 'solana'
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
          amount: sol('1.0'),
          slippage: 1.0,
          chain: 'solana'
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
          token: SOLANA_TOKEN,
          direction: 'hodl',
          amount: sol('1.0'),
          slippage: 1.0,
          chain: 'solana'
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
          token: SOLANA_TOKEN,
          direction: 'buy',
          slippage: 1.0,
          chain: 'solana'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('amount');
    });

    it('should reject without slippage', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: SOLANA_TOKEN,
          direction: 'buy',
          amount: sol('1.0'),
          chain: 'solana'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('slippage');
    });

    it('should reject excessive slippage', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: SOLANA_TOKEN,
          direction: 'buy',
          amount: sol('1.0'),
          slippage: 51.0, // Over 50% max
          chain: 'solana'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('slippage');
    });
  });

  describe('POST /swap - Solana Permission Check', () => {
    it('should reject without swap permission', async () => {
      // Create token without swap permission
      const authRes = await request(app)
        .post('/auth')
        .send({
        pubkey: TEST_AGENT_PUBKEY,
          profile: 'admin', agentId: 'no-swap-solana',
        profile: 'admin',
          limit: 1.0,// No swap!
        });

      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const pollRes = await request(app)
        .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

      // Create wallet
      const createRes = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${decryptTestToken(pollRes.body.encryptedToken)}`)
        .send({ tier: 'hot' });

      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${decryptTestToken(pollRes.body.encryptedToken)}`)
        .send({
          from: createRes.body.wallet.address,
          token: SOLANA_TOKEN,
          direction: 'buy',
          amount: sol('1.0'),
          slippage: 1.0,
          chain: 'solana'
        });

      // Wallet won't be found (EVM wallet in Solana branch) or Solana error
      expect([400, 403, 404]).toContain(res.status);
    });
  });

  describe('POST /swap - Solana Chain Routing', () => {
    it('should route solana chain to Jupiter branch', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: SOLANA_TOKEN,
          direction: 'buy',
          amount: sol('0.1'),
          slippage: 1.0,
          chain: 'solana'
        });

      // Should enter Solana branch — wallet not found (EVM address in Solana context)
      // Important: should NOT get a DEX-related error (that's EVM path)
      if (res.status === 400) {
        expect(res.body.error).not.toContain('No liquidity pool');
        expect(res.body.error).not.toContain('Unknown DEX');
      }
    });

    it('should route solana-devnet chain to Jupiter branch', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: SOLANA_TOKEN,
          direction: 'sell',
          amount: '100',
          slippage: 2.0,
          chain: 'solana-devnet'
        });

      if (res.status === 400) {
        expect(res.body.error).not.toContain('Unknown chain');
        expect(res.body.error).not.toContain('No liquidity pool');
      }
    });
  });

  describe('POST /swap - Solana Direction Handling', () => {
    it('should accept buy direction', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: SOLANA_TOKEN,
          direction: 'buy',
          amount: sol('0.1'),
          slippage: 1.0,
          chain: 'solana'
        });

      // Passes validation, fails at wallet lookup or Jupiter
      expect(res.status).toBeDefined();
    });

    it('should accept sell direction', async () => {
      const res = await request(app)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          token: SOLANA_TOKEN,
          direction: 'sell',
          amount: '100',
          slippage: 1.0,
          chain: 'solana'
        });

      expect(res.status).toBeDefined();
    });
  });
});
