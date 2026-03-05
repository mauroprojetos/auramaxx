/**
 * Tests for server/lib/auto-execute.ts
 *
 * Unit tests for the shared auto-execute helper that fires pre-computed
 * actions after human approval.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../../lib/events', () => ({
  emitWalletEvent: vi.fn(),
}));

vi.mock('../../lib/strategy/engine', () => ({
  handleAppMessage: vi.fn().mockResolvedValue({ reply: null }),
}));

vi.mock('../../lib/defaults', () => ({
  getDefaultSync: vi.fn().mockReturnValue('3,120000'),
  parseRateLimit: vi.fn().mockReturnValue({ max: 3, windowMs: 120_000 }),
}));

vi.mock('../../lib/logger', () => ({
  logger: {
    actionResolved: vi.fn(),
  },
}));

vi.mock('../../lib/error', () => ({
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

import { autoExecuteAction, canFireCallback } from '../../lib/auto-execute';
import { emitWalletEvent } from '../../lib/events';
import { handleAppMessage } from '../../lib/strategy/engine';

describe('auto-execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the internal callbackCounts map by clearing module state
    // We can't directly access the Map, but canFireCallback resets per window
  });

  describe('autoExecuteAction', () => {
    it('returns { executed: false } when endpoint is missing', async () => {
      const result = await autoExecuteAction(
        { endpoint: '', method: 'POST' },
        { requestId: 'req-1', agentId: 'test-agent', token: 'tok-1' },
      );
      expect(result.executed).toBe(false);
    });

    it('returns { executed: false } when method is missing', async () => {
      const result = await autoExecuteAction(
        { endpoint: '/send', method: '' },
        { requestId: 'req-1', agentId: 'test-agent', token: 'tok-1' },
      );
      expect(result.executed).toBe(false);
    });

    it('executes a successful POST action and emits WebSocket event', async () => {
      const mockResponse = { success: true, txHash: '0xabc' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify(mockResponse)),
      }));

      const result = await autoExecuteAction(
        { endpoint: '/send', method: 'POST', body: { to: '0x123', amount: '0.01' } },
        { requestId: 'req-1', agentId: 'app:my-app', summary: 'Send 0.01 ETH', token: 'tok-1' },
      );

      expect(result.executed).toBe(true);
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.result).toEqual(mockResponse);

      // Verify fetch was called with correct args
      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:4242/send',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer tok-1',
          },
          body: JSON.stringify({ to: '0x123', amount: '0.01' }),
        }),
      );

      // Verify WebSocket event emitted
      expect(emitWalletEvent).toHaveBeenCalledWith('app:emit', {
        strategyId: 'my-app',
        channel: 'action:executed',
        data: expect.objectContaining({
          requestId: 'req-1',
          approved: true,
          status: 'success',
          statusCode: 200,
        }),
      });

      vi.unstubAllGlobals();
    });

    it('handles failed action (non-ok response) and emits error event', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: vi.fn().mockResolvedValue(JSON.stringify({ error: 'Forbidden' })),
      }));

      const result = await autoExecuteAction(
        { endpoint: '/send', method: 'POST', body: { to: '0x123' } },
        { requestId: 'req-2', agentId: 'app:my-app', token: 'tok-2' },
      );

      expect(result.executed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(403);

      // Verify WebSocket event emitted with error status
      expect(emitWalletEvent).toHaveBeenCalledWith('app:emit', {
        strategyId: 'my-app',
        channel: 'action:executed',
        data: expect.objectContaining({
          status: 'error',
          statusCode: 403,
        }),
      });

      vi.unstubAllGlobals();
    });

    it('handles fetch network error and emits error event', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      const result = await autoExecuteAction(
        { endpoint: '/send', method: 'POST' },
        { requestId: 'req-3', agentId: 'app:my-app', token: 'tok-3' },
      );

      expect(result.executed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');

      // Verify error event emitted
      expect(emitWalletEvent).toHaveBeenCalledWith('app:emit', {
        strategyId: 'my-app',
        channel: 'action:executed',
        data: expect.objectContaining({
          status: 'error',
          error: 'ECONNREFUSED',
        }),
      });

      vi.unstubAllGlobals();
    });

    it('strips app: prefix from agentId for strategyId', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('{}'),
      }));

      await autoExecuteAction(
        { endpoint: '/wallets', method: 'GET' },
        { requestId: 'req-4', agentId: 'app:kanban-board', token: 'tok-4' },
      );

      expect(emitWalletEvent).toHaveBeenCalledWith('app:emit', expect.objectContaining({
        strategyId: 'kanban-board',
      }));

      vi.unstubAllGlobals();
    });

    it('does not send body for GET requests', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('[]'),
      }));

      await autoExecuteAction(
        { endpoint: '/wallets', method: 'GET', body: { unused: true } },
        { requestId: 'req-5', agentId: 'test-agent', token: 'tok-5' },
      );

      // method is GET so body should be undefined even though body was provided
      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:4242/wallets',
        expect.objectContaining({
          method: 'GET',
          body: undefined,
        }),
      );

      vi.unstubAllGlobals();
    });

    it('feeds result back to app AI via handleAppMessage on success', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ success: true })),
      }));

      // Use a unique appId to avoid rate-limit exhaustion from other tests
      await autoExecuteAction(
        { endpoint: '/send', method: 'POST' },
        { requestId: 'req-6', agentId: `app:callback-success-${Date.now()}`, summary: 'Send ETH', token: 'tok-6' },
      );

      // Wait for the async callback
      await new Promise(r => setTimeout(r, 50));

      expect(handleAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('callback-success-'),
        expect.stringContaining('[SYSTEM] Action "Send ETH" approved and executed successfully'),
      );

      vi.unstubAllGlobals();
    });

    it('feeds error back to app AI via handleAppMessage on failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue(JSON.stringify({ error: 'Internal error' })),
      }));

      // Use a unique appId to avoid rate-limit exhaustion from other tests
      await autoExecuteAction(
        { endpoint: '/send', method: 'POST' },
        { requestId: 'req-7', agentId: `app:callback-fail-${Date.now()}`, summary: 'Send ETH', token: 'tok-7' },
      );

      await new Promise(r => setTimeout(r, 50));

      expect(handleAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('callback-fail-'),
        expect.stringContaining('[SYSTEM] Action "Send ETH" approved but failed (500)'),
      );

      vi.unstubAllGlobals();
    });
  });

  describe('canFireCallback', () => {
    it('allows callbacks within rate limit', () => {
      // Use a unique appId to avoid state leakage
      const appId = `rate-test-${Date.now()}`;
      expect(canFireCallback(appId)).toBe(true);
      expect(canFireCallback(appId)).toBe(true);
      expect(canFireCallback(appId)).toBe(true);
    });

    it('blocks callbacks after exceeding rate limit', () => {
      const appId = `rate-exceed-${Date.now()}`;
      canFireCallback(appId); // 1
      canFireCallback(appId); // 2
      canFireCallback(appId); // 3 (max per mock: 3)
      expect(canFireCallback(appId)).toBe(false);
    });
  });
});
