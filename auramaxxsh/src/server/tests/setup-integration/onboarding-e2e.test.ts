/**
 * E2E Onboarding Test — Full Agent Flow
 * ======================================
 * Tests the complete onboarding path an agent takes from zero to fully configured.
 * Unlike terminal-flow.test.ts which uses the admin token directly, this test
 * bootstraps an agent token via the public /auth → approve → poll flow, verifying
 * that an agent can go from unconfigured to fully set up using only the public API.
 *
 * Steps:
 *  1-4:  Health → fresh state → agent creation → post-agent state
 *  5-7:  Agent token request → human approval → token retrieval
 *  8-10: API key validation + save (Alchemy, Anthropic, Telegram bot token)
 * 11-13: Telegram setup-link → detect-chat → save adapter
 * 14-16: Restart adapters → test adapter → final state verification
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  startFreshServer,
  teardownServer,
  fetchSetup,
  createAgentViaApi,
  saveApiKey,
  validateApiKey,
  saveAdapter,
  restartAdapters,
  testAdapter,
  mockExternalResponse,
  clearMocks,
  getTestPort,
  getAdminToken,
} from './harness';

const { publicKey: ONBOARDING_TEST_PUBKEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ONBOARDING_TEST_PUBKEY = Buffer.from(ONBOARDING_TEST_PUBKEY_PEM, 'utf8').toString('base64');

/** Helper to make requests to the local test server using originalFetch via raw HTTP */
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

