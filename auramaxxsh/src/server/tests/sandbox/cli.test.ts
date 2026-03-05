import { spawnSync } from 'child_process';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as credentialTransport from '../../lib/credential-transport';
import { encryptToAgentPubkey } from '../../lib/credential-transport';

vi.mock('../../lib/secret-gist-share', () => {
  class MockSecretGistError extends Error {
    code: string;
    remediation: string;
    detail?: string;

    constructor(code: string, message: string, remediation: string, detail?: string) {
      super(message);
      this.name = 'SecretGistError';
      this.code = code;
      this.remediation = remediation;
      this.detail = detail;
    }
  }

  return {
    createSecretGist: vi.fn(async (input: any) => ({
      url: `https://gist.github.com/mock/${input.credentialId}`,
      marker: '||:|||:|:||||',
      identifier: 'ABC123DEF4',
      title: `AURAMAXX.SH :: ||:|||:|:|||| :: ABC123DEF4 :: ${input.credentialName}`,
      filename: 'auramaxx-sh-abc123def4.txt',
      content: `AURAMAXX.SH :: ||:|||:|:|||| :: ABC123DEF4\nSHARE_URL: ${input.shareUrl}\n`,
    })),
    SecretGistError: MockSecretGistError,
  };
});

import { runAgentCli } from '../../cli/commands/agent';
import { createSecretGist } from '../../lib/secret-gist-share';

interface MockCredential {
  id: string;
  name: string;
  type: string;
  agentId: string;
  fields: Array<{ key: string; value: string; type?: string; sensitive?: boolean }>;
}

function jsonResponse(payload: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function readJsonBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (!body) return {};
  if (typeof body !== 'string') return {};
  return JSON.parse(body) as Record<string, unknown>;
}

function readRequestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return new URL(input).pathname;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url).pathname;
}

function readAuthHeader(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get('Authorization');
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === 'authorization') return value;
    }
    return null;
  }
  const record = headers as Record<string, string>;
  return record.Authorization || record.authorization || null;
}

