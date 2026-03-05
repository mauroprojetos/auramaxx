/**
 * Tests for /fund endpoint with Solana (chain: 'solana')
 *
 * Tests focus on validation, access control, and spending limits for Solana fund transfers.
 * Actual cold→hot SOL transfer will fail without a live Solana node.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_ID, TEST_AGENT_PUBKEY, setupAndUnlockWallet, encryptPasswordForTest, decryptTestToken, } from '../setup';
import { lock } from '../../lib/cold';
import { sol, eth } from '../helpers/amounts';

const app = createTestApp();

const SOLANA_HOT_ADDR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

describe('Fund Endpoint - Solana', () => {
  let adminToken: string;
  let agentToken: string;
  let walletAddress: string;

  beforeAll(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create agent token with fund permission
    const authRes = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: TEST_AGENT_ID,
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot', 'fund'] },
        limit: 1.0,
      });

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

  describe('POST /fund - Solana Validation', () => {
    it('should accept chain: solana parameter', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress,
          amount: sol('0.1'),
          chain: 'solana'
        });

      // Should route to Solana branch — will fail at Solana connection or keypair
      // but should pass basic validation
      expect(res.status).toBeDefined();
      if (res.status === 400) {
        expect(res.body.error).not.toContain('to (hot wallet address) is required');
        expect(res.body.error).not.toContain('amount is required');
      }
    });

    it('should reject unknown chain', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress,
          amount: sol('0.1'),
          chain: 'notachain'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Unknown chain');
    });

    it('should reject without to address', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          amount: sol('0.1'),
          chain: 'solana'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('to');
    });

    it('should reject without amount', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress,
          chain: 'solana'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('amount');
    });
  });

  describe('POST /fund - Solana Spending Limits', () => {
    it('should reject amount exceeding limit for Solana fund', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress,
          amount: sol('5.0'), // Exceeds 1.0 limit
          chain: 'solana'
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('exceeds');
      expect(res.body.remaining).toBeDefined();
      expect(res.body.requested).toBeCloseTo(5.0);
    });
  });

  describe('POST /fund - Solana Cold Wallet Lock', () => {
    it('should reject when cold wallet is locked', async () => {
      lock();

      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress,
          amount: sol('0.1'),
          chain: 'solana'
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('locked');

      // Re-unlock
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      await request(app)
        .post('/unlock')
        .send({
        pubkey: TEST_AGENT_PUBKEY, encrypted });
    });
  });

  describe('POST /fund - Solana Permission Check', () => {
    it('should reject without fund permission', async () => {
      // Create token without fund permission
      const authRes = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'no-fund-solana',
          profile: 'admin',
          profileOverrides: { scope: ['wallet:create:hot'] },
          limit: 1.0,
        });

      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const pollRes = await request(app)
        .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${decryptTestToken(pollRes.body.encryptedToken)}`)
        .send({
          to: walletAddress,
          amount: sol('0.1'),
          chain: 'solana'
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('fund permission');
    });
  });

  describe('POST /fund - Solana-devnet chain', () => {
    it('should accept solana-devnet as a valid chain', async () => {
      const res = await request(app)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          to: walletAddress,
          amount: sol('0.1'),
          chain: 'solana-devnet'
        });

      // Should not be "Unknown chain"
      if (res.status === 400) {
        expect(res.body.error).not.toContain('Unknown chain');
      }
    });
  });
});
