/**
 * Tests for /wallet endpoints
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_ID, TEST_AGENT_PUBKEY, setupAndUnlockWallet, encryptPasswordForTest, decryptTestToken, } from '../setup';
import { lock } from '../../lib/cold';

const app = createTestApp();

describe('Wallet Endpoints', () => {
  let adminToken: string;
  let agentToken: string;
  let tokenHash: string;

  beforeAll(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create an agent token for testing
    const authRes = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: TEST_AGENT_ID,
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot', 'wallet:create:temp', 'wallet:export', 'wallet:rename'] },
        limit: 1.0,
      });

    if (!authRes.body.requestId) {
      throw new Error(`Auth request failed: ${JSON.stringify(authRes.body)}`);
    }

    // Approve it
    await request(app)
      .post(`/actions/${authRes.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    // Get the token
    const pollRes = await request(app)
      .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

    if (!pollRes.body.encryptedToken) {
      throw new Error(`Token retrieval failed: ${JSON.stringify(pollRes.body)}`);
    }

    agentToken = decryptTestToken(pollRes.body.encryptedToken);
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean hot wallets between tests
    await testPrisma.hotWallet.deleteMany();
  });

  describe('POST /wallet/create', () => {
    it('should reject without token for hot wallet', async () => {
      const res = await request(app)
        .post('/wallet/create')
        .send({ tier: 'hot' });

      expect(res.status).toBe(401);
    });

    it('should reject with invalid tier', async () => {
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'invalid' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('tier');
    });

    it('should create hot wallet with token', async () => {
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          tier: 'hot',
          name: 'Test Wallet',
          color: '#FF5733',
          emoji: '🔥'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(res.body.wallet.tier).toBe('hot');
      expect(res.body.wallet.name).toBe('Test Wallet');
      expect(res.body.wallet.color).toBe('#FF5733');
      expect(res.body.wallet.emoji).toBe('🔥');
      expect(res.body.wallet.tokenHash).toBeDefined();
    });

    it('should reject hot wallet creation when locked', async () => {
      lock();

      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot' });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('unlocked');

      // Re-unlock for other tests and capture new admin token
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({
        pubkey: TEST_AGENT_PUBKEY, encrypted });
      adminToken = unlockRes.body.token;
    });

    it('should create temp wallet with token', async () => {
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'temp' });

      expect(res.status).toBe(200);
      expect(res.body.wallet.tier).toBe('temp');
    });
  });

  describe('GET /wallets', () => {
    it('should list all wallets for human (no token)', async () => {
      // Create a wallet
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Wallet 1' });

      const res = await request(app).get('/wallets');

      expect(res.status).toBe(200);
      expect(res.body.wallets).toBeDefined();
      // Should include cold wallet for human
      const coldWallet = res.body.wallets.find((w: { tier: string }) => w.tier === 'cold');
      expect(coldWallet).toBeDefined();
    });

    it('should filter wallets for agent (only owned)', async () => {
      // Create a wallet with this token
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'My Wallet' });

      // Create another token and wallet
      const authRes2 = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'other-agent',
          profile: 'admin',
          profileOverrides: { scope: ['wallet:create:hot'] },
          limit: 0.1,
        });

      await request(app)
        .post(`/actions/${authRes2.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const pollRes2 = await request(app)
        .get(`/auth/${authRes2.body.requestId}`).set('x-aura-claim-secret', authRes2.body.secret);

      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${decryptTestToken(pollRes2.body.encryptedToken)}`)
        .send({ tier: 'hot', name: 'Other Wallet' });

      // Agent should only see own wallet
      const res = await request(app)
        .get('/wallets')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      const hotWallets = res.body.wallets.filter((w: { tier: string }) => w.tier === 'hot');
      expect(hotWallets.length).toBe(1);
      expect(hotWallets[0].name).toBe('My Wallet');

      // Should not see cold wallet
      const coldWallet = res.body.wallets.find((w: { tier: string }) => w.tier === 'cold');
      expect(coldWallet).toBeUndefined();
    });

    it('should show all hot wallets and cold wallet for agent with wallet:list permission', async () => {
      // Create a wallet with the existing agent token (no wallet:list)
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Owner Wallet' });

      // Create a second agent with wallet:list permission
      const authRes2 = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'listing-agent',
          profile: 'admin',
          profileOverrides: { scope: ['wallet:list', 'wallet:create:hot'] },
          limit: 0,
        });

      await request(app)
        .post(`/actions/${authRes2.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const pollRes2 = await request(app)
        .get(`/auth/${authRes2.body.requestId}`).set('x-aura-claim-secret', authRes2.body.secret);

      const listToken = decryptTestToken(pollRes2.body.encryptedToken);

      // Agent with wallet:list should see all hot wallets (including ones it doesn't own)
      const res = await request(app)
        .get('/wallets')
        .set('Authorization', `Bearer ${listToken}`);

      expect(res.status).toBe(200);
      const hotWallets = res.body.wallets.filter((w: { tier: string }) => w.tier === 'hot');
      expect(hotWallets.length).toBeGreaterThanOrEqual(1);
      expect(hotWallets.find((w: { name: string }) => w.name === 'Owner Wallet')).toBeDefined();

      // Should also see cold wallet (read-only) with wallet:list
      const coldWallet = res.body.wallets.find((w: { tier: string }) => w.tier === 'cold');
      expect(coldWallet).toBeDefined();
      expect(coldWallet.address).toBeDefined();
    });

    it('should filter wallets by tier', async () => {
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Filter Test Wallet' });

      // Human request with tier=hot should exclude cold wallet
      const res = await request(app).get('/wallets?tier=hot');

      expect(res.status).toBe(200);
      expect(res.body.wallets.every((w: { tier: string }) => w.tier === 'hot')).toBe(true);
      expect(res.body.wallets.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter wallets by chain', async () => {
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', chain: 'base', name: 'Base Wallet' });

      const res = await request(app).get('/wallets?chain=base');

      expect(res.status).toBe(200);
      expect(res.body.wallets.every((w: { chain: string }) => w.chain === 'base')).toBe(true);
    });

    it('should sort wallets by name', async () => {
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Bravo' });

      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Alpha' });

      const res = await request(app).get('/wallets?tier=hot&sortBy=name&sortDir=asc');

      expect(res.status).toBe(200);
      const names = res.body.wallets.map((w: { name?: string }) => w.name).filter(Boolean);
      expect(names.length).toBeGreaterThanOrEqual(2);
      // Verify sorted ascending
      for (let i = 1; i < names.length; i++) {
        expect(names[i].localeCompare(names[i - 1])).toBeGreaterThanOrEqual(0);
      }
    });

    it('should include agent info with token', async () => {
      const res = await request(app)
        .get('/wallets')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.body.agent).toBeDefined();
      expect(res.body.agent.id).toBe(TEST_AGENT_ID);
      expect(res.body.agent.remaining).toBeDefined();
    });
  });

  describe('POST /wallet/:address/export', () => {
    let walletAddress: string;

    beforeEach(async () => {
      // Create a wallet
      const createRes = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot' });

      walletAddress = createRes.body.wallet.address;
    });

    it('should export wallet with owner token', async () => {
      const res = await request(app)
        .post(`/wallet/${walletAddress}/export`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.address).toBe(walletAddress);
      expect(res.body.privateKey).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it('should reject export from non-owner token', async () => {
      // Create another token with wallet:export permission but not owning the wallet
      const authRes2 = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'other-agent',
          profile: 'admin',
          profileOverrides: { scope: ['wallet:export'] },
        });

      await request(app)
        .post(`/actions/${authRes2.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const pollRes2 = await request(app)
        .get(`/auth/${authRes2.body.requestId}`).set('x-aura-claim-secret', authRes2.body.secret);

      const res = await request(app)
        .post(`/wallet/${walletAddress}/export`)
        .set('Authorization', `Bearer ${decryptTestToken(pollRes2.body.encryptedToken)}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('does not have access');
    });

    it('should reject export without token even when unlocked', async () => {
      const res = await request(app)
        .post(`/wallet/${walletAddress}/export`);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Authorization');
    });

    it('should reject export when locked', async () => {
      lock();

      const res = await request(app)
        .post(`/wallet/${walletAddress}/export`);

      expect(res.status).toBe(401);

      // Re-unlock and capture new admin token
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({
        pubkey: TEST_AGENT_PUBKEY, encrypted });
      adminToken = unlockRes.body.token;
    });
  });

  describe('POST /wallet/rename', () => {
    let walletAddress: string;

    beforeEach(async () => {
      const createRes = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Original Name' });

      walletAddress = createRes.body.wallet.address;
    });

    it('should rename wallet with owner token', async () => {
      const res = await request(app)
        .post('/wallet/rename')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          address: walletAddress,
          name: 'New Name',
          color: '#00FF00'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should reject rename from non-owner', async () => {
      // Create another token
      const authRes2 = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'other-agent',
          profile: 'admin',
          profileOverrides: { scope: ['wallet:rename'] },
        });

      await request(app)
        .post(`/actions/${authRes2.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const pollRes2 = await request(app)
        .get(`/auth/${authRes2.body.requestId}`).set('x-aura-claim-secret', authRes2.body.secret);

      const res = await request(app)
        .post('/wallet/rename')
        .set('Authorization', `Bearer ${decryptTestToken(pollRes2.body.encryptedToken)}`)
        .send({ address: walletAddress, name: 'Hacked' });

      expect(res.status).toBe(403);
    });

    it('should update hidden field', async () => {
      const res = await request(app)
        .post('/wallet/rename')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          address: walletAddress,
          hidden: true
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify it's hidden
      const wallet = await testPrisma.hotWallet.findUnique({
        where: { address: walletAddress }
      });
      expect(wallet?.hidden).toBe(true);
    });
  });

  describe('Hidden Wallets', () => {
    it('should create wallet with hidden: true', async () => {
      const res = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          tier: 'hot',
          name: 'Hidden Wallet',
          hidden: true
        });

      expect(res.status).toBe(200);
      expect(res.body.wallet.hidden).toBe(true);
    });

    it('should exclude hidden wallets from default listing', async () => {
      // Create a visible wallet
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Visible Wallet' });

      // Create a hidden wallet
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Hidden Wallet', hidden: true });

      // Default listing should not include hidden
      const res = await request(app)
        .get('/wallets')
        .set('Authorization', `Bearer ${agentToken}`);

      const hotWallets = res.body.wallets.filter((w: { tier: string }) => w.tier === 'hot');
      expect(hotWallets.length).toBe(1);
      expect(hotWallets[0].name).toBe('Visible Wallet');
    });

    it('should include hidden wallets when includeHidden=true', async () => {
      // Create a visible wallet
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Visible Wallet' });

      // Create a hidden wallet
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Hidden Wallet', hidden: true });

      // With includeHidden=true should include both
      const res = await request(app)
        .get('/wallets?includeHidden=true')
        .set('Authorization', `Bearer ${agentToken}`);

      const hotWallets = res.body.wallets.filter((w: { tier: string }) => w.tier === 'hot');
      expect(hotWallets.length).toBe(2);
    });
  });

  describe('GET /wallets/search', () => {
    beforeEach(async () => {
      // Create some wallets for search tests
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Trading Bot' });

      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Savings Agent' });

      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Hidden Trading', hidden: true });
    });

    it('should require search query', async () => {
      const res = await request(app)
        .get('/wallets/search');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('query');
    });

    it('should search by name', async () => {
      const res = await request(app)
        .get('/wallets/search?q=trading')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.wallets.length).toBe(2); // Trading Bot + Hidden Trading
    });

    it('should include hidden wallets in search results', async () => {
      const res = await request(app)
        .get('/wallets/search?q=hidden')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.wallets.length).toBe(1);
      expect(res.body.wallets[0].name).toBe('Hidden Trading');
    });

    it('should search by address', async () => {
      // Get one wallet address
      const listRes = await request(app)
        .get('/wallets?includeHidden=true')
        .set('Authorization', `Bearer ${agentToken}`);

      const hotWallet = listRes.body.wallets.find((w: { tier: string }) => w.tier === 'hot');
      const addressFragment = hotWallet.address.slice(2, 8); // Skip 0x

      const res = await request(app)
        .get(`/wallets/search?q=${addressFragment}`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.wallets.length).toBeGreaterThanOrEqual(1);
    });

    it('should search by description', async () => {
      // Create a wallet with a description
      await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'hot', name: 'Test', description: 'unique-search-term-xyz' });

      const res = await request(app)
        .get('/wallets/search?q=unique-search-term')
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.wallets.length).toBe(1);
      expect(res.body.wallets[0].description).toContain('unique-search-term');
    });

    it('should allow human search without auth', async () => {
      // Human (no token) should be able to search all wallets
      const res = await request(app)
        .get('/wallets/search?q=trading');

      expect(res.status).toBe(200);
      // Human sees all wallets, including those from any agent
      expect(res.body.wallets.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /wallet/:address', () => {
    let walletAddress: string;

    beforeEach(async () => {
      const createRes = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          tier: 'hot',
          name: 'My Wallet',
          description: 'Test description',
          emoji: '🚀',
          color: '#FF0000'
        });

      walletAddress = createRes.body.wallet.address;
    });

    it('should return wallet details', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}`);

      expect(res.status).toBe(200);
      expect(res.body.address).toBe(walletAddress);
      expect(res.body.name).toBe('My Wallet');
      expect(res.body.description).toBe('Test description');
      expect(res.body.emoji).toBe('🚀');
      expect(res.body.color).toBe('#FF0000');
      expect(res.body.tier).toBe('hot');
      expect(res.body.balance).toBeDefined();
      expect(res.body.createdAt).toBeDefined();
    });

    it('should return cold wallet details for human', async () => {
      const listRes = await request(app).get('/wallets');
      const coldWallet = listRes.body.wallets.find((w: { tier: string; chain: string }) => w.tier === 'cold' && w.chain === 'base');

      expect(coldWallet).toBeDefined();

      const res = await request(app)
        .get(`/wallet/${coldWallet.address}`);

      expect(res.status).toBe(200);
      expect(res.body.address).toBe(coldWallet.address);
      expect(res.body.tier).toBe('cold');
      expect(res.body.chain).toBe('base');
      expect(res.body.balance).toBeDefined();
    });

    it('should reject cold wallet details for agent without wallet:list', async () => {
      const listRes = await request(app).get('/wallets');
      const coldWallet = listRes.body.wallets.find((w: { tier: string; chain: string }) => w.tier === 'cold' && w.chain === 'base');

      expect(coldWallet).toBeDefined();

      const res = await request(app)
        .get(`/wallet/${coldWallet.address}`)
        .set('Authorization', `Bearer ${agentToken}`);

      expect(res.status).toBe(403);
    });

    it('should allow cold wallet details for agent with wallet:list permission', async () => {
      const authRes = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'wallet-list-agent',
          profile: 'admin',
          profileOverrides: { scope: ['wallet:list'] },
          limit: 0.1,
        });

      await request(app)
        .post(`/actions/${authRes.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const pollRes = await request(app)
        .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);
      const walletListToken = decryptTestToken(pollRes.body.encryptedToken);

      const listRes = await request(app).get('/wallets');
      const coldWallet = listRes.body.wallets.find((w: { tier: string; chain: string }) => w.tier === 'cold' && w.chain === 'base');

      expect(coldWallet).toBeDefined();

      const res = await request(app)
        .get(`/wallet/${coldWallet.address}`)
        .set('Authorization', `Bearer ${walletListToken}`);

      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('cold');
      expect(res.body.address).toBe(coldWallet.address);
    });

    it('should return temp wallet details', async () => {
      const createRes = await request(app)
        .post('/wallet/create')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ tier: 'temp' });

      const tempAddress = createRes.body.wallet.address;

      const res = await request(app)
        .get(`/wallet/${tempAddress}`);

      expect(res.status).toBe(200);
      expect(res.body.address.toLowerCase()).toBe(tempAddress.toLowerCase());
      expect(res.body.tier).toBe('temp');
      expect(res.body.balance).toBeDefined();
    });

    it('should return 404 for non-existent wallet', async () => {
      const res = await request(app)
        .get('/wallet/0x0000000000000000000000000000000000000000');

      expect(res.status).toBe(404);
    });

    it('should reject access from non-owner agent', async () => {
      // Create another token
      const authRes2 = await request(app)
        .post('/auth')
        .send({
          pubkey: TEST_AGENT_PUBKEY,
          agentId: 'other-agent',
          profile: 'admin',
          profileOverrides: { scope: ['wallet:create:hot'] },
        });

      await request(app)
        .post(`/actions/${authRes2.body.requestId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ approved: true });

      const pollRes2 = await request(app)
        .get(`/auth/${authRes2.body.requestId}`).set('x-aura-claim-secret', authRes2.body.secret);

      const res = await request(app)
        .get(`/wallet/${walletAddress}`)
        .set('Authorization', `Bearer ${decryptTestToken(pollRes2.body.encryptedToken)}`);

      expect(res.status).toBe(403);
    });

    it('should allow human access without token', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}`);

      expect(res.status).toBe(200);
      expect(res.body.address).toBe(walletAddress);
    });
  });
});
