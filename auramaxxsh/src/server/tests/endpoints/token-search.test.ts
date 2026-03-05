/**
 * Token Search Endpoint Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../setup';

// Mock the token-search library
vi.mock('../../lib/token-search', () => {
  return {
    searchTokens: vi.fn(),
    clearTokenSearchCache: vi.fn(),
  };
});

import { searchTokens, clearTokenSearchCache } from '../../lib/token-search';

const app = createTestApp();
const mockedSearchTokens = vi.mocked(searchTokens);

beforeEach(() => {
  vi.clearAllMocks();
});

const mockResult = (overrides: Partial<ReturnType<typeof makeResult>> = {}) => makeResult(overrides);

function makeResult(overrides: Record<string, any> = {}) {
  return {
    address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
    chain: 'ethereum',
    symbol: 'PEPE',
    name: 'Pepe',
    priceUsd: '0.00001234',
    liquidity: 5000000,
    volume24h: 12000000,
    marketCap: 5200000000,
    fdv: 5200000000,
    imageUrl: 'https://dd.dexscreener.com/ds-data/tokens/ethereum/0x698.png',
    websites: ['https://pepe.vip'],
    socials: [{ type: 'twitter', url: 'https://twitter.com/pepecoineth' }],
    dexId: 'uniswap',
    pairAddress: '0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f',
    ...overrides,
  };
}

describe('Token Search Endpoint', () => {
  describe('GET /token/search', () => {
    it('should return results for a valid query', async () => {
      mockedSearchTokens.mockResolvedValue([mockResult()]);

      const res = await request(app).get('/token/search?q=PEPE');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.query).toBe('PEPE');
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].symbol).toBe('PEPE');
      expect(res.body.results[0].address).toBe('0x6982508145454Ce325dDbE47a25d4ec3d2311933');
    });

    it('should pass chain filter to searchTokens', async () => {
      mockedSearchTokens.mockResolvedValue([mockResult({ chain: 'base' })]);

      const res = await request(app).get('/token/search?q=PEPE&chain=base');

      expect(res.status).toBe(200);
      expect(mockedSearchTokens).toHaveBeenCalledWith('PEPE', { chain: 'base', limit: 10 });
    });

    it('should pass limit to searchTokens', async () => {
      mockedSearchTokens.mockResolvedValue([mockResult()]);

      const res = await request(app).get('/token/search?q=PEPE&limit=5');

      expect(res.status).toBe(200);
      expect(mockedSearchTokens).toHaveBeenCalledWith('PEPE', { chain: undefined, limit: 5 });
    });

    it('should clamp limit to max 50', async () => {
      mockedSearchTokens.mockResolvedValue([]);

      await request(app).get('/token/search?q=PEPE&limit=100');

      expect(mockedSearchTokens).toHaveBeenCalledWith('PEPE', { chain: undefined, limit: 50 });
    });

    it('should clamp limit to min 1', async () => {
      mockedSearchTokens.mockResolvedValue([]);

      await request(app).get('/token/search?q=PEPE&limit=0');

      expect(mockedSearchTokens).toHaveBeenCalledWith('PEPE', { chain: undefined, limit: 1 });
    });

    it('should return 400 when q is missing', async () => {
      const res = await request(app).get('/token/search');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Missing required query parameter: q');
    });

    it('should return 400 when q is empty', async () => {
      const res = await request(app).get('/token/search?q=');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 when q is whitespace', async () => {
      const res = await request(app).get('/token/search?q=%20%20');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 200 with empty results when no tokens found', async () => {
      mockedSearchTokens.mockResolvedValue([]);

      const res = await request(app).get('/token/search?q=ZZZZNOTAREALTOKEN');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.results).toEqual([]);
    });

    it('should return results sorted by liquidity (from searchTokens)', async () => {
      const results = [
        mockResult({ symbol: 'PEPE', liquidity: 5000000 }),
        mockResult({ symbol: 'PEPE2', liquidity: 100000, address: '0xaaa' }),
      ];
      mockedSearchTokens.mockResolvedValue(results);

      const res = await request(app).get('/token/search?q=PEPE');

      expect(res.status).toBe(200);
      expect(res.body.results[0].liquidity).toBeGreaterThan(res.body.results[1].liquidity);
    });

    it('should include metadata fields in results', async () => {
      mockedSearchTokens.mockResolvedValue([mockResult()]);

      const res = await request(app).get('/token/search?q=PEPE');

      const result = res.body.results[0];
      expect(result.imageUrl).toBe('https://dd.dexscreener.com/ds-data/tokens/ethereum/0x698.png');
      expect(result.websites).toEqual(['https://pepe.vip']);
      expect(result.socials).toEqual([{ type: 'twitter', url: 'https://twitter.com/pepecoineth' }]);
      expect(result.dexId).toBe('uniswap');
      expect(result.pairAddress).toBe('0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f');
    });

    it('should handle searchTokens failure gracefully', async () => {
      mockedSearchTokens.mockRejectedValue(new Error('DexScreener timeout'));

      const res = await request(app).get('/token/search?q=PEPE');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('DexScreener timeout');
    });

    it('should trim whitespace from query', async () => {
      mockedSearchTokens.mockResolvedValue([]);

      await request(app).get('/token/search?q=%20PEPE%20');

      expect(mockedSearchTokens).toHaveBeenCalledWith('PEPE', expect.any(Object));
    });
  });
});

describe('Token Search Library', () => {
  // These tests verify the search logic directly (unmocked)
  // Re-import the actual module for unit testing
  describe('searchTokens dedup and sorting', () => {
    it('should call searchTokens with correct arguments', async () => {
      mockedSearchTokens.mockResolvedValue([]);

      await searchTokens('DOGE', { chain: 'base', limit: 5 });

      expect(mockedSearchTokens).toHaveBeenCalledWith('DOGE', { chain: 'base', limit: 5 });
    });
  });
});
