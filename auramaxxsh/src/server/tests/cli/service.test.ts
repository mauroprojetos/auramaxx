import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;
const ORIGINAL_APPDATA = process.env.APPDATA;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('service command (windows)', () => {
  let mockedExecSync: ReturnType<typeof vi.fn>;
  let mockedSpawn: ReturnType<typeof vi.fn>;
  let mockedExistsSync: ReturnType<typeof vi.fn>;
  let mockedMkdirSync: ReturnType<typeof vi.fn>;
  let mockedWriteFileSync: ReturnType<typeof vi.fn>;
  let mockedUnlinkSync: ReturnType<typeof vi.fn>;

  async function loadServiceModule() {
    vi.resetModules();

    mockedExecSync = vi.fn();
    mockedSpawn = vi.fn(() => ({ unref: vi.fn() }));
    mockedExistsSync = vi.fn();
    mockedMkdirSync = vi.fn();
    mockedWriteFileSync = vi.fn();
    mockedUnlinkSync = vi.fn();

    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const realOs = await vi.importActual<typeof import('os')>('os');

    vi.doMock('child_process', () => ({
      execSync: mockedExecSync,
      spawn: mockedSpawn,
    }));

    vi.doMock('fs', () => ({
      ...realFs,
      existsSync: mockedExistsSync,
      mkdirSync: mockedMkdirSync,
      writeFileSync: mockedWriteFileSync,
      unlinkSync: mockedUnlinkSync,
    }));

    vi.doMock('os', () => ({
      ...realOs,
      homedir: vi.fn(() => 'C:/Users/alice'),
    }));

    vi.doMock('../../cli/lib/process', () => ({
      findProjectRoot: vi.fn(() => 'C:/repo/auramaxx'),
    }));

    return import('../../cli/commands/service');
  }

  beforeEach(() => {
    setPlatform('win32');
    process.env.APPDATA = 'C:/Users/alice/AppData/Roaming';
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM);
    if (ORIGINAL_APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = ORIGINAL_APPDATA;
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('installs startup script and bootstraps immediate start when activated', async () => {
    const service = await loadServiceModule();

    const result = service.installService({ activate: true });

    expect(result).toEqual({ installed: true });
    expect(mockedMkdirSync).toHaveBeenCalled();
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
    expect(String(mockedWriteFileSync.mock.calls[0]?.[0])).toContain('auramaxx-startup.cmd');
    expect(String(mockedWriteFileSync.mock.calls[0]?.[1])).toContain('start --background');

    expect(mockedSpawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringContaining('bin/auramaxx.js'), 'start', '--background'],
      expect.objectContaining({
        detached: true,
        windowsHide: true,
        env: expect.objectContaining({ AURA_SERVICE_BOOTSTRAP: '1' }),
      }),
    );
    expect(mockedSpawn.mock.results[0]?.value?.unref).toHaveBeenCalled();
  });

  it('reports startup-script installation state on windows', async () => {
    const service = await loadServiceModule();
    mockedExistsSync.mockReturnValue(true);

    expect(service.isServiceInstalled()).toBe(true);
    expect(mockedExistsSync).toHaveBeenCalledWith(expect.stringContaining('auramaxx-startup.cmd'));
  });

  it('detects running state from netstat listening port', async () => {
    const service = await loadServiceModule();

    mockedExecSync.mockReturnValue('  TCP    127.0.0.1:4242      0.0.0.0:0      LISTENING       1234\n');
    expect(service.isServiceRunning()).toBe(true);

    mockedExecSync.mockReturnValue('  TCP    127.0.0.1:4747      0.0.0.0:0      LISTENING       6789\n');
    expect(service.isServiceRunning()).toBe(false);
  });

  it('loadServiceIfNeeded starts background process when installed but not running', async () => {
    const service = await loadServiceModule();
    mockedExistsSync.mockReturnValue(true);
    mockedExecSync.mockReturnValue(''); // no LISTENING on 4242

    expect(service.loadServiceIfNeeded()).toBe(true);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);

    mockedSpawn.mockClear();
    mockedExecSync.mockReturnValue('  TCP    127.0.0.1:4242      0.0.0.0:0      LISTENING       1234\n');
    expect(service.loadServiceIfNeeded()).toBe(false);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('uninstall removes startup script when present', async () => {
    const service = await loadServiceModule();
    mockedExistsSync.mockReturnValue(true);

    service.uninstallService();

    expect(mockedUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('auramaxx-startup.cmd'));
  });
});
