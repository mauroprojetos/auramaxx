/**
 * Fresh Setup Integration Test
 * ============================
 * Tests the initial server state transitions: no wallet → create agent → verify setup status.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startFreshServer,
  teardownServer,
  fetchSetup,
  createAgentViaApi,
  getAdminToken,
} from './harness';

describe('Fresh Setup Flow', () => {
  beforeAll(async () => {
    await startFreshServer();
  });

  afterAll(async () => {
    await teardownServer();
  });

  it('should report unconfigured state on fresh server', async () => {
    const status = (await fetchSetup()) as { hasWallet: boolean; unlocked: boolean; address: string | null };

    expect(status.hasWallet).toBe(false);
    expect(status.unlocked).toBe(false);
    expect(status.address).toBeNull();
  });

  it('should create agent and return mnemonic', async () => {
    const result = await createAgentViaApi();

    expect(result.address).toBeDefined();
    expect(result.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(result.mnemonic).toBeDefined();
    expect(result.mnemonic.split(' ').length).toBe(12);
    expect(result.token).toBeDefined();
  });

  it('should report configured + unlocked state after agent creation', async () => {
    const token = getAdminToken();
    const status = (await fetchSetup(token)) as {
      hasWallet: boolean;
      unlocked: boolean;
      address: string | null;
      apiKeys: { alchemy: boolean; anthropic: boolean };
      adapters: { telegram: boolean; webhook: boolean };
    };

    expect(status.hasWallet).toBe(true);
    expect(status.unlocked).toBe(true);
    expect(status.address).toBeDefined();
    // No API keys or adapters configured yet
    expect(status.apiKeys.alchemy).toBe(false);
    expect(status.apiKeys.anthropic).toBe(false);
    expect(status.adapters.telegram).toBe(false);
  });
});
