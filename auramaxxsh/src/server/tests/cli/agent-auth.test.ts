import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getApprovalContext, putActiveSessionToken, putApprovalContext, putClaimedToken } from '../../cli/lib/approval-context';
import { waitForAuthDecision } from '../../cli/lib/approval-poll';

function hasClaimSecret(init: RequestInit | undefined, expected: string): boolean {
  const headers = init?.headers;
  if (!headers) return false;
  if (headers instanceof Headers) {
    return headers.get('x-aura-claim-secret') === expected;
  }
  if (Array.isArray(headers)) {
    return headers.some(([key, value]) => key.toLowerCase() === 'x-aura-claim-secret' && String(value) === expected);
  }
  const asRecord = headers as Record<string, unknown>;
  for (const [key, value] of Object.entries(asRecord)) {
    if (key.toLowerCase() === 'x-aura-claim-secret') {
      return String(value) === expected;
    }
  }
  return false;
}

function makeTestAgentToken(permissions: string[]): string {
  const payload = Buffer.from(JSON.stringify({
    agentId: 'cli-agent',
    permissions,
    exp: Date.now() + 60_000,
  }), 'utf8').toString('base64url');
  return `${payload}.sig`;
}

const mocks = vi.hoisted(() => ({
  bootstrapViaSocket: vi.fn(),
  bootstrapViaAuthRequest: vi.fn(),
  generateEphemeralKeypair: vi.fn(() => ({
    publicKeyPem: 'mock-public-key',
    privateKeyPem: 'mock-private-key',
    publicKeyBase64: Buffer.from('mock-public-key', 'utf8').toString('base64'),
  })),
  createReadToken: vi.fn(async () => 'read-token'),
  decryptWithPrivateKey: vi.fn((encrypted: string) => encrypted),
  encryptToAgentPubkey: vi.fn((value: string) => `enc(${value})`),
}));

vi.mock('../../lib/credential-transport', async () => {
  const actual = await vi.importActual<typeof import('../../lib/credential-transport')>('../../lib/credential-transport');
  return {
    ...actual,
    bootstrapViaSocket: mocks.bootstrapViaSocket,
    bootstrapViaAuthRequest: mocks.bootstrapViaAuthRequest,
    generateEphemeralKeypair: mocks.generateEphemeralKeypair,
    createReadToken: mocks.createReadToken,
    decryptWithPrivateKey: mocks.decryptWithPrivateKey,
    encryptToAgentPubkey: mocks.encryptToAgentPubkey,
  };
});

import { runAgentCli } from '../../cli/commands/agent';
import { runAuthCli } from '../../cli/commands/auth';

