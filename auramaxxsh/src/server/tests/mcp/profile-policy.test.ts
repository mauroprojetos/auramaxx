import { describe, expect, it } from 'vitest';
import { resolveMcpIssuanceProfile } from '../../mcp/profile-policy';

describe('MCP profile issuance policy env resolver', () => {
  // ── Basic resolution ──────────────────────────────────────────────────

  it('returns undefined when no profile is configured', () => {
    expect(resolveMcpIssuanceProfile('read', {})).toBeUndefined();
  });

  it('returns undefined for empty string profile', () => {
    expect(resolveMcpIssuanceProfile('read', { AURA_MCP_READ_PROFILE: '' })).toBeUndefined();
  });

  it('returns undefined for whitespace-only profile', () => {
    expect(resolveMcpIssuanceProfile('read', { AURA_MCP_READ_PROFILE: '   ' })).toBeUndefined();
  });

  it('trims profile and version values', () => {
    const resolved = resolveMcpIssuanceProfile('read', {
      AURA_MCP_READ_PROFILE: ' strict ',
      AURA_MCP_READ_PROFILE_VERSION: ' v1 ',
    });
    expect(resolved).toEqual({
      profile: 'strict',
      profileVersion: 'v1',
    });
  });

  it('parses read profile + version + overrides', () => {
    const resolved = resolveMcpIssuanceProfile('read', {
      AURA_MCP_READ_PROFILE: 'strict',
      AURA_MCP_READ_PROFILE_VERSION: 'v1',
      AURA_MCP_READ_PROFILE_OVERRIDES_JSON: JSON.stringify({ ttlSeconds: 600, maxReads: 25 }),
    });

    expect(resolved).toEqual({
      profile: 'strict',
      profileVersion: 'v1',
      profileOverrides: { ttlSeconds: 600, maxReads: 25 },
    });
  });

  it('drops invalid override json fail-closed to profile-only request', () => {
    const resolved = resolveMcpIssuanceProfile('write', {
      AURA_MCP_WRITE_PROFILE: 'dev',
      AURA_MCP_WRITE_PROFILE_OVERRIDES_JSON: '{bad-json',
    });

    expect(resolved).toEqual({ profile: 'dev' });
  });

  // ── Read vs write prefix isolation ────────────────────────────────────

  it('read kind reads AURA_MCP_READ_PROFILE, ignores write env', () => {
    const resolved = resolveMcpIssuanceProfile('read', {
      AURA_MCP_WRITE_PROFILE: 'write-only',
      AURA_MCP_WRITE_PROFILE_VERSION: 'v2',
    });
    expect(resolved).toBeUndefined();
  });

  it('write kind reads AURA_MCP_WRITE_PROFILE, ignores read env', () => {
    const resolved = resolveMcpIssuanceProfile('write', {
      AURA_MCP_READ_PROFILE: 'read-only',
      AURA_MCP_WRITE_PROFILE: 'agent-write',
    });
    expect(resolved).toEqual({ profile: 'agent-write' });
  });

  // ── Profile-only (no version, no overrides) ──────────────────────────

  it('returns profile-only when version and overrides are absent', () => {
    const resolved = resolveMcpIssuanceProfile('read', {
      AURA_MCP_READ_PROFILE: 'default',
    });
    expect(resolved).toEqual({ profile: 'default' });
    expect(resolved).not.toHaveProperty('profileVersion');
    expect(resolved).not.toHaveProperty('profileOverrides');
  });

  // ── Version without overrides ─────────────────────────────────────────

  it('includes version without overrides', () => {
    const resolved = resolveMcpIssuanceProfile('write', {
      AURA_MCP_WRITE_PROFILE: 'prod',
      AURA_MCP_WRITE_PROFILE_VERSION: 'v3',
    });
    expect(resolved).toEqual({ profile: 'prod', profileVersion: 'v3' });
    expect(resolved).not.toHaveProperty('profileOverrides');
  });

  // ── Override edge cases (fail-closed) ─────────────────────────────────

  it('rejects array overrides (must be object)', () => {
    const resolved = resolveMcpIssuanceProfile('read', {
      AURA_MCP_READ_PROFILE: 'strict',
      AURA_MCP_READ_PROFILE_OVERRIDES_JSON: '[1,2,3]',
    });
    expect(resolved).toEqual({ profile: 'strict' });
  });

  it('rejects null overrides', () => {
    const resolved = resolveMcpIssuanceProfile('read', {
      AURA_MCP_READ_PROFILE: 'strict',
      AURA_MCP_READ_PROFILE_OVERRIDES_JSON: 'null',
    });
    expect(resolved).toEqual({ profile: 'strict' });
  });

  it('rejects string overrides', () => {
    const resolved = resolveMcpIssuanceProfile('read', {
      AURA_MCP_READ_PROFILE: 'strict',
      AURA_MCP_READ_PROFILE_OVERRIDES_JSON: '"just-a-string"',
    });
    expect(resolved).toEqual({ profile: 'strict' });
  });

  it('rejects number overrides', () => {
    const resolved = resolveMcpIssuanceProfile('read', {
      AURA_MCP_READ_PROFILE: 'strict',
      AURA_MCP_READ_PROFILE_OVERRIDES_JSON: '42',
    });
    expect(resolved).toEqual({ profile: 'strict' });
  });

  it('accepts empty object overrides', () => {
    const resolved = resolveMcpIssuanceProfile('read', {
      AURA_MCP_READ_PROFILE: 'strict',
      AURA_MCP_READ_PROFILE_OVERRIDES_JSON: '{}',
    });
    expect(resolved).toEqual({ profile: 'strict', profileOverrides: {} });
  });

  // ── Full override shapes ──────────────────────────────────────────────

  it('preserves all ProfileIssuanceOverrides fields', () => {
    const overrides = {
      ttlSeconds: 300,
      maxReads: 5,
      readScopes: ['agent:primary'],
      writeScopes: [],
      excludeFields: ['totp'],
    };
    const resolved = resolveMcpIssuanceProfile('write', {
      AURA_MCP_WRITE_PROFILE: 'restrictive',
      AURA_MCP_WRITE_PROFILE_VERSION: 'v1',
      AURA_MCP_WRITE_PROFILE_OVERRIDES_JSON: JSON.stringify(overrides),
    });
    expect(resolved).toEqual({
      profile: 'restrictive',
      profileVersion: 'v1',
      profileOverrides: overrides,
    });
  });

  // ── Empty version string ──────────────────────────────────────────────

  it('omits version when version env is empty string', () => {
    const resolved = resolveMcpIssuanceProfile('read', {
      AURA_MCP_READ_PROFILE: 'test',
      AURA_MCP_READ_PROFILE_VERSION: '',
    });
    expect(resolved).toEqual({ profile: 'test' });
    expect(resolved).not.toHaveProperty('profileVersion');
  });

  // ── Empty overrides string ────────────────────────────────────────────

  it('omits overrides when overrides env is empty string', () => {
    const resolved = resolveMcpIssuanceProfile('read', {
      AURA_MCP_READ_PROFILE: 'test',
      AURA_MCP_READ_PROFILE_OVERRIDES_JSON: '',
    });
    expect(resolved).toEqual({ profile: 'test' });
    expect(resolved).not.toHaveProperty('profileOverrides');
  });
});
