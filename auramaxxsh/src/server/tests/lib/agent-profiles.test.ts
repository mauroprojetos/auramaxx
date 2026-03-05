import { describe, expect, it } from 'vitest';
import {
  AgentProfileError,
  listProfiles,
  resolveProfileToEffectivePolicy,
  describeProfile,
  describeResolvedPolicy,
} from '../../lib/agent-profiles';

describe('agent profiles resolver', () => {
  it('lists baseline v1 profiles', () => {
    const ids = listProfiles().map((p) => p.id).sort();
    expect(ids).toEqual(['admin', 'dev', 'strict']);
  });

  it('resolves deterministically for same input', () => {
    const a = resolveProfileToEffectivePolicy({ profileId: 'strict' });
    const b = resolveProfileToEffectivePolicy({ profileId: 'strict' });

    expect(a).toEqual(b);
    expect(a.permissions).toContain('secret:read');
    expect(a.effectivePolicyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects broadening scope override', () => {
    expect(() => resolveProfileToEffectivePolicy({
      profileId: 'strict',
      overrides: { readScopes: ['agent:agent', 'agent:primary', 'agent:linked'] },
    })).toThrowError(AgentProfileError);

    try {
      resolveProfileToEffectivePolicy({
        profileId: 'strict',
        overrides: { readScopes: ['agent:agent', 'agent:primary', 'agent:linked'] },
      });
    } catch (error) {
      expect((error as AgentProfileError).code).toBe('AGENT_PROFILE_OVERRIDE_NOT_ALLOWED');
    }
  });

  it('includes primary + legacy strict read scopes for migrated installs', () => {
    const policy = resolveProfileToEffectivePolicy({ profileId: 'strict' });
    expect(policy.credentialAccess.read).toEqual(['agent:agent', 'agent:primary']);
  });

  it('allows tighten-only ttl/maxReads overrides', () => {
    const policy = resolveProfileToEffectivePolicy({
      profileId: 'dev',
      overrides: { ttlSeconds: 1200, maxReads: 100 },
    });

    expect(policy.ttlSeconds).toBe(1200);
    expect(policy.credentialAccess.maxReads).toBe(100);
    expect(policy.overrideDelta).toEqual(['maxReads', 'ttlSeconds']);
  });

  it('scopes dev profile credential access to primary + legacy alias only', () => {
    const policy = resolveProfileToEffectivePolicy({ profileId: 'dev' });
    expect(policy.credentialAccess.read).toEqual(['agent:agent', 'agent:primary']);
    expect(policy.credentialAccess.write).toEqual(['agent:agent', 'agent:primary']);
  });
});

describe('describeProfile', () => {
  it('returns human-readable description for strict profile', () => {
    const desc = describeProfile('strict');
    expect(desc.name).toBe('Strict');
    expect(desc.canWrite).toBe(false);
    expect(desc.hiddenFields.length).toBeGreaterThan(0);
    expect(desc.summary).toContain('Read-only');
    expect(desc.ttl).toBe('1 hour');
    expect(desc.maxReads).toBe('50 reads');
  });

  it('returns human-readable description for dev profile', () => {
    const desc = describeProfile('dev');
    expect(desc.name).toBe('Dev');
    expect(desc.canWrite).toBe(true);
    expect(desc.ttl).toBe('168 hours');
    expect(desc.permissions.length).toBeGreaterThan(0);
  });

  it('returns human-readable description for admin profile', () => {
    const desc = describeProfile('admin');
    expect(desc.name).toBe('Admin');
    expect(desc.hiddenFields).toEqual([]);
    expect(desc.maxReads).toBe('Unlimited');
    expect(desc.warnings.length).toBeGreaterThan(0);
  });

  it('describes a resolved policy', () => {
    const policy = resolveProfileToEffectivePolicy({ profileId: 'dev' });
    const desc = describeResolvedPolicy(policy);
    expect(desc.name).toBe('Dev');
    expect(desc.canWrite).toBe(true);
    expect(desc.summary).toContain('Read/write');
  });
});
