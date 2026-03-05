/**
 * Tests for message handler
 *
 * Tests:
 * - processMessage calls hook and returns reply
 * - Serial processing per app
 * - Parallel processing across apps
 * - Rate limiting (11th message in 60s rejected)
 * - Missing message hook returns error (tested via engine)
 * - Hook state updates are persisted
 * - Reply extraction: reply field preferred, falls back to log
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
vi.mock('../../../lib/strategy/hooks', () => ({
  callHook: vi.fn(),
}));

vi.mock('../../../lib/strategy/state', () => ({
  getState: vi.fn().mockReturnValue({}),
  updateState: vi.fn(),
  getConfigOverrides: vi.fn().mockResolvedValue({}),
  restoreState: vi.fn().mockResolvedValue(undefined),
  persistState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/strategy/tick', () => ({
  processIntents: vi.fn().mockResolvedValue(undefined),
}));

import { processMessage, clearMessageQueue, clearAllMessageQueues } from '../../../lib/strategy/message';
import { callHook } from '../../../lib/strategy/hooks';
import { getState, updateState, restoreState, persistState } from '../../../lib/strategy/state';
import type { StrategyManifest } from '../../../lib/strategy/types';

function makeManifest(overrides: Partial<StrategyManifest> = {}): StrategyManifest {
  return {
    id: 'test-app',
    name: 'Test App',
    sources: [],
    hooks: { message: 'You are a helpful assistant. Respond to the user message.' },
    config: {},
    permissions: [],
    ...overrides,
  };
}

function makeRuntime(manifest?: StrategyManifest) {
  return { manifest: manifest || makeManifest(), token: 'test-token' };
}

describe('Message Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllMessageQueues();
    vi.mocked(getState).mockReturnValue({});
  });

  describe('processMessage()', () => {
    it('should call hook and return reply', async () => {
      vi.mocked(callHook).mockResolvedValue({
        intents: [],
        state: {},
        reply: 'Hello back!',
      });

      const result = await processMessage(
        { appId: 'test-app', message: 'Hello' },
        makeRuntime(),
      );

      expect(result.reply).toBe('Hello back!');
      expect(result.error).toBeUndefined();
      expect(callHook).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'test-app' }),
        'message',
        expect.objectContaining({ message: 'Hello', appId: 'test-app' }),
        'test-token',
        undefined,
        expect.any(Function),
      );
      expect(restoreState).toHaveBeenCalledWith('test-app');
    });

    it('should restore persisted state before invoking the message hook', async () => {
      vi.mocked(getState).mockReturnValue({ fromStorage: true });
      vi.mocked(callHook).mockResolvedValue({
        intents: [],
        state: {},
        reply: 'ready',
      });

      await processMessage(
        { appId: 'test-app', message: 'hello' },
        makeRuntime(),
      );

      expect(restoreState).toHaveBeenCalledWith('test-app');
      expect(callHook).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'test-app' }),
        'message',
        expect.objectContaining({ state: { fromStorage: true } }),
        'test-token',
        undefined,
        expect.anything(),
      );
    });

    it('should fall back to log when reply is missing', async () => {
      vi.mocked(callHook).mockResolvedValue({
        intents: [],
        state: {},
        log: 'Fallback log message',
      });

      const result = await processMessage(
        { appId: 'test-app', message: 'Hi' },
        makeRuntime(),
      );

      expect(result.reply).toBe('Fallback log message');
    });

    it('should return null reply when no reply and no log', async () => {
      vi.mocked(callHook).mockResolvedValue({
        intents: [],
        state: {},
      });

      const result = await processMessage(
        { appId: 'test-app', message: 'Hi' },
        makeRuntime(),
      );

      expect(result.reply).toBeNull();
    });

    it('should prefer reply over log', async () => {
      vi.mocked(callHook).mockResolvedValue({
        intents: [],
        state: {},
        reply: 'The reply',
        log: 'The log',
      });

      const result = await processMessage(
        { appId: 'test-app', message: 'Hi' },
        makeRuntime(),
      );

      expect(result.reply).toBe('The reply');
    });

    it('should update state when hook returns state changes', async () => {
      vi.mocked(callHook).mockResolvedValue({
        intents: [],
        state: { counter: 1 },
        reply: 'Updated',
      });

      await processMessage(
        { appId: 'test-app', message: 'increment' },
        makeRuntime(),
      );

      expect(updateState).toHaveBeenCalledWith('test-app', { counter: 1 });
      expect(persistState).toHaveBeenCalledWith('test-app');
    });

    it('should not update state when hook returns empty state', async () => {
      vi.mocked(callHook).mockResolvedValue({
        intents: [],
        state: {},
        reply: 'No changes',
      });

      await processMessage(
        { appId: 'test-app', message: 'hello' },
        makeRuntime(),
      );

      expect(updateState).not.toHaveBeenCalled();
    });

    it('should process intents returned by message hook', async () => {
      const { processIntents } = await import('../../../lib/strategy/tick');

      vi.mocked(callHook).mockResolvedValue({
        intents: [{ type: 'swap', token: 'SOL' }],
        state: {},
        reply: 'Swapping SOL',
      });

      await processMessage(
        { appId: 'test-app', message: 'buy SOL' },
        makeRuntime(),
      );

      expect(processIntents).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'test-app' }),
        [{ type: 'swap', token: 'SOL' }],
        expect.any(Object),
        'test-token',
        0,
      );
    });

    it('should pass onProgress callback to callHook', async () => {
      vi.mocked(callHook).mockResolvedValue({
        intents: [],
        state: {},
        reply: 'Done!',
      });

      const onProgress = vi.fn();
      const result = await processMessage(
        { appId: 'test-app', message: 'swap', onProgress },
        makeRuntime(),
      );

      expect(result.reply).toBe('Done!');
      expect(callHook).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'test-app' }),
        'message',
        expect.objectContaining({ message: 'swap', appId: 'test-app' }),
        'test-token',
        onProgress,
        expect.any(Function),
      );
    });

    it('should retry once for ticker lookups when model deflects without tool use', async () => {
      vi.mocked(callHook)
        .mockResolvedValueOnce({
          intents: [],
          state: {},
          reply: "I don't have market cap data. Check CoinGecko.",
          _meta: { toolCallCount: 0 } as any,
        })
        .mockResolvedValueOnce({
          intents: [],
          state: {},
          reply: 'AXIOM on Base has multiple matches. Confirm which contract you want.',
          _meta: { toolCallCount: 1 } as any,
        });

      const result = await processMessage(
        { appId: 'test-app', message: 'What is $axiom market cap on base' },
        makeRuntime(),
      );

      expect(result.reply).toContain('AXIOM');
      expect(callHook).toHaveBeenCalledTimes(2);

      const retryContext = vi.mocked(callHook).mock.calls[1]?.[2] as Record<string, unknown>;
      expect(retryContext.retry).toEqual(
        expect.objectContaining({
          requiredToolCall: expect.stringContaining('/token/search'),
        }),
      );
    });
  });

  describe('serial processing per app', () => {
    it('should process messages serially for the same app', async () => {
      const order: number[] = [];

      vi.mocked(callHook)
        .mockImplementationOnce(async () => {
          order.push(1);
          await new Promise(r => setTimeout(r, 50));
          order.push(2);
          return { intents: [], state: {}, reply: 'first' };
        })
        .mockImplementationOnce(async () => {
          order.push(3);
          return { intents: [], state: {}, reply: 'second' };
        });

      const runtime = makeRuntime();
      const p1 = processMessage({ appId: 'test-app', message: 'first' }, runtime);
      const p2 = processMessage({ appId: 'test-app', message: 'second' }, runtime);

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.reply).toBe('first');
      expect(r2.reply).toBe('second');
      // Second message should not start until first is done
      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe('parallel processing across apps', () => {
    it('should process messages in parallel for different apps', async () => {
      const startTimes: Record<string, number> = {};

      vi.mocked(callHook).mockImplementation(async (manifest) => {
        startTimes[manifest.id] = Date.now();
        await new Promise(r => setTimeout(r, 50));
        return { intents: [], state: {}, reply: `reply from ${manifest.id}` };
      });

      const runtime1 = makeRuntime(makeManifest({ id: 'app-a', name: 'A' }));
      const runtime2 = makeRuntime(makeManifest({ id: 'app-b', name: 'B' }));

      const p1 = processMessage({ appId: 'app-a', message: 'hello' }, runtime1);
      const p2 = processMessage({ appId: 'app-b', message: 'hello' }, runtime2);

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.reply).toBe('reply from app-a');
      expect(r2.reply).toBe('reply from app-b');
      // Both should have started close together (within 20ms)
      const diff = Math.abs(startTimes['app-a'] - startTimes['app-b']);
      expect(diff).toBeLessThan(20);
    });
  });

  describe('rate limiting', () => {
    const origBypass = process.env.BYPASS_RATE_LIMIT;
    beforeEach(() => { process.env.BYPASS_RATE_LIMIT = 'false'; });
    afterEach(() => { process.env.BYPASS_RATE_LIMIT = origBypass; });

    it('should reject the 11th message within 60s', async () => {
      vi.mocked(callHook).mockResolvedValue({
        intents: [],
        state: {},
        reply: 'ok',
      });

      const runtime = makeRuntime();

      // Send 10 messages (should all succeed)
      for (let i = 0; i < 10; i++) {
        const result = await processMessage(
          { appId: 'test-app', message: `msg ${i}` },
          runtime,
        );
        expect(result.reply).toBe('ok');
      }

      // 11th should be rate limited
      const result = await processMessage(
        { appId: 'test-app', message: 'msg 10' },
        runtime,
      );
      expect(result.error).toContain('Rate limited');
      expect(result.reply).toBeNull();
    });

    it('should not rate limit different apps independently', async () => {
      vi.mocked(callHook).mockResolvedValue({
        intents: [],
        state: {},
        reply: 'ok',
      });

      const runtimeA = makeRuntime(makeManifest({ id: 'app-a', name: 'A' }));
      const runtimeB = makeRuntime(makeManifest({ id: 'app-b', name: 'B' }));

      // Send 10 messages to app-a
      for (let i = 0; i < 10; i++) {
        await processMessage({ appId: 'app-a', message: `msg ${i}` }, runtimeA);
      }

      // app-b should still work
      const result = await processMessage(
        { appId: 'app-b', message: 'hello' },
        runtimeB,
      );
      expect(result.reply).toBe('ok');
    });
  });

  describe('error handling', () => {
    it('should return error when hook throws', async () => {
      vi.mocked(callHook).mockRejectedValue(new Error('AI unavailable'));

      const result = await processMessage(
        { appId: 'test-app', message: 'hello' },
        makeRuntime(),
      );

      expect(result.reply).toBeNull();
      expect(result.error).toBe('AI unavailable');
    });
  });

  describe('cleanup', () => {
    it('clearMessageQueue should reset rate limits for a app', async () => {
      vi.mocked(callHook).mockResolvedValue({
        intents: [],
        state: {},
        reply: 'ok',
      });

      const runtime = makeRuntime();

      // Fill up rate limit
      for (let i = 0; i < 10; i++) {
        await processMessage({ appId: 'test-app', message: `msg ${i}` }, runtime);
      }

      // Clear queue (resets rate limits)
      clearMessageQueue('test-app');

      // Should work again
      const result = await processMessage(
        { appId: 'test-app', message: 'after reset' },
        runtime,
      );
      expect(result.reply).toBe('ok');
    });
  });
});
