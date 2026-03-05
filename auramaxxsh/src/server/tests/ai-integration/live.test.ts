/**
 * AI Agent Live Model Tests
 * =========================
 * Tests the full pipeline with REAL Claude — no mocking.
 *
 * Works with either provider path:
 *   SDK: ANTHROPIC_API_KEY env or DB ApiKey → callHookViaSdk()
 *   CLI: claude subscription → callHookViaCli() with MCP server
 *
 * Tests validate outcomes (reply content, DB state) not exact tool call
 * sequences, since model output is non-deterministic.
 *
 * Skips if no AI provider is available (no API key AND no claude CLI).
 *
 * Prompt coverage tests (from prompts.md) are included at the bottom.
 * Control scope with env vars:
 *
 *   PROMPT_LIMIT=all        Run all 312 prompts
 *   PROMPT_LIMIT=5          Run first 5 prompts per category
 *   PROMPT_LIMIT=0          Skip prompt coverage entirely (default)
 *   PROMPT_CATEGORY=1       Run only category 1 (Balance & Portfolio)
 *   PROMPT_CATEGORY=1,4,13  Run categories 1, 4, and 13
 *
 * Run: npm run test:ai:live
 *      PROMPT_LIMIT=1 npm run test:ai:live          # + 1 prompt per category
 *      PROMPT_LIMIT=all npm run test:ai:live         # + all 312 prompts
 *      PROMPT_LIMIT=3 PROMPT_CATEGORY=1,4 npm run test:ai:live
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import {
  setupTestServer,
  teardownTestServer,
  createAgentToken,
  createHotWallet,
  runLivePrompt,
} from './live-harness';
import { testPrisma } from '../setup';

// ─── Skip if no AI provider available ───────────────────────────────
// The harness will try: ANTHROPIC_API_KEY env → real DB key → claude CLI.
// Skip only if none of these can possibly work.

const hasApiKeyEnv =
  !!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('test-key');

// Real DB exists → harness will try to read the key from it
const hasRealDb = existsSync(join(homedir(), '.auramaxx', 'auramaxx.db'));

let hasClaudeCli = false;
if (!hasApiKeyEnv && !hasRealDb) {
  // Only bother checking CLI if the faster options aren't available
  try {
    execFileSync('claude', ['--version'], { timeout: 5000, stdio: 'pipe' });
    hasClaudeCli = true;
  } catch {
    // claude CLI not available
  }
}

const canRun = hasApiKeyEnv || hasRealDb || hasClaudeCli;

// ─── Prompt coverage: parse prompts.md ──────────────────────────────

interface PromptCategory {
  id: number;
  name: string;
  prompts: string[];
}

function parsePromptsMd(filepath: string): PromptCategory[] {
  const content = readFileSync(filepath, 'utf-8');
  const categories: PromptCategory[] = [];
  let current: PromptCategory | null = null;

  for (const line of content.split('\n')) {
    const headerMatch = line.match(/^## (\d+)\.\s+(.+?)\s*\(\d+\)/);
    if (headerMatch) {
      current = {
        id: parseInt(headerMatch[1], 10),
        name: headerMatch[2],
        prompts: [],
      };
      categories.push(current);
      continue;
    }

    if (current) {
      const promptMatch = line.match(/^\d+\.\s+"(.+)"/);
      if (promptMatch) {
        current.prompts.push(promptMatch[1]);
      }
    }
  }

  return categories;
}

/** Loose keywords per category — reply should contain at least one. */
const CATEGORY_KEYWORDS: Record<number, string[]> = {
  1:  ['balance', 'wallet', 'eth', 'sol', 'token', 'hold', 'worth', 'asset', 'usdc', 'portfolio'],
  2:  ['send', 'transfer', 'approv', 'permiss', 'request', 'pending', 'transaction', 'eth', 'address'],
  3:  ['address', 'wallet', '0x', 'deposit', 'receive'],
  4:  ['swap', 'trade', 'buy', 'sell', 'approv', 'permiss', 'request', 'exchange', 'dex', 'uniswap', 'slippage'],
  5:  ['price', 'token', 'market', 'worth', 'usd', 'info', 'chain'],
  6:  ['transaction', 'history', 'sent', 'swap', 'transfer', 'recent', 'bought', 'axiom'],
  7:  ['gas', 'fee', 'cost', 'gwei', 'estimate'],
  8:  ['wallet', 'create', 'list', 'rename', 'hot', 'temp', 'cold'],
  9:  ['fund', 'transfer', 'cold', 'hot', 'approv', 'permiss', 'request', 'top'],
  10: ['permiss', 'token', 'limit', 'revok', 'security', 'active', 'access', 'spend'],
  11: ['agent', 'unlock', 'lock', 'seed', 'backup', 'primary'],
  12: ['chain', 'bridge', 'cross', 'base', 'ethereum', 'solana', 'support'],
  13: ['launch', 'token', 'deploy', 'approv', 'permiss', 'request', 'doppler', 'create'],
  14: ['strateg', 'dca', 'automat', 'config', 'enable', 'disable', 'active'],
  15: ['track', 'asset', 'token', 'add', 'remove', 'list'],
  16: ['portfolio', 'profit', 'loss', 'p&l', 'perform', 'roi', 'allocation'],
  17: ['send', 'sweep', 'wallet', 'fund', 'consolidat', 'batch', 'multiple'],
  18: ['telegram', 'adapter', 'notif', 'webhook', 'alert', 'connect'],
  19: ['api', 'key', 'config', 'rpc', 'alchemy', 'anthropic', 'chain', 'default'],
  20: ['system', 'default', 'backup', 'status', 'server', 'running', 'provider'],
  21: ['error', 'fail', 'stuck', 'cancel', 'wrong', 'troubleshoot', 'issue', 'problem', 'help'],
  22: ['help', 'start', 'setup', 'explain', 'wallet', 'how', 'what', 'support', 'chain'],
  23: ['price', 'limit', 'order', 'alert', 'condition', 'automat', 'dca', 'time', 'trigger'],
  24: ['token', 'contract', 'safe', 'rug', 'liquidity', 'audit', 'holder', 'risk', 'honeypot'],
  25: ['wallet', 'balance', 'total', 'fund', 'rebalance', 'sweep', 'gas'],
  26: ['dashboard', 'app', 'workspace', 'log', 'event', 'iframe', 'ui'],
};

