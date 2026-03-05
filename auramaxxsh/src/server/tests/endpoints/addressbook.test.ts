/**
 * Tests for /address-labels endpoint (Address Book)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, setupAndUnlockWallet, TEST_AGENT_ID, TEST_AGENT_PUBKEY, decryptTestToken } from '../setup';

const app = createTestApp();

describe('Address Book Endpoints', () => {
  let adminToken: string;
  let agentToken: string;
  let agentTokenNoPerms: string;

  beforeAll(async () => {
    await cleanDatabase();
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create agent with addressbook:write permission
    const authRes = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: TEST_AGENT_ID,
        profile: 'admin',
        profileOverrides: { scope: ['addressbook:write'] },
        limit: 1.0,
      });

    await request(app)
      .post(`/actions/${authRes.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const pollRes = await request(app)
      .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);
    agentToken = decryptTestToken(pollRes.body.encryptedToken);

    // Create agent WITHOUT addressbook:write
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

  describe('POST /address-labels', () => {
    it('should create an address label (admin)', async () => {
      const res = await request(app)
        .post('/address-labels')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          address: '0x1234567890abcdef1234567890abcdef12345678',
          label: 'Vitalik',
          emoji: '🦄',
          color: '#FF5733',
          notes: 'Ethereum co-founder',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.label.label).toBe('Vitalik');
      expect(res.body.label.emoji).toBe('🦄');
      expect(res.body.label.createdBy).toBe('human');
    });

    it('should create an address label (agent with permission)', async () => {
      const res = await request(app)
        .post('/address-labels')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          label: 'Treasury',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.label.createdBy).toBe(TEST_AGENT_ID);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/address-labels')
        .send({
          address: '0xaaaa',
          label: 'Test',
        });

      expect(res.status).toBe(401);
    });

    it('should reject agent without addressbook:write', async () => {
      const res = await request(app)
        .post('/address-labels')
        .set('Authorization', `Bearer ${agentTokenNoPerms}`)
        .send({
          address: '0xbbbb',
          label: 'Test',
        });

      expect(res.status).toBe(403);
    });

    it('should require address and label', async () => {
      const res = await request(app)
        .post('/address-labels')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: '0xaaaa' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('should upsert on same address', async () => {
      const addr = '0x1111111111111111111111111111111111111111';

      await request(app)
        .post('/address-labels')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: addr, label: 'Original' });

      const res = await request(app)
        .post('/address-labels')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: addr, label: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.label.label).toBe('Updated');

      // Should only have one entry for this address
      const count = await testPrisma.addressLabel.count({ where: { address: addr } });
      expect(count).toBe(1);
    });
  });

  describe('GET /address-labels', () => {
    it('should list all labels', async () => {
      const res = await request(app)
        .get('/address-labels');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.labels)).toBe(true);
      expect(res.body.labels.length).toBeGreaterThan(0);
    });

    it('should search by label', async () => {
      const res = await request(app)
        .get('/address-labels?q=Vitalik');

      expect(res.status).toBe(200);
      expect(res.body.labels.some((l: any) => l.label === 'Vitalik')).toBe(true);
    });

    it('should search by address', async () => {
      const res = await request(app)
        .get('/address-labels?q=0x1234');

      expect(res.status).toBe(200);
      expect(res.body.labels.length).toBeGreaterThan(0);
    });
  });

  describe('DELETE /address-labels/:id', () => {
    it('should delete a label', async () => {
      // Create one to delete
      const createRes = await request(app)
        .post('/address-labels')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: '0xdeleteme000000000000000000000000000000', label: 'ToDelete' });

      const id = createRes.body.label.id;

      const res = await request(app)
        .delete(`/address-labels/${id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify deleted
      const check = await testPrisma.addressLabel.findUnique({ where: { id } });
      expect(check).toBeNull();
    });

    it('should return 404 for non-existent label', async () => {
      const res = await request(app)
        .delete('/address-labels/nonexistent')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
    });

    it('should reject agent without permission', async () => {
      const createRes = await request(app)
        .post('/address-labels')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: '0xnoperm000000000000000000000000000000000', label: 'NoPerm' });

      const res = await request(app)
        .delete(`/address-labels/${createRes.body.label.id}`)
        .set('Authorization', `Bearer ${agentTokenNoPerms}`);

      expect(res.status).toBe(403);
    });
  });
});
