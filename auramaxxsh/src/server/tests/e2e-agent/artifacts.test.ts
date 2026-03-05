import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { writeArtifacts } from '../../lib/e2e-agent/artifacts';
import { RunFingerprint } from '../../lib/e2e-agent/contracts';

describe('e2e-agent artifacts', () => {
  it('writes summary and replay manifest with matching runFingerprint', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-agent-artifacts-'));
    const runFingerprint: RunFingerprint = {
      scenarioId: 'credential-create-basic',
      lane: 'pr-smoke',
      mode: 'scripted',
      clockBaseTimeIso: '2026-02-16T12:00:00.000Z',
      schemaVersion: '1.0.0',
      runnerVersion: '1.0.0',
      gitCommit: 'deadbeef',
    };

    const paths = writeArtifacts(tempDir, {
      runId: 'run-123',
      status: 'passed',
      scenarioId: 'credential-create-basic',
      runFingerprint,
    });

    const summary = JSON.parse(fs.readFileSync(paths.summaryPath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf8'));

    expect(summary.runFingerprint).toEqual(runFingerprint);
    expect(manifest.runFingerprint).toEqual(runFingerprint);
    expect(manifest.replayCommand).toContain('run-123');
  });
});
