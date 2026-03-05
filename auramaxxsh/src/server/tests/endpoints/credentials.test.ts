import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
} from 'crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createAdminToken } from '../../lib/auth';
import {
  cleanDatabase,
  createTestApp,
  createToken,
  encryptPasswordForTest,
  setupAndUnlockWallet,
  TEST_AGENT_PRIVATE_KEY,
  TEST_PASSWORD,
  testPrisma,
} from '../setup';
import { ESCALATION_ROUTE_IDS } from '../../lib/escalation-route-registry';
import { NOTE_CONTENT_KEY } from '../../../../shared/credential-field-schema';

const app = createTestApp();

interface HybridEnvelope {
  v: number;
  alg: string;
  key: string;
  iv: string;
  tag: string;
  data: string;
}

function decryptEnvelope(encryptedBase64: string, privateKeyPem: string): string {
  const decoded = Buffer.from(encryptedBase64, 'base64');
  const envelope = JSON.parse(decoded.toString('utf8')) as HybridEnvelope;
  if (envelope.v !== 1 || envelope.alg !== 'RSA-OAEP/AES-256-GCM') {
    throw new Error(`Unexpected envelope: v=${envelope.v} alg=${envelope.alg}`);
  }
  const sessionKey = privateDecrypt(
    {
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(envelope.key, 'base64'),
  );
  const decipher = createDecipheriv('aes-256-gcm', sessionKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

function decryptCredentialPayload(encryptedBase64: string, privateKeyPem: string) {
  return JSON.parse(decryptEnvelope(encryptedBase64, privateKeyPem)) as {
    id: string;
    agentId: string;
    type: string;
    fields: Array<{ key: string; value: string }>;
    health?: {
      status: string;
      flags: {
        weak: boolean;
        reused: boolean;
        breached: boolean;
        unknown: boolean;
      };
      evidence: {
        reuseCount: number;
        breachCount: number | null;
        weakReasons: string[];
      };
      lastScannedAt: string | null;
      engineVersion: string;
    };
  };
}

describe('Credential Endpoints', () => {
  let adminToken: string;

  beforeEach(async () => {
    await cleanDatabase();
    const setup = await setupAndUnlockWallet();
    adminToken = setup.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('should create linked agents without requiring explicit password input', async () => {
    const createRes = await request(app)
      .post('/agents/credential')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'agent-linked',
        mode: 'linked',
      });

    expect(createRes.status).toBe(200);
    expect(createRes.body.agent.mode).toBe('linked');
    expect(createRes.body.agent.parentAgentId).toBe('primary');
    expect(createRes.body.agent.linkedTo).toBe('primary');
  });

  it('should reject invalid credential id formats on id-based routes', async () => {
    const res = await request(app)
      .get('/credentials/not-a-valid-id')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid credential id format');
  });

  it('should not create linked agents after primary agent is explicitly locked', async () => {
    const lockRes = await request(app)
      .post('/lock/primary')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(lockRes.status).toBe(200);

    const createRes = await request(app)
      .post('/agents/credential')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'agent-linked-after-primary-lock',
        mode: 'linked',
      });

    expect(createRes.status).toBe(401);
    expect(createRes.body.error).toContain('Primary agent must be unlocked');
  });

  it('should support explicit parentAgentId while preserving legacy linkedTo compatibility', async () => {
    const parentRes = await request(app)
      .post('/agents/credential')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'ops-parent',
        mode: 'linked',
      });
    expect(parentRes.status).toBe(200);
    const parentAgentId = parentRes.body.agent.id as string;

    const childRes = await request(app)
      .post('/agents/credential')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'ops-child',
        mode: 'linked',
        parentAgentId,
      });

    expect(childRes.status).toBe(200);
    expect(childRes.body.agent.mode).toBe('linked');
    expect(childRes.body.agent.parentAgentId).toBe(parentAgentId);
    expect(childRes.body.agent.linkedTo).toBe(parentAgentId);

    const legacyChildRes = await request(app)
      .post('/agents/credential')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'ops-child-legacy',
        mode: 'linked',
        linkedTo: parentAgentId,
      });

    expect(legacyChildRes.status).toBe(200);
    expect(legacyChildRes.body.agent.parentAgentId).toBe(parentAgentId);
    expect(legacyChildRes.body.agent.linkedTo).toBe(parentAgentId);
  });

  it('should require password for independent agent creation', async () => {
    const invalidParent = await request(app)
      .post('/agents/credential')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'ops-independent-invalid',
        mode: 'independent',
        parentAgentId: 'primary',
      });
    expect(invalidParent.status).toBe(400);
    expect(invalidParent.body.error).toContain('independent agents cannot set parentAgentId/linkedTo');

    const missingPassword = await request(app)
      .post('/agents/credential')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'ops-independent',
        mode: 'independent',
      });
    expect(missingPassword.status).toBe(400);
    expect(missingPassword.body.error).toContain('Encrypted password is required');

    const plaintextPassword = await request(app)
      .post('/agents/credential')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        password: `${TEST_PASSWORD}-independent-plaintext`,
        name: 'ops-independent-plaintext',
        mode: 'independent',
      });
    expect(plaintextPassword.status).toBe(400);
    expect(plaintextPassword.body.error).toContain('Encrypted password is required');

    const createRes = await request(app)
      .post('/agents/credential')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        encrypted: encryptPasswordForTest(`${TEST_PASSWORD}-independent`),
        name: 'ops-independent',
        mode: 'independent',
      });
    expect(createRes.status).toBe(200);
    expect(createRes.body.agent.mode).toBe('independent');
  });

  it('should support full credential flow with scope-filtered list and encrypted read', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pubkeyBase64 = Buffer.from(publicKey, 'utf8').toString('base64');

    const agentRes = await request(app)
      .post('/agents/credential')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        encrypted: encryptPasswordForTest(TEST_PASSWORD),
        name: 'work',
      });
    expect(agentRes.status).toBe(200);
    const agentId = agentRes.body.agent.id as string;

    const agentListRes = await request(app)
      .get('/agents/credential')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(agentListRes.status).toBe(200);
    expect(Array.isArray(agentListRes.body.agents)).toBe(true);
    expect(agentListRes.body.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: agentId,
          name: 'work',
        }),
      ]),
    );

    const tokenRes = await request(app)
      .post('/actions/token')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'cred-agent',
        permissions: ['secret:read', 'secret:write'],
        credentialAccess: {
          read: [`agent:${agentId}`],
          write: [`agent:${agentId}`],
          excludeFields: [],
        },
        pubkey: pubkeyBase64,
      });
    expect(tokenRes.status).toBe(200);
    const token = decryptEnvelope(tokenRes.body.encryptedToken as string, privateKey);

    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({
        agentId,
        type: 'login',
        name: 'GitHub',
        meta: { tags: ['deploy'], url: 'https://github.com' },
        fields: [
          { key: 'username', value: 'example-user', type: 'text', sensitive: false },
          { key: 'password', value: 'hunter2', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const outOfScopeRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'note',
        name: 'Internal',
        meta: { tags: ['ops'] },
        fields: [{ key: 'content', value: 'should-not-list', type: 'text', sensitive: true }],
      });
    expect(outOfScopeRes.status).toBe(200);
    const outOfScopeId = outOfScopeRes.body.credential.id as string;

    const listRes = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    const listedIds = listRes.body.credentials.map((credential: { id: string }) => credential.id);
    expect(listedIds).toContain(credentialId);
    expect(listedIds).not.toContain(outOfScopeId);

    const readRes = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(readRes.status).toBe(200);
    expect(readRes.body.encrypted).toBeTypeOf('string');
    const decrypted = decryptCredentialPayload(readRes.body.encrypted, privateKey);
    expect(decrypted.id).toBe(credentialId);
    expect(decrypted.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'password', value: 'hunter2' }),
      ]),
    );

    const deleteRes = await request(app)
      .delete(`/credentials/${credentialId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(deleteRes.status).toBe(200);

    const getDeletedRes = await request(app)
      .get(`/credentials/${credentialId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(getDeletedRes.status).toBe(404);
  });

  it('should only request human approval when excluded fields are explicitly requested', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pubkeyBase64 = Buffer.from(publicKey, 'utf8').toString('base64');

    const loginRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Default Login',
        meta: { tags: ['default'] },
        fields: [
          { key: 'password', value: 'p@ss', type: 'secret', sensitive: true },
          { key: 'notes', value: 'shown', type: 'text', sensitive: true },
        ],
      });
    expect(loginRes.status).toBe(200);
    const loginId = loginRes.body.credential.id as string;

    const cardRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'card',
        name: 'Default Card',
        meta: { tags: ['default'] },
        fields: [
          { key: 'number', value: '4111111111111111', type: 'text', sensitive: true },
          { key: 'cvv', value: '123', type: 'secret', sensitive: true },
        ],
      });
    expect(cardRes.status).toBe(200);
    const cardId = cardRes.body.credential.id as string;

    const tokenRes = await request(app)
      .post('/actions/token')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'default-agent',
        permissions: ['secret:read'],
        pubkey: pubkeyBase64,
      });
    expect(tokenRes.status).toBe(200);
    const token = decryptEnvelope(tokenRes.body.encryptedToken as string, privateKey);

    const listRes = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.credentials.some((credential: { id: string }) => credential.id === loginId)).toBe(true);
    expect(listRes.body.credentials.some((credential: { id: string }) => credential.id === cardId)).toBe(true);

    const loginRead = await request(app)
      .post(`/credentials/${loginId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(loginRead.status).toBe(200);
    const loginDecrypted = decryptCredentialPayload(loginRead.body.encrypted, privateKey);
    expect(loginDecrypted.fields.map((field) => field.key)).not.toContain('password');
    expect(loginDecrypted.fields.map((field) => field.key)).toContain('notes');

    const cardRead = await request(app)
      .post(`/credentials/${cardId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(cardRead.status).toBe(200);
    const cardDecrypted = decryptCredentialPayload(cardRead.body.encrypted, privateKey);
    expect(cardDecrypted.fields.map((field) => field.key)).toContain('number');
    expect(cardDecrypted.fields.map((field) => field.key)).not.toContain('cvv');

    const loginExplicitRead = await request(app)
      .post(`/credentials/${loginId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({ requestedFields: ['password'] });
    expect(loginExplicitRead.status).toBe(403);
    expect(loginExplicitRead.body.reasonCode).toBe('DENY_EXCLUDED_FIELD');
    expect(loginExplicitRead.body.requiresHumanApproval).toBe(true);
    const loginReqId = (loginExplicitRead.body.reqId ?? loginExplicitRead.body.requestId) as string | undefined;
    expect(typeof loginReqId).toBe('string');
    expect(typeof loginExplicitRead.body.secret).toBe('string');
    const expectedPollUrl = `http://127.0.0.1:4242/auth/${encodeURIComponent(loginReqId as string)}`;
    expect(loginExplicitRead.body.pollUrl).toBe(expectedPollUrl);
    expect(loginExplicitRead.body.claim).toMatchObject({
      method: 'GET',
      endpoint: `/auth/${encodeURIComponent(loginReqId as string)}`,
    });
    expect(loginExplicitRead.body.approvalFlow?.mode).toBe('one_time_scoped_read');
    expect(loginExplicitRead.body.requestedFields).toEqual(expect.arrayContaining(['password']));
    expect(loginExplicitRead.body.effectiveExcludeFields).toEqual(expect.arrayContaining(['password']));

    const loginApproval = await testPrisma.humanAction.findUnique({
      where: { id: loginReqId as string },
    });
    expect(loginApproval?.type).toBe('auth');
    expect(loginApproval?.status).toBe('pending');
    const loginApprovalMeta = JSON.parse(loginApproval!.metadata || '{}') as {
      credentialId?: string;
      requestedFields?: string[];
      ttl?: number;
      credentialAccess?: { read?: string[]; excludeFields?: string[]; maxReads?: number; ttl?: number };
    };
    expect(loginApprovalMeta.credentialId).toBe(loginId);
    expect(loginApprovalMeta.requestedFields).toEqual(expect.arrayContaining(['password']));
    expect(loginApprovalMeta.ttl).toBe(300);
    expect(loginApprovalMeta.credentialAccess?.read).toEqual([loginId]);
    expect(loginApprovalMeta.credentialAccess?.excludeFields || []).not.toContain('password');
    expect(loginApprovalMeta.credentialAccess?.maxReads).toBe(1);
    expect(loginApprovalMeta.credentialAccess?.ttl).toBe(300);

    const cardExplicitRead = await request(app)
      .post(`/credentials/${cardId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({ requestedFields: ['cvv'] });
    expect(cardExplicitRead.status).toBe(403);
    expect(cardExplicitRead.body.reasonCode).toBe('DENY_EXCLUDED_FIELD');
    expect(cardExplicitRead.body.requestedFields).toEqual(expect.arrayContaining(['cvv']));
  });

  it('should issue scoped temporary read access after excluded-field approval', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pubkeyBase64 = Buffer.from(publicKey, 'utf8').toString('base64');

    const primaryRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Scoped Approval Login',
        fields: [
          { key: 'username', value: 'agent-user', type: 'text', sensitive: false },
          { key: 'password', value: 'scoped-secret', type: 'secret', sensitive: true },
        ],
      });
    expect(primaryRes.status).toBe(200);
    const credentialId = primaryRes.body.credential.id as string;

    const secondaryRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Out of Scope Login',
        fields: [
          { key: 'username', value: 'blocked-user', type: 'text', sensitive: false },
          { key: 'password', value: 'blocked-secret', type: 'secret', sensitive: true },
        ],
      });
    expect(secondaryRes.status).toBe(200);
    const outOfScopeCredentialId = secondaryRes.body.credential.id as string;

    const tokenRes = await request(app)
      .post('/actions/token')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'excluded-field-approver',
        permissions: ['secret:read'],
        pubkey: pubkeyBase64,
      });
    expect(tokenRes.status).toBe(200);
    const token = decryptEnvelope(tokenRes.body.encryptedToken as string, privateKey);

    const deniedRead = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({ requestedFields: ['password'] });
    expect(deniedRead.status).toBe(403);
    expect(deniedRead.body.reasonCode).toBe('DENY_EXCLUDED_FIELD');
    expect(deniedRead.body.routeId).toBe(ESCALATION_ROUTE_IDS.CREDENTIALS_READ_EXCLUDED_FIELD);
    expect(deniedRead.body.routeContractId).toBe('credentials.read');
    expect(deniedRead.body.requestedPolicySource).toBe('derived_403');
    expect(typeof deniedRead.body.policyHash).toBe('string');
    expect(deniedRead.body.compilerVersion).toBe('v1');
    const requestId = (deniedRead.body.reqId ?? deniedRead.body.requestId) as string;
    const secret = deniedRead.body.secret as string;

    const approveRes = await request(app)
      .post(`/actions/${requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);

    const pollRes = await request(app)
      .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('approved');
    expect(typeof pollRes.body.encryptedToken).toBe('string');
    const scopedToken = decryptEnvelope(pollRes.body.encryptedToken as string, privateKey);

    const replayClaim = await request(app)
      .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);
    expect(replayClaim.status).toBe(410);

    const scopedRead = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${scopedToken}`)
      .send({});
    expect(scopedRead.status).toBe(200);
    const scopedPayload = decryptCredentialPayload(scopedRead.body.encrypted, privateKey);
    expect(scopedPayload.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'password', value: 'scoped-secret' }),
      ]),
    );

    const replayScopedRead = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${scopedToken}`)
      .send({});
    expect(replayScopedRead.status).toBe(403);
    expect(replayScopedRead.body.reasonCode).toBe('TOKEN_MAX_READS_EXCEEDED');

    const outOfScopeRead = await request(app)
      .post(`/credentials/${outOfScopeCredentialId}/read`)
      .set('Authorization', `Bearer ${scopedToken}`)
      .send({});
    expect(outOfScopeRead.status).toBe(403);
    expect(outOfScopeRead.body.errorCode).toBe('operation_binding_mismatch');
    expect(outOfScopeRead.body.requiresHumanApproval).toBe(false);
    expect(outOfScopeRead.body.approvalScope).toBe('one_shot_read');
    expect(outOfScopeRead.body.policyHash).toBe(deniedRead.body.policyHash);
    expect(outOfScopeRead.body.compilerVersion).toBe(deniedRead.body.compilerVersion);

    const auditRows = await testPrisma.credentialAccessAudit.findMany({
      where: { credentialId },
      orderBy: { timestamp: 'asc' },
      select: { reasonCode: true, httpStatus: true },
    });
    expect(auditRows.some((row) => row.reasonCode === 'DENY_EXCLUDED_FIELD' && row.httpStatus === 403)).toBe(true);
    expect(auditRows.some((row) => row.reasonCode === 'ALLOW' && row.httpStatus === 200)).toBe(true);
    expect(auditRows.some((row) => row.reasonCode === 'TOKEN_MAX_READS_EXCEEDED' && row.httpStatus === 403)).toBe(true);
  });

  it('rejects client requestedPolicy when requestedPolicySource is derived_403', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pubkeyBase64 = Buffer.from(publicKey, 'utf8').toString('base64');

    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Derived Policy Reject Login',
        fields: [
          { key: 'username', value: 'user', type: 'text', sensitive: false },
          { key: 'password', value: 'secret', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const tokenRes = await request(app)
      .post('/actions/token')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'derived-policy-test',
        permissions: ['secret:read'],
        pubkey: pubkeyBase64,
      });
    expect(tokenRes.status).toBe(200);
    const token = decryptEnvelope(tokenRes.body.encryptedToken as string, privateKey);

    const deniedRead = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        requestedFields: ['password'],
        requestedPolicySource: 'derived_403',
        requestedPolicy: {
          permissions: ['admin:*'],
        },
      });

    expect(deniedRead.status).toBe(400);
    expect(deniedRead.body.errorCode).toBe('client_policy_not_allowed_for_derived_source');
  });

  it('rejects malformed requestedPolicy input when requestedPolicySource is derived_403', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pubkeyBase64 = Buffer.from(publicKey, 'utf8').toString('base64');

    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Derived Malformed Policy Login',
        fields: [
          { key: 'username', value: 'user', type: 'text', sensitive: false },
          { key: 'password', value: 'secret', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const tokenRes = await request(app)
      .post('/actions/token')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'derived-policy-malformed-test',
        permissions: ['secret:read'],
        pubkey: pubkeyBase64,
      });
    expect(tokenRes.status).toBe(200);
    const token = decryptEnvelope(tokenRes.body.encryptedToken as string, privateKey);

    const deniedRead = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        requestedFields: ['password'],
        requestedPolicySource: 'derived_403',
        requestedPolicy: 'bad-value',
      });

    expect(deniedRead.status).toBe(400);
    expect(deniedRead.body.errorCode).toBe('client_policy_not_allowed_for_derived_source');
  });

  it('rejects requestedPolicy input for one-shot credential read escalation regardless of source hint', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pubkeyBase64 = Buffer.from(publicKey, 'utf8').toString('base64');

    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Agent Policy Login',
        fields: [
          { key: 'username', value: 'user', type: 'text', sensitive: false },
          { key: 'password', value: 'secret', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const tokenRes = await request(app)
      .post('/actions/token')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'agent-policy-test',
        permissions: ['secret:read'],
        pubkey: pubkeyBase64,
      });
    expect(tokenRes.status).toBe(200);
    const token = decryptEnvelope(tokenRes.body.encryptedToken as string, privateKey);

    const agentPolicyAttempt = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        requestedFields: ['password'],
        requestedPolicySource: 'agent',
        requestedPolicy: {
          permissions: ['secret:read'],
          credentialAccess: {
            read: [credentialId],
            write: [credentialId],
            excludeFields: [],
            ttl: 999,
            maxReads: 99,
          },
          ttlSeconds: 999,
          maxUses: 99,
        },
      });

    expect(agentPolicyAttempt.status).toBe(400);
    expect(agentPolicyAttempt.body.errorCode).toBe('client_policy_not_allowed_for_derived_source');
    expect(agentPolicyAttempt.body.requestedPolicySource).toBe('derived_403');

    const elevatedPolicyAttempt = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        requestedFields: ['password'],
        requestedPolicySource: 'agent',
        requestedPolicy: {
          permissions: ['admin:*'],
        },
      });
    expect(elevatedPolicyAttempt.status).toBe(400);
    expect(elevatedPolicyAttempt.body.errorCode).toBe('client_policy_not_allowed_for_derived_source');
    expect(elevatedPolicyAttempt.body.requestedPolicySource).toBe('derived_403');
  });

  it('should issue scoped temporary TOTP access after totp permission approval', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pubkeyBase64 = Buffer.from(publicKey, 'utf8').toString('base64');

    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'TOTP Escalation Login',
        sensitiveFields: [
          { key: 'totp', value: 'JBSWY3DPEHPK3PXP', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const outOfScopeCreateRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'TOTP Out-of-Scope Login',
        sensitiveFields: [
          { key: 'totp', value: 'JBSWY3DPEHPK3PXP', type: 'secret', sensitive: true },
        ],
      });
    expect(outOfScopeCreateRes.status).toBe(200);
    const outOfScopeCredentialId = outOfScopeCreateRes.body.credential.id as string;

    const tokenRes = await request(app)
      .post('/actions/token')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'totp-escalation-agent',
        permissions: ['secret:read'],
        pubkey: pubkeyBase64,
      });
    expect(tokenRes.status).toBe(200);
    const token = decryptEnvelope(tokenRes.body.encryptedToken as string, privateKey);

    const deniedTotp = await request(app)
      .post(`/credentials/${credentialId}/totp`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(deniedTotp.status).toBe(403);
    expect(deniedTotp.body.reasonCode).toBe('TOKEN_PERMISSION_DENIED');
    expect(deniedTotp.body.routeId).toBe(ESCALATION_ROUTE_IDS.CREDENTIALS_TOTP_PERMISSION_DENIED);
    expect(deniedTotp.body.requiresHumanApproval).toBe(true);
    expect(deniedTotp.body.approvalScope).toBe('one_shot_read');
    expect(deniedTotp.body.routeContractId).toBe('credentials.totp');
    expect(deniedTotp.body.claimStatus).toBe('pending');
    expect(deniedTotp.body.retryReady).toBe(false);
    expect(deniedTotp.body.requestedPolicySource).toBe('derived_403');
    expect(typeof deniedTotp.body.policyHash).toBe('string');
    expect(deniedTotp.body.compilerVersion).toBe('v1');
    const requestId = (deniedTotp.body.reqId ?? deniedTotp.body.requestId) as string;
    const secret = deniedTotp.body.secret as string;

    const approveRes = await request(app)
      .post(`/actions/${requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);

    const claimRes = await request(app)
      .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.status).toBe('approved');
    expect(typeof claimRes.body.encryptedToken).toBe('string');
    const scopedToken = decryptEnvelope(claimRes.body.encryptedToken as string, privateKey);

    const approvedTotp = await request(app)
      .post(`/credentials/${credentialId}/totp`)
      .set('Authorization', `Bearer ${scopedToken}`)
      .send({});
    expect(approvedTotp.status).toBe(200);
    expect(typeof approvedTotp.body.code).toBe('string');
    expect(typeof approvedTotp.body.remaining).toBe('number');

    const replayTotp = await request(app)
      .post(`/credentials/${credentialId}/totp`)
      .set('Authorization', `Bearer ${scopedToken}`)
      .send({});
    expect(replayTotp.status).toBe(403);
    expect(replayTotp.body.reasonCode).toBe('TOKEN_MAX_READS_EXCEEDED');

    const outOfScopeTotp = await request(app)
      .post(`/credentials/${outOfScopeCredentialId}/totp`)
      .set('Authorization', `Bearer ${scopedToken}`)
      .send({});
    expect(outOfScopeTotp.status).toBe(403);
    expect(outOfScopeTotp.body.errorCode).toBe('operation_binding_mismatch');
    expect(outOfScopeTotp.body.requiresHumanApproval).toBe(false);
    expect(outOfScopeTotp.body.approvalScope).toBe('one_shot_read');
    expect(outOfScopeTotp.body.policyHash).toBe(deniedTotp.body.policyHash);
    expect(outOfScopeTotp.body.compilerVersion).toBe(deniedTotp.body.compilerVersion);
  });

  it('should return explicit rejected status when excluded-field approval is denied', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pubkeyBase64 = Buffer.from(publicKey, 'utf8').toString('base64');

    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Reject Approval Login',
        fields: [
          { key: 'username', value: 'reject-user', type: 'text', sensitive: false },
          { key: 'password', value: 'reject-secret', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const tokenRes = await request(app)
      .post('/actions/token')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'excluded-field-reject',
        permissions: ['secret:read'],
        pubkey: pubkeyBase64,
      });
    expect(tokenRes.status).toBe(200);
    const token = decryptEnvelope(tokenRes.body.encryptedToken as string, privateKey);

    const deniedRead = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({ requestedFields: ['password'] });
    expect(deniedRead.status).toBe(403);
    expect(deniedRead.body.reasonCode).toBe('DENY_EXCLUDED_FIELD');
    expect(deniedRead.body.routeId).toBe(ESCALATION_ROUTE_IDS.CREDENTIALS_READ_EXCLUDED_FIELD);
    expect(deniedRead.body.requestedPolicySource).toBe('derived_403');
    const requestId = (deniedRead.body.reqId ?? deniedRead.body.requestId) as string;
    const secret = deniedRead.body.secret as string;

    const rejectRes = await request(app)
      .post(`/actions/${requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: false });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.approved).toBe(false);

    const pollRes = await request(app)
      .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('rejected');
    expect(String(pollRes.body.message || '')).toContain('rejected');
  });

  it('should include login password for admin token reads', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const adminReadToken = await createAdminToken(publicKey);

    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Admin Read Login',
        meta: { tags: ['admin-read'] },
        fields: [
          { key: 'username', value: 'example-user', type: 'text', sensitive: false },
          { key: 'password', value: 'hunter2', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const readRes = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${adminReadToken}`)
      .send({});
    expect(readRes.status).toBe(200);

    const decrypted = decryptCredentialPayload(readRes.body.encrypted, privateKey);
    const keys = decrypted.fields.map((field) => field.key);
    expect(keys).toContain('password');
    expect(decrypted.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'password', value: 'hunter2' }),
      ]),
    );
  });

  it('should enforce oauth2 primary-agent and expires_at validation on create/update', async () => {
    const nonPrimaryAgentRes = await request(app)
      .post('/agents/credential')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        encrypted: encryptPasswordForTest(TEST_PASSWORD),
        name: 'work',
      });
    expect(nonPrimaryAgentRes.status).toBe(200);
    const nonPrimaryAgentId = nonPrimaryAgentRes.body.agent.id as string;

    const nonPrimaryCreate = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: nonPrimaryAgentId,
        type: 'oauth2',
        name: 'OAuth App',
        meta: {
          token_endpoint: 'https://oauth.example.com/token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
        fields: [
          { key: 'access_token', value: 'access', type: 'secret', sensitive: true },
          { key: 'refresh_token', value: 'refresh', type: 'secret', sensitive: true },
          { key: 'client_id', value: 'cid', type: 'secret', sensitive: true },
          { key: 'client_secret', value: 'csecret', type: 'secret', sensitive: true },
        ],
      });
    expect(nonPrimaryCreate.status).toBe(400);
    expect(nonPrimaryCreate.body.error).toContain('primary agent');

    const missingExpiryCreate = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'oauth2',
        name: 'OAuth Missing Expiry',
        meta: {
          token_endpoint: 'https://oauth.example.com/token',
        },
        fields: [
          { key: 'access_token', value: 'access', type: 'secret', sensitive: true },
          { key: 'refresh_token', value: 'refresh', type: 'secret', sensitive: true },
          { key: 'client_id', value: 'cid', type: 'secret', sensitive: true },
          { key: 'client_secret', value: 'csecret', type: 'secret', sensitive: true },
        ],
      });
    expect(missingExpiryCreate.status).toBe(400);
    expect(missingExpiryCreate.body.error).toContain('expires_at');

    const missingSecretCreate = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'oauth2',
        name: 'OAuth Missing Access Token',
        meta: {
          token_endpoint: 'https://oauth.example.com/token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
        fields: [
          { key: 'refresh_token', value: 'refresh', type: 'secret', sensitive: true },
          { key: 'client_id', value: 'cid', type: 'secret', sensitive: true },
          { key: 'client_secret', value: 'csecret', type: 'secret', sensitive: true },
        ],
      });
    expect(missingSecretCreate.status).toBe(400);
    expect(missingSecretCreate.body.error).toContain('access_token');

    const validCreate = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'oauth2',
        name: 'OAuth Valid',
        meta: {
          token_endpoint: 'https://oauth.example.com/token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
        fields: [
          { key: 'access_token', value: 'access', type: 'secret', sensitive: true },
          { key: 'refresh_token', value: 'refresh', type: 'secret', sensitive: true },
          { key: 'client_id', value: 'cid', type: 'secret', sensitive: true },
          { key: 'client_secret', value: 'csecret', type: 'secret', sensitive: true },
        ],
      });
    expect(validCreate.status).toBe(200);
    const oauth2Id = validCreate.body.credential.id as string;

    const invalidUpdate = await request(app)
      .put(`/credentials/${oauth2Id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        meta: {
          token_endpoint: 'https://oauth.example.com/token',
          expires_at: 'soon',
        },
      });
    expect(invalidUpdate.status).toBe(400);
    expect(invalidUpdate.body.error).toContain('expires_at');

    const invalidUpdateMissingRefreshToken = await request(app)
      .put(`/credentials/${oauth2Id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sensitiveFields: [
          { key: 'refresh_token', value: '', type: 'secret', sensitive: true },
        ],
      });
    expect(invalidUpdateMissingRefreshToken.status).toBe(400);
    expect(invalidUpdateMissingRefreshToken.body.error).toContain('refresh_token');
  });

  it('should create hot_wallet credentials through wallet provisioning and enforce wallet:create:hot permission', async () => {
    const deniedToken = createToken({
      agentId: 'no-hot-wallet-create',
      permissions: ['secret:write'],
      exp: Date.now() + 60_000,
    });

    const deniedRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${deniedToken}`)
      .send({
        agentId: 'primary',
        type: 'hot_wallet',
        name: 'Blocked Hot Wallet',
        meta: { chain: 'base' },
      });
    expect(deniedRes.status).toBe(403);
    expect(String(deniedRes.body.error || '')).toContain('wallet:create:hot');

    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const adminReadToken = await createAdminToken(publicKey);

    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'hot_wallet',
        name: 'Trading Hot Wallet',
        meta: { chain: 'base' },
      });

    expect(createRes.status).toBe(200);
    expect(createRes.body.credential.type).toBe('hot_wallet');
    expect(createRes.body.credential.meta.chain).toBe('base');
    expect(String(createRes.body.credential.meta.address || '')).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(createRes.body.credential.meta.walletLink).toEqual(
      expect.objectContaining({
        tier: 'hot',
        source: 'created',
        chain: 'base',
      }),
    );

    const credentialId = createRes.body.credential.id as string;
    const walletAddress = createRes.body.credential.meta.address as string;

    const walletRes = await request(app)
      .get(`/wallet/${walletAddress}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(walletRes.status).toBe(200);
    expect(walletRes.body.tier).toBe('hot');
    expect(String(walletRes.body.address || '').toLowerCase()).toBe(walletAddress.toLowerCase());

    const readRes = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${adminReadToken}`)
      .send({});
    expect(readRes.status).toBe(200);

    const decrypted = decryptCredentialPayload(readRes.body.encrypted, privateKey);
    expect(decrypted.type).toBe('hot_wallet');
    expect(
      decrypted.fields.find((field) => field.key === 'private_key')?.value || '',
    ).toMatch(/^0x[a-fA-F0-9]{64}$/);
  });

  it('should clear OAuth2 reauth flags when sensitive tokens are updated', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'oauth2',
        name: 'OAuth Needs Reauth',
        meta: {
          token_endpoint: 'https://oauth.example.com/token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          needs_reauth: true,
          reauth_reason: 'Token revoked by provider',
        },
        fields: [
          { key: 'access_token', value: 'access', type: 'secret', sensitive: true },
          { key: 'refresh_token', value: 'refresh', type: 'secret', sensitive: true },
          { key: 'client_id', value: 'cid', type: 'secret', sensitive: true },
          { key: 'client_secret', value: 'csecret', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const updateRes = await request(app)
      .put(`/credentials/${credentialId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sensitiveFields: [
          { key: 'access_token', value: 'new-access', type: 'secret', sensitive: true },
        ],
      });
    expect(updateRes.status).toBe(200);

    const detailRes = await request(app)
      .get(`/credentials/${credentialId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.credential.meta.needs_reauth).toBe(false);
    expect(detailRes.body.credential.meta.reauth_reason).toBeNull();
  });

  it('should complete oauth2 reauth start + callback code exchange', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'oauth2',
        name: 'OAuth Reauth',
        meta: {
          token_endpoint: 'https://oauth.example.com/token',
          authorization_endpoint: 'https://oauth.example.com/authorize',
          expires_at: Math.floor(Date.now() / 1000) - 10,
          needs_reauth: true,
          reauth_reason: 'expired',
        },
        fields: [
          { key: 'access_token', value: 'access', type: 'secret', sensitive: true },
          { key: 'refresh_token', value: 'refresh', type: 'secret', sensitive: true },
          { key: 'client_id', value: 'cid', type: 'secret', sensitive: true },
          { key: 'client_secret', value: 'csecret', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const startRes = await request(app)
      .post(`/credentials/${credentialId}/reauth`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(startRes.status).toBe(200);
    expect(startRes.body.success).toBe(true);
    expect(startRes.body.authorization_url).toContain('https://oauth.example.com/authorize');
    expect(typeof startRes.body.state).toBe('string');

    const originalFetch = global.fetch;
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    })) as typeof fetch;

    try {
      const completeRes = await request(app)
        .post(`/credentials/${credentialId}/reauth`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code: 'auth-code', state: startRes.body.state });
      expect(completeRes.status).toBe(200);
      expect(completeRes.body.success).toBe(true);

      const detailRes = await request(app)
        .get(`/credentials/${credentialId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.credential.meta.needs_reauth).toBe(false);
      expect(detailRes.body.credential.meta.reauth_reason).toBeNull();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('marks oauth2 credential as needs_reauth when code exchange fails', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'oauth2',
        name: 'OAuth Reauth Failure',
        meta: {
          token_endpoint: 'https://oauth.example.com/token',
          authorization_endpoint: 'https://oauth.example.com/authorize',
          expires_at: Math.floor(Date.now() / 1000) - 10,
        },
        fields: [
          { key: 'access_token', value: 'access', type: 'secret', sensitive: true },
          { key: 'refresh_token', value: 'refresh', type: 'secret', sensitive: true },
          { key: 'client_id', value: 'cid', type: 'secret', sensitive: true },
          { key: 'client_secret', value: 'csecret', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const startRes = await request(app)
      .post(`/credentials/${credentialId}/reauth`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    const originalFetch = global.fetch;
    global.fetch = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'revoked' }),
    })) as typeof fetch;

    try {
      const completeRes = await request(app)
        .post(`/credentials/${credentialId}/reauth`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code: 'auth-code', state: startRes.body.state });
      expect(completeRes.status).toBe(400);
      expect(completeRes.body.error).toContain('revoked');

      const detailRes = await request(app)
        .get(`/credentials/${credentialId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.credential.meta.needs_reauth).toBe(true);
      expect(String(detailRes.body.credential.meta.reauth_reason)).toContain('revoked');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should always exclude oauth2 refresh machinery from agent reads', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pubkeyBase64 = Buffer.from(publicKey, 'utf8').toString('base64');

    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'oauth2',
        name: 'OAuth Read Contract',
        meta: {
          token_endpoint: 'https://oauth.example.com/token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
        fields: [
          { key: 'access_token', value: 'access', type: 'secret', sensitive: true },
          { key: 'refresh_token', value: 'refresh', type: 'secret', sensitive: true },
          { key: 'client_id', value: 'cid', type: 'secret', sensitive: true },
          { key: 'client_secret', value: 'csecret', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const tokenRes = await request(app)
      .post('/actions/token')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'oauth2-read-agent',
        permissions: ['secret:read'],
        credentialAccess: {
          read: ['*'],
          excludeFields: [],
        },
        pubkey: pubkeyBase64,
      });
    expect(tokenRes.status).toBe(200);
    const token = decryptEnvelope(tokenRes.body.encryptedToken as string, privateKey);

    const readRes = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(readRes.status).toBe(200);

    const decrypted = decryptCredentialPayload(readRes.body.encrypted, privateKey);
    const keys = decrypted.fields.map(field => field.key);
    expect(keys).toContain('access_token');
    expect(keys).not.toContain('refresh_token');
    expect(keys).not.toContain('client_id');
    expect(keys).not.toContain('client_secret');
    expect(keys).not.toContain('token_endpoint');
  });

  it('should include credential health envelope in encrypted agent read payloads', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pubkeyBase64 = Buffer.from(publicKey, 'utf8').toString('base64');

    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Health Envelope Contract',
        meta: { tags: ['health'] },
        fields: [
          { key: 'username', value: 'example-user', type: 'text', sensitive: false },
          { key: 'password', value: 'short', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const tokenRes = await request(app)
      .post('/actions/token')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'health-envelope-agent',
        permissions: ['secret:read'],
        credentialAccess: {
          read: ['*'],
          excludeFields: [],
        },
        pubkey: pubkeyBase64,
      });
    expect(tokenRes.status).toBe(200);
    const token = decryptEnvelope(tokenRes.body.encryptedToken as string, privateKey);

    const readRes = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(readRes.status).toBe(200);

    const decrypted = decryptCredentialPayload(readRes.body.encrypted, privateKey);
    expect(decrypted.health).toBeDefined();
    expect(decrypted.health?.status).toBeTypeOf('string');
    expect(decrypted.health?.flags).toEqual(
      expect.objectContaining({
        weak: expect.any(Boolean),
        reused: expect.any(Boolean),
        breached: expect.any(Boolean),
        unknown: expect.any(Boolean),
      }),
    );
    expect(decrypted.health?.evidence.reuseCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(decrypted.health?.evidence.weakReasons)).toBe(true);
    expect(decrypted.health?.engineVersion).toBe('1');
    expect(decrypted.health?.lastScannedAt).toEqual(expect.any(String));
  });

  it('should accept structured walletLink metadata and normalize linkedAt', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'note',
        name: 'Wallet-linked note',
        meta: {
          walletLink: {
            version: 1,
            walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
            chain: 'base',
            tier: 'hot',
            source: 'existing',
            linkedAt: '2000-01-01T00:00:00.000Z',
          },
        },
        fields: [{ key: 'content', value: 'hello', type: 'text', sensitive: true }],
      });

    expect(createRes.status).toBe(200);
    expect(createRes.body.credential.meta.walletLink).toBeTruthy();
    expect(createRes.body.credential.meta.walletLink.tier).toBe('hot');
    expect(createRes.body.credential.meta.walletLink.source).toBe('existing');
    expect(createRes.body.credential.meta.walletLink.linkedAt).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('should normalize legacy note "value" field to canonical content key on read', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pubkeyBase64 = Buffer.from(publicKey, 'utf8').toString('base64');

    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'note',
        name: 'Legacy Note',
        fields: [{ key: 'value', value: 'legacy note body', type: 'text', sensitive: true }],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const tokenRes = await request(app)
      .post('/actions/token')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'legacy-note-reader',
        permissions: ['secret:read'],
        credentialAccess: {
          read: ['*'],
          excludeFields: [],
        },
        pubkey: pubkeyBase64,
      });
    expect(tokenRes.status).toBe(200);
    const token = decryptEnvelope(tokenRes.body.encryptedToken as string, privateKey);

    const readRes = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(readRes.status).toBe(200);

    const decrypted = decryptCredentialPayload(readRes.body.encrypted, privateKey);
    const contentField = decrypted.fields.find((field) => field.key === NOTE_CONTENT_KEY);
    expect(contentField?.value).toBe('legacy note body');
    expect(decrypted.fields.some((field) => field.key === 'value')).toBe(false);
  });

  it('should reject walletLink with temp tier', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'note',
        name: 'Bad wallet link',
        meta: {
          walletLink: {
            version: 1,
            walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
            chain: 'base',
            tier: 'temp',
            source: 'existing',
            linkedAt: new Date().toISOString(),
          },
        },
        fields: [{ key: 'content', value: 'hello', type: 'text', sensitive: true }],
      });

    expect(createRes.status).toBe(400);
    expect(String(createRes.body.error || '')).toContain('walletLink.tier');
  });

  it('should enforce ssh/gpg private_key requirements, host validation, and server-side fingerprint overwrite', async () => {
    const invalidHosts = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'ssh',
        name: 'Bad SSH',
        meta: { hosts: 'github.com' },
        fields: [
          { key: 'private_key', value: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----', type: 'secret', sensitive: true },
        ],
      });
    expect(invalidHosts.status).toBe(400);
    expect(String(invalidHosts.body.error || '')).toContain('meta.hosts');

    const missingPrivate = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'gpg',
        name: 'Bad GPG',
        meta: { public_key: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nabc' },
        fields: [],
      });
    expect(missingPrivate.status).toBe(400);
    expect(String(missingPrivate.body.error || '')).toContain('private_key');

    const createSsh = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'ssh',
        name: 'Deploy SSH',
        meta: {
          fingerprint: 'manually-set-should-not-stick',
          public_key: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC1test user@host',
          hosts: ['github.com', 'prod.example.com'],
        },
        fields: [
          { key: 'private_key', value: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----', type: 'secret', sensitive: true },
          { key: 'passphrase', value: 'pass', type: 'secret', sensitive: true },
        ],
      });
    expect(createSsh.status).toBe(200);
    expect(createSsh.body.credential.type).toBe('ssh');
    expect(createSsh.body.credential.meta.hosts).toEqual(['github.com', 'prod.example.com']);
    expect(String(createSsh.body.credential.meta.fingerprint || '')).not.toBe('manually-set-should-not-stick');

    const createGpg = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'gpg',
        name: 'Release GPG',
        meta: {
          key_id: 'ABC123',
          uid_email: 'dev@example.com',
          public_key: '-----BEGIN PGP PUBLIC KEY BLOCK-----\nabc',
        },
        fields: [
          { key: 'private_key', value: '-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc', type: 'secret', sensitive: true },
        ],
      });
    expect(createGpg.status).toBe(200);
    expect(createGpg.body.credential.type).toBe('gpg');
    expect(typeof createGpg.body.credential.meta.fingerprint).toBe('string');
  });

  it('returns async health rescan lifecycle state by scan id', async () => {
    const kickoff = await request(app)
      .post('/credentials/health/rescan')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(kickoff.status).toBe(200);
    expect(kickoff.body.accepted).toBe(true);
    expect(typeof kickoff.body.scanId).toBe('string');

    const scanRes = await request(app)
      .get(`/credentials/health/rescan/${kickoff.body.scanId as string}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(scanRes.status).toBe(200);
    expect(scanRes.body.success).toBe(true);
    expect(scanRes.body.scanId).toBe(kickoff.body.scanId);
    expect(['queued', 'running', 'complete', 'failed', 'expired']).toContain(scanRes.body.scan.status);
  });

  it('returns 404 for unknown health rescan scan id', async () => {
    const res = await request(app)
      .get('/credentials/health/rescan/scan-does-not-exist')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error || '')).toContain('not found');
  });

  it('keeps health status consistent across list, summary, and detail endpoints', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Health Consistency',
        meta: { tags: ['health'] },
        fields: [
          { key: 'username', value: 'example-user', type: 'text', sensitive: false },
          { key: 'password', value: 'short', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const listRes = await request(app)
      .get('/credentials?health=true')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);

    const listEntry = (listRes.body.credentials as Array<{ id: string; health?: { status?: string } }>).find(
      (credential) => credential.id === credentialId,
    );
    expect(listEntry).toBeTruthy();
    expect(typeof listEntry?.health?.status).toBe('string');

    const detailRes = await request(app)
      .get('/credentials/health')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(detailRes.status).toBe(200);

    const detailEntry = (detailRes.body.credentials as Array<{ id: string; health: { status: string } }>).find(
      (credential) => credential.id === credentialId,
    );
    expect(detailEntry).toBeTruthy();
    expect(detailEntry?.health.status).toBe(listEntry?.health?.status);

    const summaryRes = await request(app)
      .get('/credentials/health/summary')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.summary.totalAnalyzed).toBeGreaterThanOrEqual(1);
    expect(summaryRes.body.summary.weak).toBeGreaterThanOrEqual(1);
  });

  it('supports plain_note non-sensitive content create and read', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'plain_note',
        name: 'Visibility note',
        fields: [
          { key: NOTE_CONTENT_KEY, value: 'rotate monthly', type: 'text', sensitive: false },
        ],
      });

    expect(createRes.status).toBe(200);
    const createdId = createRes.body.credential.id as string;

    const adminRead = await request(app)
      .post(`/credentials/${createdId}/read`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminRead.status).toBe(200);
    const decrypted = decryptCredentialPayload(adminRead.body.encrypted, TEST_AGENT_PRIVATE_KEY);
    expect(decrypted.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: NOTE_CONTENT_KEY, value: 'rotate monthly', sensitive: false }),
      ]),
    );
    expect(decrypted.fields.some((field: { key: string }) => field.key === 'value')).toBe(false);

  });

  it('normalizes legacy plain_note value key to content on read', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'plain_note',
        name: 'Legacy plain note',
        fields: [
          { key: 'value', value: 'legacy payload', type: 'text', sensitive: false },
        ],
      });

    expect(createRes.status).toBe(200);
    const createdId = createRes.body.credential.id as string;

    const adminRead = await request(app)
      .post(`/credentials/${createdId}/read`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminRead.status).toBe(200);
    const decrypted = decryptCredentialPayload(adminRead.body.encrypted, TEST_AGENT_PRIVATE_KEY);
    expect(decrypted.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: NOTE_CONTENT_KEY, value: 'legacy payload', sensitive: false }),
      ]),
    );
    expect(decrypted.fields.some((field: { key: string }) => field.key === 'value')).toBe(false);
  });

  it('should enforce maxReads and TTL constraints on credential reads', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pubkeyPem = publicKey.toString();

    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'note',
        name: 'TTL/Reads',
        meta: { tags: ['timed'] },
        fields: [{ key: 'content', value: 'secret', type: 'text', sensitive: true }],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const maxReadsToken = createToken({
      agentId: 'reads-agent',
      permissions: ['secret:read'],
      exp: Date.now() + 3600_000,
      credentialAccess: { read: ['*'], maxReads: 1, excludeFields: [] },
      agentPubkey: pubkeyPem,
    });

    const firstRead = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${maxReadsToken}`)
      .send({});
    expect(firstRead.status).toBe(200);
    const firstPayload = decryptCredentialPayload(firstRead.body.encrypted, privateKey);
    expect(firstPayload.fields.map(field => field.key)).toContain('content');

    const secondRead = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${maxReadsToken}`)
      .send({});
    expect(secondRead.status).toBe(403);
    expect(secondRead.body.error).toContain('read limit');

    const expiredToken = createToken({
      agentId: 'ttl-agent',
      permissions: ['secret:read'],
      exp: Date.now() + 3600_000,
      iat: Date.now() - 10_000,
      credentialAccess: { read: ['*'], ttl: 1, excludeFields: [] },
      agentPubkey: pubkeyPem,
    });

    const expiredRead = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${expiredToken}`)
      .send({});
    expect(expiredRead.status).toBe(403);
    expect(expiredRead.body.error).toContain('TTL expired');
  });
});
