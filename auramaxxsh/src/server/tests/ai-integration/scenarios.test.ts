/**
 * AI Agent Integration Tests
 * ==========================
 * Tests the full pipeline: user prompt → processMessage → callHookViaSdk (mocked AI)
 * → executeTool (real) → fetch (intercepted) → Express routes (real).
 *
 * Only the Anthropic SDK is mocked (scripted tool_use / text responses).
 * Everything else — auth, permissions, wallet ops, DB — runs against real code
 * with a test database.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// ─── Module mocks (hoisted before imports) ──────────────────────────

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate };
    constructor() {}
  }
  return { default: MockAnthropic };
});

vi.mock('../../lib/strategy/hook-context', () => ({
  getHookSystemContext: (mode?: string, _provider?: string) => '[SYSTEM_CONTEXT]',
}));

vi.mock('../../lib/strategy/tick', () => ({
  processIntents: vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import {
  setupTestServer,
  teardownTestServer,
  createAgentToken,
  createHotWallet,
  runPrompt,
} from './harness';
import { testPrisma } from '../setup';

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Extract tool_result contents from a specific turn in the conversation.
 *
 * NOTE: callHookViaSdk passes the same `messages` array reference to every
 * client.messages.create() call. By the time tests inspect mock calls, the
 * array has been mutated to its final state. So we use the final messages
 * array and find tool results by TURN INDEX (Nth user message with array
 * content), not by mock call index.
 *
 * @param turnIndex - Which tool-use turn's results to retrieve (0-based)
 * @returns Array of content strings from tool_result blocks in that turn
 */
function getToolResults(turnIndex: number): string[] {
  // All mock calls share the same messages reference — use the last call
  const lastCallIndex = mockCreate.mock.calls.length - 1;
  if (lastCallIndex < 0) return [];
  const messages = mockCreate.mock.calls[lastCallIndex][0].messages as Array<{
    role: string;
    content: unknown;
  }>;
  // Find the Nth user message with tool_result content
  let count = 0;
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      if (count === turnIndex) {
        return (msg.content as Array<{ type: string; content: string }>)
          .filter((b) => b.type === 'tool_result')
          .map((b) => b.content);
      }
      count++;
    }
  }
  return [];
}

// ─── Test suite ─────────────────────────────────────────────────────

