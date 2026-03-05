/**
 * Tests for AGENT_PASSWORD env var auto-unlock behavior.
 *
 * These test the cold.unlock() function directly — the same function
 * called by server/index.ts on startup when AGENT_PASSWORD is set.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { unlock, isUnlocked, lock, createColdWallet, hasColdWallet, deleteColdWallet, _resetForTesting } from '../../lib/cold';

const PASSWORD = 'test-auto-unlock-pw';

describe('AGENT_PASSWORD auto-unlock', () => {
  beforeAll(() => {
    _resetForTesting();
    if (hasColdWallet()) deleteColdWallet();
    createColdWallet(PASSWORD);
  });

  beforeEach(() => {
    lock();
  });

  it('should unlock with correct password', () => {
    expect(isUnlocked()).toBe(false);
    const ok = unlock(PASSWORD);
    expect(ok).toBe(true);
    expect(isUnlocked()).toBe(true);
  });

  it('should fail with wrong password', () => {
    const ok = unlock('wrongpassword');
    expect(ok).toBe(false);
    expect(isUnlocked()).toBe(false);
  });

  it('should succeed when already unlocked', () => {
    unlock(PASSWORD);
    expect(isUnlocked()).toBe(true);
    const ok = unlock(PASSWORD);
    expect(ok).toBe(true);
    expect(isUnlocked()).toBe(true);
  });

  it('should detect agent exists', () => {
    expect(hasColdWallet()).toBe(true);
  });
});
