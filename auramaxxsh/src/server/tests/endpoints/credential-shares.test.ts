import fs from 'fs';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { DATA_PATHS } from '../../lib/config';
import { cleanDatabase, createTestApp, setupAndUnlockWallet, testPrisma } from '../setup';
import { createSecretGist, SecretGistError } from '../../lib/secret-gist-share';

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
      url: 'https://gist.github.com/mock/credential-share',
      marker: '||:|||:|:||||',
      identifier: 'ABC123DEF4',
      title: 'AURAMAXX.SH :: ||:|||:|:|||| :: ABC123DEF4 :: Shared Login',
      filename: 'auramaxx-sh-abc123def4.txt',
      content: 'AURAMAXX.SH :: ||:|||:|:|||| :: ABC123DEF4\n',
    })),
    SecretGistError: MockSecretGistError,
  };
});

const app = createTestApp();

describe('Credential Share Endpoints', () => {
  let adminToken: string;

  beforeEach(async () => {
    await cleanDatabase();
    const setup = await setupAndUnlockWallet();
    adminToken = setup.adminToken;
    vi.mocked(createSecretGist).mockResolvedValue({
      url: 'https://gist.github.com/mock/credential-share',
      marker: '||:|||:|:||||',
      identifier: 'ABC123DEF4',
      title: 'AURAMAXX.SH :: ||:|||:|:|||| :: ABC123DEF4 :: Shared Login',
      filename: 'auramaxx-sh-abc123def4.txt',
      content: 'AURAMAXX.SH :: ||:|||:|:|||| :: ABC123DEF4\n',
    });
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  async function createLoginCredential() {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Shared Login',
        meta: { url: 'https://example.com' },
        fields: [
          { key: 'username', value: 'example-user', type: 'text', sensitive: false },
          { key: 'password', value: 'hunter2', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    return createRes.body.credential.id as string;
  }

  async function createShare(credentialId: string, payload?: Record<string, unknown>) {
    const res = await request(app)
      .post('/credential-shares')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        credentialId,
        expiresAfter: '1h',
        accessMode: 'anyone',
        oneTimeOnly: false,
        ...payload,
      });
    expect(res.status).toBe(200);
    return res.body.share.token as string;
  }

  it('creates and reads a public share link', async () => {
    const credentialId = await createLoginCredential();
    const token = await createShare(credentialId);

    const metaRes = await request(app).get(`/credential-shares/${token}`);
    expect(metaRes.status).toBe(200);
    expect(metaRes.body.share.passwordRequired).toBe(false);
    expect(metaRes.body.share.credentialId).toBe(credentialId);

    const readRes = await request(app)
      .post(`/credential-shares/${token}/read`)
      .send({});
    expect(readRes.status).toBe(200);
    expect(readRes.body.credential.id).toBe(credentialId);
    expect(readRes.body.credential.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'password', value: 'hunter2' }),
      ]),
    );
  });

  it('rejects invalid credential id format for share creation', async () => {
    const res = await request(app)
      .post('/credential-shares')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        credentialId: '../etc/passwd',
        expiresAfter: '1h',
        accessMode: 'anyone',
      });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('credentialId format is invalid');
  });

  it('requires a password when share access mode is password', async () => {
    const credentialId = await createLoginCredential();
    const token = await createShare(credentialId, {
      accessMode: 'password',
      password: 'share-pass',
    });

    const noPasswordRes = await request(app)
      .post(`/credential-shares/${token}/read`)
      .send({});
    expect(noPasswordRes.status).toBe(401);
    expect(noPasswordRes.body.reason).toBe('password_required');

    const wrongPasswordRes = await request(app)
      .post(`/credential-shares/${token}/read`)
      .send({ password: 'wrong-pass' });
    expect(wrongPasswordRes.status).toBe(401);
    expect(wrongPasswordRes.body.reason).toBe('invalid_password');

    const goodPasswordRes = await request(app)
      .post(`/credential-shares/${token}/read`)
      .send({ password: 'share-pass' });
    expect(goodPasswordRes.status).toBe(200);
    expect(goodPasswordRes.body.credential.id).toBe(credentialId);
  });

  it('enforces one-time view links', async () => {
    const credentialId = await createLoginCredential();
    const token = await createShare(credentialId, { oneTimeOnly: true });

    const firstRead = await request(app)
      .post(`/credential-shares/${token}/read`)
      .send({});
    expect(firstRead.status).toBe(200);

    const secondRead = await request(app)
      .post(`/credential-shares/${token}/read`)
      .send({});
    expect(secondRead.status).toBe(410);
    expect(secondRead.body.reason).toBe('already_viewed');

    const metaAfterRead = await request(app).get(`/credential-shares/${token}`);
    expect(metaAfterRead.status).toBe(410);
    expect(metaAfterRead.body.reason).toBe('already_viewed');
  });

  it('enforces link expiry', async () => {
    const credentialId = await createLoginCredential();
    const token = await createShare(credentialId);

    const filePath = path.join(DATA_PATHS.credentialShares, `${token}.json`);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { expiresAt: number };
    raw.expiresAt = Date.now() - 1000;
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2));

    const metaRes = await request(app).get(`/credential-shares/${token}`);
    expect(metaRes.status).toBe(410);
    expect(metaRes.body.reason).toBe('expired');

    const readRes = await request(app)
      .post(`/credential-shares/${token}/read`)
      .send({});
    expect(readRes.status).toBe(410);
    expect(readRes.body.reason).toBe('expired');
  });

  it('creates gist-first share bundle', async () => {
    const credentialId = await createLoginCredential();
    const res = await request(app)
      .post('/credential-shares/gist')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        credentialId,
        expiresAfter: '1h',
        accessMode: 'anyone',
        oneTimeOnly: false,
        shareBaseUrl: 'https://dashboard.example.com',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.gist.url).toBe('https://gist.github.com/mock/credential-share');
    expect(res.body.gist.title).toContain('AURAMAXX.SH');
    expect(res.body.link).toMatch(/^https:\/\/dashboard\.example\.com\/share\//);
    expect(vi.mocked(createSecretGist)).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId,
        credentialName: 'Shared Login',
        shareUrl: expect.stringMatching(/^https:\/\/dashboard\.example\.com\/share\//),
        fields: expect.arrayContaining([
          expect.objectContaining({ key: 'password', value: 'hunter2' }),
        ]),
      }),
    );
  });

  it('returns setup error metadata when gh auth is missing for gist flow', async () => {
    vi.mocked(createSecretGist).mockRejectedValueOnce(
      new SecretGistError(
        'GH_AUTH_REQUIRED',
        'GitHub CLI is not authenticated for gist creation.',
        'Run `gh auth login` and retry.',
      ),
    );

    const credentialId = await createLoginCredential();
    const res = await request(app)
      .post('/credential-shares/gist')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        credentialId,
        expiresAfter: '1h',
        accessMode: 'anyone',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('GH_AUTH_REQUIRED');
    expect(res.body.error).toContain('not authenticated');
    expect(res.body.remediation).toContain('gh auth login');
  });
});
