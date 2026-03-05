/**
 * Token Balance Endpoint Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../setup';

// Mock viem — createPublicClient is called inside the route handler
const mockMulticall = vi.fn();
vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      multicall: mockMulticall,
    })),
  };
});

// Mock config
vi.mock('../../lib/config', async () => {
  const actual = await vi.importActual('../../lib/config');
  return {
    ...actual,
    getRpcUrl: vi.fn().mockResolvedValue('https://mock-rpc.example.com'),
    loadConfig: vi.fn().mockReturnValue({ defaultChain: 'base' }),
  };
});

// Mock price
vi.mock('../../lib/price', () => ({
  getTokenPrices: vi.fn().mockResolvedValue(new Map()),
}));

// Mock Solana connection
vi.mock('../../lib/solana/connection', () => ({
  getSolanaConnection: vi.fn().mockResolvedValue({
    getParsedAccountInfo: vi.fn(),
  }),
}));

// Mock @solana/spl-token
vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddress: vi.fn(),
  getAccount: vi.fn(),
  TOKEN_PROGRAM_ID: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
}));

import { getTokenPrices } from '../../lib/price';
import { getRpcUrl, loadConfig } from '../../lib/config';

const app = createTestApp();

const TOKEN_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WALLET_ADDRESS = '0x498581ff718922c3f8e6a244956af099b2652b2b';

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default config mock
  vi.mocked(loadConfig).mockReturnValue({ defaultChain: 'base' } as any);
  vi.mocked(getRpcUrl).mockResolvedValue('https://mock-rpc.example.com');
  vi.mocked(getTokenPrices).mockResolvedValue(new Map());
});

describe('Token Balance Endpoint', () => {
  describe('GET /token/:tokenAddress/balance/:walletAddress', () => {
    it('should return successful balance query for EVM token', async () => {
      mockMulticall.mockResolvedValue([
        { status: 'success', result: 1000000n },   // balanceOf
        { status: 'success', result: 6 },           // decimals
        { status: 'success', result: 'USDC' },      // symbol
        { status: 'success', result: 'USD Coin' },  // name
      ]);

      const res = await request(app).get(
        `/token/${TOKEN_ADDRESS}/balance/${WALLET_ADDRESS}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.tokenAddress).toBe(TOKEN_ADDRESS);
      expect(res.body.walletAddress).toBe(WALLET_ADDRESS);
      expect(res.body.chain).toBe('base');
      expect(res.body.balance).toBe('1000000');
      expect(res.body.formatted).toBe('1');
      expect(res.body.decimals).toBe(6);
      expect(res.body.symbol).toBe('USDC');
      expect(res.body.name).toBe('USD Coin');
    });

    it('should include price and value when price data is available', async () => {
      mockMulticall.mockResolvedValue([
        { status: 'success', result: 1000000n },
        { status: 'success', result: 6 },
        { status: 'success', result: 'USDC' },
        { status: 'success', result: 'USD Coin' },
      ]);

      vi.mocked(getTokenPrices).mockResolvedValue(
        new Map([
          [`base:${TOKEN_ADDRESS.toLowerCase()}`, { priceUsd: '1.00', source: 'mock', cached: false }],
        ]),
      );

      const res = await request(app).get(
        `/token/${TOKEN_ADDRESS}/balance/${WALLET_ADDRESS}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.priceUsd).toBe('1');
      expect(res.body.valueUsd).toBe('1.00');
    });

    it('should return zero balance correctly', async () => {
      mockMulticall.mockResolvedValue([
        { status: 'success', result: 0n },
        { status: 'success', result: 6 },
        { status: 'success', result: 'USDC' },
        { status: 'success', result: 'USD Coin' },
      ]);

      const res = await request(app).get(
        `/token/${TOKEN_ADDRESS}/balance/${WALLET_ADDRESS}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.balance).toBe('0');
      expect(res.body.formatted).toBe('0');
      expect(res.body.priceUsd).toBeNull();
      expect(res.body.valueUsd).toBeNull();
    });

    it('should return 400 for invalid token address', async () => {
      const res = await request(app).get(
        `/token/not-a-hex-address/balance/${WALLET_ADDRESS}`,
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid EVM token address format');
    });

    it('should return 400 for invalid wallet address', async () => {
      const res = await request(app).get(
        `/token/${TOKEN_ADDRESS}/balance/not-a-hex-address`,
      );

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid EVM wallet address format');
    });

    it('should return 502 when RPC balanceOf call fails', async () => {
      mockMulticall.mockResolvedValue([
        { status: 'failure', error: new Error('RPC error') },
        { status: 'success', result: 6 },
        { status: 'success', result: 'USDC' },
        { status: 'success', result: 'USD Coin' },
      ]);

      const res = await request(app).get(
        `/token/${TOKEN_ADDRESS}/balance/${WALLET_ADDRESS}`,
      );

      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Failed to query token balance from RPC');
    });

    it('should handle partial metadata failure gracefully', async () => {
      mockMulticall.mockResolvedValue([
        { status: 'success', result: 5000000n },
        { status: 'success', result: 6 },
        { status: 'failure', error: new Error('no symbol') },
        { status: 'failure', error: new Error('no name') },
      ]);

      const res = await request(app).get(
        `/token/${TOKEN_ADDRESS}/balance/${WALLET_ADDRESS}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.balance).toBe('5000000');
      expect(res.body.symbol).toBeNull();
      expect(res.body.name).toBeNull();
    });

    it('should use chain query parameter when provided', async () => {
      mockMulticall.mockResolvedValue([
        { status: 'success', result: 1000000n },
        { status: 'success', result: 6 },
        { status: 'success', result: 'USDC' },
        { status: 'success', result: 'USD Coin' },
      ]);

      const res = await request(app).get(
        `/token/${TOKEN_ADDRESS}/balance/${WALLET_ADDRESS}?chain=ethereum`,
      );

      expect(res.status).toBe(200);
      expect(res.body.chain).toBe('ethereum');
      expect(vi.mocked(getRpcUrl)).toHaveBeenCalledWith('ethereum');
    });

    it('should use defaultChain from config when no chain param given', async () => {
      vi.mocked(loadConfig).mockReturnValue({ defaultChain: 'base' } as any);

      mockMulticall.mockResolvedValue([
        { status: 'success', result: 1000000n },
        { status: 'success', result: 6 },
        { status: 'success', result: 'USDC' },
        { status: 'success', result: 'USD Coin' },
      ]);

      const res = await request(app).get(
        `/token/${TOKEN_ADDRESS}/balance/${WALLET_ADDRESS}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.chain).toBe('base');
      expect(vi.mocked(getRpcUrl)).toHaveBeenCalledWith('base');
    });
  });
});
