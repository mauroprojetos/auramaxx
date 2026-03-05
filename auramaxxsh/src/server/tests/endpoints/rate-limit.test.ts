/**
 * Tests for rate limiting middleware (BUG-2)
 *
 * The production app (server/index.ts) applies express-rate-limit to routes:
 *   /unlock, POST /setup  => 5 req / 15 min  (authBruteForceLimit)
 *   GET /setup        => general limiter (read-only status check, not a brute force vector)
 *   /auth             => 10 req / 1 min  (authRequestLimit)
 *   /send, /swap, /fund => 30 req / 1 min per Bearer token (txLimit)
 *   everything else   => 100 req / 1 min (generalLimit)
 *
 * The standard createTestApp() does NOT include rate limiters, so we build
 * a dedicated app here that mirrors the production middleware stack.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { generateKeyPairSync } from 'crypto';
import { decryptWithPrivateKey } from '../../lib/credential-transport';
import { cleanDatabase, testPrisma, TEST_PASSWORD, TEST_AGENT_ID, TEST_AGENT_PUBKEY, setupAndUnlockWallet, encryptPasswordForTest } from '../setup';

// Routes
import setupRoutes from '../../routes/setup';
import unlockRoutes from '../../routes/unlock';
import lockRoutes from '../../routes/lock';
import walletRoutes from '../../routes/wallet';
import sendRoutes from '../../routes/send';
import swapRoutes from '../../routes/swap';
import authRoutes from '../../routes/auth';
import fundRoutes from '../../routes/fund';
import actionsRoutes from '../../routes/actions';

const { publicKey: RATE_LIMIT_TEST_PUBKEY_PEM, privateKey: RATE_LIMIT_TEST_PRIVATE_KEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const RATE_LIMIT_TEST_PUBKEY = Buffer.from(RATE_LIMIT_TEST_PUBKEY_PEM, 'utf8').toString('base64');
const RATE_LIMIT_TEST_IP = '203.0.113.10';

/**
 * Create a test app WITH rate limiting middleware.
 * Uses the same limiter configuration as server/index.ts.
 */
function createRateLimitedApp() {
  const app = express();
  app.set('trust proxy', true);

  app.use(cors());
  app.use(express.json());

  const rateLimitResponse = (_req: express.Request, res: express.Response) => {
    res.status(429).json({ success: false, error: 'Too many requests, please try again later' });
  };

  // Strict limit for password/setup endpoints (brute force protection)
  const authBruteForceLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitResponse,
    validate: false, // Suppress IPv6 validation warning in tests
  });

  // Registration/token request limit
  const authRequestLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitResponse,
    validate: false,
  });

  // Transaction endpoints - keyed by Bearer token
  const txLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
      }
      return req.ip || 'unknown';
    },
    handler: rateLimitResponse,
    validate: false,
  });

  // General rate limit
  const generalLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitResponse,
    validate: false,
  });

  // Apply rate limits to specific routes before general middleware
  app.use('/unlock', authBruteForceLimit);
  // Only brute-force-limit setup writes; GET /setup (status check) uses the general limiter
  app.use('/setup', (req, res, next) => {
    if (req.method === 'GET') return next();
    return authBruteForceLimit(req, res, next);
  });
  app.use('/auth', authRequestLimit);
  app.use('/send', txLimit);
  app.use('/swap', txLimit);
  app.use('/fund', txLimit);

  // General rate limit for everything else
  app.use(generalLimit);

  // Routes
  app.use('/setup', setupRoutes);
  app.use('/unlock', unlockRoutes);
  app.use('/lock', lockRoutes);
  app.use('/actions', actionsRoutes);
  app.use('/wallets', walletRoutes);
  app.use('/wallet', walletRoutes);
  app.use('/send', sendRoutes);
  app.use('/swap', swapRoutes);
  app.use('/auth', authRoutes);
  app.use('/fund', fundRoutes);

  // Health check (for general limit testing)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}

