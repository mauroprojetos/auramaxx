/**
 * Tests for AI client module (server/lib/ai.ts)
 *
 * Tests:
 * - getAnthropicClient — env var priority, DB fallback, no key error, caching
 * - getOpenAiClient — env var priority, DB fallback, no key error
 * - getProviderMode — reads from defaults, fallback works
 * - getDefaultModel — reads from defaults, fallback works
 * - resolveModelId — dispatches to correct model map per provider
 * - getProviderStatus — detects CLI availability and key presence
 * - getAiProvider — backward compat returns 'sdk' or 'cli'
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/apikey-migration', () => ({
  ensureApiKeysMigrated: vi.fn(async () => undefined),
  hasActiveApiKeyCredential: vi.fn(() => false),
  readApiKeyValueByService: vi.fn(() => null),
}));

// Mock defaults module
vi.mock('../../lib/defaults', () => {
  const listeners = new Map<string, Set<Function>>();
  return {
    getDefault: vi.fn(async (_key: string, fallback: unknown) => fallback),
    getDefaultSync: vi.fn((_key: string, fallback: unknown) => fallback),
    onDefaultChanged: vi.fn((key: string, cb: Function) => {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(cb);
      return () => { listeners.get(key)?.delete(cb); };
    }),
    invalidateCache: vi.fn(),
    __triggerListener: (key: string, value: unknown) => {
      listeners.get(key)?.forEach(cb => cb(key, value));
    },
  };
});

// Mock the Anthropic SDK as a class constructor
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: vi.fn() };
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

// Mock the OpenAI SDK as a class constructor
vi.mock('openai', () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } };
    _opts: any;
    constructor(opts: any) {
      MockOpenAI._lastOpts = opts;
      MockOpenAI._callCount++;
      this._opts = opts;
    }
    static _lastOpts: any = null;
    static _callCount = 0;
    static _reset() {
      MockOpenAI._lastOpts = null;
      MockOpenAI._callCount = 0;
    }
  }
  return { default: MockOpenAI };
});

// Mock child_process.execFile for CLI availability checks
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import {
  getAnthropicClient,
  getOpenAiClient,
  getProviderMode,
  getDefaultModel,
  resolveModelId,
  getProviderStatus,
  getAiProvider,
  shouldUseCli,
  selectModelTier,
  MODEL_TIERS,
  __resetCachedClient,
  PROVIDER_MODELS,
} from '../../lib/ai';
import {
  hasActiveApiKeyCredential,
  readApiKeyValueByService,
} from '../../lib/apikey-migration';
import { getDefault } from '../../lib/defaults';
import { execFile } from 'child_process';

/** Helper to get the mock Anthropic class statics */
async function getAnthropicMock() {
  const mod = await import('@anthropic-ai/sdk');
  return mod.default as any;
}

/** Helper to get the mock OpenAI class statics */
async function getOpenAiMock() {
  const mod = await import('openai');
  return mod.default as any;
}

