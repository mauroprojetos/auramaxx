/**
 * Token Search Library Unit Tests
 *
 * Tests the DexScreener → CoinGecko fallback logic by mocking global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchTokens, clearTokenSearchCache, safeJsonParse } from '../../lib/token-search';

// Mock prisma for persistence tests
const mockUpsert = vi.fn().mockResolvedValue({});
const mockFindMany = vi.fn().mockResolvedValue([]);
vi.mock('../../lib/db', () => ({
  prisma: {
    tokenMetadata: {
      upsert: (...args: any[]) => mockUpsert(...args),
      findMany: (...args: any[]) => mockFindMany(...args),
    },
  },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenSearchCache();
});

// Helper to create a DexScreener pair response
function dexPair(overrides: Record<string, any> = {}) {
  return {
    chainId: 'ethereum',
    dexId: 'uniswap',
    pairAddress: '0xpair1',
    baseToken: {
      address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
      symbol: 'PEPE',
      name: 'Pepe',
    },
    priceUsd: '0.00001234',
    liquidity: { usd: 5000000 },
    volume: { h24: 12000000 },
    marketCap: 5200000000,
    fdv: 5200000000,
    info: {
      imageUrl: 'https://img.dexscreener.com/pepe.png',
      websites: [{ url: 'https://pepe.vip' }],
      socials: [{ type: 'twitter', url: 'https://twitter.com/pepecoineth' }],
    },
    ...overrides,
  };
}

function dexResponse(pairs: any[]) {
  return {
    ok: true,
    json: () => Promise.resolve({ pairs }),
  };
}

function cgSearchResponse(coins: any[]) {
  return {
    ok: true,
    json: () => Promise.resolve({ coins }),
  };
}

function cgCoinResponse(data: Record<string, any>) {
  return {
    ok: true,
    json: () => Promise.resolve(data),
  };
}

function failedResponse() {
  return { ok: false, status: 500, json: () => Promise.resolve({}) };
}

describe('Token Search Library', () => {
  describe('DexScreener primary', () => {
    it('should return DexScreener results when available', async () => {
      mockFetch.mockResolvedValueOnce(dexResponse([dexPair()]));

      const results = await searchTokens('PEPE');

      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('PEPE');
      expect(results[0].dexId).toBe('uniswap');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain('dexscreener.com');
    });

    it('should deduplicate same token across DEXes', async () => {
      mockFetch.mockResolvedValueOnce(dexResponse([
        dexPair({ dexId: 'uniswap', liquidity: { usd: 5000000 }, pairAddress: '0xpair1' }),
        dexPair({ dexId: 'sushiswap', liquidity: { usd: 1000000 }, pairAddress: '0xpair2' }),
      ]));

      const results = await searchTokens('PEPE');

      expect(results).toHaveLength(1);
      expect(results[0].liquidity).toBe(5000000);
      expect(results[0].dexId).toBe('uniswap');
    });

    it('should keep different tokens on different chains', async () => {
      mockFetch.mockResolvedValueOnce(dexResponse([
        dexPair({ chainId: 'ethereum', liquidity: { usd: 5000000 } }),
        dexPair({
          chainId: 'base',
          baseToken: { address: '0xbase123', symbol: 'PEPE', name: 'Pepe' },
          liquidity: { usd: 2000000 },
        }),
      ]));

      const results = await searchTokens('PEPE');

      expect(results).toHaveLength(2);
      expect(results[0].chain).toBe('ethereum');
      expect(results[1].chain).toBe('base');
    });

    it('should sort by liquidity descending', async () => {
      mockFetch.mockResolvedValueOnce(dexResponse([
        dexPair({
          baseToken: { address: '0xlow', symbol: 'LOW', name: 'Low' },
          liquidity: { usd: 100 },
        }),
        dexPair({
          baseToken: { address: '0xhigh', symbol: 'HIGH', name: 'High' },
          liquidity: { usd: 999999 },
        }),
      ]));

      const results = await searchTokens('token');

      expect(results[0].symbol).toBe('HIGH');
      expect(results[1].symbol).toBe('LOW');
    });

    it('should apply chain filter', async () => {
      mockFetch.mockResolvedValueOnce(dexResponse([
        dexPair({ chainId: 'ethereum' }),
        dexPair({ chainId: 'base', baseToken: { address: '0xbase', symbol: 'PEPE', name: 'Pepe' } }),
      ]));

      const results = await searchTokens('PEPE', { chain: 'base' });

      expect(results).toHaveLength(1);
      expect(results[0].chain).toBe('base');
    });

    it('should apply limit', async () => {
      const pairs = Array.from({ length: 20 }, (_, i) =>
        dexPair({
          baseToken: { address: `0x${i}`, symbol: `TOK${i}`, name: `Token ${i}` },
          liquidity: { usd: 1000 - i },
        }),
      );
      mockFetch.mockResolvedValueOnce(dexResponse(pairs));

      const results = await searchTokens('TOK', { limit: 3 });

      expect(results).toHaveLength(3);
    });

    it('should extract metadata from info field', async () => {
      mockFetch.mockResolvedValueOnce(dexResponse([dexPair()]));

      const results = await searchTokens('PEPE');

      expect(results[0].imageUrl).toBe('https://img.dexscreener.com/pepe.png');
      expect(results[0].websites).toEqual(['https://pepe.vip']);
      expect(results[0].socials).toEqual([{ type: 'twitter', url: 'https://twitter.com/pepecoineth' }]);
    });

    it('should handle missing info field gracefully', async () => {
      mockFetch.mockResolvedValueOnce(dexResponse([dexPair({ info: undefined })]));

      const results = await searchTokens('PEPE');

      expect(results[0].imageUrl).toBeNull();
      expect(results[0].websites).toEqual([]);
      expect(results[0].socials).toEqual([]);
    });
  });

  describe('CoinGecko fallback', () => {
    it('should fall back to CoinGecko when DexScreener returns non-ok', async () => {
      // DexScreener fails
      mockFetch.mockResolvedValueOnce(failedResponse());
      // CoinGecko search succeeds
      mockFetch.mockResolvedValueOnce(cgSearchResponse([
        { id: 'pepe', symbol: 'PEPE', name: 'Pepe', market_cap_rank: 25 },
      ]));
      // CoinGecko coin details
      mockFetch.mockResolvedValueOnce(cgCoinResponse({
        symbol: 'pepe',
        name: 'Pepe',
        platforms: {
          ethereum: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
        },
        market_data: {
          current_price: { usd: 0.00000368 },
          market_cap: { usd: 1550000000 },
          total_volume: { usd: 302000000 },
          fully_diluted_valuation: { usd: 1550000000 },
        },
        image: { large: 'https://coingecko.com/pepe.png' },
        links: {
          homepage: ['https://pepe.vip'],
          twitter_screen_name: 'pepecoineth',
        },
      }));

      const results = await searchTokens('PEPE');

      expect(results).toHaveLength(1);
      expect(results[0].address).toBe('0x6982508145454Ce325dDbE47a25d4ec3d2311933');
      expect(results[0].chain).toBe('ethereum');
      expect(results[0].symbol).toBe('PEPE');
      expect(results[0].priceUsd).toBe('0.00000368');
      expect(results[0].marketCap).toBe(1550000000);
      expect(results[0].dexId).toBe('coingecko');
      expect(results[0].imageUrl).toBe('https://coingecko.com/pepe.png');
      expect(results[0].websites).toEqual(['https://pepe.vip']);
      expect(results[0].socials).toContainEqual({
        type: 'twitter',
        url: 'https://twitter.com/pepecoineth',
      });
    });

    it('should fall back to CoinGecko when DexScreener times out', async () => {
      // DexScreener throws (timeout)
      mockFetch.mockRejectedValueOnce(new Error('timeout'));
      // CoinGecko search
      mockFetch.mockResolvedValueOnce(cgSearchResponse([
        { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' },
      ]));
      // CoinGecko coin details
      mockFetch.mockResolvedValueOnce(cgCoinResponse({
        symbol: 'btc',
        name: 'Bitcoin',
        platforms: {},
        market_data: {
          current_price: { usd: 95000 },
          market_cap: { usd: 1800000000000 },
          total_volume: { usd: 30000000000 },
          fully_diluted_valuation: { usd: 1995000000000 },
        },
        image: { large: 'https://coingecko.com/btc.png' },
        links: { homepage: ['https://bitcoin.org'] },
      }));

      const results = await searchTokens('BTC');

      // Bitcoin has no platform addresses (it's native), so empty
      expect(results).toHaveLength(0);
    });

    it('should fall back when DexScreener returns empty pairs', async () => {
      // DexScreener returns empty
      mockFetch.mockResolvedValueOnce(dexResponse([]));
      // CoinGecko search
      mockFetch.mockResolvedValueOnce(cgSearchResponse([
        { id: 'usd-coin', symbol: 'USDC', name: 'USD Coin' },
      ]));
      // CoinGecko coin details
      mockFetch.mockResolvedValueOnce(cgCoinResponse({
        symbol: 'usdc',
        name: 'USD Coin',
        platforms: {
          ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        },
        market_data: {
          current_price: { usd: 1.0 },
          market_cap: { usd: 32000000000 },
          total_volume: { usd: 5000000000 },
          fully_diluted_valuation: { usd: 32000000000 },
        },
        image: { small: 'https://coingecko.com/usdc.png' },
        links: { homepage: ['https://www.circle.com/usdc'] },
      }));

      const results = await searchTokens('USDC');

      expect(results).toHaveLength(2);
      expect(results[0].chain).toBe('ethereum');
      expect(results[1].chain).toBe('base');
    });

    it('should map CoinGecko platform IDs to chain names', async () => {
      mockFetch.mockResolvedValueOnce(failedResponse());
      mockFetch.mockResolvedValueOnce(cgSearchResponse([{ id: 'test-token' }]));
      mockFetch.mockResolvedValueOnce(cgCoinResponse({
        symbol: 'test',
        name: 'Test',
        platforms: {
          'polygon-pos': '0xpoly',
          'arbitrum-one': '0xarb',
          'optimistic-ethereum': '0xop',
        },
        market_data: { current_price: { usd: 1 }, market_cap: {}, total_volume: {} },
        image: {},
        links: {},
      }));

      const results = await searchTokens('TEST');

      const chains = results.map((r) => r.chain).sort();
      expect(chains).toEqual(['arbitrum', 'optimism', 'polygon']);
    });

    it('should apply chain filter to CoinGecko results', async () => {
      mockFetch.mockResolvedValueOnce(failedResponse());
      mockFetch.mockResolvedValueOnce(cgSearchResponse([{ id: 'usdc' }]));
      mockFetch.mockResolvedValueOnce(cgCoinResponse({
        symbol: 'usdc',
        name: 'USD Coin',
        platforms: {
          ethereum: '0xeth',
          base: '0xbase',
          solana: 'SolAddr123',
        },
        market_data: { current_price: { usd: 1 }, market_cap: {}, total_volume: {} },
        image: {},
        links: {},
      }));

      const results = await searchTokens('USDC', { chain: 'base' });

      expect(results).toHaveLength(1);
      expect(results[0].chain).toBe('base');
    });

    it('should extract telegram social from CoinGecko', async () => {
      mockFetch.mockResolvedValueOnce(failedResponse());
      mockFetch.mockResolvedValueOnce(cgSearchResponse([{ id: 'test' }]));
      mockFetch.mockResolvedValueOnce(cgCoinResponse({
        symbol: 'test',
        name: 'Test',
        platforms: { ethereum: '0xtest' },
        market_data: { current_price: { usd: 1 }, market_cap: {}, total_volume: {} },
        image: {},
        links: {
          twitter_screen_name: 'testtoken',
          telegram_channel_identifier: 'testchannel',
        },
      }));

      const results = await searchTokens('TEST');

      expect(results[0].socials).toContainEqual({
        type: 'twitter',
        url: 'https://twitter.com/testtoken',
      });
      expect(results[0].socials).toContainEqual({
        type: 'telegram',
        url: 'https://t.me/testchannel',
      });
    });

    it('should set liquidity to 0 and pairAddress to empty for CoinGecko results', async () => {
      mockFetch.mockResolvedValueOnce(failedResponse());
      mockFetch.mockResolvedValueOnce(cgSearchResponse([{ id: 'test' }]));
      mockFetch.mockResolvedValueOnce(cgCoinResponse({
        symbol: 'test',
        name: 'Test',
        platforms: { ethereum: '0xtest' },
        market_data: { current_price: { usd: 1 }, market_cap: {}, total_volume: {} },
        image: {},
        links: {},
      }));

      const results = await searchTokens('TEST');

      expect(results[0].liquidity).toBe(0);
      expect(results[0].pairAddress).toBe('');
    });

    it('should limit CoinGecko detail fetches to 5 coins', async () => {
      mockFetch.mockResolvedValueOnce(failedResponse());
      // Return 10 coins from search
      const coins = Array.from({ length: 10 }, (_, i) => ({ id: `coin-${i}` }));
      mockFetch.mockResolvedValueOnce(cgSearchResponse(coins));
      // Each detail call
      for (let i = 0; i < 5; i++) {
        mockFetch.mockResolvedValueOnce(cgCoinResponse({
          symbol: `c${i}`,
          name: `Coin ${i}`,
          platforms: { ethereum: `0x${i}` },
          market_data: { current_price: { usd: 1 }, market_cap: {}, total_volume: {} },
          image: {},
          links: {},
        }));
      }

      await searchTokens('coin');

      // 1 DexScreener + 1 CoinGecko search + 5 CoinGecko details = 7
      expect(mockFetch).toHaveBeenCalledTimes(7);
    });

    it('should return empty when both DexScreener and CoinGecko fail', async () => {
      mockFetch.mockResolvedValueOnce(failedResponse()); // DexScreener
      mockFetch.mockResolvedValueOnce(failedResponse()); // CoinGecko search

      const results = await searchTokens('PEPE');

      expect(results).toEqual([]);
    });

    it('should return empty when both DexScreener and CoinGecko throw', async () => {
      mockFetch.mockRejectedValueOnce(new Error('network')); // DexScreener
      mockFetch.mockRejectedValueOnce(new Error('network')); // CoinGecko search

      const results = await searchTokens('PEPE');

      expect(results).toEqual([]);
    });

    it('should handle CoinGecko detail fetch failure gracefully', async () => {
      mockFetch.mockResolvedValueOnce(failedResponse()); // DexScreener
      mockFetch.mockResolvedValueOnce(cgSearchResponse([
        { id: 'good' },
        { id: 'bad' },
      ]));
      // First detail succeeds
      mockFetch.mockResolvedValueOnce(cgCoinResponse({
        symbol: 'good',
        name: 'Good Token',
        platforms: { ethereum: '0xgood' },
        market_data: { current_price: { usd: 5 }, market_cap: { usd: 100000 }, total_volume: {} },
        image: {},
        links: {},
      }));
      // Second detail fails
      mockFetch.mockResolvedValueOnce(failedResponse());

      const results = await searchTokens('token');

      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('GOOD');
    });
  });

  describe('Caching', () => {
    it('should return cached results on second call', async () => {
      mockFetch.mockResolvedValueOnce(dexResponse([dexPair()]));

      const first = await searchTokens('PEPE');
      const second = await searchTokens('PEPE');

      expect(first).toEqual(second);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should use different cache keys for different queries', async () => {
      mockFetch.mockResolvedValueOnce(dexResponse([dexPair()]));
      mockFetch.mockResolvedValueOnce(dexResponse([
        dexPair({ baseToken: { address: '0xdoge', symbol: 'DOGE', name: 'Dogecoin' } }),
      ]));

      const pepe = await searchTokens('PEPE');
      const doge = await searchTokens('DOGE');

      expect(pepe[0].symbol).toBe('PEPE');
      expect(doge[0].symbol).toBe('DOGE');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should cache CoinGecko fallback results too', async () => {
      mockFetch.mockResolvedValueOnce(failedResponse());
      mockFetch.mockResolvedValueOnce(cgSearchResponse([{ id: 'pepe' }]));
      mockFetch.mockResolvedValueOnce(cgCoinResponse({
        symbol: 'pepe',
        name: 'Pepe',
        platforms: { ethereum: '0xpepe' },
        market_data: { current_price: { usd: 0.00001 }, market_cap: {}, total_volume: {} },
        image: {},
        links: {},
      }));

      const first = await searchTokens('PEPE');
      const second = await searchTokens('PEPE');

      expect(first).toEqual(second);
      // DexScreener (1) + CoinGecko search (1) + CoinGecko detail (1) = 3, no more on second call
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('Market data persistence', () => {
    it('should persist market data for tokens with sufficient liquidity', async () => {
      mockFetch.mockResolvedValueOnce(dexResponse([
        dexPair({ liquidity: { usd: 5000000 } }),
      ]));

      await searchTokens('PEPE');

      // Allow fire-and-forget to execute
      await new Promise(r => setTimeout(r, 10));

      expect(mockUpsert).toHaveBeenCalledTimes(1);
      const call = mockUpsert.mock.calls[0][0];
      expect(call.where.tokenAddress_chain.tokenAddress).toBe('0x6982508145454Ce325dDbE47a25d4ec3d2311933');
      expect(call.create.priceUsd).toBe('0.00001234');
      expect(call.create.marketCap).toBe(5200000000);
      expect(call.create.liquidity).toBe(5000000);
      expect(call.create.dexId).toBe('uniswap');
      expect(call.update.priceUsd).toBe('0.00001234');
    });

    it('should skip persistence for tokens below liquidity threshold without marketCap', async () => {
      mockFetch.mockResolvedValueOnce(dexResponse([
        dexPair({
          baseToken: { address: '0xdust', symbol: 'DUST', name: 'Dust' },
          liquidity: { usd: 50 },
          marketCap: null,
          fdv: null,
        }),
      ]));

      await searchTokens('DUST');
      await new Promise(r => setTimeout(r, 10));

      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('should persist tokens with low liquidity but valid marketCap', async () => {
      mockFetch.mockResolvedValueOnce(dexResponse([
        dexPair({
          baseToken: { address: '0xcg', symbol: 'CG', name: 'CoinGecko Token' },
          liquidity: { usd: 50 },
          marketCap: 1000000,
        }),
      ]));

      await searchTokens('CG');
      await new Promise(r => setTimeout(r, 10));

      expect(mockUpsert).toHaveBeenCalledTimes(1);
    });

    it('should not persist local-only results', async () => {
      // searchLocal returns results with dexId='local', these should not be persisted
      mockFindMany.mockResolvedValueOnce([{
        tokenAddress: '0xlocal',
        chain: 'base',
        symbol: 'LOCAL',
        name: 'Local Token',
        icon: null,
        priceUsd: null,
        marketCap: null,
        fdv: null,
        liquidity: null,
        volume24h: null,
        dexId: null,
        pairAddress: null,
        websites: null,
        socials: null,
        lastAccessedAt: new Date(),
      }]);
      // DexScreener returns empty → CoinGecko returns empty
      mockFetch.mockResolvedValueOnce(dexResponse([]));
      mockFetch.mockResolvedValueOnce(cgSearchResponse([]));

      await searchTokens('LOCAL');
      await new Promise(r => setTimeout(r, 10));

      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('should persist websites and socials as JSON strings', async () => {
      mockFetch.mockResolvedValueOnce(dexResponse([dexPair()]));

      await searchTokens('PEPE');
      await new Promise(r => setTimeout(r, 10));

      const call = mockUpsert.mock.calls[0][0];
      expect(call.create.websites).toBe(JSON.stringify(['https://pepe.vip']));
      expect(call.create.socials).toBe(JSON.stringify([{ type: 'twitter', url: 'https://twitter.com/pepecoineth' }]));
    });

    it('should not break search when persistence fails', async () => {
      mockUpsert.mockRejectedValue(new Error('DB write failed'));
      mockFetch.mockResolvedValueOnce(dexResponse([dexPair()]));

      const results = await searchTokens('PEPE');

      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('PEPE');
    });
  });

  describe('Local enrichment with market data', () => {
    it('should return market data from DB in local results', async () => {
      mockFindMany.mockResolvedValueOnce([{
        tokenAddress: '0xenriched',
        chain: 'base',
        symbol: 'RICH',
        name: 'Rich Token',
        icon: 'https://img.com/rich.png',
        priceUsd: '1.50',
        marketCap: 500000,
        fdv: 600000,
        liquidity: 200000,
        volume24h: 50000,
        dexId: 'uniswap',
        pairAddress: '0xpair',
        websites: JSON.stringify(['https://rich.io']),
        socials: JSON.stringify([{ type: 'twitter', url: 'https://twitter.com/rich' }]),
        lastAccessedAt: new Date(),
      }]);
      // DexScreener returns nothing new
      mockFetch.mockResolvedValueOnce(dexResponse([]));
      mockFetch.mockResolvedValueOnce(cgSearchResponse([]));

      const results = await searchTokens('RICH');

      expect(results).toHaveLength(1);
      expect(results[0].priceUsd).toBe('1.50');
      expect(results[0].marketCap).toBe(500000);
      expect(results[0].fdv).toBe(600000);
      expect(results[0].liquidity).toBe(200000);
      expect(results[0].volume24h).toBe(50000);
      expect(results[0].dexId).toBe('uniswap');
      expect(results[0].pairAddress).toBe('0xpair');
      expect(results[0].websites).toEqual(['https://rich.io']);
      expect(results[0].socials).toEqual([{ type: 'twitter', url: 'https://twitter.com/rich' }]);
    });

    it('should fallback to defaults when DB columns are null', async () => {
      mockFindMany.mockResolvedValueOnce([{
        tokenAddress: '0xstub',
        chain: 'base',
        symbol: 'STUB',
        name: 'Stub Token',
        icon: null,
        priceUsd: null,
        marketCap: null,
        fdv: null,
        liquidity: null,
        volume24h: null,
        dexId: null,
        pairAddress: null,
        websites: null,
        socials: null,
        lastAccessedAt: new Date(),
      }]);
      mockFetch.mockResolvedValueOnce(dexResponse([]));
      mockFetch.mockResolvedValueOnce(cgSearchResponse([]));

      const results = await searchTokens('STUB');

      expect(results).toHaveLength(1);
      expect(results[0].priceUsd).toBeNull();
      expect(results[0].liquidity).toBe(0);
      expect(results[0].volume24h).toBe(0);
      expect(results[0].marketCap).toBeNull();
      expect(results[0].fdv).toBeNull();
      expect(results[0].dexId).toBe('local');
      expect(results[0].pairAddress).toBe('');
      expect(results[0].websites).toEqual([]);
      expect(results[0].socials).toEqual([]);
    });
  });

  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      expect(safeJsonParse('["a","b"]', [])).toEqual(['a', 'b']);
      expect(safeJsonParse('[{"type":"twitter","url":"x"}]', [])).toEqual([{ type: 'twitter', url: 'x' }]);
    });

    it('should return fallback for invalid JSON', () => {
      expect(safeJsonParse('not-json', [])).toEqual([]);
      expect(safeJsonParse('{broken', 'default')).toBe('default');
    });

    it('should return fallback for null/undefined', () => {
      expect(safeJsonParse(null, [])).toEqual([]);
      expect(safeJsonParse(undefined, [])).toEqual([]);
    });
  });
});
