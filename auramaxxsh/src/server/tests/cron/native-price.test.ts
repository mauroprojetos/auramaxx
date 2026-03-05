import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, testPrisma } from '../setup';
import { nativePriceJob } from '../../cron/jobs/native-price';
import type { CronContext } from '../../cron/job';
import pino from 'pino';

function createMockContext(): CronContext {
  return {
    prisma: testPrisma as unknown as CronContext['prisma'],
    broadcastUrl: '',
    emit: vi.fn().mockResolvedValue(undefined),
    defaults: { get: <T>(_key: string, fallback: T) => fallback },
    log: pino({ level: 'silent' }),
  };
}

describe('native-price job', () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanDatabase();
  });

  it('writes ETH and SOL prices to DB', async () => {
    // Mock fetch to return valid CoinGecko response
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ethereum: { usd: 3456.78 },
        solana: { usd: 123.45 },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createMockContext();
    await nativePriceJob.run(ctx);

    const ethPrice = await testPrisma.nativePrice.findUnique({
      where: { currency: 'ETH' },
    });
    expect(ethPrice).not.toBeNull();
    expect(ethPrice!.priceUsd).toBe('3456.78');

    const solPrice = await testPrisma.nativePrice.findUnique({
      where: { currency: 'SOL' },
    });
    expect(solPrice).not.toBeNull();
    expect(solPrice!.priceUsd).toBe('123.45');
  });

  it('handles CoinGecko error gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createMockContext();
    // Should not throw
    await nativePriceJob.run(ctx);

    // No prices written
    const count = await testPrisma.nativePrice.count();
    expect(count).toBe(0);
  });

  it('handles non-OK response gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createMockContext();
    await nativePriceJob.run(ctx);

    const count = await testPrisma.nativePrice.count();
    expect(count).toBe(0);
  });

  it('skips when sync.enabled is false', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createMockContext();
    ctx.defaults = {
      get: <T>(key: string, fallback: T) => {
        if (key === 'sync.enabled') return false as unknown as T;
        return fallback;
      },
    };

    await nativePriceJob.run(ctx);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('updates existing prices (upsert)', async () => {
    // Seed initial price
    await testPrisma.nativePrice.create({
      data: { currency: 'ETH', priceUsd: '1000' },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ethereum: { usd: 2000 },
        solana: { usd: 50 },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createMockContext();
    await nativePriceJob.run(ctx);

    const ethPrice = await testPrisma.nativePrice.findUnique({
      where: { currency: 'ETH' },
    });
    expect(ethPrice!.priceUsd).toBe('2000');
  });
});
