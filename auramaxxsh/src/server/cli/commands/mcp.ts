/**
 * auramaxx mcp — Start the MCP server (stdio transport)
 *
 * Spawned by MCP clients (Codex CLI, Claude Code/Desktop, Cursor, VS Code, Windsurf, etc.) via config:
 *   { "command": "npx", "args": ["auramaxx", "mcp"], "env": { "AURA_TOKEN": "<token>" } }
 *
 * Flags:
 *   --install  Auto-detect local client MCP config entries (does not start server)
 *   --run      Start MCP server after processing install/setup flags
 *   --setup    Install MCP config entries, then start MCP server
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { getErrorMessage } from '../../lib/error';

const args = process.argv.slice(2);

const shouldInstall = args.includes('--install') || args.includes('--setup');
const shouldRun = args.includes('--run') || args.includes('--setup') || !shouldInstall;

if (shouldInstall) {
  installMcpConfigs();
}
if (shouldRun) {
  // The MCP server runs on import — connects stdio transport and registers tools
  import('../../mcp/server.js');
}

interface IdeTarget {
  name: string;
  configPath: string;
  global: boolean;
}

type InstallStatus = 'configured' | 'already-configured' | 'not-found' | 'error';

interface InstallResult {
  status: InstallStatus;
  detail?: string;
}

function installMcpConfigs(): void {
  const home = os.homedir();
  const walletBase = process.env.WALLET_SERVER_URL?.trim() || undefined;

  const targets: IdeTarget[] = [
    {
      name: 'Claude Code',
      configPath: path.join(process.cwd(), '.mcp.json'),
      global: false,
    },
    {
      name: 'Claude Desktop',
      configPath: path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      global: true,
    },
    {
      name: 'Cursor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      global: true,
    },
    {
      name: 'VS Code',
      configPath: path.join(process.cwd(), '.vscode', 'mcp.json'),
      global: false,
    },
    {
      name: 'Windsurf',
      configPath: path.join(home, '.windsurf', 'mcp.json'),
      global: true,
    },
  ];

  console.log('\n  AuraMaxx MCP Installer');
  console.log('  ───────────────────────\n');

  let updated = 0;
  let skipped = 0;
  let notFound = 0;
  let errors = 0;

  for (const target of targets) {
    const configDir = path.dirname(target.configPath);

    // Only touch configs for IDEs that are actually present.
    // Do not create new IDE directories implicitly.
    if (!fs.existsSync(configDir)) {
      console.log(`  ${target.name}: not found (${configDir} not found)`);
      notFound++;
      continue;
    }

    // Read existing config or start fresh. If the file is malformed, skip it
    // instead of overwriting user data with {}.
    let config: Record<string, unknown> = {};
    if (fs.existsSync(target.configPath)) {
      try {
        const raw = fs.readFileSync(target.configPath, 'utf-8');
        config = JSON.parse(raw);
      } catch (error) {
        const message = getErrorMessage(error);
        console.log(`  ${target.name}: skipped (invalid JSON in ${target.configPath}: ${message})`);
        errors++;
        continue;
      }
    }

    // Check if canonical entry already exists
    if (
      config.mcpServers !== undefined &&
      (typeof config.mcpServers !== 'object' || config.mcpServers === null || Array.isArray(config.mcpServers))
    ) {
      console.log(`  ${target.name}: skipped (mcpServers must be an object in ${target.configPath})`);
      errors++;
      continue;
    }

    const mcpServers = (config.mcpServers || {}) as Record<string, unknown>;
    const existingEntry = isPlainObject(mcpServers.auramaxx) ? mcpServers.auramaxx as Record<string, unknown> : undefined;
    const nextEntry = buildJsonMcpEntry(existingEntry, walletBase);
    if (existingEntry && sameJson(existingEntry, nextEntry)) {
      console.log(`  ${target.name}: already configured`);
      skipped++;
      continue;
    }

    // Merge canonical entry.
    mcpServers.auramaxx = nextEntry;
    config.mcpServers = mcpServers;

    fs.writeFileSync(target.configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`  ${target.name}: configured (${target.configPath})`);
    updated++;
  }

  const codexResult = installCodexMcp(home, walletBase);
  if (codexResult.status === 'configured') {
    const detail = codexResult.detail ? ` (${codexResult.detail})` : '';
    console.log(`  Codex CLI: configured (${path.join(home, '.codex', 'config.toml')})${detail}`);
    updated++;
  } else if (codexResult.status === 'already-configured') {
    console.log('  Codex CLI: already configured');
    skipped++;
  } else if (codexResult.status === 'not-found') {
    const detail = codexResult.detail ? ` (${codexResult.detail})` : '';
    console.log(`  Codex CLI: not found${detail}`);
    notFound++;
  } else {
    const detail = codexResult.detail ? ` (${codexResult.detail})` : '';
    console.log(`  Codex CLI: skipped due to error${detail}`);
    errors++;
  }

  console.log('');
  console.log(`  Done: ${updated} updated, ${skipped} already configured, ${notFound} not found, ${errors} skipped due to errors`);
  console.log('');
}

function buildJsonMcpEntry(existing: Record<string, unknown> | undefined, walletBase: string | undefined): Record<string, unknown> {
  const next: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {};
  next.command = 'npx';
  next.args = ['auramaxx', 'mcp'];

  const env = isPlainObject(existing?.env) ? { ...(existing?.env as Record<string, unknown>) } : {};
  if (walletBase) {
    env.WALLET_SERVER_URL = walletBase;
  } else {
    delete env.WALLET_SERVER_URL;
  }
  if (Object.keys(env).length > 0) {
    next.env = env;
  } else {
    delete next.env;
  }

  return next;
}

function installCodexMcp(home: string, walletBase: string | undefined): InstallResult {
  const probe = spawnSync('codex', ['mcp', 'list'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (probe.error) {
    const code = (probe.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { status: 'not-found', detail: 'codex not in PATH' };
    }
    return { status: 'error', detail: getErrorMessage(probe.error) };
  }
  if ((probe.status ?? 1) !== 0) {
    return { status: 'error', detail: sanitizeCommandOutput(probe.stderr || probe.stdout) };
  }

  let needsUpdate = true;
  const existing = spawnSync('codex', ['mcp', 'get', 'auramaxx', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!existing.error && (existing.status ?? 1) === 0) {
    try {
      const parsed = JSON.parse(existing.stdout) as {
        transport?: {
          type?: string;
          command?: string;
          args?: unknown;
          env?: Record<string, unknown> | null;
        };
      };
      if (parsed.transport?.type === 'stdio' && parsed.transport?.command === 'npx') {
        const args = Array.isArray(parsed.transport.args) ? parsed.transport.args : [];
        const argsMatch = args.length === 2 && args[0] === 'auramaxx' && args[1] === 'mcp';
        const env = parsed.transport.env || {};
        const currentWalletBase = typeof env.WALLET_SERVER_URL === 'string' ? env.WALLET_SERVER_URL : undefined;
        if (argsMatch && currentWalletBase === walletBase) {
          needsUpdate = false;
        }
      }
    } catch {
      // Ignore parse failure and reconfigure.
    }
  } else if (existing.error) {
    return { status: 'error', detail: getErrorMessage(existing.error) };
  }

  if (!needsUpdate) {
    return { status: 'already-configured' };
  }

  const remove = spawnSync('codex', ['mcp', 'remove', 'auramaxx'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (remove.error) {
    return { status: 'error', detail: getErrorMessage(remove.error) };
  }
  if ((remove.status ?? 0) !== 0) {
    const stderr = remove.stderr || '';
    const notFound = stderr.includes("No MCP server named 'auramaxx' found");
    if (!notFound) {
      return { status: 'error', detail: sanitizeCommandOutput(remove.stderr || remove.stdout) };
    }
  }

  const addArgs = ['mcp', 'add', 'auramaxx'];
  if (walletBase) {
    addArgs.push('--env', `WALLET_SERVER_URL=${walletBase}`);
  }
  addArgs.push('--', 'npx', 'auramaxx', 'mcp');

  const add = spawnSync('codex', addArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (add.error) {
    return { status: 'error', detail: getErrorMessage(add.error) };
  }
  if ((add.status ?? 1) !== 0) {
    return { status: 'error', detail: sanitizeCommandOutput(add.stderr || add.stdout) };
  }

  const detail = walletBase ? `WALLET_SERVER_URL=${walletBase}` : undefined;
  return { status: 'configured', detail };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameJson(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sanitizeCommandOutput(text?: string): string | undefined {
  if (!text) return undefined;
  const cleaned = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('WARNING: proceeding, even though we could not update PATH'))
    .join(' | ');
  return cleaned || undefined;
}
