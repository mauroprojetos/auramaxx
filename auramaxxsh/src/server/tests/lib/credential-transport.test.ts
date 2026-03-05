import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
} from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapViaAuthRequest,
  createReadToken,
  encryptToAgentPubkey,
  buildScopedReadTokenIssueRequest,
  generateEphemeralKeypair,
  isValidAgentPubkey,
  normalizeAgentPubkey,
} from '../../lib/credential-transport';
import * as defaults from '../../lib/defaults';

interface HybridEnvelope {
  v: number;
  alg: string;
  key: string;
  iv: string;
  tag: string;
  data: string;
}

function decryptWithPrivateKey(encryptedBase64: string, privateKeyPem: string): string {
  const decoded = Buffer.from(encryptedBase64, 'base64');

  // Hybrid payloads are base64(JSON envelope)
  try {
    const parsed = JSON.parse(decoded.toString('utf8')) as HybridEnvelope;
    if (parsed && parsed.v === 1 && parsed.alg === 'RSA-OAEP/AES-256-GCM') {
      const sessionKey = privateDecrypt(
        {
          key: privateKeyPem,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        Buffer.from(parsed.key, 'base64'),
      );

      const decipher = createDecipheriv('aes-256-gcm', sessionKey, Buffer.from(parsed.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, 'base64')),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    }
  } catch {
    // Not a hybrid envelope, fall back to raw RSA ciphertext.
  }

  const plaintext = privateDecrypt(
    {
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    decoded,
  );
  return plaintext.toString('utf8');
}

describe('credential-transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AURA_AUTH_PROFILE;
    delete process.env.AURA_AGENT_PROFILE;
  });

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  it('should encrypt/decrypt small payloads with RSA-OAEP', () => {
    const payload = JSON.stringify({ secret: 'hello-world' });
    const encrypted = encryptToAgentPubkey(payload, publicKey);
    const decrypted = decryptWithPrivateKey(encrypted, privateKey);
    expect(decrypted).toBe(payload);
  });

  it('should use hybrid encryption for large payloads and decrypt round-trip', () => {
    const largePayload = JSON.stringify({
      fields: Array.from({ length: 250 }, (_, i) => ({
        key: `k${i}`,
        value: `v-${'x'.repeat(30)}-${i}`,
      })),
    });

    const pubkeyBase64 = Buffer.from(publicKey, 'utf8').toString('base64');
    const encrypted = encryptToAgentPubkey(largePayload, pubkeyBase64);
    const decrypted = decryptWithPrivateKey(encrypted, privateKey);
    expect(decrypted).toBe(largePayload);
  });

  it('should validate and normalize public keys', () => {
    const pubkeyBase64 = Buffer.from(publicKey, 'utf8').toString('base64');
    expect(isValidAgentPubkey(publicKey)).toBe(true);
    expect(isValidAgentPubkey(pubkeyBase64)).toBe(true);

    const normalized = normalizeAgentPubkey(pubkeyBase64);
    expect(normalized).toContain('BEGIN PUBLIC KEY');
  });

  it('should reject invalid public keys', () => {
    expect(isValidAgentPubkey('not-a-key')).toBe(false);
    expect(() => encryptToAgentPubkey('test', 'not-a-key')).toThrow();
  });

  it('createReadToken should return decrypted encryptedToken', async () => {
    const keypair = generateEphemeralKeypair();
    const token = JSON.stringify({ kind: 'agent-token', scope: 'secret:read' });
    const encryptedToken = encryptToAgentPubkey(token, keypair.publicKeyPem);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ encryptedToken }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await createReadToken('https://wallet.local', 'admin-token', keypair, 'cli-test-reader');

    expect(result).toBe(token);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://wallet.local/actions/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        }),
      }),
    );

    fetchSpy.mockRestore();
  });

  

  it('buildScopedReadTokenIssueRequest emits profile fields when requested', () => {
    const payload = buildScopedReadTokenIssueRequest({
      agentId: 'cli-test-reader',
      pubkey: 'pubkey',
      profile: 'strict',
      profileVersion: 'v1',
      profileOverrides: { ttlSeconds: 600, maxReads: 25 },
    });

    expect(payload).toEqual({
      agentId: 'cli-test-reader',
      profile: 'strict',
      profileVersion: 'v1',
      profileOverrides: { ttlSeconds: 600, maxReads: 25 },
      pubkey: 'pubkey',
    });
  });

  it('createReadToken forwards profile issuance fields to /actions/token', async () => {
    const keypair = generateEphemeralKeypair();
    const token = JSON.stringify({ kind: 'agent-token', scope: 'secret:read' });
    const encryptedToken = encryptToAgentPubkey(token, keypair.publicKeyPem);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ encryptedToken }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await createReadToken(
      'https://wallet.local',
      'admin-token',
      keypair,
      'cli-test-reader',
      {
        profile: 'strict',
        profileVersion: 'v1',
        profileOverrides: { ttlSeconds: 600, maxReads: 25 },
      },
    );

    const call = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(call.body));
    expect(body).toMatchObject({
      agentId: 'cli-test-reader',
      profile: 'strict',
      profileVersion: 'v1',
      profileOverrides: { ttlSeconds: 600, maxReads: 25 },
    });

    fetchSpy.mockRestore();
  });

  it('bootstrapViaAuthRequest defaults to trust.localProfile when unset', async () => {
    const keypair = generateEphemeralKeypair();
    vi.spyOn(defaults, 'getDefault').mockImplementation(async (key: string) => {
      if (key === 'trust.localProfile') return 'admin';
      if (key === 'trust.localProfileVersion') return 'v1';
      return null;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        requestId: 'req_123',
        secret: 'secret_123',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await bootstrapViaAuthRequest('https://wallet.local', 'cli-test-auth', keypair, {
      noWait: true,
    });

    expect(result).toEqual({
      requestId: 'req_123',
      secret: 'secret_123',
      approveUrl: undefined,
    });
    const call = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(call.body));
    expect(body.profile).toBe('admin');
    expect(body.profileVersion).toBe('v1');
  });

  it('bootstrapViaAuthRequest falls back to defaults.ts seeds when local trust defaults are empty', async () => {
    const keypair = generateEphemeralKeypair();
    vi.spyOn(defaults, 'getDefault').mockResolvedValue('');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        requestId: 'req_123',
        secret: 'secret_123',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await bootstrapViaAuthRequest('https://wallet.local', 'cli-test-auth', keypair, {
      noWait: true,
    });

    const call = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(call.body));
    expect(body.profile).toBe('admin');
    expect(body.profileVersion).toBe('v1');
  });

  it('bootstrapViaAuthRequest includes claim secret header when polling for approval', async () => {
    const keypair = generateEphemeralKeypair();
    const token = JSON.stringify({ kind: 'agent-token', scope: 'session' });
    const encryptedToken = encryptToAgentPubkey(token, keypair.publicKeyPem);

    vi.spyOn(defaults, 'getDefault').mockImplementation(async (key: string) => {
      if (key === 'trust.localProfile') return 'admin';
      if (key === 'trust.localProfileVersion') return 'v1';
      return null;
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          requestId: 'req_poll',
          secret: 'secret_poll',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const result = await bootstrapViaAuthRequest('https://wallet.local', 'cli-test-auth', keypair);

    expect(result).toBe(token);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const pollCall = fetchSpy.mock.calls[1];
    const pollUrl = String(pollCall?.[0] ?? '');
    const pollInit = (pollCall?.[1] ?? {}) as RequestInit;
    const headers = pollInit.headers as Record<string, string>;
    expect(pollUrl).toBe('https://wallet.local/auth/req_poll');
    expect(headers['x-aura-claim-secret']).toBe('secret_poll');

    fetchSpy.mockRestore();
  });

  it('createReadToken should fail when encryptedToken is missing', async () => {
    const keypair = generateEphemeralKeypair();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ token: 'plaintext-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(createReadToken('https://wallet.local', 'admin-token', keypair, 'cli-test-reader'))
      .rejects
      .toThrow('No encryptedToken in response');

    fetchSpy.mockRestore();
  });
});
