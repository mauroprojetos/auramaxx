import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runActionsCli } from '../../cli/commands/actions';

function getHeader(headersInit: HeadersInit | undefined, name: string): string | null {
  if (!headersInit) return null;
  return new Headers(headersInit).get(name);
}

describe('actions CLI auth behavior', () => {
  beforeEach(() => {
    delete process.env.AURA_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AURA_TOKEN;
  });

  it('admin token can create and resolve its own action request', async () => {
    process.env.AURA_TOKEN = 'admin-token';

    const authHeaders: string[] = [];
    let createBody: Record<string, unknown> | undefined;
    let resolveBody: Record<string, unknown> | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method || 'GET';
      const auth = getHeader(init?.headers, 'Authorization');
      if (auth) authHeaders.push(auth);

      if (url.pathname === '/actions' && method === 'POST') {
        createBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        return new Response(JSON.stringify({
          success: true,
          requestId: 'act-self',
          secret: 'sec-self',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url.pathname === '/actions/act-self/resolve' && method === 'POST') {
        resolveBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        return new Response(JSON.stringify({
          success: true,
          resolved: true,
          requestId: 'act-self',
          status: 'approved',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      throw new Error(`Unexpected fetch path: ${method} ${url.pathname}${url.search}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const createExitCode = await runActionsCli([
      'create',
      '--summary', 'Self approve',
      '--permissions', 'secret:read',
      '--no-wait',
      '--json',
    ]);
    expect(createExitCode).toBe(0);

    const resolveExitCode = await runActionsCli([
      'resolve',
      'act-self',
      '--approve',
      '--json',
    ]);
    expect(resolveExitCode).toBe(0);

    expect(authHeaders).toEqual(['Bearer admin-token', 'Bearer admin-token']);
    expect(createBody).toMatchObject({
      summary: 'Self approve',
      permissions: ['secret:read'],
    });
    expect(resolveBody).toMatchObject({ approved: true });

    const outputs = logSpy.mock.calls.map((args) => String(args[0]));
    const createOutput = JSON.parse(outputs[0]) as { requestId?: string; status?: string };
    const resolveOutput = JSON.parse(outputs[1]) as { requestId?: string; status?: string };
    expect(createOutput).toMatchObject({ requestId: 'act-self', status: 'pending' });
    expect(resolveOutput).toMatchObject({ requestId: 'act-self', status: 'approved' });
  });
});
