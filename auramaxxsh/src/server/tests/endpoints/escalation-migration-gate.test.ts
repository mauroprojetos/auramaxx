import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanDatabase,
  createTestApp,
  createToken,
  setupAndUnlockWallet,
  TEST_AGENT_PUBKEY,
  testPrisma,
} from '../setup';
import { ESCALATION_CONTRACT_VERSION } from '../../lib/escalation-contract';
import {
  ESCALATION_ROUTE_IDS,
  NON_WALLET_ESCALATION_ALLOWLIST,
  WALLET_DEFERRED_ROUTE_IDS,
} from '../../lib/escalation-route-registry';

const app = createTestApp();
let adminToken: string;

function makeLimitedToken(): string {
  return createToken({
    agentId: 'gate-agent',
    permissions: ['wallet:list'],
    exp: Date.now() + 60_000,
    agentPubkey: TEST_AGENT_PUBKEY,
  });
}

describe('Escalation rollout migration gates', () => {
  beforeEach(async () => {
    await cleanDatabase();
    const setup = await setupAndUnlockWallet();
    adminToken = setup.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('returns canonical v1 contract fields for migrated non-wallet escalations', async () => {
    const token = makeLimitedToken();
    const res = await request(app)
      .post('/address-labels')
      .set('Authorization', `Bearer ${token}`)
      .send({ address: '0xabc', label: 'test' });

    expect(res.status).toBe(403);
    expect(res.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(res.body.requiresHumanApproval).toBe(true);
    expect(typeof res.body.reqId).toBe('string');
    expect(res.body.approvalScope).toBe('session_token');
    expect(typeof res.body.approveUrl).toBe('string');
    expect(res.body.claimStatus).toBe('pending');
    expect(res.body.retryReady).toBe(false);
    expect(res.body.claimAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'GET',
    }));
    expect(res.body.retryAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'POST',
    }));
    expect(Array.isArray(res.body.instructions)).toBe(true);
    expect(res.body.instructions.length).toBeGreaterThan(0);
  });

  it('returns canonical v1 contract fields for apikey route middleware escalations', async () => {
    const token = makeLimitedToken();
    const res = await request(app)
      .get('/apikeys')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(res.body.requiresHumanApproval).toBe(true);
    expect(typeof res.body.reqId).toBe('string');
    expect(res.body.approvalScope).toBe('session_token');
    expect(typeof res.body.approveUrl).toBe('string');
    expect(res.body.claimAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'GET',
    }));
    expect(res.body.retryAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'POST',
    }));
  });

  it('returns canonical v1 contract fields for adapter route middleware escalations', async () => {
    const token = makeLimitedToken();
    const res = await request(app)
      .post('/adapters/test')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'telegram' });

    expect(res.status).toBe(403);
    expect(res.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(res.body.requiresHumanApproval).toBe(true);
    expect(typeof res.body.reqId).toBe('string');
    expect(res.body.approvalScope).toBe('session_token');
    expect(typeof res.body.approveUrl).toBe('string');
    expect(res.body.claimAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'GET',
    }));
    expect(res.body.retryAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'POST',
    }));
  });

  it('returns canonical v1 contract fields for migrated wallet escalations', async () => {
    const token = makeLimitedToken();
    const res = await request(app)
      .post('/wallet/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ tier: 'hot' });

    expect(res.status).toBe(403);
    expect(res.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(res.body.requiresHumanApproval).toBe(true);
    expect(typeof res.body.reqId).toBe('string');
    expect(res.body.approvalScope).toBe('session_token');
    expect(typeof res.body.approveUrl).toBe('string');
    expect(res.body.claimStatus).toBe('pending');
    expect(res.body.retryReady).toBe(false);
  });

  it('returns canonical v1 contract fields for swap quote permission denials', async () => {
    const token = makeLimitedToken();
    const res = await request(app)
      .post('/swap/quote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        from: '0x1111111111111111111111111111111111111111',
        token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        direction: 'buy',
        amount: '100000000000000000',
        slippage: 1,
        chain: 'base',
      });

    expect(res.status).toBe(403);
    expect(res.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(res.body.requiresHumanApproval).toBe(true);
    expect(res.body.approvalScope).toBe('session_token');
    expect(res.body.routeId).toBe(ESCALATION_ROUTE_IDS.SWAP_QUOTE_PERMISSION);
    expect(res.body.required).toEqual(['swap']);
    expect(res.body.claimStatus).toBe('pending');
    expect(res.body.retryReady).toBe(false);
  });

  it('returns canonical one-shot envelopes for migrated credential denial routes (no legacy plain 403)', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Migration Gate Credential',
        sensitiveFields: [
          { key: 'password', value: 'gate-secret', type: 'secret', sensitive: true },
          { key: 'totp', value: 'JBSWY3DPEHPK3PXP', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const readScopeDeniedToken = createToken({
      agentId: 'gate-cred-read-scope-denied',
      permissions: ['secret:read'],
      exp: Date.now() + 60_000,
      credentialAccess: {
        read: ['cred_other'],
        excludeFields: [],
      },
      agentPubkey: TEST_AGENT_PUBKEY,
    });
    const readScopeDeniedRes = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${readScopeDeniedToken}`)
      .send({});

    expect(readScopeDeniedRes.status).toBe(403);
    expect(readScopeDeniedRes.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(readScopeDeniedRes.body.requiresHumanApproval).toBe(true);
    expect(readScopeDeniedRes.body.approvalScope).toBe('one_shot_read');
    expect(readScopeDeniedRes.body.routeId).toBe(ESCALATION_ROUTE_IDS.CREDENTIALS_READ_SCOPE_DENIED);
    expect(readScopeDeniedRes.body.routeContractId).toBe('credentials.read');
    expect(readScopeDeniedRes.body.reasonCode).toBe('CREDENTIAL_SCOPE_DENIED');
    expect(readScopeDeniedRes.body.requestedPolicySource).toBe('derived_403');
    expect(typeof readScopeDeniedRes.body.policyHash).toBe('string');
    expect(readScopeDeniedRes.body.compilerVersion).toBe('v1');
    expect(readScopeDeniedRes.body.claimStatus).toBe('pending');
    expect(readScopeDeniedRes.body.retryReady).toBe(false);
    expect(readScopeDeniedRes.body.claimAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'GET',
    }));
    expect(readScopeDeniedRes.body.retryAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'POST',
    }));

    const readExcludedFieldToken = createToken({
      agentId: 'gate-cred-read-excluded',
      permissions: ['secret:read'],
      exp: Date.now() + 60_000,
      credentialAccess: {
        read: ['*'],
        excludeFields: ['password'],
      },
      agentPubkey: TEST_AGENT_PUBKEY,
    });
    const readExcludedFieldRes = await request(app)
      .post(`/credentials/${credentialId}/read`)
      .set('Authorization', `Bearer ${readExcludedFieldToken}`)
      .send({ requestedFields: ['password'] });

    expect(readExcludedFieldRes.status).toBe(403);
    expect(readExcludedFieldRes.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(readExcludedFieldRes.body.requiresHumanApproval).toBe(true);
    expect(readExcludedFieldRes.body.approvalScope).toBe('one_shot_read');
    expect(readExcludedFieldRes.body.routeId).toBe(ESCALATION_ROUTE_IDS.CREDENTIALS_READ_EXCLUDED_FIELD);
    expect(readExcludedFieldRes.body.routeContractId).toBe('credentials.read');
    expect(readExcludedFieldRes.body.reasonCode).toBe('DENY_EXCLUDED_FIELD');
    expect(readExcludedFieldRes.body.requestedPolicySource).toBe('derived_403');
    expect(typeof readExcludedFieldRes.body.policyHash).toBe('string');
    expect(readExcludedFieldRes.body.compilerVersion).toBe('v1');
    expect(readExcludedFieldRes.body.claimStatus).toBe('pending');
    expect(readExcludedFieldRes.body.retryReady).toBe(false);
    expect(readExcludedFieldRes.body.claimAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'GET',
    }));
    expect(readExcludedFieldRes.body.retryAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'POST',
    }));

    const totpScopeDeniedToken = createToken({
      agentId: 'gate-cred-totp-scope-denied',
      permissions: ['secret:read', 'totp:read'],
      exp: Date.now() + 60_000,
      credentialAccess: {
        read: ['cred_other'],
        excludeFields: [],
      },
      agentPubkey: TEST_AGENT_PUBKEY,
    });
    const totpScopeDeniedRes = await request(app)
      .post(`/credentials/${credentialId}/totp`)
      .set('Authorization', `Bearer ${totpScopeDeniedToken}`)
      .send({});

    expect(totpScopeDeniedRes.status).toBe(403);
    expect(totpScopeDeniedRes.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(totpScopeDeniedRes.body.requiresHumanApproval).toBe(true);
    expect(totpScopeDeniedRes.body.approvalScope).toBe('one_shot_read');
    expect(totpScopeDeniedRes.body.routeId).toBe(ESCALATION_ROUTE_IDS.CREDENTIALS_TOTP_SCOPE_DENIED);
    expect(totpScopeDeniedRes.body.routeContractId).toBe('credentials.totp');
    expect(totpScopeDeniedRes.body.reasonCode).toBe('CREDENTIAL_SCOPE_DENIED');
    expect(totpScopeDeniedRes.body.requestedPolicySource).toBe('derived_403');
    expect(typeof totpScopeDeniedRes.body.policyHash).toBe('string');
    expect(totpScopeDeniedRes.body.compilerVersion).toBe('v1');
    expect(totpScopeDeniedRes.body.claimStatus).toBe('pending');
    expect(totpScopeDeniedRes.body.retryReady).toBe(false);
    expect(totpScopeDeniedRes.body.claimAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'GET',
    }));
    expect(totpScopeDeniedRes.body.retryAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'POST',
    }));

    const totpPermissionDeniedToken = createToken({
      agentId: 'gate-cred-totp-perm-denied',
      permissions: ['secret:read'],
      exp: Date.now() + 60_000,
      credentialAccess: {
        read: ['*'],
        excludeFields: [],
      },
      agentPubkey: TEST_AGENT_PUBKEY,
    });
    const totpPermissionDeniedRes = await request(app)
      .post(`/credentials/${credentialId}/totp`)
      .set('Authorization', `Bearer ${totpPermissionDeniedToken}`)
      .send({});

    expect(totpPermissionDeniedRes.status).toBe(403);
    expect(totpPermissionDeniedRes.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(totpPermissionDeniedRes.body.requiresHumanApproval).toBe(true);
    expect(totpPermissionDeniedRes.body.approvalScope).toBe('one_shot_read');
    expect(totpPermissionDeniedRes.body.routeId).toBe(ESCALATION_ROUTE_IDS.CREDENTIALS_TOTP_PERMISSION_DENIED);
    expect(totpPermissionDeniedRes.body.routeContractId).toBe('credentials.totp');
    expect(totpPermissionDeniedRes.body.reasonCode).toBe('TOKEN_PERMISSION_DENIED');
    expect(totpPermissionDeniedRes.body.requestedPolicySource).toBe('derived_403');
    expect(typeof totpPermissionDeniedRes.body.policyHash).toBe('string');
    expect(totpPermissionDeniedRes.body.compilerVersion).toBe('v1');
    expect(totpPermissionDeniedRes.body.claimStatus).toBe('pending');
    expect(totpPermissionDeniedRes.body.retryReady).toBe(false);
    expect(totpPermissionDeniedRes.body.claimAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'GET',
    }));
    expect(totpPermissionDeniedRes.body.retryAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'POST',
    }));
  });

  it('returns canonical v1 contract fields for wallet export-seed admin denial', async () => {
    const token = makeLimitedToken();
    const res = await request(app)
      .get('/wallet/export-seed')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(res.body.requiresHumanApproval).toBe(true);
    expect(typeof res.body.reqId).toBe('string');
    expect(res.body.approvalScope).toBe('session_token');
    expect(typeof res.body.approveUrl).toBe('string');
    expect(res.body.routeId).toBe(ESCALATION_ROUTE_IDS.WALLET_ADMIN);
    expect(res.body.required).toEqual(['admin:*']);
    expect(res.body.claimStatus).toBe('pending');
    expect(res.body.retryReady).toBe(false);
  });

  it('marks wallet route ids as migrated in escalation registry', () => {
    const walletRouteIds = [
      ESCALATION_ROUTE_IDS.WALLET_CREATE_HOT_PERMISSION,
      ESCALATION_ROUTE_IDS.WALLET_CREATE_TEMP_PERMISSION,
      ESCALATION_ROUTE_IDS.WALLET_ACCESS,
      ESCALATION_ROUTE_IDS.WALLET_EXPORT_PERMISSION,
      ESCALATION_ROUTE_IDS.WALLET_ADMIN,
      ESCALATION_ROUTE_IDS.WALLET_ASSET_ADD_PERMISSION,
      ESCALATION_ROUTE_IDS.WALLET_ASSET_REMOVE_PERMISSION,
      ESCALATION_ROUTE_IDS.WALLET_TX_ADD_PERMISSION,
      ESCALATION_ROUTE_IDS.WALLET_TX_ACCESS,
      ESCALATION_ROUTE_IDS.WALLET_TX_LIST_ACCESS,
    ];

    for (const routeId of walletRouteIds) {
      expect(NON_WALLET_ESCALATION_ALLOWLIST.has(routeId)).toBe(true);
      expect(WALLET_DEFERRED_ROUTE_IDS.has(routeId)).toBe(false);
    }
  });

  it('marks swap quote route ids as migrated in escalation registry', () => {
    const swapQuoteRouteIds = [
      ESCALATION_ROUTE_IDS.SWAP_QUOTE_PERMISSION,
      ESCALATION_ROUTE_IDS.SWAP_QUOTE_WALLET_ACCESS,
    ];

    for (const routeId of swapQuoteRouteIds) {
      expect(NON_WALLET_ESCALATION_ALLOWLIST.has(routeId)).toBe(true);
      expect(WALLET_DEFERRED_ROUTE_IDS.has(routeId)).toBe(false);
    }
  });

  it('marks credential denial route ids as migrated in escalation registry', () => {
    const credentialRouteIds = [
      ESCALATION_ROUTE_IDS.CREDENTIALS_READ_SCOPE_DENIED,
      ESCALATION_ROUTE_IDS.CREDENTIALS_READ_EXCLUDED_FIELD,
      ESCALATION_ROUTE_IDS.CREDENTIALS_TOTP_SCOPE_DENIED,
      ESCALATION_ROUTE_IDS.CREDENTIALS_TOTP_PERMISSION_DENIED,
    ];

    for (const routeId of credentialRouteIds) {
      expect(NON_WALLET_ESCALATION_ALLOWLIST.has(routeId)).toBe(true);
      expect(WALLET_DEFERRED_ROUTE_IDS.has(routeId)).toBe(false);
    }
  });

  it('keeps TOKEN_BINDING_MISMATCH deterministic hard-deny behavior', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Binding Gate Credential',
        sensitiveFields: [
          { key: 'password', value: 'gate-secret', type: 'secret', sensitive: true },
        ],
      });
    expect(createRes.status).toBe(200);
    const credentialId = createRes.body.credential.id as string;

    const token = createToken({
      agentId: 'binding-gate-agent',
      permissions: ['secret:read'],
      exp: Date.now() + 60_000,
      credentialAccess: {
        read: ['*'],
        excludeFields: [],
      },
      oneShotBinding: {
        reqId: 'req_binding_gate',
        actorId: 'binding-gate-agent',
        method: 'POST',
        routeId: 'credentials.read',
        resourceHash: 'deadbeef',
        bodyHash: 'deadbeef',
        bindingHash: 'deadbeef',
        policyHash: 'deadbeef',
        compilerVersion: 'v1',
      },
      agentPubkey: TEST_AGENT_PUBKEY,
    });

    const res = await request(app)
      .post(`/credentials/${credentialId}/totp`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(res.body.errorCode).toBe('operation_binding_mismatch');
    expect(res.body.requiresHumanApproval).toBe(false);
    expect(res.body.claimStatus).toBe('approved');
    expect(res.body.retryReady).toBe(false);
  });

  it('uses shared escalation helper (no legacy plain 403 branches) on covered swap/credential deny paths', () => {
    const swapSource = fs.readFileSync(path.resolve(__dirname, '../../routes/swap.ts'), 'utf8');
    expect(swapSource).toContain('routeId: ESCALATION_ROUTE_IDS.SWAP_QUOTE_PERMISSION');
    expect(swapSource).toContain('routeId: ESCALATION_ROUTE_IDS.SWAP_QUOTE_WALLET_ACCESS');
    expect(swapSource).not.toContain("Token does not have swap permission' });");
    expect(swapSource).not.toContain("Token does not have access to this wallet' });");

    const credentialsSource = fs.readFileSync(path.resolve(__dirname, '../../routes/credentials.ts'), 'utf8');
    expect(credentialsSource).toContain('routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_READ_SCOPE_DENIED');
    expect(credentialsSource).toContain('routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_READ_EXCLUDED_FIELD');
    expect(credentialsSource).toContain('routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_TOTP_SCOPE_DENIED');
    expect(credentialsSource).toContain('routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_TOTP_PERMISSION_DENIED');
    expect(credentialsSource).toContain("requestedPolicySource: 'derived_403'");
  });

  it('removes wallet TODO markers after migration', () => {
    const marker = 'TODO(escalation-rollout-wallet): keep legacy 403 for now; migrate to canonical approval->claim contract later.';
    const walletFiles = [
      path.resolve(__dirname, '../../routes/wallet.ts'),
      path.resolve(__dirname, '../../routes/wallet-assets.ts'),
      path.resolve(__dirname, '../../routes/wallet-transactions.ts'),
    ];

    for (const file of walletFiles) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source.includes(marker)).toBe(false);
    }
  });

  it('does not use legacy permission middleware in migrated wallet route files', () => {
    const walletFiles = [
      path.resolve(__dirname, '../../routes/wallet.ts'),
      path.resolve(__dirname, '../../routes/wallet-assets.ts'),
      path.resolve(__dirname, '../../routes/wallet-transactions.ts'),
    ];

    for (const file of walletFiles) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/\brequirePermission\b/);
      expect(source).not.toMatch(/\brequireAdmin\b/);
      expect(source).not.toMatch(/\bbuildPermissionDenied\b/);
    }
  });
});
