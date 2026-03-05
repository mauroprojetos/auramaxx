/**
 * Tests for app routes: storage, API keys, approval, token endpoint
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
import { setDefault } from '../../lib/defaults';

describe('App Routes', () => {
  beforeEach(async () => {
    await cleanDatabase();
    resetColdWallet();
    await testPrisma.appStorage.deleteMany();
    await testPrisma.humanAction.deleteMany();
  });

  afterEach(() => {
    revokeAdminTokens();
    lock();
  });

  describe('Authenticated Storage (app:storage)', () => {
    it('should require authentication', async () => {
      const app = createTestApp();
      const res = await request(app).get('/apps/test-app/storage');
      expect(res.status).toBe(401);
    });

    it('should require app:storage permission', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['wallet:list'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apps/test-app/storage')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Insufficient permissions');
    });

    it('should list storage keys with app:storage permission', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      // Seed a storage entry
      await testPrisma.appStorage.create({
        data: { appId: 'test-app', key: 'mykey', value: JSON.stringify({ hello: 'world' }) },
      });

      // agentId matches appId for scoped access
      const token = createToken({
        agentId: 'test-app',
        permissions: ['app:storage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apps/test-app/storage')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].key).toBe('mykey');
      expect(res.body.entries[0].value).toEqual({ hello: 'world' });
    });

    it('should get a single storage value', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      await testPrisma.appStorage.create({
        data: { appId: 'test-app', key: 'mykey', value: JSON.stringify(42) },
      });

      const token = createToken({
        agentId: 'test-app',
        permissions: ['app:storage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apps/test-app/storage/mykey')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.value).toBe(42);
    });

    it('should return 404 for missing storage key', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-app',
        permissions: ['app:storage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apps/test-app/storage/nonexistent')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('should set (upsert) a storage value', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-app',
        permissions: ['app:storage'],
        exp: Date.now() + 3600000,
      });

      // Create
      let res = await request(app)
        .put('/apps/test-app/storage/mykey')
        .set('Authorization', `Bearer ${token}`)
        .send({ value: { count: 1 } });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.value).toEqual({ count: 1 });

      // Update
      res = await request(app)
        .put('/apps/test-app/storage/mykey')
        .set('Authorization', `Bearer ${token}`)
        .send({ value: { count: 2 } });

      expect(res.status).toBe(200);
      expect(res.body.value).toEqual({ count: 2 });
    });

    it('should reject set without value', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-app',
        permissions: ['app:storage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .put('/apps/test-app/storage/mykey')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('value is required');
    });

    it('should delete a storage key', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      await testPrisma.appStorage.create({
        data: { appId: 'test-app', key: 'mykey', value: JSON.stringify('delete-me') },
      });

      const token = createToken({
        agentId: 'test-app',
        permissions: ['app:storage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .delete('/apps/test-app/storage/mykey')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify deleted
      const entry = await testPrisma.appStorage.findUnique({
        where: { appId_key: { appId: 'test-app', key: 'mykey' } },
      });
      expect(entry).toBeNull();
    });

    it('should return 404 when deleting nonexistent key', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-app',
        permissions: ['app:storage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .delete('/apps/test-app/storage/nonexistent')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('should allow admin:* to access any app storage', async () => {
      const { adminToken } = await setupAndUnlockWallet();
      const app = createTestApp();

      const res = await request(app)
        .get('/apps/test-app/storage')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('Storage Scoping', () => {
    it('should deny app:storage token access to another app storage', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      await testPrisma.appStorage.create({
        data: { appId: 'app-b', key: 'secret', value: JSON.stringify('private') },
      });

      // Token for app-a trying to access app-b's storage
      const token = createToken({
        agentId: 'app-a',
        permissions: ['app:storage'],
        exp: Date.now() + 3600000,
      });

      // GET list
      let res = await request(app)
        .get('/apps/app-b/storage')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain("another app's storage");

      // GET key
      res = await request(app)
        .get('/apps/app-b/storage/secret')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);

      // PUT key
      res = await request(app)
        .put('/apps/app-b/storage/secret')
        .set('Authorization', `Bearer ${token}`)
        .send({ value: 'hacked' });
      expect(res.status).toBe(403);

      // DELETE key
      res = await request(app)
        .delete('/apps/app-b/storage/secret')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('should allow app:storage:all token to access any app storage', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      await testPrisma.appStorage.create({
        data: { appId: 'app-b', key: 'data', value: JSON.stringify('shared') },
      });

      const token = createToken({
        agentId: 'app-a',
        permissions: ['app:storage', 'app:storage:all'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apps/app-b/storage')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.entries).toHaveLength(1);
    });

    it('should allow admin token to access any app storage', async () => {
      const { adminToken } = await setupAndUnlockWallet();
      const app = createTestApp();

      await testPrisma.appStorage.create({
        data: { appId: 'some-other-app', key: 'data', value: JSON.stringify('admin-visible') },
      });

      const res = await request(app)
        .get('/apps/some-other-app/storage')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.entries).toHaveLength(1);
    });

    it('should strip strategy: prefix from agentId for scope matching', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      await testPrisma.appStorage.create({
        data: { appId: 'tic-tac-toe', key: 'state', value: JSON.stringify({ board: [] }) },
      });

      // Strategy token has "strategy:" prefix on agentId
      const token = createToken({
        agentId: 'strategy:tic-tac-toe',
        permissions: ['app:storage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apps/tic-tac-toe/storage/state')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.value).toEqual({ board: [] });
    });

    it('should strip app: prefix from agentId for scope matching', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      await testPrisma.appStorage.create({
        data: { appId: 'tic-tac-toe', key: 'state', value: JSON.stringify({ board: [] }) },
      });

      // App token has "app:" prefix on agentId
      const token = createToken({
        agentId: 'app:tic-tac-toe',
        permissions: ['app:storage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apps/tic-tac-toe/storage/state')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.value).toEqual({ board: [] });
    });
  });

  describe('API Key Access (app:accesskey)', () => {
    it('should require app:accesskey permission', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['app:storage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apps/test-app/apikey/birdeye')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('should return API key from app storage', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      await testPrisma.appStorage.create({
        data: { appId: 'test-app', key: 'birdeye', value: JSON.stringify('sk-test-key') },
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['app:accesskey'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apps/test-app/apikey/birdeye')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.value).toBe('sk-test-key');
      expect(res.body.keyName).toBe('birdeye');
    });

    it('should return 404 for missing API key', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['app:accesskey'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apps/test-app/apikey/nonexistent')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe('App Messaging (cron-owned queue)', () => {
    it('should enqueue message requests and return timeout when no cron worker consumes them', async () => {
      const { adminToken } = await setupAndUnlockWallet();
      const app = createTestApp();

      await setDefault('strategy.message_timeout_ms', 25);
      try {
        const res = await request(app)
          .post('/apps/agent-chat/message')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ message: 'hello from dashboard', adapter: 'dashboard' });

        expect(res.status).toBe(504);
        expect(res.body.success).toBe(false);

        const queued = await testPrisma.humanAction.findFirst({
          where: { type: 'strategy:message' },
          orderBy: { createdAt: 'desc' },
        });
        expect(queued).not.toBeNull();
        expect(queued!.status).toBe('rejected');
        expect(queued!.metadata || '').toContain('agent-chat');
        expect(queued!.metadata || '').toContain('hello from dashboard');
      } finally {
        await setDefault('strategy.message_timeout_ms', 120000);
      }
    });
  });

  describe('App Approval (strategy:manage)', () => {
    it('should require strategy:manage permission for approval', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['strategy:read'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/apps/some-app/approve')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('should return 404 for non-existent app on approve', async () => {
      const { adminToken } = await setupAndUnlockWallet();
      const app = createTestApp();

      const res = await request(app)
        .post('/apps/nonexistent-app/approve')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('should revoke approval (delete) even if no approval exists', async () => {
      const { adminToken } = await setupAndUnlockWallet();
      const app = createTestApp();

      const res = await request(app)
        .delete('/apps/some-app/approve')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.revoked).toBe(true);
    });

    it('should require strategy:manage for revocation', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['app:storage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .delete('/apps/some-app/approve')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });

  describe('Internal Strategy Token Bridge', () => {
    it('should return 404 because /apps/internal/:appId/strategy-token is removed', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const res = await request(app)
        .post('/apps/internal/agent-chat/strategy-token')
        .set('x-strategy-cron-secret', process.env.STRATEGY_CRON_SHARED_SECRET!);

      expect(res.status).toBe(404);
    });
  });

  describe('App Token (admin only)', () => {
    it('should require authentication', async () => {
      const app = createTestApp();
      const res = await request(app).get('/apps/test-app/token');
      expect(res.status).toBe(401);
    });

    it('should require admin permission', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['app:storage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .get('/apps/test-app/token')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Admin access required');
    });

    it('should return 404 when no token exists for app', async () => {
      const { adminToken } = await setupAndUnlockWallet();
      const app = createTestApp();

      const res = await request(app)
        .get('/apps/nonexistent-app/token')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
    });
  });
});
