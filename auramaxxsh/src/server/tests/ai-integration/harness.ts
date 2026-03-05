/**
 * AI Integration Test Harness
 * ===========================
 * Provides setup/teardown, fetch interception, and a `runPrompt()` helper
 * that drives the full AI message pipeline with scripted model responses.
 *
 * Mock boundary: Only the Anthropic SDK is mocked (scripted responses).
 * Everything from executeTool through Express routes is real code.
 */

import http from 'http';
import { createTestApp, cleanDatabase, setupAndUnlockWallet, resetColdWallet } from '../setup';
import { createToken } from '../../lib/auth';
import { __resetCachedClient } from '../../lib/ai';
import { clearAllMessageQueues, processMessage } from '../../lib/strategy/message';
import type { StrategyManifest } from '../../lib/strategy/types';
import type { Mock } from 'vitest';

// ─── Types ──────────────────────────────────────────────────────────

/** A scripted AI response turn */
export type ScriptedTurn =
  | { toolCalls: Array<{ name: string; input: Record<string, unknown> }> }
  | { text: string };

// ─── Module state ───────────────────────────────────────────────────

let testServer: http.Server | null = null;
let testPort: number = 0;
let originalFetch: typeof globalThis.fetch;
let adminToken: string = '';

// ─── Setup / Teardown ───────────────────────────────────────────────

/**
 * Start the test Express app on a random port and intercept fetch.
 * Sets up the cold wallet, unlocks it, and returns an admin token.
 */
export async function setupTestServer(): Promise<{ port: number; adminToken: string }> {
  const app = createTestApp();

  // Start on random port
  testServer = app.listen(0);
  const addr = testServer.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get test server address');
  testPort = addr.port;

  // Intercept globalThis.fetch to redirect 127.0.0.1:4242 → test port
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('http://127.0.0.1:4242')) {
      input = input.replace('http://127.0.0.1:4242', `http://127.0.0.1:${testPort}`);
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;

  // Setup wallet and get admin token
  await cleanDatabase();
  const result = await setupAndUnlockWallet();
  adminToken = result.adminToken;

  // Force SDK path (not CLI) for all hook calls
  process.env.ANTHROPIC_API_KEY = 'test-key-for-ai-integration';

  return { port: testPort, adminToken };
}

/**
 * Stop the test server, restore fetch, clean up state.
 */
export async function teardownTestServer(): Promise<void> {
  delete process.env.ANTHROPIC_API_KEY;

  if (testServer) {
    await new Promise<void>((resolve) => testServer!.close(() => resolve()));
    testServer = null;
  }

  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }

  resetColdWallet();
  await cleanDatabase();
}

// ─── Token helpers ──────────────────────────────────────────────────

/**
 * Create an agent token with given permissions (registered in sessions Map).
 */
export async function createAgentToken(
  permissions: string[],
  options?: { limits?: Record<string, number>; walletAccess?: string[]; agentId?: string },
): Promise<string> {
  const agentId = options?.agentId || 'app:ai-test';
  return createToken(agentId, 0, permissions, 3600, {
    limits: options?.limits,
    walletAccess: options?.walletAccess,
  });
}

// ─── Wallet helpers ─────────────────────────────────────────────────

/**
 * Create a hot wallet via the wallet API (uses fetch interception).
 */
export async function createHotWallet(
  token: string,
  name: string = 'Test Hot Wallet',
): Promise<string> {
  const res = await fetch('http://127.0.0.1:4242/wallet/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tier: 'hot', name }),
  });
  const data = (await res.json()) as { wallet?: { address?: string } };
  if (!data.wallet?.address) {
    throw new Error(`Failed to create hot wallet: ${JSON.stringify(data)}`);
  }
  return data.wallet.address;
}

// ─── Manifest ───────────────────────────────────────────────────────

/**
 * Default test manifest for AI integration tests.
 */
export function testManifest(overrides?: Partial<StrategyManifest>): StrategyManifest {
  return {
    id: 'ai-test-app',
    name: 'AI Test App',
    sources: [],
    hooks: { message: 'You are a helpful wallet assistant.' },
    config: {},
    permissions: ['wallet:list', 'action:create'],
    ...overrides,
  };
}

// ─── Response conversion ────────────────────────────────────────────

/** Incrementing tool ID counter for unique tool_use block IDs */
let toolIdCounter = 0;

/**
 * Convert a ScriptedTurn into an Anthropic SDK response object.
 */
function turnToResponse(turn: ScriptedTurn): Record<string, unknown> {
  if ('text' in turn) {
    return {
      content: [{ type: 'text', text: turn.text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    };
  }

  const content = turn.toolCalls.map((tc) => ({
    type: 'tool_use',
    id: `toolu_${++toolIdCounter}`,
    name: tc.name,
    input: tc.input,
  }));

  return {
    content,
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

// ─── runPrompt ──────────────────────────────────────────────────────

/**
 * Run a prompt through the full AI message pipeline with scripted responses.
 *
 * Programs the mock Anthropic client with the given turns, then calls
 * processMessage() which drives the real callHookViaSdk tool-use loop.
 * Tool calls hit the real Express server (via fetch interception).
 *
 * @param mockCreate - The vi.fn() mock for Anthropic client.messages.create
 * @param prompt - The user message to process
 * @param turns - Scripted AI responses (tool_use and text turns)
 * @param options - Optional overrides for manifest, token, permissions
 */
export async function runPrompt(
  mockCreate: Mock,
  prompt: string,
  turns: ScriptedTurn[],
  options?: {
    manifest?: StrategyManifest;
    token?: string;
    permissions?: string[];
  },
): Promise<{ reply: string | null; error?: string }> {
  // Reset between prompts
  clearAllMessageQueues();
  __resetCachedClient();
  mockCreate.mockReset();

  // Program mock with scripted responses
  toolIdCounter = 0;
  for (const turn of turns) {
    mockCreate.mockResolvedValueOnce(turnToResponse(turn));
  }

  // Create token if not provided
  let token = options?.token;
  if (!token) {
    const permissions = options?.permissions || ['wallet:list', 'action:create'];
    token = await createAgentToken(permissions);
  }

  const manifest = options?.manifest || testManifest();

  return processMessage(
    { appId: `test-${Date.now()}`, message: prompt },
    { manifest, token },
  );
}

// ─── Accessors ──────────────────────────────────────────────────────

/** Get the current test server port. */
export function getTestPort(): number {
  return testPort;
}

/** Get the admin token (set during setupTestServer). */
export function getAdminToken(): string {
  return adminToken;
}
