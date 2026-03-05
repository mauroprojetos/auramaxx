#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const localAuraCli = resolve(projectRoot, 'node_modules', '@auraindustry', 'aurajs', 'src', 'cli.mjs');
const runArgs = ['run', '--asset-mode', 'sibling'];

const result = existsSync(localAuraCli)
  ? spawnSync(process.execPath, [localAuraCli, ...runArgs], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    })
  : spawnSync('npm', ['exec', '--yes', '--package', '@auraindustry/aurajs', '--', 'aura', ...runArgs], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });

process.exit(result.status ?? 1);
