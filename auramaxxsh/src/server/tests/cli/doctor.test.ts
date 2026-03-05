import { afterEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import net from 'net';
import { parseArgs, mapExitCode, evaluateCredentialHealthSeverity, probeSocketViability, type DoctorCheck } from '../../cli/commands/doctor';

describe('doctor CLI arg parsing', () => {
  it('parses default options', () => {
    expect(parseArgs([])).toEqual({ json: false, strict: false, fix: false });
  });

  it('parses json + strict', () => {
    expect(parseArgs(['--json', '--strict'])).toEqual({ json: true, strict: true, fix: false });
  });

  it('parses fix flag', () => {
    expect(parseArgs(['--fix'])).toEqual({ json: false, strict: false, fix: true });
  });

  it('throws on unknown flags', () => {
    expect(() => parseArgs(['--wat'])).toThrow('Unknown flag: --wat');
  });
});

describe('doctor exit-code mapping', () => {
  const baseCheck: DoctorCheck = {
    id: 'runtime.api.health',
    code: 'AURA_DOCTOR_RUNTIME_API_HEALTHY',
    severity: 'info',
    status: 'pass',
    finding: 'ok',
    evidence: 'ok',
    remediation: 'none',
  };

  it('returns 0 when ok=true', () => {
    expect(
      mapExitCode({
        ok: true,
        mode: 'default',
        summary: { pass: 1, warn: 0, fail: 0 },
        checks: [baseCheck],
      })
    ).toBe(0);
  });

  it('returns 1 when ok=false', () => {
    expect(
      mapExitCode({
        ok: false,
        mode: 'default',
        summary: { pass: 0, warn: 0, fail: 1 },
        checks: [{ ...baseCheck, status: 'fail' }],
      })
    ).toBe(1);
  });
});

describe('credential health severity mapping', () => {
  it('maps breached summary to fail', () => {
    const result = evaluateCredentialHealthSeverity({
      totalAnalyzed: 5,
      safe: 1,
      weak: 1,
      reused: 2,
      breached: 1,
      unknown: 0,
      lastScanAt: null,
    });

    expect(result.status).toBe('fail');
    expect(result.code).toBe('AURA_DOCTOR_CREDENTIAL_HEALTH_BREACHED');
  });

  it('maps unknown-only risk to warn with unknown remediation', () => {
    const result = evaluateCredentialHealthSeverity({
      totalAnalyzed: 5,
      safe: 4,
      weak: 0,
      reused: 0,
      breached: 0,
      unknown: 1,
      lastScanAt: null,
    });

    expect(result.status).toBe('warn');
    expect(result.code).toBe('AURA_DOCTOR_CREDENTIAL_HEALTH_WARN_UNKNOWN');
    expect(result.remediation).toContain('HEALTH_BREACH_CHECK=true');
  });

  it('maps all clear summary to pass', () => {
    const result = evaluateCredentialHealthSeverity({
      totalAnalyzed: 5,
      safe: 5,
      weak: 0,
      reused: 0,
      breached: 0,
      unknown: 0,
      lastScanAt: null,
    });

    expect(result.status).toBe('pass');
    expect(result.code).toBe('AURA_DOCTOR_CREDENTIAL_HEALTH_PASS');
  });
});

describe('doctor socket probe (windows pipe mode)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports viable when named-pipe ping responds with pong', async () => {
    vi.spyOn(net, 'createConnection').mockImplementation(() => {
      const socket = new EventEmitter() as unknown as net.Socket;
      (socket as unknown as { write: (data: string) => void }).write = () => {
        setTimeout(() => {
          (socket as unknown as EventEmitter).emit('data', Buffer.from('{"type":"pong"}'));
        }, 0);
      };
      (socket as unknown as { destroy: () => void }).destroy = () => {};
      setTimeout(() => {
        (socket as unknown as EventEmitter).emit('connect');
      }, 0);
      return socket;
    });

    const result = await probeSocketViability({
      platform: 'win32',
      socketPaths: ['\\\\.\\pipe\\aura-cli-test'],
    });

    expect(result.viable).toBe(true);
    expect(result.evidence).toBe('socket-connect-ping-ok:\\\\.\\pipe\\aura-cli-test');
  });

  it('reports non-viable when named-pipe connection fails', async () => {
    vi.spyOn(net, 'createConnection').mockImplementation(() => {
      const socket = new EventEmitter() as unknown as net.Socket;
      (socket as unknown as { write: (data: string) => void }).write = () => {};
      (socket as unknown as { destroy: () => void }).destroy = () => {};
      setTimeout(() => {
        (socket as unknown as EventEmitter).emit('error', new Error('connect failed'));
      }, 0);
      return socket;
    });

    const result = await probeSocketViability({
      platform: 'win32',
      socketPaths: ['\\\\.\\pipe\\aura-cli-test'],
    });

    expect(result.viable).toBe(false);
    expect(result.evidence).toBe('socket-connect-failed:\\\\.\\pipe\\aura-cli-test');
  });
});
