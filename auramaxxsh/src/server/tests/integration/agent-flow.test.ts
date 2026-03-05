/**
 * Integration Tests: Complete Agent Flow
 *
 * Tests the full lifecycle of an agent:
 * 1. Request access token (POST /auth)
 * 2. Poll for approval (GET /auth/:id)
 * 3. Human approves (POST /actions/:id/resolve)
 * 4. Create hot wallet (POST /wallet/create)
 * 5. Fund hot wallet from cold (POST /fund) - executes immediately
 * 6. Send transaction (POST /send)
 *
 * These tests verify the complete flow works end-to-end with proper
 * token validation, wallet ownership, and spending limit enforcement.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_PUBKEY, setupAndUnlockWallet, encryptPasswordForTest, decryptTestToken } from '../setup';
import { lock } from '../../lib/cold';
import { revokeAdminTokens } from '../../lib/auth';
import { eth } from '../helpers/amounts';

const app = createTestApp();

describe('Integration: Complete Agent Lifecycle', () => {
 beforeAll(async () => {
 await cleanDatabase();
 });

 afterAll(async () => {
 await testPrisma.$disconnect();
 });

 it('should complete full agent lifecycle: auth -> wallet -> fund attempt', async () => {
 // ============================================
 // STEP 1: Human sets up cold wallet and gets admin token
 // ============================================
 const { address: coldAddress, adminToken } = await setupAndUnlockWallet();
 console.log('Cold wallet created:', coldAddress);

 // ============================================
 // STEP 2: Agent requests access token
 // ============================================
 const authRes = await request(app)
 .post('/auth')
 .send({
 pubkey: TEST_AGENT_PUBKEY,
 agentId: 'trading-bot-v1',
 profile: 'admin',
 profileOverrides: { scope: ['wallet:create:hot', 'fund'] },
 limit: 1.0 });

 expect(authRes.status).toBe(200);
 expect(authRes.body.requestId).toBeDefined();
 expect(authRes.body.secret).toBeDefined();

 const requestId = authRes.body.requestId;
 const secret = authRes.body.secret;
 console.log('Auth request created:', requestId);

 // ============================================
 // STEP 3: Agent polls - should be pending
 // ============================================
 const pollPendingRes = await request(app)
 .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);

 expect(pollPendingRes.status).toBe(200);
 expect(pollPendingRes.body.status).toBe('pending');
 console.log('Auth status: pending');

 // ============================================
 // STEP 4: Verify notification was created
 // ============================================
 const notifications = await testPrisma.notification.findMany({
 where: { type: 'pending_approval' }
 });
 expect(notifications.length).toBeGreaterThan(0);
 console.log('Notification created for human');

 // ============================================
 // STEP 5: Human approves the request
 // ============================================
 const approveRes = await request(app)
 .post(`/actions/${requestId}/resolve`)
 .set('Authorization', `Bearer ${adminToken}`)
 .send({ approved: true });

 expect(approveRes.status).toBe(200);
 expect(approveRes.body.success).toBe(true);
 expect(approveRes.body.token).toBeDefined();
 console.log('Human approved request');

 // ============================================
 // STEP 6: Agent retrieves token
 // ============================================
 const pollApprovedRes = await request(app)
 .get(`/auth/${requestId}`).set('x-aura-claim-secret', secret);

 expect(pollApprovedRes.status).toBe(200);
 expect(pollApprovedRes.body.status).toBe('approved');
 expect(pollApprovedRes.body.encryptedToken).toBeDefined();

 const token = decryptTestToken(pollApprovedRes.body.encryptedToken);
 console.log('Agent retrieved token');

 // ============================================
 // STEP 7: Agent creates hot wallet
 // ============================================
 const createWalletRes = await request(app)
 .post('/wallet/create')
 .set('Authorization', `Bearer ${token}`)
 .send({
 tier: 'hot',
 name: 'Trading Wallet',
 color: '#3498db'
 });

 expect(createWalletRes.status).toBe(200);
 expect(createWalletRes.body.wallet.address).toBeDefined();
 expect(createWalletRes.body.wallet.tier).toBe('hot');

 const hotWalletAddress = createWalletRes.body.wallet.address;
 console.log('Hot wallet created:', hotWalletAddress);

 // ============================================
 // STEP 8: Agent lists their wallets
 // ============================================
 const listRes = await request(app)
 .get('/wallets')
 .set('Authorization', `Bearer ${token}`);

 expect(listRes.status).toBe(200);
 expect(listRes.body.wallets.length).toBe(1);
 expect(listRes.body.wallets[0].address).toBe(hotWalletAddress);
 expect(listRes.body.agent.remaining).toBe(1.0);
 console.log('Agent can list their wallets');

 // ============================================
 // STEP 9: Agent attempts to fund hot wallet
 // This would execute immediately if there was a real blockchain
 // ============================================
 const fundRes = await request(app)
 .post('/fund')
 .set('Authorization', `Bearer ${token}`)
 .send({
 to: hotWalletAddress,
 amount: eth('0.5')
 });

 // Will fail at blockchain level (no real RPC), but passes all validation
 // Status 400 means it got past auth and hit the blockchain error
 expect(fundRes.status).toBe(400);
 console.log('Fund request passed validation (blockchain call expected to fail in tests)');
 });
});

describe('Integration: Fund Spending Limit Enforcement', () => {
 let token: string;
 let walletAddress: string;

 beforeAll(async () => {
 await cleanDatabase();

 const { adminToken } = await setupAndUnlockWallet();

 // Create agent with 0.5 ETH limit
 const authRes = await request(app)
 .post('/auth')
 .send({
 pubkey: TEST_AGENT_PUBKEY,
 agentId: 'limited-agent',
 profile: 'admin',
 profileOverrides: { scope: ['wallet:create:hot', 'fund'] },
 limit: 0.5 });

 await request(app)
 .post(`/actions/${authRes.body.requestId}/resolve`)
 .set('Authorization', `Bearer ${adminToken}`)
 .send({ approved: true });

 const pollRes = await request(app)
 .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

 token = decryptTestToken(pollRes.body.encryptedToken);

 const walletRes = await request(app)
 .post('/wallet/create')
 .set('Authorization', `Bearer ${token}`)
 .send({ tier: 'hot' });

 walletAddress = walletRes.body.wallet.address;
 });

 afterAll(async () => {
 await testPrisma.$disconnect();
 });

 it('should reject fund request exceeding limit', async () => {
 const res = await request(app)
 .post('/fund')
 .set('Authorization', `Bearer ${token}`)
 .send({
 to: walletAddress,
 amount: eth('1.0') // Exceeds 0.5 limit
 });

 expect(res.status).toBe(403);
 expect(res.body.error).toContain('exceeds');
 expect(res.body.remaining).toBe(0.5);
 });

 it('should allow fund request within limit (fails at blockchain level)', async () => {
 const res = await request(app)
 .post('/fund')
 .set('Authorization', `Bearer ${token}`)
 .send({
 to: walletAddress,
 amount: eth('0.3') // Within 0.5 limit
 });

 // Passes validation, fails at blockchain (no real RPC)
 expect(res.status).toBe(400);
 expect(res.body.error).not.toContain('exceeds');
 });
});

describe('Integration: Multi-Agent Fund Isolation', () => {
 let agent1Token: string;
 let agent1Wallet: string;
 let agent2Token: string;
 let agent2Wallet: string;

 beforeAll(async () => {
 await cleanDatabase();

 const { adminToken } = await setupAndUnlockWallet();

 // Create Agent 1
 const auth1 = await request(app)
 .post('/auth')
 .send({ agentId: 'agent-1',
 profile: 'admin', pubkey: TEST_AGENT_PUBKEY,
 profileOverrides: { scope: ['wallet:create:hot', 'fund'] },
 limit: 1.0 });

 await request(app)
 .post(`/actions/${auth1.body.requestId}/resolve`)
 .set('Authorization', `Bearer ${adminToken}`)
 .send({ approved: true });

 const poll1 = await request(app)
 .get(`/auth/${auth1.body.requestId}`).set('x-aura-claim-secret', auth1.body.secret);
 agent1Token = decryptTestToken(poll1.body.encryptedToken);

 const wallet1 = await request(app)
 .post('/wallet/create')
 .set('Authorization', `Bearer ${agent1Token}`)
 .send({ tier: 'hot', name: 'Agent 1 Wallet' });
 agent1Wallet = wallet1.body.wallet.address;

 // Create Agent 2
 const auth2 = await request(app)
 .post('/auth')
 .send({ agentId: 'agent-2',
 profile: 'admin', pubkey: TEST_AGENT_PUBKEY,
 profileOverrides: { scope: ['wallet:create:hot', 'fund'] },
 limit: 1.0 });

 await request(app)
 .post(`/actions/${auth2.body.requestId}/resolve`)
 .set('Authorization', `Bearer ${adminToken}`)
 .send({ approved: true });

 const poll2 = await request(app)
 .get(`/auth/${auth2.body.requestId}`).set('x-aura-claim-secret', auth2.body.secret);
 agent2Token = decryptTestToken(poll2.body.encryptedToken);

 const wallet2 = await request(app)
 .post('/wallet/create')
 .set('Authorization', `Bearer ${agent2Token}`)
 .send({ tier: 'hot', name: 'Agent 2 Wallet' });
 agent2Wallet = wallet2.body.wallet.address;
 });

 afterAll(async () => {
 await testPrisma.$disconnect();
 });

 it('agent 1 cannot fund agent 2\'s wallet', async () => {
 const res = await request(app)
 .post('/fund')
 .set('Authorization', `Bearer ${agent1Token}`)
 .send({
 to: agent2Wallet,
 amount: eth('0.1')
 });

 expect(res.status).toBe(403);
 expect(res.body.error).toContain('does not have access');
 });

 it('agent 2 cannot fund agent 1\'s wallet', async () => {
 const res = await request(app)
 .post('/fund')
 .set('Authorization', `Bearer ${agent2Token}`)
 .send({
 to: agent1Wallet,
 amount: eth('0.1')
 });

 expect(res.status).toBe(403);
 expect(res.body.error).toContain('does not have access');
 });

 it('each agent can attempt to fund their own wallet', async () => {
 // Both will fail at blockchain level but pass validation
 const res1 = await request(app)
 .post('/fund')
 .set('Authorization', `Bearer ${agent1Token}`)
 .send({
 to: agent1Wallet,
 amount: eth('0.1')
 });

 // 400 = passed auth, failed at blockchain (expected in tests)
 expect(res1.status).toBe(400);

 const res2 = await request(app)
 .post('/fund')
 .set('Authorization', `Bearer ${agent2Token}`)
 .send({
 to: agent2Wallet,
 amount: eth('0.1')
 });

 expect(res2.status).toBe(400);
 });
});

describe('Integration: Cold Wallet Lock State', () => {
 let token: string;
 let walletAddress: string;

 beforeAll(async () => {
 await cleanDatabase();

 const { adminToken } = await setupAndUnlockWallet();

 // Create agent
 const authRes = await request(app)
 .post('/auth')
 .send({
 pubkey: TEST_AGENT_PUBKEY,
 agentId: 'lock-test-agent',
 profile: 'admin',
 profileOverrides: { scope: ['wallet:create:hot', 'fund'] },
 limit: 1.0 });

 await request(app)
 .post(`/actions/${authRes.body.requestId}/resolve`)
 .set('Authorization', `Bearer ${adminToken}`)
 .send({ approved: true });

 const pollRes = await request(app)
 .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);
 token = decryptTestToken(pollRes.body.encryptedToken);

 const walletRes = await request(app)
 .post('/wallet/create')
 .set('Authorization', `Bearer ${token}`)
 .send({ tier: 'hot' });
 walletAddress = walletRes.body.wallet.address;
 });

 afterAll(async () => {
 // Re-unlock for other tests
 const encrypted = encryptPasswordForTest(TEST_PASSWORD);
 await request(app)
 .post('/unlock')
 .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });
 await testPrisma.$disconnect();
 });

 it('should reject fund when cold wallet is locked', async () => {
 // Lock the cold wallet
 lock();

 const res = await request(app)
 .post('/fund')
 .set('Authorization', `Bearer ${token}`)
 .send({
 to: walletAddress,
 amount: eth('0.1')
 });

 expect(res.status).toBe(401);
 expect(res.body.error).toContain('locked');
 });

 it('should allow fund attempt when cold wallet is unlocked', async () => {
 // Unlock the cold wallet
 const encrypted = encryptPasswordForTest(TEST_PASSWORD);
 await request(app)
 .post('/unlock')
 .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

 const res = await request(app)
 .post('/fund')
 .set('Authorization', `Bearer ${token}`)
 .send({
 to: walletAddress,
 amount: eth('0.1')
 });

 // 400 = passed auth, failed at blockchain (expected)
 expect(res.status).toBe(400);
 expect(res.body.error).not.toContain('locked');
 });
});

describe('Integration: Token Revocation and Fund', () => {
 let token: string;
 let walletAddress: string;

 beforeAll(async () => {
 await cleanDatabase();

 const { adminToken } = await setupAndUnlockWallet();

 // Create agent
 const authRes = await request(app)
 .post('/auth')
 .send({
 pubkey: TEST_AGENT_PUBKEY,
 agentId: 'revocable-agent',
 profile: 'admin',
 profileOverrides: { scope: ['wallet:create:hot', 'fund'] },
 limit: 1.0 });

 await request(app)
 .post(`/actions/${authRes.body.requestId}/resolve`)
 .set('Authorization', `Bearer ${adminToken}`)
 .send({ approved: true });

 const pollRes = await request(app)
 .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);
 token = decryptTestToken(pollRes.body.encryptedToken);

 const walletRes = await request(app)
 .post('/wallet/create')
 .set('Authorization', `Bearer ${token}`)
 .send({ tier: 'hot' });
 walletAddress = walletRes.body.wallet.address;
 });

 afterAll(async () => {
 await testPrisma.$disconnect();
 });

 it('should reject fund after token revocation', async () => {
 // Agent revokes their own token
 await request(app)
 .post('/actions/tokens/revoke')
 .set('Authorization', `Bearer ${token}`);

 // Fund should now fail
 const res = await request(app)
 .post('/fund')
 .set('Authorization', `Bearer ${token}`)
 .send({
 to: walletAddress,
 amount: eth('0.1')
 });

 expect(res.status).toBe(401);
 expect(res.body.error).toContain('revoked');
 });
});
