/**
 * Live Model AI Test Harness
 * ==========================
 * Provides setup/teardown and a `runLivePrompt()` helper that drives the full
 * AI message pipeline with REAL Claude — no mocking.
 *
 * Separate from harness.ts to avoid any vi.mock contamination.
 *
 * AI provider resolution (same priority as production):
 *   1. ANTHROPIC_API_KEY env var (if already set)
 *   2. ApiKey from real ~/.auramaxx/ DB (service: 'anthropic')
 *   3. claude CLI fallback (subscription/OAuth)
 *
 * The test Express server runs on a random port, reached via:
 *   - WALLET_SERVER_URL env var (for executeTool + MCP subprocess)
 *   - globalThis.fetch interception (belt-and-suspenders for hardcoded URLs)
 */

import http from 'http';
import path from 'path';
import os from 'os';
import { PrismaClient } from '@prisma/client';
import { createTestApp, cleanDatabase, setupAndUnlockWallet, resetColdWallet } from '../setup';
import { createToken } from '../../lib/auth';
import { __resetCachedClient } from '../../lib/ai';
import { clearAllMessageQueues, processMessage } from '../../lib/strategy/message';
import { clearAllCliSessions } from '../../lib/strategy/hooks';
import type { StrategyManifest } from '../../lib/strategy/types';

// ─── Module state ───────────────────────────────────────────────────

let testServer: http.Server | null = null;
let testPort: number = 0;
let originalFetch: typeof globalThis.fetch;
let adminToken: string = '';
let didSetApiKey = false;

// ─── AI key bootstrap ───────────────────────────────────────────────

/**
 * Read the Anthropic API key from the real ~/.auramaxx/ database.
 * Same lookup as getAnthropicClient() in lib/ai.ts — checks the ApiKey
 * table for service: 'anthropic'. Returns null if not found.
 */
async function loadAnthropicKeyFromRealDb(): Promise<string | null> {
  const realDbPath = path.join(os.homedir(), '.auramaxx', 'auramaxx.db');
  let realPrisma: PrismaClient | null = null;
  try {
    realPrisma = new PrismaClient({
      datasources: { db: { url: `file:${realDbPath}` } },
    });
    const row = await realPrisma.apiKey.findFirst({
      where: { service: 'anthropic', isActive: true },
    });
    return row?.key || null;
  } catch {
    return null;
  } finally {
    await realPrisma?.$disconnect();
  }
}

// ─── Setup / Teardown ───────────────────────────────────────────────

/**
 * Start the test Express app on a random port.
 * Sets up the cold wallet, unlocks it, and returns an admin token.
 *
 * AI provider: reads the Anthropic API key from the real ~/.auramaxx/ DB
 * (same as production) and sets it as ANTHROPIC_API_KEY so the SDK path is
 * used. Falls back to claude CLI if no key is found.
 */
export async function setupTestServer(): Promise<{ port: number; adminToken: string }> {
  const app = createTestApp();

  // Start on random port
  testServer = app.listen(0);
  const addr = testServer.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get test server address');
  testPort = addr.port;

  // Set WALLET_SERVER_URL so executeTool (in-process) and MCP subprocess
  // both reach the test server
  process.env.WALLET_SERVER_URL = `http://127.0.0.1:${testPort}`;

  // Intercept fetch for any code that still uses hardcoded 127.0.0.1:4242
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('http://127.0.0.1:4242')) {
      input = input.replace('http://127.0.0.1:4242', `http://127.0.0.1:${testPort}`);
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;

  // Bootstrap AI provider: read API key from real DB → set as env var → SDK path
  if (!process.env.ANTHROPIC_API_KEY) {
    const key = await loadAnthropicKeyFromRealDb();
    if (key) {
      process.env.ANTHROPIC_API_KEY = key;
      didSetApiKey = true;
      console.log('[live-harness] Loaded Anthropic API key from ~/.auramaxx/ DB → SDK path');
    } else {
      console.log('[live-harness] No API key in DB, falling back to claude CLI path');
    }
  }

  // Setup wallet and get admin token
  await cleanDatabase();
  const result = await setupAndUnlockWallet();
  adminToken = result.adminToken;

  return { port: testPort, adminToken };
}

/**
 * Stop the test server, restore fetch, clean up state.
 */
export async function teardownTestServer(): Promise<void> {
  delete process.env.WALLET_SERVER_URL;

  // Only delete the key if we set it (don't clobber a user-provided env var)
  if (didSetApiKey) {
    delete process.env.ANTHROPIC_API_KEY;
    didSetApiKey = false;
  }

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
  const agentId = options?.agentId || 'app:ai-live-test';
  return createToken(agentId, 0, permissions, 3600, {
    limits: options?.limits,
    walletAccess: options?.walletAccess,
  });
}

// ─── Wallet helpers ─────────────────────────────────────────────────

/**
 * Create a hot wallet via the wallet API.
 */
export async function createHotWallet(
  token: string,
  name: string = 'Test Hot Wallet',
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${testPort}/wallet/create`, {
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
 * Default test manifest for live AI tests. Uses haiku for speed + cost.
 */
export function testManifest(overrides?: Partial<StrategyManifest>): StrategyManifest {
  return {
    id: 'ai-live-test-app',
    name: 'AI Live Test App',
    sources: [],
    hooks: { message: 'You are a helpful wallet assistant.' },
    config: { model: 'haiku' },
    permissions: ['wallet:list', 'action:create'],
    ...overrides,
  };
}

// ─── runLivePrompt ──────────────────────────────────────────────────

/**
 * Run a prompt through the full AI message pipeline with REAL Claude.
 *
 * No mocking — calls processMessage() which drives the real hook caller.
 * Uses SDK path (API key from DB) or CLI path (claude subscription) as fallback.
 * Tool calls hit the real Express server via WALLET_SERVER_URL / fetch interception.
 *
 * @param prompt - The user message to process
 * @param options - Optional overrides for manifest, token, permissions
 */
export async function runLivePrompt(
  prompt: string,
  options?: {
    manifest?: StrategyManifest;
    token?: string;
    permissions?: string[];
  },
): Promise<{ reply: string | null; error?: string }> {
  // Reset between prompts — clear message queues, AI client cache, and CLI sessions
  // so each test gets a fresh conversation (no accumulated context from prior tests)
  clearAllMessageQueues();
  __resetCachedClient();
  clearAllCliSessions();

  // Create token if not provided
  let token = options?.token;
  if (!token) {
    const permissions = options?.permissions || ['wallet:list', 'action:create'];
    token = await createAgentToken(permissions);
  }

  const manifest = options?.manifest || testManifest();

  return processMessage(
    { appId: `live-test-${Date.now()}`, message: prompt },
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
