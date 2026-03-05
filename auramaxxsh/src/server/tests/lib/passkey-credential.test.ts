import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/config', () => ({
  DATA_PATHS: { credentials: '/tmp/test-creds' },
}));

vi.mock('../../lib/credential-agent', () => ({
  getCredentialAgentKey: () => Buffer.from('a'.repeat(32)),
}));

vi.mock('../../lib/encrypt', () => ({
  encryptWithSeed: (data: string, _key: Buffer) => ({
    iv: 'test-iv',
    data: Buffer.from(data).toString('base64'),
    tag: 'test-tag',
  }),
  decryptWithSeed: (enc: any, _key: Buffer) => Buffer.from(enc.data, 'base64').toString(),
}));

vi.mock('fs', () => {
  const store = new Map<string, string>();
  return {
    default: {
      existsSync: (p: string) => store.has(p),
      readFileSync: (p: string) => store.get(p)!,
      writeFileSync: (p: string, data: string) => store.set(p, data),
      mkdirSync: () => {},
      readdirSync: (dir: string) => {
        const files: string[] = [];
        for (const key of store.keys()) {
          if (key.startsWith(dir)) files.push(key.split('/').pop()!);
        }
        return files;
      },
      unlinkSync: (p: string) => store.delete(p),
    },
  };
});

import {
  registerPasskey,
  authenticatePasskey,
  matchPasskeys,
  _resetPasskeyCredentialChallengeStoreForTests,
} from '../../lib/passkey-credential';

function clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string): string {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString('base64url');
}

describe('passkey-credential', () => {
  beforeEach(() => {
    _resetPasskeyCredentialChallengeStoreForTests();
  });

  it('registers a passkey and returns valid attestation data', () => {
    const challenge = 'challenge-create-1';
    const result = registerPasskey({
      agentId: 'primary',
      rpId: 'example.com',
      rpName: 'Example',
      userName: 'user@example.com',
      displayName: 'Test User',
      userHandle: 'dXNlcjEyMw',
      challenge,
      origin: 'https://example.com',
      clientDataJSON: clientData('webauthn.create', challenge, 'https://example.com'),
    });

    expect(result.credentialId).toBeTruthy();
    expect(result.attestationObject).toBeTruthy();
    expect(result.publicKey).toBeTruthy();
    expect(result.transports).toEqual(['internal']);
    expect(result.auraCredentialId).toMatch(/^cred-/);
  });

  it('authenticates with a registered passkey', () => {
    const regChallenge = 'reg-challenge';
    const reg = registerPasskey({
      agentId: 'primary',
      rpId: 'test.com',
      rpName: 'Test',
      userName: 'alice',
      displayName: 'Alice',
      userHandle: 'YWxpY2U',
      challenge: regChallenge,
      origin: 'https://test.com',
      clientDataJSON: clientData('webauthn.create', regChallenge, 'https://test.com'),
    });

    const authChallenge = 'auth-challenge';
    const auth = authenticatePasskey({
      auraCredentialId: reg.auraCredentialId,
      rpId: 'test.com',
      challenge: authChallenge,
      origin: 'https://test.com',
      clientDataJSON: clientData('webauthn.get', authChallenge, 'https://test.com'),
    });

    expect(auth.credentialId).toBe(reg.credentialId);
    expect(auth.authenticatorData).toBeTruthy();
    expect(auth.signature).toBeTruthy();
    expect(auth.userHandle).toBe('YWxpY2U');
  });

  it('rejects challenge replay', () => {
    const challenge = 'replay-challenge';
    registerPasskey({
      agentId: 'primary',
      rpId: 'example.com',
      userHandle: 'Ym9i',
      challenge,
      origin: 'https://example.com',
      clientDataJSON: clientData('webauthn.create', challenge, 'https://example.com'),
    });

    expect(() => registerPasskey({
      agentId: 'primary',
      rpId: 'example.com',
      userHandle: 'Ym9i',
      challenge,
      origin: 'https://example.com',
      clientDataJSON: clientData('webauthn.create', challenge, 'https://example.com'),
    })).toThrow('replay');
  });

  it('rejects authentication with wrong rpId', () => {
    const regChallenge = 'reg-rpid';
    const reg = registerPasskey({
      agentId: 'primary',
      rpId: 'correct.com',
      userName: 'bob',
      userHandle: 'Ym9i',
      challenge: regChallenge,
      origin: 'https://correct.com',
      clientDataJSON: clientData('webauthn.create', regChallenge, 'https://correct.com'),
    });

    const authChallenge = 'auth-rpid';
    expect(() => authenticatePasskey({
      auraCredentialId: reg.auraCredentialId,
      rpId: 'wrong.com',
      challenge: authChallenge,
      origin: 'https://wrong.com',
      clientDataJSON: clientData('webauthn.get', authChallenge, 'https://wrong.com'),
    })).toThrow('rpId mismatch');
  });

  it('matchPasskeys returns empty for unknown rpId', () => {
    const matches = matchPasskeys('unknown-domain.com');
    expect(matches).toEqual([]);
  });
});
