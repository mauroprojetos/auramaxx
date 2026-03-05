/**
 * Adapter Test Integration Test
 * ==============================
 * Tests the POST /adapters/test endpoint with mocked external services.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  startInitializedServer,
  teardownServer,
  testAdapter,
  saveApiKey,
  saveAdapter,
  mockExternalResponse,
  clearMocks,
  testPrisma,
} from './harness';

describe('Adapter Test Endpoint', () => {
  let token: string;

  beforeAll(async () => {
    const result = await startInitializedServer();
    token = result.adminToken;
  });

  afterAll(async () => {
    await teardownServer();
  });

  beforeEach(async () => {
    clearMocks();
    // Clean up adapter-related data between tests
    await testPrisma.apiKey.deleteMany({ where: { service: { startsWith: 'adapter:' } } });
    await testPrisma.appConfig.deleteMany();
  });

  describe('Telegram adapter', () => {
    it('should return 404 when bot token not configured', async () => {
      const result = await testAdapter(token, 'telegram');

      // Should fail because no bot token in DB
      expect(result.error).toContain('not configured');
    });

    it('should return 404 when chat ID not configured', async () => {
      // Save bot token but no adapter config with chatId
      await saveApiKey(token, 'adapter:telegram', 'botToken', '123456:ABC-DEF');

      const result = await testAdapter(token, 'telegram');

      expect(result.error).toContain('not configured');
    });

    it('should send test message when fully configured', async () => {
      // Save bot token
      await saveApiKey(token, 'adapter:telegram', 'botToken', '123456:ABC-DEF');
      // Save adapter config with chatId
      await saveAdapter(token, 'telegram', true, { chatId: '999999' });
      // Mock Telegram sendMessage
      mockExternalResponse('api.telegram.org', 200, {
        ok: true,
        result: { message_id: 1 },
      });

      const result = await testAdapter(token, 'telegram');

      expect(result.success).toBe(true);
    });

    it('should handle Telegram API failure', async () => {
      await saveApiKey(token, 'adapter:telegram', 'botToken', '123456:ABC-DEF');
      await saveAdapter(token, 'telegram', true, { chatId: '999999' });
      mockExternalResponse('api.telegram.org', 200, {
        ok: false,
        description: 'Bad Request: chat not found',
      });

      const result = await testAdapter(token, 'telegram');

      expect(result.success).toBe(false);
      expect(result.error).toContain('chat not found');
    });
  });

  describe('Webhook adapter', () => {
    it('should return 404 when webhook URL not configured', async () => {
      const result = await testAdapter(token, 'webhook');

      expect(result.error).toContain('not configured');
    });

    it('should send test payload when configured', async () => {
      // Save adapter config with webhook URL
      // We need to mock the webhook URL - use a recognizable pattern
      await saveAdapter(token, 'webhook', true, { url: 'https://hooks.example.com/test' });

      // Mock the webhook endpoint
      mockExternalResponse('hooks.example.com', 200, { ok: true });

      const result = await testAdapter(token, 'webhook');

      expect(result.success).toBe(true);
    });

    it('should handle webhook failure', async () => {
      await saveAdapter(token, 'webhook', true, { url: 'https://hooks.example.com/test' });
      mockExternalResponse('hooks.example.com', 500, { error: 'Internal Server Error' });

      const result = await testAdapter(token, 'webhook');

      expect(result.success).toBe(false);
    });
  });

  describe('Unknown adapter type', () => {
    it('should return 400 for unknown type', async () => {
      const result = await testAdapter(token, 'discord');

      expect(result.error).toContain('Unknown');
    });
  });
});
