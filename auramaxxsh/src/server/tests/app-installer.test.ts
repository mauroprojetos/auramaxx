/**
 * App Installer Tests
 *
 * Tests installApp, removeApp, listApps, updateApp
 * using real filesystem operations in temp directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  installApp,
  removeApp,
  listApps,
  updateApp,
} from '../lib/app-installer';

// ─── Test Fixtures ──────────────────────────────────────────────────

const VALID_APP_MD = `---
name: Test App
icon: Smile
category: general
size: 1x1
permissions:
data:
---

A test app for unit tests.
`;

const APP_MD_WITH_PERMS = `---
name: Perms App
icon: Shield
category: strategy
size: 2x1
permissions:
  - swap
  - wallet:list
data:
---

A app that requires permissions.
`;

const VALID_INDEX_HTML = `<!DOCTYPE html>
<html><head></head><body><div>Hello</div></body></html>
`;

const INVALID_APP_MD_NO_FRONTMATTER = `# Just a markdown file
No YAML frontmatter here.
`;

/** Create a valid app directory at the given path */
function createValidApp(dir: string, appMd = VALID_APP_MD) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.md'), appMd);
  fs.writeFileSync(path.join(dir, 'index.html'), VALID_INDEX_HTML);
}

// ─── Helpers ────────────────────────────────────────────────────────

let originalCwd: string;
let testRoot: string;

