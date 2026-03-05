/**
 * Price Library Unit Tests — tests the cascading fallback logic
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock external dependencies before importing the module under test
vi.mock('../../lib/prices', () => ({
  getEthToUsd: vi.fn(),
  getSolToUsd: vi.fn(),
}));

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

const mockedGetEthToUsd = vi.mocked(getEthToUsd);
const mockedGetSolToUsd = vi.mocked(getSolToUsd);
const mockedGetAlchemyKey = vi.mocked(getAlchemyKey);

// Mock global fetch
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  clearPriceCache();
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('getTokenPrice', () => {
  // --- Native token ---

  it('should return ETH price for native on EVM chain', async () => {
    mockedGetEthToUsd.mockResolvedValue(3200);

    const result = await getTokenPrice('native', 'base');

    expect(result).toEqual({ priceUsd: '3200', source: 'cache', cached: true });
    expect(mockedGetEthToUsd).toHaveBeenCalled();
  });

  it('should return SOL price for native on Solana chain', async () => {
    mockedGetSolToUsd.mockResolvedValue(150);

    const result = await getTokenPrice('native', 'solana');

    expect(result).toEqual({ priceUsd: '150', source: 'cache', cached: true });
    expect(mockedGetSolToUsd).toHaveBeenCalled();
  });

  it('should return null when native price not cached', async () => {
    mockedGetEthToUsd.mockResolvedValue(null);

    const result = await getTokenPrice('native', 'base');

    expect(result).toBeNull();
  });

  // --- DexScreener ---

  it('should return DexScreener price and pick highest liquidity pair', async () => {
    const mockResponse = {
      pairs: [
        { chainId: 'base', priceUsd: '0.50', liquidity: { usd: 1000 } },
        { chainId: 'base', priceUsd: '0.9998', liquidity: { usd: 50000000 } },
        { chainId: 'ethereum', priceUsd: '1.01', liquidity: { usd: 80000000 } },
      ],
    };

    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    const result = await getTokenPrice('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'base');

    expect(result).toEqual({ priceUsd: '0.9998', source: 'dexscreener', cached: false });
    // Should filter by chain — the ethereum pair with higher liquidity is excluded
  });

  it('should filter DexScreener pairs by chain', async () => {
    const mockResponse = {
      pairs: [
        { chainId: 'ethereum', priceUsd: '1.01', liquidity: { usd: 80000000 } },
        // No base pairs
      ],
    };

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response)
      // CoinGecko also fails
      .mockResolvedValueOnce({ ok: false } as Response);

    const result = await getTokenPrice('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'base');

    // DexScreener returns no pairs for base, CoinGecko fails, no Alchemy key
    expect(result).toBeNull();
  });

  // --- CoinGecko fallback ---

  it('should fall back to CoinGecko when DexScreener fails', async () => {
    vi.mocked(globalThis.fetch)
      // DexScreener fails
      .mockRejectedValueOnce(new Error('DexScreener timeout'))
      // CoinGecko succeeds
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { usd: 1.0 },
        }),
      } as Response);

    const result = await getTokenPrice('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'base');

    expect(result).toEqual({ priceUsd: '1', source: 'coingecko', cached: false });
  });

  it('should use correct CoinGecko platform ID for Solana', async () => {
    vi.mocked(globalThis.fetch)
      // DexScreener fails
      .mockRejectedValueOnce(new Error('DexScreener timeout'))
      // CoinGecko succeeds
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v': { usd: 1.0 },
        }),
      } as Response);

    const result = await getTokenPrice('EPjFWdd5AufqSSqeM2qN1xZYBaPC8G4wEGGkZwyTDt1v', 'solana');

    expect(result).toEqual({ priceUsd: '1', source: 'coingecko', cached: false });

    // Verify CoinGecko was called with 'solana' platform
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    const coingeckoCall = calls.find(c => String(c[0]).includes('coingecko'));
    expect(coingeckoCall).toBeDefined();
    expect(String(coingeckoCall![0])).toContain('/solana?');
  });

  // --- Alchemy fallback ---

  it('should fall back to Alchemy when DexScreener and CoinGecko fail', async () => {
    mockedGetAlchemyKey.mockResolvedValue('test-alchemy-key');

    vi.mocked(globalThis.fetch)
      // DexScreener fails
      .mockRejectedValueOnce(new Error('DexScreener timeout'))
      // CoinGecko fails
      .mockResolvedValueOnce({ ok: false } as Response)
      // Alchemy succeeds
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          data: [{
            prices: [{ currency: 'usd', value: '1.001' }],
          }],
        }),
      } as Response);

    const result = await getTokenPrice('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'base');

    expect(result).toEqual({ priceUsd: '1.001', source: 'alchemy', cached: false });
  });

  it('should skip Alchemy when no API key configured', async () => {
    mockedGetAlchemyKey.mockResolvedValue(null);

    vi.mocked(globalThis.fetch)
      // DexScreener fails
      .mockRejectedValueOnce(new Error('DexScreener timeout'))
      // CoinGecko fails
      .mockResolvedValueOnce({ ok: false } as Response);

    const result = await getTokenPrice('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'base');

    // Only 2 fetch calls (DexScreener + CoinGecko), no Alchemy
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });

  it('should skip Alchemy for Solana chains even with API key', async () => {
    mockedGetAlchemyKey.mockResolvedValue('test-alchemy-key');

    vi.mocked(globalThis.fetch)
      // DexScreener fails
      .mockRejectedValueOnce(new Error('DexScreener timeout'))
      // CoinGecko fails
      .mockResolvedValueOnce({ ok: false } as Response);

    const result = await getTokenPrice('EPjFWdd5AufqSSqeM2qN1xZYBaPC8G4wEGGkZwyTDt1v', 'solana');

    // Only 2 fetch calls — Alchemy was skipped (Solana not supported)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
    expect(result).toBeNull();
  });

  // --- All fail ---

  it('should return null when all sources fail', async () => {
    mockedGetAlchemyKey.mockResolvedValue('test-alchemy-key');

    vi.mocked(globalThis.fetch)
      .mockRejectedValueOnce(new Error('DexScreener timeout'))
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: false } as Response);

    const result = await getTokenPrice('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'base');

    expect(result).toBeNull();
  });

  // --- Cache ---

  it('should return cached result on second call within TTL', async () => {
    const mockResponse = {
      pairs: [
        { chainId: 'base', priceUsd: '0.9998', liquidity: { usd: 50000000 } },
      ],
    };

    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    // First call — fetches from DexScreener
    const result1 = await getTokenPrice('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'base');
    expect(result1?.cached).toBe(false);
    expect(result1?.source).toBe('dexscreener');

    // Second call — should be cached
    const result2 = await getTokenPrice('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'base');
    expect(result2?.cached).toBe(true);
    expect(result2?.source).toBe('dexscreener');

    // fetch should only have been called once (for the first DexScreener call)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('should re-fetch after cache TTL expires', async () => {
    vi.useFakeTimers();

    const mockResponse = {
      pairs: [
        { chainId: 'base', priceUsd: '0.9998', liquidity: { usd: 50000000 } },
      ],
    };

    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    // First call — fetches from DexScreener
    await getTokenPrice('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'base');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);

    // Advance past TTL (61 seconds)
    vi.advanceTimersByTime(61_000);

    // Second call — cache expired, should re-fetch
    const result2 = await getTokenPrice('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'base');
    expect(result2?.cached).toBe(false);

    // fetch should have been called twice (once per DexScreener call)
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