describe('Rate Limiting', () => {
  let adminToken: string;
  let agentToken: string;

  beforeAll(async () => {
    await cleanDatabase();

    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;

    // Create an agent token for txLimit tests.
    // Use a separate non-rate-limited app so setup requests don't count.
    const { createTestApp } = await import('../setup');
    const helperApp = createTestApp();

    const authRes = await request(helperApp)
      .post('/auth')
      .send({
        pubkey: RATE_LIMIT_TEST_PUBKEY,
        agentId: TEST_AGENT_ID,
        limit: 1.0,
        profile: 'dev'
      });

    expect(authRes.status).toBe(200);

    await request(helperApp)
      .post(`/actions/${authRes.body.requestId}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approved: true });

    const pollRes = await request(helperApp)
      .get(`/auth/${authRes.body.requestId}`).set('x-aura-claim-secret', authRes.body.secret);

    if (!pollRes.body.encryptedToken) {
      throw new Error(`Agent token retrieval failed: ${JSON.stringify(pollRes.body)}`);
    }

    agentToken = decryptWithPrivateKey(pollRes.body.encryptedToken, RATE_LIMIT_TEST_PRIVATE_KEY_PEM);
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  describe('/unlock - brute force limit (5 per 15 min)', () => {
    it('should return 429 after 5 requests', async () => {
      // Each test gets its own rate-limited app to isolate counters
      const localApp = createRateLimitedApp();

      const encrypted = encryptPasswordForTest('wrongpassword');

      // First 5 requests should NOT be 429
      for (let i = 0; i < 5; i++) {
        const res = await request(localApp)
          .post('/unlock')
          .send({
        pubkey: TEST_AGENT_PUBKEY, encrypted });
        expect(res.status).not.toBe(429);
      }

      // 6th request should be 429
      const res = await request(localApp)
        .post('/unlock')
        .send({
        pubkey: TEST_AGENT_PUBKEY, encrypted });

      expect(res.status).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Too many requests');
    });
  });

  describe('POST /setup - brute force limit (5 per 15 min)', () => {
    it('should return 429 after 5 requests', async () => {
      const localApp = createRateLimitedApp();

      // Send 5 requests (they will fail for various reasons, but won't be 429)
      for (let i = 0; i < 5; i++) {
        const res = await request(localApp)
          .post('/setup')
          .send({ encrypted: 'invalid' });
        expect(res.status).not.toBe(429);
      }

      // 6th request should be 429
      const res = await request(localApp)
        .post('/setup')
        .send({ encrypted: 'invalid' });

      expect(res.status).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Too many requests');
    });
  });

  describe('GET /setup - exempt from brute force limit', () => {
    it('should not be brute-force limited (uses general limiter instead)', async () => {
      const localApp = createRateLimitedApp();

      // Send more than 5 GET /setup requests — should all succeed (not 429)
      // because GET /setup bypasses the brute-force limiter
      for (let i = 0; i < 10; i++) {
        const res = await request(localApp)
          .get('/setup');
        expect(res.status).not.toBe(429);
      }
    });

    it('GET requests should not count toward POST brute force limit', async () => {
      const localApp = createRateLimitedApp();

      // Send 10 GET requests first (would exhaust brute force limit if counted)
      for (let i = 0; i < 10; i++) {
        await request(localApp).get('/setup');
      }

      // POST /setup should still work (brute force counter not affected by GETs)
      const res = await request(localApp)
        .post('/setup')
        .send({ encrypted: 'invalid' });
      expect(res.status).not.toBe(429);
    });
  });

  describe('/auth - request limit (10 per minute)', () => {
    it('should return 429 after 10 requests', async () => {
      const localApp = createRateLimitedApp();

      // Send 10 requests
      for (let i = 0; i < 10; i++) {
        const res = await request(localApp)
          .post('/auth')
          .set('X-Forwarded-For', RATE_LIMIT_TEST_IP)
          .send({
        pubkey: TEST_AGENT_PUBKEY, agentId: `rate-limit-agent-${i}` });
        expect(res.status).not.toBe(429);
      }

      // 11th request should be rate limited
      const res = await request(localApp)
        .post('/auth')
        .set('X-Forwarded-For', RATE_LIMIT_TEST_IP)
        .send({
        pubkey: TEST_AGENT_PUBKEY, agentId: 'rate-limit-agent-overflow' });

      expect(res.status).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Too many requests');
    });

    it('should also rate-limit GET /auth/:id under the same /auth limiter', async () => {
      const localApp = createRateLimitedApp();

      // Burn through 10 requests with GET /auth/nonexistent
      for (let i = 0; i < 10; i++) {
        const res = await request(localApp)
          .get('/auth/nonexistent').set('x-aura-claim-secret', 'test')
          .set('X-Forwarded-For', RATE_LIMIT_TEST_IP);
        expect(res.status).not.toBe(429);
      }

      // 11th request should be 429
      const res = await request(localApp)
        .get('/auth/nonexistent').set('x-aura-claim-secret', 'test')
        .set('X-Forwarded-For', RATE_LIMIT_TEST_IP);

      expect(res.status).toBe(429);
      expect(res.body.error).toContain('Too many requests');
    });
  });

  describe('/swap - tx limit (30 per minute per Bearer token)', () => {
    it('should return 429 after 30 requests with same Bearer token', async () => {
      const localApp = createRateLimitedApp();

      // Send 30 requests (they will fail auth/validation, but rate limit counts them)
      for (let i = 0; i < 30; i++) {
        const res = await request(localApp)
          .post('/swap')
          .set('Authorization', `Bearer ${agentToken}`)
          .send({});
        expect(res.status).not.toBe(429);
      }

      // 31st request should be rate limited
      const res = await request(localApp)
        .post('/swap')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({});

      expect(res.status).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Too many requests');
    });

    it('should track rate limits separately per Bearer token', async () => {
      const localApp = createRateLimitedApp();

      const tokenA = 'fake-token-a';
      const tokenB = 'fake-token-b';

      // Exhaust rate limit for tokenA
      for (let i = 0; i < 30; i++) {
        await request(localApp)
          .post('/swap')
          .set('Authorization', `Bearer ${tokenA}`)
          .send({});
      }

      // tokenA should be blocked
      const resA = await request(localApp)
        .post('/swap')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({});
      expect(resA.status).toBe(429);

      // tokenB should still work (not 429)
      const resB = await request(localApp)
        .post('/swap')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({});
      expect(resB.status).not.toBe(429);
    });
  });

  describe('/send - tx limit (30 per minute per Bearer token)', () => {
    it('should return 429 after 30 requests', async () => {
      const localApp = createRateLimitedApp();

      for (let i = 0; i < 30; i++) {
        const res = await request(localApp)
          .post('/send')
          .set('Authorization', `Bearer ${agentToken}`)
          .send({});
        expect(res.status).not.toBe(429);
      }

      const res = await request(localApp)
        .post('/send')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({});

      expect(res.status).toBe(429);
      expect(res.body.error).toContain('Too many requests');
    });
  });

  describe('/fund - tx limit (30 per minute per Bearer token)', () => {
    it('should return 429 after 30 requests', async () => {
      const localApp = createRateLimitedApp();

      for (let i = 0; i < 30; i++) {
        const res = await request(localApp)
          .post('/fund')
          .set('Authorization', `Bearer ${agentToken}`)
          .send({});
        expect(res.status).not.toBe(429);
      }

      const res = await request(localApp)
        .post('/fund')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({});

      expect(res.status).toBe(429);
      expect(res.body.error).toContain('Too many requests');
    });
  });

  describe('/health - general limit (100 per minute)', () => {
    it('should return 429 after 100 requests', async () => {
      const localApp = createRateLimitedApp();

      // Send 100 requests
      for (let i = 0; i < 100; i++) {
        const res = await request(localApp)
          .get('/health');
        expect(res.status).toBe(200);
      }

      // 101st request should be rate limited
      const res = await request(localApp)
        .get('/health');

      expect(res.status).toBe(429);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Too many requests');
    });
  });

  describe('Rate limit response format', () => {
    it('should return standard rate limit headers', async () => {
      const localApp = createRateLimitedApp();

      // Make a request to get rate limit headers
      const res = await request(localApp)
        .get('/health');

      expect(res.status).toBe(200);
      // express-rate-limit with standardHeaders: true sets RateLimit-* headers
      expect(res.headers['ratelimit-limit']).toBeDefined();
      expect(res.headers['ratelimit-remaining']).toBeDefined();
    });

    it('should include correct JSON body on 429', async () => {
      const localApp = createRateLimitedApp();

      // Exhaust the /setup limit (5 requests)
      for (let i = 0; i < 5; i++) {
        await request(localApp)
          .post('/setup')
          .send({ encrypted: 'invalid' });
      }

      const res = await request(localApp)
        .post('/setup')
        .send({ encrypted: 'invalid' });

      expect(res.status).toBe(429);
      expect(res.body).toEqual({
        success: false,
        error: 'Too many requests, please try again later'
      });
    });
  });
});
