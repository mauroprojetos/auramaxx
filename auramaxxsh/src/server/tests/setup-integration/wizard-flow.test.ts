/**
 * Wizard Flow Integration Test
 * =============================
 * Full happy path: agent creation → configure all 3 services → verify setup status.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  startFreshServer,
  teardownServer,
  fetchSetup,
  createAgentViaApi,
  unlockAgentViaApi,
  saveApiKey,
  validateApiKey,
  saveAdapter,
  restartAdapters,
  testAdapter,
  mockExternalResponse,
  clearMocks,
  getAdminToken,
  testPrisma,
} from './harness';
import { lock } from '../../lib/cold';

describe('Full Wizard Flow', () => {
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

  it('Step 1: create agent', async () => {
    const result = await createAgentViaApi();
    expect(result.address).toBeDefined();
    expect(result.mnemonic).toBeDefined();
  });

  it('Step 2: validate and save Anthropic key', async () => {
    const token = getAdminToken();

    // Mock Anthropic validation
    mockExternalResponse('api.anthropic.com', 200, {
      id: 'msg_test',
      content: [{ type: 'text', text: 'ok' }],
    });

    // Validate first
    const validation = await validateApiKey(token, 'anthropic', 'sk-ant-test-key');
    expect(validation.valid).toBe(true);

    // Save
    const saved = (await saveApiKey(token, 'anthropic', 'default', 'sk-ant-test-key')) as { success: boolean };
    expect(saved.success).toBe(true);

    // Verify setup status updated
    const status = (await fetchSetup(token)) as { apiKeys: { anthropic: boolean } };
    expect(status.apiKeys.anthropic).toBe(true);
  });

  it('Step 3: validate and save Alchemy key', async () => {
    const token = getAdminToken();

    // Mock Alchemy validation
    mockExternalResponse('g.alchemy.com', 200, {
      jsonrpc: '2.0',
      id: 1,
      result: '0x134b3a8',
    });

    const validation = await validateApiKey(token, 'alchemy', 'test-alchemy-key');
    expect(validation.valid).toBe(true);

    const saved = (await saveApiKey(token, 'alchemy', 'default', 'test-alchemy-key')) as { success: boolean };
    expect(saved.success).toBe(true);

    const status = (await fetchSetup(token)) as { apiKeys: { alchemy: boolean; anthropic: boolean } };
    expect(status.apiKeys.alchemy).toBe(true);
    expect(status.apiKeys.anthropic).toBe(true);
  });

  it('Step 4: validate Telegram bot, save config, and test', async () => {
    const token = getAdminToken();

    // Mock Telegram getMe validation
    mockExternalResponse('api.telegram.org', 200, {
      ok: true,
      result: { id: 123, is_bot: true, username: 'AuraTestBot' },
    });

    // Validate bot token
    const validation = await validateApiKey(token, 'adapter:telegram', '123456:ABC-DEF');
    expect(validation.valid).toBe(true);
    expect(validation.info).toEqual({ botUsername: 'AuraTestBot' });

    // Save bot token
    await saveApiKey(token, 'adapter:telegram', 'botToken', '123456:ABC-DEF');

    // Save adapter config with chatId
    await saveAdapter(token, 'telegram', true, { chatId: '999999' });

    // Mock sendMessage for test
    clearMocks();
    mockExternalResponse('api.telegram.org', 200, {
      ok: true,
      result: { message_id: 42 },
    });

    // Test adapter
    const testResult = await testAdapter(token, 'telegram');
    expect(testResult.success).toBe(true);
  });

  it('Step 5: setup status shows all configured', async () => {
    const token = getAdminToken();
    const status = (await fetchSetup(token)) as {
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
