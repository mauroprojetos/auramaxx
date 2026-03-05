/**
 * Tests for /bookmarks endpoint (Token Bookmarks)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, setupAndUnlockWallet, TEST_AGENT_ID, TEST_AGENT_PUBKEY, decryptTestToken } from '../setup';

const app = createTestApp();

const MOCK_TOKEN = '0x' + 'a'.repeat(40);
const MOCK_TOKEN_2 = '0x' + 'b'.repeat(40);

describe('Bookmark Endpoints', () => {
  let adminToken: string;
  let agentToken: string;
  let agentTokenNoPerms: string;

  beforeAll(async () => {
    await cleanDatabase();
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create agent with bookmark:write permission
    const authRes = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: TEST_AGENT_ID,
        profile: 'admin',
        profileOverrides: { scope: ['bookmark:write'] },
        limit: 1.0,
      });

    await request(app)
      .post(`/actions/${authRes.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const pollRes = await request(app)
      .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);
    agentToken = decryptTestToken(pollRes.body.encryptedToken);

    // Create agent WITHOUT bookmark:write
    const authRes2 = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: 'no-perms-agent',
        profile: 'admin',
        profileOverrides: { scope: ['wallet:create:hot'] },
        limit: 1.0,
      });

    await request(app)
      .post(`/actions/${authRes2.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const pollRes2 = await request(app)
      .get(`/auth/${authRes2.body.requestId}`).set('x-aura-claim-secret', authRes2.body.secret);
    agentTokenNoPerms = decryptTestToken(pollRes2.body.encryptedToken);
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  describe('POST /bookmarks', () => {
    it('should create a bookmark (admin)', async () => {
      const res = await request(app)
        .post('/bookmarks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          tokenAddress: MOCK_TOKEN,
          chain: 'base',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.bookmark.walletAddress).toBeNull();
      expect(res.body.bookmark.tokenAddress).toBe(MOCK_TOKEN.toLowerCase());
      expect(res.body.bookmark.chain).toBe('base');
    });

    it('should create a bookmark (agent with permission)', async () => {
      const res = await request(app)
        .post('/bookmarks')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          tokenAddress: MOCK_TOKEN_2,
          chain: 'base',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.bookmark.walletAddress).toBeNull();
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/bookmarks')
        .send({ tokenAddress: MOCK_TOKEN });

      expect(res.status).toBe(401);
    });

    it('should reject agent without bookmark:write', async () => {
      const res = await request(app)
        .post('/bookmarks')
        .set('Authorization', `Bearer ${agentTokenNoPerms}`)
        .send({ tokenAddress: MOCK_TOKEN });

      expect(res.status).toBe(403);
    });

    it('should require tokenAddress', async () => {
      const res = await request(app)
        .post('/bookmarks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ chain: 'base' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('tokenAddress');
    });

    it('should be idempotent (same token+chain)', async () => {
      const token = '0x' + 'c'.repeat(40);

      await request(app)
        .post('/bookmarks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tokenAddress: token, chain: 'base' });

      const res = await request(app)
        .post('/bookmarks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tokenAddress: token, chain: 'base' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Only one bookmark row
      const count = await testPrisma.trackedAsset.count({
        where: { walletAddress: null, tokenAddress: token.toLowerCase(), chain: 'base' },
      });
      expect(count).toBe(1);
    });

    it('should seed TokenMetadata on creation', async () => {
      const token = '0x' + 'd'.repeat(40);

      await request(app)
        .post('/bookmarks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tokenAddress: token, chain: 'base' });

      // Wait briefly for fire-and-forget metadata upsert
      await new Promise(r => setTimeout(r, 100));

      const meta = await testPrisma.tokenMetadata.findUnique({
        where: { tokenAddress_chain: { tokenAddress: token.toLowerCase(), chain: 'base' } },
      });
      expect(meta).not.toBeNull();
    });
  });

  describe('GET /bookmarks', () => {
    it('should list all bookmarks', async () => {
      const res = await request(app)
        .get('/bookmarks');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.bookmarks)).toBe(true);
      expect(res.body.bookmarks.length).toBeGreaterThan(0);

      // All should have null walletAddress
      for (const b of res.body.bookmarks) {
        expect(b.walletAddress).toBeNull();
      }
    });

    it('should filter by chain', async () => {
      const res = await request(app)
        .get('/bookmarks?chain=base');

      expect(res.status).toBe(200);
      for (const b of res.body.bookmarks) {
        expect(b.chain).toBe('base');
      }
    });

    it('should search by token address', async () => {
      const res = await request(app)
        .get(`/bookmarks?q=${MOCK_TOKEN.toLowerCase().slice(0, 10)}`);

      expect(res.status).toBe(200);
      expect(res.body.bookmarks.length).toBeGreaterThan(0);
    });
  });

  describe('DELETE /bookmarks/:id', () => {
    it('should delete a bookmark', async () => {
      // Create one to delete
      const createRes = await request(app)
        .post('/bookmarks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tokenAddress: '0x' + 'e'.repeat(40), chain: 'base' });

      const id = createRes.body.bookmark.id;

      const res = await request(app)
        .delete(`/bookmarks/${id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 404 for non-existent bookmark', async () => {
      const res = await request(app)
        .delete('/bookmarks/nonexistent')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
    });

    it('should reject agent without permission', async () => {
      const createRes = await request(app)
        .post('/bookmarks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tokenAddress: '0x' + 'f'.repeat(40), chain: 'base' });

      const res = await request(app)
        .delete(`/bookmarks/${createRes.body.bookmark.id}`)
        .set('Authorization', `Bearer ${agentTokenNoPerms}`);

      expect(res.status).toBe(403);
    });
  });

  describe('Market data enrichment', () => {
    it('should include market data from TokenMetadata in GET /bookmarks', async () => {
      const token = '0x' + '7'.repeat(40);

      // Create bookmark
      await request(app)
        .post('/bookmarks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tokenAddress: token, chain: 'base' });

      // Wait for fire-and-forget metadata seed
      await new Promise(r => setTimeout(r, 100));

      // Manually update TokenMetadata with market data
      await testPrisma.tokenMetadata.update({
        where: { tokenAddress_chain: { tokenAddress: token.toLowerCase(), chain: 'base' } },
        data: {
          priceUsd: '42.50',
          marketCap: 1000000,
          fdv: 1200000,
          liquidity: 500000,
          volume24h: 200000,
          dexId: 'uniswap',
          pairAddress: '0xpair123',
          websites: JSON.stringify(['https://example.com']),
          socials: JSON.stringify([{ type: 'twitter', url: 'https://twitter.com/example' }]),
        },
      });

      const res = await request(app).get('/bookmarks');

      const bookmark = res.body.bookmarks.find((b: any) => b.tokenAddress === token.toLowerCase());
      expect(bookmark).toBeDefined();
      expect(bookmark.priceUsd).toBe('42.50');
      expect(bookmark.marketCap).toBe(1000000);
      expect(bookmark.fdv).toBe(1200000);
      expect(bookmark.liquidity).toBe(500000);
      expect(bookmark.volume24h).toBe(200000);
      expect(bookmark.dexId).toBe('uniswap');
      expect(bookmark.pairAddress).toBe('0xpair123');
      expect(bookmark.websites).toEqual(['https://example.com']);
      expect(bookmark.socials).toEqual([{ type: 'twitter', url: 'https://twitter.com/example' }]);
    });

    it('should return null/empty defaults when no market data exists', async () => {
      const res = await request(app).get('/bookmarks');

      // Pick any bookmark that doesn't have market data injected
      const bookmark = res.body.bookmarks.find((b: any) => b.priceUsd === null);
      if (bookmark) {
        expect(bookmark.marketCap).toBeNull();
        expect(bookmark.websites).toEqual([]);
        expect(bookmark.socials).toEqual([]);
      }
    });
  });

  describe('Bookmark + TrackedAsset coexistence', () => {
    it('should allow bookmark and wallet-tracked asset for same token', async () => {
      const token = '0x' + '9'.repeat(40);

      // Create bookmark (null wallet)
      const bookmarkRes = await request(app)
        .post('/bookmarks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ tokenAddress: token, chain: 'base' });

      expect(bookmarkRes.status).toBe(200);

      // Create wallet-tracked asset for same token
      await testPrisma.trackedAsset.create({
        data: {
          walletAddress: '0x' + '1'.repeat(40),
          tokenAddress: token.toLowerCase(),
          chain: 'base',
        },
      });

      // Both should exist
      const all = await testPrisma.trackedAsset.findMany({
        where: { tokenAddress: token.toLowerCase(), chain: 'base' },
      });
      expect(all.length).toBe(2);
      expect(all.filter(a => a.walletAddress === null).length).toBe(1);
      expect(all.filter(a => a.walletAddress !== null).length).toBe(1);
    });
  });
});
