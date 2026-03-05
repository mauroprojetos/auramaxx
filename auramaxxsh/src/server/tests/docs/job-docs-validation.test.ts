import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

describe('job docs validation harness', () => {
  it('passes for canonical job docs runbooks', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');

    const output = execFileSync('node', ['scripts/validate-job-docs.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(output).toContain('job docs validation passed');
  });
});
