/**
 * Tests for global transactions endpoint
 *
 * Tests:
 * - GET /wallets/transactions (access control, filtering, pagination)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_ID, TEST_AGENT_PUBKEY, setupAndUnlockWallet, decryptTestToken, } from '../setup';

const app = createTestApp();

describe('GET /wallets/transactions', () => {
  let adminToken: string;
  let agentToken: string;          // has wallet:create:hot only (no wallet:list)
  let agentWithListToken: string;  // has wallet:create:hot + wallet:list
  let walletAddress: string;       // owned by agentToken
  let otherWalletAddress: string;  // owned by agentWithListToken

  beforeAll(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Agent 1: no wallet:list
    const authRes = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: TEST_AGENT_ID,
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

    agentToken = decryptTestToken(pollRes.body.encryptedToken);

    // Create wallet for agent 1
    const createRes = await request(app)
      .post('/wallet/create')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ tier: 'hot' });

    walletAddress = createRes.body.wallet.address;

    // Agent 2: has wallet:list
    const authRes2 = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: 'list-agent',
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot', 'wallet:list'] },
        limit: 1.0,
      });

    await request(app)
      .post(`/actions/${authRes2.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const pollRes2 = await request(app)
      .get(`/auth/${authRes2.body.requestId}`).set('x-aura-claim-secret', authRes2.body.secret);

    agentWithListToken = decryptTestToken(pollRes2.body.encryptedToken);

    // Create wallet for agent 2
    const createRes2 = await request(app)
      .post('/wallet/create')
      .set('Authorization', `Bearer ${agentWithListToken}`)
      .send({ tier: 'hot' });

    otherWalletAddress = createRes2.body.wallet.address;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  beforeEach(async () => {
    await testPrisma.transaction.deleteMany();
  });

  /** Seed transactions for both wallets */
  async function seedTransactions() {
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
          description: 'Test send from agent1',
          chain: 'base',
        },
        {
          walletAddress: walletAddress.toLowerCase(),
          txHash: '0x' + '2'.repeat(64),
          type: 'swap',
          status: 'confirmed',
          amount: '0.05',
          tokenAddress: '0x' + '3'.repeat(40),
          from: walletAddress.toLowerCase(),
          description: 'Test swap on agent1',
          chain: 'base',
        },
        {
          walletAddress: otherWalletAddress.toLowerCase(),
          txHash: '0x' + '3'.repeat(64),
          type: 'receive',
          status: 'pending',
          amount: '1.0',
          from: '0x' + '4'.repeat(40),
          to: otherWalletAddress.toLowerCase(),
          description: 'Incoming to agent2',
          chain: 'ethereum',
        },
        {
          walletAddress: otherWalletAddress.toLowerCase(),
          txHash: '0x' + '4'.repeat(64),
          type: 'send',
          status: 'confirmed',
          amount: '0.2',
          from: otherWalletAddress.toLowerCase(),
          to: '0x' + '5'.repeat(40),
          description: 'Outgoing from agent2',
          chain: 'base',
        },
      ],
    });
  }

  it('should list all transactions without auth (human)', async () => {
    await seedTransactions();

    const res = await request(app).get('/wallets/transactions');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.transactions).toHaveLength(4);
    expect(res.body.pagination.total).toBe(4);
    expect(res.body.pagination.hasMore).toBe(false);
  });

  it('should scope to own wallets for agent without wallet:list', async () => {
    await seedTransactions();

    const res = await request(app)
      .get('/wallets/transactions')
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(2);
    // All returned transactions belong to agent1's wallet
    for (const tx of res.body.transactions) {
      expect(tx.walletAddress).toBe(walletAddress.toLowerCase());
    }
  });

  it('should return all transactions for agent with wallet:list', async () => {
    await seedTransactions();

    const res = await request(app)
      .get('/wallets/transactions')
      .set('Authorization', `Bearer ${agentWithListToken}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(4);
  });

  it('should filter by wallet address', async () => {
    await seedTransactions();

    const res = await request(app)
      .get(`/wallets/transactions?wallet=${otherWalletAddress}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(2);
    for (const tx of res.body.transactions) {
      expect(tx.walletAddress).toBe(otherWalletAddress.toLowerCase());
    }
  });

  it('should filter by type', async () => {
    await seedTransactions();

    const res = await request(app)
      .get('/wallets/transactions?type=swap');

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].type).toBe('swap');
  });

  it('should filter by status', async () => {
    await seedTransactions();

    const res = await request(app)
      .get('/wallets/transactions?status=pending');

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].status).toBe('pending');
  });

  it('should filter by chain', async () => {
    await seedTransactions();

    const res = await request(app)
      .get('/wallets/transactions?chain=ethereum');

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].chain).toBe('ethereum');
  });

  it('should filter by token address', async () => {
    await seedTransactions();

    const tokenAddr = '0x' + '3'.repeat(40);
    const res = await request(app)
      .get(`/wallets/transactions?token=${tokenAddr}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].tokenAddress).toBe(tokenAddr.toLowerCase());
  });

  it('should search by description', async () => {
    await seedTransactions();

    const res = await request(app)
      .get('/wallets/transactions?search=swap');

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].description).toContain('swap');
  });

  it('should search by txHash', async () => {
    await seedTransactions();

    const hash = '0x' + '1'.repeat(64);
    const res = await request(app)
      .get(`/wallets/transactions?search=${'1'.repeat(10)}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions.length).toBeGreaterThanOrEqual(1);
    expect(res.body.transactions[0].txHash).toBe(hash);
  });

  it('should paginate results', async () => {
    await seedTransactions();

    const res = await request(app)
      .get('/wallets/transactions?limit=2&offset=0');

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(2);
    expect(res.body.pagination.total).toBe(4);
    expect(res.body.pagination.limit).toBe(2);
    expect(res.body.pagination.offset).toBe(0);
    expect(res.body.pagination.hasMore).toBe(true);

    const res2 = await request(app)
      .get('/wallets/transactions?limit=2&offset=2');

    expect(res2.body.transactions).toHaveLength(2);
    expect(res2.body.pagination.hasMore).toBe(false);
  });

  it('should cap limit at 250', async () => {
    await seedTransactions();

    const res = await request(app)
      .get('/wallets/transactions?limit=500');

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(250);
  });

  it('should return 403 when agent without wallet:list filters by non-owned wallet', async () => {
    await seedTransactions();

    const res = await request(app)
      .get(`/wallets/transactions?wallet=${otherWalletAddress}`)
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('does not have access');
  });

  it('should return empty list for agent with no wallets', async () => {
    await seedTransactions();

    // Create agent 3 with no wallets
    const authRes3 = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: 'empty-agent',
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot'] },
        limit: 0.5,
      });

    await request(app)
      .post(`/actions/${authRes3.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const pollRes3 = await request(app)
      .get(`/auth/${authRes3.body.requestId}`).set('x-aura-claim-secret', authRes3.body.secret);

    const emptyAgentToken = decryptTestToken(pollRes3.body.encryptedToken);

    const res = await request(app)
      .get('/wallets/transactions')
      .set('Authorization', `Bearer ${emptyAgentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it('should allow agent without wallet:list to filter by own wallet', async () => {
    await seedTransactions();

    const res = await request(app)
      .get(`/wallets/transactions?wallet=${walletAddress}`)
      .set('Authorization', `Bearer ${agentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(2);
  });
});
