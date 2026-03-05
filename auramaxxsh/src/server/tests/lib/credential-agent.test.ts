/**
 * Tests for credential agent subkey derivation and lifecycle hooks
 *
 * Tests:
 * - deriveCredentialKey: determinism, uniqueness, format
 * - unlockCredentialAgent/lockCredentialAgent/lockAllCredentialAgents
 * - getCredentialAgentKey/isCredentialAgentUnlocked
 * - Lifecycle integration with cold.ts (unlock/lock propagation)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DATA_PATHS } from '../../lib/config';
import {
  deriveCredentialKey,
  unlockCredentialAgent,
  lockCredentialAgent,
  lockAllCredentialAgents,
  getCredentialAgentKey,
  isCredentialAgentUnlocked,
  _resetCredentialAgentForTesting,
} from '../../lib/credential-agent';
import {
  createColdWallet,
  createAgent,
  getPrimaryAgentPassword,
  unlockAgent,
  lockAgent,
  lockAllAgents,
  lock,
  _resetForTesting as resetColdState,
} from '../../lib/cold';
import { clearSessions } from '../../lib/sessions';
import { revokeAdminTokens } from '../../lib/auth';

const TEST_PASSWORD = 'testpassword123';

function cleanAgentFiles(): void {
  const walletsDir = DATA_PATHS.wallets;
  if (fs.existsSync(walletsDir)) {
    for (const file of fs.readdirSync(walletsDir)) {
      if (file.startsWith('agent-') && file.endsWith('.json')) {
        fs.unlinkSync(path.join(walletsDir, file));
      }
    }
  }
}

describe('Credential Agent', () => {
  beforeEach(() => {
    resetColdState();
    _resetCredentialAgentForTesting();
    revokeAdminTokens();
    clearSessions();
    cleanAgentFiles();
  });

  afterEach(() => {
    lock();
    _resetCredentialAgentForTesting();
    cleanAgentFiles();
  });

  describe('deriveCredentialKey()', () => {
    it('should be deterministic (same inputs → same output)', () => {
      const key1 = deriveCredentialKey('agent-1', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
      const key2 = deriveCredentialKey('agent-1', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
      expect(key1).toBe(key2);
    });

    it('should produce different keys for different agentIds', () => {
      const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      const key1 = deriveCredentialKey('agent-a', mnemonic);
      const key2 = deriveCredentialKey('agent-b', mnemonic);
      expect(key1).not.toBe(key2);
    });

    it('should produce different keys for different mnemonics', () => {
      const key1 = deriveCredentialKey('agent-1', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
      const key2 = deriveCredentialKey('agent-1', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong');
      expect(key1).not.toBe(key2);
    });

    it('should return a 64-character hex string (256 bits)', () => {
      const key = deriveCredentialKey('test', 'test mnemonic');
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('unlock/lock lifecycle', () => {
    it('should unlock credential agent when wallet agent is unlocked', () => {
      createColdWallet(TEST_PASSWORD);

      expect(isCredentialAgentUnlocked('primary')).toBe(true);
      expect(getCredentialAgentKey('primary')).not.toBeNull();
      expect(getCredentialAgentKey('primary')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should lock credential agent when wallet agent is locked', () => {
      createColdWallet(TEST_PASSWORD);
      expect(isCredentialAgentUnlocked('primary')).toBe(true);

      lockAgent('primary');

      expect(isCredentialAgentUnlocked('primary')).toBe(false);
      expect(getCredentialAgentKey('primary')).toBeNull();
    });

    it('clears cached primary password when locking primary agent directly', () => {
      createColdWallet(TEST_PASSWORD);
      expect(getPrimaryAgentPassword()).toBe(TEST_PASSWORD);

      lockAgent('primary');

      expect(getPrimaryAgentPassword()).toBeNull();
    });

    it('should lock all credential agents when all wallet agents are locked', () => {
      createColdWallet(TEST_PASSWORD);
      expect(isCredentialAgentUnlocked('primary')).toBe(true);

      lockAllAgents();

      expect(isCredentialAgentUnlocked('primary')).toBe(false);
    });

    it('should re-unlock credential agent on wallet re-unlock', () => {
      createColdWallet(TEST_PASSWORD);
      const keyBefore = getCredentialAgentKey('primary');

      lockAgent('primary');
      expect(getCredentialAgentKey('primary')).toBeNull();

      unlockAgent('primary', TEST_PASSWORD);
      const keyAfter = getCredentialAgentKey('primary');

      expect(keyAfter).not.toBeNull();
      // Derived key should be deterministic — same after re-unlock
      expect(keyAfter).toBe(keyBefore);
    });

    it('should return null for locked/non-existent agent', () => {
      expect(getCredentialAgentKey('nonexistent')).toBeNull();
      expect(isCredentialAgentUnlocked('nonexistent')).toBe(false);
    });
  });

  describe('unlockCredentialAgent()', () => {
    it('should return true on success', () => {
      createColdWallet(TEST_PASSWORD);
      _resetCredentialAgentForTesting(); // clear to re-test manually
      const result = unlockCredentialAgent('primary');
      expect(result).toBe(true);
    });

    it('should return false when wallet agent is locked', () => {
      // No wallet agent unlocked
      const result = unlockCredentialAgent('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('_resetCredentialAgentForTesting()', () => {
    it('should clear all credential agent sessions', () => {
      createColdWallet(TEST_PASSWORD);
      expect(isCredentialAgentUnlocked('primary')).toBe(true);

      _resetCredentialAgentForTesting();

      expect(isCredentialAgentUnlocked('primary')).toBe(false);
      expect(getCredentialAgentKey('primary')).toBeNull();
    });
  });
});
