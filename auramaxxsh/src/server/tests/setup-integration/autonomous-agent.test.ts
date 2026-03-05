/**
 * Autonomous Agent Agent Test
 * ===========================
 * Tests the fully autonomous agent flow: agent creates its own agent,
 * gets an admin token, survives a simulated server restart by re-unlocking
 * with the stored password, and bootstraps a scoped agent token.
 *
 * This simulates what happens when an agent uses:
 *  - MCP `create_agent` tool (RSA encrypt + POST /setup)
 *  - CLI `npx auramaxx init --password "pass"` (same flow)
 *  - POST /unlock to recover after restart
 *
 * Steps:
 *  1-2:  Health check → fresh state
 *  3-4:  Create agent with agent password → verify state
 *  5:    Admin token works (list wallets)
 *  6:    Duplicate agent creation rejected
 *  7-9:  Simulate restart → old token dead → unlock with stored password
 * 10-12: Bootstrap scoped agent token → approve → use
 * 13:    Create hot wallet with scoped token
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startFreshServer,
  teardownServer,
  fetchSetup,
  getTestPort,
} from './harness';
import { encryptPasswordForTest, TEST_AGENT_PUBKEY } from '../setup';
import { lock } from '../../lib/cold';
import { revokeAdminTokens } from '../../lib/auth';

const AGENT_PASSWORD = 'autonomous-agent-pass-42';

/** Helper to make requests to the local test server */
async function serverFetch(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `http://127.0.0.1:${getTestPort()}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.headers) Object.assign(headers, opts.headers);

  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json();
  return { status: res.status, body: body as Record<string, unknown> };
}

describe('Autonomous Agent — Self-Managed Agent', () => {
  let adminToken: string;
  let coldAddress: string;

  beforeAll(async () => {
    await startFreshServer();
  });

  afterAll(async () => {
    await teardownServer();
  });

  // ─── Steps 1-2: Fresh state ────────────────────────────────────

  it('Step 1: health check returns OK', async () => {
    const { status } = await serverFetch('/health');
    expect(status).toBe(200);
  });

  it('Step 2: fresh state — no wallet', async () => {
    const status = (await fetchSetup()) as { hasWallet: boolean; unlocked: boolean };
    expect(status.hasWallet).toBe(false);
    expect(status.unlocked).toBe(false);
  });

  // ─── Steps 3-4: Agent creates agent ────────────────────────────

  it('Step 3: agent creates agent with own password', async () => {
    // This simulates what MCP create_agent does: encrypt + POST /setup
    const encrypted = encryptPasswordForTest(AGENT_PASSWORD);
    const { status, body } = await serverFetch('/setup', {
      method: 'POST',
      body: { encrypted, pubkey: TEST_AGENT_PUBKEY },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect((body.mnemonic as string).split(' ').length).toBe(12);
    expect(body.token).toBeDefined();

    adminToken = body.token as string;
    coldAddress = body.address as string;
  });

  it('Step 4: agent exists and is unlocked', async () => {
    const status = (await fetchSetup()) as {
      hasWallet: boolean;
      unlocked: boolean;
      address: string;
    };
    expect(status.hasWallet).toBe(true);
    expect(status.unlocked).toBe(true);
    expect(status.address).toBe(coldAddress);
  });

  // ─── Step 5: Admin token works ─────────────────────────────────

  it('Step 5: admin token from agent creation works', async () => {
    const { status, body } = await serverFetch('/wallets', { token: adminToken });
    expect(status).toBe(200);

    const wallets = body.wallets as Array<{ address: string; tier: string }>;
    expect(wallets.length).toBeGreaterThanOrEqual(1);
    const cold = wallets.find((w) => w.tier === 'cold');
    expect(cold).toBeDefined();
    expect(cold!.address.toLowerCase()).toBe(coldAddress.toLowerCase());
  });

  // ─── Step 6: One-agent guard ───────────────────────────────────

  it('Step 6: duplicate agent creation rejected', async () => {
    const encrypted = encryptPasswordForTest(AGENT_PASSWORD);
    const { status, body } = await serverFetch('/setup', {
      method: 'POST',
      body: { encrypted, pubkey: TEST_AGENT_PUBKEY },
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/already exists/i);
  });

  // ─── Steps 7-9: Simulate restart → re-unlock ──────────────────

  it('Step 7: simulate server restart (lock + revoke tokens)', () => {
    lock();
    revokeAdminTokens();
  });

  it('Step 8: old admin token is rejected on auth-required endpoint', async () => {
    // Use POST /wallet/create which requires auth (unlike GET /wallets which is optionalAuth)
    const { status } = await serverFetch('/wallet/create', {
      method: 'POST',
      token: adminToken,
      body: { tier: 'hot', name: 'should-fail', chain: 'base' },
    });
    expect(status).toBe(401);
  });

  it('Step 9: agent re-unlocks with stored password', async () => {
    const encrypted = encryptPasswordForTest(AGENT_PASSWORD);
    const { status, body } = await serverFetch('/unlock', {
      method: 'POST',
      body: { encrypted, pubkey: TEST_AGENT_PUBKEY },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.token).toBeDefined();

    adminToken = body.token as string;
  });

  it('Step 10: new admin token works after re-unlock', async () => {
    const { status, body } = await serverFetch('/wallets', { token: adminToken });
    expect(status).toBe(200);
    const wallets = body.wallets as Array<{ address: string }>;
    expect(wallets.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Steps 11-13: Bootstrap scoped agent token ─────────────────

  it('Step 11: agent requests scoped token', async () => {
    const { status, body } = await serverFetch('/auth', {
      method: 'POST',
      body: {
        agentId: 'autonomous-agent',
        permissions: ['trade:all', 'action:create'],
        limits: { fund: 0.1, send: 0.5, swap: 0.5 },
        ttl: 3600,
        pubkey: TEST_AGENT_PUBKEY,
      },
    });

    expect(status).toBe(200);
    expect(body.requestId).toBeDefined();
    expect(body.secret).toBeDefined();

    (globalThis as Record<string, unknown>).__auto_requestId = body.requestId;
    (globalThis as Record<string, unknown>).__auto_secret = body.secret;
  });

  it('Step 12: agent approves own token request (admin)', async () => {
    const requestId = (globalThis as Record<string, unknown>).__auto_requestId as string;

    const { status, body } = await serverFetch(`/actions/${requestId}/resolve`, {
      method: 'POST',
      token: adminToken,
      body: { approved: true },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('Step 13: agent retrieves scoped token', async () => {
    const requestId = (globalThis as Record<string, unknown>).__auto_requestId as string;
    const secret = (globalThis as Record<string, unknown>).__auto_secret as string;

    const { status, body } = await serverFetch(`/auth/${requestId}`, {
      headers: { 'x-aura-claim-secret': secret },
    });

    expect(status).toBe(200);
    expect(body.status).toBe('approved');
    expect(body.token).toBeDefined();

    (globalThis as Record<string, unknown>).__auto_scopedToken = body.token;
  });

  // ─── Step 14: Use scoped token ─────────────────────────────────

  it('Step 14: create hot wallet with scoped token', async () => {
    const scopedToken = (globalThis as Record<string, unknown>).__auto_scopedToken as string;

    const { status, body } = await serverFetch('/wallet/create', {
      method: 'POST',
      token: scopedToken,
      body: { tier: 'hot', name: 'agent-trading', chain: 'base' },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const wallet = body.wallet as { address: string; name: string; tier: string };
    expect(wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(wallet.name).toBe('agent-trading');
    expect(wallet.tier).toBe('hot');
  });
});
