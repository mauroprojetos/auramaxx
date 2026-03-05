import { describe, expect, it } from 'vitest';
import { buildScopedReadTokenIssueRequest } from '../../lib/credential-transport';
import { resolveMcpIssuanceProfile } from '../../mcp/profile-policy';
import { resolveProfileToEffectivePolicy } from '../../lib/agent-profiles';

describe('profile parity (API/CLI/MCP issuance inputs)', () => {
  it('resolves equivalent effective policy for strict@v1 overrides', () => {
    const apiInput = {
      profileId: 'strict',
      profileVersion: 'v1',
      overrides: { ttlSeconds: 600, maxReads: 25 },
    } as const;

    const cliPayload = buildScopedReadTokenIssueRequest({
      agentId: 'cli-reader',
      pubkey: 'test-key',
      profile: 'strict',
      profileVersion: 'v1',
      profileOverrides: { ttlSeconds: 600, maxReads: 25 },
    });

    const mcpProfile = resolveMcpIssuanceProfile('read', {
      AURA_MCP_READ_PROFILE: 'strict',
      AURA_MCP_READ_PROFILE_VERSION: 'v1',
      AURA_MCP_READ_PROFILE_OVERRIDES_JSON: JSON.stringify({ ttlSeconds: 600, maxReads: 25 }),
    });
    const mcpPayload = buildScopedReadTokenIssueRequest({
      agentId: 'mcp-reader',
      pubkey: 'test-key',
      ...(mcpProfile || {}),
    });

    const fromApi = resolveProfileToEffectivePolicy(apiInput);
    const fromCli = resolveProfileToEffectivePolicy({
      profileId: String(cliPayload.profile),
      profileVersion: String(cliPayload.profileVersion),
      overrides: cliPayload.profileOverrides as typeof apiInput.overrides,
    });
    const fromMcp = resolveProfileToEffectivePolicy({
      profileId: String(mcpPayload.profile),
      profileVersion: String(mcpPayload.profileVersion),
      overrides: mcpPayload.profileOverrides as typeof apiInput.overrides,
    });

    expect(fromCli.effectivePolicyHash).toBe(fromApi.effectivePolicyHash);
    expect(fromMcp.effectivePolicyHash).toBe(fromApi.effectivePolicyHash);
    expect(fromCli.overrideDelta).toEqual(['maxReads', 'ttlSeconds']);
    expect(fromMcp.overrideDelta).toEqual(['maxReads', 'ttlSeconds']);
  });
});
