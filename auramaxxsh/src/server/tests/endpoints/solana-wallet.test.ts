/**
 * Tests for wallet endpoints with Solana chains
 *
 * Tests:
 * - Creating Solana hot wallets (chain: 'solana')
 * - Creating Solana temp wallets
 * - Listing wallets includes Solana wallets
 * - Chain parameter propagation
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_AGENT_ID, TEST_AGENT_PUBKEY, setupAndUnlockWallet, decryptTestToken, } from '../setup';

const app = createTestApp();

describe('Wallet Endpoints - Solana', () => {
  let adminToken: string;
  let agentToken: string;

  beforeAll(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create agent token
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
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  beforeEach(async () => {
    await testPrisma.hotWallet.deleteMany();
  });

  describe('POST /wallet/create - Solana Hot Wallet', () => {
    it('should create a Solana hot wallet', async () => {
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          tier: 'hot',
          chain: 'solana',
          name: 'Solana Hot'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.wallet).toBeDefined();
      expect(res.body.wallet.chain).toBe('solana');
      expect(res.body.wallet.tier).toBe('hot');
      expect(res.body.wallet.name).toBe('Solana Hot');
      // Solana addresses are base58 (not 0x-prefixed)
      expect(res.body.wallet.address).toBeDefined();
      expect(res.body.wallet.address.startsWith('0x')).toBe(false);
    });

    it('should create a Solana hot wallet with metadata', async () => {
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          tier: 'hot',
          chain: 'solana',
          name: 'Trading Bot SOL',
          color: '#9945FF',
          emoji: '☀️'
        });

      expect(res.status).toBe(200);
      expect(res.body.wallet.name).toBe('Trading Bot SOL');
      expect(res.body.wallet.color).toBe('#9945FF');
      expect(res.body.wallet.emoji).toBe('☀️');
    });

    it('should store Solana wallet in DB with correct chain', async () => {
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          tier: 'hot',
          chain: 'solana'
        });

      const wallet = await testPrisma.hotWallet.findUnique({
        where: { address: res.body.wallet.address }
      });

      expect(wallet).toBeDefined();
      expect(wallet!.chain).toBe('solana');
      // Solana addresses are case-sensitive — should NOT be lowercased
      expect(wallet!.address).toBe(res.body.wallet.address);
    });

    it('should create EVM wallet by default (no chain param)', async () => {
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          tier: 'hot',
          name: 'Default Chain'
        });

      expect(res.status).toBe(200);
      // EVM address starts with 0x
      expect(res.body.wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  describe('POST /wallet/create - Solana Temp Wallet', () => {
    it('should create a Solana temp wallet', async () => {
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          tier: 'temp',
          chain: 'solana'
        });

      expect(res.status).toBe(200);
      expect(res.body.wallet).toBeDefined();
      expect(res.body.wallet.tier).toBe('temp');
      // Should be a base58 address (not 0x-prefixed)
      expect(res.body.wallet.address).toBeDefined();
      expect(res.body.wallet.address.startsWith('0x')).toBe(false);
    });

    it('should create EVM temp wallet by default', async () => {
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'temp' });

      expect(res.status).toBe(200);
      expect(res.body.wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  describe('GET /wallets - Mixed Chain Listing', () => {
    it('should list both EVM and Solana wallets', async () => {
      // Create EVM wallet
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'EVM Wallet' });

      // Create Solana wallet
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', chain: 'solana', name: 'SOL Wallet' });

      const res = await request(app)
        .get('/wallets')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      const hotWallets = res.body.wallets.filter((w: { tier: string }) => w.tier === 'hot');
      expect(hotWallets.length).toBe(2);

      const evmWallet = hotWallets.find((w: { name: string }) => w.name === 'EVM Wallet');
      const solWallet = hotWallets.find((w: { name: string }) => w.name === 'SOL Wallet');

      expect(evmWallet).toBeDefined();
      expect(solWallet).toBeDefined();
      expect(evmWallet.address.startsWith('0x')).toBe(true);
      expect(solWallet.address.startsWith('0x')).toBe(false);
    });

    it('should include chain info in wallet listing', async () => {
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', chain: 'solana', name: 'Chain Test' });

      const res = await request(app)
        .get('/wallets')
        .set('Authorization', `Bearer ${agentToken}`);

      const solWallet = res.body.wallets.find((w: { name: string }) => w.name === 'Chain Test');
      expect(solWallet).toBeDefined();
      expect(solWallet.chain).toBe('solana');
    });
  });

  describe('Wallet Endpoints - Address Format Differences', () => {
    it('should handle Solana address case sensitivity', async () => {
      const createRes = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', chain: 'solana', name: 'Case Test' });

      const address = createRes.body.wallet.address;

      // Solana address should be preserved as-is (case-sensitive)
      const wallet = await testPrisma.hotWallet.findUnique({
        where: { address }
      });

      expect(wallet).toBeDefined();
      // The address in DB should exactly match the returned address
      expect(wallet!.address).toBe(address);
    });
  });
});
