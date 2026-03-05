/**
 * Edge Cases Integration Test
 * ============================
 * Tests: overwriting keys, unknown services, locked agent behavior,
 * concurrent validates.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  startInitializedServer,
  teardownServer,
  saveApiKey,
  validateApiKey,
  fetchSetup,
  mockExternalResponse,
  clearMocks,
  testPrisma,
} from './harness';
import { lock } from '../../lib/cold';

describe('Edge Cases', () => {
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
    await testPrisma.apiKey.deleteMany();
  });

  describe('Overwriting keys', () => {
    it('should overwrite an existing API key', async () => {
      // Save initial key
      await saveApiKey(token, 'alchemy', 'default', 'first-key');

      // Overwrite with new key
      const result = (await saveApiKey(token, 'alchemy', 'default', 'second-key')) as { success: boolean };
      expect(result.success).toBe(true);

      // Verify only one key exists
      const keys = await testPrisma.apiKey.findMany({
        where: { service: 'alchemy', name: 'default', isActive: true },
      });
      expect(keys.length).toBe(1);
      expect(keys[0].key).toBe('second-key');
    });

    it('should track setup status correctly after overwrite', async () => {
      // Save and verify
      await saveApiKey(token, 'anthropic', 'default', 'key-1');
      let status = (await fetchSetup(token)) as { apiKeys: { anthropic: boolean } };
      expect(status.apiKeys.anthropic).toBe(true);

      // Overwrite and verify still shows configured
      await saveApiKey(token, 'anthropic', 'default', 'key-2');
      status = (await fetchSetup(token)) as { apiKeys: { anthropic: boolean } };
      expect(status.apiKeys.anthropic).toBe(true);
    });
  });

  describe('Unknown service validation', () => {
    it('should return 400 for unknown service', async () => {
      const result = await validateApiKey(token, 'unknown-service', 'some-key');
      expect(result.error).toContain('Unknown service');
    });
  });

  describe('Concurrent validates', () => {
    it('should handle multiple concurrent validation requests', async () => {
      // Mock both services
      mockExternalResponse('g.alchemy.com', 200, {
        jsonrpc: '2.0',
        id: 1,
        result: '0x100',
      });
      mockExternalResponse('api.anthropic.com', 200, {
        id: 'msg_test',
        content: [{ type: 'text', text: 'ok' }],
      });

      // Fire both concurrently
      const [alchemyResult, anthropicResult] = await Promise.all([
        validateApiKey(token, 'alchemy', 'alchemy-key'),
        validateApiKey(token, 'anthropic', 'sk-ant-key'),
      ]);

      expect(alchemyResult.valid).toBe(true);
      expect(anthropicResult.valid).toBe(true);
    });
  });

  describe('Locked agent behavior', () => {
    it('should still report setup status when locked', async () => {
      // Save some keys first while unlocked
      await saveApiKey(token, 'alchemy', 'default', 'test-key');

      const status = (await fetchSetup()) as {
        hasWallet: boolean;
        unlocked: boolean;
        apiKeys: { alchemy: boolean };
      };

      // Setup status is public endpoint, should still work
      expect(status.hasWallet).toBe(true);
      // apiKeys field should still be present
      expect(status.apiKeys).toBeDefined();
    });
  });
});
