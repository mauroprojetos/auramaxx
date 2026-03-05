import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, createToken, testPrisma, setupAndUnlockWallet, TEST_AGENT_PUBKEY } from '../setup';

const app = createTestApp();

describe('Action approval endpoints', () => {
  let adminToken: string;
  let resolveOnlyToken: string;

  beforeAll(async () => {
    await cleanDatabase();
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
    resolveOnlyToken = createToken({
      agentId: 'approve-test-non-admin',
      permissions: ['action:resolve'],
      exp: Date.now() + 5 * 60 * 1000,
    });
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function createPendingAction(): Promise<string> {
    const createRes = await request(app)
      .post('/auth')
      .send({
        pubkey: TEST_AGENT_PUBKEY,
        agentId: 'approve-test-action',
        profile: 'dev',
      });

    return createRes.body.requestId as string;
  }

  it('approves a pending action with admin token via /actions/:id/approve', async () => {
    const id = await createPendingAction();

    const res = await request(app)
      .post(`/actions/${id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const action = await testPrisma.humanAction.findUnique({ where: { id } });
    expect(action?.status).toBe('approved');
  });

  it('rejects non-admin tokens on /actions/:id/approve', async () => {
    const id = await createPendingAction();

    const res = await request(app)
      .post(`/actions/${id}/approve`)
      .set('Authorization', `Bearer ${resolveOnlyToken}`)
      .send({});

    expect(res.status).toBe(403);
    expect(String(res.body.error || '')).toContain('Admin');
  });

  it('requires admin for approval even when using /actions/:id/resolve', async () => {
    const id = await createPendingAction();

    const res = await request(app)
      .post(`/actions/${id}/resolve`)
      .set('Authorization', `Bearer ${resolveOnlyToken}`)
      .send({ approved: true });

    expect(res.status).toBe(403);
    expect(String(res.body.error || '')).toContain('Admin');
  });

  it('returns deterministic 404 for missing action id on /actions/:id/approve', async () => {
    const res = await request(app)
      .post('/actions/does-not-exist/approve')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(404);
    expect(String(res.body.error || '')).toContain('not found or already resolved');
  });

  it('returns deterministic 404 when already resolved on /actions/:id/approve', async () => {
    const id = await createPendingAction();

    await request(app)
      .post(`/actions/${id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    const res = await request(app)
      .post(`/actions/${id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(404);
    expect(String(res.body.error || '')).toContain('not found or already resolved');
  });
});
