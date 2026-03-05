/**
 * Test setup and helpers
 */
import { PrismaClient } from '@prisma/client';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { publicEncrypt, constants } from 'crypto';
import { DATA_PATHS } from '../lib/config';
import { deleteColdWallet, hasColdWallet, lock, _resetForTesting as resetColdState } from '../lib/cold';
import { revokeAdminTokens } from '../lib/auth';
import { clearSessions } from '../lib/sessions';
import { getPublicKey, getPrivateKey } from '../lib/transport';
import { decryptWithPrivateKey } from '../lib/credential-transport';

// Routes
import setupRoutes from '../routes/setup';
import unlockRoutes from '../routes/unlock';
import lockRoutes from '../routes/lock';
import walletRoutes from '../routes/wallet';
import sendRoutes from '../routes/send';
import swapRoutes from '../routes/swap';
import authRoutes from '../routes/auth';
import fundRoutes from '../routes/fund';
import apikeysRoutes from '../routes/apikeys';
import backupRoutes from '../routes/backup';
import nukeRoutes from '../routes/nuke';
import appRoutes from '../routes/apps';
import strategyRoutes from '../routes/strategy';
import actionsRoutes from '../routes/actions';
import credentialAgentRoutes from '../routes/credential-agents';
import credentialsRoutes from '../routes/credentials';
import agentProfilesRoutes from '../routes/agent-profiles';
import credentialSharesRoutes from '../routes/credential-shares';
import importRoutes from '../routes/import';
import adaptersRoutes from '../routes/adapters';
import launchRoutes from '../routes/launch';
import defaultsRoutes from '../routes/defaults';
import portfolioRoutes from '../routes/portfolio';
import resolveRoutes from '../routes/resolve';
import priceRoutes from '../routes/price';
import tokenRoutes from '../routes/token';
import batchRoutes from '../routes/batch';
import addressbookRoutes from '../routes/addressbook';
import bookmarkRoutes from '../routes/bookmarks';
import passkeyRoutes from '../routes/passkey';
import passkeyCredentialRoutes from '../routes/passkey-credentials';
import securityRoutes from '../routes/security';
import heartbeatRoutes from '../routes/heartbeat';

// Create test app
export function createTestApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use('/setup', setupRoutes);
  app.use('/unlock', unlockRoutes);
  app.use('/lock', lockRoutes);
  app.use('/wallets', walletRoutes);
  app.use('/wallet', walletRoutes);
  app.use('/send', sendRoutes);
  app.use('/swap', swapRoutes);
  app.use('/auth', authRoutes);
  app.use('/fund', fundRoutes);
  app.use('/apikeys', apikeysRoutes);
  app.use('/backup', backupRoutes);
  app.use('/nuke', nukeRoutes);
  app.use('/apps', appRoutes);
  app.use('/strategies', strategyRoutes);
  app.use('/actions', actionsRoutes);
  app.use('/agents/credential', credentialAgentRoutes);
  app.use('/credentials', credentialsRoutes);
  app.use('/agent-profiles', agentProfilesRoutes);
  app.use('/credential-shares', credentialSharesRoutes);
  app.use('/credentials/import', importRoutes);
  app.use('/adapters', adaptersRoutes);
  app.use('/launch', launchRoutes);
  app.use('/defaults', defaultsRoutes);
  app.use('/portfolio', portfolioRoutes);
  app.use('/resolve', resolveRoutes);
  app.use('/price', priceRoutes);
  app.use('/token', tokenRoutes);
  app.use('/batch', batchRoutes);
  app.use('/address-labels', addressbookRoutes);
  app.use('/bookmarks', bookmarkRoutes);
  app.use('/security', securityRoutes);
  app.use('/what_is_happening', heartbeatRoutes);
  app.use('/auth/passkey', passkeyRoutes);
  app.use('/credentials/passkey', passkeyCredentialRoutes);
  app.use('/credentials/import', importRoutes);

  // Health check (matches server/index.ts — needed for batch sub-request tests)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
}