// Load prompts from prompts.md (co-located in this directory)
const __dirname_resolved = dirname(fileURLToPath(import.meta.url));
const promptsFile = join(__dirname_resolved, 'prompts.md');
const allCategories = existsSync(promptsFile) ? parsePromptsMd(promptsFile) : [];

// PROMPT_LIMIT: 0 (default, skip), 1-N (per category), "all"
const promptLimit = process.env.PROMPT_LIMIT === 'all'
  ? Infinity
  : parseInt(process.env.PROMPT_LIMIT || '0', 10);

// PROMPT_CATEGORY: filter to specific categories (e.g. "1,4,13")
const categoryFilter = process.env.PROMPT_CATEGORY
  ? new Set(process.env.PROMPT_CATEGORY.split(',').map((s) => parseInt(s.trim(), 10)))
  : null;

const promptCategories = (categoryFilter
  ? allCategories.filter((c) => categoryFilter.has(c.id))
  : allCategories
).map((c) => ({ ...c, prompts: c.prompts.slice(0, promptLimit) }));

const runPrompts = promptLimit > 0 && promptCategories.some((c) => c.prompts.length > 0);

// ─── Tests ───────────────────────────────────────────────────────────

describe.skipIf(!canRun)('AI Agent Live Model', () => {
  let agentToken: string;
  let hotWalletAddress: string;

  beforeAll(async () => {
    await setupTestServer();

    // Create agent token with broad permissions for prompt coverage
    agentToken = await createAgentToken([
      'wallet:list',
      'wallet:create:hot',
      'wallet:create:temp',
      'wallet:rename',
      'action:create',
    ]);

    // Create a hot wallet for test scenarios
    hotWalletAddress = await createHotWallet(agentToken);
  });

  afterAll(async () => {
    await teardownTestServer();
    await testPrisma.$disconnect();
  });

  // ─── Wallet queries ─────────────────────────────────────────────

  describe('Wallet queries', () => {
    it('should list wallets when asked', async () => {
      const result = await runLivePrompt('What wallets do I have?', {
        token: agentToken,
      });

      expect(result.error).toBeUndefined();
      expect(result.reply).toBeTruthy();
      // Model should mention the wallet or address in some form
      const reply = result.reply!.toLowerCase();
      expect(
        reply.includes('wallet') ||
          reply.includes(hotWalletAddress.toLowerCase().slice(0, 8)),
      ).toBe(true);
    });

    it('should check wallet balance when asked', async () => {
      const result = await runLivePrompt('What is the balance of my wallet?', {
        token: agentToken,
      });

      expect(result.error).toBeUndefined();
      expect(result.reply).toBeTruthy();
      // Model should mention balance, ETH, or the wallet address
      const reply = result.reply!.toLowerCase();
      expect(
        reply.includes('balance') ||
          reply.includes('eth') ||
          reply.includes(hotWalletAddress.toLowerCase().slice(0, 8)),
      ).toBe(true);
    });
  });

  // ─── Token discovery ────────────────────────────────────────────

  describe('Token discovery', () => {
    it('should not claim token search is unavailable for ticker lookups', async () => {
      const result = await runLivePrompt('Try to find $openwork token on base', {
        token: agentToken,
      });

      expect(result.error).toBeUndefined();
      expect(result.reply).toBeTruthy();

      const reply = result.reply!.toLowerCase();
      expect(reply).not.toContain("doesn't have a built-in token search endpoint");
      expect(reply).not.toContain('search \'openwork\' on dextools');
    });
  });

  // ─── Permission-gated operations ─────────────────────────────────

  describe('Permission-gated operations', () => {
    it('should request approval when send permission is missing', async () => {
      // Token with wallet:list + action:create but NOT send:hot
      const restrictedToken = await createAgentToken(['wallet:list', 'action:create']);

      const result = await runLivePrompt(
        `Send 0.01 ETH to 0x1234567890abcdef1234567890abcdef12345678`,
        { token: restrictedToken },
      );

      expect(result.error).toBeUndefined();
      expect(result.reply).toBeTruthy();

      // Check that a HumanAction was created with send:hot permission
      const pending = await testPrisma.humanAction.findMany({
        where: { status: 'pending', type: 'action' },
        orderBy: { createdAt: 'desc' },
      });

      const sendRequest = pending.find((p) => {
        const meta = JSON.parse(p.metadata || '{}');
        return meta.permissions?.includes('send:hot');
      });
      const reply = result.reply!.toLowerCase();

      // Depending on wallet balances in the live env, model may either:
      // 1) request approval for send:hot, or
      // 2) stop early due insufficient funds and ask to fund first.
      if (sendRequest) {
        expect(
          reply.includes('approv') ||
            reply.includes('permiss') ||
            reply.includes('request') ||
            reply.includes('pending') ||
            reply.includes('authorization'),
        ).toBe(true);
      } else {
        expect(
          reply.includes('balance') ||
            reply.includes('insufficient') ||
            reply.includes('empty') ||
            reply.includes('fund'),
        ).toBe(true);
      }
    });

    it('should handle fund operation appropriately', async () => {
      // Token without fund permission
      const restrictedToken = await createAgentToken(['wallet:list', 'action:create']);

      const result = await runLivePrompt(
        'Fund my hot wallet with 0.5 ETH from cold',
        { token: restrictedToken },
      );

      expect(result.error).toBeUndefined();
      expect(result.reply).toBeTruthy();

      // Model may either:
      // 1. Request approval (creates HumanAction with fund permission)
      // 2. Report insufficient cold wallet balance (0 ETH in test)
      // Both are valid responses — the key is the model engaged with the request.
      const reply = result.reply!.toLowerCase();
      expect(
        reply.includes('approv') ||
          reply.includes('permiss') ||
          reply.includes('request') ||
          reply.includes('pending') ||
          reply.includes('authorization') ||
          reply.includes('fund') ||
          reply.includes('cold') ||
          reply.includes('balance') ||
          reply.includes('insufficient') ||
          reply.includes('deposit'),
      ).toBe(true);
    });
  });

  // ─── Wallet creation ─────────────────────────────────────────────

  describe('Wallet creation', () => {
    it('should create a new hot wallet', async () => {
      const fullToken = await createAgentToken([
        'wallet:list',
        'wallet:create:hot',
        'action:create',
      ]);

      const result = await runLivePrompt(
        'Create a new hot wallet called "AI Trading"',
        { token: fullToken },
      );

      expect(result.error).toBeUndefined();
      expect(result.reply).toBeTruthy();

      // Model should have called POST /wallet/create and reported the result.
      // Check reply mentions creation and includes a wallet address.
      const reply = result.reply!.toLowerCase();
      expect(
        reply.includes('creat') ||
          reply.includes('new wallet') ||
          reply.includes('0x'),
      ).toBe(true);
    });
  });

  // ─── Error handling ───────────────────────────────────────────────

  describe('Error handling', () => {
    it('should handle invalid address gracefully', async () => {
      const result = await runLivePrompt(
        'Send ETH to 0xinvalid',
        { token: agentToken },
      );

      // Should not crash — model should handle it gracefully
      expect(result.error).toBeUndefined();
      expect(result.reply).toBeTruthy();
    });
  });

  // ─── Prompt coverage (from prompts.md) ────────────────────────────
  // Activated with PROMPT_LIMIT env var. Default 0 = skip.

  describe.skipIf(!runPrompts)('Prompt coverage', () => {
    for (const category of promptCategories) {
      const keywords = CATEGORY_KEYWORDS[category.id] || [];

      describe(`${category.id}. ${category.name}`, () => {
        for (let i = 0; i < category.prompts.length; i++) {
          const prompt = category.prompts[i];

          it(`prompt ${i + 1}: "${prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt}"`, async () => {
            const result = await runLivePrompt(prompt, { token: agentToken });

            // Basic: no crash, got a reply
            expect(result.error).toBeUndefined();
            expect(result.reply).toBeTruthy();

            // Category keyword check (at least one keyword appears in reply)
            if (keywords.length > 0) {
              const reply = result.reply!.toLowerCase();
              const matched = keywords.some((kw) => reply.includes(kw));
              if (!matched) {
                console.warn(
                  `[WARN] Category ${category.id} prompt ${i + 1}: no keyword match.\n` +
                  `  Prompt: "${prompt}"\n` +
                  `  Reply (first 200 chars): "${result.reply!.slice(0, 200)}"\n` +
                  `  Expected one of: [${keywords.join(', ')}]`,
                );
              }
            }
          });
        }
      });
    }
  });
});
