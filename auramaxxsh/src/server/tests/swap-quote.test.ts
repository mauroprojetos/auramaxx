/**
 * Swap Quote Tests
 *
 * Tests the POST /swap/quote endpoint for Relay (EVM) and Jupiter (Solana).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTokenSync as createToken } from '../lib/auth';
import { tokenCanAccessWallet } from '../lib/hot';
import { ESCALATION_CONTRACT_VERSION } from '../lib/escalation-contract';
import { ESCALATION_ROUTE_IDS } from '../lib/escalation-route-registry';
import { createTestApp, cleanDatabase, testPrisma, setupAndUnlockWallet, TEST_AGENT_PUBKEY } from './setup';

const app = createTestApp();

// Mock hot wallet lookups
vi.mock('../lib/hot', async () => {
  const actual = await vi.importActual('../lib/hot');
  return {
    ...actual as object,
    getHotWallet: vi.fn().mockImplementation(async (addr: string) => {
      if (addr === '0x1111111111111111111111111111111111111111') {
        return { address: addr, chain: 'base' };
      }
      return null;
    }),
    tokenCanAccessWallet: vi.fn().mockResolvedValue(true),
    signWithHotWallet: vi.fn().mockResolvedValue({ hash: '0x' + 'b'.repeat(64) }),
  };
});

vi.mock('../lib/temp', async () => {
  const actual = await vi.importActual('../lib/temp');
  return {
    ...actual as object,
    getTempWallet: vi.fn().mockReturnValue(null),
    hasTempWallet: vi.fn().mockReturnValue(false),
    getTempSolanaKeypair: vi.fn().mockReturnValue(null),
  };
});

// Mock Relay price endpoint
vi.mock('../lib/dex/relay', async () => {
  const actual = await vi.importActual('../lib/dex/relay');
  return {
    ...actual as object,
    getRelayPrice: vi.fn().mockResolvedValue({
      fees: {
        gas: { amount: '21000', amountUsd: '0.05', currency: { symbol: 'ETH' } },
        relayer: { amount: '1000', amountUsd: '0.01' },
      },
      details: {
        sender: {
          amount: '100000000000000000',
          amountFormatted: '0.1',
          amountUsd: '350.00',
          currency: { symbol: 'ETH', decimals: 18, address: '0x0000000000000000000000000000000000000000' },
        },
        recipient: {
          amount: '350000000',
          amountFormatted: '350.0',
          amountUsd: '350.00',
          currency: { symbol: 'USDC', decimals: 6, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
        },
        rate: '3500.0',
        slippageTolerance: { origin: { percent: '1' } },
      },
    }),
  };
});

// Mock DEX detection to return relay
vi.mock('../lib/dex', async () => {
  const actual = await vi.importActual('../lib/dex');
  return {
    ...actual as object,
    detectBestDex: vi.fn().mockResolvedValue({
      adapter: {
        name: 'relay',
        supportsChain: () => true,
        detectPool: vi.fn().mockResolvedValue({ version: 'relay', poolAddress: 'relay' }),
        buildSwapTx: vi.fn(),
        getRouterAddress: () => 'relay',
      },
      pool: { version: 'relay', poolAddress: 'relay' },
    }),
    getDexAdapter: vi.fn().mockImplementation((name: string) => {
      if (name === 'relay') {
        return {
          name: 'relay',
          supportsChain: () => true,
          detectPool: vi.fn().mockResolvedValue({ version: 'relay', poolAddress: 'relay' }),
          buildSwapTx: vi.fn(),
          getRouterAddress: () => 'relay',
        };
      }
      return null;
    }),
    listDexes: vi.fn().mockReturnValue(['relay', 'uniswap', 'jupiter']),
  };
});

describe('Swap Quote', () => {
  let adminToken: string;
  const quotePayload = {
    from: '0x1111111111111111111111111111111111111111',
    token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    direction: 'buy',
    amount: '100000000000000000',
    slippage: 1,
    chain: 'base',
  };

  function makeToken(permissions: string[]): string {
    return createToken({
      agentId: 'swap-quote-test-agent',
      permissions,
      exp: Date.now() + 60_000,
      agentPubkey: TEST_AGENT_PUBKEY,
    });
  }

  beforeAll(async () => {
    await cleanDatabase();
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  describe('POST /swap/quote', () => {
    it('should return Relay quote for EVM token', async () => {
      const res = await request(app)
        .post('/swap/quote')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          from: '0x1111111111111111111111111111111111111111',
          token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          direction: 'buy',
          amount: '100000000000000000',
          slippage: 1,
          chain: 'base',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.dex).toBe('relay');
      expect(res.body.inputAmount).toBeDefined();
      expect(res.body.outputAmount).toBeDefined();
      expect(res.body.rate).toBeDefined();
      expect(res.body.fees).toBeDefined();
      expect(res.body.chain).toBe('base');
    });

    it('should not create a transaction record', async () => {
      const txCount = await testPrisma.transaction.count({
        where: { type: 'swap' },
      });

      const res = await request(app)
        .post('/swap/quote')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          from: '0x1111111111111111111111111111111111111111',
          token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          direction: 'buy',
          amount: '100000000000000000',
          slippage: 1,
          chain: 'base',
        });

      expect(res.status).toBe(200);

      const txCountAfter = await testPrisma.transaction.count({
        where: { type: 'swap' },
      });
      expect(txCountAfter).toBe(txCount);
    });

    it('should require auth', async () => {
      const res = await request(app)
        .post('/swap/quote')
        .send({
          from: '0x1111111111111111111111111111111111111111',
          token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          direction: 'buy',
          amount: '100000000000000000',
          slippage: 1,
        });

      expect(res.status).toBe(401);
    });

    it('should return canonical 403 escalation when missing swap permission', async () => {
      const token = makeToken(['wallet:list']);
      const res = await request(app)
        .post('/swap/quote')
        .set('Authorization', `Bearer ${token}`)
        .send(quotePayload);

      expect(res.status).toBe(403);
      expect(res.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
      expect(res.body.requiresHumanApproval).toBe(true);
      expect(res.body.approvalScope).toBe('session_token');
      expect(res.body.routeId).toBe(ESCALATION_ROUTE_IDS.SWAP_QUOTE_PERMISSION);
      expect(res.body.required).toEqual(['swap']);
      expect(res.body.claimStatus).toBe('pending');
      expect(res.body.retryReady).toBe(false);
    });

    it('should return canonical 403 escalation when wallet access is denied', async () => {
      vi.mocked(tokenCanAccessWallet).mockResolvedValueOnce(false);
      const token = makeToken(['swap']);
      const res = await request(app)
        .post('/swap/quote')
        .set('Authorization', `Bearer ${token}`)
        .send(quotePayload);

      expect(res.status).toBe(403);
      expect(res.body.contractVersion).toBe(ESCALATION_CONTRACT_VERSION);
      expect(res.body.requiresHumanApproval).toBe(true);
      expect(res.body.approvalScope).toBe('session_token');
      expect(res.body.routeId).toBe(ESCALATION_ROUTE_IDS.SWAP_QUOTE_WALLET_ACCESS);
      expect(res.body.required).toEqual(['wallet:access']);
      expect(res.body.claimStatus).toBe('pending');
      expect(res.body.retryReady).toBe(false);
    });

    it('should validate required fields', async () => {
      // Missing token
      const res = await request(app)
        .post('/swap/quote')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          from: '0x1111111111111111111111111111111111111111',
          direction: 'buy',
          amount: '100000000000000000',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('token address is required');
    });

    it('should validate direction field', async () => {
      const res = await request(app)
        .post('/swap/quote')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          from: '0x1111111111111111111111111111111111111111',
          token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          direction: 'invalid',
          amount: '100000000000000000',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('direction must be');
    });

    it('should reject unknown DEX', async () => {
      const res = await request(app)
        .post('/swap/quote')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          from: '0x1111111111111111111111111111111111111111',
          token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          direction: 'buy',
          amount: '100000000000000000',
          slippage: 1,
          dex: 'nonexistent',
          chain: 'base',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Unknown DEX');
    });
  });
});
