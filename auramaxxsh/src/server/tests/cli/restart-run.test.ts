import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../cli/commands/start', () => ({
  runStartCli: vi.fn(),
}));

vi.mock('../../cli/lib/process', () => ({
  stopServer: vi.fn(),
  cleanupTempFiles: vi.fn(),
}));

vi.mock('../../cli/commands/service', () => ({
  isServiceInstalled: vi.fn(),
  isServiceRunning: vi.fn(),
  stopServiceProcesses: vi.fn(),
  SERVICE_BOOTSTRAP_ENV: 'AURA_SERVICE_BOOTSTRAP',
}));

vi.mock('../../cli/lib/theme', () => ({
  printBanner: vi.fn(),
  printHelp: vi.fn(),
}));

vi.mock('../../lib/error', () => ({
  getErrorMessage: vi.fn((error: unknown) => String(error)),
}));

import { runRestartCli } from '../../cli/commands/restart';
import { runStartCli } from '../../cli/commands/start';
import { stopServer, cleanupTempFiles } from '../../cli/lib/process';
import { isServiceInstalled, isServiceRunning, stopServiceProcesses } from '../../cli/commands/service';
import { printHelp } from '../../cli/lib/theme';

describe('restart CLI run behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runStartCli).mockResolvedValue(0);
    vi.mocked(isServiceInstalled).mockReturnValue(false);
    vi.mocked(isServiceRunning).mockReturnValue(false);
  });

  it('stops active service and delegates to start', async () => {
    vi.mocked(isServiceInstalled).mockReturnValue(true);
    vi.mocked(isServiceRunning).mockReturnValue(true);

    await expect(runRestartCli(['--dev'])).resolves.toBe(0);

    expect(stopServiceProcesses).toHaveBeenCalledTimes(1);
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(cleanupTempFiles).toHaveBeenCalledTimes(1);
    expect(runStartCli).toHaveBeenCalledWith(['--dev']);
  });

  it('skips service unload when service is not running', async () => {
    vi.mocked(isServiceInstalled).mockReturnValue(true);
    vi.mocked(isServiceRunning).mockReturnValue(false);

    await expect(runRestartCli([])).resolves.toBe(0);

    expect(stopServiceProcesses).not.toHaveBeenCalled();
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(cleanupTempFiles).toHaveBeenCalledTimes(1);
    expect(runStartCli).toHaveBeenCalledWith([]);
  });

  it('shows help without restarting when --help is provided', async () => {
    await expect(runRestartCli(['--help'])).resolves.toBe(0);

    expect(printHelp).toHaveBeenCalledTimes(1);
    expect(stopServiceProcesses).not.toHaveBeenCalled();
    expect(stopServer).not.toHaveBeenCalled();
    expect(cleanupTempFiles).not.toHaveBeenCalled();
    expect(runStartCli).not.toHaveBeenCalled();
  });
});