describe('agent CLI auth behavior', () => {
  beforeEach(() => {
    mocks.bootstrapViaSocket.mockReset();
    mocks.bootstrapViaAuthRequest.mockReset();
    mocks.generateEphemeralKeypair.mockReset();
    mocks.createReadToken.mockReset();
    mocks.decryptWithPrivateKey.mockReset();
    mocks.encryptToAgentPubkey.mockReset();
    mocks.generateEphemeralKeypair.mockReturnValue({
      publicKeyPem: 'mock-public-key',
      privateKeyPem: 'mock-private-key',
      publicKeyBase64: Buffer.from('mock-public-key', 'utf8').toString('base64'),
    });
    mocks.createReadToken.mockResolvedValue('read-token');
    mocks.decryptWithPrivateKey.mockImplementation((encrypted: string) => encrypted);
    mocks.encryptToAgentPubkey.mockImplementation((value: string) => `enc(${value})`);
    delete process.env.AURA_TOKEN;
    delete process.env.AUTO_DECRYPT;
    delete process.env.AURA_AGENT_PASSWORD;
    delete process.env.AURA_MY_SECRET;
    delete process.env.AURA_GITHUB;
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AURA_TOKEN;
    delete process.env.AUTO_DECRYPT;
    delete process.env.AURA_AGENT_PASSWORD;
    delete process.env.AURA_MY_SECRET;
    delete process.env.AURA_GITHUB;
    delete process.env.WALLET_DATA_DIR;
  });

  it('prints explicit unlock guidance when socket auth reports locked agent', async () => {
    mocks.bootstrapViaSocket.mockRejectedValueOnce(new Error('Auth error: Wallet is locked. Unlock first.'));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await runAgentCli(['list']);

    expect(exitCode).toBe(1);
    expect(mocks.bootstrapViaAuthRequest).not.toHaveBeenCalled();
    const messages = errorSpy.mock.calls.map((args) => String(args[0]));
    expect(messages).toContain('\nAgent is locked (agent command).');
    expect(messages.some((line) => line.includes('auramaxx unlock'))).toBe(true);
  });

  it('tries socket before profile-based auth even with --profile', async () => {
    mocks.bootstrapViaSocket.mockResolvedValueOnce('socket-token');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname === '/credentials') {
        return new Response(JSON.stringify({ credentials: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch path: ${url.pathname}`);
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await runAgentCli(['list', '--profile', 'dev']);

    expect(exitCode).toBe(0);
    expect(mocks.bootstrapViaSocket).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapViaAuthRequest).not.toHaveBeenCalled();
  });

  it('falls back to profile-based noWait auth when socket fails with --profile', async () => {
    mocks.bootstrapViaSocket.mockRejectedValueOnce(new Error('connect ENOENT /tmp/aura-cli.sock'));
    mocks.bootstrapViaAuthRequest.mockResolvedValueOnce('profile-token');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });

    try {
      await runAgentCli(['list', '--profile', 'dev']);
    } catch {
      // process.exit mock throws
    }

    expect(mocks.bootstrapViaSocket).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapViaAuthRequest).toHaveBeenCalledTimes(1);
    // Should pass profile through and use noWait mode
    const authCall = mocks.bootstrapViaAuthRequest.mock.calls[0];
    expect(authCall[3]).toMatchObject({ profile: 'dev', noWait: true });
    // Should print approve URL guidance before exit
    const messages = errorSpy.mock.calls.map((args) => String(args[0]));
    expect(messages.some((line) => line.includes('approve') || line.includes('AURA_TOKEN'))).toBe(true);
    exitSpy.mockRestore();
  });

  it('inject with --profile tries socket first', async () => {
    mocks.bootstrapViaSocket.mockResolvedValueOnce('socket-token');
    mocks.createReadToken.mockResolvedValueOnce('read-token');
    mocks.decryptWithPrivateKey.mockImplementation((v: string) => v);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'MY_SECRET') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-1',
            name: 'MY_SECRET',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-1/read' && method === 'POST') {
        return new Response(JSON.stringify({
          encrypted: JSON.stringify({
            id: 'cred-1',
            agentId: 'primary',
            type: 'note',
            fields: [{ key: 'value', value: 'secret-val', sensitive: true }],
          }),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await runAgentCli(['inject', 'MY_SECRET', '--env', 'MY_VAR', '--profile', 'dev']);

    expect(exitCode).toBe(0);
    expect(mocks.bootstrapViaSocket).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapViaAuthRequest).not.toHaveBeenCalled();
  });

  it('inject honors --field by requesting and injecting that exact field', async () => {
    mocks.bootstrapViaSocket.mockResolvedValueOnce('socket-token');
    mocks.createReadToken.mockResolvedValueOnce('read-token');
    mocks.decryptWithPrivateKey.mockImplementation((v: string) => v);

    const readRequestBodies: Array<{ requestedFields?: string[] }> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'visa_7890') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-card',
            name: 'visa_7890',
            type: 'card',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-card/read' && method === 'POST') {
        if (typeof init?.body === 'string') {
          readRequestBodies.push(JSON.parse(init.body) as { requestedFields?: string[] });
        } else {
          readRequestBodies.push({});
        }
        return new Response(JSON.stringify({
          encrypted: JSON.stringify({
            id: 'cred-card',
            agentId: 'primary',
            type: 'card',
            fields: [
              { key: 'number', value: '1234567890', sensitive: true },
              { key: 'cvv', value: '123', sensitive: true },
            ],
          }),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const exitCode = await runAgentCli([
      'inject',
      'visa_7890',
      '--field',
      'cvv',
      '--env',
      'VISA_CVV',
      '--',
      'node',
      '-e',
      "process.exit(process.env.VISA_CVV === '123' ? 0 : 9)",
    ]);

    expect(exitCode).toBe(0);
    expect(readRequestBodies).toHaveLength(1);
    expect(readRequestBodies[0]?.requestedFields).toEqual(['cvv']);
  });

  it('list supports --agent filter by name or id', async () => {
    mocks.bootstrapViaSocket.mockResolvedValue('socket-token');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [
            { id: 'cred-1', name: 'alpha', type: 'note', agentId: 'primary', meta: {} },
            { id: 'cred-2', name: 'beta', type: 'note', agentId: 'agent-2', meta: {} },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [
            { id: 'primary', name: 'primary', isPrimary: true },
            { id: 'agent-2', name: 'secondary' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const byNameExitCode = await runAgentCli(['list', '--agent', 'primary']);
    expect(byNameExitCode).toBe(0);
    expect(logSpy.mock.calls.map((args) => String(args[0]))).toEqual(['alpha  (note)']);

    logSpy.mockClear();

    const byIdExitCode = await runAgentCli(['list', '--agent', 'agent-2']);
    expect(byIdExitCode).toBe(0);
    expect(logSpy.mock.calls.map((args) => String(args[0]))).toEqual(['beta  (note)']);
  });

  it('get with socket auth injects into env and prints SECRET DECRYPTED banner', async () => {
    mocks.bootstrapViaSocket.mockResolvedValueOnce('socket-token');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'my secret') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-1',
            name: 'my secret',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-1/read' && method === 'POST') {
        return new Response(JSON.stringify({
          encrypted: JSON.stringify({
            id: 'cred-1',
            agentId: 'primary',
            type: 'note',
            fields: [{ key: 'value', value: 'super-secret', sensitive: true }],
          }),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await runAgentCli(['get', 'my secret']);

    expect(exitCode).toBe(0);
    expect(process.env.AURA_MY_SECRET).toBe('super-secret');
    const output = logSpy.mock.calls.map((args) => String(args[0])).join('\n');
    expect(output).toContain('SECRET DECRYPTED');
    expect(output).toContain('AURA_MY_SECRET');
    expect(output).toContain('WORKING_WITH_SECRETS.md');
    expect(output).toContain('*******');
    expect(output).toContain('WHATDO');
    expect(output).toContain('Saved to env variable AURA_MY_SECRET.');
    expect(output).toContain("Scope: current CLI process only. Use '-- <command>' to inject into a child command.");
  });

  it('get with --danger-plaintext prints secret in socket banner output', async () => {
    mocks.bootstrapViaSocket.mockResolvedValueOnce('socket-token');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'my secret') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-1',
            name: 'my secret',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-1/read' && method === 'POST') {
        return new Response(JSON.stringify({
          encrypted: JSON.stringify({
            id: 'cred-1',
            agentId: 'primary',
            type: 'note',
            fields: [{ key: 'value', value: 'super-secret', sensitive: true }],
          }),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await runAgentCli(['get', 'my secret', '--danger-plaintext']);

    expect(exitCode).toBe(0);
    const output = logSpy.mock.calls.map((args) => String(args[0])).join('\n');
    expect(output).toContain('super-secret');
    expect(output).not.toContain('*******');
  });

  it('get supports command injection via -- <command>', async () => {
    mocks.bootstrapViaSocket.mockResolvedValueOnce('socket-token');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'my secret') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-1',
            name: 'my secret',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-1/read' && method === 'POST') {
        return new Response(JSON.stringify({
          encrypted: JSON.stringify({
            id: 'cred-1',
            agentId: 'primary',
            type: 'note',
            fields: [{ key: 'value', value: 'super-secret', sensitive: true }],
          }),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const exitCode = await runAgentCli([
      'get',
      'my secret',
      '--',
      'node',
      '-e',
      "process.exit(process.env.AURA_MY_SECRET === 'super-secret' ? 0 : 3)",
    ]);

    expect(exitCode).toBe(0);
    expect(process.env.AURA_MY_SECRET).toBeUndefined();
  });

  it('get with env token keeps non-socket output behavior and does not auto-inject', async () => {
    process.env.AURA_TOKEN = 'env-token';
    process.env.AUTO_DECRYPT = 'true';
    process.env.AURA_AGENT_PASSWORD = 'pw';

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'github') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-github',
            name: 'github',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-github/read' && method === 'POST') {
        return new Response(JSON.stringify({
          encrypted: JSON.stringify({
            id: 'cred-github',
            agentId: 'primary',
            type: 'note',
            fields: [{ key: 'value', value: 'gh-secret', sensitive: true }],
          }),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await runAgentCli(['get', 'github']);

    expect(exitCode).toBe(0);
    expect(process.env.AURA_GITHUB).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith('gh-secret');
    expect(logSpy).not.toHaveBeenCalledWith('Secret Decrypted: AURA_GITHUB');
    expect(mocks.bootstrapViaSocket).not.toHaveBeenCalled();
  });

  it('one-shot claimed token should allow one retry with --reqId, then fail deterministically on replay', async () => {
    process.env.AURA_TOKEN = 'env-token';
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));
    putClaimedToken({
      reqId: 'req-once',
      token: 'one-shot-token',
      approvalScope: 'one_shot_read',
      ttlSeconds: 120,
      credentialId: 'cred-github',
      credentialName: 'github',
    });

    let readCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'github') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-github',
            name: 'github',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-github/read' && method === 'POST') {
        readCalls += 1;
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer one-shot-token');
        return new Response(JSON.stringify({
          encrypted: JSON.stringify({
            id: 'cred-github',
            agentId: 'primary',
            type: 'note',
            fields: [{ key: 'value', value: 'gh-secret', sensitive: true }],
          }),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const firstExit = await runAgentCli(['get', 'github', '--reqId', 'req-once']);
    expect(firstExit).toBe(0);
    expect(logSpy).toHaveBeenCalledWith('enc(gh-secret)');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secondExit = await runAgentCli(['get', 'github', '--reqId', 'req-once']);
    expect(secondExit).toBe(1);
    const replayPayload = JSON.parse(String(errorSpy.mock.calls[0][0])) as { errorCode?: string; claimStatus?: string };
    expect(replayPayload.errorCode).toBe('missing_or_expired_claim');
    expect(replayPayload.claimStatus).toBe('expired');
    expect(readCalls).toBe(1);
    expect(fetchSpy.mock.calls.some(([input]) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      return url.pathname === '/credentials/cred-github/read';
    })).toBe(true);
  });

  it('admin session claim should allow sensitive read with --reqId, then again without reqId', async () => {
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));

    let requestedProfile: string | undefined;
    const readAuthHeaders: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/auth' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as { profile?: string };
        requestedProfile = body.profile;
        return new Response(JSON.stringify({
          success: true,
          requestId: 'req-admin-cli',
          secret: 'sec-admin-cli',
          approveUrl: 'http://localhost:4747/approve/req-admin-cli',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/auth/req-admin-cli' && method === 'GET' && hasClaimSecret(init, 'sec-admin-cli')) {
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: 'session-admin-token',
          ttl: 120,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/auth/validate' && method === 'POST') {
        return new Response(JSON.stringify({ valid: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'github') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-github',
            name: 'github',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-github/read' && method === 'POST') {
        const headers = init?.headers as Record<string, string>;
        readAuthHeaders.push(headers.Authorization);
        return new Response(JSON.stringify({
          encrypted: JSON.stringify({
            id: 'cred-github',
            agentId: 'primary',
            type: 'note',
            fields: [{ key: 'value', value: 'gh-admin-secret', sensitive: true }],
          }),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const requestExit = await runAuthCli(['request', '--profile', 'admin', '--json']);
    expect(requestExit).toBe(0);
    expect(requestedProfile).toBe('admin');

    const claimExit = await runAuthCli(['claim', 'req-admin-cli', '--json']);
    expect(claimExit).toBe(0);

    process.env.AURA_TOKEN = 'session-admin-token';
    const firstReadExit = await runAgentCli(['get', 'github', '--reqId', 'req-admin-cli']);
    expect(firstReadExit).toBe(0);

    const secondReadExit = await runAgentCli(['get', 'github']);
    expect(secondReadExit).toBe(0);

    expect(logSpy).toHaveBeenCalledWith('enc(gh-admin-secret)');
    expect(readAuthHeaders).toEqual(['Bearer session-admin-token', 'Bearer read-token']);
  });

  it('e2e CLI flow: approval-required get -> auth claim -> reqId retry -> replay fail', async () => {
    process.env.AURA_TOKEN = 'env-token';
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));

    const reqId = 'req-e2e-cli-claim';
    const secret = 'req-e2e-cli-secret';
    let oneShotReads = 0;
    let originalCommandHeader = '';

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'github') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-github',
            name: 'github',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-github/read' && method === 'POST') {
        const headers = init?.headers as Record<string, string>;
        if (headers.Authorization === 'Bearer read-token') {
          originalCommandHeader = headers['X-Aura-Original-Command'] || headers['x-aura-original-command'] || '';
          return new Response(JSON.stringify({
            contractVersion: 'v1',
            error: 'Excluded credential fields require human approval',
            status: 403,
            requiresHumanApproval: true,
            reqId,
            secret,
            approveUrl: `http://localhost:4747/approve/${reqId}`,
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
        if (headers.Authorization === 'Bearer one-shot-token') {
          oneShotReads += 1;
          return new Response(JSON.stringify({
            encrypted: JSON.stringify({
              id: 'cred-github',
              agentId: 'primary',
              type: 'note',
              fields: [{ key: 'value', value: 'gh-secret', sensitive: true }],
            }),
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === `/auth/${reqId}` && method === 'GET') {
        if (!hasClaimSecret(init, secret)) {
          return new Response(JSON.stringify({ success: false, status: 'pending' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: 'one-shot-token',
          ttl: 60,
          retryCommand: `npx auramaxx get github --json --reqId ${reqId}`,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const runWithCapture = async (runner: () => Promise<number>) => {
      const logs: string[] = [];
      const errors: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
        logs.push(values.map(String).join(' '));
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
        errors.push(values.map(String).join(' '));
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${String(code ?? '')}`);
      }) as any);
      let exitCode = 0;
      try {
        exitCode = await runner();
      } catch (error) {
        const match = String(error).match(/process\.exit:(\d+)/);
        if (match) {
          exitCode = Number(match[1]);
        } else {
          throw error;
        }
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        exitSpy.mockRestore();
      }
      return { exitCode, logs, errors };
    };

    const readJsonPayload = (captured: { logs: string[]; errors: string[] }): Record<string, unknown> => {
      const line = [...captured.errors, ...captured.logs].find((entry) => entry.trim().startsWith('{'));
      if (!line) throw new Error('Expected JSON payload from CLI command');
      return JSON.parse(line) as Record<string, unknown>;
    };

    const denied = await runWithCapture(() => runAgentCli(['get', 'github', '--json']));
    expect(denied.exitCode).toBe(1);
    const deniedPayload = readJsonPayload(denied);
    expect(deniedPayload.requiresHumanApproval).toBe(true);
    expect(deniedPayload.reqId).toBe(reqId);

    const claimed = await runWithCapture(() => runAuthCli(['claim', reqId, '--json']));
    expect(claimed.exitCode).toBe(0);
    const claimPayload = readJsonPayload(claimed);
    expect(claimPayload.claimStatus).toBe('approved');
    expect(claimPayload.retryReady).toBe(true);
    expect(claimPayload.retryCommand).toBe(`npx auramaxx get github --json --reqId ${reqId}`);
    expect(originalCommandHeader).toBe('npx auramaxx get github --json');

    const retried = await runWithCapture(() => runAgentCli(['get', 'github', '--reqId', reqId, '--json']));
    expect(retried.exitCode).toBe(0);
    const retryPayload = readJsonPayload(retried) as {
      fields?: Array<{ key?: string; value?: string }>;
    };
    expect(Array.isArray(retryPayload.fields)).toBe(true);
    expect(retryPayload.fields?.some((field) => field.key === 'value' && String(field.value || '').includes('gh-secret'))).toBe(true);

    const replay = await runWithCapture(() => runAgentCli(['get', 'github', '--reqId', reqId, '--json']));
    expect(replay.exitCode).toBe(1);
    const replayPayload = readJsonPayload(replay);
    expect(replayPayload.errorCode).toBe('missing_or_expired_claim');
    expect(oneShotReads).toBe(1);
  });

  it('get with explicit --reqId returns deterministic missing_or_expired_claim when no claim is bound (even with a session token)', async () => {
    process.env.AURA_TOKEN = 'env-token';
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'github') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-github',
            name: 'github',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await runAgentCli(['get', 'github', '--reqId', 'req-missing']);

    expect(exitCode).toBe(1);
    const payload = JSON.parse(String(errorSpy.mock.calls[0][0])) as {
      reqId?: string;
      errorCode?: string;
      claimStatus?: string;
      retryReady?: boolean;
    };
    expect(payload.reqId).toBe('req-missing');
    expect(payload.errorCode).toBe('missing_or_expired_claim');
    expect(payload.claimStatus).toBe('expired');
    expect(payload.retryReady).toBe(false);
    expect(fetchSpy.mock.calls.some(([input]) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      return url.pathname.includes('/credentials/cred-github/read');
    })).toBe(false);
  });

  it('get with --reqId surfaces deterministic operation_binding_mismatch from server', async () => {
    process.env.AURA_TOKEN = 'env-token';
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));
    putClaimedToken({
      reqId: 'req-bind-cli',
      token: 'one-shot-token',
      approvalScope: 'one_shot_read',
      ttlSeconds: 120,
      credentialId: 'cred-github',
      credentialName: 'github',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'github') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-github',
            name: 'github',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-github/read' && method === 'POST') {
        return new Response(JSON.stringify({
          contractVersion: 'v1',
          success: false,
          errorCode: 'operation_binding_mismatch',
          error: 'Claimed token is bound to POST credentials.read; this retry does not match the bound operation.',
          reqId: 'req-bind-cli',
          approvalScope: 'one_shot_read',
          claimStatus: 'approved',
          retryReady: false,
          policyHash: 'pol-cli',
          compilerVersion: 'v1',
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await runAgentCli(['get', 'github', '--reqId', 'req-bind-cli']);
    expect(exitCode).toBe(1);
    const payload = JSON.parse(String(errorSpy.mock.calls[0][0])) as {
      errorCode?: string;
      reqId?: string;
      policyHash?: string;
      compilerVersion?: string;
      claimStatus?: string;
    };
    expect(payload.errorCode).toBe('operation_binding_mismatch');
    expect(payload.reqId).toBe('req-bind-cli');
    expect(payload.policyHash).toBe('pol-cli');
    expect(payload.compilerVersion).toBe('v1');
    expect(payload.claimStatus).toBe('approved');
  });

  it('get surfaces deterministic policy compiler errors (400) from server', async () => {
    process.env.AURA_TOKEN = 'env-token';
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'github') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-github',
            name: 'github',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-github/read' && method === 'POST') {
        return new Response(JSON.stringify({
          contractVersion: 'v1',
          success: false,
          errorCode: 'client_policy_not_allowed_for_derived_source',
          error: 'requestedPolicy is not allowed when requestedPolicySource=derived_403',
          requestedPolicySource: 'derived_403',
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await runAgentCli(['get', 'github']);
    expect(exitCode).toBe(1);
    const payload = JSON.parse(String(errorSpy.mock.calls[0][0])) as {
      errorCode?: string;
      requestedPolicySource?: string;
    };
    expect(payload.errorCode).toBe('client_policy_not_allowed_for_derived_source');
    expect(payload.requestedPolicySource).toBe('derived_403');
  });

  it('waitForAuthDecision fails fast on polling 5xx responses', async () => {
    let pollCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';
      if (url.pathname === '/auth/req-poll-500' && method === 'GET' && hasClaimSecret(init, 'sec-poll-500')) {
        pollCalls += 1;
        return new Response(JSON.stringify({ error: 'upstream unavailable' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    await expect(waitForAuthDecision(
      'http://localhost:4242',
      'req-poll-500',
      'sec-poll-500',
      { timeoutMs: 60_000, intervalMs: 1 },
    )).rejects.toThrow('server error');
    expect(pollCalls).toBe(1);
  });

  it('waitForAuthDecision fails fast on non-retryable 4xx responses', async () => {
    let pollCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';
      if (url.pathname === '/auth/req-poll-400' && method === 'GET' && hasClaimSecret(init, 'sec-poll-400')) {
        pollCalls += 1;
        return new Response(JSON.stringify({ error: 'bad request' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    await expect(waitForAuthDecision(
      'http://localhost:4242',
      'req-poll-400',
      'sec-poll-400',
      { timeoutMs: 60_000, intervalMs: 1 },
    )).rejects.toThrow('non-retryable client error');
    expect(pollCalls).toBe(1);
  });

  it('auth claim auto-retries pending responses until approved', async () => {
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));
    putApprovalContext({
      reqId: 'req-auto-retry',
      secret: 'sec-auto-retry',
      privateKeyPem: 'mock-private-key',
      approvalScope: 'session_token',
      ttlSeconds: 300,
      retryCommandTemplate: 'npx auramaxx agent get "github" --reqId <reqId>',
    });

    let pollCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';
      if (url.pathname === '/auth/req-auto-retry' && method === 'GET' && hasClaimSecret(init, 'sec-auto-retry')) {
        pollCalls += 1;
        if (pollCalls < 3) {
          return new Response(JSON.stringify({ success: true, status: 'pending' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: 'session-auto-token',
          ttl: 60,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await runAuthCli([
      'claim',
      'req-auto-retry',
      '--pending-retries',
      '4',
      '--pending-retry-interval-ms',
      '1',
      '--json',
    ]);
    expect(exitCode).toBe(0);

    const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as {
      claimStatus?: string;
      retryReady?: boolean;
      claimPollAttempts?: number;
      pendingRetriesUsed?: number;
      token?: string;
      tokenPreview?: string;
    };
    expect(payload.claimStatus).toBe('approved');
    expect(payload.retryReady).toBe(true);
    expect(payload.claimPollAttempts).toBe(3);
    expect(payload.pendingRetriesUsed).toBe(2);
    expect(payload.token).toBeUndefined();
    expect(payload.tokenPreview).toBe('session-auto-token');
    expect(pollCalls).toBe(3);
    expect(getApprovalContext('req-auto-retry')).toBeNull();
  });

  it('auth claim allows disabling pending auto-retry', async () => {
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));
    putApprovalContext({
      reqId: 'req-no-retry',
      secret: 'sec-no-retry',
      privateKeyPem: 'mock-private-key',
      approvalScope: 'session_token',
      ttlSeconds: 300,
      retryCommandTemplate: 'npx auramaxx agent get "github" --reqId <reqId>',
    });

    let pollCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';
      if (url.pathname === '/auth/req-no-retry' && method === 'GET' && hasClaimSecret(init, 'sec-no-retry')) {
        pollCalls += 1;
        return new Response(JSON.stringify({ success: true, status: 'pending' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await runAuthCli(['claim', 'req-no-retry', '--pending-retries', '0', '--json']);
    expect(exitCode).toBe(0);

    const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as {
      claimStatus?: string;
      retryReady?: boolean;
      claimPollAttempts?: number;
      pendingRetriesUsed?: number;
    };
    expect(payload.claimStatus).toBe('pending');
    expect(payload.retryReady).toBe(false);
    expect(payload.claimPollAttempts).toBe(1);
    expect(payload.pendingRetriesUsed).toBe(0);
    expect(pollCalls).toBe(1);
    expect(getApprovalContext('req-no-retry')).not.toBeNull();
  });

  it('auth claim surfaces server errors without reporting pending success', async () => {
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));
    putApprovalContext({
      reqId: 'req-server-error',
      secret: 'sec-server-error',
      privateKeyPem: 'mock-private-key',
      approvalScope: 'session_token',
      ttlSeconds: 300,
      retryCommandTemplate: 'npx auramaxx agent get "github" --reqId <reqId>',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';
      if (url.pathname === '/auth/req-server-error' && method === 'GET' && hasClaimSecret(init, 'sec-server-error')) {
        return new Response(JSON.stringify({ error: 'upstream unavailable' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await runAuthCli(['claim', 'req-server-error', '--json']);
    expect(exitCode).toBe(1);

    const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as {
      success?: boolean;
      claimStatus?: string;
      errorCode?: string;
      retryReady?: boolean;
      note?: string;
    };
    expect(payload.success).toBe(false);
    expect(payload.claimStatus).toBe('pending');
    expect(payload.errorCode).toBe('claim_server_error');
    expect(payload.retryReady).toBe(false);
    expect(payload.note).toContain('transient');
    expect(getApprovalContext('req-server-error')).not.toBeNull();
  });

  it('auth claim maps 403 to claim_invalid_secret and keeps context', async () => {
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));
    putApprovalContext({
      reqId: 'req-rejected',
      secret: 'sec-rejected',
      privateKeyPem: 'mock-private-key',
      approvalScope: 'session_token',
      ttlSeconds: 300,
      retryCommandTemplate: 'npx auramaxx agent get "github" --reqId <reqId>',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';
      if (url.pathname === '/auth/req-rejected' && method === 'GET' && hasClaimSecret(init, 'sec-rejected')) {
        return new Response('rejected', { status: 403 });
      }
      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await runAuthCli(['claim', 'req-rejected', '--json']);
    expect(exitCode).toBe(1);

    const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as {
      claimStatus?: string;
      errorCode?: string;
      retryReady?: boolean;
      note?: string;
    };
    expect(payload.claimStatus).toBe('expired');
    expect(payload.errorCode).toBe('claim_invalid_secret');
    expect(payload.retryReady).toBe(false);
    expect(payload.note).toContain('Stored approval context was kept');
    expect(getApprovalContext('req-rejected')).not.toBeNull();
  });

  it('auth claim maps 200 rejected status to claim_rejected and clears context', async () => {
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));
    putApprovalContext({
      reqId: 'req-rejected-status',
      secret: 'sec-rejected-status',
      privateKeyPem: 'mock-private-key',
      approvalScope: 'session_token',
      ttlSeconds: 300,
      retryCommandTemplate: 'npx auramaxx agent get "github" --reqId <reqId>',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';
      if (url.pathname === '/auth/req-rejected-status' && method === 'GET' && hasClaimSecret(init, 'sec-rejected-status')) {
        return new Response(JSON.stringify({ success: true, status: 'rejected' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await runAuthCli(['claim', 'req-rejected-status', '--json']);
    expect(exitCode).toBe(1);

    const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as {
      claimStatus?: string;
      errorCode?: string;
      retryReady?: boolean;
    };
    expect(payload.claimStatus).toBe('rejected');
    expect(payload.errorCode).toBe('claim_rejected');
    expect(payload.retryReady).toBe(false);
    expect(getApprovalContext('req-rejected-status')).toBeNull();
  });

  it('auth request --help exits without creating an auth request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not run for --help');
    });

    const exitCode = await runAuthCli(['request', '--help']);
    expect(exitCode).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('auth claim --help exits without polling claim endpoints', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not run for --help');
    });

    const exitCode = await runAuthCli(['claim', '--help']);
    expect(exitCode).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('auth claim maps 410 to expired deterministically', async () => {
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));
    putApprovalContext({
      reqId: 'req-expired',
      secret: 'sec-expired',
      privateKeyPem: 'mock-private-key',
      approvalScope: 'session_token',
      ttlSeconds: 300,
      retryCommandTemplate: 'npx auramaxx agent get "github" --reqId <reqId>',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';
      if (url.pathname === '/auth/req-expired' && method === 'GET' && hasClaimSecret(init, 'sec-expired')) {
        return new Response('expired', { status: 410 });
      }
      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await runAuthCli(['claim', 'req-expired', '--json']);
    expect(exitCode).toBe(1);

    const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as {
      claimStatus?: string;
      errorCode?: string;
      retryReady?: boolean;
    };
    expect(payload.claimStatus).toBe('expired');
    expect(payload.errorCode).toBe('missing_or_expired_claim');
    expect(payload.retryReady).toBe(false);
  });

  it('expired one-shot reqId fails deterministically and does not continue to read', async () => {
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));
    process.env.AURA_TOKEN = 'env-token';
    putClaimedToken({
      reqId: 'req-expired-oneshot',
      token: 'claimed-one-shot',
      approvalScope: 'one_shot_read',
      ttlSeconds: 120,
      credentialId: 'cred-github',
      credentialName: 'github',
    });

    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 121_000);
    let readCalls = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'github') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-github',
            name: 'github',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-github/read' && method === 'POST') {
        readCalls += 1;
        return new Response(JSON.stringify({ error: 'should-not-read' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitCode = await runAgentCli(['get', 'github', '--reqId', 'req-expired-oneshot']);
    expect(exitCode).toBe(1);
    const payload = JSON.parse(String(errorSpy.mock.calls[0][0])) as {
      errorCode?: string;
      claimStatus?: string;
    };
    expect(payload.errorCode).toBe('missing_or_expired_claim');
    expect(payload.claimStatus).toBe('expired');
    expect(readCalls).toBe(0);
    expect(fetchSpy.mock.calls.some(([input]) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      return url.pathname === '/credentials/cred-github/read';
    })).toBe(false);
    nowSpy.mockRestore();
  });

  it('still falls back to /auth for non-lock socket failures', async () => {
    mocks.bootstrapViaSocket.mockRejectedValueOnce(new Error('Cannot connect to AuraMaxx: connect ENOENT /tmp/aura-cli.sock'));
    mocks.bootstrapViaAuthRequest.mockResolvedValueOnce('fallback-token');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname === '/credentials') {
        return new Response(JSON.stringify({ credentials: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch path: ${url.pathname}`);
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await runAgentCli(['list']);

    expect(exitCode).toBe(0);
    expect(mocks.bootstrapViaAuthRequest).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('No credentials found.');
  });

  it('ignores stored session token and uses /auth fallback when socket bootstrap fails', async () => {
    process.env.WALLET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auramaxx-agent-auth-'));
    putActiveSessionToken({
      token: 'stored-session-token',
      privateKeyPem: 'mock-private-key',
      ttlSeconds: 120,
    });
    mocks.bootstrapViaSocket.mockRejectedValueOnce(new Error('Cannot connect to AuraMaxx: connect ENOENT /tmp/aura-cli.sock'));
    mocks.bootstrapViaAuthRequest.mockResolvedValueOnce('fallback-token');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET') {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer fallback-token');
        return new Response(JSON.stringify({ credentials: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await runAgentCli(['list']);

    expect(exitCode).toBe(0);
    expect(mocks.bootstrapViaSocket).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapViaAuthRequest).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/auth/validate'))).toBe(false);
    expect(logSpy).toHaveBeenCalledWith('No credentials found.');
  });

  it('uses delegated read key for /auth fallback tokens when read token issuance succeeds', async () => {
    mocks.bootstrapViaSocket.mockRejectedValueOnce(new Error('Cannot connect to AuraMaxx: connect ENOENT /tmp/aura-cli.sock'));
    mocks.bootstrapViaAuthRequest.mockResolvedValueOnce('fallback-auth-token');
    mocks.generateEphemeralKeypair.mockReturnValueOnce({
      publicKeyPem: 'ephemeral-public-key',
      privateKeyPem: 'ephemeral-private-key',
      publicKeyBase64: Buffer.from('ephemeral-public-key', 'utf8').toString('base64'),
    });
    mocks.createReadToken.mockResolvedValueOnce('delegated-read-token');
    mocks.decryptWithPrivateKey.mockImplementation((encrypted: string, privateKeyPem: string) => {
      expect(privateKeyPem).toBe('ephemeral-private-key');
      return encrypted;
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'github') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-github',
            name: 'github',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-github/read' && method === 'POST') {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer delegated-read-token');
        return new Response(JSON.stringify({
          encrypted: JSON.stringify({
            id: 'cred-github',
            agentId: 'primary',
            type: 'note',
            fields: [{ key: 'value', value: 'gh-secret', sensitive: true }],
          }),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await runAgentCli(['get', 'github']);

    expect(exitCode).toBe(0);
    expect(mocks.createReadToken).toHaveBeenCalledTimes(1);
    expect(mocks.createReadToken.mock.calls[0]?.[1]).toBe('fallback-auth-token');
    expect(logSpy).toHaveBeenCalledWith('enc(gh-secret)');
  });

  it('skips delegated read token mint when fallback token is parseable non-admin', async () => {
    const nonAdminToken = makeTestAgentToken(['secret:read']);
    mocks.bootstrapViaSocket.mockRejectedValueOnce(new Error('Cannot connect to AuraMaxx: connect ENOENT /tmp/aura-cli.sock'));
    mocks.bootstrapViaAuthRequest.mockResolvedValueOnce(nonAdminToken);
    mocks.generateEphemeralKeypair.mockReturnValueOnce({
      publicKeyPem: 'ephemeral-public-key',
      privateKeyPem: 'ephemeral-private-key',
      publicKeyBase64: Buffer.from('ephemeral-public-key', 'utf8').toString('base64'),
    });
    mocks.decryptWithPrivateKey.mockImplementation((encrypted: string, privateKeyPem: string) => {
      expect(privateKeyPem).toBe('ephemeral-private-key');
      return encrypted;
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';

      if (url.pathname === '/credentials' && method === 'GET' && url.searchParams.get('q') === 'github') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-github',
            name: 'github',
            type: 'note',
            agentId: 'primary',
            meta: {},
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup/agents' && method === 'GET') {
        return new Response(JSON.stringify({
          agents: [{ id: 'primary', name: 'primary', isPrimary: true }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/setup' && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/credentials/cred-github/read' && method === 'POST') {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe(`Bearer ${nonAdminToken}`);
        return new Response(JSON.stringify({
          encrypted: JSON.stringify({
            id: 'cred-github',
            agentId: 'primary',
            type: 'note',
            fields: [{ key: 'value', value: 'gh-secret', sensitive: true }],
          }),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await runAgentCli(['get', 'github']);

    expect(exitCode).toBe(0);
    expect(mocks.createReadToken).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('enc(gh-secret)');
  });
});
