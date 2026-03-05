/**
 * End-to-End Tests
 *
 * Tests the complete flow from agent requesting access to performing transactions.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_PUBKEY, setupAndUnlockWallet, decryptTestToken } from './setup';
const app = createTestApp();

describe('End-to-End: Complete Agent Flow', () => {
  let adminToken: string;

  beforeAll(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('should complete full agent workflow: setup -> auth -> wallet -> export', async () => {
    // ============================================
    // STEP 1: Cold wallet already setup in beforeAll
    // ============================================

    // ============================================
    // STEP 2: Agent requests access token
    // ============================================
    const authRes = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY, agentId: 'trading-bot-v1',
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot', 'wallet:export'] },
        limit: 0.5,
      });

    expect(authRes.status).toBe(200);
    expect(authRes.body.requestId).toBeDefined();
    expect(authRes.body.secret).toBeDefined();

    const requestId = authRes.body.requestId;
    const secret = authRes.body.secret;

    // ============================================
    // STEP 3: Agent polls (should be pending)
    // ============================================
    const pollPendingRes = await request(app)
      .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);

    expect(pollPendingRes.status).toBe(200);
    expect(pollPendingRes.body.status).toBe('pending');

    // ============================================
    // STEP 4: Human sees notification and approves
    // ============================================
    // Verify notification was created
    const notifications = await testPrisma.notification.findMany({
      where: { type: 'pending_approval' }
    });
    expect(notifications.length).toBeGreaterThan(0);

    // Human approves
    const approveRes = await request(app)
      .post(`/actions/${requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);

    // ============================================
    // STEP 5: Agent retrieves token
    // ============================================
    const pollApprovedRes = await request(app)
      .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);

    expect(pollApprovedRes.status).toBe(200);
    expect(pollApprovedRes.body.status).toBe('approved');
    expect(pollApprovedRes.body.encryptedToken).toBeDefined();

    const token = decryptTestToken(pollApprovedRes.body.encryptedToken);

    // ============================================
    // STEP 6: Agent creates hot wallet
    // ============================================
    const createWalletRes = await request(app)
      .post('/wallet/create')
      .set('Authorization', `Bearer ${token}`)
      .send({
        tier: 'hot',
        name: 'Trading Wallet',
        color: '#3498db',
        emoji: '💹'
      });

    expect(createWalletRes.status).toBe(200);
    expect(createWalletRes.body.wallet.address).toBeDefined();
    expect(createWalletRes.body.wallet.name).toBe('Trading Wallet');

    const hotWalletAddress = createWalletRes.body.wallet.address;

    // ============================================
    // STEP 7: Agent lists their wallets
    // ============================================
    const listRes = await request(app)
      .get('/wallets')
      .set('Authorization', `Bearer ${token}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.wallets.length).toBe(1);
    expect(listRes.body.wallets[0].address).toBe(hotWalletAddress);
    expect(listRes.body.agent.remaining).toBe(0.5);

    // ============================================
    // STEP 8: Agent exports wallet
    // ============================================
    const exportRes = await request(app)
      .post(`/wallet/${hotWalletAddress}/export`)
      .set('Authorization', `Bearer ${token}`);

    expect(exportRes.status).toBe(200);
    expect(exportRes.body.privateKey).toMatch(/^0x[a-fA-F0-9]{64}$/);
  });
});

describe('End-to-End: Token Rejection Flow', () => {
  let adminToken: string;

  beforeEach(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('should handle rejection correctly', async () => {
    // Agent requests
    const authRes = await request(app)
      .post('/auth')
      .send({ profile: 'admin', pubkey: TEST_AGENT_PUBKEY, agentId: 'rejected-agent' });

    // Human rejects
    await request(app)
      .post(`/actions/${authRes.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: false });

    // Agent polls
    const pollRes = await request(app)
      .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

    expect(pollRes.body.status).toBe('rejected');
    expect(pollRes.body.encryptedToken).toBeUndefined();
  });
});

describe('End-to-End: Multi-Agent Isolation', () => {
  let adminToken: string;

  beforeEach(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('should isolate wallets between agents', async () => {
    // Create Agent 1
    const auth1 = await request(app)
      .post('/auth')
      .send({ pubkey: TEST_AGENT_PUBKEY, agentId: 'agent-1',
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot', 'wallet:export'] },
      });

    await request(app)
      .post(`/actions/${auth1.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const poll1 = await request(app)
      .get(`/auth/${auth1.body.requestId}`).set('x-aura-claim-secret', auth1.body.secret);
    const token1 = decryptTestToken(poll1.body.encryptedToken);

    // Create Agent 2
    const auth2 = await request(app)
      .post('/auth')
      .send({ pubkey: TEST_AGENT_PUBKEY, agentId: 'agent-2',
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot', 'wallet:export'] },
      });

    await request(app)
      .post(`/actions/${auth2.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const poll2 = await request(app)
      .get(`/auth/${auth2.body.requestId}`).set('x-aura-claim-secret', auth2.body.secret);
    const token2 = decryptTestToken(poll2.body.encryptedToken);

    // Agent 1 creates wallet
    const wallet1 = await request(app)
      .post('/wallet/create')
      .set('Authorization', `Bearer ${token1}`)
      .send({ tier: 'hot', name: 'Agent 1 Wallet' });

    // Agent 2 creates wallet
    const wallet2 = await request(app)
      .post('/wallet/create')
      .set('Authorization', `Bearer ${token2}`)
      .send({ tier: 'hot', name: 'Agent 2 Wallet' });

    // Agent 1 lists - should only see their wallet
    const list1 = await request(app)
      .get('/wallets')
      .set('Authorization', `Bearer ${token1}`);

    expect(list1.body.wallets.length).toBe(1);
    expect(list1.body.wallets[0].name).toBe('Agent 1 Wallet');

    // Agent 2 lists - should only see their wallet
    const list2 = await request(app)
      .get('/wallets')
      .set('Authorization', `Bearer ${token2}`);

    expect(list2.body.wallets.length).toBe(1);
    expect(list2.body.wallets[0].name).toBe('Agent 2 Wallet');

    // Human lists - should see all wallets
    const listHuman = await request(app).get('/wallets');
    const hotWallets = listHuman.body.wallets.filter((w: { tier: string }) => w.tier === 'hot');
    expect(hotWallets.length).toBe(2);

    // Agent 1 cannot export Agent 2's wallet
    const exportAttempt = await request(app)
      .post(`/wallet/${wallet2.body.wallet.address}/export`)
      .set('Authorization', `Bearer ${token1}`);

    expect(exportAttempt.status).toBe(403);
  });
});

describe('End-to-End: Token Validation', () => {
  it('should invalidate tampered tokens', async () => {
    await cleanDatabase();

    const { adminToken } = await setupAndUnlockWallet();

    const authRes = await request(app)
      .post('/auth')
      .send({ profile: 'admin', pubkey: TEST_AGENT_PUBKEY, agentId: 'test-agent',
        profileOverrides: { scope: ['wallet:create:hot'] },
      });

    await request(app)
      .post(`/actions/${authRes.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const pollRes = await request(app)
      .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

    // Token should work
    const validToken = decryptTestToken(pollRes.body.encryptedToken);
    const listRes = await request(app)
      .get('/wallets')
      .set('Authorization', `Bearer ${validToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.agent).toBeDefined();

    // A tampered token should fail
    const tamperedToken = validToken.slice(0, -10) + 'XXXXXXXXXX';
    const failRes = await request(app)
      .get('/wallets')
      .set('Authorization', `Bearer ${tamperedToken}`);

    // Should still return 200 but without agent info (treated as human)
    expect(failRes.body.agent).toBeUndefined();
  });
});
