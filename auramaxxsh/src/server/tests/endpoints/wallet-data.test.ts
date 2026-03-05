/**
 * Tests for wallet transaction and asset endpoints
 *
 * Tests:
 * - GET /wallet/:address/transactions (filtering, pagination, access control)
 * - POST /wallet/:address/transactions (permission, validation, duplicates)
 * - GET /wallet/:address/assets (filtering, sorting, access control)
 * - POST /wallet/:address/asset (permission, upsert, validation)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_ID, TEST_AGENT_PUBKEY, setupAndUnlockWallet, decryptTestToken, } from '../setup';

// Mock on-chain transaction history for external address tests
vi.mock('../../lib/txhistory', () => ({
  fetchAndDecodeEvents: vi.fn().mockResolvedValue({
    transactions: [],
    blockRange: { from: '0', to: '100000' },
    total: 0,
  }),
}));

const app = createTestApp();

describe('Wallet Data Endpoints', () => {
  let adminToken: string;
  let agentToken: string;
  let walletAddress: string;
  let otherAgentToken: string;
  let otherWalletAddress: string;

  beforeAll(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create first agent token with wallet:tx:add and wallet:asset:add permissions
    const authRes = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: TEST_AGENT_ID,
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot', 'wallet:tx:add', 'wallet:asset:add'] },
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

    // Create second agent without tx/asset permissions
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
    // Clean transactions and assets between tests
    await testPrisma.transaction.deleteMany();
    await testPrisma.trackedAsset.deleteMany();
  });

  describe('GET /wallet/:address/transactions', () => {
    beforeEach(async () => {
      // Create some test transactions
      await testPrisma.transaction.createMany({
        data: [
          {
            walletAddress: walletAddress.toLowerCase(),
            txHash: '0x' + '1'.repeat(64),
            type: 'send',
            status: 'confirmed',
            amount: '0.1',
            from: walletAddress.toLowerCase(),
            to: '0x' + '2'.repeat(40),
            description: 'Test send',
            chain: 'base'
          },
          {
            walletAddress: walletAddress.toLowerCase(),
            txHash: '0x' + '2'.repeat(64),
            type: 'swap',
            status: 'confirmed',
            amount: '0.05',
            tokenAddress: '0x' + '3'.repeat(40),
            from: walletAddress.toLowerCase(),
            description: 'Test swap',
            chain: 'base'
          },
          {
            walletAddress: walletAddress.toLowerCase(),
            txHash: '0x' + '3'.repeat(64),
            type: 'receive',
            status: 'pending',
            amount: '1.0',
            from: '0x' + '4'.repeat(40),
            to: walletAddress.toLowerCase(),
            chain: 'base'
          }
        ]
      });
    });

    it('should list transactions for a wallet', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/transactions`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.transactions).toHaveLength(3);
      expect(res.body.pagination.total).toBe(3);
    });

    it('should filter by type', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/transactions?type=swap`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.transactions).toHaveLength(1);
      expect(res.body.transactions[0].type).toBe('swap');
    });

    it('should filter by status', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/transactions?status=pending`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.transactions).toHaveLength(1);
      expect(res.body.transactions[0].status).toBe('pending');
    });

    it('should filter by token address', async () => {
      const tokenAddr = '0x' + '3'.repeat(40);
      const res = await request(app)
        .get(`/wallet/${walletAddress}/transactions?token=${tokenAddr}`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.transactions).toHaveLength(1);
      expect(res.body.transactions[0].tokenAddress).toBe(tokenAddr.toLowerCase());
    });

    it('should search by description', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/transactions?search=swap`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.transactions).toHaveLength(1);
      expect(res.body.transactions[0].description).toContain('swap');
    });

    it('should paginate results', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/transactions?limit=2&offset=0`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.transactions).toHaveLength(2);
      expect(res.body.pagination.hasMore).toBe(true);

      const res2 = await request(app)
        .get(`/wallet/${walletAddress}/transactions?limit=2&offset=2`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res2.body.transactions).toHaveLength(1);
      expect(res2.body.pagination.hasMore).toBe(false);
    });

    it('should reject access from non-owner agent', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/transactions`)
        .set('Authorization', `Bearer ${otherAgentToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('does not have access');
    });

    it('should allow human access without token', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/transactions`);

      expect(res.status).toBe(200);
      expect(res.body.transactions).toHaveLength(3);
    });

    it('should return DB transactions path for cold wallet (no on-chain fallback)', async () => {
      const listRes = await request(app).get('/wallets');
      const coldWallet = listRes.body.wallets.find((w: { tier: string; chain: string }) => w.tier === 'cold' && w.chain === 'base');

      expect(coldWallet).toBeDefined();

      const res = await request(app)
        .get(`/wallet/${coldWallet.address}/transactions`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.source).toBe('db');
      expect(res.body.transactions).toHaveLength(0);
      expect(res.body.pagination.hasMore).toBe(false);
    });

    it('should return on-chain results for non-existent wallet (external address)', async () => {
      const res = await request(app)
        .get('/wallet/0x0000000000000000000000000000000000000000/transactions');

      // External addresses now trigger the on-chain path instead of 404
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('on-chain');
    });
  });

  describe('POST /wallet/:address/transactions', () => {
    it('should add a manual transaction', async () => {
      const res = await request(app)
        .post(`/wallet/${walletAddress}/transactions`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          type: 'manual',
          amount: '0.5',
          description: 'Manual entry',
          from: '0x' + '1'.repeat(40),
          to: walletAddress
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.transaction.type).toBe('manual');
      expect(res.body.transaction.amount).toBe('0.5');
    });

    it('should reject invalid type', async () => {
      const res = await request(app)
        .post(`/wallet/${walletAddress}/transactions`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          type: 'invalid',
          amount: '0.5'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('type');
    });

    it('should reject duplicate txHash', async () => {
      const txHash = '0x' + 'a'.repeat(64);

      await request(app)
        .post(`/wallet/${walletAddress}/transactions`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          type: 'send',
          txHash,
          amount: '0.1'
        });

      const res = await request(app)
        .post(`/wallet/${walletAddress}/transactions`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          type: 'send',
          txHash,
          amount: '0.2'
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already exists');
    });

    it('should reject without wallet:tx:add permission', async () => {
      const res = await request(app)
        .post(`/wallet/${otherWalletAddress}/transactions`)
        .set('Authorization', `Bearer ${otherAgentToken}`)
        .send({
          type: 'manual',
          amount: '0.5'
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('wallet:tx:add');
    });

    it('should reject without wallet access', async () => {
      const res = await request(app)
        .post(`/wallet/${otherWalletAddress}/transactions`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          type: 'manual',
          amount: '0.5'
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('does not have access');
    });
  });

  describe('GET /wallet/:address/assets', () => {
    beforeEach(async () => {
      // Create some test assets
      await testPrisma.trackedAsset.createMany({
        data: [
          {
            walletAddress: walletAddress.toLowerCase(),
            tokenAddress: '0x' + '1'.repeat(40),
            symbol: 'TKN1',
            name: 'Token One',
            decimals: 18,
            chain: 'base'
          },
          {
            walletAddress: walletAddress.toLowerCase(),
            tokenAddress: '0x' + '2'.repeat(40),
            symbol: 'TKN2',
            name: 'Token Two',
            decimals: 6,
            chain: 'base'
          },
          {
            walletAddress: walletAddress.toLowerCase(),
            tokenAddress: '0x' + '3'.repeat(40),
            symbol: 'HIDDEN',
            name: 'Hidden Token',
            decimals: 18,
            isHidden: true,
            chain: 'base'
          }
        ]
      });
    });

    it('should list assets for a wallet', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/assets`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.assets).toHaveLength(2); // Hidden not included by default
    });

    it('should include hidden assets when requested', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/assets?includeHidden=true`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.assets).toHaveLength(3);
    });

    it('should search by symbol', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/assets?search=TKN1`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.assets).toHaveLength(1);
      expect(res.body.assets[0].symbol).toBe('TKN1');
    });

    it('should search by name', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/assets?search=two`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.assets).toHaveLength(1);
      expect(res.body.assets[0].name).toBe('Token Two');
    });

    it('should reject access from non-owner agent', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/assets`)
        .set('Authorization', `Bearer ${otherAgentToken}`);

      expect(res.status).toBe(403);
    });

    it('should allow human access without token', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/assets`);

      expect(res.status).toBe(200);
      expect(res.body.assets).toHaveLength(2);
    });

    it('should return empty assets for cold wallet instead of 404', async () => {
      const listRes = await request(app).get('/wallets');
      const coldWallet = listRes.body.wallets.find((w: { tier: string; chain: string }) => w.tier === 'cold' && w.chain === 'base');

      expect(coldWallet).toBeDefined();

      const res = await request(app)
        .get(`/wallet/${coldWallet.address}/assets`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.assets).toHaveLength(0);
    });
  });

  describe('POST /wallet/:address/asset', () => {
    it('should add a tracked asset', async () => {
      const res = await request(app)
        .post(`/wallet/${walletAddress}/asset`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          tokenAddress: '0x' + 'a'.repeat(40),
          symbol: 'NEW',
          name: 'New Token',
          decimals: 18
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.asset.symbol).toBe('NEW');
    });

    it('should upsert existing asset', async () => {
      const tokenAddr = '0x' + 'b'.repeat(40);

      // First create
      await request(app)
        .post(`/wallet/${walletAddress}/asset`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          tokenAddress: tokenAddr,
          symbol: 'OLD',
          name: 'Old Name'
        });

      // Then update
      const res = await request(app)
        .post(`/wallet/${walletAddress}/asset`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          tokenAddress: tokenAddr,
          symbol: 'UPD',
          name: 'Updated Name'
        });

      expect(res.status).toBe(200);
      expect(res.body.asset.symbol).toBe('UPD');
      expect(res.body.asset.name).toBe('Updated Name');

      // Verify only one asset exists
      const assets = await testPrisma.trackedAsset.findMany({
        where: { tokenAddress: tokenAddr.toLowerCase() }
      });
      expect(assets).toHaveLength(1);
    });

    it('should reject without tokenAddress', async () => {
      const res = await request(app)
        .post(`/wallet/${walletAddress}/asset`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          symbol: 'NOADDR'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('tokenAddress');
    });

    it('should reject without wallet:asset:add permission', async () => {
      const res = await request(app)
        .post(`/wallet/${otherWalletAddress}/asset`)
        .set('Authorization', `Bearer ${otherAgentToken}`)
        .send({
          tokenAddress: '0x' + 'c'.repeat(40),
          symbol: 'TEST'
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('wallet:asset:add');
    });
  });
});
