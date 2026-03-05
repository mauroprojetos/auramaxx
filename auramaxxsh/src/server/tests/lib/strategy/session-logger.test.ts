/**
 * Tests for session-logger.ts
 *
 * Tests:
 * - Chat sessions: create file, append reply, reuse within idle timeout, new file after timeout
 * - Tick sessions: create daily file, append multiple ticks
 * - Tool calls: logged within session
 * - Error handling: logError marks session, endChatSession with 'error' status
 * - Crash recovery: in_progress files detected and rewritten as crashed
 * - Log rotation: old directories deleted, recent ones kept
 * - Daily summary: generated from session files
 * - Concurrent sessions: multiple apps logging simultaneously
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// Use a unique temp directory for each test run
const TEST_DATA_DIR = join(tmpdir(), `aura-session-test-${randomBytes(4).toString('hex')}`);

// Override env BEFORE importing the module
// We need to unset VITEST so shouldSkip() doesn't short-circuit
const origVitest = process.env.VITEST;
const origNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  process.env.WALLET_DATA_DIR = TEST_DATA_DIR;
  delete process.env.VITEST;
  process.env.NODE_ENV = 'development';
});

afterEach(() => {
  // Restore env
  if (origVitest) process.env.VITEST = origVitest;
  else delete process.env.VITEST;
  if (origNodeEnv) process.env.NODE_ENV = origNodeEnv;
  else delete process.env.NODE_ENV;

  // Clean up test directory
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
});

// Dynamic import after env setup — must be done in each test to respect env changes
async function importLogger() {
  // Clear module cache to pick up fresh env
  const modulePath = '../../../lib/strategy/session-logger';
  const mod = await import(modulePath);
  mod.__resetSessionLogger();
  return mod;
}

describe('session-logger', () => {
  describe('chat sessions', () => {
    it('should create a session file with frontmatter and first message', async () => {
      const logger = await importLogger();

      const sessionId = logger.startChatSession('my-app', 'telegram', 'Hello AI');
      expect(sessionId).toMatch(/^s_/);

      // Give async write time to complete
      await new Promise(r => setTimeout(r, 100));

      // Find the session file
      const sessionsDir = join(TEST_DATA_DIR, 'logs', 'sessions');
      const today = new Date().toISOString().slice(0, 10);
      const dayDir = join(sessionsDir, today);
      expect(existsSync(dayDir)).toBe(true);

      const files = require('fs').readdirSync(dayDir) as string[];
      const sessionFile = files.find((f: string) => f.includes('telegram') && f.includes('my-app'));
      expect(sessionFile).toBeTruthy();

      const content = readFileSync(join(dayDir, sessionFile!), 'utf-8');
      expect(content).toContain('session_id:');
      expect(content).toContain('adapter: telegram');
      expect(content).toContain('app: my-app');
      expect(content).toContain('status: in_progress');
      expect(content).toContain('**User:** Hello AI');

      await logger.endChatSession(sessionId);
    });

    it('should append reply with timing info', async () => {
      const logger = await importLogger();

      const sessionId = logger.startChatSession('w1', 'dashboard', 'What is my balance?');
      await new Promise(r => setTimeout(r, 50));

      logger.logReply(sessionId, 'Your balance is $100.', { model: 'claude-sonnet', tokens: 150, durationMs: 1234 });
      await new Promise(r => setTimeout(r, 50));

      // Find and read the file
      const today = new Date().toISOString().slice(0, 10);
      const dayDir = join(TEST_DATA_DIR, 'logs', 'sessions', today);
      const files = require('fs').readdirSync(dayDir) as string[];
      const sessionFile = files.find((f: string) => f.includes('dashboard'));
      const content = readFileSync(join(dayDir, sessionFile!), 'utf-8');

      expect(content).toContain('**Response time:**');
      expect(content).toContain('claude-sonnet');
      expect(content).toContain('Your balance is $100.');

      await logger.endChatSession(sessionId);
    });

    it('should reuse session within idle timeout', async () => {
      const logger = await importLogger();

      const id1 = logger.startChatSession('w1', 'telegram', 'First message');
      await new Promise(r => setTimeout(r, 50));

      // Second message to same app — should reuse session
      const id2 = logger.startChatSession('w1', 'telegram', 'Second message');
      expect(id2).toBe(id1);

      await new Promise(r => setTimeout(r, 50));

      // Find and read the file
      const today = new Date().toISOString().slice(0, 10);
      const dayDir = join(TEST_DATA_DIR, 'logs', 'sessions', today);
      const files = require('fs').readdirSync(dayDir) as string[];
      const sessionFile = files.find((f: string) => f.includes('telegram') && f.includes('w1'));
      const content = readFileSync(join(dayDir, sessionFile!), 'utf-8');

      expect(content).toContain('Message 1');
      expect(content).toContain('Message 2');
      expect(content).toContain('First message');
      expect(content).toContain('Second message');

      await logger.endChatSession(id1);
    });

    it('should end session and update frontmatter', async () => {
      const logger = await importLogger();

      const sessionId = logger.startChatSession('w1', 'cli', 'Test');
      await new Promise(r => setTimeout(r, 50));

      await logger.endChatSession(sessionId, 'completed');
      await new Promise(r => setTimeout(r, 50));

      const today = new Date().toISOString().slice(0, 10);
      const dayDir = join(TEST_DATA_DIR, 'logs', 'sessions', today);
      const files = require('fs').readdirSync(dayDir) as string[];
      const sessionFile = files.find((f: string) => f.includes('cli'));
      const content = readFileSync(join(dayDir, sessionFile!), 'utf-8');

      expect(content).toContain('status: completed');
      expect(content).toContain('ended:');
      expect(content).toContain('duration:');
    });
  });

  describe('tool calls', () => {
    it('should log tool calls within a session', async () => {
      const logger = await importLogger();

      const sessionId = logger.startChatSession('w1', 'dashboard', 'Check wallets');
      await new Promise(r => setTimeout(r, 50));

      logger.logToolCall(sessionId, {
        name: 'wallet_api',
        input: { method: 'GET', endpoint: '/wallets' },
        result: '{"wallets":[]}',
        durationMs: 45,
      });
      await new Promise(r => setTimeout(r, 50));

      const today = new Date().toISOString().slice(0, 10);
      const dayDir = join(TEST_DATA_DIR, 'logs', 'sessions', today);
      const files = require('fs').readdirSync(dayDir) as string[];
      const sessionFile = files.find((f: string) => f.includes('dashboard'));
      const content = readFileSync(join(dayDir, sessionFile!), 'utf-8');

      expect(content).toContain('Tool Calls');
      expect(content).toContain('wallet_api');
      expect(content).toContain('GET /wallets');
      expect(content).toContain('45ms');

      await logger.endChatSession(sessionId);
    });
  });

  describe('error handling', () => {
    it('should log errors', async () => {
      const logger = await importLogger();

      const sessionId = logger.startChatSession('w1', 'telegram', 'Fail me');
      await new Promise(r => setTimeout(r, 50));

      logger.logError(sessionId, new Error('Connection timeout'));
      await new Promise(r => setTimeout(r, 50));

      const today = new Date().toISOString().slice(0, 10);
      const dayDir = join(TEST_DATA_DIR, 'logs', 'sessions', today);
      const files = require('fs').readdirSync(dayDir) as string[];
      const sessionFile = files.find((f: string) => f.includes('telegram'));
      const content = readFileSync(join(dayDir, sessionFile!), 'utf-8');

      expect(content).toContain('### Error');
      expect(content).toContain('Connection timeout');

      await logger.endChatSession(sessionId, 'error');
    });

    it('should mark session as error status on end', async () => {
      const logger = await importLogger();

      const sessionId = logger.startChatSession('w1', 'dashboard', 'Test error');
      await new Promise(r => setTimeout(r, 50));

      await logger.endChatSession(sessionId, 'error');
      await new Promise(r => setTimeout(r, 50));

      const today = new Date().toISOString().slice(0, 10);
      const dayDir = join(TEST_DATA_DIR, 'logs', 'sessions', today);
      const files = require('fs').readdirSync(dayDir) as string[];
      const sessionFile = files.find((f: string) => f.includes('dashboard'));
      const content = readFileSync(join(dayDir, sessionFile!), 'utf-8');

      expect(content).toContain('status: error');
    });
  });

  describe('tick sessions', () => {
    it('should create a daily tick file and log events', async () => {
      const logger = await importLogger();

      const sessionId = logger.startTickSession('trading-bot');
      expect(sessionId).toMatch(/^s_/);

      await new Promise(r => setTimeout(r, 50));

      logger.logTickEvent(sessionId, 'Sources', 'prices:5, portfolio:3 (120ms)');
      await new Promise(r => setTimeout(r, 50));

      logger.endTickSession(sessionId, 'completed', 1234);
      await new Promise(r => setTimeout(r, 50));

      const today = new Date().toISOString().slice(0, 10);
      const dayDir = join(TEST_DATA_DIR, 'logs', 'sessions', today);
      const files = require('fs').readdirSync(dayDir) as string[];
      const tickFile = files.find((f: string) => f.startsWith('ticks_trading-bot'));
      expect(tickFile).toBeTruthy();

      const content = readFileSync(join(dayDir, tickFile!), 'utf-8');
      expect(content).toContain('## Tick —');
      expect(content).toContain('Sources');
      expect(content).toContain('completed');
    });

    it('should append multiple ticks to the same daily file', async () => {
      const logger = await importLogger();

      const s1 = logger.startTickSession('w1');
      await new Promise(r => setTimeout(r, 30));
      logger.endTickSession(s1, 'completed', 100);
      await new Promise(r => setTimeout(r, 30));

      const s2 = logger.startTickSession('w1');
      await new Promise(r => setTimeout(r, 30));
      logger.endTickSession(s2, 'completed', 200);
      await new Promise(r => setTimeout(r, 30));

      const today = new Date().toISOString().slice(0, 10);
      const dayDir = join(TEST_DATA_DIR, 'logs', 'sessions', today);
      const files = require('fs').readdirSync(dayDir) as string[];
      const tickFiles = files.filter((f: string) => f.startsWith('ticks_w1'));
      // Should be a single file
      expect(tickFiles.length).toBe(1);

      const content = readFileSync(join(dayDir, tickFiles[0]), 'utf-8');
      const tickHeaders = content.match(/## Tick —/g);
      expect(tickHeaders?.length).toBe(2);
    });
  });

  describe('crash recovery', () => {
    it('should mark in_progress sessions as crashed', async () => {
      const logger = await importLogger();

      // Create a fake in_progress session file
      const today = new Date().toISOString().slice(0, 10);
      const dayDir = join(TEST_DATA_DIR, 'logs', 'sessions', today);
      mkdirSync(dayDir, { recursive: true });

      const crashFile = join(dayDir, '12-00-00_telegram_orphan.md');
      writeFileSync(crashFile, `---
session_id: s_orphan123
adapter: telegram
app: orphan
started: 2026-02-13T12:00:00Z
status: in_progress
messages: 1
tool_calls: 0
tokens: 0
model: unknown
errors: 0
---

# telegram > orphan

## Message 1 — 12:00:00
**User:** This message was being processed when server died
`);

      await logger.recoverCrashedSessions();
      await new Promise(r => setTimeout(r, 50));

      const content = readFileSync(crashFile, 'utf-8');
      expect(content).toContain('status: crashed');
      expect(content).toContain('CRASH DETECTED');
      expect(content).toContain('in_progress when the server stopped');
    });

    it('should not touch completed sessions', async () => {
      const logger = await importLogger();

      const today = new Date().toISOString().slice(0, 10);
      const dayDir = join(TEST_DATA_DIR, 'logs', 'sessions', today);
      mkdirSync(dayDir, { recursive: true });

      const completedFile = join(dayDir, '11-00-00_dashboard_ok.md');
      const original = `---
session_id: s_done
status: completed
---
# done
`;
      writeFileSync(completedFile, original);

      await logger.recoverCrashedSessions();
      await new Promise(r => setTimeout(r, 50));

      const content = readFileSync(completedFile, 'utf-8');
      expect(content).toBe(original);
    });
  });

  describe('log rotation', () => {
    it('should delete old directories beyond retention', async () => {
      const logger = await importLogger();

      const sessionsDir = join(TEST_DATA_DIR, 'logs', 'sessions');
      // Create old directory (60 days ago)
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 60);
      const oldDir = join(sessionsDir, oldDate.toISOString().slice(0, 10));
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(join(oldDir, 'test.md'), 'old');

      // Create recent directory (5 days ago)
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 5);
      const recentDir = join(sessionsDir, recentDate.toISOString().slice(0, 10));
      mkdirSync(recentDir, { recursive: true });
      writeFileSync(join(recentDir, 'test.md'), 'recent');

      await logger.cleanupOldLogs(30);

      expect(existsSync(oldDir)).toBe(false);
      expect(existsSync(recentDir)).toBe(true);
    });
  });

  describe('daily summary', () => {
    it('should generate a summary from session files', async () => {
      const logger = await importLogger();

      const today = new Date().toISOString().slice(0, 10);
      const dayDir = join(TEST_DATA_DIR, 'logs', 'sessions', today);
      mkdirSync(dayDir, { recursive: true });

      // Create a completed session file
      writeFileSync(join(dayDir, '10-00-00_telegram_bot.md'), `---
session_id: s_abc
adapter: telegram
app: bot
started: 2026-02-13T10:00:00Z
ended: 2026-02-13T10:05:00Z
status: completed
messages: 2
tool_calls: 3
tokens: 500
model: claude-sonnet
errors: 0
---

# telegram > bot
`);

      // Create a tick file
      writeFileSync(join(dayDir, 'ticks_bot.md'), `
## Tick — 09:00:00 [s_t1]
**Status:** completed

---

## Tick — 09:05:00 [s_t2]
**Status:** completed

---
`);

      await logger.generateDailySummary(today);
      await new Promise(r => setTimeout(r, 50));

      const summaryPath = join(dayDir, '_daily-summary.md');
      expect(existsSync(summaryPath)).toBe(true);

      const content = readFileSync(summaryPath, 'utf-8');
      expect(content).toContain('Daily Summary');
      expect(content).toContain('Chat sessions | 1');
      expect(content).toContain('Tick invocations | 2');
      expect(content).toContain('telegram');
      expect(content).toContain('bot');
    });
  });

  describe('concurrent sessions', () => {
    it('should handle multiple apps logging simultaneously', async () => {
      const logger = await importLogger();

      const s1 = logger.startChatSession('app-a', 'telegram', 'Message A');
      const s2 = logger.startChatSession('app-b', 'dashboard', 'Message B');
      expect(s1).not.toBe(s2);

      await new Promise(r => setTimeout(r, 50));

      logger.logReply(s1, 'Reply A', { durationMs: 100 });
      logger.logReply(s2, 'Reply B', { durationMs: 200 });

      await new Promise(r => setTimeout(r, 50));

      await logger.endChatSession(s1);
      await logger.endChatSession(s2);

      await new Promise(r => setTimeout(r, 50));

      expect(logger.__getActiveSessionCount()).toBe(0);
    });
  });

  describe('endAllActiveSessions', () => {
    it('should mark all active sessions as completed on shutdown', async () => {
      const logger = await importLogger();

      logger.startChatSession('w1', 'telegram', 'Msg 1');
      logger.startChatSession('w2', 'dashboard', 'Msg 2');
      logger.startTickSession('w3');

      expect(logger.__getActiveSessionCount()).toBe(2);
      expect(logger.__getActiveTickSessionCount()).toBe(1);

      await new Promise(r => setTimeout(r, 50));
      await logger.endAllActiveSessions('completed');
      await new Promise(r => setTimeout(r, 50));

      expect(logger.__getActiveSessionCount()).toBe(0);
      expect(logger.__getActiveTickSessionCount()).toBe(0);
    });
  });
});
