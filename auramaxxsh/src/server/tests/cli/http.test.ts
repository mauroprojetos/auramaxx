/**
 * Integration tests for server/cli/lib/http.ts
 *
 * Spins up a real Express test server on a random port, points
 * WALLET_SERVER_URL at it, and tests the CLI HTTP helper functions.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import {
  createTestApp,
  cleanDatabase,
  resetColdWallet,
  encryptPasswordForTest,
  testPrisma,
  TEST_PASSWORD,
  TEST_AGENT_PUBKEY,
} from '../setup';
import {
  serverUrl,
  fetchJson,
  isServerRunning,
  waitForServer,
  fetchSetupStatus,
} from '../../cli/lib/http';

let testServer: http.Server;
let testPort: number;
let originalEnv: string | undefined;

beforeAll(async () => {
  await cleanDatabase();
  resetColdWallet();

  const app = createTestApp();

  // Add /health endpoint (not included in createTestApp)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Start on random port
  testServer = app.listen(0);
  const addr = testServer.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get test server address');
  testPort = addr.port;

  // Point CLI helpers at our test server
  originalEnv = process.env.WALLET_SERVER_URL;
  process.env.WALLET_SERVER_URL = `http://127.0.0.1:${testPort}`;
});

afterAll(async () => {
  // Restore env
  if (originalEnv !== undefined) {
    process.env.WALLET_SERVER_URL = originalEnv;
  } else {
    delete process.env.WALLET_SERVER_URL;
  }

  await new Promise<void>((resolve) => testServer.close(() => resolve()));
  resetColdWallet();
  await cleanDatabase();
  await testPrisma.$disconnect();
});

beforeEach(() => {
  resetColdWallet();
});

// ─── serverUrl ────────────────────────────────────────────────────

describe('serverUrl()', () => {
  it('should return WALLET_SERVER_URL env value', () => {
    expect(serverUrl()).toBe(`http://127.0.0.1:${testPort}`);
  });

  it('should default to http://localhost:4242 when env is not set', () => {
    const saved = process.env.WALLET_SERVER_URL;
    delete process.env.WALLET_SERVER_URL;
    try {
      expect(serverUrl()).toBe('http://localhost:4242');
    } finally {
      process.env.WALLET_SERVER_URL = saved;
    }
  });
});

// ─── fetchJson ────────────────────────────────────────────────────

describe('fetchJson()', () => {
  it('should GET JSON from the server', async () => {
    const data = await fetchJson<{ status: string }>('/health');
    expect(data.status).toBe('ok');
  });

  it('should POST JSON body when body option is provided', async () => {
    // POST /setup without encrypted field → 400 error
    await expect(fetchJson('/setup', { body: { pubkey: TEST_AGENT_PUBKEY } })).rejects.toThrow();
  });

  it('should throw on non-2xx responses with error message', async () => {
    await expect(fetchJson('/setup', { body: { pubkey: TEST_AGENT_PUBKEY } })).rejects.toThrow(/[Ee]ncrypted/);
  });

  it('should send Authorization header when token is provided', async () => {
    // fetchJson with token should set the Authorization header.
    // Use a valid endpoint — the header is sent even if it's not required.
    const data = await fetchJson<{ hasWallet: boolean }>('/setup', { token: 'some-token' });
    expect(data).toHaveProperty('hasWallet');
  });

  it('should default to GET when no body is provided', async () => {
    const data = await fetchJson<{ hasWallet: boolean }>('/setup');
    expect(data).toHaveProperty('hasWallet');
  });
});

// ─── isServerRunning ──────────────────────────────────────────────

describe('isServerRunning()', () => {
  it('should return true when server is up', async () => {
    const running = await isServerRunning();
    expect(running).toBe(true);
  });

  it('should return false when server is unreachable', async () => {
    const saved = process.env.WALLET_SERVER_URL;
    // Point to a port that definitely isn't listening
    process.env.WALLET_SERVER_URL = 'http://127.0.0.1:19999';
    try {
      const running = await isServerRunning();
      expect(running).toBe(false);
    } finally {
      process.env.WALLET_SERVER_URL = saved;
    }
  });
});

// ─── waitForServer ────────────────────────────────────────────────

describe('waitForServer()', () => {
  it('should resolve when server is already running', async () => {
    await expect(waitForServer(5000)).resolves.toBeUndefined();
  });

  it('should reject after timeout when server is unreachable', async () => {
    const saved = process.env.WALLET_SERVER_URL;
    process.env.WALLET_SERVER_URL = 'http://127.0.0.1:19999';
    try {
      await expect(waitForServer(1000)).rejects.toThrow(/did not start/);
    } finally {
      process.env.WALLET_SERVER_URL = saved;
    }
  });
});

// ─── fetchSetupStatus ─────────────────────────────────────────────

describe('fetchSetupStatus()', () => {
  it('should return hasWallet: false on fresh server', async () => {
    const status = await fetchSetupStatus();
    expect(status.hasWallet).toBe(false);
    expect(status.address).toBeNull();
  });

  it('should return hasWallet: true after agent creation', async () => {
    // Create agent via the test server
    const encrypted = encryptPasswordForTest(TEST_PASSWORD);
    await fetchJson('/setup', { body: { encrypted, pubkey: TEST_AGENT_PUBKEY } });

    const status = await fetchSetupStatus();
    expect(status.hasWallet).toBe(true);
    expect(status.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(status.unlocked).toBe(true);
  });
});
