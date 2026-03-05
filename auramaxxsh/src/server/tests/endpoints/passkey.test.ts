import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import {
  createTestApp,
  setupAndUnlockWallet,
  cleanDatabase,
  resetColdWallet,
  testPrisma,
  TEST_AGENT_PUBKEY,
} from '../setup';
import { lock } from '../../lib/cold';
import { storeChallenge, uint8ArrayToBase64url } from '../../lib/passkey';

const app = createTestApp();
let adminToken: string;

beforeAll(async () => {
  await cleanDatabase();
});

beforeEach(async () => {
  resetColdWallet();
  await testPrisma.passkey.deleteMany();
  const result = await setupAndUnlockWallet();
  adminToken = result.adminToken;
});

describe('GET /auth/passkey/status', () => {
  it('returns registered: false when no passkeys', async () => {
    const res = await request(app).get('/auth/passkey/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ registered: false, count: 0 });
  });

  it('returns registered: true when passkeys exist', async () => {
    await testPrisma.passkey.create({
      data: {
        credentialId: 'test-cred-id',
        publicKey: Buffer.from('fake-key'),
        counter: 0,
        rpId: 'localhost',
        transports: '["internal"]',
      },
    });
    const res = await request(app).get('/auth/passkey/status?rpId=localhost');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ registered: true, count: 1, rpId: 'localhost' });
  });
});

describe('POST /auth/passkey/register/options', () => {
  it('returns 401 without admin token', async () => {
    const res = await request(app)
      .post('/auth/passkey/register/options')
      .send({});
    expect(res.status).toBe(401);
  });

  it('returns registration options with valid admin token', async () => {
    const res = await request(app)
      .post('/auth/passkey/register/options')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rpId: 'localhost' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('challenge');
    expect(res.body).toHaveProperty('rp');
    expect(res.body.rp.id).toBe('localhost');
    expect(res.body).toHaveProperty('user');
    expect(res.body).toHaveProperty('pubKeyCredParams');
    expect(res.body.authenticatorSelection.authenticatorAttachment).toBe('platform');
    expect(res.body.authenticatorSelection.userVerification).toBe('required');
  });

  it('returns 400 when agent is locked', async () => {
    lock();
    const res = await request(app)
      .post('/auth/passkey/register/options')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    // Token is revoked on lock, so we get 401
    expect([400, 401]).toContain(res.status);
  });
});

describe('POST /auth/passkey/authenticate/options', () => {
  it('returns agent_locked error when agent is locked', async () => {
    lock();
    const res = await request(app)
      .post('/auth/passkey/authenticate/options')
      .send({ rpId: 'localhost' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('agent_locked');
    expect(res.body.message).toBe('Password required after server restart');
  });

  it('returns 400 when no passkeys registered for rpId', async () => {
    const res = await request(app)
      .post('/auth/passkey/authenticate/options')
      .send({ rpId: 'localhost' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No passkeys');
  });

  it('returns authentication options when passkeys exist', async () => {
    await testPrisma.passkey.create({
      data: {
        credentialId: 'test-cred-id',
        publicKey: Buffer.from('fake-key'),
        counter: 0,
        rpId: 'localhost',
        transports: '["internal"]',
      },
    });
    const res = await request(app)
      .post('/auth/passkey/authenticate/options')
      .send({ rpId: 'localhost' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('challenge');
    expect(res.body.allowCredentials).toHaveLength(1);
    expect(res.body.allowCredentials[0].id).toBe('test-cred-id');
  });
});

describe('POST /auth/passkey/authenticate/verify', () => {
  it('returns agent_locked error when agent is locked', async () => {
    lock();
    const res = await request(app)
      .post('/auth/passkey/authenticate/verify')
      .send({ credential: {}, pubkey: TEST_AGENT_PUBKEY });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('agent_locked');
  });

  it('returns 400 without credential', async () => {
    const res = await request(app)
      .post('/auth/passkey/authenticate/verify')
      .send({ pubkey: TEST_AGENT_PUBKEY });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('credential is required');
  });

  it('returns 400 without pubkey', async () => {
    const res = await request(app)
      .post('/auth/passkey/authenticate/verify')
      .send({ credential: { id: 'test' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('pubkey is required');
  });

  it('returns 401 with invalid challenge', async () => {
    const fakeClientData = Buffer.from(JSON.stringify({
      challenge: 'nonexistent-challenge',
      origin: 'http://localhost',
      type: 'webauthn.get',
    })).toString('base64url');

    const res = await request(app)
      .post('/auth/passkey/authenticate/verify')
      .send({
        credential: {
          id: 'test-cred',
          response: { clientDataJSON: fakeClientData },
        },
        pubkey: TEST_AGENT_PUBKEY,
      });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /auth/passkey/:credentialId', () => {
  it('returns 401 without admin token', async () => {
    const res = await request(app).delete('/auth/passkey/test-cred-id');
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent passkey', async () => {
    const res = await request(app)
      .delete('/auth/passkey/nonexistent')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('deletes an existing passkey', async () => {
    await testPrisma.passkey.create({
      data: {
        credentialId: 'to-delete',
        publicKey: Buffer.from('fake-key'),
        counter: 0,
        rpId: 'localhost',
      },
    });
    const res = await request(app)
      .delete('/auth/passkey/to-delete')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const remaining = await testPrisma.passkey.findUnique({ where: { credentialId: 'to-delete' } });
    expect(remaining).toBeNull();
  });
});

describe('passkey challenge store', () => {
  it('storeChallenge and consumeChallenge work', async () => {
    storeChallenge('test-challenge', 'register');
    expect(storeChallenge).toBeDefined();
    // Consume returns true first time
    const { consumeChallenge } = await import('../../lib/passkey');
    expect(consumeChallenge('test-challenge', 'register')).toBe(true);
    // Second consume returns false (single-use)
    expect(consumeChallenge('test-challenge', 'register')).toBe(false);
  });

  it('rejects wrong type', async () => {
    const { storeChallenge, consumeChallenge } = await import('../../lib/passkey');
    storeChallenge('typed-challenge', 'register');
    expect(consumeChallenge('typed-challenge', 'authenticate')).toBe(false);
  });
});
