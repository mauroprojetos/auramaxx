/**
 * Tests for strategy hook caller
 *
 * Tests:
 * - parseHookResponse — valid JSON, JSON in code blocks, invalid JSON, missing fields
 * - callHook — mock Anthropic client, verify system message caching, handle errors
 *
 * Note: getAnthropicClient tests moved to server/tests/lib/ai.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StrategyManifest } from '../../../lib/strategy/types';

// Shared mock for messages.create — tests can override per-test
const mockCreate = vi.fn();

// Mock prisma
vi.mock('../../../lib/db', () => ({
  prisma: {
    apiKey: {
      findFirst: vi.fn(),
    },
  },
}));

// Mock defaults module (needed by ai.ts)
vi.mock('../../../lib/defaults', () => ({
  getDefault: vi.fn(async (_key: string, fallback: unknown) => fallback),
  getDefaultSync: vi.fn((_key: string, fallback: unknown) => fallback),
  onDefaultChanged: vi.fn(() => () => {}),
  invalidateCache: vi.fn(),
}));

// Mock hook-context to return a known string (accepts mode + provider parameters)
vi.mock('../../../lib/strategy/hook-context', () => ({
  getHookSystemContext: (mode?: string, _provider?: string) => mode === 'tool-call' ? '[SYSTEM_CONTEXT_TOOL_CALL]' : '[SYSTEM_CONTEXT]',
}));

// Mock auth module for validateToken
vi.mock('../../../lib/auth', () => ({
  validateToken: vi.fn().mockReturnValue(null),
  getTokenHash: vi.fn().mockReturnValue('mock-hash'),
  createToken: vi.fn(),
  createTokenSync: vi.fn(),
}));

// Mock executeTool from mcp/tools
const mockExecuteTool = vi.fn();
vi.mock('../../../mcp/tools', () => ({
  toAnthropicTools: () => [
    {
      name: 'wallet_api',
      description: 'Call the AuraMaxx API.',
      input_schema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST'] },
          endpoint: { type: 'string' },
          body: { type: 'object' },
        },
        required: ['method', 'endpoint'],
      },
    },
    {
      name: 'request_human_action',
      description: 'Request human approval for a privileged wallet action.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          permissions: { type: 'array' },
          action: { type: 'object' },
          limits: { type: 'object' },
          ttl: { type: 'number' },
        },
        required: ['summary', 'permissions', 'action'],
      },
    },
  ],
  toOpenAITools: () => [
    {
      type: 'function',
      function: {
        name: 'wallet_api',
        description: 'Call the AuraMaxx API.',
        parameters: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['GET', 'POST'] },
            endpoint: { type: 'string' },
            body: { type: 'object' },
          },
          required: ['method', 'endpoint'],
        },
      },
    },
  ],
  executeTool: (...args: any[]) => mockExecuteTool(...args),
}));

// Mock the OpenAI SDK
vi.mock('openai', () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } };
    constructor(opts: any) { this._opts = opts; }
    _opts: any;
  }
  return { default: MockOpenAI };
});

// Mock the Anthropic SDK as a class constructor
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate };
    _opts: any;
    constructor(opts: any) {
      MockAnthropic._lastOpts = opts;
      MockAnthropic._callCount++;
      this._opts = opts;
    }
    static _lastOpts: any = null;
    static _callCount = 0;
    static _reset() {
      MockAnthropic._lastOpts = null;
      MockAnthropic._callCount = 0;
    }
  }
  return { default: MockAnthropic };
});

import { parseHookResponse, callHook, toolCallToStatus, __resetCachedClient } from '../../../lib/strategy/hooks';
import { prisma } from '../../../lib/db';
import { getDefault, getDefaultSync } from '../../../lib/defaults';
import { validateToken } from '../../../lib/auth';

/** Helper to get the mock Anthropic class statics */
async function getAnthropicMock() {
  const mod = await import('@anthropic-ai/sdk');
  return mod.default as any;
}

