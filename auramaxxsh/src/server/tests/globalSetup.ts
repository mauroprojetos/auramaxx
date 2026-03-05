/**
 * Global setup for tests - runs ONCE before all workers.
 * Builds a template database that workers copy for isolation.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const TEST_DATA_DIR = path.resolve(__dirname, '..', 'test-data');
const TEMPLATE_DB_PATH = path.join(TEST_DATA_DIR, 'template.db');
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', 'prisma', 'migrations');

function applySqlMigrations(dbPath: string): void {
  const migrationDirs = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const dir of migrationDirs) {
    const sqlPath = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
    if (!fs.existsSync(sqlPath)) continue;
    const sql = fs.readFileSync(sqlPath, 'utf8');
    execFileSync('sqlite3', [dbPath], { input: sql, timeout: 10000 });
  }
}

export default async function globalSetup() {
  // Create test data directory
  if (!fs.existsSync(TEST_DATA_DIR)) {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  }

  // Clean up old template
  if (fs.existsSync(TEMPLATE_DB_PATH)) {
    fs.unlinkSync(TEMPLATE_DB_PATH);
  }

  // Build template DB with all migrations applied
  applySqlMigrations(TEMPLATE_DB_PATH);

  // Force DELETE journal mode to avoid WAL files that can cause
  // corruption when PrismaClient instances overlap within a fork
  execFileSync('sqlite3', [TEMPLATE_DB_PATH, 'PRAGMA journal_mode=DELETE;'], { timeout: 10000 });

  console.log('\n✓ Template database created at', TEMPLATE_DB_PATH);

  // Return teardown function
  return async function globalTeardown() {
    if (fs.existsSync(TEMPLATE_DB_PATH)) {
      fs.unlinkSync(TEMPLATE_DB_PATH);
    }
    if (fs.existsSync(TEST_DATA_DIR)) {
      const entries = fs.readdirSync(TEST_DATA_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('worker-')) {
          fs.rmSync(path.join(TEST_DATA_DIR, entry.name), { recursive: true, force: true });
        }
      }
    }
  };
}
