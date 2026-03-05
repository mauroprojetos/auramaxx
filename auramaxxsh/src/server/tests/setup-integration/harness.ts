/**
 * Setup Integration Test Harness
 * ===============================
 * Provides setup/teardown and helpers for testing the full setup wizard flow.
 *
 * Mock boundary: Only external HTTP calls (Alchemy, Anthropic, Telegram) are
 * intercepted. All Express routes, DB operations, and auth run against real code.
 */

import http from 'http';
import {
  createTestApp,
  cleanDatabase,
  setupAndUnlockWallet,
  setupColdWallet,
  resetColdWallet,
  encryptPasswordForTest,
  testPrisma,
  TEST_PASSWORD,
  TEST_AGENT_PUBKEY,
} from '../setup';
import { createTokenSync as createToken } from '../../lib/auth';
import { revokeAdminTokens } from '../../lib/auth';
import { lock } from '../../lib/cold';

// ─── Module state ───────────────────────────────────────────────

let testServer: http.Server | null = null;
let testPort: number = 0;
let originalFetch: typeof globalThis.fetch;
let adminToken: string = '';

// External URL patterns to intercept
const EXTERNAL_PATTERNS = [
  'api.anthropic.com',
  'g.alchemy.com',
  'api.telegram.org',
  'hooks.example.com',
];

// Mock response registry for external URLs
type MockResponse = { status: number; body: unknown };
const mockResponses = new Map<string, MockResponse>();

// ─── Setup / Teardown ───────────────────────────────────────────

/**
 * Start a fresh server with NO agent (unconfigured state).
 */
export async function startFreshServer(): Promise<{ port: number }> {
  await cleanDatabase();
  // Also clean tables not covered by cleanDatabase()
  await testPrisma.apiKey.deleteMany();
  await testPrisma.appConfig.deleteMany();
  resetColdWallet();

  const app = createTestApp();
  testServer = app.listen(0);
  const addr = testServer.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get test server address');
  testPort = addr.port;

  installFetchInterceptor();

  return { port: testPort };
}

/**
 * Start a server with agent created and unlocked.
 */
export async function startInitializedServer(): Promise<{ port: number; adminToken: string }> {
  await cleanDatabase();
  // Also clean tables not covered by cleanDatabase()
  await testPrisma.apiKey.deleteMany();
  await testPrisma.appConfig.deleteMany();
  resetColdWallet();

  const app = createTestApp();
  testServer = app.listen(0);
  const addr = testServer.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get test server address');
  testPort = addr.port;

  installFetchInterceptor();

  // Setup and unlock wallet
  const result = await setupAndUnlockWallet();
  adminToken = result.adminToken;

  return { port: testPort, adminToken };
}

/**
 * Tear down the test server and clean up.
 */
export async function teardownServer(): Promise<void> {
  if (testServer) {
    await new Promise<void>((resolve) => testServer!.close(() => resolve()));
    testServer = null;
  }

  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }

  mockResponses.clear();
  revokeAdminTokens();
  lock();
  resetColdWallet();
  await cleanDatabase();
  await testPrisma.apiKey.deleteMany();
  await testPrisma.appConfig.deleteMany();
}

// ─── Fetch interception ─────────────────────────────────────────

function installFetchInterceptor(): void {
  originalFetch = globalThis.fetch;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    // Check if this is an external URL we should intercept
    const isExternal = EXTERNAL_PATTERNS.some((pattern) => url.includes(pattern));

    if (isExternal) {
      // Check mock registry for matching response
      for (const [pattern, response] of mockResponses) {
        if (url.includes(pattern)) {
          return Promise.resolve(
            new Response(JSON.stringify(response.body), {
              status: response.status,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
      }

      // Default: return 500 for unmocked external calls
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'Unmocked external call' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }

    // Route localhost requests through real server
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
}

// ─── Mock helpers ───────────────────────────────────────────────

/**
 * Register a mock response for external URLs matching a pattern.
 */
export function mockExternalResponse(urlPattern: string, status: number, body: unknown): void {
  mockResponses.set(urlPattern, { status, body });
}

/**
 * Clear all registered mock responses.
 */
export function clearMocks(): void {
  mockResponses.clear();
}

// ─── API helpers ────────────────────────────────────────────────

function baseUrl(): string {
  return `http://127.0.0.1:${testPort}`;
}

export async function fetchSetup(token?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await originalFetch(`${baseUrl()}/setup`, { headers });
  return res.json();
}

export async function createAgentViaApi(password: string = TEST_PASSWORD): Promise<{ address: string; mnemonic: string; token: string }> {
  const encrypted = encryptPasswordForTest(password);
  const res = await originalFetch(`${baseUrl()}/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted, pubkey: TEST_AGENT_PUBKEY }),
  });
  const data = (await res.json()) as { success: boolean; address: string; mnemonic: string; token: string };
  if (!data.success) throw new Error('Failed to create agent');
  adminToken = data.token;
  return data;
}

export async function unlockAgentViaApi(password: string = TEST_PASSWORD): Promise<{ token: string }> {
  const encrypted = encryptPasswordForTest(password);
  const res = await originalFetch(`${baseUrl()}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted, pubkey: TEST_AGENT_PUBKEY }),
  });
  const data = (await res.json()) as { success: boolean; token: string };
  if (!data.success) throw new Error('Failed to unlock agent');
  adminToken = data.token;
  return data;
}

export async function saveApiKey(
  token: string,
  service: string,
  name: string,
  key: string,
): Promise<unknown> {
  const res = await originalFetch(`${baseUrl()}/apikeys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ service, name, key }),
  });
  return res.json();
}

export async function validateApiKey(
  token: string,
  service: string,
  key: string,
): Promise<{ valid?: boolean; error?: string; info?: unknown }> {
  const res = await originalFetch(`${baseUrl()}/apikeys/validate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ service, key }),
  });
  return res.json() as Promise<{ valid?: boolean; error?: string; info?: unknown }>;
}

export async function saveAdapter(
  token: string,
  type: string,
  enabled: boolean,
  config: Record<string, unknown>,
): Promise<unknown> {
  const res = await originalFetch(`${baseUrl()}/adapters`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ type, enabled, config }),
  });
  return res.json();
}

export async function testAdapter(
  token: string,
  type: string,
): Promise<{ success?: boolean; error?: string }> {
  const res = await originalFetch(`${baseUrl()}/adapters/test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ type }),
  });
  return res.json() as Promise<{ success?: boolean; error?: string }>;
}

export async function restartAdapters(token: string): Promise<unknown> {
  const res = await originalFetch(`${baseUrl()}/adapters/restart`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  return res.json();
}

// ─── Accessors ──────────────────────────────────────────────────

export function getTestPort(): number {
  return testPort;
}

export function getAdminToken(): string {
  return adminToken;
}

// Re-export commonly needed helpers
export { testPrisma, createToken, TEST_PASSWORD };
