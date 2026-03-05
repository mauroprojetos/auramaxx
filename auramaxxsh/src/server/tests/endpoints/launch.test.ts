/**
 * Tests for /launch endpoint
 *
 * Note: These tests focus on validation, auth, and access control.
 * Doppler SDK interaction would require on-chain calls and is not tested here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_ID, TEST_AGENT_PUBKEY, setupAndUnlockWallet, encryptPasswordForTest, decryptTestToken } from '../setup';
import { lock } from '../../lib/cold';

const app = createTestApp();

describe('Launch Endpoint', () => {
  let adminToken: string;
  let agentToken: string;
  let walletAddress: string;
  let otherAgentToken: string;
  let otherWalletAddress: string;
  let noLaunchAgentToken: string;
  let noLaunchWalletAddress: string;

  beforeAll(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create agent token with launch permission
    const authRes = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: TEST_AGENT_ID,
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot', 'launch', 'fund'] },
        limit: 1.0,});

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

    // Create second agent with launch permission (for wallet ownership tests)
    const authRes2 = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: 'other-agent',
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot', 'launch', 'fund'] },
        limit: 0.5,});

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

    // Create third agent WITHOUT launch permission
    const authRes3 = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: 'no-launch-agent',
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot'] },
        limit: 0.5,// No launch permission
      });

    if (!authRes3.body.requestId) {
      throw new Error(`Auth3 request failed: ${JSON.stringify(authRes3.body)}`);
    }

    await request(app)
      .post(`/actions/${authRes3.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const pollRes3 = await request(app)
      .get(`/auth/${authRes3.body.requestId}`).set('x-aura-claim-secret', authRes3.body.secret);

    if (!pollRes3.body.encryptedToken) {
      throw new Error(`Token3 retrieval failed: ${JSON.stringify(pollRes3.body)}`);
    }

    noLaunchAgentToken = decryptTestToken(pollRes3.body.encryptedToken);

    const createRes3 = await request(app)
      .post('/wallet/create')
      .set('Authorization', `Bearer ${noLaunchAgentToken}`)
      .send({ tier: 'hot' });

    if (!createRes3.body.wallet) {
      throw new Error(`Failed to create third wallet: ${JSON.stringify(createRes3.body)}`);
    }

    noLaunchWalletAddress = createRes3.body.wallet.address;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  beforeEach(async () => {
    await testPrisma.transaction.deleteMany();
    await testPrisma.trackedAsset.deleteMany();
    await testPrisma.log.deleteMany();
  });

  describe('POST /launch - Basic Validation', () => {
    it('should reject without from address', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          name: 'Test Token',
          symbol: 'TEST',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('from');
    });

    it('should reject without name', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          symbol: 'TEST',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('should reject without symbol', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Test Token',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('symbol');
    });

    it('should reject invalid auction type', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Test Token',
          symbol: 'TEST',
          type: 'invalid',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('type');
    });

    it('should reject non-string from address', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: 123,
          name: 'Test Token',
          symbol: 'TEST',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('from');
    });

    it('should reject non-string name', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 123,
          symbol: 'TEST',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('should reject non-string symbol', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Test Token',
          symbol: 456,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('symbol');
    });
  });

  describe('POST /launch - Token Validation', () => {
    it('should reject invalid bearer token', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', 'Bearer invalid_token')
        .send({
          from: walletAddress,
          name: 'Test Token',
          symbol: 'TEST',
        });

      expect(res.status).toBe(401);
    });

    it('should reject without bearer token', async () => {
      const res = await request(app)
        .post('/launch')
        .send({
          from: walletAddress,
          name: 'Test Token',
          symbol: 'TEST',
        });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /launch - Permission Check', () => {
    it('should reject without launch permission', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${noLaunchAgentToken}`)
        .send({
          from: noLaunchWalletAddress,
          name: 'Test Token',
          symbol: 'TEST',
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('launch');
    });
  });

  describe('POST /launch - Wallet Ownership', () => {
    it('should reject launching from wallet not owned by token', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: otherWalletAddress, // Owned by other agent
          name: 'Test Token',
          symbol: 'TEST',
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('does not have access');
    });

    it('should reject launching from non-existent wallet', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: '0x' + '9'.repeat(40),
          name: 'Test Token',
          symbol: 'TEST',
        });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /launch - Requires Unlock', () => {
    it('should reject launch when wallet locked', async () => {
      lock();

      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Test Token',
          symbol: 'TEST',
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

  describe('POST /launch - Chain Validation', () => {
    it('should reject unknown chain', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Test Token',
          symbol: 'TEST',
          chain: 'nonexistent-chain',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Unknown chain');
    });
  });

  describe('POST /launch - Admin Access', () => {
    it('should allow admin to launch from any wallet', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          from: walletAddress,
          name: 'Admin Token',
          symbol: 'ADM',
        });

      // Admin bypasses permission checks - will reach Doppler SDK call
      // which will fail in test environment (no real chain), but should not be 403
      expect(res.status).not.toBe(403);
    });
  });

  describe('POST /launch - Auction Type Acceptance', () => {
    it('should accept static auction type (reaches SDK)', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Static Token',
          symbol: 'STAT',
          type: 'static',
        });

      // Should pass all validation (may fail at SDK/chain interaction)
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it('should accept dynamic auction type (reaches SDK)', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Dynamic Token',
          symbol: 'DYN',
          type: 'dynamic',
        });

      // Should pass all validation (may fail at SDK/chain interaction)
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it('should accept multicurve auction type (reaches SDK)', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Multi Token',
          symbol: 'MULTI',
          type: 'multicurve',
        });

      // Should pass all validation (may fail at SDK/chain interaction)
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  });

  describe('POST /launch - Beneficiaries', () => {
    it('should accept beneficiaries array on multicurve launch (reaches SDK)', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Beneficiary Token',
          symbol: 'BEN',
          type: 'multicurve',
          beneficiaries: [
            { address: '0x' + '1'.repeat(40), shares: '0.5' },
            { address: '0x' + '2'.repeat(40), shares: '0.5' },
          ],
        });

      // Should pass all validation (may fail at SDK/chain interaction)
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it('should accept beneficiaries array on static launch (reaches SDK)', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Static Ben Token',
          symbol: 'SBEN',
          type: 'static',
          beneficiaries: [
            { address: '0x' + 'a'.repeat(40), shares: '0.05' },
            { address: '0x' + 'b'.repeat(40), shares: '0.95' },
          ],
        });

      // Should pass all validation (may fail at SDK/chain interaction)
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it('should accept dynamic launch with beneficiaries (ignores them with warning)', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Dynamic Ben Token',
          symbol: 'DBEN',
          type: 'dynamic',
          beneficiaries: [
            { address: '0x' + 'c'.repeat(40), shares: '1.0' },
          ],
        });

      // Should pass all validation — beneficiaries are silently ignored for dynamic
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it('should accept launch without beneficiaries (reaches SDK)', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'No Ben Token',
          symbol: 'NOBEN',
          type: 'multicurve',
        });

      // No beneficiaries is valid — should pass all validation (may fail at SDK/chain interaction)
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  });

  describe('POST /launch - Token Metadata (imageUrl / metadata)', () => {
    it('should accept imageUrl and metadata fields (reaches SDK)', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Image Token',
          symbol: 'IMG',
          type: 'multicurve',
          imageUrl: 'https://telegra.ph/file/abc123.jpg',
          metadata: {
            description: 'A token with an image',
            website: 'https://example.com',
          },
        });

      // Should pass all validation (may fail at SDK/chain interaction)
      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it('should accept imageUrl without metadata (reaches SDK)', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Image Only Token',
          symbol: 'IMGO',
          type: 'multicurve',
          imageUrl: 'https://telegra.ph/file/def456.jpg',
        });

      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it('should accept metadata without imageUrl (reaches SDK)', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Meta Only Token',
          symbol: 'META',
          type: 'multicurve',
          metadata: { description: 'Token with description only' },
        });

      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it('should prefer explicit tokenURI over imageUrl/metadata (reaches SDK)', async () => {
      const res = await request(app)
        .post('/launch')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          from: walletAddress,
          name: 'Explicit URI Token',
          symbol: 'EURI',
          type: 'multicurve',
          tokenURI: 'https://example.com/metadata.json',
          imageUrl: 'https://telegra.ph/file/ignored.jpg',
          metadata: { description: 'This should be ignored' },
        });

      // Should pass validation — explicit tokenURI takes precedence
      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  });

  describe('POST /launch/collect-fees - Bulk Fee Collection', () => {
    it('should reject without from address', async () => {
      const res = await request(app)
        .post('/launch/collect-fees')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('from');
    });

    it('should reject without bearer token', async () => {
      const res = await request(app)
        .post('/launch/collect-fees')
        .send({ from: walletAddress });

      expect(res.status).toBe(401);
    });

    it('should allow token without launch permission (collect-fees is permissionless)', async () => {
      const res = await request(app)
        .post('/launch/collect-fees')
        .set('Authorization', `Bearer ${noLaunchAgentToken}`)
        .send({ from: noLaunchWalletAddress });

      // Should NOT be 403 — no launch permission needed for fee collection
      expect(res.status).not.toBe(403);
    });

    it('should reject wallet not owned by token', async () => {
      const res = await request(app)
        .post('/launch/collect-fees')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ from: otherWalletAddress });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('does not have access');
    });

    it('should reject non-existent wallet', async () => {
      const res = await request(app)
        .post('/launch/collect-fees')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ from: '0x' + '9'.repeat(40) });

      expect(res.status).toBe(404);
    });

    it('should return empty results when no launched tokens exist', async () => {
      const res = await request(app)
        .post('/launch/collect-fees')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ from: walletAddress });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.results).toEqual([]);
    });

    it('should allow admin to collect fees', async () => {
      const res = await request(app)
        .post('/launch/collect-fees')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ from: walletAddress });

      expect(res.status).not.toBe(403);
    });
  });

  describe('POST /launch/:tokenAddress/collect-fees - Single Token Fee Collection', () => {
    const fakeTokenAddress = '0x' + 'a'.repeat(40);

    it('should reject without from address', async () => {
      const res = await request(app)
        .post(`/launch/${fakeTokenAddress}/collect-fees`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('from');
    });

    it('should reject without bearer token', async () => {
      const res = await request(app)
        .post(`/launch/${fakeTokenAddress}/collect-fees`)
        .send({ from: walletAddress });

      expect(res.status).toBe(401);
    });

    it('should allow token without launch permission (collect-fees is permissionless)', async () => {
      const res = await request(app)
        .post(`/launch/${fakeTokenAddress}/collect-fees`)
        .set('Authorization', `Bearer ${noLaunchAgentToken}`)
        .send({ from: noLaunchWalletAddress });

      // Should NOT be 403 — no launch permission needed for fee collection
      expect(res.status).not.toBe(403);
    });

    it('should reject wallet not owned by token', async () => {
      const res = await request(app)
        .post(`/launch/${fakeTokenAddress}/collect-fees`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ from: otherWalletAddress });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('does not have access');
    });

    it('should reject non-existent wallet', async () => {
      const res = await request(app)
        .post(`/launch/${fakeTokenAddress}/collect-fees`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ from: '0x' + '9'.repeat(40) });

      expect(res.status).toBe(404);
    });

    it('should reach SDK for valid request (may fail at chain interaction)', async () => {
      const res = await request(app)
        .post(`/launch/${fakeTokenAddress}/collect-fees`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ from: walletAddress });

      // Should pass all validation — will fail at SDK/chain interaction in test env
      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it('should allow admin to collect fees from any wallet', async () => {
      const res = await request(app)
        .post(`/launch/${fakeTokenAddress}/collect-fees`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ from: walletAddress });

      expect(res.status).not.toBe(403);
    });
  });
});
