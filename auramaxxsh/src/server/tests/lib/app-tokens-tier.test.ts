/**
 * Tests for agent-chat permission tier in app-tokens
 *
 * Tests:
 * - createAppToken('agent-chat') with tier 'admin' → token has admin:*
 * - createAppToken('agent-chat') with tier 'restricted' → token has wallet:list, action:create
 * - Other apps are unaffected by the tier setting
 * - onDefaultChanged listener triggers revoke + recreate
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase } from '../setup';
import { createAppToken, revokeAppToken, getAppToken } from '../../lib/app-tokens';
import { validateToken, getTokenHash } from '../../lib/auth';
import { invalidateCache, setDefault, onDefaultChanged } from '../../lib/defaults';
import { clearSessions, isRevoked } from '../../lib/sessions';

describe('app-tokens agent tier', () => {
  beforeEach(async () => {
    invalidateCache();
    await cleanDatabase();
    clearSessions();
  });

  afterEach(async () => {
    // Clean up any created tokens
    await revokeAppToken('agent-chat').catch(() => {});
    await revokeAppToken('other-app').catch(() => {});
    invalidateCache();
    clearSessions();
  });

  it('grants admin:* to agent-chat when tier is admin (default)', async () => {
    // Default tier is 'admin' from seed defaults
    const token = await createAppToken('agent-chat', ['wallet:list', 'action:create']);
    expect(token).toBeTruthy();

    const payload = validateToken(token!);
    expect(payload).toBeTruthy();
    expect(payload!.permissions).toContain('admin:*');
  });

  it('uses declared permissions for agent-chat when tier is restricted', async () => {
    await setDefault('permissions.agent_tier', 'restricted');

    const token = await createAppToken('agent-chat', ['wallet:list', 'action:create']);
    expect(token).toBeTruthy();

    const payload = validateToken(token!);
    expect(payload).toBeTruthy();
    expect(payload!.permissions).toContain('wallet:list');
    expect(payload!.permissions).toContain('action:create');
    expect(payload!.permissions).not.toContain('admin:*');
  });

  it('does not affect other apps when tier is admin', async () => {
    // tier is admin by default
    const token = await createAppToken('other-app', ['wallet:list']);
    expect(token).toBeTruthy();

    const payload = validateToken(token!);
    expect(payload).toBeTruthy();
    expect(payload!.permissions).toContain('wallet:list');
    expect(payload!.permissions).not.toContain('admin:*');
  });

  it('onDefaultChanged listener revokes and recreates agent-chat token', async () => {
    // Register a listener for this test (module-level one may be cleared between tests)
    let listenerFired = false;
    const cleanup = onDefaultChanged('permissions.agent_tier', async () => {
      await revokeAppToken('agent-chat');
      await createAppToken('agent-chat');
      listenerFired = true;
    });

    try {
      // Create initial token with admin tier
      const token1 = await createAppToken('agent-chat', ['wallet:list', 'action:create']);
      expect(token1).toBeTruthy();
      expect(validateToken(token1!)!.permissions).toContain('admin:*');

      const oldHash = getTokenHash(token1!);

      // Change tier to restricted — triggers the listener
      await setDefault('permissions.agent_tier', 'restricted');

      // Give a moment for the async listener to fire
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(listenerFired).toBe(true);

      // Old token should have been revoked
      expect(isRevoked(oldHash)).toBe(true);

      // New token should exist and be restricted
      const token2 = getAppToken('agent-chat');
      expect(token2).toBeTruthy();
      expect(token2).not.toBe(token1);
      const payload2 = validateToken(token2!);
      expect(payload2).toBeTruthy();
      expect(payload2!.permissions).not.toContain('admin:*');
      expect(payload2!.permissions).toContain('app:storage');
    } finally {
      cleanup();
    }
  });
});
