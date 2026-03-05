/**
 * Tests for POST /auth with action field + resolve flow
 *
 * Integration tests verifying:
 * - POST /auth accepts optional action field
 * - Action metadata stored in HumanAction
 * - Approval triggers auto-execute when action present
 * - Existing auth flow (no action) unchanged
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, testPrisma, cleanDatabase, setupAndUnlockWallet, TEST_AGENT_PUBKEY } from '../setup';

const app = createTestApp();

describe('POST /auth with action field', () => {
  let adminToken: string;

  beforeAll(async () => {
    const wallet = await setupAndUnlockWallet();
    adminToken = wallet.adminToken;
  });

  beforeEach(async () => {
    // Clean pending actions between tests
    await testPrisma.humanAction.deleteMany({ where: { type: 'auth' } });
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  it('accepts POST /auth without action field (regression)', async () => {
    const res = await request(app)
      .post('/auth')
      .send({
        agentId: 'test-no-action',
        profile: 'strict',
        pubkey: TEST_AGENT_PUBKEY,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.requestId).toBeDefined();
    expect(res.body.secret).toBeDefined();

    // Verify no action in metadata
    const record = await testPrisma.humanAction.findUnique({ where: { id: res.body.requestId } });
    expect(record).not.toBeNull();
    const metadata = JSON.parse(record!.metadata || '{}');
    expect(metadata.action).toBeUndefined();
  });

  it('accepts POST /auth with action field', async () => {
    const actionPayload = {
      endpoint: '/send',
      method: 'POST',
      body: { to: '0x1234567890abcdef1234567890abcdef12345678', amount: '0.01' },
    };

    const res = await request(app)
      .post('/auth')
      .send({
        agentId: 'test-with-action',
        profile: 'strict',
        pubkey: TEST_AGENT_PUBKEY,
        action: actionPayload,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.requestId).toBeDefined();
    expect(res.body.secret).toBeDefined();

    // Verify action stored in metadata
    const record = await testPrisma.humanAction.findUnique({ where: { id: res.body.requestId } });
    expect(record).not.toBeNull();
    const metadata = JSON.parse(record!.metadata || '{}');
    expect(metadata.action).toEqual({
      endpoint: '/send',
      method: 'POST',
      body: { to: '0x1234567890abcdef1234567890abcdef12345678', amount: '0.01' },
    });
  });

  it('normalizes action method to uppercase', async () => {
    const res = await request(app)
      .post('/auth')
      .send({
        agentId: 'test-method-case',
        profile: 'strict',
        pubkey: TEST_AGENT_PUBKEY,
        action: { endpoint: '/wallets', method: 'get' },
      });

    expect(res.status).toBe(200);

    const record = await testPrisma.humanAction.findUnique({ where: { id: res.body.requestId } });
    const metadata = JSON.parse(record!.metadata || '{}');
    expect(metadata.action.method).toBe('GET');
  });

  it('ignores invalid action field (non-object)', async () => {
    const res = await request(app)
      .post('/auth')
      .send({
        agentId: 'test-invalid-action',
        profile: 'strict',
        pubkey: TEST_AGENT_PUBKEY,
        action: 'not-an-object',
      });

    expect(res.status).toBe(200);

    // Should succeed without storing action
    const record = await testPrisma.humanAction.findUnique({ where: { id: res.body.requestId } });
    const metadata = JSON.parse(record!.metadata || '{}');
    expect(metadata.action).toBeUndefined();
  });

  it('ignores action field missing endpoint', async () => {
    const res = await request(app)
      .post('/auth')
      .send({
        agentId: 'test-missing-endpoint',
        profile: 'strict',
        pubkey: TEST_AGENT_PUBKEY,
        action: { method: 'POST' },
      });

    expect(res.status).toBe(200);

    const record = await testPrisma.humanAction.findUnique({ where: { id: res.body.requestId } });
    const metadata = JSON.parse(record!.metadata || '{}');
    expect(metadata.action).toBeUndefined();
  });

  it('stores action without body when body is omitted', async () => {
    const res = await request(app)
      .post('/auth')
      .send({
        agentId: 'test-no-body',
        profile: 'strict',
        pubkey: TEST_AGENT_PUBKEY,
        action: { endpoint: '/wallets', method: 'GET' },
      });

    expect(res.status).toBe(200);

    const record = await testPrisma.humanAction.findUnique({ where: { id: res.body.requestId } });
    const metadata = JSON.parse(record!.metadata || '{}');
    expect(metadata.action).toEqual({ endpoint: '/wallets', method: 'GET' });
    expect(metadata.action.body).toBeUndefined();
  });
});

describe('Auth resolve with action triggers auto-execute', () => {
  let adminToken: string;

  beforeAll(async () => {
    const wallet = await setupAndUnlockWallet();
    adminToken = wallet.adminToken;
  });

  beforeEach(async () => {
    await testPrisma.humanAction.deleteMany({ where: { type: 'auth' } });
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  it('approval of auth request without action returns token only', async () => {
    // Create auth request
    const createRes = await request(app)
      .post('/auth')
      .send({
        agentId: 'resolve-no-action',
        profile: 'strict',
        pubkey: TEST_AGENT_PUBKEY,
      });
    expect(createRes.status).toBe(200);

    // Resolve (approve)
    const resolveRes = await request(app)
      .post(`/actions/${createRes.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.success).toBe(true);
    expect(resolveRes.body.token).toBeDefined();
    expect(resolveRes.body.agentId).toBe('resolve-no-action');
  });

  it('approval of auth request with action creates token (auto-execute fires in background)', async () => {
    // Create auth request with action
    const createRes = await request(app)
      .post('/auth')
      .send({
        agentId: 'resolve-with-action',
        profile: 'strict',
        pubkey: TEST_AGENT_PUBKEY,
        action: { endpoint: '/wallets', method: 'GET' },
      });
    expect(createRes.status).toBe(200);

    // Resolve (approve)
    const resolveRes = await request(app)
      .post(`/actions/${createRes.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.success).toBe(true);
    expect(resolveRes.body.token).toBeDefined();
    expect(resolveRes.body.agentId).toBe('resolve-with-action');

    // Verify the HumanAction was updated to approved
    const record = await testPrisma.humanAction.findUnique({ where: { id: createRes.body.requestId } });
    expect(record!.status).toBe('approved');
  });

  it('rejection of auth request with action does not execute', async () => {
    // Create auth request with action
    const createRes = await request(app)
      .post('/auth')
      .send({
        agentId: 'resolve-reject-action',
        profile: 'strict',
        pubkey: TEST_AGENT_PUBKEY,
        action: { endpoint: '/send', method: 'POST', body: { to: '0x123', amount: '1000' } },
      });
    expect(createRes.status).toBe(200);

    // Resolve (reject)
    const resolveRes = await request(app)
      .post(`/actions/${createRes.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: false });

    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.success).toBe(true);
    expect(resolveRes.body.approved).toBe(false);
    expect(resolveRes.body.token).toBeUndefined();

    // Verify status is rejected
    const record = await testPrisma.humanAction.findUnique({ where: { id: createRes.body.requestId } });
    expect(record!.status).toBe('rejected');
  });
});
