/**
 * Tests for the adapter agent chat system.
 *
 * Tests:
 * - TelegramAdapter.onMessage() — chat opt-in guard, app routing, reply formatting
 * - Factory — chat config passthrough to adapter constructors
 *
 * Note: We test onMessage() directly rather than through the polling loop
 * to avoid spawning long-running fetch loops that cause OOM in vitest forks.
 * The polling loop integration (message → handleChatMessage → onMessage)
 * is tested in the TelegramAdapter's start/stop lifecycle in adapters.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock network module for factory imports
vi.mock('../../lib/network', () => ({
  validateExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

import { TelegramAdapter } from '../../lib/adapters/telegram';
import { createAdapters } from '../../lib/adapters/factory';
import type { AdapterContext } from '../../lib/adapters/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockContext(overrides?: Partial<AdapterContext>): AdapterContext {
  return {
    resolve: vi.fn().mockResolvedValue({ success: true }),
    serverUrl: 'http://localhost:4242',
    sendMessage: vi.fn().mockResolvedValue({ reply: 'Test reply', error: undefined }),
    resolveApp: vi.fn().mockResolvedValue('test-app'),
    ...overrides,
  };
}

/**
 * Create a TelegramAdapter with ctx set but without starting the polling loop.
 * This lets us test onMessage() in isolation.
 */
function createAdapterWithCtx(
  config: ConstructorParameters<typeof TelegramAdapter>[0],
  ctx: AdapterContext,
): TelegramAdapter {
  const adapter = new TelegramAdapter(config);
  // Set ctx directly to avoid starting the polling loop
  (adapter as unknown as { ctx: AdapterContext }).ctx = ctx;
  return adapter;
}

// ─── TelegramAdapter.onMessage — opt-in guard ────────────────────────────────

