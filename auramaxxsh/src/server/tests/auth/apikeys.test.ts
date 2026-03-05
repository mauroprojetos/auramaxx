/**
 * Tests for API key routes and permissions
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import {
  createTestApp,
  cleanDatabase,
  resetColdWallet,
  setupAndUnlockWallet,
  createToken,
} from '../setup';
import { revokeAdminTokens } from '../../lib/auth';
import { lock } from '../../lib/cold';
import { testPrisma } from '../setup';
import { APIKEY_DB_PLACEHOLDER } from '../../lib/apikey-migration';

describe('API Keys Routes', () => {
  beforeEach(async () => {
    await cleanDatabase();
    resetColdWallet();
    // Clean up any existing API keys
    await testPrisma.apiKey.deleteMany();
  });

  afterEach(() => {
    revokeAdminTokens();
    lock();
  });

  describe('GET /apikeys', () => {
    it('should require authentication', async () => {
      const app = createTestApp();
      const res = await request(app).get('/apikeys');

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('required');
    });

    it('should require apikey:get permission', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      // Create token without apikey:get permission
      const token = createToken({
        agentId: 'test-agent',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apikeys')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Insufficient permissions');
    });

    it('should allow access with apikey:get permission', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['apikey:get'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apikeys')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.apiKeys)).toBe(true);
    });

    it('should never include raw key in GET response', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      // Create an API key first
      const adminToken = createToken({
        agentId: 'admin',
        permissions: ['apikey:set', 'apikey:get'],
        exp: Date.now() + 3600000,
      });

      await request(app)
        .post('/apikeys')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ service: 'alchemy', name: 'leak-test', key: 'secret-api-key-12345678' });

      // Fetch keys and verify raw key is NOT present
      const res = await request(app)
        .get('/apikeys')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.apiKeys.length).toBeGreaterThan(0);
      for (const apiKey of res.body.apiKeys) {
        expect(apiKey.key).toBeUndefined();
        expect(apiKey.keyMasked).toBeDefined();
        expect(apiKey.keyMasked).not.toBe('secret-api-key-12345678');
      }
    });

    it('should allow access with trade:all compound permission', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      // trade:all should expand to include apikey:get
      const token = createToken({
        agentId: 'test-agent',
        permissions: ['trade:all'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apikeys')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should allow access with admin:* permission', async () => {
      const { adminToken } = await setupAndUnlockWallet();
      const app = createTestApp();

      const res = await request(app)
        .get('/apikeys')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /apikeys', () => {
    it('should require authentication', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/apikeys')
        .send({ service: 'alchemy', name: 'test', key: 'test-key' });

      expect(res.status).toBe(401);
    });

    it('should require apikey:set permission', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      // apikey:get is not enough for creating
      const token = createToken({
        agentId: 'test-agent',
        permissions: ['apikey:get'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/apikeys')
        .set('Authorization', `Bearer ${token}`)
        .send({ service: 'alchemy', name: 'test', key: 'test-key' });

      expect(res.status).toBe(403);
    });

    it('should allow creating API key with apikey:set permission', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['apikey:set'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/apikeys')
        .set('Authorization', `Bearer ${token}`)
        .send({ service: 'alchemy', name: 'test', key: 'test-api-key-12345' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.apiKey.service).toBe('alchemy');
      expect(res.body.apiKey.name).toBe('test');
      // Key should be masked in response
      expect(res.body.apiKey.key).toContain('*');
    });

    it('should validate required fields', async () => {
      const { adminToken } = await setupAndUnlockWallet();
      const app = createTestApp();

      // Missing service
      let res = await request(app)
        .post('/apikeys')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'test', key: 'test-key' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('service is required');

      // Missing name
      res = await request(app)
        .post('/apikeys')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ service: 'alchemy', key: 'test-key' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('name is required');

      // Missing key
      res = await request(app)
        .post('/apikeys')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ service: 'alchemy', name: 'test' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('key is required');
    });

    it('should upsert existing API key', async () => {
      const { adminToken } = await setupAndUnlockWallet();
      const app = createTestApp();

      // Create initial key
      await request(app)
        .post('/apikeys')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ service: 'alchemy', name: 'test', key: 'first-key' });

      // Update with same service/name
      const res = await request(app)
        .post('/apikeys')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ service: 'alchemy', name: 'test', key: 'updated-key' });

      expect(res.status).toBe(200);

      // Verify only one key exists
      const keys = await testPrisma.apiKey.findMany({
        where: { service: 'alchemy', name: 'test' }
      });
      expect(keys.length).toBe(1);
      expect(keys[0].key).toBe(APIKEY_DB_PLACEHOLDER);
    });
  });

  describe('DELETE /apikeys/revoke-all', () => {
    it('should require apikey:set permission', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['apikey:get'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .delete('/apikeys/revoke-all')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('should revoke all active API keys in one request', async () => {
      const { adminToken } = await setupAndUnlockWallet();
      const app = createTestApp();

      await request(app)
        .post('/apikeys')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ service: 'alchemy', name: 'one', key: 'delete-me-1' });

      await request(app)
        .post('/apikeys')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ service: 'openai', name: 'two', key: 'delete-me-2' });

      const revokeRes = await request(app)
        .delete('/apikeys/revoke-all')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.success).toBe(true);
      expect(revokeRes.body.revokedCount).toBe(2);

      const listRes = await request(app)
        .get('/apikeys')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(listRes.status).toBe(200);
      expect(listRes.body.apiKeys).toHaveLength(0);

      const activeRows = await testPrisma.apiKey.findMany({ where: { isActive: true } });
      expect(activeRows).toHaveLength(0);

      const revokeAllEvents = await testPrisma.event.findMany({ where: { type: 'system:apikey_revoked_all' } });
      expect(revokeAllEvents.length).toBeGreaterThan(0);
      const latestPayload = JSON.parse(revokeAllEvents[revokeAllEvents.length - 1].data) as { revokedCount?: number };
      expect(latestPayload.revokedCount).toBe(2);
    });
  });

  describe('DELETE /apikeys/:id', () => {
    it('should require apikey:set permission', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['apikey:get'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .delete('/apikeys/some-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('should soft delete API key', async () => {
      const { adminToken } = await setupAndUnlockWallet();
      const app = createTestApp();

      // Create key
      const createRes = await request(app)
        .post('/apikeys')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ service: 'alchemy', name: 'to-delete', key: 'delete-me' });

      const keyId = createRes.body.apiKey.id;

      // Delete it
      const deleteRes = await request(app)
        .delete(`/apikeys/${keyId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.success).toBe(true);

      // Verify it's not returned in list (isActive = false)
      const listRes = await request(app)
        .get('/apikeys')
        .set('Authorization', `Bearer ${adminToken}`);

      const deletedKey = listRes.body.apiKeys.find((k: { id: string }) => k.id === keyId);
      expect(deletedKey).toBeUndefined();
    });
  });
});
