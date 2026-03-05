import { describe, expect, it } from 'vitest';
import {
  buildOperationBindingHashes,
  compileTempPolicy,
  operationBindingMatches,
  TEMP_POLICY_COMPILER_VERSION,
  type TempPolicy,
} from '../../lib/temp-policy';

describe('temp-policy compiler', () => {
  const derivedPolicy: TempPolicy = {
    permissions: ['secret:read'],
    limits: { fund: 0, send: 0, swap: 0 },
    credentialAccess: {
      read: ['cred-123'],
      write: [],
      excludeFields: ['cvv'],
      ttl: 300,
      maxReads: 1,
    },
    ttlSeconds: 300,
    maxUses: 1,
  };

  const contract = {
    requiredPermissions: ['secret:read'],
    allowedPermissions: ['secret:read'],
    requiredReadScopes: ['cred-123'],
    allowedReadScopes: ['cred-123'],
    allowedWriteScopes: [],
    maxTtlSeconds: 300,
    defaultTtlSeconds: 300,
    maxUses: 1,
    defaultMaxUses: 1,
    allowLimits: false,
    allowWalletAccess: false,
    enforceExcludeFieldsFromDerived: true,
  } as const;

  it('is deterministic for identical compile inputs', () => {
    const input = {
      requestedPolicySource: 'derived_403' as const,
      derivedPolicy,
      contract,
      binding: {
        actorId: 'mcp-stdio',
        method: 'POST',
        routeId: 'credentials.read',
        resource: { credentialId: 'cred-123' },
        body: {},
      },
    };
    const first = compileTempPolicy(input);
    const second = compileTempPolicy(input);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.compilerVersion).toBe(TEMP_POLICY_COMPILER_VERSION);
    expect(first.value.policyHash).toBe(second.value.policyHash);
    expect(first.value.binding.bindingHash).toBe(second.value.binding.bindingHash);
    expect(first.value.effectivePolicy).toEqual(second.value.effectivePolicy);
  });

  it('rejects client requestedPolicy when source is derived_403', () => {
    const result = compileTempPolicy({
      requestedPolicySource: 'derived_403',
      requestedPolicy: {
        permissions: ['admin:*'],
      },
      derivedPolicy,
      contract,
      binding: {
        actorId: 'mcp-stdio',
        method: 'POST',
        routeId: 'credentials.read',
        resource: { credentialId: 'cred-123' },
        body: {},
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('client_policy_not_allowed_for_derived_source');
  });

  it('accepts + clamps agent requestedPolicy against contract ceilings', () => {
    const result = compileTempPolicy({
      requestedPolicySource: 'agent',
      requestedPolicy: {
        permissions: ['secret:read'],
        credentialAccess: {
          read: ['cred-123'],
          write: ['cred-123'],
          excludeFields: [],
          ttl: 999,
          maxReads: 99,
        },
        ttlSeconds: 999,
        maxUses: 99,
      },
      hasRequestedPolicyInput: true,
      derivedPolicy,
      contract,
      binding: {
        actorId: 'mcp-stdio',
        method: 'POST',
        routeId: 'credentials.read',
        resource: { credentialId: 'cred-123' },
        body: {},
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requestedPolicySource).toBe('agent');
    expect(result.value.effectivePolicy.permissions).toEqual(['secret:read']);
    expect(result.value.effectivePolicy.ttlSeconds).toBe(300);
    expect(result.value.effectivePolicy.maxUses).toBe(1);
    expect(result.value.effectivePolicy.credentialAccess?.ttl).toBe(300);
    expect(result.value.effectivePolicy.credentialAccess?.maxReads).toBe(1);
    // write scopes are not allowed by this route contract
    expect(result.value.effectivePolicy.credentialAccess?.write).toEqual([]);
  });

  it('rejects agent source when requestedPolicy is missing/unparseable', () => {
    const result = compileTempPolicy({
      requestedPolicySource: 'agent',
      hasRequestedPolicyInput: true,
      derivedPolicy,
      contract,
      binding: {
        actorId: 'mcp-stdio',
        method: 'POST',
        routeId: 'credentials.read',
        resource: { credentialId: 'cred-123' },
        body: {},
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('invalid_requested_policy');
  });

  it('rejects agent source when requestedPolicy cannot satisfy required permission floor', () => {
    const result = compileTempPolicy({
      requestedPolicySource: 'agent',
      requestedPolicy: {
        permissions: ['admin:*'],
      },
      hasRequestedPolicyInput: true,
      derivedPolicy,
      contract,
      binding: {
        actorId: 'mcp-stdio',
        method: 'POST',
        routeId: 'credentials.read',
        resource: { credentialId: 'cred-123' },
        body: {},
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('policy_unsatisfied_for_retry');
  });

  it('matches canonical body/resource hashes regardless object key order', () => {
    const policyHash = 'abc123';
    const binding = buildOperationBindingHashes({
      actorId: 'mcp-stdio',
      method: 'POST',
      routeId: 'wallet.send',
      resource: { wallet: '0xabc', token: 'USDC' },
      body: { amount: '1', to: '0xdef' },
      policyHash,
    });
    const matches = operationBindingMatches({
      binding,
      actorId: 'mcp-stdio',
      method: 'POST',
      routeId: 'wallet.send',
      resource: { token: 'USDC', wallet: '0xabc' },
      body: { to: '0xdef', amount: '1' },
    });
    expect(matches).toBe(true);
  });
});