/** Helper to create a minimal manifest */
function testManifest(overrides: Partial<StrategyManifest> = {}): StrategyManifest {
  return {
    id: 'test-strategy',
    name: 'Test',
    ticker: 'standard',
    sources: [],
    hooks: { tick: 'Analyze the data', execute: 'Create an action' },
    config: {},
    permissions: [],
    ...overrides,
  };
}

describe('Strategy Hooks', () => {
  describe('parseHookResponse()', () => {
    it('should parse valid JSON with intents and state', () => {
      const json = JSON.stringify({
        intents: [{ type: 'swap', token: 'abc' }],
        state: { lastPrice: 42 },
        log: 'Found opportunity',
      });
      const result = parseHookResponse(json);
      expect(result.intents).toEqual([{ type: 'swap', token: 'abc' }]);
      expect(result.state).toEqual({ lastPrice: 42 });
      expect(result.log).toBe('Found opportunity');
    });

    it('should return empty defaults for invalid JSON', () => {
      const result = parseHookResponse('this is not json');
      expect(result.intents).toEqual([]);
      expect(result.state).toEqual({});
    });

    it('should handle JSON wrapped in markdown code blocks', () => {
      const wrapped = '```json\n{"intents": [{"type": "buy"}], "state": {"x": 1}}\n```';
      const result = parseHookResponse(wrapped);
      expect(result.intents).toEqual([{ type: 'buy' }]);
      expect(result.state).toEqual({ x: 1 });
    });

    it('should handle code blocks without language specifier', () => {
      const wrapped = '```\n{"intents": [], "state": {"done": true}}\n```';
      const result = parseHookResponse(wrapped);
      expect(result.intents).toEqual([]);
      expect(result.state).toEqual({ done: true });
    });

    it('should default intents to empty array if missing', () => {
      const json = JSON.stringify({ state: { a: 1 } });
      const result = parseHookResponse(json);
      expect(result.intents).toEqual([]);
      expect(result.state).toEqual({ a: 1 });
    });

    it('should default state to empty object if missing', () => {
      const json = JSON.stringify({ intents: [{ type: 'sell' }] });
      const result = parseHookResponse(json);
      expect(result.intents).toEqual([{ type: 'sell' }]);
      expect(result.state).toEqual({});
    });

    it('should handle intents that is not an array', () => {
      const json = JSON.stringify({ intents: 'not-array', state: {} });
      const result = parseHookResponse(json);
      expect(result.intents).toEqual([]);
    });

    it('should handle state that is not an object', () => {
      const json = JSON.stringify({ intents: [], state: 'not-obj' });
      const result = parseHookResponse(json);
      expect(result.state).toEqual({});
    });

    it('should handle empty string', () => {
      const result = parseHookResponse('');
      expect(result.intents).toEqual([]);
      expect(result.state).toEqual({});
    });

    it('should handle whitespace-only input', () => {
      const result = parseHookResponse('   \n  ');
      expect(result.intents).toEqual([]);
      expect(result.state).toEqual({});
    });

    it('should handle non-string log', () => {
      const json = JSON.stringify({ intents: [], state: {}, log: 42 });
      const result = parseHookResponse(json);
      expect(result.log).toBeUndefined();
    });

    it('should extract reply field', () => {
      const json = JSON.stringify({ intents: [], state: {}, reply: 'Hello!' });
      const result = parseHookResponse(json);
      expect(result.reply).toBe('Hello!');
    });

    it('should handle non-string reply', () => {
      const json = JSON.stringify({ intents: [], state: {}, reply: 123 });
      const result = parseHookResponse(json);
      expect(result.reply).toBeUndefined();
    });

    it('should handle JSON with extra fields gracefully', () => {
      const json = JSON.stringify({
        intents: [{ type: 'hold' }],
        state: { pos: 1 },
        reasoning: 'Market is flat',
        confidence: 0.8,
      });
      const result = parseHookResponse(json);
      expect(result.intents).toEqual([{ type: 'hold' }]);
      expect(result.state).toEqual({ pos: 1 });
    });

    it('should extract JSON from code block embedded in reasoning text', () => {
      const response = `I need to check the permissions first.

Looking at the API docs, I should create a wallet.

\`\`\`json
{"reply": "Creating a hot wallet.", "state": {"step": 1}, "intents": [{"type": "wallet:create"}]}
\`\`\``;
      const result = parseHookResponse(response);
      expect(result.reply).toBe('Creating a hot wallet.');
      expect(result.intents).toEqual([{ type: 'wallet:create' }]);
      expect(result.state).toEqual({ step: 1 });
    });

    it('should extract JSON from braces when no code block', () => {
      const response = `Let me check your wallets.

{"reply": "You have 2 wallets.", "state": {}, "intents": []}

Hope that helps!`;
      const result = parseHookResponse(response);
      expect(result.reply).toBe('You have 2 wallets.');
      expect(result.intents).toEqual([]);
    });

    it('should handle reasoning text with code block containing intents', () => {
      const response = `Based on the context, the user wants to swap. I'll create an intent with permissions.

\`\`\`json
{
  "reply": "I'll swap 0.1 ETH for USDC.",
  "state": {"lastSwap": "ETH->USDC"},
  "intents": [{"type": "swap", "permissions": ["swap"], "action": {"endpoint": "/swap", "method": "POST"}}]
}
\`\`\`

This should work.`;
      const result = parseHookResponse(response);
      expect(result.reply).toBe("I'll swap 0.1 ETH for USDC.");
      expect(result.intents).toHaveLength(1);
      expect(result.intents[0].type).toBe('swap');
    });
  });

  describe('callHook()', () => {
    beforeEach(async () => {
      __resetCachedClient();
      mockCreate.mockReset();
      mockExecuteTool.mockReset();
      vi.clearAllMocks();
      const MockAnthropic = await getAnthropicMock();
      MockAnthropic._reset();
      // Default provider to claude-api for SDK-based tests
      vi.mocked(getDefault).mockImplementation(async (key: string, fallback: unknown) => {
        if (key === 'ai.provider') return 'claude-api';
        return fallback;
      });
      vi.mocked(getDefaultSync).mockImplementation((key: string, fallback: unknown) => {
        if (key === 'ai.provider') return 'claude-api';
        return fallback;
      });
    });

    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should return empty defaults when hook instruction is missing', async () => {
      const manifest = testManifest({ hooks: { tick: 'Analyze', execute: 'Execute' } });

      const result = await callHook(manifest, 'init', { config: {} });
      expect(result.intents).toEqual([]);
      expect(result.state).toEqual({});
    });

    it('should call Anthropic with correct parameters and cache_control (no token → fast tier → haiku)', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);
      vi.mocked(validateToken).mockReturnValue(null);

      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"intents": [], "state": {"checked": true}}' }],
      });

      const manifest = testManifest({
        hooks: { tick: 'Analyze the market data', execute: 'Create action' },
      });

      const context = { sources: { prices: [{ eth: 3000 }] }, state: {} };
      const result = await callHook(manifest, 'tick', context);

      // No token → fast tier → haiku → claude-haiku-4-5-20251001
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          system: [
            {
              type: 'text',
              text: '[SYSTEM_CONTEXT]',
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: 'Analyze the market data',
            },
          ],
          messages: [
            {
              role: 'user',
              content: JSON.stringify(context),
            },
          ],
        }),
      );

      expect(result.state).toEqual({ checked: true });
    });

    it('should promote token research message prompts to standard tier when no token is present', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);
      vi.mocked(validateToken).mockReturnValue(null);

      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"reply":"ok","state":{}}' }],
      });

      const manifest = testManifest({
        hooks: { tick: 'unused', execute: 'unused', message: 'Chat helper' },
      });

      await callHook(
        manifest,
        'message',
        { message: 'What is $axiom market cap on base?' },
      );

      // No token usually maps to fast tier, but token research prompts are promoted to standard.
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-5-20250929',
        }),
      );
    });

    it('should promote deep analysis message prompts to powerful tier', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);
      vi.mocked(validateToken).mockReturnValue(null);

      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"reply":"ok","state":{}}' }],
      });

      const manifest = testManifest({
        hooks: { tick: 'unused', execute: 'unused', message: 'Chat helper' },
      });

      await callHook(
        manifest,
        'message',
        { message: "Who's been dumping $axiom? analyze recent transactions." },
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-6',
        }),
      );
    });

    it('should use powerful tier (opus) when token has swap permission', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);
      vi.mocked(validateToken).mockReturnValue({
        agentId: 'test-agent',
        permissions: ['swap', 'wallet:list'],
        exp: Date.now() + 3600000,
      });

      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"intents": [], "state": {}}' }],
      });

      const manifest = testManifest();
      await callHook(manifest, 'tick', {}, 'test-token');

      // swap permission → powerful tier → opus → claude-opus-4-6
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-6',
        }),
      );
    });

    it('should use decoded token payload permissions for tiering when validateToken fails', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);
      vi.mocked(validateToken).mockReturnValue(null);

      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"intents": [], "state": {}}' }],
      });

      const payload = Buffer.from(JSON.stringify({
        agentId: 'bridged-agent',
        permissions: ['swap'],
        exp: Date.now() + 3600000,
      })).toString('base64url');
      const bridgedToken = `${payload}.unsigned`;

      const manifest = testManifest();
      await callHook(manifest, 'tick', {}, bridgedToken);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4-6',
        }),
      );
    });

    it('should use fast tier (haiku) for init hook even with powerful permissions', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);
      vi.mocked(validateToken).mockReturnValue({
        agentId: 'test-agent',
        permissions: ['admin:*'],
        exp: Date.now() + 3600000,
      });

      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"intents": [], "state": {}}' }],
      });

      const manifest = testManifest({
        hooks: { tick: 'Analyze', execute: 'Execute', init: 'Initialize' },
      });

      await callHook(manifest, 'init', { config: {} }, 'test-token');

      // init hook → always fast → haiku
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-haiku-4-5-20251001',
        }),
      );
    });

    it('should return empty defaults on API error', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      mockCreate.mockRejectedValue(new Error('API rate limited'));

      const manifest = testManifest();
      const result = await callHook(manifest, 'tick', {});
      expect(result.intents).toEqual([]);
      expect(result.state).toEqual({});
    });

    it('should concatenate multiple text blocks in response', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      mockCreate.mockResolvedValue({
        content: [
          { type: 'text', text: '{"intents": [{"type":' },
          { type: 'text', text: ' "buy"}], "state": {"multi": true}}' },
        ],
      });

      const manifest = testManifest();
      const result = await callHook(manifest, 'tick', {});
      expect(result.intents).toEqual([{ type: 'buy' }]);
      expect(result.state).toEqual({ multi: true });
    });

    it('should include tools when token is provided', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"intents": [], "state": {}}' }],
        stop_reason: 'end_turn',
      });

      const manifest = testManifest();
      await callHook(manifest, 'tick', {}, 'test-token');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({ name: 'wallet_api' }),
          ]),
        }),
      );
    });

    it('should include tools even when no token is provided', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"intents": [], "state": {}}' }],
        stop_reason: 'end_turn',
      });

      const manifest = testManifest();
      await callHook(manifest, 'tick', {});

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({ name: 'wallet_api' }),
          ]),
        }),
      );
    });

    it('should handle tool-use loop: call tool then get final response', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      // First call: model wants to use a tool
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Let me check your wallets.' },
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'wallet_api',
            input: { method: 'GET', endpoint: '/wallets' },
          },
        ],
        stop_reason: 'tool_use',
      });

      // Second call: model returns final answer after seeing tool result
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'text', text: '{"intents": [], "state": {"walletCount": 2}, "reply": "You have 2 wallets."}' },
        ],
        stop_reason: 'end_turn',
      });

      mockExecuteTool.mockResolvedValue('{"wallets": [{"address": "0x1"}, {"address": "0x2"}]}');

      const manifest = testManifest({ hooks: { tick: 'Check wallets', execute: 'Execute' } });
      const result = await callHook(manifest, 'tick', {}, 'test-token');

      // Verify executeTool was called with correct args
      expect(mockExecuteTool).toHaveBeenCalledWith(
        'wallet_api',
        { method: 'GET', endpoint: '/wallets' },
        'test-token',
      );

      // Verify second API call includes the tool result
      expect(mockCreate).toHaveBeenCalledTimes(2);
      const secondCall = mockCreate.mock.calls[1][0];
      expect(secondCall.messages).toHaveLength(3); // user + assistant + tool_result

      // Verify final result
      expect(result.state).toEqual({ walletCount: 2 });
      expect(result.reply).toBe('You have 2 wallets.');
    });

    it('should stop after MAX_TOOL_CALLS (10) iterations', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      // Always return tool_use — should stop after 10
      mockCreate.mockResolvedValue({
        content: [
          { type: 'text', text: 'Checking...' },
          {
            type: 'tool_use',
            id: 'tool_loop',
            name: 'wallet_api',
            input: { method: 'GET', endpoint: '/wallets' },
          },
        ],
        stop_reason: 'tool_use',
      });

      mockExecuteTool.mockResolvedValue('{"wallets": []}');

      const manifest = testManifest({ hooks: { tick: 'Check wallets', execute: 'Execute' } });
      const result = await callHook(manifest, 'tick', {}, 'test-token');

      // Should have been called but capped at some point
      expect(mockExecuteTool.mock.calls.length).toBeLessThanOrEqual(10);

      // Should still return a result (the text extracted from the last tool_use response)
      expect(result).toBeDefined();
      expect(result.intents).toEqual([]);
    });

    it('should handle tool execution errors gracefully', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      // First call: tool_use
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_err',
            name: 'wallet_api',
            input: { method: 'GET', endpoint: '/bad-endpoint' },
          },
        ],
        stop_reason: 'tool_use',
      });

      // Second call: model handles the error and returns text
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'text', text: '{"intents": [], "state": {}, "reply": "API call failed"}' },
        ],
        stop_reason: 'end_turn',
      });

      mockExecuteTool.mockResolvedValue('{"error": "API call failed: Connection refused"}');

      const manifest = testManifest({ hooks: { tick: 'Check wallets', execute: 'Execute' } });
      const result = await callHook(manifest, 'tick', {}, 'test-token');

      expect(result.reply).toBe('API call failed');
      // The error tool result was passed back to the model
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('should handle request_human_action in tool-use loop', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      // First call: model tries wallet_api POST /swap → gets 403
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_swap',
            name: 'wallet_api',
            input: { method: 'POST', endpoint: '/swap', body: { amount: '0.01' } },
          },
        ],
        stop_reason: 'tool_use',
      });

      // Second call: model sees 403, calls request_human_action
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_rha',
            name: 'request_human_action',
            input: {
              summary: 'Swap 0.01 ETH for USDC',
              permissions: ['swap'],
              action: { endpoint: '/swap', method: 'POST', body: { amount: '0.01' } },
            },
          },
        ],
        stop_reason: 'tool_use',
      });

      // Third call: model returns final reply
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'text', text: '{"reply": "Approval requested for swap.", "state": {}}' },
        ],
        stop_reason: 'end_turn',
      });

      // wallet_api returns 403
      mockExecuteTool.mockResolvedValueOnce('{"error": "Insufficient permissions", "status": 403}');
      // request_human_action returns success
      mockExecuteTool.mockResolvedValueOnce('{"success": true, "requestId": "req-1", "message": "Waiting for human approval"}');

      const manifest = testManifest({
        hooks: { tick: 'unused', execute: 'unused', message: 'Swap assistant' },
      });
      const result = await callHook(manifest, 'message', { message: 'swap 0.01 ETH' }, 'test-token');

      expect(mockExecuteTool).toHaveBeenCalledTimes(2);
      expect(mockExecuteTool).toHaveBeenNthCalledWith(1, 'wallet_api', expect.any(Object), 'test-token');
      expect(mockExecuteTool).toHaveBeenNthCalledWith(2, 'request_human_action', expect.any(Object), 'test-token');
      expect(result.reply).toBe('Approval requested for swap.');
    });

    it('should use tool-call system context for message hooks', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"reply": "Hi", "state": {}}' }],
        stop_reason: 'end_turn',
      });

      const manifest = testManifest({
        hooks: { tick: 'unused', execute: 'unused', message: 'Chat helper' },
      });
      await callHook(manifest, 'message', { message: 'hello' }, 'test-token');

      // System context should be the tool-call variant
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.arrayContaining([
            expect.objectContaining({ text: '[SYSTEM_CONTEXT_TOOL_CALL]' }),
          ]),
        }),
      );
    });

    it('should use intent system context for tick hooks', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"intents": [], "state": {}}' }],
        stop_reason: 'end_turn',
      });

      const manifest = testManifest();
      await callHook(manifest, 'tick', {}, 'test-token');

      // System context should be the intent variant
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.arrayContaining([
            expect.objectContaining({ text: '[SYSTEM_CONTEXT]' }),
          ]),
        }),
      );
    });

    it('should fire onProgress callback on each tool call', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.mocked(prisma.apiKey.findFirst).mockResolvedValue(null);

      // First call: model calls wallet_api GET /wallets
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'wallet_api',
            input: { method: 'GET', endpoint: '/wallets' },
          },
        ],
        stop_reason: 'tool_use',
      });

      // Second call: model calls wallet_api POST /swap
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: 'tool_use',
            id: 'tool_2',
            name: 'wallet_api',
            input: { method: 'POST', endpoint: '/swap', body: {} },
          },
        ],
        stop_reason: 'tool_use',
      });

      // Third call: final response
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: 'text', text: '{"reply": "Done!", "state": {}}' },
        ],
        stop_reason: 'end_turn',
      });

      mockExecuteTool.mockResolvedValue('{"ok": true}');

      const progressCalls: string[] = [];
      const onProgress = (status: string) => { progressCalls.push(status); };

      const manifest = testManifest({
        hooks: { tick: 'unused', execute: 'unused', message: 'Swap assistant' },
      });
      await callHook(manifest, 'message', { message: 'swap' }, 'test-token', onProgress);

      expect(progressCalls).toEqual([
        'checking your wallets...',
        'preparing the swap...',
      ]);
    });
  });

  describe('toolCallToStatus()', () => {
    it('should return "requesting approval..." for request_human_action', () => {
      expect(toolCallToStatus('request_human_action', {})).toBe('requesting approval...');
    });

    it('should return "checking your wallets..." for GET /wallets', () => {
      expect(toolCallToStatus('wallet_api', { method: 'GET', endpoint: '/wallets' })).toBe('checking your wallets...');
    });

    it('should return "looking up assets..." for asset endpoints', () => {
      expect(toolCallToStatus('wallet_api', { method: 'GET', endpoint: '/wallet/0x123/assets' })).toBe('looking up assets...');
    });

    it('should return "preparing the swap..." for POST /swap', () => {
      expect(toolCallToStatus('wallet_api', { method: 'POST', endpoint: '/swap' })).toBe('preparing the swap...');
    });

    it('should return "checking swap routes..." for GET /swap', () => {
      expect(toolCallToStatus('wallet_api', { method: 'GET', endpoint: '/swap' })).toBe('checking swap routes...');
    });

    it('should return "preparing the transfer..." for /send', () => {
      expect(toolCallToStatus('wallet_api', { method: 'POST', endpoint: '/send' })).toBe('preparing the transfer...');
    });

    it('should return "funding the wallet..." for /fund', () => {
      expect(toolCallToStatus('wallet_api', { method: 'POST', endpoint: '/fund' })).toBe('funding the wallet...');
    });

    it('should return "launching the token..." for /launch', () => {
      expect(toolCallToStatus('wallet_api', { method: 'POST', endpoint: '/launch' })).toBe('launching the token...');
    });

    it('should return "looking up token info..." for /token/* endpoints', () => {
      expect(toolCallToStatus('wallet_api', { method: 'GET', endpoint: '/token/0xabc' })).toBe('looking up token info...');
    });

    it('should return null for unknown endpoints', () => {
      expect(toolCallToStatus('wallet_api', { method: 'GET', endpoint: '/unknown' })).toBeNull();
    });

    it('should return null for unknown tool names (non request_human_action)', () => {
      expect(toolCallToStatus('some_other_tool', {})).toBeNull();
    });
  });

});
