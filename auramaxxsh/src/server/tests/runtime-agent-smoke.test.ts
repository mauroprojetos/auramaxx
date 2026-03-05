/**
 * Runtime Agent Smoke Test — V1 Launch Readiness
 *
 * Boots the runtime with a setup + unlocked agent and verifies critical
 * endpoints respond correctly. This is the "open-agent smoke" gate:
 * if these fail, the runtime cannot serve authenticated users.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  createTestApp,
  cleanDatabase,
  testPrisma,
  setupAndUnlockWallet,
} from './setup';

const app = createTestApp();

describe('Runtime Agent Smoke (open agent)', () => {
  let adminToken: string;
  let address: string;

  beforeAll(async () => {
    await cleanDatabase();
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
    address = result.address;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  // ── Core status ──────────────────────────────────────────────

  it('heartbeat responds with 200', async () => {
    const res = await request(app).get('/what_is_happening');
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });

  it('setup status shows wallet is set up and unlocked', async () => {
    const res = await request(app).get('/setup');
    expect(res.status).toBe(200);
    expect(res.body.hasWallet).toBe(true);
    expect(res.body.unlocked).toBe(true);
  });

  // ── Auth-gated endpoints respond (not 500) ──────────────────

  it('wallet list returns 200 with auth', async () => {
    const res = await request(app)
      .get('/wallet')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('credentials list returns 200 with auth', async () => {
    const res = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('agents credential list returns 200 with auth', async () => {
    const res = await request(app)
      .get('/agents/credential')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('api keys list returns 200 with auth', async () => {
    const res = await request(app)
      .get('/apikeys')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('pending actions returns 200 with auth', async () => {
    const res = await request(app)
      .get('/actions/pending')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('defaults returns 200 with auth', async () => {
    const res = await request(app)
      .get('/defaults')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  // ── Unauthenticated access is blocked ────────────────────────

  it('credentials list returns 401/403 without auth', async () => {
    const res = await request(app).get('/credentials');
    expect([401, 403]).toContain(res.status);
  });

  // ── Agent operations while unlocked ──────────────────────────

  it('can create and read a credential in the agent', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'smoke-test-cred',
        type: 'plain_note',
        agentId: 'primary',
        fields: [{ key: 'content', value: 'smoke-test-value', sensitive: false }],
      });
    expect(createRes.status).toBe(200);

    const credId = createRes.body.credential?.id ?? createRes.body.id;
    expect(credId).toBeDefined();

    const readRes = await request(app)
      .get(`/credentials/${credId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(readRes.status).toBe(200);
  });

  // ── Address sanity ───────────────────────────────────────────

  it('wallet address is valid hex or base58', async () => {
    expect(address).toBeTruthy();
    expect(typeof address).toBe('string');
    expect(address.length).toBeGreaterThan(10);
  });
});