beforeEach(() => {
  originalCwd = process.cwd();
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-app-test-'));
  // App installer uses process.cwd()/apps as the target
  process.chdir(testRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// ─── installApp ──────────────────────────────────────────────────

describe('installApp', () => {
  it('should install from a local path', () => {
    // Create a source app
    const sourceDir = path.join(testRoot, 'source-app');
    createValidApp(sourceDir);

    const result = installApp(sourceDir);

    expect(result.id).toBe('source-app');
    expect(result.name).toBe('Test App');
    expect(result.source.type).toBe('local');

    // Verify files were copied
    const targetDir = path.join(testRoot, 'apps', 'source-app');
    expect(fs.existsSync(path.join(targetDir, 'app.md'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, '.source.json'))).toBe(true);
  });

  it('should install with a custom name via --name', () => {
    const sourceDir = path.join(testRoot, 'source-app');
    createValidApp(sourceDir);

    const result = installApp(sourceDir, { name: 'custom-id' });

    expect(result.id).toBe('custom-id');
    expect(fs.existsSync(path.join(testRoot, 'apps', 'custom-id', 'app.md'))).toBe(true);
  });

  it('should write correct .source.json provenance', () => {
    const sourceDir = path.join(testRoot, 'my-app');
    createValidApp(sourceDir);

    installApp(sourceDir, { name: 'test-provenance' });

    const sourceJson = JSON.parse(
      fs.readFileSync(path.join(testRoot, 'apps', 'test-provenance', '.source.json'), 'utf-8')
    );
    expect(sourceJson.type).toBe('local');
    expect(sourceJson.url).toBe(sourceDir);
    expect(sourceJson.ref).toBeNull();
    expect(sourceJson.subdir).toBeNull();
    expect(sourceJson.installedAt).toBeDefined();
  });

  it('should reject if app already exists without --force', () => {
    const sourceDir = path.join(testRoot, 'existing-app');
    createValidApp(sourceDir);

    // Install once
    installApp(sourceDir);

    // Install again — should fail
    expect(() => installApp(sourceDir)).toThrow('already exists');
  });

  it('should overwrite with --force', () => {
    const sourceDir = path.join(testRoot, 'force-app');
    createValidApp(sourceDir);

    installApp(sourceDir, { name: 'overwrite-test' });

    // Modify source
    fs.writeFileSync(path.join(sourceDir, 'extra.txt'), 'new file');

    // Force install
    const result = installApp(sourceDir, { name: 'overwrite-test', force: true });
    expect(result.id).toBe('overwrite-test');
    expect(fs.existsSync(path.join(testRoot, 'apps', 'overwrite-test', 'extra.txt'))).toBe(true);
  });

  it('should reject app without app.md', () => {
    const sourceDir = path.join(testRoot, 'no-manifest');
    fs.mkdirSync(sourceDir, { recursive: true });

    expect(() => installApp(sourceDir)).toThrow('Missing app.md');
  });

  it('should accept app without index.html (headless)', () => {
    const sourceDir = path.join(testRoot, 'headless-app');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'app.md'), VALID_APP_MD);

    const result = installApp(sourceDir);

    expect(result.id).toBe('headless-app');
    expect(result.name).toBe('Test App');
    const targetDir = path.join(testRoot, 'apps', 'headless-app');
    expect(fs.existsSync(path.join(targetDir, 'app.md'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'index.html'))).toBe(false);
  });

  it('should reject app.md without YAML frontmatter', () => {
    const sourceDir = path.join(testRoot, 'bad-manifest');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'app.md'), INVALID_APP_MD_NO_FRONTMATTER);
    fs.writeFileSync(path.join(sourceDir, 'index.html'), VALID_INDEX_HTML);

    expect(() => installApp(sourceDir)).toThrow('missing YAML frontmatter');
  });

  it('should reject files larger than 5MB', () => {
    const sourceDir = path.join(testRoot, 'big-file-app');
    createValidApp(sourceDir);

    // Create a file just over 5MB
    const bigFile = Buffer.alloc(5 * 1024 * 1024 + 1, 'x');
    fs.writeFileSync(path.join(sourceDir, 'huge.bin'), bigFile);

    expect(() => installApp(sourceDir)).toThrow('File too large');
  });

  it('should reject total size over 20MB', () => {
    const sourceDir = path.join(testRoot, 'big-total-app');
    createValidApp(sourceDir);

    // Create multiple files that sum to >20MB
    const chunk = Buffer.alloc(4 * 1024 * 1024, 'x'); // 4MB each
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(sourceDir, `chunk-${i}.bin`), chunk);
    }

    expect(() => installApp(sourceDir)).toThrow('exceeds 20MB');
  });

  it('should reject symlinks that escape the app directory', () => {
    const sourceDir = path.join(testRoot, 'symlink-app');
    createValidApp(sourceDir);

    // Create a symlink pointing outside the app
    fs.symlinkSync('/etc/passwd', path.join(sourceDir, 'escape.txt'));

    expect(() => installApp(sourceDir)).toThrow('Symlink escapes');
  });

  it('should reject nonexistent local path', () => {
    expect(() => installApp('/nonexistent/path/app')).toThrow('not found');
  });

  it('should create apps/ directory if it does not exist', () => {
    const sourceDir = path.join(testRoot, 'auto-create');
    createValidApp(sourceDir);

    expect(fs.existsSync(path.join(testRoot, 'apps'))).toBe(false);

    installApp(sourceDir);

    expect(fs.existsSync(path.join(testRoot, 'apps'))).toBe(true);
  });

  it('should preserve permissions from manifest', () => {
    const sourceDir = path.join(testRoot, 'perms-app');
    createValidApp(sourceDir, APP_MD_WITH_PERMS);

    const result = installApp(sourceDir);
    expect(result.name).toBe('Perms App');
  });

  it('should handle relative local paths', () => {
    const sourceDir = path.join(testRoot, 'relative-source');
    createValidApp(sourceDir);

    const result = installApp('./relative-source');

    expect(result.id).toBe('relative-source');
    expect(result.source.type).toBe('local');
  });
});

// ─── removeApp ───────────────────────────────────────────────────

describe('removeApp', () => {
  it('should remove an installed app', () => {
    const sourceDir = path.join(testRoot, 'removable');
    createValidApp(sourceDir);
    installApp(sourceDir);

    const targetDir = path.join(testRoot, 'apps', 'removable');
    expect(fs.existsSync(targetDir)).toBe(true);

    removeApp('removable');
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it('should reject removing nonexistent app', () => {
    expect(() => removeApp('does-not-exist')).toThrow('not found');
  });

  it('should reject removing directory without app.md', () => {
    // Create a directory that's not a app
    const fakeDir = path.join(testRoot, 'apps', 'not-a-app');
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDir, 'random.txt'), 'hello');

    expect(() => removeApp('not-a-app')).toThrow('does not appear to be a app');
  });
});

