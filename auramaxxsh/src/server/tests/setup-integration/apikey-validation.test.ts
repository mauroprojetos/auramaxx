/**
 * API Key Validation Integration Test
 * ====================================
 * Tests the POST /apikeys/validate endpoint with mocked external APIs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  startInitializedServer,
  teardownServer,
  validateApiKey,
  mockExternalResponse,
  clearMocks,
  getAdminToken,
} from './harness';

describe('API Key Validation', () => {
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

  describe('Alchemy validation', () => {
    it('should validate a working Alchemy key', async () => {
      mockExternalResponse('g.alchemy.com', 200, {
        jsonrpc: '2.0',
        id: 1,
        result: '0x134b3a8',
      });

      const result = await validateApiKey(token, 'alchemy', 'test-alchemy-key');

      expect(result.valid).toBe(true);
    });

    it('should reject an invalid Alchemy key', async () => {
      mockExternalResponse('g.alchemy.com', 200, {
        jsonrpc: '2.0',
        id: 1,
        error: { message: 'Invalid API key' },
      });

      const result = await validateApiKey(token, 'alchemy', 'bad-key');

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('Anthropic validation', () => {
    it('should validate a working Anthropic key', async () => {
      mockExternalResponse('api.anthropic.com', 200, {
        id: 'msg_test',
        content: [{ type: 'text', text: 'hi' }],
      });

      const result = await validateApiKey(token, 'anthropic', 'sk-ant-valid-key');

      expect(result.valid).toBe(true);
    });

    it('should accept rate-limited as valid (429)', async () => {
      mockExternalResponse('api.anthropic.com', 429, {
        error: { type: 'rate_limit_error', message: 'Rate limited' },
      });

      const result = await validateApiKey(token, 'anthropic', 'sk-ant-valid-key');

      expect(result.valid).toBe(true);
    });

    it('should reject an invalid Anthropic key (401)', async () => {
      mockExternalResponse('api.anthropic.com', 401, {
        error: { type: 'authentication_error', message: 'Invalid API key' },
      });

      const result = await validateApiKey(token, 'anthropic', 'sk-ant-bad-key');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid');
    });
  });

  describe('Telegram bot token validation', () => {
    it('should validate a working Telegram bot token', async () => {
      mockExternalResponse('api.telegram.org', 200, {
        ok: true,
        result: { id: 123, is_bot: true, username: 'TestBot' },
      });

      const result = await validateApiKey(token, 'adapter:telegram', '123456:ABC-DEF');

      expect(result.valid).toBe(true);
      expect(result.info).toEqual({ botUsername: 'TestBot' });
    });

    it('should reject an invalid Telegram bot token', async () => {
      mockExternalResponse('api.telegram.org', 200, {
        ok: false,
        description: 'Unauthorized',
      });

      const result = await validateApiKey(token, 'adapter:telegram', 'bad-token');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid bot token');
    });
  });
});
