/**
 * Credential & Agent Path Security Tests
 * =======================================
 *
 * V1 launch hardening: ensure credential IDs are validated,
 * path traversal is blocked, agent-scoped credential isolation
 * works correctly, and all credential locations resolve safely.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  cleanDatabase,
  createTestApp,
  encryptPasswordForTest,
  resetColdWallet,
  setupAndUnlockWallet,
  TEST_PASSWORD,
  testPrisma,
} from '../setup';
import { isValidCredentialId } from '../../lib/credentials';

const app = createTestApp();

// ---------------------------------------------------------------------------
// Unit: isValidCredentialId
// ---------------------------------------------------------------------------

describe('isValidCredentialId', () => {
  it('accepts valid credential ids', () => {
    expect(isValidCredentialId('cred-abcd1234')).toBe(true);
    expect(isValidCredentialId('cred-00000000')).toBe(true);
    expect(isValidCredentialId('cred-zzzzzzzz')).toBe(true);
  });

  it('rejects ids without cred- prefix', () => {
    expect(isValidCredentialId('abcd1234')).toBe(false);
    expect(isValidCredentialId('CRED-abcd1234')).toBe(false);
    expect(isValidCredentialId('Cred-abcd1234')).toBe(false);
  });

  it('rejects ids with wrong length', () => {
    expect(isValidCredentialId('cred-abc')).toBe(false);
    expect(isValidCredentialId('cred-abcd12345')).toBe(false);
    expect(isValidCredentialId('cred-')).toBe(false);
  });

  it('rejects ids with uppercase characters', () => {
    expect(isValidCredentialId('cred-ABCD1234')).toBe(false);
    expect(isValidCredentialId('cred-Abcd1234')).toBe(false);
  });

  it('rejects ids with special characters', () => {
    expect(isValidCredentialId('cred-abcd123!')).toBe(false);
    expect(isValidCredentialId('cred-abc.1234')).toBe(false);
    expect(isValidCredentialId('cred-abc/1234')).toBe(false);
    expect(isValidCredentialId('cred-abc\\1234')).toBe(false);
  });

  it('rejects path traversal attempts', () => {
    expect(isValidCredentialId('../etc/passwd')).toBe(false);
    expect(isValidCredentialId('cred-../../../')).toBe(false);
    expect(isValidCredentialId('..%2f..%2f..')).toBe(false);
    expect(isValidCredentialId('cred-..%2f..%')).toBe(false);
  });

  it('rejects empty and whitespace', () => {
    expect(isValidCredentialId('')).toBe(false);
    expect(isValidCredentialId('   ')).toBe(false);
    expect(isValidCredentialId(' cred-abcd1234 ')).toBe(false);
  });

  it('rejects null bytes and control characters', () => {
    expect(isValidCredentialId('cred-abc\x001234')).toBe(false);
    expect(isValidCredentialId('cred-abc\n1234')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// API-level: path traversal on credential endpoints
// ---------------------------------------------------------------------------

describe('Credential path traversal via API', () => {
  let adminToken: string;

  beforeAll(async () => {
    await cleanDatabase();
    resetColdWallet();
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  const TRAVERSAL_IDS = [
    '../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    'cred-../../../etc',
    '....//....//etc',
    'cred-abcd1234/../../',
    '%00cred-abcd1234',
    'cred-abcd1234%00.json',
  ];

  for (const maliciousId of TRAVERSAL_IDS) {
    it(`GET /credentials/${encodeURIComponent(maliciousId)} → 400`, async () => {
      const res = await request(app)
        .get(`/credentials/${encodeURIComponent(maliciousId)}`)
        .set('Authorization', `Bearer ${adminToken}`);

      // Should be rejected by id validation (400) not found (404)
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid credential id');
    });

    it(`POST /credentials/${encodeURIComponent(maliciousId)}/read → 400`, async () => {
      const res = await request(app)
        .post(`/credentials/${encodeURIComponent(maliciousId)}/read`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it(`DELETE /credentials/${encodeURIComponent(maliciousId)} → 400`, async () => {
      const res = await request(app)
        .delete(`/credentials/${encodeURIComponent(maliciousId)}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
    });
  }

  it('rejects credential creation with traversal in name (should not affect storage path)', async () => {
    // Name doesn't affect file path (id is auto-generated), but ensure it doesn't crash
    const res = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'note',
        name: '../../../etc/passwd',
        fields: [{ key: 'note_content', value: 'test' }],
      });

    // Should succeed — name is just metadata, id is generated safely
    expect(res.status).toBe(200);
    expect(res.body.credential.id).toMatch(/^cred-[a-z0-9]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// Agent-scoped credential isolation
// ---------------------------------------------------------------------------

describe('Agent-scoped credential isolation', () => {
  let adminToken: string;
  let agentAId: string;
  let agentBId: string;
  let credInA: string;
  let credInB: string;

  beforeAll(async () => {
    resetColdWallet();
    await cleanDatabase();
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create two agents
    const encA = encryptPasswordForTest('agent-a-password1');
    const resA = await request(app)
      .post('/setup/agent')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ encrypted: encA, name: 'PathTestA' });
    agentAId = resA.body.id;

    const encB = encryptPasswordForTest('agent-b-password1');
    const resB = await request(app)
      .post('/setup/agent')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ encrypted: encB, name: 'PathTestB' });
    agentBId = resB.body.id;

    // Create a credential in each agent
    const credResA = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: agentAId,
        type: 'note',
        name: 'Secret A',
        fields: [{ key: 'note_content', value: 'content-a' }],
      });
    credInA = credResA.body.credential.id;

    const credResB = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: agentBId,
        type: 'note',
        name: 'Secret B',
        fields: [{ key: 'note_content', value: 'content-b' }],
      });
    credInB = credResB.body.credential.id;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('listing agent A credentials does not include agent B credentials', async () => {
    const res = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ agent: agentAId });

    expect(res.status).toBe(200);
    const ids = (res.body.credentials as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(credInA);
    expect(ids).not.toContain(credInB);
  });

  it('listing agent B credentials does not include agent A credentials', async () => {
    const res = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ agent: agentBId });

    expect(res.status).toBe(200);
    const ids = (res.body.credentials as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(credInB);
    expect(ids).not.toContain(credInA);
  });

  it('credential from agent A is accessible by id', async () => {
    const res = await request(app)
      .get(`/credentials/${credInA}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.credential.name).toBe('Secret A');
  });

  it('credential from agent B is accessible by id', async () => {
    const res = await request(app)
      .get(`/credentials/${credInB}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.credential.name).toBe('Secret B');
  });
});

// ---------------------------------------------------------------------------
// Credential location paths (active / archive / recently_deleted)
// ---------------------------------------------------------------------------

describe('Credential location lifecycle paths', () => {
  let adminToken: string;
  let credId: string;

  beforeAll(async () => {
    resetColdWallet();
    await cleanDatabase();
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create a credential in primary agent
    const res = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'note',
        name: 'Lifecycle Test',
        fields: [{ key: 'note_content', value: 'lifecycle' }],
      });
    credId = res.body.credential.id;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('credential starts in active location', async () => {
    const res = await request(app)
      .get(`/credentials/${credId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.credential.id).toBe(credId);
  });

  it('DELETE from active archives credential (moves to archive)', async () => {
    // DELETE /credentials/:id with location=active (default) archives it
    const archiveRes = await request(app)
      .delete(`/credentials/${credId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(archiveRes.status).toBe(200);
    expect(archiveRes.body.action).toBe('archived');

    // Not in active listing
    const activeRes = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`);

    const activeIds = (activeRes.body.credentials as Array<{ id: string }>).map((c) => c.id);
    expect(activeIds).not.toContain(credId);
  });

  it('archived credential appears in archive location', async () => {
    const res = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ location: 'archive' });

    expect(res.status).toBe(200);
    const ids = (res.body.credentials as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(credId);
  });

  it('restoring moves credential back to active', async () => {
    const restoreRes = await request(app)
      .post(`/credentials/${credId}/restore`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.action).toBe('restored_to_active');

    const activeRes = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`);

    const activeIds = (activeRes.body.credentials as Array<{ id: string }>).map((c) => c.id);
    expect(activeIds).toContain(credId);
  });

  it('DELETE twice moves active→archive→recently_deleted', async () => {
    // First delete: active → archive
    const del1 = await request(app)
      .delete(`/credentials/${credId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del1.status).toBe(200);
    expect(del1.body.action).toBe('archived');

    // Second delete: archive → recently_deleted
    const del2 = await request(app)
      .delete(`/credentials/${credId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ location: 'archive' });
    expect(del2.status).toBe(200);
    expect(del2.body.action).toBe('moved_to_recently_deleted');

    // Not in active
    const activeRes = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`);
    const activeIds = (activeRes.body.credentials as Array<{ id: string }>).map((c) => c.id);
    expect(activeIds).not.toContain(credId);

    // In recently_deleted
    const deletedRes = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ location: 'recently_deleted' });
    expect(deletedRes.status).toBe(200);
    const deletedIds = (deletedRes.body.credentials as Array<{ id: string }>).map((c) => c.id);
    expect(deletedIds).toContain(credId);
  });

  it('rejects invalid location parameter', async () => {
    const res = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ location: '../etc' });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Agent path: invalid agent IDs
// ---------------------------------------------------------------------------

describe('Invalid agent ID handling', () => {
  let adminToken: string;

  beforeAll(async () => {
    resetColdWallet();
    await cleanDatabase();
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('listing credentials with non-existent agent returns empty', async () => {
    const res = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ agent: 'nonexistent-agent-id' });

    expect(res.status).toBe(200);
    expect(res.body.credentials).toEqual([]);
  });

  it('unlock with traversal agent id returns error', async () => {
    const encrypted = encryptPasswordForTest(TEST_PASSWORD);
    const res = await request(app)
      .post('/unlock/../../../etc')
      .send({ pubkey: 'test', encrypted });

    // Should be 404 (no matching route) or 400/401
    expect([400, 401, 404]).toContain(res.status);
  });

  it('lock with traversal agent id returns error', async () => {
    const res = await request(app)
      .post('/lock/../../../etc')
      .set('Authorization', `Bearer ${adminToken}`)
      .send();

    expect([400, 401, 404]).toContain(res.status);
  });
});