// Test database client — explicitly pass datasource URL to override any .env file
// that Prisma's dotenv loading may have picked up.
export const testPrisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

// Clean up database between tests
export async function cleanDatabase() {
  // Verify we're using the test database
  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl.includes('test-data') && !dbUrl.includes('test.db')) {
    throw new Error(
      `SAFETY: Refusing to wipe non-test database!\n` +
      `  DATABASE_URL = ${dbUrl}\n` +
      `  Expected URL containing 'test-data' or 'test.db'.`
    );
  }

  await testPrisma.addressLabel.deleteMany();
  await testPrisma.tokenMetadata.deleteMany();
  await testPrisma.poolMetadata.deleteMany();
  await testPrisma.notification.deleteMany();
  await testPrisma.humanAction.deleteMany();
  await testPrisma.transaction.deleteMany();
  await testPrisma.trackedAsset.deleteMany();
  await testPrisma.hotWallet.deleteMany();
  await testPrisma.agentToken.deleteMany();
  const prismaWithOptionalAudit = testPrisma as PrismaClient & {
    credentialAccessAudit?: { deleteMany: () => Promise<unknown> };
  };
  if (prismaWithOptionalAudit.credentialAccessAudit) {
    await prismaWithOptionalAudit.credentialAccessAudit.deleteMany();
  }
  await testPrisma.strategyRun.deleteMany();
  await testPrisma.strategy.deleteMany();
  await testPrisma.appStorage.deleteMany();
  await testPrisma.systemDefault.deleteMany();
  await testPrisma.apiKey.deleteMany();
  await testPrisma.log.deleteMany();
  await testPrisma.nativeBalance.deleteMany();
  await testPrisma.nativePrice.deleteMany();
  await testPrisma.passkey.deleteMany();
  await testPrisma.syncState.deleteMany();

  // Credential files are file-backed, not DB-backed.
  const credentialsDir = DATA_PATHS.credentials;
  if (fs.existsSync(credentialsDir)) {
    for (const file of fs.readdirSync(credentialsDir)) {
      if (file.startsWith('cred-') && file.endsWith('.json')) {
        fs.unlinkSync(path.join(credentialsDir, file));
      }
    }
  }

  const shareDir = DATA_PATHS.credentialShares;
  if (fs.existsSync(shareDir)) {
    for (const file of fs.readdirSync(shareDir)) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(shareDir, file));
      }
    }
  }

  const agentProfilesPath = path.join(DATA_PATHS.wallets, 'agent-profiles.json');
  if (fs.existsSync(agentProfilesPath)) {
    fs.unlinkSync(agentProfilesPath);
  }
}

// Test constants
export const TEST_PASSWORD = 'testpassword123';
export const TEST_AGENT_ID = 'test-agent';
export const TEST_AGENT_PUBKEY = getPublicKey();
export const TEST_AGENT_PRIVATE_KEY = getPrivateKey();

/**
 * Decrypt an encryptedToken returned by `GET /auth/:id` poll responses.
 * Uses the test agent's private key that matches TEST_AGENT_PUBKEY.
 */
export function decryptTestToken(encryptedToken: string): string {
  return decryptWithPrivateKey(encryptedToken, TEST_AGENT_PRIVATE_KEY);
}

// Helper to wait for async operations
export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mock provider response for send tests
export const mockTxHash = '0x' + '1'.repeat(64);

// Re-export createTokenSync for testing convenience
export { createTokenSync as createToken } from '../lib/auth';

// Re-export ethers for test utilities
import { ethers } from 'ethers';

/**
 * Create a mock Initialize event log for V4 pool detection testing
 */
