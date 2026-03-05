/**
 * Integration tests for GET /wallet/:address/transactions
 * Tests both the DB path (our wallets) and on-chain fallback (external addresses).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, setupAndUnlockWallet, cleanDatabase, testPrisma } from '../setup';

// Mock fetchAndDecodeEvents for the on-chain path
vi.mock('../../lib/txhistory', () => ({
  fetchAndDecodeEvents: vi.fn().mockResolvedValue({
    transactions: [
      {
        type: 'transfer',
        summary: 'Received 500 USDC from 0x1234...abcd',
        txHash: '0x' + 'ab'.repeat(32),
        blockNumber: '100000',
        timestamp: 1700000000,
        details: {
          from: '0x1234567890abcdef1234567890abcdef1234abcd',
          to: '0x0000000000000000000000000000000000000000',
          amount: '500',
          symbol: 'USDC',
          direction: 'in',
        },
      },
    ],
    blockRange: { from: '90000', to: '100000' },
    total: 1,
  }),
}));

// Mock Solana connection for Solana path tests
vi.mock('../../lib/solana/connection', () => ({
  getSolanaConnection: vi.fn().mockResolvedValue({
    getSignaturesForAddress: vi.fn().mockResolvedValue([
      {
        signature: 'mockSig123',
        blockTime: 1700000000,
        slot: 250000000,
        err: null,
      },
    ]),
    getParsedTransactions: vi.fn().mockResolvedValue([
      {
        transaction: {
          message: {
            instructions: [
              {
                program: 'system',
                parsed: {
                  type: 'transfer',
                  info: {
                    source: 'SourcePubkey111111111111111111111111111111',
                    destination: 'DestPubkey1111111111111111111111111111111111',
                    lamports: 1000000000, // 1 SOL
                  },
                },
              },
            ],
          },
        },
      },
    ]),
  }),
}));

const app = createTestApp();
let adminToken: string;
let walletAddress: string;

beforeAll(async () => {
  await cleanDatabase();
  const setup = await setupAndUnlockWallet();
  adminToken = setup.adminToken;

  // Create a hot wallet
  const walletRes = await request(app)
    .post('/wallet/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ tier: 'hot', chain: 'base' });

  walletAddress = walletRes.body.wallet.address;

  // Seed some transactions for DB path
  await testPrisma.transaction.createMany({
    data: [
      {
        walletAddress: walletAddress.toLowerCase(),
        txHash: '0x' + '11'.repeat(32),
        type: 'send',
        status: 'confirmed',
        amount: '0.1',
        from: walletAddress.toLowerCase(),
        to: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        chain: 'base',
      },
      {
        walletAddress: walletAddress.toLowerCase(),
        txHash: '0x' + '22'.repeat(32),
        type: 'receive',
        status: 'confirmed',
        amount: '1.0',
        from: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        to: walletAddress.toLowerCase(),
        chain: 'base',
      },
    ],
  });
});

afterAll(async () => {
  await cleanDatabase();
});

describe('GET /wallet/:address/transactions', () => {
  describe('DB path (our wallets)', () => {
    it('should return transactions from DB with source "db"', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/transactions`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.source).toBe('db');
      expect(res.body.transactions).toHaveLength(2);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.total).toBe(2);
    });

    it('should filter DB transactions by type', async () => {
      const res = await request(app)
        .get(`/wallet/${walletAddress}/transactions?type=send`);

      expect(res.status).toBe(200);
      expect(res.body.transactions).toHaveLength(1);
      expect(res.body.transactions[0].type).toBe('send');
    });
  });

  describe('On-chain EVM path (external addresses)', () => {
    const externalAddr = '0x0000000000000000000000000000000000000000';

    it('should return on-chain transactions for external address', async () => {
      const res = await request(app)
        .get(`/wallet/${externalAddr}/transactions?chain=base`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.source).toBe('on-chain');
      expect(res.body.chain).toBe('base');
      expect(res.body.blockRange).toBeDefined();
      expect(res.body.transactions).toHaveLength(1);
      expect(res.body.transactions[0].type).toBe('transfer');
      expect(res.body.transactions[0].summary).toContain('USDC');
    });

    it('should not require auth for external addresses', async () => {
      const res = await request(app)
        .get(`/wallet/${externalAddr}/transactions`);

      // No auth header — should still work
      expect(res.status).toBe(200);
      expect(res.body.source).toBe('on-chain');
    });

    it('should pass limit to fetchAndDecodeEvents', async () => {
      const { fetchAndDecodeEvents } = await import('../../lib/txhistory');
      const mockFn = fetchAndDecodeEvents as any;
      mockFn.mockClear();

      await request(app)
        .get(`/wallet/${externalAddr}/transactions?limit=5&chain=base`);

      expect(mockFn).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5, chain: 'base' }),
      );
    });

    it('should pass type filter', async () => {
      const { fetchAndDecodeEvents } = await import('../../lib/txhistory');
      const mockFn = fetchAndDecodeEvents as any;
      mockFn.mockClear();

      await request(app)
        .get(`/wallet/${externalAddr}/transactions?types=transfer,swap`);

      expect(mockFn).toHaveBeenCalledWith(
        expect.objectContaining({ types: ['transfer', 'swap'] }),
      );
    });

    it('should pass block range params', async () => {
      const { fetchAndDecodeEvents } = await import('../../lib/txhistory');
      const mockFn = fetchAndDecodeEvents as any;
      mockFn.mockClear();

      await request(app)
        .get(`/wallet/${externalAddr}/transactions?fromBlock=90000&toBlock=100000`);

      expect(mockFn).toHaveBeenCalledWith(
        expect.objectContaining({ fromBlock: 90000n, toBlock: 100000n }),
      );
    });
  });

  describe('On-chain Solana path', () => {
    it('should return Solana transactions for external address', async () => {
      // Use a Solana-like address (base58)
      const solanaAddr = 'DestPubkey1111111111111111111111111111111111';

      const res = await request(app)
        .get(`/wallet/${solanaAddr}/transactions?chain=solana`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.source).toBe('on-chain');
      expect(res.body.chain).toBe('solana');
      expect(res.body.transactions.length).toBeGreaterThanOrEqual(1);
      expect(res.body.transactions[0].type).toBe('transfer');
      expect(res.body.transactions[0].summary).toContain('SOL');
    });
  });
});
