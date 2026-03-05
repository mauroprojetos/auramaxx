/**
 * Integration test for the full CLI init flow.
 *
 * Tests the init command sequence by calling individual functions in order,
 * with mocked process management but a real HTTP test server. This avoids
 * the problems of calling main() directly (process.exit, SIGINT handlers,
 * infinite poll loop).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
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

// ─── Mocks ────────────────────────────────────────────────────────

// Mock child_process to prevent real process operations
vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from('')),
  spawn: vi.fn().mockReturnValue({ unref: vi.fn(), on: vi.fn(), pid: 99999 }),
  exec: vi.fn(),
}));

// Mock fs for init-steps (ensureDirectories, hasAgent)
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
  };
});

// Mock findProjectRoot to avoid walking real filesystem
vi.mock('../../cli/lib/process', async () => {
  const actual = await vi.importActual<typeof import('../../cli/lib/process')>('../../cli/lib/process');
  return {
    ...actual,
    findProjectRoot: vi.fn(() => '/mock/project/root'),
    stopServer: vi.fn(),
    startServer: vi.fn(() => [{ unref: vi.fn(), pid: 99999 }]),
  };
});

import { execSync } from 'child_process';
import * as fs from 'fs';
import { ensureDirectories, runMigrations, generatePrismaClient } from '../../cli/lib/init-steps';
import { waitForServer, fetchSetupStatus, fetchJson } from '../../cli/lib/http';

// ─── Test server setup ────────────────────────────────────────────

let testServer: http.Server;
let testPort: number;
let originalEnv: string | undefined;

beforeAll(async () => {
  await cleanDatabase();
  resetColdWallet();

  const app = createTestApp();
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  testServer = app.listen(0);
  const addr = testServer.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get test server address');
  testPort = addr.port;

  originalEnv = process.env.WALLET_SERVER_URL;
  process.env.WALLET_SERVER_URL = `http://127.0.0.1:${testPort}`;
});

afterAll(async () => {
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
  vi.clearAllMocks();
  resetColdWallet();
  // Default: existsSync returns false (dirs don't exist yet)
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

// ─── Happy path: fresh init + agent creation ──────────────────────

describe('Fresh init flow', () => {
  it('should complete the full init sequence and detect agent creation', async () => {
    // Step 1: ensureDirectories (mocked fs)
    ensureDirectories();
    expect(fs.mkdirSync).toHaveBeenCalled();

    // Step 2: runMigrations (mocked execSync)
    runMigrations('/mock/project/root');
    expect(execSync).toHaveBeenCalledWith(
      'npx prisma migrate deploy',
      expect.any(Object),
    );

    // Step 3: generatePrismaClient (mocked execSync)
    generatePrismaClient('/mock/project/root');
    expect(execSync).toHaveBeenCalledWith(
      'npx prisma generate',
      expect.any(Object),
    );

    // Step 4: waitForServer succeeds (test server is already running)
    await expect(waitForServer(5000)).resolves.toBeUndefined();

    // Step 5: fetchSetupStatus shows no wallet
    const statusBefore = await fetchSetupStatus();
    expect(statusBefore.hasWallet).toBe(false);

    // Step 6: Create agent via API (simulates user action in browser)
    const encrypted = encryptPasswordForTest(TEST_PASSWORD);
    const createResult = await fetchJson<{ success: boolean; address: string }>('/setup', {
      body: { encrypted, pubkey: TEST_AGENT_PUBKEY },
    });
    expect(createResult.success).toBe(true);
    expect(createResult.address).toMatch(/^0x[a-fA-F0-9]{40}$/);

    // Step 7: fetchSetupStatus now shows wallet exists
    const statusAfter = await fetchSetupStatus();
    expect(statusAfter.hasWallet).toBe(true);
    expect(statusAfter.address).toBe(createResult.address);
    expect(statusAfter.unlocked).toBe(true);
  });
});

// ─── Already initialized ─────────────────────────────────────────

describe('Already initialized flow', () => {
  it('should detect existing agent and skip poll loop', async () => {
    // Create agent first
    const encrypted = encryptPasswordForTest(TEST_PASSWORD);
    await fetchJson('/setup', { body: { encrypted, pubkey: TEST_AGENT_PUBKEY } });

    // Now fetchSetupStatus shows wallet exists
    const status = await fetchSetupStatus();
    expect(status.hasWallet).toBe(true);
    expect(status.address).toMatch(/^0x[a-fA-F0-9]{40}$/);

    // In the real init flow, this would skip to "Already initialized" message
    // and not enter the poll loop or open browser
  });
});

// ─── Migration failure ────────────────────────────────────────────

describe('Migration failure', () => {
  it('should throw when both deploy and dev fail', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('migration failed');
    });

    expect(() => runMigrations('/mock/project/root')).toThrow('migration failed');

    // Both deploy and dev were attempted
    expect(execSync).toHaveBeenCalledTimes(2);
    expect(execSync).toHaveBeenCalledWith('npx prisma migrate deploy', expect.any(Object));
    expect(execSync).toHaveBeenCalledWith('npx prisma migrate dev --name init', expect.any(Object));
  });
});

// ─── Server start timeout ─────────────────────────────────────────

describe('Server start timeout', () => {
  it('should reject when server is unreachable', async () => {
    const saved = process.env.WALLET_SERVER_URL;
    process.env.WALLET_SERVER_URL = 'http://127.0.0.1:19999';
    try {
      await expect(waitForServer(1000)).rejects.toThrow(/did not start/);
    } finally {
      process.env.WALLET_SERVER_URL = saved;
    }
  });
});

// ─── Poll detects agent creation mid-test ─────────────────────────

describe('Poll detects agent creation', () => {
  it('should detect agent creation between poll cycles', async () => {
    // Start with no agent
    let status = await fetchSetupStatus();
    expect(status.hasWallet).toBe(false);

    // Simulate "agent created mid-poll" — create agent between checks
    const encrypted = encryptPasswordForTest(TEST_PASSWORD);
    await fetchJson('/setup', { body: { encrypted, pubkey: TEST_AGENT_PUBKEY } });

    // Next poll detects the agent
    status = await fetchSetupStatus();
    expect(status.hasWallet).toBe(true);
    expect(status.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});
