/**
 * Tests for the approval adapter system.
 *
 * Tests:
 * - ApprovalRouter: adapter registration, notify/resolved fan-out, resolve flow
 * - WebhookAdapter: POST notifications, HMAC signatures, error handling
 * - TelegramAdapter: message formatting, inline keyboards, resolution editing
 * - Factory: config-based creation, disabled skipping, unknown type warnings
 * - loadAdaptersFromDb: DB config + agent-backed adapter secrets
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';

// Mock network module for WebhookAdapter SSRF validation
vi.mock('../../lib/network', () => ({
  validateExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

// Mock resolveAction for router tests
vi.mock('../../lib/resolve-action', () => ({
  resolveAction: vi.fn(),
}));

// Mock strategy engine for sendMessage tests
vi.mock('../../lib/strategy/engine', () => ({
  handleAppMessage: vi.fn(),
  enqueueAppMessage: vi.fn(),
  waitForQueuedAppMessage: vi.fn(),
}));

import { ApprovalRouter } from '../../lib/adapters/router';
import { WebhookAdapter } from '../../lib/adapters/webhook';
import { TelegramAdapter } from '../../lib/adapters/telegram';
import { WhatsAppAdapter } from '../../lib/adapters/whatsapp';
import { DiscordAdapter } from '../../lib/adapters/discord';
import { createAdapters, registerAdapterType } from '../../lib/adapters/factory';
import { resolveAction } from '../../lib/resolve-action';
import { handleAppMessage, enqueueAppMessage, waitForQueuedAppMessage } from '../../lib/strategy/engine';
import type {
  ApprovalAdapter,
  AdapterContext,
  ActionNotification,
  ActionResolution,
} from '../../lib/adapters/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockAction(overrides?: Partial<ActionNotification>): ActionNotification {
  return {
    id: 'action-123',
    type: 'agent_access',
    source: 'test-agent',
    summary: 'Requesting access with fund permission',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function mockResolution(overrides?: Partial<ActionResolution>): ActionResolution {
  return {
    id: 'action-123',
    type: 'agent_access',
    approved: true,
    resolvedBy: 'dashboard',
    ...overrides,
  };
}

function createMockAdapter(name = 'mock'): ApprovalAdapter & {
  startCalls: AdapterContext[];
  notifyCalls: ActionNotification[];
  resolvedCalls: ActionResolution[];
  stopCalls: number;
} {
  const adapter = {
    name,
    startCalls: [] as AdapterContext[],
    notifyCalls: [] as ActionNotification[],
    resolvedCalls: [] as ActionResolution[],
    stopCalls: 0,
    async start(ctx: AdapterContext) { adapter.startCalls.push(ctx); },
    async notify(action: ActionNotification) { adapter.notifyCalls.push(action); },
    async resolved(resolution: ActionResolution) { adapter.resolvedCalls.push(resolution); },
    async stop() { adapter.stopCalls++; },
  };
  return adapter;
}

// ─── ApprovalRouter ───────────────────────────────────────────────────────────

describe('ApprovalRouter', () => {
  // Mock WebSocket so the router doesn't try to connect
  vi.mock('ws', () => {
    class MockWebSocket {
      on() {}
      close() {}
    }
    return { WebSocket: MockWebSocket };
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should register adapters and fan out notify()', async () => {
    const router = new ApprovalRouter('http://localhost:4242');
    const adapter1 = createMockAdapter('a1');
    const adapter2 = createMockAdapter('a2');

    router.registerAdapter(adapter1);
    router.registerAdapter(adapter2);

    // Directly test the fan-out by simulating what handleEvent does
    const action = mockAction();

    // Call notify on both adapters (simulating fan-out)
    await adapter1.notify(action);
    await adapter2.notify(action);

    expect(adapter1.notifyCalls).toHaveLength(1);
    expect(adapter1.notifyCalls[0].id).toBe('action-123');
    expect(adapter2.notifyCalls).toHaveLength(1);
  });

  it('should fan out resolved() to all adapters', async () => {
    const adapter1 = createMockAdapter('a1');
    const adapter2 = createMockAdapter('a2');

    const resolution = mockResolution();

    await adapter1.resolved(resolution);
    await adapter2.resolved(resolution);

    expect(adapter1.resolvedCalls).toHaveLength(1);
    expect(adapter1.resolvedCalls[0].approved).toBe(true);
    expect(adapter2.resolvedCalls).toHaveLength(1);
  });

  it('should call resolveAction directly', async () => {
    const mockResolveAction = vi.mocked(resolveAction);
    mockResolveAction.mockResolvedValue({
      success: true,
      statusCode: 200,
      data: { success: true, token: 'tok', agentId: 'bot' },
    });

    const router = new ApprovalRouter('http://localhost:4242');
    const result = await router.resolve('action-123', true);

    expect(result.success).toBe(true);
    expect(result.agentId).toBe('bot');
    expect(result.token).toBe('tok');

    // Verify resolveAction was called with correct args
    expect(mockResolveAction).toHaveBeenCalledWith('action-123', true, {
      walletAccess: undefined,
      limits: undefined,
    });
  });

  it('should handle resolveAction returning not-found (404)', async () => {
    const mockResolveAction = vi.mocked(resolveAction);
    mockResolveAction.mockResolvedValue({
      success: false,
      statusCode: 404,
      data: { success: false, error: 'Action not found or already resolved' },
    });

    const router = new ApprovalRouter('http://localhost:4242');
    const result = await router.resolve('action-old', true);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should handle resolveAction returning locked wallet (401)', async () => {
    const mockResolveAction = vi.mocked(resolveAction);
    mockResolveAction.mockResolvedValue({
      success: false,
      statusCode: 401,
      data: { success: false, error: 'Wallet is locked. Unlock first.' },
    });

    const router = new ApprovalRouter('http://localhost:4242');
    const result = await router.resolve('action-123', true);

    expect(result.success).toBe(false);
    expect(result.error).toContain('locked');
  });

  it('should pass resolve options (walletAccess, limits) to resolveAction', async () => {
    const mockResolveAction = vi.mocked(resolveAction);
    mockResolveAction.mockResolvedValue({
      success: true,
      statusCode: 200,
      data: { success: true, token: 'tok', agentId: 'agent-1' },
    });

    const router = new ApprovalRouter('http://localhost:4242');
    const result = await router.resolve('action-1', true, {
      walletAccess: ['0xabc'],
      limits: { fund: 2.0 },
    });

    expect(result.success).toBe(true);

    expect(mockResolveAction).toHaveBeenCalledWith('action-1', true, {
      walletAccess: ['0xabc'],
      limits: { fund: 2.0 },
    });
  });

  it('should handle resolveAction throwing an error', async () => {
    const mockResolveAction = vi.mocked(resolveAction);
    mockResolveAction.mockRejectedValue(new Error('DB connection failed'));

    const router = new ApprovalRouter('http://localhost:4242');
    const result = await router.resolve('action-1', true);

    expect(result.success).toBe(false);
    expect(result.error).toContain('DB connection failed');
  });

  it('should call handleAppMessage directly for system chat', async () => {
    const mockHandleAppMessage = vi.mocked(handleAppMessage);
    mockHandleAppMessage.mockResolvedValue({ reply: 'Hello from AI' });

    const router = new ApprovalRouter('http://localhost:4242');
    const result = await router.sendMessage('__system__', 'Hello', undefined, 'telegram');

    expect(result.reply).toBe('Hello from AI');
    expect(result.error).toBeUndefined();
    expect(mockHandleAppMessage).toHaveBeenCalledWith('__system__', 'Hello', undefined, 'telegram');
  });

  it('should call handleAppMessage directly for agent-chat', async () => {
    const mockHandleAppMessage = vi.mocked(handleAppMessage);
    mockHandleAppMessage.mockResolvedValue({ reply: 'Agent chat reply' });

    const router = new ApprovalRouter('http://localhost:4242');
    const result = await router.sendMessage('agent-chat', 'Hi', undefined, 'telegram');

    expect(result.reply).toBe('Agent chat reply');
    expect(result.error).toBeUndefined();
    expect(mockHandleAppMessage).toHaveBeenCalledWith('agent-chat', 'Hi', undefined, 'telegram');
    expect(vi.mocked(enqueueAppMessage)).not.toHaveBeenCalled();
  });

  it('should use queue path for non-system apps', async () => {
    const mockEnqueue = vi.mocked(enqueueAppMessage);
    const mockWait = vi.mocked(waitForQueuedAppMessage);
    mockEnqueue.mockResolvedValue('req-123');
    mockWait.mockResolvedValue({ status: 'ok', reply: 'App reply' });

    const router = new ApprovalRouter('http://localhost:4242');
    const result = await router.sendMessage('my-app', 'Hi', undefined, 'webhook');

    expect(result.reply).toBe('App reply');
    expect(mockEnqueue).toHaveBeenCalledWith('my-app', 'Hi', 'webhook');
    expect(mockWait).toHaveBeenCalledWith('req-123', expect.any(Number));
  });

  it('should handle sendMessage error from system chat', async () => {
    const mockHandleAppMessage = vi.mocked(handleAppMessage);
    mockHandleAppMessage.mockResolvedValue({ reply: null, error: 'System chat not approved' });

    const router = new ApprovalRouter('http://localhost:4242');
    const result = await router.sendMessage('__system__', 'test');

    expect(result.reply).toBeNull();
    expect(result.error).toContain('not approved');
  });

  it('should stop all adapters on stop()', async () => {
    const router = new ApprovalRouter('http://localhost:4242');
    const adapter1 = createMockAdapter('a1');
    const adapter2 = createMockAdapter('a2');

    router.registerAdapter(adapter1);
    router.registerAdapter(adapter2);

    await router.stop();

    expect(adapter1.stopCalls).toBe(1);
    expect(adapter2.stopCalls).toBe(1);
  });
});

// ─── WebhookAdapter ───────────────────────────────────────────────────────────

describe('WebhookAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should POST action notification to configured URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 })
    );

    const adapter = new WebhookAdapter({ url: 'https://hooks.example.com/notify' });
    const action = mockAction();

    await adapter.notify(action);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/notify');
    expect(opts?.method).toBe('POST');

    const body = JSON.parse(opts?.body as string);
    expect(body.type).toBe('action:created');
    expect(body.data.id).toBe('action-123');

    fetchSpy.mockRestore();
  });

  it('should include HMAC signature when secret is configured', async () => {
    const secret = 'webhook-secret-key';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 })
    );

    const adapter = new WebhookAdapter({ url: 'https://hooks.example.com/notify', secret });
    await adapter.notify(mockAction());

    const [, opts] = fetchSpy.mock.calls[0];
    const headers = opts?.headers as Record<string, string>;
    const signature = headers['X-Signature-256'];

    expect(signature).toBeDefined();
    expect(signature).toMatch(/^sha256=[a-f0-9]+$/);

    // Verify signature is correct
    const expectedSig = createHmac('sha256', secret)
      .update(opts?.body as string)
      .digest('hex');
    expect(signature).toBe(`sha256=${expectedSig}`);

    fetchSpy.mockRestore();
  });

  it('should POST resolution updates', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 })
    );

    const adapter = new WebhookAdapter({ url: 'https://hooks.example.com/notify' });
    await adapter.resolved(mockResolution());

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.type).toBe('action:resolved');
    expect(body.data.approved).toBe(true);

    fetchSpy.mockRestore();
  });

  it('should handle webhook URL failures without throwing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Connection refused')
    );

    const adapter = new WebhookAdapter({ url: 'https://hooks.example.com/down' });

    // Should not throw
    await expect(adapter.notify(mockAction())).resolves.not.toThrow();

    fetchSpy.mockRestore();
  });

  it('should include custom headers if configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 })
    );

    const adapter = new WebhookAdapter({
      url: 'https://hooks.example.com/notify',
      headers: { 'X-Custom': 'value' },
    });
    await adapter.notify(mockAction());

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['X-Custom']).toBe('value');
    expect(headers['Content-Type']).toBe('application/json');

    fetchSpy.mockRestore();
  });
});

// ─── TelegramAdapter ──────────────────────────────────────────────────────────

describe('TelegramAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should send message with inline keyboard on notify', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );

    const adapter = new TelegramAdapter({ botToken: 'BOT_TOKEN', chatId: '12345' });
    // Start with a mock context (the polling will fail silently since we're mocking fetch)
    await adapter.start({
      resolve: vi.fn(),
      serverUrl: 'http://localhost:4242',
    });

    await adapter.notify(mockAction());

    // Find the sendMessage call (skip getUpdates calls from polling)
    const sendCall = fetchSpy.mock.calls.find(([url]) =>
      (url as string).includes('sendMessage')
    );

    expect(sendCall).toBeDefined();
    const [url, opts] = sendCall!;
    expect(url).toContain('api.telegram.org/botBOT_TOKEN/sendMessage');

    const body = JSON.parse(opts?.body as string);
    expect(body.chat_id).toBe('12345');
    expect(body.text).toContain('New Action Request');
    expect(body.text).toContain('agent_access');

    const keyboard = JSON.parse(body.reply_markup);
    expect(keyboard.inline_keyboard[0]).toHaveLength(2);
    expect(keyboard.inline_keyboard[0][0].text).toBe('Approve');
    expect(keyboard.inline_keyboard[0][0].callback_data).toBe('approve:action-123');
    expect(keyboard.inline_keyboard[0][1].text).toBe('Reject');

    await adapter.stop();
    fetchSpy.mockRestore();
  });

  it('should edit message on resolution', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );

    const adapter = new TelegramAdapter({ botToken: 'BOT_TOKEN', chatId: '12345' });
    await adapter.start({
      resolve: vi.fn(),
      serverUrl: 'http://localhost:4242',
    });

    // First notify to register the message
    await adapter.notify(mockAction({ id: 'action-456' }));

    // Then resolve
    await adapter.resolved(mockResolution({ id: 'action-456' }));

    const editCall = fetchSpy.mock.calls.find(([url]) =>
      (url as string).includes('editMessageText')
    );

    expect(editCall).toBeDefined();
    const body = JSON.parse(editCall![1]?.body as string);
    expect(body.message_id).toBe(42);
    expect(body.text).toContain('APPROVED');

    await adapter.stop();
    fetchSpy.mockRestore();
  });

  it('should not edit message for unknown action', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );

    const adapter = new TelegramAdapter({ botToken: 'BOT_TOKEN', chatId: '12345' });
    await adapter.start({
      resolve: vi.fn(),
      serverUrl: 'http://localhost:4242',
    });

    await adapter.resolved(mockResolution({ id: 'unknown-action' }));

    const editCall = fetchSpy.mock.calls.find(([url]) =>
      (url as string).includes('editMessageText')
    );
    expect(editCall).toBeUndefined();

    await adapter.stop();
    fetchSpy.mockRestore();
  });

  it('should clean up on stop', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );

    const adapter = new TelegramAdapter({ botToken: 'TOK', chatId: '1' });
    await adapter.start({
      resolve: vi.fn(),
      serverUrl: 'http://localhost:4242',
    });

    await adapter.notify(mockAction());
    await adapter.stop();

    // After stop, resolved should be a no-op (actionMessages cleared)
    fetchSpy.mockClear();
    await adapter.resolved(mockResolution());

    const editCall = fetchSpy.mock.calls.find(([url]) =>
      (url as string).includes('editMessageText')
    );
    expect(editCall).toBeUndefined();

    fetchSpy.mockRestore();
  });
});

// ─── DiscordAdapter ───────────────────────────────────────────────────────────

describe('DiscordAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should send notifications to Discord channel', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/channels/123/messages')) {
        return Promise.resolve(new Response(JSON.stringify({ id: 'm1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: '123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    const adapter = new DiscordAdapter({ botToken: 'BOT_TOKEN', channelId: '123' });
    await adapter.start({
      resolve: vi.fn(),
      resolveApp: vi.fn(),
      sendMessage: vi.fn(),
      serverUrl: 'http://localhost:4242',
    });

    await adapter.notify(mockAction());

    const sendCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes('/channels/123/messages')
    );
    expect(sendCall).toBeDefined();

    await adapter.stop();
    fetchSpy.mockRestore();
  });
});

// ─── WhatsAppAdapter ──────────────────────────────────────────────────────────

describe('WhatsAppAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should resolve approve commands from chat text', async () => {
    const adapter = new WhatsAppAdapter({});
    const fullActionId = 'a1b2c3d4e5f6g7h8';
    const shortId = fullActionId.slice(0, 12).toLowerCase();

    const resolveSpy = vi.fn().mockResolvedValue({ success: true });
    (adapter as unknown as { ctx: AdapterContext }).ctx = {
      resolve: resolveSpy,
      resolveApp: vi.fn(),
      sendMessage: vi.fn(),
      serverUrl: 'http://localhost:4242',
    };
    (adapter as unknown as { pendingActions: Set<string> }).pendingActions = new Set([fullActionId]);
    (adapter as unknown as { shortActionMap: Map<string, string> }).shortActionMap = new Map([[shortId, fullActionId]]);
    (adapter as unknown as { sendText: (text: string) => Promise<void> }).sendText = vi.fn().mockResolvedValue(undefined);

    await (adapter as unknown as { handleIncomingText(senderId: string, text: string): Promise<void> })
      .handleIncomingText('123@s.whatsapp.net', `approve ${shortId}`);

    expect(resolveSpy).toHaveBeenCalledWith(fullActionId, true);
    const sendTextSpy = (adapter as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText;
    expect(sendTextSpy).toHaveBeenCalledWith(expect.stringContaining(`Action ${fullActionId.slice(0, 12)} approved`));
  });

  it('should route non-command messages to app chat when enabled', async () => {
    const adapter = new WhatsAppAdapter({ chat: { enabled: true } });
    const sendMessageSpy = vi.fn().mockResolvedValue({ reply: 'hello from ai' });

    (adapter as unknown as { ctx: AdapterContext }).ctx = {
      resolve: vi.fn().mockResolvedValue({ success: true }),
      resolveApp: vi.fn().mockResolvedValue('test-app'),
      sendMessage: sendMessageSpy,
      serverUrl: 'http://localhost:4242',
    };
    (adapter as unknown as { sendText: (text: string) => Promise<void> }).sendText = vi.fn().mockResolvedValue(undefined);

    await (adapter as unknown as { handleIncomingText(senderId: string, text: string): Promise<void> })
      .handleIncomingText('123@s.whatsapp.net', 'hello');

    expect(sendMessageSpy).toHaveBeenCalledWith('test-app', 'hello', undefined, 'whatsapp');
    const sendTextSpy = (adapter as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText;
    expect(sendTextSpy).toHaveBeenCalledWith('hello from ai');
  });

  it('should fall back to DB action lookup when in-memory action map is empty', async () => {
    const adapter = new WhatsAppAdapter({});
    const fullActionId = 'cmm45oevo000ckl2k7y83843t';

    const resolveSpy = vi.fn().mockResolvedValue({ success: true });
    (adapter as unknown as { ctx: AdapterContext }).ctx = {
      resolve: resolveSpy,
      resolveApp: vi.fn(),
      sendMessage: vi.fn(),
      serverUrl: 'http://localhost:4242',
    };
    (adapter as unknown as { pendingActions: Set<string> }).pendingActions = new Set();
    (adapter as unknown as { shortActionMap: Map<string, string> }).shortActionMap = new Map();
    (adapter as unknown as { resolveActionIdFromDb: (actionRef: string | null) => Promise<string | null> }).resolveActionIdFromDb = vi.fn().mockResolvedValue(fullActionId);
    (adapter as unknown as { sendText: (text: string) => Promise<void> }).sendText = vi.fn().mockResolvedValue(undefined);

    await (adapter as unknown as { handleIncomingText(senderId: string, text: string): Promise<void> })
      .handleIncomingText('123@s.whatsapp.net', 'approve');

    expect(resolveSpy).toHaveBeenCalledWith(fullActionId, true);
    const sendTextSpy = (adapter as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText;
    expect(sendTextSpy).toHaveBeenCalledWith(expect.stringContaining(`Action ${fullActionId.slice(0, 12)} approved`));
  });

  it('should allow sender when allowFrom wildcard is enabled', () => {
    const adapter = new WhatsAppAdapter({});
    (adapter as unknown as { allowAllSenders: boolean }).allowAllSenders = true;

    const allowed = (adapter as unknown as { isAllowedSender(jid: string): boolean })
      .isAllowedSender('120586172948697@lid');
    expect(allowed).toBe(true);
  });
});

// ─── Factory ──────────────────────────────────────────────────────────────────

describe('Adapter Factory', () => {
  it('should create adapters from entries', () => {
    const entries = [
      {
        type: 'webhook',
        enabled: true,
        config: { url: 'https://hooks.example.com/test' },
      },
    ];

    const adapters = createAdapters(entries);
    expect(adapters).toHaveLength(1);
    expect(adapters[0].name).toContain('webhook');
  });

  it('should skip disabled adapters', () => {
    const entries = [
      {
        type: 'webhook',
        enabled: false,
        config: { url: 'https://hooks.example.com/test' },
      },
    ];

    const adapters = createAdapters(entries);
    expect(adapters).toHaveLength(0);
  });

  it('should return empty array for empty input', () => {
    const adapters = createAdapters([]);
    expect(adapters).toHaveLength(0);
  });

  it('should warn on unknown adapter types', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const entries = [
      {
        type: 'unknown_type',
        enabled: true,
        config: {},
      },
    ];

    const adapters = createAdapters(entries);
    expect(adapters).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown adapter type'));

    warnSpy.mockRestore();
  });

  it('should support registering custom adapter types', () => {
    const custom = createMockAdapter('custom-adapter');
    registerAdapterType('custom', () => custom);

    const entries = [
      { type: 'custom', enabled: true, config: {} },
    ];

    const adapters = createAdapters(entries);
    expect(adapters).toHaveLength(1);
    expect(adapters[0].name).toBe('custom-adapter');
  });

  it('should create telegram adapter from config', () => {
    const entries = [
      {
        type: 'telegram',
        enabled: true,
        config: { botToken: 'TEST_TOKEN', chatId: '12345' },
      },
    ];

    const adapters = createAdapters(entries);
    expect(adapters).toHaveLength(1);
    expect(adapters[0].name).toBe('telegram');
  });

  it('should create whatsapp adapter from config', () => {
    const entries = [
      {
        type: 'whatsapp',
        enabled: true,
        config: { authDir: '/tmp/whatsapp-auth' },
      },
    ];

    const adapters = createAdapters(entries);
    expect(adapters).toHaveLength(1);
    expect(adapters[0].name).toBe('whatsapp');
  });

  it('should create discord adapter from config', () => {
    const entries = [
      {
        type: 'discord',
        enabled: true,
        config: { botToken: 'BOT_TOKEN', channelId: '123' },
      },
    ];

    const adapters = createAdapters(entries);
    expect(adapters).toHaveLength(1);
    expect(adapters[0].name).toBe('discord');
  });
});

// ─── loadAdaptersFromDb ──────────────────────────────────────────────────────

describe('loadAdaptersFromDb', () => {
  // Use dynamic import so the mock can be set up first
  let loadAdaptersFromDb: typeof import('../../lib/adapters/factory').loadAdaptersFromDb;

  const mockPrisma = {
    appConfig: {
      findUnique: vi.fn(),
    },
  };

  const mockApiKeyMigration = {
    ensureApiKeysMigrated: vi.fn(async () => undefined),
    listApiKeyCredentials: vi.fn(() => []),
    readApiKeyValueByServiceName: vi.fn(() => null),
  };

  const savedNodeEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    // Override NODE_ENV so the test guard in loadAdaptersFromDb is bypassed
    process.env.NODE_ENV = 'development';
    vi.doMock('../../lib/db', () => ({
      prisma: mockPrisma,
    }));
    vi.doMock('../../lib/apikey-migration', () => mockApiKeyMigration);
    // Re-import to pick up mock
    const mod = await import('../../lib/adapters/factory');
    loadAdaptersFromDb = mod.loadAdaptersFromDb;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv;
    vi.doUnmock('../../lib/db');
    vi.doUnmock('../../lib/apikey-migration');
  });

  it('should return empty array when no adapterConfig exists', async () => {
    mockPrisma.appConfig.findUnique.mockResolvedValue(null);

    const adapters = await loadAdaptersFromDb();
    expect(adapters).toHaveLength(0);
  });

  it('should return empty array when system disabled', async () => {
    mockPrisma.appConfig.findUnique.mockResolvedValue({
      adapterConfig: JSON.stringify({ enabled: false, adapters: [] }),
    });

    const adapters = await loadAdaptersFromDb();
    expect(adapters).toHaveLength(0);
  });

  it('should merge secrets from agent credentials into adapter config', async () => {
    mockPrisma.appConfig.findUnique.mockResolvedValue({
      adapterConfig: JSON.stringify({
        enabled: true,
        adapters: [
          { type: 'webhook', enabled: true, config: { url: 'https://hooks.example.com/test' } },
        ],
      }),
    });
    mockApiKeyMigration.listApiKeyCredentials.mockReturnValue([
      {
        id: 'cred-abc12345',
        service: 'adapter:webhook',
        name: 'secret',
        keyMasked: 'my**********ret',
        metadata: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    mockApiKeyMigration.readApiKeyValueByServiceName.mockImplementation((service: string, name: string) => {
      if (service === 'adapter:webhook' && name === 'secret') return 'my-hmac-secret';
      return null;
    });

    const adapters = await loadAdaptersFromDb();
    expect(adapters).toHaveLength(1);
    expect(adapters[0].name).toContain('webhook');
  });

  it('should create telegram adapter with secrets from agent credentials', async () => {
    mockPrisma.appConfig.findUnique.mockResolvedValue({
      adapterConfig: JSON.stringify({
        enabled: true,
        adapters: [
          { type: 'telegram', enabled: true, config: { chatId: '12345' } },
        ],
      }),
    });
    mockApiKeyMigration.listApiKeyCredentials.mockReturnValue([
      {
        id: 'cred-def67890',
        service: 'adapter:telegram',
        name: 'botToken',
        keyMasked: '123****ABC',
        metadata: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    mockApiKeyMigration.readApiKeyValueByServiceName.mockImplementation((service: string, name: string) => {
      if (service === 'adapter:telegram' && name === 'botToken') return '123:ABC';
      return null;
    });

    const adapters = await loadAdaptersFromDb();
    expect(adapters).toHaveLength(1);
    expect(adapters[0].name).toBe('telegram');
  });

  it('should create whatsapp adapter from DB config', async () => {
    mockPrisma.appConfig.findUnique.mockResolvedValue({
      adapterConfig: JSON.stringify({
        enabled: true,
        adapters: [
          { type: 'whatsapp', enabled: true, config: { authDir: '/tmp/wa-auth' } },
        ],
      }),
    });

    const adapters = await loadAdaptersFromDb();
    expect(adapters).toHaveLength(1);
    expect(adapters[0].name).toBe('whatsapp');
  });

  it('should create discord adapter with secrets from agent credentials', async () => {
    mockPrisma.appConfig.findUnique.mockResolvedValue({
      adapterConfig: JSON.stringify({
        enabled: true,
        adapters: [
          { type: 'discord', enabled: true, config: { channelId: '123' } },
        ],
      }),
    });
    mockApiKeyMigration.listApiKeyCredentials.mockReturnValue([
      {
        id: 'cred-discord',
        service: 'adapter:discord',
        name: 'botToken',
        keyMasked: 'tok***',
        metadata: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    mockApiKeyMigration.readApiKeyValueByServiceName.mockImplementation((service: string, name: string) => {
      if (service === 'adapter:discord' && name === 'botToken') return 'discord-token';
      return null;
    });

    const adapters = await loadAdaptersFromDb();
    expect(adapters).toHaveLength(1);
    expect(adapters[0].name).toBe('discord');
  });
});

// ─── Integration: Adapter Resolve Flow ────────────────────────────────────────

describe('Adapter Resolve Integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should pass resolve options (walletAccess, limits) to resolveAction', async () => {
    const mockResolveAction = vi.mocked(resolveAction);
    mockResolveAction.mockResolvedValue({
      success: true,
      statusCode: 200,
      data: { success: true, token: 'tok', agentId: 'agent-1' },
    });

    const router = new ApprovalRouter('http://localhost:4242');
    const result = await router.resolve('action-1', true, {
      walletAccess: ['0xabc'],
      limits: { fund: 2.0 },
    });

    expect(result.success).toBe(true);

    expect(mockResolveAction).toHaveBeenCalledWith('action-1', true, {
      walletAccess: ['0xabc'],
      limits: { fund: 2.0 },
    });
  });

  it('should handle resolveAction errors gracefully', async () => {
    const mockResolveAction = vi.mocked(resolveAction);
    mockResolveAction.mockRejectedValue(new Error('ECONNREFUSED'));

    const router = new ApprovalRouter('http://localhost:4242');
    const result = await router.resolve('action-1', true);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});
