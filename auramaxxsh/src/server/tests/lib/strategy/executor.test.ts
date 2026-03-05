/**
 * Tests for strategy action executor
 *
 * Tests:
 * - executeAction paper mode — logs and returns success
 * - executeAction internal URL rewriting (/ -> http://127.0.0.1:4242/)
 * - executeAction external URL passthrough
 * - executeAction error handling
 * - createStrategyToken (mock createToken)
 * - revokeStrategyToken (mock revokeToken)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before import
vi.mock('../../../lib/auth', () => ({
  createToken: vi.fn().mockResolvedValue('mock-strategy-token'),
  getTokenHash: vi.fn().mockReturnValue('mock-hash'),
}));

vi.mock('../../../lib/sessions', () => ({
  revokeToken: vi.fn().mockResolvedValue(true),
  registerToken: vi.fn(),
}));

vi.mock('../../../lib/db', () => ({
  prisma: {
    agentToken: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('../../../lib/network', () => ({
  validateExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

import { executeAction, createStrategyToken, revokeStrategyToken } from '../../../lib/strategy/executor';
import { createToken } from '../../../lib/auth';
import { revokeToken } from '../../../lib/sessions';
import { validateExternalUrl } from '../../../lib/network';
import type { Action } from '../../../lib/strategy/types';

describe('Strategy Executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('executeAction() — internal calls', () => {
    it('should rewrite / endpoints to localhost:4242', async () => {
      const mockResponse = { ok: true, json: () => Promise.resolve({ success: true, txHash: '0x123' }) };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const action: Action = { endpoint: '/send', method: 'POST', body: { from: '0x1', to: '0x2', amount: '1000000000000000000' } };
      const result = await executeAction(action, 'test', 'my-token');

      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:4242/send',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer my-token',
          }),
        }),
      );
      expect(result.success).toBe(true);
    });

    it('should include bearer token for internal calls', async () => {
      const mockResponse = { ok: true, json: () => Promise.resolve({}) };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const action: Action = { endpoint: '/wallets', method: 'GET' };
      await executeAction(action, 'test', 'secret-token');

      const calledHeaders = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
      expect(calledHeaders.Authorization).toBe('Bearer secret-token');
    });

    it('should not include Authorization header when no token', async () => {
      const mockResponse = { ok: true, json: () => Promise.resolve({}) };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const action: Action = { endpoint: '/wallets', method: 'GET' };
      await executeAction(action, 'test');

      const calledHeaders = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
      expect(calledHeaders.Authorization).toBeUndefined();
    });

    it('should include Content-Type header', async () => {
      const mockResponse = { ok: true, json: () => Promise.resolve({}) };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const action: Action = { endpoint: '/send', method: 'POST', body: { data: true } };
      await executeAction(action, 'test');

      const calledHeaders = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
      expect(calledHeaders['Content-Type']).toBe('application/json');
    });

    it('should JSON stringify the body', async () => {
      const mockResponse = { ok: true, json: () => Promise.resolve({}) };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const body = { to: '0xabc', amount: '1500000000000000000' };
      const action: Action = { endpoint: '/send', method: 'POST', body };
      await executeAction(action, 'test');

      const calledOpts = vi.mocked(fetch).mock.calls[0][1] as any;
      expect(calledOpts.body).toBe(JSON.stringify(body));
    });
  });

  describe('executeAction() — external calls', () => {
    it('should pass external URLs through unchanged', async () => {
      const mockResponse = { ok: true, json: () => Promise.resolve({ data: 'ok' }) };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const action: Action = { endpoint: 'https://api.dexscreener.com/v1/pairs', method: 'GET' };
      const result = await executeAction(action, 'test');

      expect(fetch).toHaveBeenCalledWith(
        'https://api.dexscreener.com/v1/pairs',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(result.success).toBe(true);
    });

    it('should not add bearer token for external calls', async () => {
      const mockResponse = { ok: true, json: () => Promise.resolve({}) };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const action: Action = { endpoint: 'https://external.com/api', method: 'GET' };
      await executeAction(action, 'test', 'my-token');

      const calledHeaders = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
      expect(calledHeaders.Authorization).toBeUndefined();
    });

    it('should pass custom headers for external calls', async () => {
      const mockResponse = { ok: true, json: () => Promise.resolve({}) };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const action: Action = {
        endpoint: 'https://api.opensea.io/v2',
        method: 'POST',
        headers: { 'X-API-KEY': 'opensea-key' },
        body: { bid: 1 },
      };
      await executeAction(action, 'test');

      const calledHeaders = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
      expect(calledHeaders['X-API-KEY']).toBe('opensea-key');
    });
  });

  describe('executeAction() — auth failure detection', () => {
    it('should throw AUTH_FAILURE for 401 on internal endpoint', async () => {
      const mockResponse = {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: () => Promise.resolve({ error: 'Invalid token' }),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const action: Action = { endpoint: '/wallets', method: 'GET' };
      await expect(executeAction(action, 'test', 'expired-token')).rejects.toThrow('AUTH_FAILURE');
    });

    it('should not throw AUTH_FAILURE for 401 on external endpoint', async () => {
      const mockResponse = {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: () => Promise.resolve({ error: 'Bad key' }),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const action: Action = { endpoint: 'https://api.example.com/data', method: 'GET' };
      const result = await executeAction(action, 'test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('401');
    });
  });

  describe('executeAction() — error handling', () => {
    it('should return error for non-ok response', async () => {
      const mockResponse = {
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: () => Promise.resolve({ error: 'Insufficient permissions' }),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const action: Action = { endpoint: '/send', method: 'POST' };
      const result = await executeAction(action, 'test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('403');
      expect(result.error).toContain('Insufficient permissions');
    });

    it('should handle non-JSON error response', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('not json')),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const action: Action = { endpoint: '/send', method: 'POST' };
      const result = await executeAction(action, 'test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 500');
    });

    it('should handle fetch errors', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const action: Action = { endpoint: '/swap', method: 'POST' };
      const result = await executeAction(action, 'test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    it('should handle non-Error thrown values', async () => {
      vi.mocked(fetch).mockRejectedValue('string error');

      const action: Action = { endpoint: '/wallets', method: 'GET' };
      const result = await executeAction(action, 'test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should reject invalid endpoint format', async () => {
      const action: Action = { endpoint: 'not-a-url', method: 'GET' };
      const result = await executeAction(action, 'test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid endpoint');
    });

    it('should reject ftp:// endpoints', async () => {
      const action: Action = { endpoint: 'ftp://files.example.com/data', method: 'GET' };
      const result = await executeAction(action, 'test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid endpoint');
    });
  });

  describe('executeAction() — SSRF protection', () => {
    it('should block external URL to private IP', async () => {
      vi.mocked(validateExternalUrl).mockRejectedValue(new Error('Host "evil.com" resolves to private IP 127.0.0.1'));

      const action: Action = { endpoint: 'https://evil.com/steal', method: 'GET' };
      const result = await executeAction(action, 'test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('private IP');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should block external URL not in allowedHosts', async () => {
      vi.mocked(validateExternalUrl).mockRejectedValue(new Error('Host "evil.com" is not in the allowed hosts list'));

      const action: Action = { endpoint: 'https://evil.com/api', method: 'GET' };
      const result = await executeAction(action, 'test', undefined, ['api.example.com']);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not in the allowed hosts list');
      expect(validateExternalUrl).toHaveBeenCalledWith('https://evil.com/api', ['api.example.com']);
    });

    it('should allow external URL in allowedHosts', async () => {
      vi.mocked(validateExternalUrl).mockResolvedValue(undefined);
      const mockResponse = { ok: true, json: () => Promise.resolve({ data: 'ok' }) };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const action: Action = { endpoint: 'https://api.example.com/data', method: 'GET' };
      const result = await executeAction(action, 'test', undefined, ['api.example.com']);

      expect(result.success).toBe(true);
      expect(validateExternalUrl).toHaveBeenCalledWith('https://api.example.com/data', ['api.example.com']);
    });

    it('should not validate internal URLs against SSRF', async () => {
      const mockResponse = { ok: true, json: () => Promise.resolve({ success: true }) };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const action: Action = { endpoint: '/wallets', method: 'GET' };
      await executeAction(action, 'test', 'token');

      expect(validateExternalUrl).not.toHaveBeenCalled();
    });

    it('should pass allowedHosts to validateExternalUrl', async () => {
      vi.mocked(validateExternalUrl).mockResolvedValue(undefined);
      const mockResponse = { ok: true, json: () => Promise.resolve({}) };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const hosts = ['api.dexscreener.com', 'api.coingecko.com'];
      const action: Action = { endpoint: 'https://api.dexscreener.com/v1/pairs', method: 'GET' };
      await executeAction(action, 'test', undefined, hosts);

      expect(validateExternalUrl).toHaveBeenCalledWith('https://api.dexscreener.com/v1/pairs', hosts);
    });
  });

  describe('createStrategyToken()', () => {
    it('should create token with strategy agent ID and permissions', async () => {
      const token = await createStrategyToken('my-strategy', ['swap', 'wallet:list']);

      expect(createToken).toHaveBeenCalledWith(
        'strategy:my-strategy',
        0,
        ['swap', 'wallet:list'],
        86400,
      );
      expect(token).toBe('mock-strategy-token');
    });

    it('should pass empty permissions array', async () => {
      await createStrategyToken('minimal', []);

      expect(createToken).toHaveBeenCalledWith('strategy:minimal', 0, [], 86400);
    });

    it('should use 24h TTL', async () => {
      await createStrategyToken('ttl-test', ['fund']);

      const calledTtl = vi.mocked(createToken).mock.calls[0][3];
      expect(calledTtl).toBe(86400);
    });
  });

  describe('revokeStrategyToken()', () => {
    it('should revoke token by hash', async () => {
      const result = await revokeStrategyToken('hash123');
      expect(revokeToken).toHaveBeenCalledWith('hash123');
      expect(result).toBe(true);
    });

    it('should return false when token not found', async () => {
      vi.mocked(revokeToken).mockReturnValue(false as any);

      const result = await revokeStrategyToken('nonexistent');
      expect(result).toBe(false);
    });
  });
});
