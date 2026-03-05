import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../../../..');
const binPath = path.join('bin', 'auramaxx.js');
const createCommandPath = path.join(projectRoot, 'src', 'server', 'cli', 'commands', 'create.ts');

function runCreate(args: string[], envExtra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [binPath, 'create', ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AURA_AUTO_ALIAS_INSTALL: '0',
      AURA_FORCE_NODE_TSX: '1',
      AURA_NO_UPDATE_CHECK: '1',
      ...envExtra,
    },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('create command', () => {
  it('shows canonical template ids in help', () => {
    const result = runCreate(['--help']);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(0);
    expect(combined).toContain('--template <2d-shooter|3d-platformer|blank>');
    expect(combined).toContain('auramaxx create my-game --template 3d-platformer');
  });

  it('contains descriptive select labels for 2d/3d scaffold presets', () => {
    const source = fs.readFileSync(createCommandPath, 'utf8');
    expect(source).toContain("label: '[2D] Shooter'");
    expect(source).toContain("label: '[3D] Platformer'");
    expect(source).toContain("value: '2d-shooter'");
    expect(source).toContain("value: '3d-platformer'");
  });

  it('delegates 3d alias template to aurajs 3d-platformer scaffold', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-create-test-'));
    const projectName = 'wrapper-3d-alias';
    const projectPath = path.join(tempRoot, projectName);

    try {
      const result = runCreate(
        [projectName, '--template', '3d', '--skip-install'],
        { AURA_INVOKE_CWD: tempRoot },
      );

      const combined = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(0);
      expect(combined).toContain('Template: 3d-platformer');

      const mainPath = path.join(projectPath, 'src', 'main.js');
      const starterUtilsPath = path.join(projectPath, 'src', 'starter-utils', 'index.js');
      expect(fs.existsSync(mainPath)).toBe(true);
      expect(fs.existsSync(starterUtilsPath)).toBe(true);

      const mainSource = fs.readFileSync(mainPath, 'utf8');
      expect(mainSource).toContain('AuraJS 3D platformer starter');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
