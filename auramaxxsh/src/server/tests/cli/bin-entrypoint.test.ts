import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../../../..');
const binPath = path.join('bin', 'auramaxx.js');

function shimPath(binDir: string, command: 'aura' | 'auramaxx'): string {
  return path.join(binDir, process.platform === 'win32' ? `${command}.cmd` : command);
}

describe('bin entrypoint', () => {
  it('prints update notice when newer version is detected', () => {
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-update-check-'));
    try {
      const result = spawnSync(process.execPath, [binPath, 'get'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          WALLET_DATA_DIR: tempData,
          AURA_UPDATE_CHECK_MOCK_LATEST: 'v9.9.9',
          AURA_UPDATE_CHECK_FORCE: '1',
          AURA_AUTO_ALIAS_INSTALL: '0',
          AURA_FORCE_NODE_TSX: '1',
          AURA_TOKEN: 'test-token',
          WALLET_SERVER_URL: 'http://127.0.0.1:9',
        },
        encoding: 'utf8',
      });
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).toContain('Update available');
    } finally {
      fs.rmSync(tempData, { recursive: true, force: true });
    }
  });

  it('routes top-level get alias to agent command', () => {
    const result = spawnSync(process.execPath, [binPath, 'get'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AURA_AUTO_ALIAS_INSTALL: '0',
        AURA_FORCE_NODE_TSX: '1',
        AURA_TOKEN: 'test-token',
        WALLET_SERVER_URL: 'http://127.0.0.1:9',
      },
      encoding: 'utf8',
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(1);
    expect(combinedOutput).toContain('Usage: npx auramaxx agent get <name>');
    expect(combinedOutput).not.toContain('Unknown command: get');
  });

  it('routes top-level secret alias to agent command', () => {
    const result = spawnSync(process.execPath, [binPath, 'secret'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AURA_AUTO_ALIAS_INSTALL: '0',
        AURA_FORCE_NODE_TSX: '1',
        AURA_TOKEN: 'test-token',
        WALLET_SERVER_URL: 'http://127.0.0.1:9',
      },
      encoding: 'utf8',
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(1);
    expect(combinedOutput).toContain('Usage: npx auramaxx secret exec <name> [--env ENV_VAR] [-- <command>]');
    expect(combinedOutput).not.toContain('Unknown command: secret');
  });

  it('routes top-level inject alias to agent command', () => {
    const result = spawnSync(process.execPath, [binPath, 'inject'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AURA_AUTO_ALIAS_INSTALL: '0',
        AURA_FORCE_NODE_TSX: '1',
        AURA_TOKEN: 'test-token',
        WALLET_SERVER_URL: 'http://127.0.0.1:9',
      },
      encoding: 'utf8',
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(1);
    expect(combinedOutput).toContain('Usage: npx auramaxx inject <name> [--env ENV_VAR] [-- <command>]');
    expect(combinedOutput).not.toContain('Unknown command: inject');
  });

  it('routes top-level use alias to inject compatibility path', () => {
    const result = spawnSync(process.execPath, [binPath, 'use'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AURA_AUTO_ALIAS_INSTALL: '0',
        AURA_FORCE_NODE_TSX: '1',
        AURA_TOKEN: 'test-token',
        WALLET_SERVER_URL: 'http://127.0.0.1:9',
      },
      encoding: 'utf8',
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(1);
    expect(combinedOutput).toContain('Usage: npx auramaxx inject <name> [--env ENV_VAR] [-- <command>]');
    expect(combinedOutput).not.toContain('Unknown command: use');
  });

  it('routes top-level approve command to approve handler', () => {
    const result = spawnSync(process.execPath, [binPath, 'approve', '--help'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AURA_AUTO_ALIAS_INSTALL: '0',
        AURA_FORCE_NODE_TSX: '1',
        AURA_NO_UPDATE_CHECK: '1',
      },
      encoding: 'utf8',
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(0);
    expect(combinedOutput).toContain('npx auramaxx approve <actionId> [options]');
    expect(combinedOutput).not.toContain('Unknown command: approve');
  });

  it('routes top-level social aliases to social command handler', () => {
    const result = spawnSync(process.execPath, [binPath, 'post', '--help'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AURA_AUTO_ALIAS_INSTALL: '0',
        AURA_FORCE_NODE_TSX: '1',
        AURA_NO_UPDATE_CHECK: '1',
      },
      encoding: 'utf8',
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(0);
    expect(combinedOutput).toContain('npx auramaxx social <command> [options]');
    expect(combinedOutput).not.toContain('Unknown command: post');
  });

  it('routes top-level register alias to social command handler', () => {
    const result = spawnSync(process.execPath, [binPath, 'register', '--help'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AURA_AUTO_ALIAS_INSTALL: '0',
        AURA_FORCE_NODE_TSX: '1',
        AURA_NO_UPDATE_CHECK: '1',
      },
      encoding: 'utf8',
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(0);
    expect(combinedOutput).toContain('npx auramaxx social <command> [options]');
    expect(combinedOutput).not.toContain('Unknown command: register');
  });

  it('routes top-level unregister alias to social command handler', () => {
    const result = spawnSync(process.execPath, [binPath, 'unregister', '--help'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AURA_AUTO_ALIAS_INSTALL: '0',
        AURA_FORCE_NODE_TSX: '1',
        AURA_NO_UPDATE_CHECK: '1',
      },
      encoding: 'utf8',
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(0);
    expect(combinedOutput).toContain('npx auramaxx social <command> [options]');
    expect(combinedOutput).not.toContain('Unknown command: unregister');
  });

  it('routes create-agent alias to register-agent command handler', () => {
    const result = spawnSync(process.execPath, [binPath, 'create-agent', '--help'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AURA_AUTO_ALIAS_INSTALL: '0',
        AURA_FORCE_NODE_TSX: '1',
        AURA_NO_UPDATE_CHECK: '1',
      },
      encoding: 'utf8',
    });

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(0);
    expect(combinedOutput).toContain('npx auramaxx register-agent [options]');
    expect(combinedOutput).not.toContain('Unknown command: create-agent');
  });

  it('installs aura and auramaxx aliases/shims when forced', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-cli-alias-'));
    const tempBin = path.join(tempHome, 'bin');
    fs.mkdirSync(tempBin, { recursive: true });

    try {
      const result = spawnSync(process.execPath, [binPath, 'init', '--help'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          HOME: tempHome,
          SHELL: '/bin/zsh',
          PATH: tempBin,
          AURA_AUTO_ALIAS_INSTALL_FORCE: '1',
          AURA_FORCE_NODE_TSX: '1',
          AURA_NO_UPDATE_CHECK: '1',
          WALLET_SERVER_URL: 'http://127.0.0.1:9',
        },
        encoding: 'utf8',
      });

      const rcFile = path.join(tempHome, '.zshrc');
      const auraShim = shimPath(tempBin, 'aura');
      const auramaxxShim = shimPath(tempBin, 'auramaxx');
      expect(result.status).not.toBeNull();
      const localBin = path.join(projectRoot, 'bin', 'auramaxx.js');
      expect(fs.existsSync(auraShim)).toBe(true);
      expect(fs.existsSync(auramaxxShim)).toBe(true);
      expect(fs.existsSync(rcFile)).toBe(false);
      if (process.platform === 'win32') {
        expect(fs.readFileSync(auraShim, 'utf8')).toContain(`node "${localBin}" %*`);
        expect(fs.readFileSync(auramaxxShim, 'utf8')).toContain(`node "${localBin}" %*`);
      } else {
        expect(fs.readFileSync(auraShim, 'utf8')).toContain(`exec node "${localBin}" "$@"`);
        expect(fs.readFileSync(auramaxxShim, 'utf8')).toContain(`exec node "${localBin}" "$@"`);
      }
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('cleans legacy npx aliases from shell rc when shims are installed', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-cli-alias-upgrade-'));
    const tempBin = path.join(tempHome, 'bin');
    fs.mkdirSync(tempBin, { recursive: true });
    const rcFile = path.join(tempHome, '.zshrc');
    fs.writeFileSync(rcFile, "alias aura='npx auramaxx'\nalias auramaxx='npx auramaxx'\n", 'utf8');

    try {
      const result = spawnSync(process.execPath, [binPath, 'init', '--help'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          HOME: tempHome,
          SHELL: '/bin/zsh',
          PATH: tempBin,
          AURA_AUTO_ALIAS_INSTALL_FORCE: '1',
          AURA_FORCE_NODE_TSX: '1',
          AURA_NO_UPDATE_CHECK: '1',
          WALLET_SERVER_URL: 'http://127.0.0.1:9',
        },
        encoding: 'utf8',
      });

      expect(result.status).not.toBeNull();
      expect(fs.existsSync(shimPath(tempBin, 'aura'))).toBe(true);
      expect(fs.existsSync(shimPath(tempBin, 'auramaxx'))).toBe(true);
      const rcContent = fs.readFileSync(rcFile, 'utf8');
      expect(rcContent).not.toContain("alias aura='npx auramaxx'");
      expect(rcContent).not.toContain("alias auramaxx='npx auramaxx'");
      expect(rcContent.trim()).toBe('');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('default --help shows essential admin commands only', () => {
    const result = spawnSync(process.execPath, [binPath, '--help'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AURA_AUTO_ALIAS_INSTALL: '0',
        AURA_NO_UPDATE_CHECK: '1',
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });

    const output = result.stdout;
    expect(result.status).toBe(0);

    // COMMANDS section should appear with shortcuts
    expect(output).toContain('[ COMMANDS ]');
    expect(output).toContain('get <name>');
    expect(output).toContain('set <name>');
    expect(output).toContain('list');

    // ADMIN section should show essential commands
    expect(output).toContain('[ ADMIN ]');
    expect(output).toContain('start');
    expect(output).toContain('status');
    expect(output).toContain('mcp');
    expect(output).toContain('skill');
    expect(output).toContain('auth');

    // Default mode should NOT show advanced admin commands
    expect(output).not.toMatch(/\bcron\b.*Run the cron server/);
    expect(output).not.toMatch(/\brelease-check\b.*Run release/);
    expect(output).not.toMatch(/\bquickhack\b.*Generate random/);

    // Should hint about --all
    expect(output).toContain('--help --all');

    // EXAMPLES should use aura alias
    expect(output).toContain('aura status');
    expect(output).toContain('aura get OURSECRET');
  });

  it('--help --all shows all admin commands', () => {
    const result = spawnSync(process.execPath, [binPath, '--help', '--all'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        AURA_AUTO_ALIAS_INSTALL: '0',
        AURA_NO_UPDATE_CHECK: '1',
        NO_COLOR: '1',
      },
      encoding: 'utf8',
    });

    const output = result.stdout;
    expect(result.status).toBe(0);

    // --all mode should show all admin commands
    expect(output).toContain('[ ADMIN ]');
    expect(output).toContain('start');
    expect(output).toContain('cron');
    expect(output).toContain('release-check');
    expect(output).toContain('quickhack');
    expect(output).toContain('shell-hook');
    expect(output).toContain('experimental');
    expect(output).toContain('wallet');
  });

  it('routes inferred --debug flags to start command', () => {
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-start-debug-'));
    try {
      fs.writeFileSync(path.join(tempData, 'auramaxx.db'), '');
      fs.writeFileSync(path.join(tempData, 'agent-primary.json'), '{}');

      const result = spawnSync(process.execPath, [binPath, '--debug', '--help'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          WALLET_DATA_DIR: tempData,
          AURA_AUTO_ALIAS_INSTALL: '0',
          AURA_FORCE_NODE_TSX: '1',
          AURA_NO_UPDATE_CHECK: '1',
        },
        encoding: 'utf8',
      });

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(combinedOutput).toContain('npx auramaxx start [options]');
      expect(combinedOutput).not.toContain('Unknown command: --debug');
    } finally {
      fs.rmSync(tempData, { recursive: true, force: true });
    }
  });

  it('routes inferred --terminal flags to start command', () => {
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-start-terminal-'));
    try {
      fs.writeFileSync(path.join(tempData, 'auramaxx.db'), '');
      fs.writeFileSync(path.join(tempData, 'agent-primary.json'), '{}');

      const result = spawnSync(process.execPath, [binPath, '--terminal', '--help'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          WALLET_DATA_DIR: tempData,
          AURA_AUTO_ALIAS_INSTALL: '0',
          AURA_FORCE_NODE_TSX: '1',
          AURA_NO_UPDATE_CHECK: '1',
        },
        encoding: 'utf8',
      });

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(combinedOutput).toContain('npx auramaxx start [options]');
      expect(combinedOutput).not.toContain('Unknown command: --terminal');
    } finally {
      fs.rmSync(tempData, { recursive: true, force: true });
    }
  });

  it('ignores env toggles and auto-runs skill/mcp setup on explicit start', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-start-autoinstall-'));
    const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-start-autoinstall-data-'));
    try {
      fs.writeFileSync(path.join(tempData, 'auramaxx.db'), '');
      fs.writeFileSync(path.join(tempData, 'agent-primary.json'), '{}');

      const result = spawnSync(process.execPath, [binPath, 'start', '--help'], {
        cwd: projectRoot,
        env: {
          ...process.env,
          HOME: tempHome,
          CODEX_HOME: path.join(tempHome, '.codex'),
          CLAUDE_HOME: path.join(tempHome, '.claude'),
          OPENCLAW_HOME: path.join(tempHome, '.openclaw'),
          WALLET_DATA_DIR: tempData,
          AURA_AUTO_ALIAS_INSTALL: '0',
          AURA_AUTO_SKILL_INSTALL: '0',
          AURA_AUTO_MCP_INSTALL: '0',
          AURA_FORCE_NODE_TSX: '1',
          AURA_NO_UPDATE_CHECK: '1',
        },
        encoding: 'utf8',
      });

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(combinedOutput).toContain('Skills… ✓');
      expect(combinedOutput).toContain('MCP… ✓');
      expect(combinedOutput).toContain('npx auramaxx start [options]');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
      fs.rmSync(tempData, { recursive: true, force: true });
    }
  });
});
