/**
 * Tests for credential CRUD operations
 *
 * Tests:
 * - Create credential with encrypted sensitive fields
 * - Read metadata (no decryption)
 * - Decrypt sensitive fields round-trip
 * - Update name/meta, update sensitive fields (re-encrypt)
 * - Delete credential
 * - List with filters (agentId, type, tag, query)
 * - Error when agent locked
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DATA_PATHS } from '../../lib/config';
import {
  createCredential,
  getCredential,
  readCredentialSecrets,
  updateCredential,
  deleteCredential,
  listCredentials,
} from '../../lib/credentials';
import { _resetCredentialAgentForTesting, deriveCredentialKey, getCredentialAgentKey } from '../../lib/credential-agent';
import { createColdWallet, lock, _resetForTesting as resetColdState } from '../../lib/cold';
import { clearSessions } from '../../lib/sessions';
import { revokeAdminTokens } from '../../lib/auth';
import { CredentialField } from '../../types';

const TEST_PASSWORD = 'testpassword123';
const TEST_AGENT_ID = 'primary';

function cleanCredentialFiles(): void {
  const dirs = [
    DATA_PATHS.credentials,
    DATA_PATHS.credentialsArchive,
    DATA_PATHS.credentialsRecentlyDeleted,
  ];

  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        if (file.startsWith('cred-') && file.endsWith('.json')) {
          fs.unlinkSync(path.join(dir, file));
        }
      }
    }
  }
}

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

describe('Credential CRUD', () => {
  beforeEach(() => {
    resetColdState();
    _resetCredentialAgentForTesting();
    revokeAdminTokens();
    clearSessions();
    cleanAgentFiles();
    cleanCredentialFiles();

    // Create and unlock a agent (this also unlocks credential agent)
    createColdWallet(TEST_PASSWORD);
    // Remove any seeded credentials so this suite remains deterministic.
    cleanCredentialFiles();
  });

  afterEach(() => {
    lock();
    _resetCredentialAgentForTesting();
    cleanCredentialFiles();
    cleanAgentFiles();
  });

  const testFields: CredentialField[] = [
    { key: 'username', value: 'alice', type: 'text', sensitive: false },
    { key: 'password', value: 's3cret!', type: 'secret', sensitive: true },
  ];

  describe('createCredential()', () => {
    it('should create a credential file on disk', () => {
      const cred = createCredential(TEST_AGENT_ID, 'login', 'My Login', { tags: ['work'] }, testFields);

      expect(cred.id).toMatch(/^cred-[a-z0-9]{8}$/);
      expect(cred.agentId).toBe(TEST_AGENT_ID);
      expect(cred.type).toBe('login');
      expect(cred.name).toBe('My Login');
      expect(cred.meta).toMatchObject({ tags: ['work'] });
      expect(cred.meta.sensitive_field_keys).toEqual(['username', 'password']);
      expect(cred.encrypted).toBeDefined();
      expect(cred.encrypted.ciphertext).toBeTruthy();

      // Verify file exists
      const filePath = path.join(DATA_PATHS.credentials, `${cred.id}.json`);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('should throw when agent is locked', () => {
      lock();
      expect(() => createCredential(TEST_AGENT_ID, 'login', 'Test', {}, testFields))
        .toThrow('locked');
    });
  });

  describe('getCredential()', () => {
    it('should return credential metadata without decryption', () => {
      const created = createCredential(TEST_AGENT_ID, 'login', 'My Login', { url: 'https://example.com' }, testFields);
      const fetched = getCredential(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.name).toBe('My Login');
      expect(fetched!.meta).toMatchObject({ url: 'https://example.com' });
      expect(fetched!.meta.sensitive_field_keys).toEqual(['username', 'password']);
      // encrypted field is present but we shouldn't try to read it as plaintext
      expect(fetched!.encrypted.ciphertext).toBeTruthy();
    });

    it('should return null for non-existent credential', () => {
      expect(getCredential('cred-nonexist')).toBeNull();
    });
  });

  describe('readCredentialSecrets()', () => {
    it('should decrypt sensitive fields round-trip', () => {
      const created = createCredential(TEST_AGENT_ID, 'login', 'Test', {}, testFields);
      const secrets = readCredentialSecrets(created.id);

      expect(secrets).toEqual(testFields);
    });

    it('should throw for non-existent credential', () => {
      expect(() => readCredentialSecrets('cred-nonexist')).toThrow('not found');
    });

    it('should throw when agent is locked', () => {
      const created = createCredential(TEST_AGENT_ID, 'login', 'Test', {}, testFields);
      lock();
      expect(() => readCredentialSecrets(created.id)).toThrow('locked');
    });
  });

  describe('updateCredential()', () => {
    it('should update name and meta', () => {
      const created = createCredential(TEST_AGENT_ID, 'login', 'Old Name', { tags: ['old'] }, testFields);
      const updated = updateCredential(created.id, {
        name: 'New Name',
        meta: { tags: ['new'] },
      });

      expect(updated.name).toBe('New Name');
      expect(updated.meta).toEqual({ tags: ['new'] });
      // updatedAt should be a valid ISO string (may be same ms as created)
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(created.createdAt).getTime()
      );
    });

    it('should update sensitive fields (re-encrypt)', () => {
      const created = createCredential(TEST_AGENT_ID, 'login', 'Test', {}, testFields);
      const newFields: CredentialField[] = [
        { key: 'password', value: 'newpassword!', type: 'secret', sensitive: true },
      ];

      updateCredential(created.id, { sensitiveFields: newFields });

      const secrets = readCredentialSecrets(created.id);
      expect(secrets).toEqual(newFields);
    });

    it('should throw for non-existent credential', () => {
      expect(() => updateCredential('cred-nonexist', { name: 'x' })).toThrow('not found');
    });

    it('should throw when updating sensitive fields with agent locked', () => {
      const created = createCredential(TEST_AGENT_ID, 'login', 'Test', {}, testFields);
      lock();
      expect(() => updateCredential(created.id, {
        sensitiveFields: [{ key: 'password', value: 'new', type: 'secret', sensitive: true }],
      })).toThrow('locked');
    });
  });

  describe('deleteCredential()', () => {
    it('should delete the credential file', () => {
      const created = createCredential(TEST_AGENT_ID, 'login', 'Test', {}, testFields);
      const result = deleteCredential(created.id);

      expect(result).toBe(true);
      expect(getCredential(created.id)).toBeNull();
    });

    it('should return false for non-existent credential', () => {
      expect(deleteCredential('cred-nonexist')).toBe(false);
    });
  });

  describe('listCredentials()', () => {
    beforeEach(() => {
      createCredential(TEST_AGENT_ID, 'login', 'Work Login', { tags: ['work', 'dev'] }, testFields);
      createCredential(TEST_AGENT_ID, 'card', 'My Card', { tags: ['personal'] }, [
        { key: 'number', value: '4111111111111111', type: 'text', sensitive: true },
      ]);
      createCredential(TEST_AGENT_ID, 'note', 'API Notes', { tags: ['work'] }, [
        { key: 'content', value: 'secret stuff', type: 'text', sensitive: true },
      ]);
    });

    it('should list all credentials', () => {
      const all = listCredentials();
      expect(all.length).toBe(3);
    });

    it('should filter by type', () => {
      const cards = listCredentials({ type: 'card' });
      expect(cards.length).toBe(1);
      expect(cards[0].name).toBe('My Card');
    });

    it('should filter by tag', () => {
      const work = listCredentials({ tag: 'work' });
      expect(work.length).toBe(2);
    });

    it('should filter by query (name)', () => {
      const results = listCredentials({ query: 'login' });
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Work Login');
    });

    it('should filter by agentId', () => {
      const results = listCredentials({ agentId: TEST_AGENT_ID });
      expect(results.length).toBe(3);

      const none = listCredentials({ agentId: 'nonexistent' });
      expect(none.length).toBe(0);
    });
  });
});
