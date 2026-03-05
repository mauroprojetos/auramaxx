import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isTokenExpired, refreshAccessToken, OAUTH2_DEFAULT_EXCLUDE_FIELDS } from '../../lib/oauth2-refresh';
import { CredentialFile } from '../../types';

function makeOAuth2Credential(expiresAt: number | string | null | undefined): CredentialFile {
  return {
    id: 'cred-test1234',
    agentId: 'agent-1',
    type: 'oauth2',
    name: 'Test OAuth2',
    meta: {
      token_endpoint: 'https://oauth.example.com/token',
      scopes: 'read write',
      expires_at: expiresAt,
      auth_method: 'client_secret_post',
    },
    encrypted: { ciphertext: '', iv: '', salt: '', mac: '' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('isTokenExpired', () => {
  it('returns true when expires_at is null', () => {
    expect(isTokenExpired(makeOAuth2Credential(null))).toBe(true);
  });

  it('returns true when token is expired', () => {
    const pastTimestamp = Math.floor(Date.now() / 1000) - 3600;
    expect(isTokenExpired(makeOAuth2Credential(pastTimestamp))).toBe(true);
  });

  it('returns true when token expires within 60s buffer', () => {
    const nearFuture = Math.floor(Date.now() / 1000) + 30;
    expect(isTokenExpired(makeOAuth2Credential(nearFuture))).toBe(true);
  });

  it('returns true when expires_at is an invalid string', () => {
    expect(isTokenExpired(makeOAuth2Credential('invalid-timestamp'))).toBe(true);
  });

  it('returns false when token is still valid', () => {
    const futureTimestamp = Math.floor(Date.now() / 1000) + 3600;
    expect(isTokenExpired(makeOAuth2Credential(futureTimestamp))).toBe(false);
  });
});

describe('refreshAccessToken', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends correct request with client_secret_post', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as Response);

    const result = await refreshAccessToken(
      'https://oauth.example.com/token',
      'old-refresh-token',
      'client-123',
      'secret-456',
      'client_secret_post',
    );

    expect(result.accessToken).toBe('new-access-token');
    expect(result.refreshToken).toBe('new-refresh-token');
    expect(result.expiresIn).toBe(3600);

    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://oauth.example.com/token');
    expect(opts.method).toBe('POST');
    const body = opts.body as string;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('client_id=client-123');
    expect(body).toContain('client_secret=secret-456');
  });

  it('sends Basic auth with client_secret_basic', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ access_token: 'new-token' }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as Response);

    await refreshAccessToken(
      'https://oauth.example.com/token',
      'refresh',
      'client-id',
      'client-secret',
      'client_secret_basic',
    );

    const [, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const expected = Buffer.from('client-id:client-secret').toString('base64');
    expect(opts.headers['Authorization']).toBe(`Basic ${expected}`);
    expect(opts.body).not.toContain('client_id');
  });

  it('throws on non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
    } as Response);

    await expect(
      refreshAccessToken('https://oauth.example.com/token', 'bad', 'c', 's'),
    ).rejects.toThrow('OAuth2 refresh token revoked (400)');
  });

  it('treats invalid_grant JSON errors case-insensitively as revoked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"INVALID_GRANT"}',
    } as Response);

    await expect(
      refreshAccessToken('https://oauth.example.com/token', 'bad', 'c', 's'),
    ).rejects.toThrow('OAuth2 refresh token revoked (400)');
  });
});

describe('OAUTH2_DEFAULT_EXCLUDE_FIELDS', () => {
  it('excludes refresh_token, client_secret, client_id, token_endpoint', () => {
    expect(OAUTH2_DEFAULT_EXCLUDE_FIELDS).toContain('refresh_token');
    expect(OAUTH2_DEFAULT_EXCLUDE_FIELDS).toContain('client_secret');
    expect(OAUTH2_DEFAULT_EXCLUDE_FIELDS).toContain('client_id');
    expect(OAUTH2_DEFAULT_EXCLUDE_FIELDS).toContain('token_endpoint');
    expect(OAUTH2_DEFAULT_EXCLUDE_FIELDS).not.toContain('access_token');
  });
});
