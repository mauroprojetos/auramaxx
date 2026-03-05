import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/credential-transport', async () => {
  const actual = await vi.importActual<typeof import('../../lib/credential-transport')>('../../lib/credential-transport');
  return {
    ...actual,
    generateEphemeralKeypair: () => ({
      publicKeyPem: 'mock-public-key',
      privateKeyPem: 'mock-private-key',
      publicKeyBase64: Buffer.from('mock-public-key', 'utf8').toString('base64'),
    }),
    bootstrapViaSocket: vi.fn(async () => 'test-admin-token'),
    createReadToken: vi.fn(async () => 'read-token'),
    decryptWithPrivateKey: vi.fn((encrypted: string) => encrypted),
  };
});

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
    createSecretGist: vi.fn(async () => ({
      url: 'https://gist.github.com/mock/share',
      marker: '||:|||:|:||||',
      identifier: 'ABC123DEF4',
      title: 'AURAMAXX.SH :: ||:|||:|:|||| :: ABC123DEF4 :: Shared Login',
      filename: 'auramaxx-sh-abc123def4.txt',
      content: 'AURAMAXX.SH :: ||:|||:|:|||| :: ABC123DEF4\n',
    })),
    SecretGistError: MockSecretGistError,
  };
});

import { runAgentCli } from '../../cli/commands/agent';
import { createSecretGist, SecretGistError } from '../../lib/secret-gist-share';

function jsonResponse(payload: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function readPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return new URL(input).pathname;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url).pathname;
}

describe('agent share secret gist CLI flow', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.WALLET_SERVER_URL = 'http://wallet.test';
    process.env.AURA_TOKEN = 'test-admin-token';

    vi.mocked(createSecretGist).mockResolvedValue({
      url: 'https://gist.github.com/mock/share',
      marker: '||:|||:|:||||',
      identifier: 'ABC123DEF4',
      title: 'AURAMAXX.SH :: ||:|||:|:|||| :: ABC123DEF4 :: Shared Login',
      filename: 'auramaxx-sh-abc123def4.txt',
      content: 'AURAMAXX.SH :: ||:|||:|:|||| :: ABC123DEF4\n',
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = readPath(input);
      const method = (init?.method || 'GET').toUpperCase();

      if (method === 'GET' && path === '/setup') {
        return jsonResponse({ hasWallet: true, unlocked: true, projectScopeMode: 'off' });
      }
      if (method === 'GET' && path === '/setup/agents') {
        return jsonResponse({ agents: [{ id: 'primary', name: 'Primary', isPrimary: true }] });
      }
      if (method === 'GET' && path === '/credentials') {
        return jsonResponse({
          credentials: [
            {
              id: 'cred-1',
              name: 'Shared Login',
              type: 'login',
              agentId: 'primary',
              meta: {},
            },
          ],
        });
      }
      if (method === 'POST' && path === '/credential-shares') {
        return jsonResponse({
          success: true,
          share: {
            token: 'share-cred-1',
            credentialId: 'cred-1',
            expiresAt: 1_900_000_000_000,
            accessMode: 'anyone',
            oneTimeOnly: false,
          },
        });
      }
      if (method === 'POST' && path === '/credentials/cred-1/read') {
        return jsonResponse({
          encrypted: JSON.stringify({
            id: 'cred-1',
            agentId: 'primary',
            type: 'login',
            fields: [
              { key: 'username', value: 'alice@example.com', sensitive: false },
              { key: 'password', value: 'super-secret', sensitive: true },
            ],
          }),
        });
      }

      return jsonResponse({ error: `Unhandled route ${method} ${path}` }, 404);
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.WALLET_SERVER_URL;
    delete process.env.AURA_TOKEN;
  });

  async function runCli(args: string[]): Promise<{ exitCode: number; logs: string[]; errors: string[] }> {
    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
      logs.push(values.map(String).join(' '));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
      errors.push(values.map(String).join(' '));
    });

    try {
      const exitCode = await runAgentCli(args);
      return { exitCode, logs, errors };
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }

  it('creates secret gist by default for share command', async () => {
    const result = await runCli(['share', 'Shared Login']);
    expect(result.exitCode).toBe(0);
    expect(result.logs.join('\n')).toContain('Secret gist created for Shared Login');
    expect(vi.mocked(createSecretGist)).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: 'cred-1',
        credentialName: 'Shared Login',
        shareUrl: 'http://wallet.test/credential-shares/share-cred-1',
        fields: expect.arrayContaining([
          expect.objectContaining({ key: 'password', value: 'super-secret' }),
        ]),
      }),
    );
  });

  it('falls back to local share link when gh is missing', async () => {
    vi.mocked(createSecretGist).mockRejectedValueOnce(
      new SecretGistError(
        'GH_MISSING',
        'GitHub CLI (`gh`) is not installed. Secret gist sharing requires `gh`.',
        'Install GitHub CLI and run `gh auth login`, then retry.',
      ),
    );

    const result = await runCli(['share', 'Shared Login']);
    expect(result.exitCode).toBe(0);
    expect(result.logs.join('\n')).toContain('GitHub gist unavailable');
    expect(result.logs.join('\n')).toContain('GitHub CLI (`gh`) is not installed');
    expect(result.logs.join('\n')).toContain('shareLink: http://wallet.test/credential-shares/share-cred-1');
  });

  it('falls back to local share link when gh auth is missing', async () => {
    vi.mocked(createSecretGist).mockRejectedValueOnce(
      new SecretGistError(
        'GH_AUTH_REQUIRED',
        'GitHub CLI is not authenticated for gist creation.',
        'Run `gh auth login` and retry.',
      ),
    );

    const result = await runCli(['share', 'Shared Login']);
    expect(result.exitCode).toBe(0);
    expect(result.logs.join('\n')).toContain('GitHub gist unavailable');
    expect(result.logs.join('\n')).toContain('not authenticated');
    expect(result.logs.join('\n')).toContain('shareLink: http://wallet.test/credential-shares/share-cred-1');
  });
});