describe('sandbox CLI CD lane', () => {
  const projectRoot = path.resolve(__dirname, '../../../..');
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let credentials: MockCredential[] = [];
  let nextCredentialId = 3;
  let readTokenPubkey: string | null = null;

  beforeEach(() => {
    vi.spyOn(credentialTransport, 'bootstrapViaSocket').mockRejectedValue(
      new Error('connect ENOENT /tmp/aura-cli-501.sock'),
    );

    vi.mocked(createSecretGist).mockResolvedValue({
      url: 'https://gist.github.com/mock/default',
      marker: '||:|||:|:||||',
      identifier: 'ABC123DEF4',
      title: 'AURAMAXX.SH :: ||:|||:|:|||| :: ABC123DEF4 :: Shared Login',
      filename: 'auramaxx-sh-abc123def4.txt',
      content: 'AURAMAXX.SH :: ||:|||:|:|||| :: ABC123DEF4\n',
    });

    credentials = [
      {
        id: 'cred-1',
        name: 'AURAMAXX',
        type: 'api',
        agentId: 'agent-primary',
        fields: [{ key: 'value', value: 'alpha-123', sensitive: true }],
      },
      {
        id: 'cred-2',
        name: 'ANOTHER_SECRET',
        type: 'login',
        agentId: 'agent-primary',
        fields: [{ key: 'password', value: 'beta-456', sensitive: true }],
      },
    ];
    nextCredentialId = 3;
    readTokenPubkey = null;

    process.env.WALLET_SERVER_URL = 'http://wallet.test';
    process.env.AURA_TOKEN = 'test-admin-token';
    process.env.AUTO_DECRYPT = 'true';
    process.env.AURA_AGENT_PASSWORD = 'test-password';

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const method = (init?.method || 'GET').toUpperCase();
      const authHeader = readAuthHeader(init?.headers);

      const requiresAuth = !(url.pathname === '/setup' || url.pathname === '/setup/agents');
      if (requiresAuth && authHeader !== 'Bearer test-admin-token' && authHeader !== 'Bearer read-token') {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      if (method === 'GET' && url.pathname === '/setup') {
        return jsonResponse({ hasWallet: true, unlocked: true, projectScopeMode: 'off' });
      }

      if (method === 'GET' && url.pathname === '/setup/agents') {
        return jsonResponse({
          agents: [{ id: 'agent-primary', name: 'agent', isPrimary: true }],
        });
      }

      if (method === 'POST' && url.pathname === '/actions/token') {
        const body = readJsonBody(init?.body);
        const pubkey = typeof body.pubkey === 'string' ? body.pubkey : '';
        if (!pubkey) return jsonResponse({ error: 'pubkey required' }, 400);
        readTokenPubkey = pubkey;
        const encryptedToken = encryptToAgentPubkey('read-token', pubkey);
        return jsonResponse({ encryptedToken });
      }

      if (method === 'GET' && url.pathname === '/credentials/health/summary') {
        return jsonResponse({
          summary: {
            totalAnalyzed: credentials.length,
            safe: credentials.length,
            weak: 0,
            reused: 0,
            breached: 0,
            unknown: 0,
            lastScanAt: null,
          },
        });
      }

      if (method === 'GET' && url.pathname === '/credentials') {
        const q = (url.searchParams.get('q') || url.searchParams.get('tag') || '').toLowerCase();
        const filtered = q
          ? credentials.filter((credential) => credential.name.toLowerCase().includes(q))
          : credentials;
        return jsonResponse({
          credentials: filtered.map((credential) => ({
            id: credential.id,
            name: credential.name,
            type: credential.type,
            agentId: credential.agentId,
            meta: {},
          })),
        });
      }

      const readMatch = url.pathname.match(/^\/credentials\/([^/]+)\/read$/);
      if (method === 'POST' && readMatch) {
        const credentialId = decodeURIComponent(readMatch[1]);
        const target = credentials.find((credential) => credential.id === credentialId);
        if (!target) return jsonResponse({ error: 'Not found' }, 404);
        if (!readTokenPubkey) return jsonResponse({ error: 'No read token pubkey' }, 400);
        const encrypted = encryptToAgentPubkey(
          JSON.stringify({
            id: target.id,
            agentId: target.agentId,
            type: target.type,
            fields: target.fields,
          }),
          readTokenPubkey,
        );
        return jsonResponse({ encrypted });
      }

      if (method === 'POST' && url.pathname === '/credentials') {
        const body = readJsonBody(init?.body);
        const name = String(body.name || '');
        const type = String(body.type || 'api');
        const agentId = String(body.agentId || 'agent-primary');
        const sensitiveFields = Array.isArray(body.sensitiveFields)
          ? body.sensitiveFields as Array<{ key: string; value: string; sensitive?: boolean }>
          : [];
        const created: MockCredential = {
          id: `cred-${nextCredentialId++}`,
          name,
          type,
          agentId,
          fields: sensitiveFields.map((field) => ({
            key: field.key,
            value: field.value,
            sensitive: field.sensitive ?? true,
          })),
        };
        credentials.push(created);
        return jsonResponse({
          success: true,
          credential: {
            id: created.id,
            name: created.name,
            type: created.type,
            agentId: created.agentId,
            meta: {},
          },
        });
      }

      const credentialMatch = url.pathname.match(/^\/credentials\/([^/]+)$/);
      if (method === 'PUT' && credentialMatch) {
        const credentialId = decodeURIComponent(credentialMatch[1]);
        const body = readJsonBody(init?.body);
        const target = credentials.find((credential) => credential.id === credentialId);
        if (!target) return jsonResponse({ error: 'Not found' }, 404);
        const sensitiveFields = Array.isArray(body.sensitiveFields)
          ? body.sensitiveFields as Array<{ key: string; value: string; sensitive?: boolean }>
          : [];
        target.fields = sensitiveFields.map((field) => ({
          key: field.key,
          value: field.value,
          sensitive: field.sensitive ?? true,
        }));
        return jsonResponse({
          success: true,
          credential: {
            id: target.id,
            name: target.name,
            type: target.type,
            agentId: target.agentId,
            meta: {},
          },
        });
      }

      if (method === 'DELETE' && credentialMatch) {
        const credentialId = decodeURIComponent(credentialMatch[1]);
        credentials = credentials.filter((credential) => credential.id !== credentialId);
        return jsonResponse({ success: true, action: 'deleted', deleted: true });
      }

      if (method === 'POST' && url.pathname === '/credential-shares') {
        const body = readJsonBody(init?.body);
        const credentialId = String(body.credentialId || '');
        const target = credentials.find((credential) => credential.id === credentialId);
        if (!target) return jsonResponse({ error: 'Not found' }, 404);
        return jsonResponse({
          success: true,
          share: {
            token: `share-${credentialId}`,
            credentialId,
            expiresAt: 1_900_000_000_000,
            accessMode: body.accessMode || 'anyone',
            oneTimeOnly: Boolean(body.oneTimeOnly),
          },
        });
      }

      return jsonResponse({ error: `Unhandled mock route: ${method} ${url.pathname}` }, 404);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fetchSpy.mockRestore();
    delete process.env.WALLET_SERVER_URL;
    delete process.env.AURA_TOKEN;
    delete process.env.AUTO_DECRYPT;
    delete process.env.AURA_AGENT_PASSWORD;
    delete process.env.CLI_SAVED_SECRET;
  });

  async function runCli(args: string[]): Promise<{ exitCode: number; logs: string[]; errors: string[]; warnings: string[] }> {
    const logs: string[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
      logs.push(values.map(String).join(' '));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
      errors.push(values.map(String).join(' '));
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...values: unknown[]) => {
      warnings.push(values.map(String).join(' '));
    });

    try {
      const exitCode = await runAgentCli(args);
      return { exitCode, logs, errors, warnings };
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  }

  it('routes dev aliases to local CLI for agent shortcuts', () => {
    const aliasesPath = path.join(projectRoot, 'scripts', 'dev-aliases.sh');
    const script = [
      'set -e',
      `AURA_DEV_ROOT=${JSON.stringify(projectRoot)}`,
      `source ${JSON.stringify(aliasesPath)} >/dev/null`,
      'node() { printf "NODE|AURA_FORCE_NODE_TSX=%s|%s\\n" "${AURA_FORCE_NODE_TSX:-}" "$*"; }',
      'auramaxxdev listsecrets --profile dev',
      'auramaxxdev get AURAMAXX --profile dev',
      'auramaxxdev set AURAMAXX updated-value --field value --profile dev',
      'auramaxxdev share AURAMAXX --expires-after 1h --profile dev',
      'auramaxxdev del AURAMAXX --profile dev',
    ].join('\n');

    const result = spawnSync('zsh', ['-lc', script], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const nodeCalls = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('NODE|'));

    const binTarget = `${projectRoot}/bin/auramaxx.js`;
    expect(nodeCalls).toEqual([
      `NODE|AURA_FORCE_NODE_TSX=1|${binTarget} listsecrets --profile dev`,
      `NODE|AURA_FORCE_NODE_TSX=1|${binTarget} get AURAMAXX --profile dev`,
      `NODE|AURA_FORCE_NODE_TSX=1|${binTarget} set AURAMAXX updated-value --field value --profile dev`,
      `NODE|AURA_FORCE_NODE_TSX=1|${binTarget} share AURAMAXX --expires-after 1h --profile dev`,
      `NODE|AURA_FORCE_NODE_TSX=1|${binTarget} del AURAMAXX --profile dev`,
    ]);
  });

  it('allows secret exec without command and stores process-local env value', async () => {
    const run = await runCli(['secret', 'exec', 'AURAMAXX', '--env', 'CLI_SAVED_SECRET', '--profile', 'dev']);
    expect(run.exitCode).toBe(0);
    expect(run.errors).toEqual([]);
    expect(run.logs).toContain('Saved to env variable CLI_SAVED_SECRET.');
    expect(run.logs.join('\n')).toContain("Scope: current CLI process only. Use '-- <command>' to inject into a child command.");
    expect(process.env.CLI_SAVED_SECRET).toBe('alpha-123');
  });

  it('executes deterministic agent CLI flow for CD sandbox lane', async () => {
    const listRun = await runCli(['list', '--profile', 'dev']);
    expect(listRun.exitCode).toBe(0);
    expect(listRun.errors).toEqual([]);
    const firstSecret = listRun.logs[0]?.split('  (')[0];
    expect(firstSecret).toBe('AURAMAXX');

    const getRun = await runCli(['get', firstSecret!, '--profile', 'dev']);
    expect(getRun.exitCode).toBe(0);
    expect(getRun.logs.join('\n')).toContain('alpha-123');

    const updateRun = await runCli(['set', firstSecret!, 'rotated-789', '--field', 'value', '--profile', 'dev']);
    expect(updateRun.exitCode).toBe(0);
    expect(updateRun.logs.join('\n')).toContain('Updated AURAMAXX');

    const getUpdatedRun = await runCli(['get', firstSecret!, '--profile', 'dev']);
    expect(getUpdatedRun.exitCode).toBe(0);
    expect(getUpdatedRun.logs.join('\n')).toContain('rotated-789');

    const createRun = await runCli(['set', 'CLI_NEW_SECRET', 'new-123', '--field', 'value', '--profile', 'dev']);
    expect(createRun.exitCode).toBe(0);
    expect(createRun.logs.join('\n')).toContain('Created CLI_NEW_SECRET');

    const shareRun = await runCli(['share', 'CLI_NEW_SECRET', '--expires-after', '1h', '--one-time', '--profile', 'dev']);
    expect(shareRun.exitCode).toBe(0);
    expect(shareRun.logs.join('\n')).toContain('Secret gist created for CLI_NEW_SECRET');

    const deleteRun = await runCli(['delete', 'CLI_NEW_SECRET', '--profile', 'dev']);
    expect(deleteRun.exitCode).toBe(0);
    expect(deleteRun.logs.join('\n')).toContain('Deleted CLI_NEW_SECRET');

    const healthRun = await runCli(['health', '--profile', 'dev']);
    expect(healthRun.exitCode).toBe(0);
    expect(healthRun.logs.join('\n')).toContain('Analyzed:');

    const calledPaths = fetchSpy.mock.calls.map(([input]) => readRequestPath(input));
    expect(calledPaths).toContain('/credential-shares');
    expect(calledPaths).toContain('/credentials/health/summary');
    expect(calledPaths.filter((route) => route === '/credentials').length).toBeGreaterThan(2);
  });
});
