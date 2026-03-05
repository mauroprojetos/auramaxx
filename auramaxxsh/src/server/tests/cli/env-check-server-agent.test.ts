import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('checkServerAndAgent()', () => {
  let checkServerAndAgent: () => Promise<void>;
  let cmdRun: (cmdArgs: string[]) => Promise<void>;
  let cmdInject: () => Promise<void>;
  let cmdCheck: () => Promise<void>;
  let mockFetchSetupStatus: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockFetchSetupStatus = vi.fn();

    vi.doMock('../../cli/lib/http', () => ({
      fetchSetupStatus: mockFetchSetupStatus,
      serverUrl: vi.fn(() => 'http://localhost:4242'),
    }));

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const mod = await import('../../cli/commands/env');
    checkServerAndAgent = mod.checkServerAndAgent;
    cmdRun = mod.cmdRun;
    cmdInject = mod.cmdInject;
    cmdCheck = mod.cmdCheck;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints a agent-specific message when no agent exists', async () => {
    mockFetchSetupStatus.mockResolvedValue({ hasWallet: false, unlocked: false, address: null });

    await checkServerAndAgent();

    expect(consoleErrorSpy).toHaveBeenCalledWith('No agent found. Run `npx auramaxx` to bootstrap setup.');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints a server-not-running message on connection failures', async () => {
    mockFetchSetupStatus.mockRejectedValue(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:4242'));

    await checkServerAndAgent();

    expect(consoleErrorSpy).toHaveBeenCalledWith('Aura server not running. Run `npx auramaxx` first.');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('allows command execution when agent exists', async () => {
    mockFetchSetupStatus.mockResolvedValue({ hasWallet: true, unlocked: true, address: '0xabc', adapters: { telegram: false, webhook: false }, apiKeys: { alchemy: false, anthropic: false } });

    await expect(checkServerAndAgent()).resolves.toBeUndefined();

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('fails fast for `env check` when no agent exists', async () => {
    mockFetchSetupStatus.mockResolvedValue({ hasWallet: false, unlocked: false, address: null });

    const mod = await import('../../cli/commands/env');
    const parseAuraFileSpy = vi.spyOn(mod, 'parseAuraFile');

    exitSpy.mockImplementation(() => {
      throw new Error('process.exit');
    });

    await expect(cmdCheck()).rejects.toThrow('process.exit');

    expect(parseAuraFileSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('No agent found. Run `npx auramaxx` to bootstrap setup.');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('fails fast for `env inject` when no agent exists', async () => {
    mockFetchSetupStatus.mockResolvedValue({ hasWallet: false, unlocked: false, address: null });

    const mod = await import('../../cli/commands/env');
    const parseAuraFileSpy = vi.spyOn(mod, 'parseAuraFile');

    exitSpy.mockImplementation(() => {
      throw new Error('process.exit');
    });

    await expect(cmdInject()).rejects.toThrow('process.exit');

    expect(parseAuraFileSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('No agent found. Run `npx auramaxx` to bootstrap setup.');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('fails fast for `env -- <cmd>` when no agent exists', async () => {
    mockFetchSetupStatus.mockResolvedValue({ hasWallet: false, unlocked: false, address: null });

    const mod = await import('../../cli/commands/env');
    const parseAuraFileSpy = vi.spyOn(mod, 'parseAuraFile');

    exitSpy.mockImplementation(() => {
      throw new Error('process.exit');
    });

    await expect(cmdRun(['npm', 'run', 'dev'])).rejects.toThrow('process.exit');

    expect(parseAuraFileSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('No agent found. Run `npx auramaxx` to bootstrap setup.');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
