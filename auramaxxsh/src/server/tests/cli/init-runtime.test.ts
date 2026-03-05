import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../cli/lib/http', () => ({
  waitForServer: vi.fn(),
  fetchSetupStatus: vi.fn(),
  fetchPublicKey: vi.fn(),
  fetchJson: vi.fn(),
}));

vi.mock('../../cli/lib/process', () => ({
  startServer: vi.fn(() => []),
  stopServer: vi.fn(),
  findProjectRoot: vi.fn(() => '/tmp/auramaxx'),
  startDashboardProcess: vi.fn(),
}));

vi.mock('../../cli/commands/service', () => ({
  installService: vi.fn(),
  isServiceInstalled: vi.fn(),
  isServiceRunning: vi.fn(),
  loadServiceIfNeeded: vi.fn(),
  SERVICE_BOOTSTRAP_ENV: 'AURA_SERVICE_BOOTSTRAP',
}));

import { waitForServer } from '../../cli/lib/http';
import { startServer, stopServer } from '../../cli/lib/process';
import { installService, isServiceInstalled, isServiceRunning, loadServiceIfNeeded } from '../../cli/commands/service';
import { bootstrapInitRuntime, getBrowserOpenInvocation } from '../../cli/commands/init';

describe('init runtime bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(waitForServer).mockResolvedValue(undefined);
    vi.mocked(startServer).mockReturnValue([]);
    vi.mocked(installService).mockReturnValue({ installed: true });
    vi.mocked(isServiceInstalled).mockReturnValue(true);
    vi.mocked(isServiceRunning).mockReturnValue(false);
    vi.mocked(loadServiceIfNeeded).mockReturnValue(true);
  });

  it('uses service-first path by default', async () => {
    await expect(bootstrapInitRuntime({
      debugMode: false,
      devMode: false,
      backgroundAfterSetup: false,
    })).resolves.toBe('service');

    expect(installService).not.toHaveBeenCalled();
    expect(loadServiceIfNeeded).toHaveBeenCalledTimes(1);
    expect(waitForServer).toHaveBeenCalledWith(15000);
    expect(stopServer).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
  });

  it('installs service when missing and then launches service runtime', async () => {
    vi.mocked(isServiceInstalled).mockReturnValue(false);
    vi.mocked(installService).mockReturnValue({ installed: true });

    await expect(bootstrapInitRuntime({
      debugMode: false,
      devMode: false,
      backgroundAfterSetup: false,
    })).resolves.toBe('service');

    expect(installService).toHaveBeenCalledWith({ activate: false });
    expect(loadServiceIfNeeded).toHaveBeenCalledTimes(1);
    expect(startServer).not.toHaveBeenCalled();
  });

  it('falls back to manual runtime when service install fails', async () => {
    vi.mocked(isServiceInstalled).mockReturnValue(false);
    vi.mocked(installService).mockReturnValue({ installed: false, error: 'permission denied' });

    await expect(bootstrapInitRuntime({
      debugMode: false,
      devMode: false,
      backgroundAfterSetup: false,
    })).resolves.toBe('manual');

    expect(installService).toHaveBeenCalledWith({ activate: false });
    expect(loadServiceIfNeeded).not.toHaveBeenCalled();
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      headless: true,
      debug: false,
      background: false,
      startCron: false,
    }));
    expect(waitForServer).toHaveBeenCalledWith(15000);
  });

  it('fails fast when preinstalled service cannot launch', async () => {
    vi.mocked(isServiceInstalled).mockReturnValue(true);
    vi.mocked(isServiceRunning).mockReturnValue(false);
    vi.mocked(loadServiceIfNeeded).mockReturnValue(false);

    await expect(bootstrapInitRuntime({
      debugMode: false,
      devMode: false,
      backgroundAfterSetup: false,
    })).rejects.toThrow(/failed to launch/i);

    expect(startServer).not.toHaveBeenCalled();
  });

  it('uses manual runtime in debug mode', async () => {
    await expect(bootstrapInitRuntime({
      debugMode: true,
      devMode: false,
      backgroundAfterSetup: false,
    })).resolves.toBe('manual');

    expect(installService).not.toHaveBeenCalled();
    expect(loadServiceIfNeeded).not.toHaveBeenCalled();
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      headless: true,
      debug: true,
      background: false,
      startCron: false,
    }));
  });
});

describe('init browser invocation', () => {
  it('builds a windows-safe command invocation', () => {
    expect(getBrowserOpenInvocation('http://localhost:4747', 'win32')).toEqual({
      kind: 'spawn',
      command: 'cmd',
      args: ['/d', '/s', '/c', 'start', '', 'http://localhost:4747'],
    });
  });

  it('keeps mac/linux invocation behavior', () => {
    expect(getBrowserOpenInvocation('http://localhost:4747', 'darwin')).toEqual({
      kind: 'exec',
      command: 'open "http://localhost:4747"',
    });
    expect(getBrowserOpenInvocation('http://localhost:4747', 'linux')).toEqual({
      kind: 'exec',
      command: 'xdg-open "http://localhost:4747"',
    });
  });
});
