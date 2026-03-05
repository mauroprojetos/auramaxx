/**
 * Tests for /setup endpoint
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import {
  createTestApp,
  cleanDatabase,
  testPrisma,
  TEST_PASSWORD,
  TEST_AGENT_PUBKEY,
  encryptPasswordForTest,
  resetColdWallet,
  setupAndUnlockWallet,
} from '../setup';

const app = createTestApp();

describe('POST /setup', () => {
  beforeAll(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  beforeEach(() => {
    resetColdWallet();
  });

  it('should reject request without encrypted password', async () => {
    const res = await request(app)
      .post('/setup')
      .send({ pubkey: TEST_AGENT_PUBKEY });

    expect(res.status).toBe(400);
    expect(res.body.error.toLowerCase()).toContain('encrypted');
  });

  it('should reject request without pubkey', async () => {
    const encrypted = encryptPasswordForTest(TEST_PASSWORD);
    const res = await request(app)
      .post('/setup')
      .send({ encrypted });

    expect(res.status).toBe(400);
    expect(res.body.error.toLowerCase()).toContain('pubkey');
  });

  it('should reject password shorter than 8 characters', async () => {
    const encrypted = encryptPasswordForTest('short');
    const res = await request(app)
      .post('/setup')
      .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('8 characters');
  });

  it('should create cold wallet with valid password', async () => {
    const encrypted = encryptPasswordForTest(TEST_PASSWORD);
    const res = await request(app)
      .post('/setup')
      .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(res.body.mnemonic).toBeDefined();
    expect(res.body.mnemonic.split(' ').length).toBe(12);
  });

  it('should reject if cold wallet already exists', async () => {
    // First create a wallet
    const encrypted = encryptPasswordForTest(TEST_PASSWORD);
    await request(app)
      .post('/setup')
      .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

    // Try to create another
    const res = await request(app)
      .post('/setup')
      .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already exists');
  });
});

describe('GET /setup', () => {
  beforeEach(() => {
    resetColdWallet();
  });

  it('should return hasWallet: false when no wallet exists', async () => {
    const res = await request(app).get('/setup');

    expect(res.status).toBe(200);
    expect(res.body.hasWallet).toBe(false);
  });

  it('should return hasWallet: true after setup', async () => {
    const encrypted = encryptPasswordForTest(TEST_PASSWORD);
    await request(app)
      .post('/setup')
      .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

    const res = await request(app).get('/setup');

    expect(res.status).toBe(200);
    expect(res.body.hasWallet).toBe(true);
    expect(res.body.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});

describe('POST /setup/password', () => {
  beforeEach(() => {
    resetColdWallet();
  });

  it('requires admin auth', async () => {
    const res = await request(app)
      .post('/setup/password')
      .send({
        currentEncrypted: encryptPasswordForTest(TEST_PASSWORD),
        newEncrypted: encryptPasswordForTest('newpassword123'),
      });

    expect(res.status).toBe(401);
  });

  it('rotates primary agent password and allows unlock with new password', async () => {
    const { adminToken } = await setupAndUnlockWallet(TEST_PASSWORD);
    const newPassword = 'newpassword123';

    const rotateRes = await request(app)
      .post('/setup/password')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        currentEncrypted: encryptPasswordForTest(TEST_PASSWORD),
        newEncrypted: encryptPasswordForTest(newPassword),
      });

    expect(rotateRes.status).toBe(200);
    expect(rotateRes.body.success).toBe(true);

    await request(app)
      .post('/lock')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    const oldUnlock = await request(app)
      .post('/unlock')
      .send({ encrypted: encryptPasswordForTest(TEST_PASSWORD), pubkey: TEST_AGENT_PUBKEY });
    expect(oldUnlock.status).toBe(401);

    const newUnlock = await request(app)
      .post('/unlock')
      .send({ encrypted: encryptPasswordForTest(newPassword), pubkey: TEST_AGENT_PUBKEY });
    expect(newUnlock.status).toBe(200);
    expect(newUnlock.body.success).toBe(true);
  });

  it('rejects invalid current password', async () => {
    const { adminToken } = await setupAndUnlockWallet(TEST_PASSWORD);

    const res = await request(app)
      .post('/setup/password')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        currentEncrypted: encryptPasswordForTest('wrong-password'),
        newEncrypted: encryptPasswordForTest('newpassword123'),
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Invalid current password');
  });

  it('rejects new password shorter than 8 chars', async () => {
    const { adminToken } = await setupAndUnlockWallet(TEST_PASSWORD);

    const res = await request(app)
      .post('/setup/password')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        currentEncrypted: encryptPasswordForTest(TEST_PASSWORD),
        newEncrypted: encryptPasswordForTest('short'),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('8 characters');
  });
});
