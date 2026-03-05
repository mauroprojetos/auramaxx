/**
 * Per-worker setup for parallel test execution.
 *
 * Runs as a vitest setupFile inside each forked worker process,
 * BEFORE any test file is imported. Creates an isolated data directory
 * and SQLite database per worker so tests can run in parallel without
 * DB conflicts.
 *
 * IMPORTANT: env vars are set FIRST so that even if directory/DB setup
 * fails, no test can accidentally hit ~/.auramaxx/ or the production DB.
 */
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = path.resolve(__dirname, '..', 'test-data');
const TEMPLATE_DB = path.join(TEST_DATA_DIR, 'template.db');

const poolId = process.env.VITEST_POOL_ID || '0';
const workerDir = path.join(TEST_DATA_DIR, `worker-${poolId}`);
const workerDb = path.join(workerDir, 'test.db');

// Set env vars FIRST — before any directory or DB operations that could fail.
// This ensures the safety guard in config.ts always sees a test data dir.
process.env.WALLET_DATA_DIR = workerDir;
process.env.DATABASE_URL = `file:${workerDb}`;
process.env.NODE_ENV = 'test';
process.env.WS_BROADCAST_URL = '';
process.env.WS_URL = '';
process.env.STRATEGY_CRON_SHARED_SECRET = 'test-cron-secret';

// Create worker-specific directory structure
fs.mkdirSync(path.join(workerDir, 'hot'), { recursive: true });
fs.mkdirSync(path.join(workerDir, 'pending'), { recursive: true });
fs.mkdirSync(path.join(workerDir, 'credentials'), { recursive: true });

// Copy template DB (built by globalSetup with DELETE journal mode)
fs.copyFileSync(TEMPLATE_DB, workerDb);

// Cleanup is handled by globalTeardown (in globalSetup.ts) after all workers finish.
