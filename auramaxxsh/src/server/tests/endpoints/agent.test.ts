/**
 * Tests for multi-agent operations:
 * - POST /setup/agent (create additional agent)
 * - POST /setup/agent/import (import agent from seed)
 * - GET /setup/agents (list all agents)
 * - POST /unlock/:agentId (unlock specific agent)
 * - POST /lock/:agentId (lock specific agent)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import {
  createTestApp,
  cleanDatabase,
  testPrisma,
  TEST_PASSWORD,
  TEST_AGENT_PUBKEY,
  TEST_AGENT_PRIVATE_KEY,
  setupAndUnlockWallet,
  encryptPasswordForTest,
  resetColdWallet,
} from '../setup';
import { lock } from '../../lib/cold';
import { decryptWithPrivateKey } from '../../lib/credential-transport';
import {
  DONTLOOK_NOTE_CONTENT,
  DONTLOOK_NOTE_NAME,
  OURSECRET_NOTE_CONTENT,
  OURSECRET_NOTE_NAME,
  WORKING_WITH_SECRETS_NOTE_CONTENT,
  WORKING_WITH_SECRETS_NOTE_NAME,
} from '../../lib/oursecret';
import { NOTE_CONTENT_KEY } from '../../../../shared/credential-field-schema';

const app = createTestApp();

describe('Multi-Agent Endpoints', () => {
  let adminToken: string;
  let primaryAddress: string;

  async function ensurePrimarySetup(): Promise<void> {
    if (adminToken) return;
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
    primaryAddress = result.address;
  }

  async function expectOurSecretExists(agentId: string): Promise<void> {
    await ensurePrimarySetup();
    const res = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ agent: agentId });

    expect(res.status).toBe(200);
    const names = (res.body.credentials as Array<{ name: string }>).map((credential) => credential.name);
    expect(names).toContain(OURSECRET_NOTE_NAME);
  }

  async function expectOurSecretMissing(agentId: string): Promise<void> {
    await ensurePrimarySetup();
    const res = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ agent: agentId });

    expect(res.status).toBe(200);
    const names = (res.body.credentials as Array<{ name: string }>).map((credential) => credential.name);
    expect(names).not.toContain(OURSECRET_NOTE_NAME);
  }

  async function expectSecretMissing(agentId: string, name: string): Promise<void> {
    await ensurePrimarySetup();
    const res = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ agent: agentId });

    expect(res.status).toBe(200);
    const names = (res.body.credentials as Array<{ name: string }>).map((credential) => credential.name);
    expect(names).not.toContain(name);
  }

  async function expectSeededNoteContent(agentId: string, name: string, expectedContent: string): Promise<void> {
    await ensurePrimarySetup();
    const listRes = await request(app)
      .get('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ agent: agentId });
    expect(listRes.status).toBe(200);

    const seeded = (listRes.body.credentials as Array<{ id: string; name: string }>).find(
      (credential) => credential.name === name,
    );
    expect(seeded).toBeDefined();

    const detailRes = await request(app)
      .post(`/credentials/${seeded!.id}/read`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(detailRes.status).toBe(200);
    const decrypted = JSON.parse(
      decryptWithPrivateKey(detailRes.body.encrypted as string, TEST_AGENT_PRIVATE_KEY),
    ) as { fields: Array<{ key: string; value: string }> };
    const contentField = decrypted.fields.find(
      (field) => field.key === NOTE_CONTENT_KEY,
    );
    expect(contentField?.value).toContain(expectedContent);
  }

  beforeAll(async () => {
    await cleanDatabase();
    resetColdWallet();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  // =========================================================================
  // Setup: create and unlock primary agent first
  // =========================================================================

  describe('Primary agent setup', () => {
    it('should create and unlock primary agent', async () => {
      await ensurePrimarySetup();

      expect(adminToken).toBeDefined();
      expect(primaryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it('should seed OURSECRET for primary agent', async () => {
      await expectOurSecretExists('primary');
    });

    it('should expose seeded OURSECRET content field for primary agent', async () => {
      await expectSeededNoteContent('primary', OURSECRET_NOTE_NAME, OURSECRET_NOTE_CONTENT);
    });

    it('should seed DONTLOOK for primary agent', async () => {
      const res = await request(app)
        .get('/credentials')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ agent: 'primary' });

      expect(res.status).toBe(200);
      const names = (res.body.credentials as Array<{ name: string }>).map((credential) => credential.name);
      expect(names).toContain(DONTLOOK_NOTE_NAME);
    });

    it('should expose seeded DONTLOOK content field for primary agent', async () => {
      await expectSeededNoteContent('primary', DONTLOOK_NOTE_NAME, DONTLOOK_NOTE_CONTENT);
    });

    it('should seed WORKING_WITH_SECRETS for primary agent', async () => {
      const res = await request(app)
        .get('/credentials')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ agent: 'primary' });

      expect(res.status).toBe(200);
      const names = (res.body.credentials as Array<{ name: string }>).map((credential) => credential.name);
      expect(names).toContain(WORKING_WITH_SECRETS_NOTE_NAME);
    });

    it('should expose seeded WORKING_WITH_SECRETS content field for primary agent', async () => {
      await expectSeededNoteContent('primary', WORKING_WITH_SECRETS_NOTE_NAME, WORKING_WITH_SECRETS_NOTE_CONTENT);
    });

    it('should seed OURSECRET as plain_note type', async () => {
      await ensurePrimarySetup();
      const res = await request(app)
        .get('/credentials')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ agent: 'primary' });

      expect(res.status).toBe(200);
      const credential = (res.body.credentials as Array<{ name: string; type: string }>)
        .find((c) => c.name === OURSECRET_NOTE_NAME);
      expect(credential).toBeDefined();
      expect(credential!.type).toBe('plain_note');
    });

    it('should seed WORKING_WITH_SECRETS as plain_note type', async () => {
      await ensurePrimarySetup();
      const res = await request(app)
        .get('/credentials')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ agent: 'primary' });

      expect(res.status).toBe(200);
      const credential = (res.body.credentials as Array<{ name: string; type: string }>)
        .find((c) => c.name === WORKING_WITH_SECRETS_NOTE_NAME);
      expect(credential).toBeDefined();
      expect(credential!.type).toBe('plain_note');
    });

    it('should seed DONTLOOK as note (secret) type', async () => {
      await ensurePrimarySetup();
      const res = await request(app)
        .get('/credentials')
        .set('Authorization', `Bearer ${adminToken}`)
        .query({ agent: 'primary' });

      expect(res.status).toBe(200);
      const credential = (res.body.credentials as Array<{ name: string; type: string }>)
        .find((c) => c.name === DONTLOOK_NOTE_NAME);
      expect(credential).toBeDefined();
      expect(credential!.type).toBe('note');
    });

    it('should not create a default linked agent agent', async () => {
      const agentsRes = await request(app).get('/setup/agents');
      expect(agentsRes.status).toBe(200);
      const agentAgent = (agentsRes.body.agents as Array<{ id: string; name?: string; mode?: string; linkedTo?: string; parentAgentId?: string }>)
        .find((agent) => (agent.name || '').trim().toLowerCase() === 'agent' && agent.mode === 'linked' && agent.linkedTo === 'primary' && agent.parentAgentId === 'primary');

      expect(agentAgent).toBeUndefined();
    });

  });

  // =========================================================================
  // GET /setup/agents - List agents
  // =========================================================================

  describe('GET /setup/agents', () => {
    it('should list the primary agent', async () => {
      const res = await request(app).get('/setup/agents');

      expect(res.status).toBe(200);
      expect(res.body.agents).toBeInstanceOf(Array);
      expect(res.body.agents.length).toBeGreaterThanOrEqual(1);

      const primary = res.body.agents.find((v: { isPrimary: boolean }) => v.isPrimary);
      expect(primary).toBeDefined();
      expect(primary.address).toMatch(/^0x/);
      expect(primary.isUnlocked).toBe(true);
      expect(primary.createdAt).toBeDefined();
    });

    it('should include solana address in agent listing', async () => {
      const res = await request(app).get('/setup/agents');
      const primary = res.body.agents.find((v: { isPrimary: boolean }) => v.isPrimary);
      // Solana address is a base58 string
      expect(primary.solanaAddress).toBeDefined();
      expect(typeof primary.solanaAddress).toBe('string');
      expect(primary.solanaAddress.length).toBeGreaterThan(20);
    });
  });

  // =========================================================================
  // POST /setup/agent - Create additional agent
  // =========================================================================

  describe('POST /setup/agent', () => {
    const AGENT_PASSWORD = 'secondary-agent-pw';

    it('should reject without auth', async () => {
      const encrypted = encryptPasswordForTest(AGENT_PASSWORD);
      const res = await request(app)
        .post('/setup/agent')
        .send({ encrypted, name: 'Test Agent' });

      expect(res.status).toBe(401);
    });

    it('should reject without encrypted password', async () => {
      const res = await request(app)
        .post('/setup/agent')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Test Agent' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('ncrypted');
    });

    it('should reject short password', async () => {
      const encrypted = encryptPasswordForTest('short');
      const res = await request(app)
        .post('/setup/agent')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ encrypted });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('8 characters');
    });

    it('should reject when primary is locked', async () => {
      // Lock all agents
      lock();

      const encrypted = encryptPasswordForTest(AGENT_PASSWORD);
      const res = await request(app)
        .post('/setup/agent')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ encrypted, name: 'Test Agent' });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('unlocked');

      // Re-unlock primary for subsequent tests
      const primaryEncrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({ pubkey: TEST_AGENT_PUBKEY, encrypted: primaryEncrypted });
      adminToken = unlockRes.body.token;
    });

    it('should create a new agent with name', async () => {
      const encrypted = encryptPasswordForTest(AGENT_PASSWORD);
      const res = await request(app)
        .post('/setup/agent')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ encrypted, name: 'Savings' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.id).toBeDefined();
      expect(res.body.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(res.body.solanaAddress).toBeDefined();
      expect(res.body.mnemonic).toBeDefined();
      expect(res.body.mnemonic.split(' ').length).toBe(12);
      expect(res.body.name).toBe('Savings');

      await expectOurSecretExists(res.body.id as string);
    });

    it('should create a agent without name', async () => {
      const encrypted = encryptPasswordForTest(AGENT_PASSWORD);
      const res = await request(app)
        .post('/setup/agent')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ encrypted });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.id).toBeDefined();
      expect(res.body.address).toMatch(/^0x/);
    });

    it('should list all agents after creation', async () => {
      const res = await request(app).get('/setup/agents');

      expect(res.status).toBe(200);
      // Primary + 2 new agents = 3
      expect(res.body.agents.length).toBeGreaterThanOrEqual(3);

      // Primary agent should be first
      expect(res.body.agents[0].isPrimary).toBe(true);

      // Named agent should have the name
      const savings = res.body.agents.find((v: { name?: string }) => v.name === 'Savings');
      expect(savings).toBeDefined();
    });
  });

  // =========================================================================
  // POST /setup/agent/import - Import agent from seed
  // =========================================================================

  describe('POST /setup/agent/import', () => {
    const IMPORT_PASSWORD = 'import-agent-pw1';
    // Valid 12-word BIP-39 mnemonic for testing
    const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    it('should reject without auth', async () => {
      const encrypted = encryptPasswordForTest(IMPORT_PASSWORD);
      const res = await request(app)
        .post('/setup/agent/import')
        .send({ mnemonic: TEST_MNEMONIC, encrypted });

      expect(res.status).toBe(401);
    });

    it('should reject without mnemonic', async () => {
      const encrypted = encryptPasswordForTest(IMPORT_PASSWORD);
      const res = await request(app)
        .post('/setup/agent/import')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ encrypted });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('mnemonic');
    });

    it('should reject without encrypted password', async () => {
      const res = await request(app)
        .post('/setup/agent/import')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ mnemonic: TEST_MNEMONIC });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('ncrypted');
    });

    it('should import a agent from seed', async () => {
      const encrypted = encryptPasswordForTest(IMPORT_PASSWORD);
      const res = await request(app)
        .post('/setup/agent/import')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ mnemonic: TEST_MNEMONIC, encrypted, name: 'Imported' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.id).toBeDefined();
      expect(res.body.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(res.body.solanaAddress).toBeDefined();
      expect(res.body.name).toBe('Imported');

      await expectOurSecretExists(res.body.id as string);
    });

    it('imported agent should appear in agent list', async () => {
      const res = await request(app).get('/setup/agents');
      const imported = res.body.agents.find((v: { name?: string }) => v.name === 'Imported');
      expect(imported).toBeDefined();
      expect(imported.isUnlocked).toBe(true); // Auto-unlocked after import
    });
  });

  // =========================================================================
  // POST /unlock/:agentId - Per-agent unlock
  // =========================================================================

  describe('POST /unlock/:agentId', () => {
    let secondaryAgentId: string;
    const SECONDARY_PASSWORD = 'agent-specific-pw';

    beforeAll(async () => {
      // Create a fresh secondary agent for these tests
      const encrypted = encryptPasswordForTest(SECONDARY_PASSWORD);
      const res = await request(app)
        .post('/setup/agent')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ encrypted, name: 'UnlockTest' });

      secondaryAgentId = res.body.id;
    });

    it('should reject without encrypted password', async () => {
      const res = await request(app)
        .post(`/unlock/${secondaryAgentId}`)
        .send({ pubkey: TEST_AGENT_PUBKEY });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('ncrypted');
    });

    it('should reject wrong password', async () => {
      const encrypted = encryptPasswordForTest('wrongpassword');
      const res = await request(app)
        .post(`/unlock/${secondaryAgentId}`)
        .send({ pubkey: TEST_AGENT_PUBKEY, encrypted });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('nvalid');
    });

    it('should unlock specific agent with correct password', async () => {
      // Lock all first
      await request(app)
        .post('/lock')
        .set('Authorization', `Bearer ${adminToken}`)
        .send();

      const encrypted = encryptPasswordForTest(SECONDARY_PASSWORD);
      const res = await request(app)
        .post(`/unlock/${secondaryAgentId}`)
        .send({ pubkey: TEST_AGENT_PUBKEY, encrypted });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.agentId).toBe(secondaryAgentId);
      expect(res.body.address).toMatch(/^0x/);
      expect(res.body.token).toBeDefined();
      adminToken = res.body.token; // Update token
    });

    it('should show agent as unlocked in listing', async () => {
      const res = await request(app).get('/setup/agents');
      const agent = res.body.agents.find((v: { id: string }) => v.id === secondaryAgentId);
      expect(agent).toBeDefined();
      expect(agent.isUnlocked).toBe(true);
    });

    it('should allow multiple agents unlocked simultaneously', async () => {
      // Unlock primary too
      const primaryEncrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({ pubkey: TEST_AGENT_PUBKEY, encrypted: primaryEncrypted });

      expect(unlockRes.status).toBe(200);
      adminToken = unlockRes.body.token;

      // Both should be unlocked
      const res = await request(app).get('/setup/agents');
      const primary = res.body.agents.find((v: { isPrimary: boolean }) => v.isPrimary);
      const secondary = res.body.agents.find((v: { id: string }) => v.id === secondaryAgentId);

      expect(primary.isUnlocked).toBe(true);
      expect(secondary.isUnlocked).toBe(true);
    });
  });

  // =========================================================================
  // POST /lock/:agentId - Per-agent lock
  // =========================================================================

  describe('POST /lock/:agentId', () => {
    let lockTestAgentId: string;
    const LOCK_TEST_PASSWORD = 'lock-test-pwd12';

    beforeAll(async () => {
      // Ensure primary is unlocked and we have a token
      const primaryEncrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({ pubkey: TEST_AGENT_PUBKEY, encrypted: primaryEncrypted });
      adminToken = unlockRes.body.token;

      // Create a agent for lock testing
      const encrypted = encryptPasswordForTest(LOCK_TEST_PASSWORD);
      const res = await request(app)
        .post('/setup/agent')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ encrypted, name: 'LockTest' });

      lockTestAgentId = res.body.id;
    });

    it('should require auth to lock a agent', async () => {
      const res = await request(app)
        .post(`/lock/${lockTestAgentId}`)
        .send();

      expect(res.status).toBe(401);
    });

    it('should lock a specific agent', async () => {
      const res = await request(app)
        .post(`/lock/${lockTestAgentId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('locked');
    });

    it('locked agent should show as locked in listing', async () => {
      const res = await request(app).get('/setup/agents');
      const agent = res.body.agents.find((v: { id: string }) => v.id === lockTestAgentId);
      expect(agent).toBeDefined();
      expect(agent.isUnlocked).toBe(false);
    });

    it('primary agent should still be unlocked after locking secondary', async () => {
      const res = await request(app).get('/setup/agents');
      const primary = res.body.agents.find((v: { isPrimary: boolean }) => v.isPrimary);
      expect(primary.isUnlocked).toBe(true);
    });

    it('should handle locking an already-locked agent', async () => {
      const res = await request(app)
        .post(`/lock/${lockTestAgentId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('already locked');
    });

    it('should re-unlock after lock', async () => {
      const encrypted = encryptPasswordForTest(LOCK_TEST_PASSWORD);
      const res = await request(app)
        .post(`/unlock/${lockTestAgentId}`)
        .send({ pubkey: TEST_AGENT_PUBKEY, encrypted });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      adminToken = res.body.token;
    });
  });

  // =========================================================================
  // POST /lock - Lock all agents
  // =========================================================================

  describe('POST /lock (all)', () => {
    it('should lock all agents at once', async () => {
      // Ensure primary is unlocked
      const primaryEncrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({ pubkey: TEST_AGENT_PUBKEY, encrypted: primaryEncrypted });
      adminToken = unlockRes.body.token;

      // Verify at least primary is unlocked
      let agentRes = await request(app).get('/setup/agents');
      const unlockedBefore = agentRes.body.agents.filter((v: { isUnlocked: boolean }) => v.isUnlocked).length;
      expect(unlockedBefore).toBeGreaterThanOrEqual(1);

      // Lock all
      const res = await request(app)
        .post('/lock')
        .set('Authorization', `Bearer ${adminToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify all locked
      agentRes = await request(app).get('/setup/agents');
      const unlockedAfter = agentRes.body.agents.filter((v: { isUnlocked: boolean }) => v.isUnlocked).length;
      expect(unlockedAfter).toBe(0);
    });
  });

  // =========================================================================
  // Agent isolation tests
  // =========================================================================

  describe('Agent isolation', () => {
    let agentAId: string;
    let agentBId: string;
    const AGENT_A_PASSWORD = 'agent-a-pass12';
    const AGENT_B_PASSWORD = 'agent-b-pass12';

    beforeAll(async () => {
      // Reset everything and start fresh
      resetColdWallet();
      await cleanDatabase();

      // Setup primary
      const result = await setupAndUnlockWallet();
      adminToken = result.adminToken;

      // Create agent A
      const encA = encryptPasswordForTest(AGENT_A_PASSWORD);
      const resA = await request(app)
        .post('/setup/agent')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ encrypted: encA, name: 'AgentA' });
      agentAId = resA.body.id;

      // Create agent B
      const encB = encryptPasswordForTest(AGENT_B_PASSWORD);
      const resB = await request(app)
        .post('/setup/agent')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ encrypted: encB, name: 'AgentB' });
      agentBId = resB.body.id;
    });

    it('agent A password should not unlock agent B', async () => {
      // Lock all
      await request(app)
        .post('/lock')
        .set('Authorization', `Bearer ${adminToken}`)
        .send();

      // Try to unlock agent B with agent A's password
      const encrypted = encryptPasswordForTest(AGENT_A_PASSWORD);
      const res = await request(app)
        .post(`/unlock/${agentBId}`)
        .send({ pubkey: TEST_AGENT_PUBKEY, encrypted });

      expect(res.status).toBe(401);
    });

    it('each agent has a unique address', async () => {
      const res = await request(app).get('/setup/agents');
      const addresses = res.body.agents.map((v: { address: string }) => v.address);
      const uniqueAddresses = new Set(addresses);
      expect(uniqueAddresses.size).toBe(addresses.length);
    });

    it('each agent has a unique solana address', async () => {
      const res = await request(app).get('/setup/agents');
      const solAddresses = res.body.agents
        .map((v: { solanaAddress?: string }) => v.solanaAddress)
        .filter(Boolean);
      const uniqueSolAddresses = new Set(solAddresses);
      expect(uniqueSolAddresses.size).toBe(solAddresses.length);
    });

    it('can unlock only one agent while others remain locked', async () => {
      // Lock all
      const primaryEnc = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app).post('/unlock').send({ pubkey: TEST_AGENT_PUBKEY, encrypted: primaryEnc });
      adminToken = unlockRes.body.token;
      await request(app).post('/lock').set('Authorization', `Bearer ${adminToken}`).send();

      // Unlock only agent A
      const encA = encryptPasswordForTest(AGENT_A_PASSWORD);
      const res = await request(app).post(`/unlock/${agentAId}`).send({ pubkey: TEST_AGENT_PUBKEY, encrypted: encA });
      expect(res.status).toBe(200);
      adminToken = res.body.token;

      // Check states
      const agentRes = await request(app).get('/setup/agents');
      const agentA = agentRes.body.agents.find((v: { id: string }) => v.id === agentAId);
      const agentB = agentRes.body.agents.find((v: { id: string }) => v.id === agentBId);
      const primary = agentRes.body.agents.find((v: { isPrimary: boolean }) => v.isPrimary);

      expect(agentA.isUnlocked).toBe(true);
      expect(agentB.isUnlocked).toBe(false);
      expect(primary.isUnlocked).toBe(false);
    });
  });
});
