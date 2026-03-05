import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bootstrapViaSocket: vi.fn(async () => 'test-admin-token'),
  generateEphemeralKeypair: vi.fn(() => ({
    publicKeyPem: 'mock-public-key',
    privateKeyPem: 'mock-private-key',
    publicKeyBase64: Buffer.from('mock-public-key', 'utf8').toString('base64'),
  })),
  createReadToken: vi.fn(async () => 'read-token'),
  decryptWithPrivateKey: vi.fn((encrypted: string) => encrypted),
}));

vi.mock('../../lib/credential-transport', async () => {
  const actual = await vi.importActual<typeof import('../../lib/credential-transport')>('../../lib/credential-transport');
  return {
    ...actual,
    bootstrapViaSocket: mocks.bootstrapViaSocket,
    generateEphemeralKeypair: mocks.generateEphemeralKeypair,
    createReadToken: mocks.createReadToken,
    decryptWithPrivateKey: mocks.decryptWithPrivateKey,
  };
});

import { runAgentCli } from '../../cli/commands/agent';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return new URL(input).pathname;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url).pathname;
}

describe('agent CLI list filters', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let readCalls = 0;

  beforeEach(() => {
    process.env.WALLET_SERVER_URL = 'http://wallet.test';
    process.env.AURA_TOKEN = 'test-admin-token';
    readCalls = 0;

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const path = getPath(input);
      if (path === '/credentials') {
        return jsonResponse({
          credentials: [
            { id: 'cred-1', name: 'Prod API', type: 'apikey', agentId: 'primary', meta: {} },
            { id: 'cred-2', name: 'Staging Login', type: 'login', agentId: 'primary', meta: { title: 'Admin Portal' } },
            { id: 'cred-3', name: 'Shared Notes', type: 'note', agentId: 'primary', meta: {} },
          ],
        });
      }
      if (path === '/credentials/cred-1/read') {
        readCalls += 1;
        return jsonResponse({
          encrypted: JSON.stringify({
            id: 'cred-1',
            agentId: 'primary',
            type: 'apikey',
            fields: [{ key: 'value', value: 'prod-token', sensitive: true }],
          }),
        });
      }
      if (path === '/credentials/cred-2/read') {
        readCalls += 1;
        return jsonResponse({
          encrypted: JSON.stringify({
            id: 'cred-2',
            agentId: 'primary',
            type: 'login',
            fields: [
              { key: 'username', value: 'alice@example.com', sensitive: false },
              { key: 'password', value: 'hunter2', sensitive: true },
            ],
          }),
        });
      }
      if (path === '/credentials/cred-3/read') {
        readCalls += 1;
        return jsonResponse({
          encrypted: JSON.stringify({
            id: 'cred-3',
            agentId: 'primary',
            type: 'note',
            fields: [{ key: 'content', value: 'shared mailbox rotation', sensitive: false }],
          }),
        });
      }

      return new Response(JSON.stringify({ error: `Unhandled route ${path}` }), { status: 404 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.WALLET_SERVER_URL;
    delete process.env.AURA_TOKEN;
  });

  async function runList(args: string[]): Promise<{ exitCode: number; logs: string[] }> {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
      logs.push(values.map(String).join(' '));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const exitCode = await runAgentCli(args);
      return { exitCode, logs };
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }

  it('filters list output by --name without reading credential fields', async () => {
    const result = await runList(['list', '--name', 'prod']);
    expect(result.exitCode).toBe(0);
    expect(result.logs).toEqual(['Prod API  (apikey)']);
    expect(readCalls).toBe(0);
  });

  it('allows --name matching against metadata title', async () => {
    const result = await runList(['list', '--name', 'admin']);
    expect(result.exitCode).toBe(0);
    expect(result.logs).toEqual(['Staging Login  (login)']);
    expect(readCalls).toBe(0);
  });

  it('filters list output by --field across decrypted key/value content', async () => {
    const result = await runList(['list', '--field', 'hunter2']);
    expect(result.exitCode).toBe(0);
    expect(result.logs).toEqual(['Staging Login  (login)']);
    expect(readCalls).toBe(3);
  });

  it('combines --name and --field filters with AND semantics', async () => {
    const result = await runList(['list', '--name', 'prod', '--field', 'token']);
    expect(result.exitCode).toBe(0);
    expect(result.logs).toEqual(['Prod API  (apikey)']);
    expect(readCalls).toBe(1);
  });
});