describe('AI Agent Integration', () => {
  let agentToken: string;
  let hotWalletAddress: string;

  beforeAll(async () => {
    await setupTestServer();

    // Create agent token with wallet + action permissions
    agentToken = await createAgentToken([
      'wallet:list',
      'wallet:create:hot',
      'action:create',
    ]);

    // Create a hot wallet for test scenarios
    hotWalletAddress = await createHotWallet(agentToken);
  });

  afterAll(async () => {
    await teardownTestServer();
    await testPrisma.$disconnect();
  });

  // ─── Simple queries ─────────────────────────────────────────────

  describe('Simple queries', () => {
    it('should list wallets via wallet_api tool', async () => {
      const result = await runPrompt(
        mockCreate,
        'What are my wallets?',
        [
          {
            toolCalls: [
              { name: 'wallet_api', input: { method: 'GET', endpoint: '/wallets' } },
            ],
          },
          {
            text: JSON.stringify({
              reply: 'You have 1 hot wallet.',
              state: {},
            }),
          },
        ],
        { token: agentToken },
      );

      expect(result.reply).toBe('You have 1 hot wallet.');
      expect(result.error).toBeUndefined();
      expect(mockCreate).toHaveBeenCalledTimes(2);

      // Verify the tool result fed back to the AI contains real server data
      const toolResults = getToolResults(0);
      expect(toolResults).toHaveLength(1);
      const walletsResponse = JSON.parse(toolResults[0]);
      expect(walletsResponse.wallets).toBeDefined();
      expect(walletsResponse.wallets.length).toBeGreaterThanOrEqual(1);
      expect(walletsResponse.wallets[0].address).toBe(hotWalletAddress);
    });

    it('should query wallet balance via wallet_api tool', async () => {
      const result = await runPrompt(
        mockCreate,
        'What is my balance?',
        [
          {
            toolCalls: [
              {
                name: 'wallet_api',
                input: { method: 'GET', endpoint: `/wallet/${hotWalletAddress}/assets` },
              },
            ],
          },
          {
            text: JSON.stringify({
              reply: `Your hot wallet at ${hotWalletAddress} has 0 ETH.`,
              state: {},
            }),
          },
        ],
        { token: agentToken },
      );

      expect(result.reply).toContain(hotWalletAddress);
      expect(result.error).toBeUndefined();
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Multi-step operations ──────────────────────────────────────

  describe('Multi-step operations', () => {
    it('should request approval when send permission is missing', async () => {
      // Token with wallet:list + action:create but NOT send:hot
      const restrictedToken = await createAgentToken(['wallet:list', 'action:create']);

      const result = await runPrompt(
        mockCreate,
        'Send 0.01 ETH to 0x1234567890abcdef1234567890abcdef12345678',
        [
          // Turn 1: List wallets
          {
            toolCalls: [
              { name: 'wallet_api', input: { method: 'GET', endpoint: '/wallets' } },
            ],
          },
          // Turn 2: Try /send (gets 403 from real server) + request approval
          {
            toolCalls: [
              {
                name: 'wallet_api',
                input: {
                  method: 'POST',
                  endpoint: '/send',
                  body: {
                    from: hotWalletAddress,
                    to: '0x1234567890abcdef1234567890abcdef12345678',
                    amount: '0.01',
                  },
                },
              },
              {
                name: 'request_human_action',
                input: {
                  summary: 'Send 0.01 ETH to 0x1234...5678',
                  permissions: ['send:hot'],
                  action: {
                    endpoint: '/send',
                    method: 'POST',
                    body: {
                      from: hotWalletAddress,
                      to: '0x1234567890abcdef1234567890abcdef12345678',
                      amount: '0.01',
                    },
                  },
                },
              },
            ],
          },
          // Turn 3: Final reply
          {
            text: JSON.stringify({
              reply: "I've requested approval to send 0.01 ETH. Waiting for your confirmation.",
              state: {},
            }),
          },
        ],
        { token: restrictedToken },
      );

      expect(result.reply).toContain('requested approval');
      expect(result.error).toBeUndefined();
      expect(mockCreate).toHaveBeenCalledTimes(3);

      // Verify the tool results fed back after turn 1:
      // - wallet_api POST /send → real 403 from server
      // - request_human_action → real success with requestId
      const toolResults = getToolResults(1);
      expect(toolResults).toHaveLength(2);

      const sendResult = JSON.parse(toolResults[0]);
      expect(sendResult.error).toMatch(/send:hot|[Ii]nsufficient/);

      const actionResult = JSON.parse(toolResults[1]);
      expect(actionResult.success).toBe(true);
      expect(actionResult.requestId).toBeDefined();

      // Verify HumanAction was created in DB with correct metadata
      const pending = await testPrisma.humanAction.findMany({
        where: { status: 'pending', type: 'action' },
        orderBy: { createdAt: 'desc' },
      });
      expect(pending.length).toBeGreaterThan(0);

      const latest = pending[0];
      const metadata = JSON.parse(latest.metadata || '{}');
      expect(metadata.permissions).toContain('send:hot');
      expect(metadata.action?.endpoint).toBe('/send');
    });

    it('should request approval for fund operation', async () => {
      // Token without fund permission
      const restrictedToken = await createAgentToken(['wallet:list', 'action:create']);

      const result = await runPrompt(
        mockCreate,
        'Fund my hot wallet with 0.1 ETH',
        [
          // Turn 1: List wallets
          {
            toolCalls: [
              { name: 'wallet_api', input: { method: 'GET', endpoint: '/wallets' } },
            ],
          },
          // Turn 2: Request approval for fund
          {
            toolCalls: [
              {
                name: 'request_human_action',
                input: {
                  summary: 'Fund hot wallet with 0.1 ETH from cold wallet',
                  permissions: ['fund'],
                  action: {
                    endpoint: '/fund',
                    method: 'POST',
                    body: {
                      to: hotWalletAddress,
                      amount: '0.1',
                    },
                  },
                  limits: { fund: 0.1 },
                },
              },
            ],
          },
          // Turn 3: Final reply
          {
            text: JSON.stringify({
              reply: "I've requested approval to fund your hot wallet with 0.1 ETH.",
              state: {},
            }),
          },
        ],
        { token: restrictedToken },
      );

      expect(result.reply).toContain('requested approval');
      expect(result.error).toBeUndefined();

      // Verify HumanAction in DB with fund permission
      const pending = await testPrisma.humanAction.findMany({
        where: { status: 'pending', type: 'action' },
        orderBy: { createdAt: 'desc' },
      });
      const fundRequest = pending.find((p) => {
        const meta = JSON.parse(p.metadata || '{}');
        return meta.permissions?.includes('fund');
      });
      expect(fundRequest).toBeDefined();
    });

    it('should handle 4-turn flow: create wallet → list → check balance → reply', async () => {
      // Token with create + list permissions
      const fullToken = await createAgentToken([
        'wallet:list',
        'wallet:create:hot',
        'action:create',
      ]);

      const result = await runPrompt(
        mockCreate,
        'Create a new hot wallet and tell me about it',
        [
          // Turn 1: Create a wallet
          {
            toolCalls: [
              {
                name: 'wallet_api',
                input: {
                  method: 'POST',
                  endpoint: '/wallet/create',
                  body: { tier: 'hot', name: 'AI-Created Wallet' },
                },
              },
            ],
          },
          // Turn 2: List wallets to confirm creation
          {
            toolCalls: [
              { name: 'wallet_api', input: { method: 'GET', endpoint: '/wallets' } },
            ],
          },
          // Turn 3: Check the new wallet's balance
          {
            toolCalls: [
              {
                // Endpoint uses a placeholder — executeTool will hit the real server
                // regardless; the AI "knows" the address from turn 1's tool result
                name: 'wallet_api',
                input: { method: 'GET', endpoint: '/wallets' },
              },
            ],
          },
          // Turn 4: Final reply
          {
            text: JSON.stringify({
              reply: 'Created a new hot wallet and verified it appears in your wallet list.',
              state: { walletsCreated: 1 },
            }),
          },
        ],
        { token: fullToken },
      );

      expect(result.reply).toContain('Created a new hot wallet');
      expect(result.error).toBeUndefined();
      expect(mockCreate).toHaveBeenCalledTimes(4);

      // Turn 0 result: wallet creation response from real server
      const createResults = getToolResults(0);
      expect(createResults).toHaveLength(1);
      const createResponse = JSON.parse(createResults[0]);
      expect(createResponse.wallet).toBeDefined();
      expect(createResponse.wallet.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(createResponse.wallet.name).toBe('AI-Created Wallet');
      const newAddress = createResponse.wallet.address;

      // Turn 1 result: wallet list includes the newly created wallet
      const listResults = getToolResults(1);
      expect(listResults).toHaveLength(1);
      const listResponse = JSON.parse(listResults[0]);
      const addresses = listResponse.wallets.map((w: { address: string }) => w.address);
      expect(addresses).toContain(newAddress);
    });

    it('should handle sequential 403 → approval with tool result verification', async () => {
      // Token that can list wallets and create actions but NOT send
      const restrictedToken = await createAgentToken(['wallet:list', 'action:create']);

      const result = await runPrompt(
        mockCreate,
        'Send 0.05 ETH to 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        [
          // Turn 1: List wallets to find source wallet
          {
            toolCalls: [
              { name: 'wallet_api', input: { method: 'GET', endpoint: '/wallets' } },
            ],
          },
          // Turn 2: Try to send (will get real 403)
          {
            toolCalls: [
              {
                name: 'wallet_api',
                input: {
                  method: 'POST',
                  endpoint: '/send',
                  body: {
                    from: hotWalletAddress,
                    to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
                    amount: '0.05',
                  },
                },
              },
            ],
          },
          // Turn 3: AI sees 403, requests approval
          {
            toolCalls: [
              {
                name: 'request_human_action',
                input: {
                  summary: 'Send 0.05 ETH to 0xdead...beef',
                  permissions: ['send:hot'],
                  action: {
                    endpoint: '/send',
                    method: 'POST',
                    body: {
                      from: hotWalletAddress,
                      to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
                      amount: '0.05',
                    },
                  },
                },
              },
            ],
          },
          // Turn 4: Final reply
          {
            text: JSON.stringify({
              reply: 'I tried to send but got a permission error. I\'ve requested approval for the send.',
              state: { attempted: true },
            }),
          },
        ],
        { token: restrictedToken },
      );

      expect(result.reply).toContain('requested approval');
      expect(result.error).toBeUndefined();
      expect(mockCreate).toHaveBeenCalledTimes(4);

      // Turn 0: wallet list should contain our hot wallet
      const listResults = getToolResults(0);
      const listResponse = JSON.parse(listResults[0]);
      expect(listResponse.wallets).toBeDefined();

      // Turn 1: real 403 from /send endpoint
      const sendResults = getToolResults(1);
      expect(sendResults).toHaveLength(1);
      const sendResponse = JSON.parse(sendResults[0]);
      expect(sendResponse.error).toMatch(/send:hot|[Ii]nsufficient/);

      // Turn 2: request_human_action success
      const approvalResults = getToolResults(2);
      expect(approvalResults).toHaveLength(1);
      const approvalResponse = JSON.parse(approvalResults[0]);
      expect(approvalResponse.success).toBe(true);
      expect(approvalResponse.requestId).toBeDefined();

      // Verify the pending request in DB
      const pending = await testPrisma.humanAction.findUnique({
        where: { id: approvalResponse.requestId },
      });
      expect(pending).toBeDefined();
      expect(pending!.status).toBe('pending');
    });
  });

  // ─── Error handling ─────────────────────────────────────────────

  describe('Error handling', () => {
    it('should handle permission-endpoint mismatch in request_human_action', async () => {
      // permissions: ["swap"] with action.endpoint: "/send" — validatePermissionEndpoint rejects
      const result = await runPrompt(
        mockCreate,
        'Do a trade for me',
        [
          // Turn 1: request_human_action with mismatched permission/endpoint
          {
            toolCalls: [
              {
                name: 'request_human_action',
                input: {
                  summary: 'Do a swap',
                  permissions: ['swap'],
                  action: {
                    endpoint: '/send', // wrong — swap permission requires /swap
                    method: 'POST',
                    body: {},
                  },
                },
              },
            ],
          },
          // Turn 2: AI handles the validation error
          {
            text: JSON.stringify({
              reply: 'The permission "swap" does not match the /send endpoint. Let me fix that.',
              state: {},
            }),
          },
        ],
        { token: agentToken },
      );

      expect(result.reply).toBeTruthy();
      expect(result.error).toBeUndefined();
      expect(mockCreate).toHaveBeenCalledTimes(2);

      // Verify the validation error was returned in the tool result
      const toolResults = getToolResults(0);
      expect(toolResults).toHaveLength(1);
      const errorResponse = JSON.parse(toolResults[0]);
      expect(errorResponse.error).toMatch(/do not match endpoint/);
    });

    it('should handle invalid endpoint gracefully', async () => {
      const result = await runPrompt(
        mockCreate,
        'Check something weird',
        [
          // Turn 1: Call non-existent endpoint
          {
            toolCalls: [
              { name: 'wallet_api', input: { method: 'GET', endpoint: '/nonexistent' } },
            ],
          },
          // Turn 2: AI handles the error
          {
            text: JSON.stringify({
              reply: 'That endpoint does not exist.',
              state: {},
            }),
          },
        ],
        { token: agentToken },
      );

      expect(result.reply).toBeTruthy();
      expect(result.error).toBeUndefined();
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('should handle unknown tool name', async () => {
      const result = await runPrompt(
        mockCreate,
        'Do something with an unknown tool',
        [
          // Turn 1: Call unknown tool
          {
            toolCalls: [
              { name: 'unknown_tool', input: { foo: 'bar' } },
            ],
          },
          // Turn 2: AI handles the error
          {
            text: JSON.stringify({
              reply: 'That tool is not available.',
              state: {},
            }),
          },
        ],
        { token: agentToken },
      );

      expect(result.reply).toBeTruthy();
      expect(result.error).toBeUndefined();
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });
  });
});
