/**
 * Unit tests for server/cli/lib/process.ts
 *
 * Tests findProjectRoot(), stopServer(), startServer(), cleanupTempFiles().
 * child_process is mocked for stopServer/startServer/cleanupTempFiles.
 * findProjectRoot uses the real filesystem (it should find the actual project root).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

// ─── findProjectRoot (real filesystem) ───────────────────────────

describe('findProjectRoot()', () => {
  it('should find the auramaxx project root', async () => {
    // Import fresh — no mocks for this test
    const { findProjectRoot } = await import('../../cli/lib/process');
    const root = findProjectRoot();

    expect(root).toBeDefined();
    expect(typeof root).toBe('string');

    // Verify by checking package.json exists at the found root
    const fs = await import('fs');
    const path = await import('path');
    const pkgPath = path.join(root, 'package.json');
    expect(fs.existsSync(pkgPath)).toBe(true);

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    expect(pkg.name).toBe('auramaxx');
  });
});

// ─── Mocked tests (stopServer, startServer, cleanupTempFiles) ───

// We need a separate describe with mocks for the process management functions.
// Use vi.hoisted + dynamic import to avoid polluting the findProjectRoot test.

describe('process management (mocked)', () => {
  let mockedExecSync: ReturnType<typeof vi.fn>;
  let mockedSpawn: ReturnType<typeof vi.fn>;
  let mockedExistsSync: ReturnType<typeof vi.fn>;
  let mockedUnlinkSync: ReturnType<typeof vi.fn>;
  let mockedMkdirSync: ReturnType<typeof vi.fn>;
  let mockedOpenSync: ReturnType<typeof vi.fn>;
  let mockedCloseSync: ReturnType<typeof vi.fn>;

  // We'll dynamically import the module with mocks applied
  let stopServer: typeof import('../../cli/lib/process').stopServer;
  let startServer: typeof import('../../cli/lib/process').startServer;
  let cleanupTempFiles: typeof import('../../cli/lib/process').cleanupTempFiles;

  beforeEach(async () => {
    setPlatform('darwin');
    vi.resetModules();

    mockedExecSync = vi.fn();
    mockedSpawn = vi.fn();
    mockedExistsSync = vi.fn();
    mockedUnlinkSync = vi.fn();
    mockedMkdirSync = vi.fn();
    mockedOpenSync = vi.fn();
    mockedCloseSync = vi.fn();

    // Mock child_process
    vi.doMock('child_process', () => ({
      execSync: mockedExecSync,
      spawn: mockedSpawn,
    }));

    // Mock fs — keep readFileSync real for findProjectRoot, but mock existsSync/unlinkSync
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    vi.doMock('fs', () => ({
      ...realFs,
      existsSync: mockedExistsSync,
      unlinkSync: mockedUnlinkSync,
      mkdirSync: mockedMkdirSync,
      openSync: mockedOpenSync,
      closeSync: mockedCloseSync,
      // findProjectRoot needs readFileSync to work
      readFileSync: realFs.readFileSync,
    }));

    const mod = await import('../../cli/lib/process');
    stopServer = mod.stopServer;
    startServer = mod.startServer;
    cleanupTempFiles = mod.cleanupTempFiles;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM);
  });

  // ─── stopServer ─────────────────────────────────────────────

  describe('stopServer()', () => {
    it('should call pkill for each known server pattern', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''));

      stopServer();

      // 5 pkill calls + 6 port-based kill calls (3 ports x 2 passes) + 1 sleep call
      expect(mockedExecSync).toHaveBeenCalledTimes(12);

      const patterns = [
        'tsx src/server/index.ts',
        'tsx watch src/server/index.ts',
        'tsx src/server/cron/index.ts',
        'next dev -p',
        'next start -p',
      ];

      for (const pattern of patterns) {
        expect(mockedExecSync).toHaveBeenCalledWith(
          `pkill -f "${pattern}" 2>/dev/null`,
          { stdio: 'ignore' },
        );
      }

      // Port-based kills for wallet/dashboard/ws.
      // Fallback dashboard+1 is 4748 by default and dedupes with WS_PORT.
      const ports = ['4242', '4747', '4748'];
      for (const port of ports) {
        expect(mockedExecSync).toHaveBeenCalledWith(
          `lsof -ti TCP:${port} -s TCP:LISTEN | xargs kill 2>/dev/null`,
          { stdio: 'ignore' },
        );
        expect(mockedExecSync).toHaveBeenCalledWith(
          `lsof -ti TCP:${port} -s TCP:LISTEN | xargs kill -9 2>/dev/null`,
          { stdio: 'ignore' },
        );
      }
    });

    it('should ignore errors from pkill (process not found)', () => {
      mockedExecSync.mockImplementation(() => { throw new Error('No matching processes'); });

      // Should not throw
      expect(() => stopServer()).not.toThrow();
    });

    it('should stop listeners on windows for wallet/dashboard/ws ports', () => {
      setPlatform('win32');
      mockedExecSync.mockImplementation((command: unknown) => {
        const cmd = String(command);
        if (cmd === 'netstat -ano -p tcp') {
          return [
            '  TCP    127.0.0.1:4242      0.0.0.0:0      LISTENING       1111',
            '  TCP    127.0.0.1:4747      0.0.0.0:0      LISTENING       2222',
            '  TCP    127.0.0.1:4748      0.0.0.0:0      LISTENING       3333',
          ].join('\n');
        }
        return '';
      });

      stopServer();

      expect(mockedExecSync).toHaveBeenCalledWith('taskkill /PID 1111 /T /F', { stdio: 'ignore' });
      expect(mockedExecSync).toHaveBeenCalledWith('taskkill /PID 2222 /T /F', { stdio: 'ignore' });
      expect(mockedExecSync).toHaveBeenCalledWith('taskkill /PID 3333 /T /F', { stdio: 'ignore' });
    });
  });

  // ─── startServer ────────────────────────────────────────────

  describe('startServer()', () => {
    const mockProcess = { unref: vi.fn(), on: vi.fn(), pid: 12345 };

    beforeEach(() => {
      mockedSpawn.mockReturnValue({ ...mockProcess, unref: vi.fn() });
      // findProjectRoot needs to find package.json — use real existsSync for it
      mockedExistsSync.mockReturnValue(true);
    });

    it('should spawn Express + cron + Next.js by default (headless: false)', () => {
      const children = startServer({ headless: false });

      expect(children).toHaveLength(3);
      expect(mockedSpawn).toHaveBeenCalledTimes(3);

      // Express server (detached defaults to false when background is not set)
      expect(mockedSpawn).toHaveBeenCalledWith(
        'npx', ['tsx', 'src/server/index.ts'],
        expect.objectContaining({
          stdio: 'ignore',
          detached: false,
          env: expect.objectContaining({ BYPASS_RATE_LIMIT: 'true' }),
        }),
      );

      // Cron server
      expect(mockedSpawn).toHaveBeenCalledWith(
        'npx', ['tsx', 'src/server/cron/index.ts'],
        expect.objectContaining({
          stdio: 'ignore',
          detached: false,
        }),
      );

      // Next.js dashboard (mockedExistsSync returns true, so .next is "found" → next start)
      expect(mockedSpawn).toHaveBeenCalledWith(
        'npx', ['next', 'start', '-p', '4747'],
        expect.objectContaining({
          stdio: 'ignore',
          detached: false,
        }),
      );
    });

    it('should attempt build then fall back to next dev when BUILD_ID is still missing', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const buildIdSuffix = `${path.sep}.next${path.sep}BUILD_ID`;
      mockedExistsSync.mockImplementation((targetPath: unknown) => !String(targetPath).endsWith(buildIdSuffix));

      startServer({ headless: false });

      expect(mockedExecSync).toHaveBeenCalledWith(
        'npm run build',
        expect.objectContaining({
          cwd: expect.any(String),
          stdio: 'ignore',
        }),
      );
      expect(mockedSpawn).toHaveBeenCalledWith(
        'npx', ['next', 'dev', '-p', '4747'],
        expect.objectContaining({
          stdio: 'ignore',
          detached: false,
        }),
      );
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Missing production dashboard build'));
      warnSpy.mockRestore();
    });

    it('should rebuild and use next start when BUILD_ID is recovered', () => {
      let buildRecovered = false;
      const buildIdSuffix = `${path.sep}.next${path.sep}BUILD_ID`;
      mockedExecSync.mockImplementation((command: unknown) => {
        if (String(command) === 'npm run build') {
          buildRecovered = true;
        }
        return Buffer.from('');
      });
      mockedExistsSync.mockImplementation((targetPath: unknown) => {
        const normalized = String(targetPath);
        if (normalized.endsWith(buildIdSuffix)) return buildRecovered;
        return true;
      });

      startServer({ headless: false });

      expect(mockedExecSync).toHaveBeenCalledWith(
        'npm run build',
        expect.objectContaining({
          cwd: expect.any(String),
          stdio: 'ignore',
        }),
      );
      expect(mockedSpawn).toHaveBeenCalledWith(
        'npx', ['next', 'start', '-p', '4747'],
        expect.objectContaining({
          stdio: 'ignore',
          detached: false,
        }),
      );
    });

    it('should spawn Express + cron when headless: true', () => {
      const children = startServer({ headless: true });

      expect(children).toHaveLength(2);
      expect(mockedSpawn).toHaveBeenCalledTimes(2);

      // Express server
      expect(mockedSpawn).toHaveBeenCalledWith(
        'npx', ['tsx', 'src/server/index.ts'],
        expect.any(Object),
      );

      // Cron server
      expect(mockedSpawn).toHaveBeenCalledWith(
        'npx', ['tsx', 'src/server/cron/index.ts'],
        expect.any(Object),
      );
    });

    it('should skip cron when startCron is false (headless: false)', () => {
      const children = startServer({ headless: false, startCron: false });

      expect(children).toHaveLength(2);
      expect(mockedSpawn).toHaveBeenCalledTimes(2);
      expect(mockedSpawn).toHaveBeenCalledWith(
        'npx', ['tsx', 'src/server/index.ts'],
        expect.any(Object),
      );
      expect(mockedSpawn).toHaveBeenCalledWith(
        'npx', ['next', 'start', '-p', '4747'],
        expect.any(Object),
      );
      expect(mockedSpawn).not.toHaveBeenCalledWith(
        'npx', ['tsx', 'src/server/cron/index.ts'],
        expect.any(Object),
      );
    });

    it('should spawn only Express when headless and startCron is false', () => {
      const children = startServer({ headless: true, startCron: false });

      expect(children).toHaveLength(1);
      expect(mockedSpawn).toHaveBeenCalledTimes(1);
      expect(mockedSpawn).toHaveBeenCalledWith(
        'npx', ['tsx', 'src/server/index.ts'],
        expect.any(Object),
      );
    });

    it('should unref all spawned processes when background is true', () => {
      const unref1 = vi.fn();
      const unref2 = vi.fn();
      const unref3 = vi.fn();
      mockedOpenSync
        .mockReturnValueOnce(201)
        .mockReturnValueOnce(202)
        .mockReturnValueOnce(203);
      mockedSpawn
        .mockReturnValueOnce({ unref: unref1, pid: 1 })
        .mockReturnValueOnce({ unref: unref2, pid: 2 })
        .mockReturnValueOnce({ unref: unref3, pid: 3 });

      startServer({ headless: false, background: true });

      expect(unref1).toHaveBeenCalled();
      expect(unref2).toHaveBeenCalled();
      expect(unref3).toHaveBeenCalled();
    });

    it('should route detached background logs into .logs files', () => {
      mockedOpenSync
        .mockReturnValueOnce(301)
        .mockReturnValueOnce(302)
        .mockReturnValueOnce(303);

      startServer({ headless: false, background: true });

      expect(mockedMkdirSync).toHaveBeenCalledWith(expect.stringContaining(`${path.sep}.logs`), { recursive: true });
      expect(mockedOpenSync).toHaveBeenCalledTimes(3);
      expect(mockedSpawn).toHaveBeenNthCalledWith(
        1,
        'npx',
        ['tsx', 'src/server/index.ts'],
        expect.objectContaining({
          stdio: ['ignore', 301, 301],
          detached: true,
        }),
      );
      expect(mockedSpawn).toHaveBeenNthCalledWith(
        2,
        'npx',
        ['tsx', 'src/server/cron/index.ts'],
        expect.objectContaining({
          stdio: ['ignore', 302, 302],
          detached: true,
        }),
      );
      expect(mockedSpawn).toHaveBeenNthCalledWith(
        3,
        'npx',
        ['next', 'start', '-p', '4747'],
        expect.objectContaining({
          stdio: ['ignore', 303, 303],
          detached: true,
        }),
      );
      expect(mockedCloseSync).toHaveBeenCalledTimes(3);
    });

    it('should not unref processes when background is not set', () => {
      const unref1 = vi.fn();
      const unref2 = vi.fn();
      const unref3 = vi.fn();
      mockedSpawn
        .mockReturnValueOnce({ unref: unref1, pid: 1 })
        .mockReturnValueOnce({ unref: unref2, pid: 2 })
        .mockReturnValueOnce({ unref: unref3, pid: 3 });

      startServer({ headless: false });

      expect(unref1).not.toHaveBeenCalled();
      expect(unref2).not.toHaveBeenCalled();
      expect(unref3).not.toHaveBeenCalled();
    });

    it('should set BYPASS_RATE_LIMIT env var', () => {
      startServer();

      const spawnCall = mockedSpawn.mock.calls[0];
      expect(spawnCall[2].env.BYPASS_RATE_LIMIT).toBe('true');
    });

    it('should stream logs and keep processes attached when debug mode is enabled', () => {
      startServer({ headless: false, debug: true });

      expect(mockedSpawn).toHaveBeenCalledTimes(3);
      for (const call of mockedSpawn.mock.calls) {
        expect(call[2]).toEqual(expect.objectContaining({
          stdio: 'inherit',
          detached: false,
        }));
      }
      expect(mockedOpenSync).not.toHaveBeenCalled();
    });
  });

  // ─── cleanupTempFiles ───────────────────────────────────────

  describe('cleanupTempFiles()', () => {
    it('should remove lock and socket files when they exist', () => {
      mockedExistsSync.mockReturnValue(true);

      cleanupTempFiles();

      expect(mockedUnlinkSync).toHaveBeenCalledTimes(2);
      // Verify the file patterns match
      const calls = mockedUnlinkSync.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls.every((f: string) => f.startsWith('/tmp/aura-cli-'))).toBe(true);
      expect(calls.some((f: string) => f.endsWith('.lock'))).toBe(true);
      expect(calls.some((f: string) => f.endsWith('.sock'))).toBe(true);
    });

    it('should skip files that do not exist', () => {
      mockedExistsSync.mockReturnValue(false);

      cleanupTempFiles();

      expect(mockedUnlinkSync).not.toHaveBeenCalled();
    });

    it('should ignore errors during cleanup', () => {
      mockedExistsSync.mockReturnValue(true);
      mockedUnlinkSync.mockImplementation(() => { throw new Error('EPERM'); });

      expect(() => cleanupTempFiles()).not.toThrow();
    });
  });
});
