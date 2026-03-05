/**
 * Terminal Flow Integration Test
 * ==============================
 * Tests the API call sequence that the terminal setup flow performs.
 * No readline mocking — just verifies the server endpoints work in the
 * exact order the terminal flow calls them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  startFreshServer,
  startInitializedServer,
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
  getAdminToken,
} from './harness';

describe('Terminal Flow — Full Setup', () => {
  beforeAll(async () => {
    await startFreshServer();
  });

  afterAll(async () => {
    await teardownServer();
  });

  beforeEach(() => {
    clearMocks();
  });

  it('Step 0: server starts unconfigured', async () => {
    const status = (await fetchSetup()) as { hasWallet: boolean };
    expect(status.hasWallet).toBe(false);
  });

  it('Step 1: create agent via encrypted password (mirrors terminal flow)', async () => {
    const result = await createAgentViaApi();

    expect(result.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(result.mnemonic.split(' ').length).toBe(12);
    expect(result.token).toBeDefined();
  });

  it('Step 2: validate + save Anthropic key', async () => {
    const token = getAdminToken();

    mockExternalResponse('api.anthropic.com', 200, {
      id: 'msg_test',
      content: [{ type: 'text', text: 'ok' }],
    });

    const validation = await validateApiKey(token, 'anthropic', 'sk-ant-terminal-key');
    expect(validation.valid).toBe(true);

    const saved = (await saveApiKey(token, 'anthropic', 'default', 'sk-ant-terminal-key')) as { success: boolean };
    expect(saved.success).toBe(true);
  });

  it('Step 3: validate + save Alchemy key', async () => {
    const token = getAdminToken();

    mockExternalResponse('g.alchemy.com', 200, {
      jsonrpc: '2.0',
      id: 1,
      result: '0x134b3a8',
    });

    const validation = await validateApiKey(token, 'alchemy', 'terminal-alchemy-key');
    expect(validation.valid).toBe(true);

    const saved = (await saveApiKey(token, 'alchemy', 'default', 'terminal-alchemy-key')) as { success: boolean };
    expect(saved.success).toBe(true);
  });

  it('Step 4: validate Telegram bot + save config + test', async () => {
    const token = getAdminToken();

    // Validate bot token
    mockExternalResponse('api.telegram.org', 200, {
      ok: true,
      result: { id: 123, is_bot: true, username: 'TerminalTestBot' },
    });

    const validation = await validateApiKey(token, 'adapter:telegram', '111222:XYZ');
    expect(validation.valid).toBe(true);
    expect(validation.info).toEqual({ botUsername: 'TerminalTestBot' });

    // Save bot token
    await saveApiKey(token, 'adapter:telegram', 'botToken', '111222:XYZ');

    // Save adapter config with chatId
    await saveAdapter(token, 'telegram', true, { chatId: '123456' });

    // Mock sendMessage for test
    clearMocks();
    mockExternalResponse('api.telegram.org', 200, {
      ok: true,
      result: { message_id: 1 },
    });

    const testResult = await testAdapter(token, 'telegram');
    expect(testResult.success).toBe(true);
  });

  it('Step 5: final setup status shows everything configured', async () => {
    const token = getAdminToken();
    const status = (await fetchSetup(token)) as {
      hasWallet: boolean;
      unlocked: boolean;
      apiKeys: { alchemy: boolean; anthropic: boolean };
      adapters: { telegram: boolean };
    };

    expect(status.hasWallet).toBe(true);
    expect(status.unlocked).toBe(true);
    expect(status.apiKeys.anthropic).toBe(true);
    expect(status.apiKeys.alchemy).toBe(true);
    expect(status.adapters.telegram).toBe(true);
  });
});

describe('Terminal Flow — Agent Only (skip all optional)', () => {
  beforeAll(async () => {
    await startFreshServer();
  });

  afterAll(async () => {
    await teardownServer();
  });

  it('should create agent and show defaults with no optional config', async () => {
    const result = await createAgentViaApi();
    expect(result.address).toBeDefined();

    const token = getAdminToken();
    const status = (await fetchSetup(token)) as {
      hasWallet: boolean;
      unlocked: boolean;
      apiKeys: { alchemy: boolean; anthropic: boolean };
      adapters: { telegram: boolean };
    };

    expect(status.hasWallet).toBe(true);
    expect(status.unlocked).toBe(true);
    expect(status.apiKeys.anthropic).toBe(false);
    expect(status.apiKeys.alchemy).toBe(false);
    expect(status.adapters.telegram).toBe(false);
  });
});

describe('Terminal Flow — Invalid Key + Save Anyway', () => {
  let token: string;

  beforeAll(async () => {
    const result = await startInitializedServer();
    token = result.adminToken;
  });

  afterAll(async () => {
    await teardownServer();
  });

  beforeEach(() => {
    clearMocks();
  });

  it('should allow saving an invalid key (save anyway path)', async () => {
    // Validate returns invalid
    mockExternalResponse('api.anthropic.com', 401, {
      error: { type: 'authentication_error', message: 'Invalid API key' },
    });

    const validation = await validateApiKey(token, 'anthropic', 'sk-ant-bad-key');
    expect(validation.valid).toBe(false);

    // User chooses "save anyway" — just save directly
    const saved = (await saveApiKey(token, 'anthropic', 'default', 'sk-ant-bad-key')) as { success: boolean };
    expect(saved.success).toBe(true);

    // Verify it shows as configured
    const status = (await fetchSetup(token)) as { apiKeys: { anthropic: boolean } };
    expect(status.apiKeys.anthropic).toBe(true);
  });

  it('should handle network error during validation gracefully', async () => {
    // Unmocked external call returns 500 from harness
    const validation = await validateApiKey(token, 'alchemy', 'some-key');

    // The harness returns 500 for unmocked calls — server should handle this
    // Either valid=false or an error — either way, saving should still work
    const saved = (await saveApiKey(token, 'alchemy', 'default', 'some-key')) as { success: boolean };
    expect(saved.success).toBe(true);
  });
});