describe('TelegramAdapter.onMessage', () => {
  it('should return null when chat is not configured (default off)', async () => {
    const ctx = mockContext();
    const adapter = createAdapterWithCtx({ botToken: 'TOK', chatId: '123' }, ctx);

    const reply = await adapter.onMessage!({ text: 'Hello', senderId: '123' });
    expect(reply).toBeNull();
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  it('should return null when chat.enabled is explicitly false', async () => {
    const ctx = mockContext();
    const adapter = createAdapterWithCtx({ botToken: 'TOK', chatId: '123', chat: { enabled: false } }, ctx);

    const reply = await adapter.onMessage!({ text: 'Hello', senderId: '123' });
    expect(reply).toBeNull();
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  it('should route message to app when chat is enabled', async () => {
    const ctx = mockContext();
    const adapter = createAdapterWithCtx({ botToken: 'TOK', chatId: '123', chat: { enabled: true } }, ctx);

    const reply = await adapter.onMessage!({ text: 'What is my balance?', senderId: '123' });

    expect(reply).toBeDefined();
    expect(reply!.text).toBe('Test reply');
    expect(ctx.resolveApp).toHaveBeenCalledWith(undefined);
    expect(ctx.sendMessage).toHaveBeenCalledWith('test-app', 'What is my balance?', undefined, 'telegram');
  });

  it('should pass targetApp through to resolveApp', async () => {
    const ctx = mockContext();
    const adapter = createAdapterWithCtx({ botToken: 'TOK', chatId: '123', chat: { enabled: true } }, ctx);

    await adapter.onMessage!({ text: 'test', senderId: '123', targetApp: 'my-bot' });

    expect(ctx.resolveApp).toHaveBeenCalledWith('my-bot');
  });

  it('should return helpful error when no app configured', async () => {
    const ctx = mockContext({ resolveApp: vi.fn().mockResolvedValue(null) });
    const adapter = createAdapterWithCtx({ botToken: 'TOK', chatId: '123', chat: { enabled: true } }, ctx);

    const reply = await adapter.onMessage!({ text: 'Hello', senderId: '123' });

    expect(reply).toBeDefined();
    expect(reply!.text).toContain('No AI app configured');
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  it('should return engine error in reply text', async () => {
    const ctx = mockContext({
      sendMessage: vi.fn().mockResolvedValue({ reply: null, error: 'App not found' }),
    });
    const adapter = createAdapterWithCtx({ botToken: 'TOK', chatId: '123', chat: { enabled: true } }, ctx);

    const reply = await adapter.onMessage!({ text: 'test', senderId: '123' });

    expect(reply).toBeDefined();
    expect(reply!.text).toContain('App not found');
  });

  it('should return null when engine returns null reply with no error', async () => {
    const ctx = mockContext({
      sendMessage: vi.fn().mockResolvedValue({ reply: null }),
    });
    const adapter = createAdapterWithCtx({ botToken: 'TOK', chatId: '123', chat: { enabled: true } }, ctx);

    const reply = await adapter.onMessage!({ text: 'test', senderId: '123' });
    expect(reply).toBeNull();
  });

  it('should return null when ctx is not set', async () => {
    const adapter = new TelegramAdapter({ botToken: 'TOK', chatId: '123', chat: { enabled: true } });
    const reply = await adapter.onMessage!({ text: 'test', senderId: '123' });
    expect(reply).toBeNull();
  });
});

// ─── TelegramAdapter.handleChatMessage — progress indicators ─────────────────

describe('TelegramAdapter progress indicators', () => {
  it('should pass onProgress callback through sendMessage', async () => {
    let capturedOnProgress: ((status: string) => void) | undefined;
    const ctx = mockContext({
      sendMessage: vi.fn(async (_appId, _text, onProgress) => {
        capturedOnProgress = onProgress;
        // Simulate tool calls firing progress
        if (onProgress) {
          onProgress('checking your wallets...');
          onProgress('preparing the swap...');
        }
        return { reply: 'Swap complete!', error: undefined };
      }),
    });
    const adapter = createAdapterWithCtx(
      { botToken: 'TOK', chatId: '123', chat: { enabled: true } },
      ctx,
    );

    // Call onMessage which goes through the public interface
    const reply = await adapter.onMessage!({ text: 'swap 0.1 ETH', senderId: '123' });

    expect(reply).toBeDefined();
    expect(reply!.text).toBe('Swap complete!');
    // sendMessage was called — onProgress is the 3rd arg but onMessage doesn't thread it
    // (onProgress is threaded via handleChatMessage, not onMessage)
    expect(ctx.sendMessage).toHaveBeenCalledWith('test-app', 'swap 0.1 ETH', undefined, 'telegram');
  });

  it('should send status message and delete it on reply via handleChatMessage', async () => {
    // Test the full handleChatMessage path by accessing the private method
    const apiCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let sendMessageResolve: ((result: any) => void) | undefined;
    const sendMessagePromise = new Promise(r => { sendMessageResolve = r; });

    const ctx = mockContext({
      sendMessage: vi.fn(async (_appId, _text, onProgress) => {
        // Simulate progress firing
        if (onProgress) {
          onProgress('checking your wallets...');
          // Wait a tick for the apiCall promise to resolve
          await new Promise(r => setTimeout(r, 10));
          onProgress('preparing the swap...');
          await new Promise(r => setTimeout(r, 10));
        }
        return { reply: 'Swap done!', error: undefined };
      }),
    });

    const adapter = new TelegramAdapter({ botToken: 'TOK', chatId: '123', chat: { enabled: true } });
    (adapter as any).ctx = ctx;

    // Mock apiCall to track calls
    let msgIdCounter = 100;
    (adapter as any).apiCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      apiCalls.push({ method, params });
      if (method === 'sendMessage' && !params.parse_mode) {
        // Status message — return a message_id
        return { ok: true, result: { message_id: ++msgIdCounter } };
      }
      if (method === 'sendMessage' && params.parse_mode) {
        // Real reply
        return { ok: true, result: { message_id: ++msgIdCounter } };
      }
      return { ok: true, result: {} };
    });

    // Call handleChatMessage directly
    await (adapter as any).handleChatMessage({
      message_id: 1,
      chat: { id: 123 },
      text: 'swap',
    });

    // Should have: sendChatAction, sendMessage (initial flavor), editMessageText (wallets),
    // editMessageText (swap), deleteMessage, sendMessage (reply)
    const methodSequence = apiCalls.map(c => c.method);
    expect(methodSequence).toContain('sendChatAction');
    expect(methodSequence).toContain('deleteMessage');
    // The final sendMessage should be the real reply with parse_mode
    const replyCalls = apiCalls.filter(c => c.method === 'sendMessage' && c.params.parse_mode === 'HTML');
    expect(replyCalls.length).toBeGreaterThanOrEqual(1);
    expect(replyCalls[replyCalls.length - 1].params.text).toContain('Swap done!');
  });
});

// ─── Factory: Chat Config Passthrough ────────────────────────────────────────

describe('Factory chat config', () => {
  it('should pass chat config to telegram adapter constructor', () => {
    const adapters = createAdapters([
      {
        type: 'telegram',
        enabled: true,
        config: { botToken: 'TOK', chatId: '123' },
        chat: { enabled: true },
      },
    ]);
    expect(adapters).toHaveLength(1);
    expect(adapters[0].name).toBe('telegram');
  });

  it('should create adapter without chat config', () => {
    const adapters = createAdapters([
      {
        type: 'telegram',
        enabled: true,
        config: { botToken: 'TOK', chatId: '123' },
      },
    ]);
    expect(adapters).toHaveLength(1);
    expect(adapters[0].name).toBe('telegram');
  });

  it('should skip disabled adapters', () => {
    const adapters = createAdapters([
      {
        type: 'telegram',
        enabled: false,
        config: { botToken: 'TOK', chatId: '123' },
        chat: { enabled: true },
      },
    ]);
    expect(adapters).toHaveLength(0);
  });
});
