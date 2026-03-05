import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, createToken, resetColdWallet, setupAndUnlockWallet } from '../setup';
import { revokeAdminTokens } from '../../lib/auth';
import { lock } from '../../lib/cold';
import { setDefault } from '../../lib/defaults';
import { events } from '../../lib/events';

describe('/defaults routes', () => {
  const customEventSpy = vi.spyOn(events, 'custom').mockImplementation(() => {});

  beforeEach(async () => {
    await cleanDatabase();
    resetColdWallet();
    customEventSpy.mockClear();
  });

  afterEach(() => {
    revokeAdminTokens();
    lock();
  });

  it('GET /defaults requires auth', async () => {
    const app = createTestApp();
    const res = await request(app).get('/defaults');

    expect(res.status).toBe(401);
  });

  it('GET /defaults requires admin:*', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();
    const token = createToken({
      agentId: 'agent-defaults',
      permissions: ['wallet:list'],
      exp: Date.now() + 3600_000,
    });

    const res = await request(app)
      .get('/defaults')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Admin access required');
  });

  it('GET /defaults returns grouped defaults for admin', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();
    await setDefault('limits.fund', 0.2);

    const res = await request(app)
      .get('/defaults')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.defaults.financial.some((d: { key: string }) => d.key === 'limits.fund')).toBe(true);
  });

  it('PATCH /defaults/:key updates known key', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    const patchRes = await request(app)
      .patch('/defaults/limits.fund')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 0.05 });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.success).toBe(true);
    expect(patchRes.body.key).toBe('limits.fund');
    expect(patchRes.body.value).toBe(0.05);

    const getRes = await request(app)
      .get('/defaults')
      .set('Authorization', `Bearer ${adminToken}`);
    const fund = getRes.body.defaults.financial.find((d: { key: string }) => d.key === 'limits.fund');
    expect(fund.value).toBe(0.05);
  });

  it('PATCH /defaults/:key rejects unknown key', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    const res = await request(app)
      .patch('/defaults/not.real')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Unknown default key');
  });

  it('emits audit event when trust.localProfile enters dangerous admin mode', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();
    await setDefault('trust.localProfile', 'dev');
    customEventSpy.mockClear();

    const patchRes = await request(app)
      .patch('/defaults/trust.localProfile')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 'admin' });

    expect(patchRes.status).toBe(200);
    expect(customEventSpy).toHaveBeenCalledWith(
      'trust:local_dangerous_mode_changed',
      expect.objectContaining({
        key: 'trust.localProfile',
        previousValue: 'dev',
        nextValue: 'admin',
      })
    );
  });

  it('emits audit event when trust.localProfile exits dangerous admin mode', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();
    await setDefault('trust.localProfile', 'admin');
    customEventSpy.mockClear();

    const patchRes = await request(app)
      .patch('/defaults/trust.localProfile')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 'strict' });

    expect(patchRes.status).toBe(200);
    expect(customEventSpy).toHaveBeenCalledWith(
      'trust:local_dangerous_mode_changed',
      expect.objectContaining({
        key: 'trust.localProfile',
        previousValue: 'admin',
        nextValue: 'strict',
      })
    );
  });

  it('POST /defaults/reset resets key back to seed value', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    await request(app)
      .patch('/defaults/limits.fund')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 0.77 });

    const resetRes = await request(app)
      .post('/defaults/reset')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ key: 'limits.fund' });

    expect(resetRes.status).toBe(200);
    expect(resetRes.body.success).toBe(true);

    const getRes = await request(app)
      .get('/defaults')
      .set('Authorization', `Bearer ${adminToken}`);
    const fund = getRes.body.defaults.financial.find((d: { key: string }) => d.key === 'limits.fund');
    expect(fund.value).toBe(0);
  });
});
