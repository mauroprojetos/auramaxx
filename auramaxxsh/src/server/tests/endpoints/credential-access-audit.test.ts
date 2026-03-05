import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  cleanDatabase,
  createTestApp,
  createToken,
  setupAndUnlockWallet,
  testPrisma,
  TEST_AGENT_PUBKEY,
} from '../setup';
import { getTokenHash } from '../../lib/auth';
import { resetCredentialAccessLimiterForTests } from '../../lib/credential-access-policy';
import { ESCALATION_ROUTE_IDS } from '../../lib/escalation-route-registry';

const app = createTestApp();

describe('Credential access audit + limiter', () => {
  let adminToken: string;

  beforeEach(async () => {
    await cleanDatabase();
    const setup = await setupAndUnlockWallet();
    adminToken = setup.adminToken;
    resetCredentialAccessLimiterForTests();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('enforces per-credential TOTP limiter and records allow/deny audit rows', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'GitHub',
        sensitiveFields: [{ key: 'totp', value: 'JBSWY3DPEHPK3PXP', type: 'secret', sensitive: true }],
      });

    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const token = createToken({
      agentId: 'audit-agent',
      permissions: ['secret:read', 'totp:read'],
      exp: Date.now() + 60_000,
      credentialAccess: { read: ['*'], maxReads: 500, excludeFields: [] },
      agentPubkey: TEST_AGENT_PUBKEY,
    });
    const tokenHash = getTokenHash(token);

    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .post(`/credentials/${credentialId}/totp`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(typeof res.body.code).toBe('string');
    }

    const denied = await request(app)
      .post(`/credentials/${credentialId}/totp`)
      .set('Authorization', `Bearer ${token}`);

    expect(denied.status).toBe(429);
    expect(denied.body.reasonCode).toBe('CREDENTIAL_RATE_LIMIT_EXCEEDED');

    const rows = await testPrisma.credentialAccessAudit.findMany({
      where: { credentialId, action: 'credentials.totp' },
      orderBy: { timestamp: 'asc' },
    });

    expect(rows).toHaveLength(11);
    expect(rows.filter((row) => row.allowed)).toHaveLength(10);
    expect(rows.filter((row) => !row.allowed)).toHaveLength(1);
    expect(rows[10].reasonCode).toBe('CREDENTIAL_RATE_LIMIT_EXCEEDED');
    expect(rows[10].tokenHash).toBe(tokenHash);

    const metadataText = rows.map((row) => row.metadata ?? '').join(' ');
    expect(metadataText).not.toContain('JBSWY3DPEHPK3PXP');

    const recent = await request(app)
      .get('/security/credential-access/recent?limit=5')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(recent.status).toBe(200);
    expect(Array.isArray(recent.body.rows)).toBe(true);

    const noisyTokens = await request(app)
      .get('/security/credential-access/noisy-tokens?windowMs=3600000&limit=5')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(noisyTokens.status).toBe(200);
    expect(noisyTokens.body.rows.some((row: { tokenHash: string; count: number }) => row.tokenHash === tokenHash)).toBe(true);
  });

  it('records non-limiter deny reasons and surfaces noisy credential grouping', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'NoTotp',
        sensitiveFields: [{ key: 'password', value: 'hunter2', type: 'secret', sensitive: true }],
      });

    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const deniedByScope = createToken({
      agentId: 'scope-denied-agent',
      permissions: ['secret:read'],
      exp: Date.now() + 60_000,
      credentialAccess: { read: ['prod/*'], maxReads: 50, excludeFields: [] },
      agentPubkey: TEST_AGENT_PUBKEY,
    });

    const scopeRead = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${deniedByScope}`);
    expect(scopeRead.status).toBe(403);
    expect(scopeRead.body.reasonCode).toBe('CREDENTIAL_SCOPE_DENIED');
    expect(scopeRead.body.routeId).toBe(ESCALATION_ROUTE_IDS.CREDENTIALS_READ_SCOPE_DENIED);
    expect(scopeRead.body.requestedPolicySource).toBe('derived_403');
    expect(scopeRead.body.routeContractId).toBe('credentials.read');
    expect(typeof scopeRead.body.policyHash).toBe('string');
    expect(scopeRead.body.compilerVersion).toBe('v1');

    const deniedByMissingTotpPerm = createToken({
      agentId: 'permission-denied-agent',
      permissions: ['secret:read'],
      exp: Date.now() + 60_000,
      credentialAccess: { read: ['*'], maxReads: 50, excludeFields: [] },
      agentPubkey: TEST_AGENT_PUBKEY,
    });

    const permTotp = await request(app)
      .post(`/credentials/${credentialId}/totp`)
      .set('Authorization', `Bearer ${deniedByMissingTotpPerm}`);
    expect(permTotp.status).toBe(403);
    expect(permTotp.body.reasonCode).toBe('TOKEN_PERMISSION_DENIED');
    expect(permTotp.body.routeId).toBe(ESCALATION_ROUTE_IDS.CREDENTIALS_TOTP_PERMISSION_DENIED);
    expect(permTotp.body.requestedPolicySource).toBe('derived_403');
    expect(permTotp.body.routeContractId).toBe('credentials.totp');
    expect(typeof permTotp.body.policyHash).toBe('string');
    expect(permTotp.body.compilerVersion).toBe('v1');

    const totpPermNoTotp = createToken({
      agentId: 'no-totp-agent',
      permissions: ['secret:read', 'totp:read'],
      exp: Date.now() + 60_000,
      credentialAccess: { read: ['*'], maxReads: 50, excludeFields: [] },
      agentPubkey: TEST_AGENT_PUBKEY,
    });

    const noTotp = await request(app)
      .post(`/credentials/${credentialId}/totp`)
      .set('Authorization', `Bearer ${totpPermNoTotp}`);
    expect(noTotp.status).toBe(400);
    expect(noTotp.body.reasonCode).toBe('CREDENTIAL_TOTP_NOT_CONFIGURED');

    const noPubkeyToken = createToken({
      agentId: 'no-pubkey-agent',
      permissions: ['secret:read'],
      exp: Date.now() + 60_000,
      credentialAccess: { read: ['*'], maxReads: 50, excludeFields: [] },
    });

    const noPubkeyRead = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${noPubkeyToken}`);
    expect(noPubkeyRead.status).toBe(400);
    expect(noPubkeyRead.body.reasonCode).toBe('TOKEN_AGENT_PUBKEY_MISSING');

    const denyRows = await testPrisma.credentialAccessAudit.findMany({
      where: { credentialId, allowed: false },
      orderBy: { timestamp: 'asc' },
    });
    expect(denyRows.length).toBeGreaterThanOrEqual(4);
    const reasonCodes = new Set(denyRows.map((row) => row.reasonCode));
    expect(reasonCodes.has('CREDENTIAL_SCOPE_DENIED')).toBe(true);
    expect(reasonCodes.has('TOKEN_PERMISSION_DENIED')).toBe(true);
    expect(reasonCodes.has('CREDENTIAL_TOTP_NOT_CONFIGURED')).toBe(true);
    expect(reasonCodes.has('TOKEN_AGENT_PUBKEY_MISSING')).toBe(true);

    const noisyCredentials = await request(app)
      .get('/security/credential-access/noisy-credentials?windowMs=3600000&limit=5')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(noisyCredentials.status).toBe(200);
    expect(noisyCredentials.body.rows.some((row: { credentialId: string; count: number }) => row.credentialId === credentialId && row.count >= 4)).toBe(true);
  });
});
