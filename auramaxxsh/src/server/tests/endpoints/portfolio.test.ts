import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { cleanDatabase, testPrisma, createTestApp, setupAndUnlockWallet } from '../setup';
import { __resetCache } from '../../lib/defaults';

// Mock the batch price fetcher
vi.mock('../../lib/price', () => ({
  getTokenPrices: vi.fn().mockResolvedValue(new Map()),
  getTokenPrice: vi.fn().mockResolvedValue(null),
  clearPriceCache: vi.fn(),
}));

import { getTokenPrices } from '../../lib/price';
const mockedGetTokenPrices = vi.mocked(getTokenPrices);

describe('GET /portfolio', () => {
  beforeEach(async () => {
    __resetCache();
    await cleanDatabase();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    __resetCache();
    await cleanDatabase();
  });

  it('returns empty portfolio when no data', async () => {
    const app = createTestApp();
    const res = await request(app).get('/portfolio');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.byChain).toEqual([]);
    expect(res.body.byToken).toEqual([]);
    expect(res.body.prices).toBeDefined();
    expect(res.body.totalValueUsd).toBe('0.00');
  });

  it('aggregates native balances by chain', async () => {
    const app = createTestApp();

    // Seed some native balances
    await testPrisma.nativeBalance.createMany({
      data: [
        { walletAddress: '0xaaa', chain: 'base', balance: '1.5' },
        { walletAddress: '0xbbb', chain: 'base', balance: '2.5' },
        { walletAddress: '0xccc', chain: 'ethereum', balance: '10.0' },
      ],
    });

    const res = await request(app).get('/portfolio');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const baseChain = res.body.byChain.find((c: { chain: string }) => c.chain === 'base');
    expect(baseChain).toBeDefined();
    expect(baseChain.totalBalance).toBe(4);
    expect(baseChain.walletCount).toBe(2);

    const ethChain = res.body.byChain.find((c: { chain: string }) => c.chain === 'ethereum');
    expect(ethChain).toBeDefined();
    expect(ethChain.totalBalance).toBe(10);
    expect(ethChain.walletCount).toBe(1);
  });

  it('aggregates token balances across wallets', async () => {
    const app = createTestApp();
    const tokenAddr = '0x' + 'a'.repeat(40);

    // Seed tracked assets with cached balances
    await testPrisma.trackedAsset.createMany({
      data: [
        {
          walletAddress: '0xaaa',
          tokenAddress: tokenAddr,
          chain: 'base',
          symbol: 'TKN',
          name: 'Test Token',
          lastBalance: '100.5',
          lastBalanceAt: new Date(),
        },
        {
          walletAddress: '0xbbb',
          tokenAddress: tokenAddr,
          chain: 'base',
          symbol: 'TKN',
          name: 'Test Token',
          lastBalance: '200.25',
          lastBalanceAt: new Date(),
        },
      ],
    });

    const res = await request(app).get('/portfolio');

    expect(res.status).toBe(200);
    expect(res.body.byToken).toHaveLength(1);
    expect(res.body.byToken[0].symbol).toBe('TKN');
    expect(res.body.byToken[0].totalBalance).toBeCloseTo(300.75, 2);
    expect(res.body.byToken[0].walletCount).toBe(2);
  });

  it('includes cached prices', async () => {
    const app = createTestApp();

    await testPrisma.nativePrice.createMany({
      data: [
        { currency: 'ETH', priceUsd: '3000.50' },
        { currency: 'SOL', priceUsd: '150.25' },
      ],
    });

    const res = await request(app).get('/portfolio');

    expect(res.status).toBe(200);
    expect(res.body.prices.ETH).toBe(3000.5);
    expect(res.body.prices.SOL).toBe(150.25);
  });

  it('excludes assets without cached balance', async () => {
    const app = createTestApp();

    await testPrisma.trackedAsset.create({
      data: {
        walletAddress: '0xaaa',
        tokenAddress: '0x' + 'b'.repeat(40),
        chain: 'base',
        // No lastBalance set
      },
    });

    const res = await request(app).get('/portfolio');

    expect(res.status).toBe(200);
    expect(res.body.byToken).toHaveLength(0);
  });

  it('includes USD values for tokens when prices available', async () => {
    const app = createTestApp();
    const tokenAddr = '0x' + 'a'.repeat(40);

    await testPrisma.trackedAsset.createMany({
      data: [
        {
          walletAddress: '0xaaa',
          tokenAddress: tokenAddr,
          chain: 'base',
          symbol: 'USDC',
          name: 'USD Coin',
          lastBalance: '500.0',
          lastBalanceAt: new Date(),
        },
      ],
    });

    // Mock batch price lookup to return a price for our token
    mockedGetTokenPrices.mockResolvedValue(
      new Map([
        [`base:${tokenAddr}`, { priceUsd: '1.00', source: 'coingecko', cached: false }],
      ]),
    );

    const res = await request(app).get('/portfolio');

    expect(res.status).toBe(200);
    expect(res.body.byToken[0].priceUsd).toBe('1');
    expect(res.body.byToken[0].valueUsd).toBe('500.00');
  });

  it('includes USD values for native balances', async () => {
    const app = createTestApp();

    await testPrisma.nativeBalance.createMany({
      data: [
        { walletAddress: '0xaaa', chain: 'base', balance: '2.0' },
      ],
    });

    await testPrisma.nativePrice.create({
      data: { currency: 'ETH', priceUsd: '3000' },
    });

    const res = await request(app).get('/portfolio');

    expect(res.status).toBe(200);
    const baseChain = res.body.byChain.find((c: { chain: string }) => c.chain === 'base');
    expect(baseChain.valueUsd).toBe('6000.00');
  });

  it('returns totalValueUsd summing native + token values', async () => {
    const app = createTestApp();
    const tokenAddr = '0x' + 'a'.repeat(40);

    await testPrisma.nativeBalance.create({
      data: { walletAddress: '0xaaa', chain: 'base', balance: '1.0' },
    });

    await testPrisma.nativePrice.create({
      data: { currency: 'ETH', priceUsd: '3000' },
    });

    await testPrisma.trackedAsset.create({
      data: {
        walletAddress: '0xaaa',
        tokenAddress: tokenAddr,
        chain: 'base',
        symbol: 'USDC',
        lastBalance: '500.0',
        lastBalanceAt: new Date(),
      },
    });

    mockedGetTokenPrices.mockResolvedValue(
      new Map([
        [`base:${tokenAddr}`, { priceUsd: '1.00', source: 'coingecko', cached: false }],
      ]),
    );

    const res = await request(app).get('/portfolio');

    expect(res.status).toBe(200);
    // 3000 (1 ETH) + 500 (500 USDC) = 3500
    expect(parseFloat(res.body.totalValueUsd)).toBeCloseTo(3500, 0);
  });

  it('handles null token prices gracefully', async () => {
    const app = createTestApp();
    const tokenAddr = '0x' + 'a'.repeat(40);

    await testPrisma.trackedAsset.create({
      data: {
        walletAddress: '0xaaa',
        tokenAddress: tokenAddr,
        chain: 'base',
        symbol: 'UNKNOWN',
        lastBalance: '1000',
        lastBalanceAt: new Date(),
      },
    });

    // No price returned from batch
    mockedGetTokenPrices.mockResolvedValue(new Map());

    const res = await request(app).get('/portfolio');

    expect(res.status).toBe(200);
    expect(res.body.byToken[0].priceUsd).toBeNull();
    expect(res.body.byToken[0].valueUsd).toBeNull();
    expect(res.body.totalValueUsd).toBe('0.00');
  });

  it('sorts tokens by USD value descending', async () => {
    const app = createTestApp();
    const cheapToken = '0x' + 'a'.repeat(40);
    const expensiveToken = '0x' + 'b'.repeat(40);

    await testPrisma.trackedAsset.createMany({
      data: [
        {
          walletAddress: '0xaaa',
          tokenAddress: cheapToken,
          chain: 'base',
          symbol: 'CHEAP',
          lastBalance: '1000',
          lastBalanceAt: new Date(),
        },
        {
          walletAddress: '0xaaa',
          tokenAddress: expensiveToken,
          chain: 'base',
          symbol: 'EXPENSIVE',
          lastBalance: '10',
          lastBalanceAt: new Date(),
        },
      ],
    });

    mockedGetTokenPrices.mockResolvedValue(
      new Map([
        [`base:${cheapToken}`, { priceUsd: '0.01', source: 'dexscreener', cached: false }],
        [`base:${expensiveToken}`, { priceUsd: '100', source: 'dexscreener', cached: false }],
      ]),
    );

    const res = await request(app).get('/portfolio');

    expect(res.status).toBe(200);
    expect(res.body.byToken).toHaveLength(2);
    // $1000 > $10
    expect(res.body.byToken[0].symbol).toBe('EXPENSIVE');
    expect(res.body.byToken[1].symbol).toBe('CHEAP');
  });

  // --- Filter tests ---

  it('filters by token address and returns per-wallet breakdown', async () => {
    const app = createTestApp();
    const tokenAddr = '0x' + 'a'.repeat(40);
    const otherToken = '0x' + 'b'.repeat(40);

    await testPrisma.trackedAsset.createMany({
      data: [
        {
          walletAddress: '0xaaa',
          tokenAddress: tokenAddr,
          chain: 'base',
          symbol: 'TKN',
          name: 'Test Token',
          lastBalance: '100',
          lastBalanceAt: new Date(),
        },
        {
          walletAddress: '0xbbb',
          tokenAddress: tokenAddr,
          chain: 'base',
          symbol: 'TKN',
          name: 'Test Token',
          lastBalance: '200',
          lastBalanceAt: new Date(),
        },
        {
          walletAddress: '0xaaa',
          tokenAddress: otherToken,
          chain: 'base',
          symbol: 'OTHER',
          lastBalance: '999',
          lastBalanceAt: new Date(),
        },
      ],
    });

    const res = await request(app).get(`/portfolio?token=${tokenAddr}`);

    expect(res.status).toBe(200);
    // Only the filtered token should appear
    expect(res.body.byToken).toHaveLength(1);
    expect(res.body.byToken[0].symbol).toBe('TKN');
    expect(res.body.byToken[0].totalBalance).toBeCloseTo(300, 0);

    // Per-wallet breakdown should be included
    expect(res.body.wallets).toBeDefined();
    expect(res.body.wallets).toHaveLength(2);
    const walletA = res.body.wallets.find((w: any) => w.walletAddress === '0xaaa');
    const walletB = res.body.wallets.find((w: any) => w.walletAddress === '0xbbb');
    expect(walletA.balance).toBe(100);
    expect(walletB.balance).toBe(200);
  });

  it('filters by symbol (case-insensitive) and returns per-wallet breakdown', async () => {
    const app = createTestApp();
    const tokenAddr = '0x' + 'a'.repeat(40);

    await testPrisma.trackedAsset.createMany({
      data: [
        {
          walletAddress: '0xaaa',
          tokenAddress: tokenAddr,
          chain: 'base',
          symbol: 'USDC',
          name: 'USD Coin',
          lastBalance: '500',
          lastBalanceAt: new Date(),
        },
        {
          walletAddress: '0xbbb',
          tokenAddress: tokenAddr,
          chain: 'base',
          symbol: 'USDC',
          name: 'USD Coin',
          lastBalance: '300',
          lastBalanceAt: new Date(),
        },
      ],
    });

    // Filter by lowercase symbol — route uppercases it
    const res = await request(app).get('/portfolio?symbol=usdc');

    expect(res.status).toBe(200);
    expect(res.body.byToken).toHaveLength(1);
    expect(res.body.byToken[0].symbol).toBe('USDC');
    expect(res.body.byToken[0].totalBalance).toBeCloseTo(800, 0);
    expect(res.body.wallets).toHaveLength(2);
  });

  it('filters by chain', async () => {
    const app = createTestApp();

    await testPrisma.nativeBalance.createMany({
      data: [
        { walletAddress: '0xaaa', chain: 'base', balance: '1.0' },
        { walletAddress: '0xbbb', chain: 'ethereum', balance: '5.0' },
      ],
    });

    const tokenAddr = '0x' + 'a'.repeat(40);
    await testPrisma.trackedAsset.createMany({
      data: [
        {
          walletAddress: '0xaaa',
          tokenAddress: tokenAddr,
          chain: 'base',
          symbol: 'TKN',
          lastBalance: '100',
          lastBalanceAt: new Date(),
        },
        {
          walletAddress: '0xbbb',
          tokenAddress: tokenAddr,
          chain: 'ethereum',
          symbol: 'TKN',
          lastBalance: '200',
          lastBalanceAt: new Date(),
        },
      ],
    });

    const res = await request(app).get('/portfolio?chain=base');

    expect(res.status).toBe(200);
    // Only base chain native
    expect(res.body.byChain).toHaveLength(1);
    expect(res.body.byChain[0].chain).toBe('base');
    expect(res.body.byChain[0].totalBalance).toBe(1);

    // Only base chain token
    expect(res.body.byToken).toHaveLength(1);
    expect(res.body.byToken[0].chain).toBe('base');
    expect(res.body.byToken[0].totalBalance).toBe(100);
  });

  it('does not include wallets breakdown without token/symbol filter', async () => {
    const app = createTestApp();
    const tokenAddr = '0x' + 'a'.repeat(40);

    await testPrisma.trackedAsset.create({
      data: {
        walletAddress: '0xaaa',
        tokenAddress: tokenAddr,
        chain: 'base',
        symbol: 'TKN',
        lastBalance: '100',
        lastBalanceAt: new Date(),
      },
    });

    const res = await request(app).get('/portfolio');

    expect(res.status).toBe(200);
    expect(res.body.wallets).toBeUndefined();
  });

  it('includes USD in wallet breakdown when price available', async () => {
    const app = createTestApp();
    const tokenAddr = '0x' + 'a'.repeat(40);

    await testPrisma.trackedAsset.createMany({
      data: [
        {
          walletAddress: '0xaaa',
          tokenAddress: tokenAddr,
          chain: 'base',
          symbol: 'USDC',
          lastBalance: '500',
          lastBalanceAt: new Date(),
        },
        {
          walletAddress: '0xbbb',
          tokenAddress: tokenAddr,
          chain: 'base',
          symbol: 'USDC',
          lastBalance: '300',
          lastBalanceAt: new Date(),
        },
      ],
    });

    mockedGetTokenPrices.mockResolvedValue(
      new Map([
        [`base:${tokenAddr}`, { priceUsd: '1.00', source: 'coingecko', cached: false }],
      ]),
    );

    const res = await request(app).get(`/portfolio?token=${tokenAddr}`);

    expect(res.status).toBe(200);
    expect(res.body.wallets).toHaveLength(2);

    const walletA = res.body.wallets.find((w: any) => w.walletAddress === '0xaaa');
    expect(walletA.valueUsd).toBe('500.00');

    const walletB = res.body.wallets.find((w: any) => w.walletAddress === '0xbbb');
    expect(walletB.valueUsd).toBe('300.00');
  });
});
