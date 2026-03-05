import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  cleanDatabase,
  createTestApp,
  resetColdWallet,
  setupAndUnlockWallet,
  testPrisma,
} from '../setup';

const app = createTestApp();
let adminToken: string;

function encodeClientData(data: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

beforeAll(async () => {
  await cleanDatabase();
});

beforeEach(async () => {
  resetColdWallet();
  await testPrisma.passkey.deleteMany();
  const result = await setupAndUnlockWallet();
  adminToken = result.adminToken;
});

describe('credential passkey endpoints', () => {
  it('register + match + authenticate success path', async () => {
    const challenge = 'register-challenge-1';
    const origin = 'https://example.com';

    const registerRes = await request(app)
      .post('/credentials/passkey/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        rpId: 'example.com',
        rpName: 'Example',
        userName: 'alice@example.com',
        displayName: 'Alice',
        userHandle: Buffer.from('alice').toString('base64url'),
        challenge,
        origin,
        clientDataJSON: encodeClientData({
          type: 'webauthn.create',
          challenge,
          origin,
          crossOrigin: false,
        }),
      });

    expect(registerRes.status).toBe(200);
    expect(registerRes.body).toHaveProperty('auraCredentialId');
    expect(registerRes.body).toHaveProperty('credentialId');

    const auraCredentialId = registerRes.body.auraCredentialId as string;

    const matchRes = await request(app)
      .get('/credentials/passkey/match')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ rpId: 'example.com' });

    expect(matchRes.status).toBe(200);
    expect(Array.isArray(matchRes.body.matches)).toBe(true);
    expect(matchRes.body.matches.length).toBe(1);
    expect(matchRes.body.matches[0].auraCredentialId).toBe(auraCredentialId);

    const authChallenge = 'auth-challenge-1';
    const authRes = await request(app)
      .post('/credentials/passkey/authenticate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        auraCredentialId,
        rpId: 'example.com',
        challenge: authChallenge,
        origin,
        clientDataJSON: encodeClientData({
          type: 'webauthn.get',
          challenge: authChallenge,
          origin,
          crossOrigin: false,
        }),
      });

    expect(authRes.status).toBe(200);
    expect(authRes.body).toHaveProperty('credentialId');
    expect(authRes.body).toHaveProperty('authenticatorData');
    expect(authRes.body).toHaveProperty('signature');
  });

  it('rejects clientDataJSON semantic mismatch', async () => {
    const challenge = 'register-challenge-semantic';

    const res = await request(app)
      .post('/credentials/passkey/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        rpId: 'example.com',
        userHandle: Buffer.from('alice').toString('base64url'),
        challenge,
        origin: 'https://example.com',
        clientDataJSON: encodeClientData({
          type: 'webauthn.get',
          challenge,
          origin: 'https://example.com',
          crossOrigin: false,
        }),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('clientDataJSON.type');
  });

  it('rejects challenge replay in authenticate route', async () => {
    const challenge = 'register-challenge-replay';
    const origin = 'https://example.com';

    const registerRes = await request(app)
      .post('/credentials/passkey/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        rpId: 'example.com',
        userHandle: Buffer.from('alice').toString('base64url'),
        challenge,
        origin,
        clientDataJSON: encodeClientData({
          type: 'webauthn.create',
          challenge,
          origin,
        }),
      });

    expect(registerRes.status).toBe(200);

    const auraCredentialId = registerRes.body.auraCredentialId as string;
    const authChallenge = 'auth-challenge-replay';
    const authPayload = {
      auraCredentialId,
      rpId: 'example.com',
      challenge: authChallenge,
      origin,
      clientDataJSON: encodeClientData({
        type: 'webauthn.get',
        challenge: authChallenge,
        origin,
      }),
    };

    const first = await request(app)
      .post('/credentials/passkey/authenticate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(authPayload);
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/credentials/passkey/authenticate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(authPayload);

    expect(second.status).toBe(400);
    expect(second.body.error).toContain('replay');
  });
});
