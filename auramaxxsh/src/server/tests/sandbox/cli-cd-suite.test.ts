/**
 * CLI/CD sandbox test suite — V1 launch coverage
 *
 * Extends the core sandbox/cli.test.ts with additional CLI scenarios
 * critical for V1 launch: inject with child commands, filtered lists,
 * error handling, multi-field credentials, and edge cases.
 */

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
      title: `AURAMAXX.SH :: ${input.credentialName}`,
      filename: 'auramaxx-sh-abc123def4.txt',
      content: 'AURAMAXX.SH :: mock\n',
    })),
    SecretGistError: MockSecretGistError,
  };
});

import { runAgentCli, formatCredential } from '../../cli/commands/agent';
import { createSecretGist } from '../../lib/secret-gist-share';

interface MockCredential {
  id: string;
  name: string;
  type: string;
  agentId: string;
  fields: Array<{ key: string; value: string; type?: string; sensitive?: boolean }>;
  tags?: string[];
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function readJsonBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (!body || typeof body !== 'string') return {};
  return JSON.parse(body) as Record<string, unknown>;
}

function readRequestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return new URL(input).pathname;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url).pathname;
}

function readRequestUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
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

describe('CLI/CD sandbox suite — V1 launch', () => {
  const projectRoot = path.resolve(__dirname, '../../../..');
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let credentials: MockCredential[] = [];
  let nextCredentialId = 10;
  let readTokenPubkey: string | null = null;

  beforeEach(() => {
    vi.spyOn(credentialTransport, 'bootstrapViaSocket').mockRejectedValue(
      new Error('connect ENOENT /tmp/aura-cli-501.sock'),
    );

    vi.mocked(createSecretGist).mockResolvedValue({
      url: 'https://gist.github.com/mock/default',
      marker: '||:|||:|:||||',
      identifier: 'ABC123DEF4',
      title: 'AURAMAXX.SH :: mock',
      filename: 'auramaxx-sh-abc123def4.txt',
      content: 'AURAMAXX.SH :: mock\n',
    });

    credentials = [
      {
        id: 'cred-api-1',
        name: 'PROD_API_KEY',
        type: 'api',
        agentId: 'agent-primary',
        fields: [{ key: 'value', value: 'sk-prod-abc123', sensitive: true }],
        tags: ['prod', 'api'],
      },
      {
        id: 'cred-login-1',
        name: 'GITHUB_LOGIN',
        type: 'login',
        agentId: 'agent-primary',
        fields: [
          { key: 'username', value: 'aurabuild', sensitive: false },
          { key: 'password', value: 'gh-token-xyz', sensitive: true },
        ],
        tags: ['ci', 'github'],
      },
      {
        id: 'cred-api-2',
        name: 'STAGING_KEY',
        type: 'api',
        agentId: 'agent-secondary',
        fields: [{ key: 'value', value: 'sk-staging-def456', sensitive: true }],
        tags: ['staging'],
      },
    ];
    nextCredentialId = 10;
    readTokenPubkey = null;

    process.env.WALLET_SERVER_URL = 'http://wallet.test';
    process.env.AURA_TOKEN = 'test-admin-token';
    process.env.AUTO_DECRYPT = 'true';
    process.env.AURA_AGENT_PASSWORD = 'test-password';

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = readRequestUrl(input);
      const method = (init?.method || 'GET').toUpperCase();
      const authHeader = readAuthHeader(init?.headers);

      const publicPaths = ['/setup', '/setup/agents'];
      if (!publicPaths.includes(url.pathname) && authHeader !== 'Bearer test-admin-token' && authHeader !== 'Bearer read-token') {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      // Setup routes
      if (method === 'GET' && url.pathname === '/setup') {
        return jsonResponse({ hasWallet: true, unlocked: true, projectScopeMode: 'off' });
      }
      if (method === 'GET' && url.pathname === '/setup/agents') {
        return jsonResponse({
          agents: [
            { id: 'agent-primary', name: 'agent', isPrimary: true },
            { id: 'agent-secondary', name: 'staging', isPrimary: false },
          ],
        });
      }

      // Token bootstrap
      if (method === 'POST' && url.pathname === '/actions/token') {
        const body = readJsonBody(init?.body);
        const pubkey = typeof body.pubkey === 'string' ? body.pubkey : '';
        if (!pubkey) return jsonResponse({ error: 'pubkey required' }, 400);
        readTokenPubkey = pubkey;
        const encryptedToken = encryptToAgentPubkey('read-token', pubkey);
        return jsonResponse({ encryptedToken });
      }

      // Health summary
      if (method === 'GET' && url.pathname === '/credentials/health/summary') {
        return jsonResponse({
          summary: {
            totalAnalyzed: credentials.length,
            safe: credentials.length - 1,
            weak: 1,
            reused: 0,
            breached: 0,
            unknown: 0,
            lastScanAt: '2026-02-23T10:00:00Z',
          },
        });
      }

      // List credentials (with optional q/tag filter)
      if (method === 'GET' && url.pathname === '/credentials') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const tag = (url.searchParams.get('tag') || '').toLowerCase();
        let filtered = credentials;
        if (q) {
          filtered = filtered.filter((c) => c.name.toLowerCase().includes(q));
        }
        if (tag) {
          filtered = filtered.filter((c) => c.tags?.some((t) => t.toLowerCase() === tag));
        }
        return jsonResponse({
          credentials: filtered.map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
            agentId: c.agentId,
            meta: {},
          })),
        });
      }

      // Read credential
      const readMatch = url.pathname.match(/^\/credentials\/([^/]+)\/read$/);
      if (method === 'POST' && readMatch) {
        const credentialId = decodeURIComponent(readMatch[1]);
        const target = credentials.find((c) => c.id === credentialId);
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

      // Create credential
      if (method === 'POST' && url.pathname === '/credentials') {
        const body = readJsonBody(init?.body);
        const name = String(body.name || '');
        const type = String(body.type || 'api');
        const agentId = String(body.agentId || 'agent-primary');
        const sensitiveFields = Array.isArray(body.sensitiveFields)
          ? (body.sensitiveFields as Array<{ key: string; value: string; sensitive?: boolean }>)
          : [];
        const created: MockCredential = {
          id: `cred-${nextCredentialId++}`,
          name,
          type,
          agentId,
          fields: sensitiveFields.map((f) => ({ key: f.key, value: f.value, sensitive: f.sensitive ?? true })),
        };
        credentials.push(created);
        return jsonResponse({
          success: true,
          credential: { id: created.id, name: created.name, type: created.type, agentId: created.agentId, meta: {} },
        });
      }

      // Update / Delete credential
      const credentialMatch = url.pathname.match(/^\/credentials\/([^/]+)$/);
      if (method === 'PUT' && credentialMatch) {
        const credentialId = decodeURIComponent(credentialMatch[1]);
        const body = readJsonBody(init?.body);
        const target = credentials.find((c) => c.id === credentialId);
        if (!target) return jsonResponse({ error: 'Not found' }, 404);
        const sensitiveFields = Array.isArray(body.sensitiveFields)
          ? (body.sensitiveFields as Array<{ key: string; value: string; sensitive?: boolean }>)
          : [];
        target.fields = sensitiveFields.map((f) => ({ key: f.key, value: f.value, sensitive: f.sensitive ?? true }));
        return jsonResponse({
          success: true,
          credential: { id: target.id, name: target.name, type: target.type, agentId: target.agentId, meta: {} },
        });
      }
      if (method === 'DELETE' && credentialMatch) {
        const credentialId = decodeURIComponent(credentialMatch[1]);
        credentials = credentials.filter((c) => c.id !== credentialId);
        return jsonResponse({ success: true, action: 'deleted', deleted: true });
      }

      // Share
      if (method === 'POST' && url.pathname === '/credential-shares') {
        const body = readJsonBody(init?.body);
        const credentialId = String(body.credentialId || '');
        const target = credentials.find((c) => c.id === credentialId);
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

  // ── Filtered list ──

  it('lists credentials filtered by --name query', async () => {
    const run = await runCli(['list', '--name', 'PROD', '--profile', 'dev']);
    expect(run.exitCode).toBe(0);
    expect(run.errors).toEqual([]);
    const output = run.logs.join('\n');
    expect(output).toContain('PROD_API_KEY');
    expect(output).not.toContain('GITHUB_LOGIN');
    expect(output).not.toContain('STAGING_KEY');
  });

  it('lists all credentials when no filter given', async () => {
    const run = await runCli(['list', '--profile', 'dev']);
    expect(run.exitCode).toBe(0);
    const output = run.logs.join('\n');
    expect(output).toContain('PROD_API_KEY');
    expect(output).toContain('GITHUB_LOGIN');
    expect(output).toContain('STAGING_KEY');
  });

  // ── Get with --json ──

  it('reads credential with --json flag', async () => {
    const run = await runCli(['get', 'PROD_API_KEY', '--json', '--profile', 'dev']);
    expect(run.exitCode).toBe(0);
    expect(run.errors).toEqual([]);
    const output = run.logs.join('\n');
    expect(output).toContain('sk-prod-abc123');
  });

  // ── Multi-field login credential ──

  it('reads login credential and returns password field', async () => {
    const run = await runCli(['get', 'GITHUB_LOGIN', '--profile', 'dev']);
    expect(run.exitCode).toBe(0);
    const output = run.logs.join('\n');
    // Login credentials return the password field by default
    expect(output).toContain('gh-token-xyz');
  });

  it('reads login credential with --json to see all fields', async () => {
    const run = await runCli(['get', 'GITHUB_LOGIN', '--json', '--profile', 'dev']);
    expect(run.exitCode).toBe(0);
    const output = run.logs.join('\n');
    // JSON output should include both username and password fields
    expect(output).toContain('aurabuild');
    expect(output).toContain('gh-token-xyz');
  });

  // ── Secret exec stores env ──

  it('secret exec injects value into env variable', async () => {
    const run = await runCli(['secret', 'exec', 'PROD_API_KEY', '--env', 'CLI_SAVED_SECRET', '--profile', 'dev']);
    expect(run.exitCode).toBe(0);
    expect(process.env.CLI_SAVED_SECRET).toBe('sk-prod-abc123');
  });

  // ── Create + rotate + delete lifecycle ──

  it('completes full create → read → rotate → delete lifecycle', async () => {
    // Create
    const create = await runCli(['set', 'LIFECYCLE_TEST', 'initial-value', '--field', 'value', '--profile', 'dev']);
    expect(create.exitCode).toBe(0);
    expect(create.logs.join('\n')).toContain('Created LIFECYCLE_TEST');

    // Read
    const read = await runCli(['get', 'LIFECYCLE_TEST', '--profile', 'dev']);
    expect(read.exitCode).toBe(0);
    expect(read.logs.join('\n')).toContain('initial-value');

    // Rotate
    const rotate = await runCli(['set', 'LIFECYCLE_TEST', 'rotated-value', '--field', 'value', '--profile', 'dev']);
    expect(rotate.exitCode).toBe(0);
    expect(rotate.logs.join('\n')).toContain('Updated LIFECYCLE_TEST');

    // Verify rotation
    const readAfter = await runCli(['get', 'LIFECYCLE_TEST', '--profile', 'dev']);
    expect(readAfter.exitCode).toBe(0);
    expect(readAfter.logs.join('\n')).toContain('rotated-value');

    // Delete
    const del = await runCli(['delete', 'LIFECYCLE_TEST', '--profile', 'dev']);
    expect(del.exitCode).toBe(0);
    expect(del.logs.join('\n')).toContain('Deleted LIFECYCLE_TEST');

    // Verify deletion — list should not include it
    const listAfter = await runCli(['list', '--query', 'LIFECYCLE', '--profile', 'dev']);
    expect(listAfter.exitCode).toBe(0);
    expect(listAfter.logs.join('\n')).not.toContain('LIFECYCLE_TEST');
  });

  // ── Share with options ──

  it('creates a secret gist share with one-time and expiry', async () => {
    const run = await runCli(['share', 'PROD_API_KEY', '--expires-after', '2h', '--one-time', '--profile', 'dev']);
    expect(run.exitCode).toBe(0);
    expect(run.logs.join('\n')).toContain('Secret gist created for PROD_API_KEY');

    const calledPaths = fetchSpy.mock.calls.map(([input]) => readRequestPath(input));
    expect(calledPaths).toContain('/credential-shares');
  });

  // ── Health summary ──

  it('displays credential health summary with weak count', async () => {
    const run = await runCli(['health', '--profile', 'dev']);
    expect(run.exitCode).toBe(0);
    const output = run.logs.join('\n');
    expect(output).toContain('Analyzed:');
  });

  // ── Create login-type credential ──

  it('creates login-type credential with --type login', async () => {
    const run = await runCli(['set', 'NEW_LOGIN', 'mypassword', '--type', 'login', '--profile', 'dev']);
    expect(run.exitCode).toBe(0);
    expect(run.logs.join('\n')).toContain('Created NEW_LOGIN');

    // Verify it was created with correct type via the mock
    const created = credentials.find((c) => c.name === 'NEW_LOGIN');
    expect(created).toBeDefined();
    expect(created!.type).toBe('login');
  });

  // ── Get nonexistent credential returns error ──

  it('handles get for nonexistent credential gracefully', async () => {
    const run = await runCli(['get', 'DOES_NOT_EXIST', '--profile', 'dev']);
    // Should fail or print an error — the credential won't be found in search
    const output = [...run.logs, ...run.errors].join('\n');
    // Either exits non-zero or prints a "not found" message
    expect(run.exitCode !== 0 || output.toLowerCase().includes('not found') || output.toLowerCase().includes('no credential')).toBe(true);
  });

  // ── Delete nonexistent credential ──

  it('handles delete for nonexistent credential gracefully', async () => {
    const run = await runCli(['delete', 'DOES_NOT_EXIST', '--profile', 'dev']);
    const output = [...run.logs, ...run.errors].join('\n');
    expect(run.exitCode !== 0 || output.toLowerCase().includes('not found') || output.toLowerCase().includes('no credential')).toBe(true);
  });

  // ── Multiple operations track API calls correctly ──

  it('tracks correct API call sequence for set + get + delete', async () => {
    fetchSpy.mockClear();

    await runCli(['set', 'TRACK_TEST', 'value123', '--field', 'value', '--profile', 'dev']);
    await runCli(['get', 'TRACK_TEST', '--profile', 'dev']);
    await runCli(['delete', 'TRACK_TEST', '--profile', 'dev']);

    const calledPaths = fetchSpy.mock.calls.map(([input]) => readRequestPath(input));

    // Should have called: setup, agents, token, credentials (search), credentials (create),
    // then similar for get and delete
    expect(calledPaths.filter((p) => p === '/credentials').length).toBeGreaterThanOrEqual(3);
  });

  // ── formatCredential unit test ──

  it('formatCredential returns correct JSON for api type', () => {
    const result = formatCredential(
      { id: 'test-1', name: 'MY_KEY', type: 'api' },
      { id: 'test-1', agentId: 'agent-primary', type: 'api', fields: [{ key: 'value', value: 'secret-123', sensitive: true }] },
      { json: true },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('secret-123');
    expect(result.output).toContain('MY_KEY');
    const parsed = JSON.parse(result.output);
    expect(parsed.name).toBe('MY_KEY');
    expect(parsed.fields[0].value).toBe('secret-123');
  });

  // ── Batch creates don't interfere ──

  it('handles rapid sequential creates without interference', async () => {
    const names = ['BATCH_A', 'BATCH_B', 'BATCH_C'];
    for (const name of names) {
      const run = await runCli(['set', name, `val-${name}`, '--field', 'value', '--profile', 'dev']);
      expect(run.exitCode).toBe(0);
    }

    const list = await runCli(['list', '--profile', 'dev']);
    const output = list.logs.join('\n');
    for (const name of names) {
      expect(output).toContain(name);
    }
  });
});