describe('E2E Onboarding — Full Agent Flow', () => {
  let agentToken: string;

  beforeAll(async () => {
    await startFreshServer();
  });

  afterAll(async () => {
    await teardownServer();
  });

  beforeEach(() => {
    clearMocks();
  });

  // ─── Steps 1-4: Server state + Agent creation ───────────────

  it('Step 1: health check returns OK', async () => {
    const { status } = await serverFetch('/health');
    expect(status).toBe(200);
  });

  it('Step 2: fresh state — no wallet', async () => {
    const status = (await fetchSetup()) as { hasWallet: boolean; unlocked: boolean };
    expect(status.hasWallet).toBe(false);
  });

  it('Step 3: create agent via dashboard API', async () => {
    const result = await createAgentViaApi();
    expect(result.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(result.mnemonic.split(' ').length).toBe(12);
    expect(result.token).toBeDefined();
  });

  it('Step 4: post-agent state — wallet exists, unlocked', async () => {
    const status = (await fetchSetup()) as { hasWallet: boolean; unlocked: boolean };
    expect(status.hasWallet).toBe(true);
    expect(status.unlocked).toBe(true);
  });

  // ─── Steps 5-7: Agent token bootstrap ────────────────────────

  it('Step 5: agent requests access token (no auth)', async () => {
    const { status, body } = await serverFetch('/auth', {
      method: 'POST',
      body: {
        agentId: 'onboarding-test-agent',
        permissions: ['trade:all', 'apikey:set', 'adapter:manage', 'action:create'],
        limits: { fund: 0.5, send: 1.0, swap: 0.5 },
        ttl: 3600,
        pubkey: ONBOARDING_TEST_PUBKEY,
      },
    });

    expect(status).toBe(200);
    expect(body.requestId).toBeDefined();
    expect(body.secret).toBeDefined();

    // Stash for next steps
    (globalThis as Record<string, unknown>).__e2e_requestId = body.requestId;
    (globalThis as Record<string, unknown>).__e2e_secret = body.secret;
  });

  it('Step 6: human approves the token request', async () => {
    const requestId = (globalThis as Record<string, unknown>).__e2e_requestId as string;
    const adminToken = getAdminToken();

    const { status, body } = await serverFetch(`/actions/${requestId}/resolve`, {
      method: 'POST',
      token: adminToken,
      body: { approved: true },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('Step 7: agent retrieves approved token', async () => {
    const requestId = (globalThis as Record<string, unknown>).__e2e_requestId as string;
    const secret = (globalThis as Record<string, unknown>).__e2e_secret as string;

    const { status, body } = await serverFetch(`/auth/${requestId}`, {
      headers: { 'x-aura-claim-secret': secret },
    });

    expect(status).toBe(200);
    expect(body.status).toBe('approved');
    expect(body.token).toBeDefined();

    agentToken = body.token as string;
  });

  // ─── Steps 8-10: API key validation + save ───────────────────

  it('Step 8: validate + save Alchemy key', async () => {
    mockExternalResponse('g.alchemy.com', 200, {
      jsonrpc: '2.0',
      id: 1,
      result: '0x1',
    });

    const validation = await validateApiKey(agentToken, 'alchemy', 'test-alchemy-key');
    expect(validation.valid).toBe(true);

    const saved = (await saveApiKey(agentToken, 'alchemy', 'default', 'test-alchemy-key')) as { success: boolean };
    expect(saved.success).toBe(true);
  });

  it('Step 9: validate + save Anthropic key', async () => {
    mockExternalResponse('api.anthropic.com', 200, {
      id: 'msg_test',
      content: [{ type: 'text', text: 'ok' }],
    });

    const validation = await validateApiKey(agentToken, 'anthropic', 'sk-ant-e2e-key');
    expect(validation.valid).toBe(true);

    const saved = (await saveApiKey(agentToken, 'anthropic', 'default', 'sk-ant-e2e-key')) as { success: boolean };
    expect(saved.success).toBe(true);
  });

  it('Step 10: validate + save Telegram bot token', async () => {
    mockExternalResponse('api.telegram.org', 200, {
      ok: true,
      result: { id: 999, is_bot: true, username: 'E2ETestBot' },
    });

    const validation = await validateApiKey(agentToken, 'adapter:telegram', '999:BOTTOKEN');
    expect(validation.valid).toBe(true);
    expect(validation.info).toEqual({ botUsername: 'E2ETestBot' });

    const saved = (await saveApiKey(agentToken, 'adapter:telegram', 'botToken', '999:BOTTOKEN')) as { success: boolean };
    expect(saved.success).toBe(true);
  });

  // ─── Steps 11-13: Telegram setup-link + detect-chat + save ──

  it('Step 11: get Telegram setup link', async () => {
    // Mock getMe for setup-link validation
    mockExternalResponse('api.telegram.org', 200, {
      ok: true,
      result: { id: 999, is_bot: true, username: 'E2ETestBot' },
    });

    const { status, body } = await serverFetch('/adapters/telegram/setup-link', {
      method: 'POST',
      token: agentToken,
      body: { botToken: '999:BOTTOKEN' },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.setupToken).toBeDefined();
    expect(body.botUsername).toBe('E2ETestBot');

    (globalThis as Record<string, unknown>).__e2e_setupToken = body.setupToken;
  });

  it('Step 12: detect chat via /start message', async () => {
    const setupToken = (globalThis as Record<string, unknown>).__e2e_setupToken as string;

    // Mock getUpdates to return a /start message with our setupToken
    clearMocks();
    mockExternalResponse('api.telegram.org', 200, {
      ok: true,
      result: [
        {
          update_id: 1001,
          message: {
            text: `/start ${setupToken}`,
            chat: { id: 777888, first_name: 'TestUser', username: 'testuser' },
          },
        },
      ],
    });

    const { status, body } = await serverFetch('/adapters/telegram/detect-chat', {
      method: 'POST',
      token: agentToken,
      body: { setupToken },
    });

    expect(status).toBe(200);
    expect(body.chatId).toBe('777888');
    expect(body.firstName).toBe('TestUser');
    expect(body.username).toBe('testuser');
    expect(body.verified).toBe(true);
  });

  it('Step 13: save Telegram adapter config', async () => {
    const saved = await saveAdapter(agentToken, 'telegram', true, { chatId: '777888' });
    expect((saved as { success: boolean }).success).toBe(true);
  });

  // ─── Steps 14-16: Restart + test + final verification ────────

  it('Step 14: restart adapters', async () => {
    // Mock Telegram getMe for adapter restart
    mockExternalResponse('api.telegram.org', 200, {
      ok: true,
      result: { id: 999, is_bot: true, username: 'E2ETestBot' },
    });

    const result = await restartAdapters(agentToken);
    expect(result).toBeDefined();
  });

  it('Step 15: test Telegram adapter', async () => {
    clearMocks();
    mockExternalResponse('api.telegram.org', 200, {
      ok: true,
      result: { message_id: 42 },
    });

    const result = await testAdapter(agentToken, 'telegram');
    expect(result.success).toBe(true);
  });

  it('Step 16: final setup status — everything configured', async () => {
    const status = (await fetchSetup(agentToken)) as {
      hasWallet: boolean;
      unlocked: boolean;
      apiKeys: { alchemy: boolean; anthropic: boolean };
      adapters: { telegram: boolean };
    };

    expect(status.hasWallet).toBe(true);
    expect(status.unlocked).toBe(true);
    expect(status.apiKeys.alchemy).toBe(true);
    expect(status.apiKeys.anthropic).toBe(true);
    expect(status.adapters.telegram).toBe(true);
  });
});
