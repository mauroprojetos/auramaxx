import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../cli/lib/http', () => ({
  isServerRunning: vi.fn(),
  waitForServer: vi.fn(),
}));

vi.mock('../../cli/lib/process', () => ({
  startServer: vi.fn(),
  stopServer: vi.fn(),
  acquireStartLock: vi.fn(),
  ensurePrismaClientGenerated: vi.fn(),
  findProjectRoot: vi.fn(() => '/test/root'),
  getRuntimeLogPaths: vi.fn(() => ({
    dir: '/tmp/.logs',
    server: '/tmp/.logs/server.log',
    cron: '/tmp/.logs/cron.log',
    dashboard: '/tmp/.logs/dashboard.log',
  })),
}));

vi.mock('../../lib/error', () => ({
  getErrorMessage: vi.fn((error: unknown) => String(error)),
}));

vi.mock('../../cli/lib/theme', () => ({
  printBanner: vi.fn(),
  printStatus: vi.fn(),
  printHelp: vi.fn(),
}));

vi.mock('../../cli/commands/service', () => ({
  installService: vi.fn(),
  isServiceInstalled: vi.fn(),
  isServiceRunning: vi.fn(),
  loadServiceIfNeeded: vi.fn(),
  stopServiceProcesses: vi.fn(),
  SERVICE_BOOTSTRAP_ENV: 'AURA_SERVICE_BOOTSTRAP',
}));

import { runStartCli } from '../../cli/commands/start';
import { isServerRunning, waitForServer } from '../../cli/lib/http';
import {
  acquireStartLock,
  ensurePrismaClientGenerated,
  startServer,
  stopServer,
} from '../../cli/lib/process';
import {
  installService,
  isServiceInstalled,
  isServiceRunning,
  loadServiceIfNeeded,
  stopServiceProcesses,
} from '../../cli/commands/service';

describe('start CLI run behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isServerRunning).mockResolvedValue(false);
    vi.mocked(waitForServer).mockResolvedValue(undefined);
    vi.mocked(acquireStartLock).mockResolvedValue(() => {});
    vi.mocked(ensurePrismaClientGenerated).mockReturnValue({ ok: true, generated: false, clientPath: '/test/root/node_modules/.prisma/client/default.js' });
    vi.mocked(installService).mockReturnValue({ installed: true });
    vi.mocked(isServiceInstalled).mockReturnValue(true);
    vi.mocked(isServiceRunning).mockReturnValue(false);
    vi.mocked(loadServiceIfNeeded).mockReturnValue(true);
  });

  it('stops active service before forcing dev restart', async () => {
    vi.mocked(isServerRunning).mockResolvedValue(true);
    vi.mocked(isServiceInstalled).mockReturnValue(true);
    vi.mocked(isServiceRunning).mockReturnValue(true);

    await expect(runStartCli(['--dev'])).resolves.toBe(0);

    expect(stopServiceProcesses).toHaveBeenCalledTimes(1);
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ dev: true, startCron: false }));
    expect(loadServiceIfNeeded).not.toHaveBeenCalled();
  });

  it('delegates default start to installed background service', async () => {
    vi.mocked(isServiceInstalled).mockReturnValue(true);
    vi.mocked(isServiceRunning).mockReturnValue(false);

    await expect(runStartCli([])).resolves.toBe(0);

    expect(acquireStartLock).not.toHaveBeenCalled();
    expect(loadServiceIfNeeded).toHaveBeenCalledTimes(1);
    expect(installService).not.toHaveBeenCalled();
    expect(waitForServer).toHaveBeenCalledWith(15000);
    expect(startServer).not.toHaveBeenCalled();
    expect(stopServiceProcesses).not.toHaveBeenCalled();
    expect(stopServer).not.toHaveBeenCalled();
  });

  it('auto-installs service for default start before launching it', async () => {
    vi.mocked(isServiceInstalled).mockReturnValue(false);
    vi.mocked(installService).mockReturnValue({ installed: true });

    await expect(runStartCli([])).resolves.toBe(0);

    expect(acquireStartLock).not.toHaveBeenCalled();
    expect(installService).toHaveBeenCalledWith({ activate: false });
    expect(loadServiceIfNeeded).toHaveBeenCalledTimes(1);
    expect(waitForServer).toHaveBeenCalledWith(15000);
    expect(startServer).not.toHaveBeenCalled();
  });

  it('falls back to manual start when service install fails', async () => {
    vi.mocked(isServiceInstalled).mockReturnValue(false);
    vi.mocked(installService).mockReturnValue({ installed: false, error: 'permission denied' });

    await expect(runStartCli([])).resolves.toBe(0);

    expect(acquireStartLock).toHaveBeenCalledTimes(1);
    expect(installService).toHaveBeenCalledWith({ activate: false });
    expect(loadServiceIfNeeded).not.toHaveBeenCalled();
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ background: true, dev: false, startCron: false }));
  });

  it('does not manual-fallback when pre-installed service fails to launch', async () => {
    vi.mocked(isServiceInstalled).mockReturnValue(true);
    vi.mocked(isServiceRunning).mockReturnValue(false);
    vi.mocked(loadServiceIfNeeded).mockReturnValue(false);

    await expect(runStartCli([])).resolves.toBe(1);

    expect(acquireStartLock).not.toHaveBeenCalled();
    expect(loadServiceIfNeeded).toHaveBeenCalledTimes(1);
    expect(startServer).not.toHaveBeenCalled();
  });

  it('service-first path does not depend on start lock availability', async () => {
    vi.mocked(isServiceInstalled).mockReturnValue(true);
    vi.mocked(isServiceRunning).mockReturnValue(false);
    vi.mocked(acquireStartLock).mockResolvedValue(null);

    await expect(runStartCli([])).resolves.toBe(0);

    expect(acquireStartLock).not.toHaveBeenCalled();
    expect(loadServiceIfNeeded).toHaveBeenCalledTimes(1);
    expect(startServer).not.toHaveBeenCalled();
  });

  it('manual start path still enforces start lock', async () => {
    vi.mocked(isServerRunning).mockResolvedValue(false);
    vi.mocked(acquireStartLock).mockResolvedValue(null);

    await expect(runStartCli(['--debug'])).resolves.toBe(1);

    expect(acquireStartLock).toHaveBeenCalledTimes(1);
    expect(startServer).not.toHaveBeenCalled();
  });

  it('returns early when already running without dev flag', async () => {
    vi.mocked(isServerRunning).mockResolvedValue(true);
    vi.mocked(isServiceInstalled).mockReturnValue(true);
    vi.mocked(isServiceRunning).mockReturnValue(true);

    await expect(runStartCli([])).resolves.toBe(0);

    expect(acquireStartLock).not.toHaveBeenCalled();
    expect(stopServer).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
    expect(loadServiceIfNeeded).not.toHaveBeenCalled();
    expect(stopServiceProcesses).not.toHaveBeenCalled();
    expect(ensurePrismaClientGenerated).not.toHaveBeenCalled();
  });

  it('fails early with actionable guidance when prisma bootstrap cannot be repaired', async () => {
    vi.mocked(ensurePrismaClientGenerated).mockReturnValue({
      ok: false,
      generated: false,
      clientPath: '/test/root/node_modules/.prisma/client/default.js',
      error: 'spawn failed',
    });

    await expect(runStartCli([])).resolves.toBe(1);

    expect(loadServiceIfNeeded).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
  });
});