export function mockInitializeEvent(params: {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}): ethers.Log {
  const INITIALIZE_EVENT_TOPIC = '0x803151a295203f64f7e2ca2db584660e99eaf67eca6f05af1bf0707e7d38f2cf';

  // Create properly formatted indexed topics
  const poolId = ethers.keccak256(ethers.toUtf8Bytes('mock-pool-id'));
  const currency0Padded = ethers.zeroPadValue(params.currency0.toLowerCase(), 32);
  const currency1Padded = ethers.zeroPadValue(params.currency1.toLowerCase(), 32);

  // Encode data field: fee (uint24), tickSpacing (int24), hooks (address), sqrtPriceX96 (uint160), tick (int24)
  const data = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint24', 'int24', 'address', 'uint160', 'int24'],
    [params.fee, params.tickSpacing, params.hooks, BigInt('79228162514264337593543950336'), 0]
  );

  return {
    blockNumber: 1000000,
    blockHash: '0x' + '0'.repeat(64),
    transactionIndex: 0,
    removed: false,
    address: '0x6Ab04E3376fB1d12cC0b27E6F2E7485CC8bFCb53', // Pool Manager
    data,
    topics: [INITIALIZE_EVENT_TOPIC, poolId, currency0Padded, currency1Padded],
    transactionHash: '0x' + '1'.repeat(64),
    index: 0,
  } as unknown as ethers.Log;
}

/**
 * Assert we're operating on the test data directory, not production.
 * Prevents accidental deletion of real wallet files.
 */
function assertTestDir(): void {
  const walletsDir = path.resolve(DATA_PATHS.wallets);
  if (!walletsDir.includes('test-data')) {
    throw new Error(
      `SAFETY: Refusing to modify production data directory!\n` +
      `  DATA_PATHS.wallets = ${walletsDir}\n` +
      `  Expected a path containing 'test-data'.\n` +
      `  Is WALLET_DATA_DIR set? Current value: ${process.env.WALLET_DATA_DIR || '(not set)'}`
    );
  }
}

/**
 * Reset cold wallet state for testing
 * Deletes all agent files (including legacy cold.json) and clears memory state
 */
export function resetColdWallet(): void {
  assertTestDir();

  // Clear all module state (sessions, primaryAgentId, migrationDone)
  resetColdState();
  revokeAdminTokens();
  clearSessions();

  // Delete cold wallet file if exists (legacy)
  const coldPath = path.join(DATA_PATHS.wallets, 'cold.json');
  if (fs.existsSync(coldPath)) {
    fs.unlinkSync(coldPath);
  }

  // Delete all agent-*.json files
  const walletsDir = DATA_PATHS.wallets;
  if (fs.existsSync(walletsDir)) {
    const files = fs.readdirSync(walletsDir);
    for (const file of files) {
      if (file.startsWith('agent-') && file.endsWith('.json')) {
        fs.unlinkSync(path.join(walletsDir, file));
      }
    }
  }
}

/**
 * Encrypt a password using the server's public key (for testing)
 * Uses Node's crypto module instead of Web Crypto API
 */
export function encryptPasswordForTest(password: string): string {
  const publicKey = getPublicKey();
  const encrypted = publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    Buffer.from(password, 'utf8')
  );
  return encrypted.toString('base64');
}

/**
 * Setup cold wallet via API for testing
 */
export async function setupColdWallet(password: string = TEST_PASSWORD): Promise<string> {
  resetColdWallet();

  const app = createTestApp();
  const encrypted = encryptPasswordForTest(password);
  const res = await request(app)
    .post('/setup')
    .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

  if (!res.body.success) {
    throw new Error(`Failed to setup cold wallet: ${res.body.error}`);
  }

  return res.body.address;
}

/**
 * Setup and unlock cold wallet for testing
 */
export async function setupAndUnlockWallet(password: string = TEST_PASSWORD): Promise<{ address: string; adminToken: string }> {
  await setupColdWallet(password);

  // Lock first since setup auto-unlocks (but doesn't generate admin token)
  lock();
  revokeAdminTokens();

  const app = createTestApp();
  const encrypted = encryptPasswordForTest(password);
  const res = await request(app)
    .post('/unlock')
    .send({ encrypted, pubkey: TEST_AGENT_PUBKEY });

  if (!res.body.success) {
    throw new Error(`Failed to unlock wallet: ${res.body.error}`);
  }

  if (!res.body.token) {
    throw new Error('Expected admin token from unlock');
  }

  return {
    address: res.body.address,
    adminToken: res.body.token,
  };
}
