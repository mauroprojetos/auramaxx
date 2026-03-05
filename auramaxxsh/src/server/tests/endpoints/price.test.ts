/**
 * Token Price Endpoint Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../setup';

// Mock the price library
vi.mock('../../lib/price', () => {
  const cache = new Map<string, { priceUsd: string; source: string; fetchedAt: number }>();
  const CACHE_TTL_MS = 60_000;

  return {
    getTokenPrice: vi.fn(),
    clearPriceCache: vi.fn(() => cache.clear()),
  };
});

// Mock prices.ts (native prices)
vi.mock('../../lib/prices', () => ({
  getEthToUsd: vi.fn(),
  getSolToUsd: vi.fn(),
}));

// Mock config.ts for getAlchemyKey
vi.mock('../../lib/config', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getAlchemyKey: vi.fn().mockResolvedValue(null),
  };
});

import { getTokenPrice, clearPriceCache } from '../../lib/price';
import { getEthToUsd, getSolToUsd } from '../../lib/prices';
import { getAlchemyKey } from '../../lib/config';

const app = createTestApp();
const mockedGetTokenPrice = vi.mocked(getTokenPrice);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Token Price Endpoint', () => {
  describe('GET /price/:address', () => {
    // --- Native token prices ---

    it('should return cached native ETH price', async () => {
      mockedGetTokenPrice.mockResolvedValue({
        priceUsd: '3200',
        source: 'cache',
        cached: true,
      });

      const res = await request(app).get('/price/native?chain=base');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBe('native');
      expect(res.body.chain).toBe('base');
      expect(res.body.priceUsd).toBe('3200');
      expect(res.body.source).toBe('cache');
      expect(res.body.cached).toBe(true);
    });

    it('should return cached native SOL price', async () => {
      mockedGetTokenPrice.mockResolvedValue({
        priceUsd: '150',
        source: 'cache',
        cached: true,
      });

      const res = await request(app).get('/price/native?chain=solana');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBe('native');
      expect(res.body.chain).toBe('solana');
      expect(res.body.priceUsd).toBe('150');
    });

    it('should return 404 when native price not cached', async () => {
      mockedGetTokenPrice.mockResolvedValue(null);

      const res = await request(app).get('/price/native?chain=base');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('No price found');
    });

    // --- DexScreener success ---

    it('should return DexScreener price for ERC-20 token', async () => {
      mockedGetTokenPrice.mockResolvedValue({
        priceUsd: '0.9998',
        source: 'dexscreener',
        cached: false,
      });

      const res = await request(app)
        .get('/price/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?chain=base');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.priceUsd).toBe('0.9998');
      expect(res.body.source).toBe('dexscreener');
      expect(res.body.cached).toBe(false);
    });

    // --- CoinGecko fallback ---

    it('should return CoinGecko price on DexScreener failure', async () => {
      mockedGetTokenPrice.mockResolvedValue({
        priceUsd: '1.00',
        source: 'coingecko',
        cached: false,
      });

      const res = await request(app)
        .get('/price/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?chain=base');

      expect(res.status).toBe(200);
      expect(res.body.source).toBe('coingecko');
    });

    // --- Alchemy fallback ---

    it('should return Alchemy price when DexScreener and CoinGecko fail', async () => {
      mockedGetTokenPrice.mockResolvedValue({
        priceUsd: '1.001',
        source: 'alchemy',
        cached: false,
      });

      const res = await request(app)
        .get('/price/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?chain=base');

      expect(res.status).toBe(200);
      expect(res.body.source).toBe('alchemy');
    });

    // --- All sources fail ---

    it('should return 404 when all sources fail', async () => {
      mockedGetTokenPrice.mockResolvedValue(null);

      const res = await request(app)
        .get('/price/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?chain=base');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('No price found');
    });

    // --- Cache hit ---

    it('should return cached result on second call', async () => {
      mockedGetTokenPrice.mockResolvedValue({
        priceUsd: '0.9998',
        source: 'dexscreener',
        cached: true,
      });

      const res = await request(app)
        .get('/price/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?chain=base');

      expect(res.status).toBe(200);
      expect(res.body.cached).toBe(true);
    });

    // --- Validation ---

    it('should return 400 for invalid EVM address', async () => {
      const res = await request(app).get('/price/not-an-address?chain=base');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid EVM address');
    });

    it('should return 400 for invalid Solana address', async () => {
      const res = await request(app).get('/price/0xinvalid?chain=solana');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid Solana address');
    });

    it('should return 400 for unknown chain', async () => {
      const res = await request(app).get('/price/native?chain=fantom');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Unknown chain');
    });

    // --- Solana token ---

    it('should accept valid Solana token mint address', async () => {
      mockedGetTokenPrice.mockResolvedValue({
        priceUsd: '175.50',
        source: 'coingecko',
        cached: false,
      });

      const res = await request(app)
        .get('/price/So11111111111111111111111111111111111111112?chain=solana');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.chain).toBe('solana');
    });

    // --- Default chain ---

    it('should use default chain when chain param is omitted', async () => {
      mockedGetTokenPrice.mockResolvedValue({
        priceUsd: '1.00',
        source: 'dexscreener',
        cached: false,
      });

      const res = await request(app)
        .get('/price/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');

      expect(res.status).toBe(200);
      // Default chain is 'base'
      expect(res.body.chain).toBe('base');
      expect(mockedGetTokenPrice).toHaveBeenCalledWith(
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        'base',
      );
    });
  });
});
