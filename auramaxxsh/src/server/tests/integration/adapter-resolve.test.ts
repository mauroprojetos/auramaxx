/**
 * Integration tests for adapter resolve flow.
 *
 * Uses createTestApp() + supertest to test the full flow:
 * - Create pending request → resolve via admin token → verify approved
 * - Race condition: two resolves on same action
 * - Locked wallet returns 401 for auth requests
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import {
  createTestApp,
  cleanDatabase,
  setupAndUnlockWallet,
  resetColdWallet,
  TEST_AGENT_ID,
} from '../setup';
import { lock } from '../../lib/cold';
import { createAdminToken } from '../../lib/auth';
import { getPublicKey } from '../../lib/transport';
import { testPrisma } from '../setup';

/** Helper to create a pending request with required DB fields */
function humanActionData(overrides: { type: string; agentId: string; limit: number; permissions: string[]; ttl: number }) {
  return {
    type: overrides.type,
    fromTier: 'system',
    chain: 'base',
    status: 'pending',
    metadata: JSON.stringify({
      agentId: overrides.agentId,
      limit: overrides.limit,
      permissions: overrides.permissions,
      ttl: overrides.ttl,
      pubkey: getPublicKey(),
    }),
  };
}

describe('Adapter Resolve Integration', () => {
  let app: ReturnType<typeof createTestApp>;
  let adminToken: string;

  beforeEach(async () => {
    await cleanDatabase();
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
    app = createTestApp();
  });

  afterEach(() => {
    resetColdWallet();
  });

  it('should resolve pending request via internal admin token', async () => {
    const pending = await testPrisma.humanAction.create({
      data: humanActionData({
        type: 'agent_access',
        agentId: TEST_AGENT_ID,
        limit: 0.5,
        permissions: ['fund', 'send:hot'],
        ttl: 3600,
      }),
    });

    // Create an internal admin token (as the adapter router would)
    const internalToken = await createAdminToken(getPublicKey());

    const res = await request(app)
      .post(`/actions/${pending.id}/resolve`)
      .set('Authorization', `Bearer ${internalToken}`)
      .send({ approved: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.body.agentId).toBe(TEST_AGENT_ID);
    expect(res.body.limit).toBe(0.5);

    const updated = await testPrisma.humanAction.findUnique({ where: { id: pending.id } });
    expect(updated?.status).toBe('approved');
  });

  it('should return 404 when resolving already-resolved action (race condition)', async () => {
    const pending = await testPrisma.humanAction.create({
      data: humanActionData({
        type: 'agent_access',
        agentId: TEST_AGENT_ID,
        limit: 0.1,
        permissions: ['fund'],
        ttl: 3600,
      }),
    });

    // First resolve succeeds
    const res1 = await request(app)
      .post(`/actions/${pending.id}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });
    expect(res1.status).toBe(200);
    expect(res1.body.success).toBe(true);

    // Second resolve gets 404
    const res2 = await request(app)
      .post(`/actions/${pending.id}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });
    expect(res2.status).toBe(404);
    expect(res2.body.error).toContain('already resolved');
  });

  it('should return 401 when wallet is locked for auth requests', async () => {
    const pending = await testPrisma.humanAction.create({
      data: humanActionData({
        type: 'auth',
        agentId: TEST_AGENT_ID,
        limit: 0.1,
        permissions: ['fund'],
        ttl: 3600,
      }),
    });

    // Lock the wallet (admin token still valid, but wallet is locked)
    lock();

    const res = await request(app)
      .post(`/actions/${pending.id}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('locked');
  });

  it('should handle rejection via adapter token', async () => {
    const pending = await testPrisma.humanAction.create({
      data: humanActionData({
        type: 'agent_access',
        agentId: TEST_AGENT_ID,
        limit: 1.0,
        permissions: ['fund'],
        ttl: 3600,
      }),
    });

    const internalToken = await createAdminToken(getPublicKey());

    const res = await request(app)
      .post(`/actions/${pending.id}/resolve`)
      .set('Authorization', `Bearer ${internalToken}`)
      .send({ approved: false });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.approved).toBe(false);

    const updated = await testPrisma.humanAction.findUnique({ where: { id: pending.id } });
    expect(updated?.status).toBe('rejected');
  });
});
