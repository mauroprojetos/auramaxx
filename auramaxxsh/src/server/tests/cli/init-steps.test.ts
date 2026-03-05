/**
 * Unit tests for server/cli/lib/init-steps.ts
 *
 * Tests ensureDirectories(), runMigrations(), generatePrismaClient(), hasAgent().
 * All filesystem and child_process operations are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock fs — provide a base implementation that findProjectRoot (from process.ts) needs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Mock the process module's findProjectRoot so ensureDirectories doesn't walk the real fs
vi.mock('../../cli/lib/process', () => ({
  findProjectRoot: vi.fn(() => '/mock/project/root'),
}));

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureDirectories, runMigrations, generatePrismaClient, hasAgent } from '../../cli/lib/init-steps';

// Must mirror getDataDir() in init-steps.ts: WALLET_DATA_DIR env var takes precedence
const DATA_DIR = process.env.WALLET_DATA_DIR || path.join(os.homedir(), '.auramaxx');

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── ensureDirectories ────────────────────────────────────────────

describe('ensureDirectories()', () => {
  it('should create ~/.auramaxx and subdirectories when they do not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    ensureDirectories();

    // Should check + create data dirs
    expect(fs.mkdirSync).toHaveBeenCalledWith(DATA_DIR, { recursive: true });
    expect(fs.mkdirSync).toHaveBeenCalledWith(path.join(DATA_DIR, 'hot'), { recursive: true });
    expect(fs.mkdirSync).toHaveBeenCalledWith(path.join(DATA_DIR, 'pending'), { recursive: true });

    // Backups are now written to the database directory; no project-root tmp/backups directories
    expect(fs.mkdirSync).toHaveBeenCalledTimes(3);
  });

  it('should skip directories that already exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    ensureDirectories();

    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it('should only create missing directories', () => {
    // DATA_DIR exists, hot is missing, pending exists
    vi.mocked(fs.existsSync)
      .mockReturnValueOnce(true)   // DATA_DIR exists
      .mockReturnValueOnce(false)  // hot/ missing
      .mockReturnValueOnce(true);  // pending/ exists

    ensureDirectories();

    expect(fs.mkdirSync).toHaveBeenCalledTimes(1);
    expect(fs.mkdirSync).toHaveBeenCalledWith(path.join(DATA_DIR, 'hot'), { recursive: true });
  });
});

// ─── runMigrations ────────────────────────────────────────────────

describe('runMigrations()', () => {
  // Must mirror runMigrations(): DATABASE_URL env var takes precedence over constructed path
  const dbUrl = process.env.DATABASE_URL || `file:${DATA_DIR}/auramaxx.db`;

  it('should call prisma migrate deploy first', () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    runMigrations('/test/root');

    expect(execSync).toHaveBeenCalledTimes(1);
    expect(execSync).toHaveBeenCalledWith('npx prisma migrate deploy', {
      cwd: '/test/root',
      env: expect.objectContaining({ DATABASE_URL: dbUrl }),
      stdio: 'pipe',
    });
  });

  it('should fall back to prisma migrate dev on deploy failure', () => {
    vi.mocked(execSync)
      .mockImplementationOnce(() => { throw new Error('deploy failed'); })
      .mockReturnValueOnce(Buffer.from(''));

    runMigrations('/test/root');

    expect(execSync).toHaveBeenCalledTimes(2);
    expect(execSync).toHaveBeenNthCalledWith(1, 'npx prisma migrate deploy', expect.any(Object));
    expect(execSync).toHaveBeenNthCalledWith(2, 'npx prisma migrate dev --name init', {
      cwd: '/test/root',
      env: expect.objectContaining({ DATABASE_URL: dbUrl }),
      stdio: 'pipe',
    });
  });

  it('should throw when both deploy and dev fail', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('migration failed'); });

    expect(() => runMigrations('/test/root')).toThrow('migration failed');
    expect(execSync).toHaveBeenCalledTimes(2);
  });

  it('should use findProjectRoot when no root argument given', () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    runMigrations();

    // Falls back to findProjectRoot() which returns '/mock/project/root'
    expect(execSync).toHaveBeenCalledWith('npx prisma migrate deploy', expect.objectContaining({
      cwd: '/mock/project/root',
    }));
  });
});

// ─── generatePrismaClient ────────────────────────────────────────

describe('generatePrismaClient()', () => {
  it('should call prisma generate with correct cwd', () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    generatePrismaClient('/test/root');

    expect(execSync).toHaveBeenCalledWith('npx prisma generate', {
      cwd: '/test/root',
      stdio: 'pipe',
    });
  });

  it('should use findProjectRoot when no root argument given', () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));

    generatePrismaClient();

    expect(execSync).toHaveBeenCalledWith('npx prisma generate', {
      cwd: '/mock/project/root',
      stdio: 'pipe',
    });
  });

  it('should propagate errors from prisma generate', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('generate failed'); });

    expect(() => generatePrismaClient('/test/root')).toThrow('generate failed');
  });
});

// ─── hasAgent ─────────────────────────────────────────────────────

describe('hasAgent()', () => {
  it('should return true when agent-primary.json exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    expect(hasAgent()).toBe(true);
    expect(fs.existsSync).toHaveBeenCalledWith(path.join(DATA_DIR, 'agent-primary.json'));
  });

  it('should return false when agent-primary.json does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(hasAgent()).toBe(false);
    expect(fs.existsSync).toHaveBeenCalledWith(path.join(DATA_DIR, 'agent-primary.json'));
  });
});
