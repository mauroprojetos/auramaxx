import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { cleanDatabase, createTestApp, setupAndUnlockWallet, testPrisma } from '../setup';

process.env.BYPASS_RATE_LIMIT = 'true';

const app = createTestApp();

describe('Import Endpoint Validation — POST /credentials/import', () => {
  let adminToken: string;

  beforeAll(async () => {
    process.env.BYPASS_RATE_LIMIT = 'true';
  });

  beforeEach(async () => {
    await cleanDatabase();
    const setup = await setupAndUnlockWallet();
    adminToken = setup.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('returns 400 when file is missing', async () => {
    const res = await request(app)
      .post('/credentials/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('format', '1password-csv')
      .field('agentId', 'primary');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('No file');
  });

  it('returns 400 for unsupported source', async () => {
    const res = await request(app)
      .post('/credentials/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source', 'unknown-source')
      .field('format', '1password-csv')
      .field('agentId', 'primary')
      .attach('file', Buffer.from('Title,URL\nSite,https://site.com'), 'import.csv');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Invalid source');
  });

  it('accepts iCloud CSV dry-run payload', async () => {
    const payload = `Title,URL,Username,Password,Notes
GitHub,https://github.com,alice,hunter2,dev account`;

    const res = await request(app)
      .post('/credentials/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source', 'icloud')
      .field('format', 'icloud-csv')
      .field('agentId', 'primary')
      .field('dryRun', 'true')
      .attach('file', Buffer.from(payload), 'icloud.csv');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.total).toBe(1);
    expect(Array.isArray(res.body.credentials)).toBe(true);
  });

  it('accepts LastPass CSV dry-run payload', async () => {
    const payload = `url,username,password,extra,name,grouping
https://example.com,alice,secret,note,Example,Work`;

    const res = await request(app)
      .post('/credentials/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source', 'lastpass')
      .field('format', 'lastpass-csv')
      .field('agentId', 'primary')
      .field('dryRun', 'true')
      .attach('file', Buffer.from(payload), 'lastpass.csv');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.total).toBe(1);
    expect(Array.isArray(res.body.credentials)).toBe(true);
  });

  it('returns 400 for unsupported format', async () => {
    const res = await request(app)
      .post('/credentials/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('format', 'unsupported-format')
      .field('agentId', 'primary')
      .attach('file', Buffer.from('Title,URL\nSite,https://site.com'), 'import.csv');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Invalid format');
  });

  it('returns 400 for source/format matrix mismatch', async () => {
    const res = await request(app)
      .post('/credentials/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source', 'chrome')
      .field('format', 'bitwarden-json')
      .field('agentId', 'primary')
      .attach('file', Buffer.from(JSON.stringify({ items: [] })), 'import.json');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("not supported for source 'chrome'");
  });

  it('returns 400 for invalid JSON payload', async () => {
    const res = await request(app)
      .post('/credentials/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('format', '1password-json')
      .field('agentId', 'primary')
      .attach('file', Buffer.from('{not valid json'), 'import.json');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Invalid 1password-json import payload');
  });

  it('returns 400 for invalid duplicateStrategy', async () => {
    const res = await request(app)
      .post('/credentials/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('format', '1password-csv')
      .field('agentId', 'primary')
      .field('duplicateStrategy', 'bad-strategy')
      .attach('file', Buffer.from('Title,URL\nSite,https://site.com'), 'import.csv');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Invalid duplicateStrategy');
  });

  it('returns 400 for invalid dryRun request shape', async () => {
    const res = await request(app)
      .post('/credentials/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('format', '1password-csv')
      .field('agentId', 'primary')
      .field('dryRun', 'maybe')
      .attach('file', Buffer.from('Title,URL\nSite,https://site.com'), 'import.csv');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('dryRun must be a boolean');
  });

  it('returns expected dry-run response shape', async () => {
    const payload = JSON.stringify({
      items: [{
        name: 'GitHub',
        login: {
          username: 'example-user',
          password: 'hunter2',
          uris: [{ uri: 'https://github.com' }],
        },
      }],
    });

    const res = await request(app)
      .post('/credentials/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('source', 'bitwarden')
      .field('format', 'bitwarden-json')
      .field('agentId', 'primary')
      .field('dryRun', 'true')
      .attach('file', Buffer.from(payload), 'import.json');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.duplicates).toBe('number');
    expect(Array.isArray(res.body.credentials)).toBe(true);
    expect(res.body.credentials.length).toBeGreaterThanOrEqual(1);
    expect(res.body.credentials[0]).toEqual(expect.objectContaining({
      name: expect.any(String),
      type: expect.any(String),
      fieldCount: expect.any(Number),
      isDuplicate: expect.any(Boolean),
    }));
  });
});
