/**
 * Tests for /unlock and /lock endpoints
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_PUBKEY, encryptPasswordForTest, resetColdWallet } from '../setup';
import { lock } from '../../lib/cold';
import { ESCALATION_CONTRACT_VERSION } from '../../lib/escalation-contract';
import { ESCALATION_ROUTE_IDS } from '../../lib/escalation-route-registry';

const app = createTestApp();

describe('Unlock/Lock Endpoints', () => {
  beforeAll(async () => {
    await cleanDatabase();

    // Remove and recreate cold wallet
    resetColdWallet();

    // Create a wallet for testing (using encrypted password)
    const encrypted = encryptPasswordForTest(TEST_PASSWORD);
    await request(app)
      .post('/setup')
      .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  beforeEach(() => {
    // Lock wallet before each test
    lock();
  });

  describe('POST /unlock', () => {
    it('should reject request without encrypted password', async () => {
      const res = await request(app)
        .post('/unlock')
        .send({ pubkey: TEST_AGENT_PUBKEY });

      expect(res.status).toBe(400);
      expect(res.body.error.toLowerCase()).toContain('encrypted');
    });

    it('should reject request without pubkey', async () => {
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const res = await request(app)
        .post('/unlock')
        .send({ encrypted });

      expect(res.status).toBe(400);
      expect(res.body.error.toLowerCase()).toContain('pubkey');
    });

    it('should reject wrong password', async () => {
      const encrypted = encryptPasswordForTest('wrongpassword');
      const res = await request(app)
        .post('/unlock')
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('should unlock with correct password', async () => {
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const res = await request(app)
        .post('/unlock')
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it('should return token when re-unlocking with correct password', async () => {
      // First unlock - should get a token
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const firstRes = await request(app)
        .post('/unlock')
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

      expect(firstRes.body.token).toBeDefined();

      // Try again with correct password - should get a new token
      // (allows users to get tokens after page refresh)
      const res = await request(app)
        .post('/unlock')
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
    });

    it('should reject re-unlock with wrong password', async () => {
      // First unlock with correct password
      const correctEncrypted = encryptPasswordForTest(TEST_PASSWORD);
      await request(app)
        .post('/unlock')
        .send({ encrypted: correctEncrypted, pubkey: TEST_AGENT_PUBKEY });

      // Try again with wrong password - should fail
      const wrongEncrypted = encryptPasswordForTest('wrongpassword');
      const res = await request(app)
        .post('/unlock')
        .send({ encrypted: wrongEncrypted, pubkey: TEST_AGENT_PUBKEY });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('POST /unlock/recover', () => {
    it('recovers primary agent with valid mnemonic and sets new password', async () => {
      resetColdWallet();
      const setupEncrypted = encryptPasswordForTest(TEST_PASSWORD);
      const setupRes = await request(app)
        .post('/setup')
        .send({ encrypted: setupEncrypted, pubkey: TEST_AGENT_PUBKEY });
      expect(setupRes.status).toBe(200);
      const mnemonic = setupRes.body.mnemonic as string;

      lock();

      const recoverRes = await request(app)
        .post('/unlock/recover')
        .send({
          mnemonic,
          newPassword: 'newpassword123',
          pubkey: TEST_AGENT_PUBKEY,
        });

      expect(recoverRes.status).toBe(200);
      expect(recoverRes.body.success).toBe(true);
      expect(recoverRes.body.token).toBeDefined();

      lock();
      const oldPasswordRes = await request(app)
        .post('/unlock')
        .send({ encrypted: encryptPasswordForTest(TEST_PASSWORD), pubkey: TEST_AGENT_PUBKEY });
      expect(oldPasswordRes.status).toBe(401);

      const newPasswordRes = await request(app)
        .post('/unlock')
        .send({ encrypted: encryptPasswordForTest('newpassword123'), pubkey: TEST_AGENT_PUBKEY });
      expect(newPasswordRes.status).toBe(200);
    });

    it('rejects recovery when mnemonic does not match primary agent', async () => {
      resetColdWallet();
      const setupEncrypted = encryptPasswordForTest(TEST_PASSWORD);
      await request(app)
        .post('/setup')
        .send({ encrypted: setupEncrypted, pubkey: TEST_AGENT_PUBKEY });

      lock();

      const recoverRes = await request(app)
        .post('/unlock/recover')
        .send({
          mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
          newPassword: 'newpassword123',
          pubkey: TEST_AGENT_PUBKEY,
        });

      expect(recoverRes.status).toBe(401);
    });
  });

  describe('POST /unlock/rekey', () => {
    it('should require admin token for rekey', async () => {
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY, scope: 'extension' });
      expect(unlockRes.status).toBe(200);
      const extensionToken = unlockRes.body.token as string;
      expect(extensionToken).toBeDefined();

      const rekeyRes = await request(app)
        .post('/unlock/rekey')
        .set('Authorization', `Bearer ${extensionToken}`)
        .send({ pubkey: TEST_AGENT_PUBKEY });

      expect(rekeyRes.status).toBe(403);
      expect(rekeyRes.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
      expect(rekeyRes.body.requiresHumanApproval).toBe(true);
      expect(rekeyRes.body.approvalScope).toBe('session_token');
      expect(rekeyRes.body.routeId).toBe(ESCALATION_ROUTE_IDS.WALLET_ADMIN);
      expect(rekeyRes.body.required).toEqual(['admin:*']);
      expect(typeof rekeyRes.body.reqId).toBe('string');
      expect(rekeyRes.body.claimStatus).toBe('pending');
      expect(rekeyRes.body.retryReady).toBe(false);
    });

    it('should reject revoked bearer token', async () => {
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const firstUnlockRes = await request(app)
        .post('/unlock')
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });
      expect(firstUnlockRes.status).toBe(200);
      const oldToken = firstUnlockRes.body.token as string;

      const lockRes = await request(app)
        .post('/lock')
        .set('Authorization', `Bearer ${oldToken}`)
        .send();
      expect(lockRes.status).toBe(200);

      const secondUnlockRes = await request(app)
        .post('/unlock')
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });
      expect(secondUnlockRes.status).toBe(200);

      const revokedRes = await request(app)
        .post('/unlock/rekey')
        .set('Authorization', `Bearer ${oldToken}`)
        .send({ pubkey: TEST_AGENT_PUBKEY });

      expect(revokedRes.status).toBe(401);
      expect(revokedRes.body.error).toContain('revoked');
    });

    it('should revoke old token only after successful rekey', async () => {
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });
      expect(unlockRes.status).toBe(200);
      const oldToken = unlockRes.body.token as string;

      const rekeyRes = await request(app)
        .post('/unlock/rekey')
        .set('Authorization', `Bearer ${oldToken}`)
        .send({ pubkey: TEST_AGENT_PUBKEY });
      expect(rekeyRes.status).toBe(200);
      expect(rekeyRes.body.success).toBe(true);
      const newToken = rekeyRes.body.token as string;
      expect(newToken).toBeDefined();

      const oldTokenRes = await request(app)
        .post('/lock')
        .set('Authorization', `Bearer ${oldToken}`)
        .send();
      expect(oldTokenRes.status).toBe(401);
      expect(oldTokenRes.body.error).toContain('revoked');

      const newTokenRes = await request(app)
        .post('/lock')
        .set('Authorization', `Bearer ${newToken}`)
        .send();
      expect(newTokenRes.status).toBe(200);
      expect(newTokenRes.body.success).toBe(true);
    });
  });

  describe('POST /unlock/:agentId', () => {
    it('unlocks descendant child agents when unlocking a parent agent', async () => {
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const rootUnlockRes = await request(app)
        .post('/unlock')
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });
      expect(rootUnlockRes.status).toBe(200);
      const adminToken = rootUnlockRes.body.token as string;

      const parentRes = await request(app)
        .post('/agents/credential')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'ops-parent', mode: 'linked' });
      expect(parentRes.status).toBe(200);
      const parentAgentId = parentRes.body.agent.id as string;

      const childRes = await request(app)
        .post('/agents/credential')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'ops-child', mode: 'linked', parentAgentId: parentAgentId });
      expect(childRes.status).toBe(200);
      const childAgentId = childRes.body.agent.id as string;

      lock();

      const parentUnlockRes = await request(app)
        .post(`/unlock/${parentAgentId}`)
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });
      expect(parentUnlockRes.status).toBe(200);

      const agentsRes = await request(app).get('/setup/agents');
      expect(agentsRes.status).toBe(200);
      const parentAgent = agentsRes.body.agents.find((agent: { id: string }) => agent.id === parentAgentId);
      const childAgent = agentsRes.body.agents.find((agent: { id: string }) => agent.id === childAgentId);
      expect(parentAgent?.isUnlocked).toBe(true);
      expect(childAgent?.isUnlocked).toBe(true);
    });
  });

  describe('POST /lock', () => {
    it('should lock an unlocked wallet', async () => {
      // First unlock and get admin token
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

      const adminToken = unlockRes.body.token;
      expect(adminToken).toBeDefined();

      // Then lock with admin token
      const res = await request(app)
        .post('/lock')
        .set('Authorization', `Bearer ${adminToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('locked');
    });

    it('should require authentication', async () => {
      const res = await request(app)
        .post('/lock')
        .send();

      expect(res.status).toBe(401);
    });

    it('should revoke the current admin token after lock', async () => {
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

      const adminToken = unlockRes.body.token;
      expect(adminToken).toBeDefined();

      const lockRes = await request(app)
        .post('/lock')
        .set('Authorization', `Bearer ${adminToken}`)
        .send();

      expect(lockRes.status).toBe(200);
      expect(lockRes.body.success).toBe(true);

      const reuseRes = await request(app)
        .post('/lock')
        .set('Authorization', `Bearer ${adminToken}`)
        .send();

      expect(reuseRes.status).toBe(401);
      expect(reuseRes.body.error).toContain('revoked');
    });
  });

  describe('Unlock state verification', () => {
    it('should show unlocked status in /setup', async () => {
      // Unlock
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      await request(app)
        .post('/unlock')
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

      const res = await request(app).get('/setup');
      expect(res.body.unlocked).toBe(true);
    });

    it('should show locked status after /lock', async () => {
      // Unlock then lock
      const encrypted = encryptPasswordForTest(TEST_PASSWORD);
      const unlockRes = await request(app)
        .post('/unlock')
        .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

      const adminToken = unlockRes.body.token;

      await request(app)
        .post('/lock')
        .set('Authorization', `Bearer ${adminToken}`)
        .send();

      const res = await request(app).get('/setup');
      expect(res.body.unlocked).toBe(false);
    });
  });
});