// ─── listApps ────────────────────────────────────────────────────

describe('listApps', () => {
  it('should return empty array when no apps installed', () => {
    const result = listApps();
    expect(result).toEqual([]);
  });

  it('should return empty array when apps/ does not exist', () => {
    // testRoot has no apps/ dir by default
    const result = listApps();
    expect(result).toEqual([]);
  });

  it('should list installed apps with metadata', () => {
    const source1 = path.join(testRoot, 'app-a');
    const source2 = path.join(testRoot, 'app-b');
    createValidApp(source1);
    createValidApp(source2, APP_MD_WITH_PERMS);

    installApp(source1);
    installApp(source2);

    const list = listApps();
    expect(list).toHaveLength(2);

    const appA = list.find(w => w.id === 'app-a');
    const appB = list.find(w => w.id === 'app-b');

    expect(appA).toBeDefined();
    expect(appA!.name).toBe('Test App');
    expect(appA!.description).toBe('A test app for unit tests.');
    expect(appA!.source).toBeDefined();
    expect(appA!.source!.type).toBe('local');

    expect(appB).toBeDefined();
    expect(appB!.name).toBe('Perms App');
    expect(appB!.permissions).toEqual(['swap', 'wallet:list']);
  });

  it('should list apps without .source.json (manually created)', () => {
    // Manually create a app in apps/ (no .source.json)
    const appDir = path.join(testRoot, 'apps', 'manual-app');
    createValidApp(appDir);

    const list = listApps();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('manual-app');
    expect(list[0].source).toBeNull();
  });

  it('should skip directories without app.md', () => {
    fs.mkdirSync(path.join(testRoot, 'apps', 'not-a-app'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, 'apps', 'not-a-app', 'readme.txt'), 'hi');

    const appDir = path.join(testRoot, 'apps', 'real-app');
    createValidApp(appDir);

    const list = listApps();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('real-app');
  });
});

// ─── updateApp ───────────────────────────────────────────────────

describe('updateApp', () => {
  it('should re-install app from .source.json', () => {
    const sourceDir = path.join(testRoot, 'updatable');
    createValidApp(sourceDir);

    installApp(sourceDir);

    // Modify the source
    fs.writeFileSync(path.join(sourceDir, 'new-file.txt'), 'updated content');

    // Update should re-install from original source
    const result = updateApp('updatable');
    expect(result.id).toBe('updatable');
    expect(fs.existsSync(path.join(testRoot, 'apps', 'updatable', 'new-file.txt'))).toBe(true);
  });

  it('should reject update for nonexistent app', () => {
    expect(() => updateApp('ghost')).toThrow('not found');
  });

  it('should reject update for app without .source.json', () => {
    const appDir = path.join(testRoot, 'apps', 'no-source');
    createValidApp(appDir);

    expect(() => updateApp('no-source')).toThrow('no .source.json');
  });

  it('should reject update with corrupted .source.json', () => {
    const appDir = path.join(testRoot, 'apps', 'bad-source');
    createValidApp(appDir);
    fs.writeFileSync(path.join(appDir, '.source.json'), 'not json{{{');

    expect(() => updateApp('bad-source')).toThrow('invalid .source.json');
  });
});

// ─── Source detection (tested indirectly via installApp) ─────────

describe('source detection', () => {
  it('should detect local paths starting with ./', () => {
    const sourceDir = path.join(testRoot, 'dot-local');
    createValidApp(sourceDir);

    const result = installApp('./dot-local');
    expect(result.source.type).toBe('local');
  });

  it('should detect local paths starting with /', () => {
    const sourceDir = path.join(testRoot, 'abs-local');
    createValidApp(sourceDir);

    const result = installApp(sourceDir);
    expect(result.source.type).toBe('local');
  });

  // Note: git/tarball/zip source types can't be easily tested without network.
  // Those paths are tested manually via `npx auramaxx app install <url>`.
});
