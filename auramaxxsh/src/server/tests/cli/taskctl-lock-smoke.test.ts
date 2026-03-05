/**
 * Smoke test: taskctl ownership and lock enforcement via CLI.
 *
 * Exercises claim-lock, update-task-status (requires lock), release-lock,
 * and verifies that a second owner cannot claim a held lock or transition
 * a task they don't own.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * The taskctl script imports from an external project (theroom).
 * Skip the entire suite when that dependency isn't available.
 */
const PIPELINE_DEP = path.join(os.homedir(), 'src/theroom/src/lib/pipeline-db-bootstrap.ts');
const hasExternalDep = fs.existsSync(PIPELINE_DEP);

function makeTemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(args: string, env: Record<string, string>): { code: number; json: Record<string, unknown> } {
  const cmd = `node --import tsx scripts/taskctl.ts ${args} --json`;
  try {
    const stdout = execSync(cmd, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { code: 0, json: JSON.parse(stdout.trim()) };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    const out = (e.stdout || '').trim();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(out);
    } catch {
      json = { raw: out };
    }
    return { code: e.status ?? 1, json };
  }
}

describe.skipIf(!hasExternalDep)('taskctl ownership + lock enforcement smoke', () => {
  const tempDirs: string[] = [];

  function freshEnv() {
    const dbRoot = path.join(makeTemp('taskctl-smoke-'), 'state');
    const home = makeTemp('taskctl-smoke-home-');
    tempDirs.push(dbRoot, home);
    return { AURAPIPELINE_DB_ROOT: dbRoot, HOME: home };
  }

  afterEach(() => {
    for (const d of tempDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('owner A locks, owner B is rejected, A transitions, B cannot transition', () => {
    const env = freshEnv();

    // Create a task
    const create = run('create-task --slug smoke-lock --title "Smoke lock test" --task 9990 --priority P1', env);
    expect(create.json.ok).toBe(true);

    // Owner A claims lock
    const claimA = run('claim-lock --task 9990 --owner alice', env);
    expect(claimA.code).toBe(0);
    expect(claimA.json.acquired).toBe(true);

    // Owner B cannot claim the same task
    const claimB = run('claim-lock --task 9990 --owner bob', env);
    expect(claimB.code).not.toBe(0);
    expect(claimB.json.acquired).toBe(false);
    expect(claimB.json.reason).toBe('LOCK_HELD');

    // Owner A can transition OPEN → IN_PROGRESS
    const t1 = run('update-task-status --task 9990 --owner alice --status IN_PROGRESS', env);
    expect(t1.json.ok).toBe(true);

    // Owner B cannot transition (no lock)
    const t2 = run('update-task-status --task 9990 --owner bob --status AUDITING', env);
    expect(t2.json.ok).toBe(false);
    expect(t2.json.reason).toBe('LOCK_REQUIRED');

    // Invalid transition (IN_PROGRESS → OPEN not allowed)
    const t3 = run('update-task-status --task 9990 --owner alice --status OPEN', env);
    expect(t3.json.ok).toBe(false);
    expect(t3.json.reason).toBe('INVALID_TRANSITION');

    // Valid transition IN_PROGRESS → AUDITING
    const t4 = run('update-task-status --task 9990 --owner alice --status AUDITING', env);
    expect(t4.json.ok).toBe(true);

    // Release lock
    const rel = run('release-lock --task 9990 --owner alice', env);
    expect(rel.code).toBe(0);
    expect(rel.json.released).toBe(true);

    // Now bob can claim
    const claimB2 = run('claim-lock --task 9990 --owner bob', env);
    expect(claimB2.code).toBe(0);
    expect(claimB2.json.acquired).toBe(true);

    // Verify final state via show-task
    const show = run('show-task --task 9990', env);
    expect(show.json.ok).toBe(true);
    const task = (show.json.task as Record<string, unknown>);
    expect(task.status).toBe('AUDITING');

    // Cleanup bob's lock
    run('release-lock --task 9990 --owner bob', env);
  });

  it('wrong owner cannot release lock', () => {
    const env = freshEnv();

    run('create-task --slug smoke-rel --title "Release test" --task 9991', env);
    run('claim-lock --task 9991 --owner alice', env);

    const bad = run('release-lock --task 9991 --owner bob', env);
    expect(bad.json.released).toBe(false);

    // alice can still release
    const good = run('release-lock --task 9991 --owner alice', env);
    expect(good.json.released).toBe(true);
  });
});
