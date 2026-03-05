import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ESCALATION_CONTRACT_VERSION, buildCanonicalHardDeny } from '../../lib/escalation-contract';
import { respondPermissionDenied, _testOnly } from '../../lib/escalation-responder';
import { ESCALATION_ROUTE_IDS } from '../../lib/escalation-route-registry';
import { prisma } from '../../lib/db';

function createResponseCapture(): {
  res: Response;
  statusCode: number;
  body: Record<string, unknown> | null;
} {
  let statusCode = 200;
  let body: Record<string, unknown> | null = null;
  const res = {
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    json: vi.fn((payload: Record<string, unknown>) => {
      body = payload;
      return res;
    }),
  } as unknown as Response;
  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
}

describe('escalation hard-deny schema', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns canonical hard-deny for route_not_allowlisted', async () => {
    const capture = createResponseCapture();
    const req = { method: 'POST' } as unknown as Request;

    await respondPermissionDenied({
      req,
      res: capture.res,
      routeId: 'internal.unallowlisted.route' as typeof ESCALATION_ROUTE_IDS[keyof typeof ESCALATION_ROUTE_IDS],
      error: 'Insufficient permissions',
      required: ['secret:read'],
    });

    expect(capture.statusCode).toBe(403);
    expect(capture.body?.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(capture.body?.requiresHumanApproval).toBe(false);
    expect(capture.body?.errorCode).toBe('route_not_allowlisted');
    expect(capture.body?.claimStatus).toBe('expired');
    expect(capture.body?.retryReady).toBe(false);
  });

  it('returns canonical hard-deny for missing_deny_context', async () => {
    const capture = createResponseCapture();
    const req = { method: 'POST' } as unknown as Request;

    await respondPermissionDenied({
      req,
      res: capture.res,
      routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_SECRET_READ_PERMISSION,
      error: 'Excluded field requires approval',
      required: ['secret:read'],
      requestedPolicySource: 'derived_403',
      // denyContext intentionally omitted
    });

    expect(capture.statusCode).toBe(403);
    expect(capture.body?.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(capture.body?.requiresHumanApproval).toBe(false);
    expect(capture.body?.errorCode).toBe('missing_deny_context');
    expect(capture.body?.claimStatus).toBe('expired');
    expect(capture.body?.retryReady).toBe(false);
  });

  it('returns canonical hard-deny for invalid one-shot denyContext', async () => {
    const capture = createResponseCapture();
    const req = { method: 'POST' } as unknown as Request;

    await respondPermissionDenied({
      req,
      res: capture.res,
      routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_READ_SCOPE_DENIED,
      error: 'Credential read scope denied',
      required: ['secret:read'],
      requestedPolicySource: 'derived_403',
      denyContext: { invalid: true },
    });

    expect(capture.statusCode).toBe(403);
    expect(capture.body?.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(capture.body?.requiresHumanApproval).toBe(false);
    expect(capture.body?.errorCode).toBe('missing_deny_context');
    expect(capture.body?.claimStatus).toBe('expired');
    expect(capture.body?.retryReady).toBe(false);
  });

  it('returns canonical one-shot escalation envelope when denyContext is valid', async () => {
    const capture = createResponseCapture();
    const req = {
      method: 'POST',
      auth: {
        tokenHash: 'tok_hash',
        token: {
          agentId: 'scope-agent',
          agentPubkey: 'test-pubkey',
          permissions: ['secret:read'],
        },
      },
    } as unknown as Request;

    await respondPermissionDenied({
      req,
      res: capture.res,
      routeId: ESCALATION_ROUTE_IDS.CREDENTIALS_READ_EXCLUDED_FIELD,
      error: 'Excluded credential fields require human approval',
      required: ['secret:read'],
      have: ['secret:read'],
      requestedPolicySource: 'derived_403',
      denyContext: {
        routeContractId: 'credentials.read',
        reasonCode: 'DENY_EXCLUDED_FIELD',
        summary: 'scope-agent requests excluded fields from credential',
        compile: {
          hasRequestedPolicyInput: false,
          derivedPolicy: {
            permissions: ['secret:read'],
            credentialAccess: {
              read: ['cred_123'],
              write: [],
              excludeFields: [],
              ttl: 300,
              maxReads: 1,
            },
            ttlSeconds: 300,
            maxUses: 1,
          },
          contract: {
            requiredPermissions: ['secret:read'],
            allowedPermissions: ['secret:read'],
            requiredReadScopes: ['cred_123'],
            allowedReadScopes: ['cred_123'],
            allowedWriteScopes: [],
            maxTtlSeconds: 300,
            defaultTtlSeconds: 300,
            maxUses: 1,
            defaultMaxUses: 1,
            allowLimits: false,
            allowWalletAccess: false,
            enforceExcludeFieldsFromDerived: true,
          },
          binding: {
            actorId: 'scope-agent',
            method: 'POST',
            routeId: 'credentials.read',
            resource: { credentialId: 'cred_123' },
            body: {},
          },
        },
      },
    });

    expect(capture.statusCode).toBe(403);
    expect(capture.body?.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(capture.body?.requiresHumanApproval).toBe(true);
    expect(capture.body?.approvalScope).toBe('one_shot_read');
    expect(capture.body?.routeId).toBe(ESCALATION_ROUTE_IDS.CREDENTIALS_READ_EXCLUDED_FIELD);
    expect(capture.body?.routeContractId).toBe('credentials.read');
    expect(capture.body?.reasonCode).toBe('DENY_EXCLUDED_FIELD');
    expect(capture.body?.requestedPolicySource).toBe('derived_403');
    expect(typeof capture.body?.reqId).toBe('string');
    expect(typeof capture.body?.policyHash).toBe('string');
    expect(capture.body?.compilerVersion).toBe('v1');
    expect(capture.body?.claimStatus).toBe('pending');
    expect(capture.body?.retryReady).toBe(false);
    expect(capture.body?.claimAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'GET',
    }));
    expect(capture.body?.retryAction).toEqual(expect.objectContaining({
      transport: 'http',
      kind: 'request',
      method: 'POST',
    }));
    const reqId = typeof capture.body?.reqId === 'string' ? capture.body.reqId : null;
    expect(reqId).toBeTruthy();
    const storedAction = await prisma.humanAction.findUnique({
      where: { id: reqId as string },
    });
    expect(storedAction).toBeTruthy();
  });

  it('canonical hard-deny builder keeps deterministic schema for unknown_classifier_outcome', () => {
    const payload = buildCanonicalHardDeny({
      error: 'Unexpected classifier result',
      errorCode: 'unknown_classifier_outcome',
    });

    expect(payload.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
    expect(payload.requiresHumanApproval).toBe(false);
    expect(payload.errorCode).toBe('unknown_classifier_outcome');
    expect(payload.claimStatus).toBe('expired');
    expect(payload.retryReady).toBe(false);
  });
});

describe('escalation profile resolver', () => {
  it('uses dev when required permissions fit dev profile', () => {
    expect(_testOnly.resolveEscalationProfile(['secret:read'])).toBe('dev');
  });

  it('uses dev when strict cannot satisfy but dev can', () => {
    expect(_testOnly.resolveEscalationProfile(['wallet:list'])).toBe('dev');
  });

  it('falls back to admin when required permissions are outside strict/dev', () => {
    expect(_testOnly.resolveEscalationProfile(['apikey:set'])).toBe('admin');
  });
});