describe('AI Client Module', () => {
  describe('getAnthropicClient()', () => {
    beforeEach(async () => {
      __resetCachedClient();
      vi.clearAllMocks();
      const MockAnthropic = await getAnthropicMock();
      MockAnthropic._reset();
    });

    afterEach(() => {
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('should prefer env var over agent key', async () => {
      process.env.ANTHROPIC_API_KEY = 'env-key-456';
      vi.mocked(readApiKeyValueByService).mockReturnValue('agent-key-789');

      await getAnthropicClient();
      const MockAnthropic = await getAnthropicMock();
      expect(MockAnthropic._lastOpts).toEqual({ apiKey: 'env-key-456' });
    });

    it('should fall back to API key in agent when no env var', async () => {
      vi.mocked(readApiKeyValueByService).mockReturnValue('agent-key-789');

      await getAnthropicClient();
      const MockAnthropic = await getAnthropicMock();
      expect(MockAnthropic._lastOpts).toEqual({ apiKey: 'agent-key-789' });
    });

    it('should throw when no key is available', async () => {
      vi.mocked(readApiKeyValueByService).mockReturnValue(null);

      await expect(getAnthropicClient()).rejects.toThrow('No Anthropic credentials found');
    });

    it('should cache the client on subsequent calls', async () => {
      process.env.ANTHROPIC_API_KEY = 'cache-test-key';

      const MockAnthropic = await getAnthropicMock();
      MockAnthropic._reset();

      await getAnthropicClient();
      await getAnthropicClient();

      // Anthropic constructor should only be called once due to caching
      expect(MockAnthropic._callCount).toBe(1);
    });
  });

  describe('getOpenAiClient()', () => {
    beforeEach(async () => {
      __resetCachedClient();
      vi.clearAllMocks();
      const MockOpenAI = await getOpenAiMock();
      MockOpenAI._reset();
    });

    afterEach(() => {
      delete process.env.OPENAI_API_KEY;
    });

    it('should prefer env var over agent key', async () => {
      process.env.OPENAI_API_KEY = 'sk-openai-env';
      vi.mocked(readApiKeyValueByService).mockReturnValue('sk-openai-agent');

      await getOpenAiClient();
      const MockOpenAI = await getOpenAiMock();
      expect(MockOpenAI._lastOpts).toEqual({ apiKey: 'sk-openai-env' });
    });

    it('should fall back to agent key when no env var', async () => {
      vi.mocked(readApiKeyValueByService).mockReturnValue('sk-openai-agent');

      await getOpenAiClient();
      const MockOpenAI = await getOpenAiMock();
      expect(MockOpenAI._lastOpts).toEqual({ apiKey: 'sk-openai-agent' });
    });

    it('should throw when no key is available', async () => {
      vi.mocked(readApiKeyValueByService).mockReturnValue(null);

      await expect(getOpenAiClient()).rejects.toThrow('No OpenAI credentials found');
    });

    it('should cache the client on subsequent calls', async () => {
      process.env.OPENAI_API_KEY = 'sk-cache-test';

      const MockOpenAI = await getOpenAiMock();
      MockOpenAI._reset();

      await getOpenAiClient();
      await getOpenAiClient();

      expect(MockOpenAI._callCount).toBe(1);
    });
  });

  describe('getProviderMode()', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should return fallback (claude-cli) when no default set', async () => {
      vi.mocked(getDefault).mockResolvedValue('claude-cli');
      const mode = await getProviderMode();
      expect(mode).toBe('claude-cli');
    });

    it('should return the configured provider', async () => {
      vi.mocked(getDefault).mockResolvedValue('openai-api');
      const mode = await getProviderMode();
      expect(mode).toBe('openai-api');
    });
  });

  describe('getDefaultModel()', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should return standard tier model for claude-cli provider', async () => {
      vi.mocked(getDefault).mockResolvedValue('claude-cli');
      const model = await getDefaultModel();
      expect(model).toBe(MODEL_TIERS['claude-cli'].standard); // 'sonnet'
    });

    it('should return standard tier model for openai-api provider', async () => {
      vi.mocked(getDefault).mockResolvedValue('openai-api');
      const model = await getDefaultModel();
      expect(model).toBe(MODEL_TIERS['openai-api'].standard); // 'codex'
    });
  });

  describe('selectModelTier()', () => {
    it('should return fast for init hook regardless of permissions', () => {
      expect(selectModelTier('init', ['swap', 'admin:*'])).toBe('fast');
    });

    it('should return fast for shutdown hook regardless of permissions', () => {
      expect(selectModelTier('shutdown', ['fund', 'send:hot'])).toBe('fast');
    });

    it('should return powerful for token with swap permission', () => {
      expect(selectModelTier('tick', ['swap'])).toBe('powerful');
    });

    it('should return powerful for token with fund + send:hot permissions', () => {
      expect(selectModelTier('tick', ['fund', 'send:hot'])).toBe('powerful');
    });

    it('should return standard for token with wallet:create:hot only', () => {
      expect(selectModelTier('tick', ['wallet:create:hot'])).toBe('standard');
    });

    it('should return fast for no token (empty permissions)', () => {
      expect(selectModelTier('tick', [])).toBe('fast');
    });

    it('should return powerful for admin:* permission', () => {
      expect(selectModelTier('message', ['admin:*'])).toBe('powerful');
    });
  });

  describe('MODEL_TIERS', () => {
    it('should have fast/standard/powerful for all providers', () => {
      for (const provider of ['claude-cli', 'claude-api', 'codex-cli', 'openai-api'] as const) {
        expect(MODEL_TIERS[provider]).toHaveProperty('fast');
        expect(MODEL_TIERS[provider]).toHaveProperty('standard');
        expect(MODEL_TIERS[provider]).toHaveProperty('powerful');
      }
    });
  });

  describe('resolveModelId()', () => {
    it('should return short name for claude-cli', () => {
      expect(resolveModelId('sonnet', 'claude-cli')).toBe('sonnet');
      expect(resolveModelId('haiku', 'claude-cli')).toBe('haiku');
    });

    it('should map to full SDK ID for claude-api', () => {
      expect(resolveModelId('sonnet', 'claude-api')).toBe('claude-sonnet-4-5-20250929');
      expect(resolveModelId('haiku', 'claude-api')).toBe('claude-haiku-4-5-20251001');
      expect(resolveModelId('opus', 'claude-api')).toBe('claude-opus-4-6');
    });

    it('should return short name for codex-cli', () => {
      expect(resolveModelId('codex', 'codex-cli')).toBe('codex');
      expect(resolveModelId('codex-mini', 'codex-cli')).toBe('codex-mini');
    });

    it('should map to full SDK ID for openai-api', () => {
      expect(resolveModelId('codex', 'openai-api')).toBe('gpt-5.3-codex');
      expect(resolveModelId('codex-mini', 'openai-api')).toBe('gpt-5.1-codex-mini');
      expect(resolveModelId('codex-max', 'openai-api')).toBe('gpt-5.1-codex-max');
    });

    it('should pass through unknown model names', () => {
      expect(resolveModelId('custom-model', 'claude-api')).toBe('custom-model');
      expect(resolveModelId('custom-model', 'openai-api')).toBe('custom-model');
    });
  });

  describe('PROVIDER_MODELS', () => {
    it('should have models for all provider modes', () => {
      expect(PROVIDER_MODELS['claude-cli']).toEqual(['haiku', 'sonnet', 'opus']);
      expect(PROVIDER_MODELS['claude-api']).toEqual(['haiku', 'sonnet', 'opus']);
      expect(PROVIDER_MODELS['codex-cli']).toEqual(['codex-mini', 'codex', 'codex-max']);
      expect(PROVIDER_MODELS['openai-api']).toEqual(['codex-mini', 'codex', 'codex-max']);
    });
  });

  describe('getProviderStatus()', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
    });

    it('should detect CLI availability and key presence', async () => {
      // Mock `which` — claude found, codex not found
      vi.mocked(execFile as any).mockImplementation((cmd: string, args: string[], cb: Function) => {
        if (args[0] === 'claude') cb(null);  // success
        else if (args[0] === 'codex') cb(new Error('not found'));  // not found
      });

      // No API keys in env or agent
      vi.mocked(hasActiveApiKeyCredential).mockReturnValue(false);

      const status = await getProviderStatus();

      expect(status).toHaveLength(4);
      expect(status[0]).toMatchObject({ mode: 'claude-cli', available: true });
      expect(status[1]).toMatchObject({ mode: 'claude-api', available: false, reason: 'No Anthropic API key configured' });
      expect(status[2]).toMatchObject({ mode: 'codex-cli', available: false });
      expect(status[3]).toMatchObject({ mode: 'openai-api', available: false, reason: 'No OpenAI API key configured' });
    });

    it('should detect API key from env var', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      vi.mocked(execFile as any).mockImplementation((_cmd: string, _args: string[], cb: Function) => {
        cb(new Error('not found'));
      });
      vi.mocked(hasActiveApiKeyCredential).mockReturnValue(false);

      const status = await getProviderStatus();

      expect(status[1]).toMatchObject({ mode: 'claude-api', available: true, reason: 'Anthropic API key configured' });
    });

    it('should detect API key from agent', async () => {
      vi.mocked(execFile as any).mockImplementation((_cmd: string, _args: string[], cb: Function) => {
        cb(new Error('not found'));
      });
      vi.mocked(hasActiveApiKeyCredential).mockImplementation((service: string) => {
        return service === 'openai';
      });

      const status = await getProviderStatus();

      expect(status[3]).toMatchObject({ mode: 'openai-api', available: true, reason: 'OpenAI API key configured' });
    });

    it('should include models array for each provider', async () => {
      vi.mocked(execFile as any).mockImplementation((_cmd: string, _args: string[], cb: Function) => {
        cb(new Error('not found'));
      });
      vi.mocked(hasActiveApiKeyCredential).mockReturnValue(false);

      const status = await getProviderStatus();

      expect(status[0].models).toEqual(['haiku', 'sonnet', 'opus']);
      expect(status[2].models).toEqual(['codex-mini', 'codex', 'codex-max']);
    });
  });

  describe('shouldUseCli() (backward compat)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should return true for CLI providers', async () => {
      vi.mocked(getDefault).mockResolvedValue('claude-cli');
      expect(await shouldUseCli()).toBe(true);
    });

    it('should return true for codex-cli', async () => {
      vi.mocked(getDefault).mockResolvedValue('codex-cli');
      expect(await shouldUseCli()).toBe(true);
    });

    it('should return false for API providers', async () => {
      vi.mocked(getDefault).mockResolvedValue('claude-api');
      expect(await shouldUseCli()).toBe(false);
    });
  });

  describe('getAiProvider() (backward compat)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should return "cli" for CLI providers', async () => {
      vi.mocked(getDefault).mockResolvedValue('claude-cli');
      expect(await getAiProvider()).toBe('cli');
    });

    it('should return "sdk" for API providers', async () => {
      vi.mocked(getDefault).mockResolvedValue('openai-api');
      expect(await getAiProvider()).toBe('sdk');
    });
  });

  describe('Client cache reset on provider change', () => {
    it('should reset cached clients when provider changes', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const MockAnthropic = await getAnthropicMock();
      MockAnthropic._reset();
      __resetCachedClient();

      // Create a cached client
      await getAnthropicClient();
      expect(MockAnthropic._callCount).toBe(1);

      // Trigger provider change
      const { __triggerListener } = await import('../../lib/defaults') as any;
      __triggerListener('ai.provider', 'openai-api');

      // Next call should create a new client
      await getAnthropicClient();
      expect(MockAnthropic._callCount).toBe(2);

      delete process.env.ANTHROPIC_API_KEY;
    });
  });
});
