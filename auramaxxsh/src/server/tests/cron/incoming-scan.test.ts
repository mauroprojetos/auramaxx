import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, testPrisma } from '../setup';
import { incomingScanJob } from '../../cron/jobs/incoming-scan';
import type { CronContext } from '../../cron/job';
import pino from 'pino';

// ─── Mocks ────────────────────────────────────────────────────────────

// Mock token-search
vi.mock('../../lib/token-search', () => ({
  searchTokens: vi.fn().mockResolvedValue([]),
}));

// Mock price
vi.mock('../../lib/price', () => ({
  getTokenPrice: vi.fn().mockResolvedValue(null),
}));

// Mock token-safety
vi.mock('../../lib/token-safety', () => ({
  getTokenSafety: vi.fn().mockResolvedValue(null),
}));

// Mock token-metadata (fire-and-forget)
vi.mock('../../lib/token-metadata', () => ({
  upsertTokenMetadata: vi.fn(),
}));

// Mock enricher — resolveTokenMetadataBatch
vi.mock('../../lib/txhistory/enricher', () => ({
  resolveTokenMetadataBatch: vi.fn().mockResolvedValue(new Map()),
}));

// Mock config — only override getRpcUrl, keep getDbUrl for Prisma
vi.mock('../../lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/config')>();
  return {
    ...actual,
    getRpcUrl: vi.fn().mockResolvedValue('http://localhost:8545'),
  };
});

import { getTokenPrice } from '../../lib/price';
import { searchTokens } from '../../lib/token-search';
import { getTokenSafety } from '../../lib/token-safety';
import { upsertTokenMetadata } from '../../lib/token-metadata';
import { resolveTokenMetadataBatch } from '../../lib/txhistory/enricher';
import type { TokenInfo } from '../../lib/txhistory/enricher';

// ─── Helpers ──────────────────────────────────────────────────────────

const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const SENDER_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TX_HASH = '0x' + 'ab'.repeat(32);
const BLOCK_HEX = '0xf4240'; // 1000000

function createMockContext(overrides?: Partial<CronContext>): CronContext {
  return {
    prisma: testPrisma as unknown as CronContext['prisma'],
    broadcastUrl: '',
    emit: vi.fn().mockResolvedValue(undefined),
    defaults: { get: <T>(_key: string, fallback: T) => fallback },
    log: pino({ level: 'silent' }),
    ...overrides,
  };
}

/** Build a mock eth_getLogs RPC response with a single ERC-20 Transfer log */
function buildTransferLog(opts: {
  token?: string;
  from?: string;
  to?: string;
  amount?: string;
  txHash?: string;
  blockNumber?: string;
} = {}) {
  const token = opts.token ?? USDC_ADDRESS;
  const from = opts.from ?? SENDER_ADDRESS;
  const to = opts.to ?? WALLET_ADDRESS;
  // 1000000 = 0xF4240 padded to 32 bytes (USDC has 6 decimals, so 1000000 = 1 USDC)
  const amount = opts.amount ?? '0x' + '0'.repeat(58) + '0f4240';
  const txHash = opts.txHash ?? TX_HASH;
  const blockNumber = opts.blockNumber ?? BLOCK_HEX;

  return {
    address: token,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Transfer
      '0x' + from.slice(2).padStart(64, '0'), // from (topic1)
      '0x' + to.slice(2).padStart(64, '0'),   // to (topic2)
    ],
    data: amount,
    transactionHash: txHash,
    logIndex: '0x0',
    blockNumber,
  };
}

/** Set up a hot wallet in the test DB */
async function seedHotWallet(address: string = WALLET_ADDRESS, chain: string = 'base') {
  await testPrisma.hotWallet.create({
    data: {
      address: address.toLowerCase(),
      encryptedPrivateKey: 'test-encrypted-key',
      tokenHash: 'test-token-hash',
      chain,
    },
  });
}

/** Build the mock fetch that handles both eth_blockNumber and eth_getLogs */
function buildMockFetch(logs: any[] = [], latestBlock: string = '0x100000') {
  return vi.fn().mockImplementation(async (url: string, opts?: any) => {
    if (opts?.body) {
      const body = JSON.parse(opts.body);
      if (body.method === 'eth_blockNumber') {
        return {
          ok: true,
          json: async () => ({ jsonrpc: '2.0', id: body.id, result: latestBlock }),
        };
      }
      if (body.method === 'eth_getLogs') {
        return {
          ok: true,
          json: async () => ({ jsonrpc: '2.0', id: body.id, result: logs }),
        };
      }
    }
    return { ok: false, json: async () => ({}) };
  });
}

/** Set up standard mocks for a token that passes all gates */
function setupPassingGates(opts: {
  priceUsd?: string;
  liquidity?: number;
  symbol?: string;
  decimals?: number;
} = {}) {
  const symbol = opts.symbol ?? 'USDC';
  const decimals = opts.decimals ?? 6;
  const priceUsd = opts.priceUsd ?? '1.0';
  const liquidity = opts.liquidity ?? 5000;

  vi.mocked(resolveTokenMetadataBatch).mockResolvedValue(
    new Map<string, TokenInfo>([[USDC_ADDRESS, {
      address: USDC_ADDRESS,
      symbol,
      name: 'USD Coin',
      decimals,
    }]])
  );

  vi.mocked(getTokenPrice).mockResolvedValue({
    priceUsd,
    source: 'dexscreener',
    cached: false,
  });

  vi.mocked(searchTokens).mockResolvedValue([{
    address: USDC_ADDRESS,
    chain: 'base',
    symbol,
    name: 'USD Coin',
    priceUsd,
    liquidity,
    volume24h: 1000000,
    marketCap: 1000000000,
    fdv: null,
    imageUrl: null,
    websites: [],
    socials: [],
    dexId: 'uniswap',
    pairAddress: '0xpool',
  }]);

  vi.mocked(getTokenSafety).mockResolvedValue({
    tokenName: 'USD Coin',
    tokenSymbol: symbol,
    totalSupply: '1000000000',
    isHoneypot: false,
    isMintable: false,
    isOpenSource: true,
    isProxy: false,
    isBlacklisted: false,
    isAntiWhale: false,
    hasHiddenOwner: false,
    hasExternalCall: false,
    hasSelfDestruct: false,
    canTakeBackOwnership: false,
    transferPausable: false,
    buyTax: '0',
    sellTax: '0',
    ownerAddress: '',
    creatorAddress: '',
    creatorPercent: '0',
    holderCount: 1000,
    holders: [],
    lpHolderCount: 10,
    lpTotalSupply: '1000000',
    lpHolders: [],
    dexInfo: [],
  });
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('incoming-scan job', () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanDatabase();
  });

  it('has correct job metadata', () => {
    expect(incomingScanJob.id).toBe('incoming-scan');
    expect(incomingScanJob.intervalKey).toBe('discovery.scan_interval');
    expect(incomingScanJob.defaultInterval).toBe(60_000);
  });

  it('exits immediately when discovery.enabled is false', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createMockContext({
      defaults: {
        get: <T>(key: string, fallback: T) => {
          if (key === 'discovery.enabled') return false as unknown as T;
          return fallback;
        },
      },
    });

    await incomingScanJob.run(ctx);

    // Should not even query the DB for wallets
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does nothing when no hot wallets exist', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('token passes all gates → TrackedAsset + Transaction created', async () => {
    await seedHotWallet();

    const logs = [buildTransferLog()];
    const mockFetch = buildMockFetch(logs, '0x100000');
    vi.stubGlobal('fetch', mockFetch);

    setupPassingGates();

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    // Check TrackedAsset was created
    const asset = await testPrisma.trackedAsset.findUnique({
      where: {
        walletAddress_tokenAddress_chain: {
          walletAddress: WALLET_ADDRESS.toLowerCase(),
          tokenAddress: USDC_ADDRESS,
          chain: 'base',
        },
      },
    });
    expect(asset).not.toBeNull();
    expect(asset!.symbol).toBe('USDC');
    expect(asset!.decimals).toBe(6);

    // Check Transaction was created
    const tx = await testPrisma.transaction.findUnique({
      where: { txHash_chain: { txHash: TX_HASH, chain: 'base' } },
    });
    expect(tx).not.toBeNull();
    expect(tx!.type).toBe('receive');
    expect(tx!.tokenAddress).toBe(USDC_ADDRESS);
    expect(tx!.from).toBe(SENDER_ADDRESS.toLowerCase());

    // Check asset:discovered event emitted
    expect(ctx.emit).toHaveBeenCalledWith('asset:discovered', expect.objectContaining({
      walletAddress: WALLET_ADDRESS.toLowerCase(),
      tokenAddress: USDC_ADDRESS,
      chain: 'base',
      symbol: 'USDC',
    }));
  });

  it('token fails value gate → skipped', async () => {
    await seedHotWallet();

    const logs = [buildTransferLog()];
    const mockFetch = buildMockFetch(logs, '0x100000');
    vi.stubGlobal('fetch', mockFetch);

    // Set up mocks with very low price (below $0.50 threshold)
    vi.mocked(resolveTokenMetadataBatch).mockResolvedValue(
      new Map([[USDC_ADDRESS, { address: USDC_ADDRESS, symbol: 'SCAM', name: 'Scam Token', decimals: 6 }]])
    );
    vi.mocked(getTokenPrice).mockResolvedValue({
      priceUsd: '0.0001', // 1 USDC worth of this token = $0.0001 — way below $0.50
      source: 'dexscreener',
      cached: false,
    });

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    // No TrackedAsset created
    const count = await testPrisma.trackedAsset.count();
    expect(count).toBe(0);

    // No Transaction created
    const txCount = await testPrisma.transaction.count();
    expect(txCount).toBe(0);
  });

  it('token fails liquidity gate → skipped', async () => {
    await seedHotWallet();

    const logs = [buildTransferLog()];
    const mockFetch = buildMockFetch(logs, '0x100000');
    vi.stubGlobal('fetch', mockFetch);

    vi.mocked(resolveTokenMetadataBatch).mockResolvedValue(
      new Map([[USDC_ADDRESS, { address: USDC_ADDRESS, symbol: 'LOW', name: 'Low Liq', decimals: 6 }]])
    );
    vi.mocked(getTokenPrice).mockResolvedValue({
      priceUsd: '10.0', // High price, passes value gate
      source: 'dexscreener',
      cached: false,
    });
    vi.mocked(searchTokens).mockResolvedValue([{
      address: USDC_ADDRESS,
      chain: 'base',
      symbol: 'LOW',
      name: 'Low Liq',
      priceUsd: '10.0',
      liquidity: 500, // Below $1000 threshold
      volume24h: 100,
      marketCap: null,
      fdv: null,
      imageUrl: null,
      websites: [],
      socials: [],
      dexId: 'uniswap',
      pairAddress: '0xpool',
    }]);

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    const count = await testPrisma.trackedAsset.count();
    expect(count).toBe(0);
  });

  it('token fails safety gate (honeypot) → skipped, TokenMetadata still written', async () => {
    await seedHotWallet();

    const logs = [buildTransferLog()];
    const mockFetch = buildMockFetch(logs, '0x100000');
    vi.stubGlobal('fetch', mockFetch);

    // Pass value and liquidity gates
    vi.mocked(resolveTokenMetadataBatch).mockResolvedValue(
      new Map([[USDC_ADDRESS, { address: USDC_ADDRESS, symbol: 'HONEY', name: 'Honeypot', decimals: 6 }]])
    );
    vi.mocked(getTokenPrice).mockResolvedValue({
      priceUsd: '10.0',
      source: 'dexscreener',
      cached: false,
    });
    vi.mocked(searchTokens).mockResolvedValue([{
      address: USDC_ADDRESS,
      chain: 'base',
      symbol: 'HONEY',
      name: 'Honeypot',
      priceUsd: '10.0',
      liquidity: 5000,
      volume24h: 1000,
      marketCap: null,
      fdv: null,
      imageUrl: null,
      websites: [],
      socials: [],
      dexId: 'uniswap',
      pairAddress: '0xpool',
    }]);
    vi.mocked(getTokenSafety).mockResolvedValue({
      tokenName: 'Honeypot',
      tokenSymbol: 'HONEY',
      totalSupply: '1000000',
      isHoneypot: true,
      isMintable: false,
      isOpenSource: false,
      isProxy: false,
      isBlacklisted: false,
      isAntiWhale: false,
      hasHiddenOwner: false,
      hasExternalCall: false,
      hasSelfDestruct: false,
      canTakeBackOwnership: false,
      transferPausable: false,
      buyTax: '0',
      sellTax: '0',
      ownerAddress: '',
      creatorAddress: '',
      creatorPercent: '0',
      holderCount: 10,
      holders: [],
      lpHolderCount: 1,
      lpTotalSupply: '100',
      lpHolders: [],
      dexInfo: [],
    });

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    // No TrackedAsset created
    const count = await testPrisma.trackedAsset.count();
    expect(count).toBe(0);

    // upsertTokenMetadata was still called (for manual lookup)
    expect(upsertTokenMetadata).toHaveBeenCalledWith(
      USDC_ADDRESS, 'base',
      expect.objectContaining({ symbol: 'HONEY' }),
    );
  });

  it('already-tracked token → only Transaction created, no duplicate TrackedAsset', async () => {
    await seedHotWallet();

    // Pre-seed the tracked asset
    await testPrisma.trackedAsset.create({
      data: {
        walletAddress: WALLET_ADDRESS.toLowerCase(),
        tokenAddress: USDC_ADDRESS,
        chain: 'base',
        symbol: 'USDC',
        decimals: 6,
      },
    });

    const logs = [buildTransferLog()];
    const mockFetch = buildMockFetch(logs, '0x100000');
    vi.stubGlobal('fetch', mockFetch);

    vi.mocked(resolveTokenMetadataBatch).mockResolvedValue(
      new Map([[USDC_ADDRESS, { address: USDC_ADDRESS, symbol: 'USDC', name: 'USD Coin', decimals: 6 }]])
    );

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    // Still just 1 TrackedAsset
    const assetCount = await testPrisma.trackedAsset.count();
    expect(assetCount).toBe(1);

    // Transaction was created
    const tx = await testPrisma.transaction.findUnique({
      where: { txHash_chain: { txHash: TX_HASH, chain: 'base' } },
    });
    expect(tx).not.toBeNull();
    expect(tx!.type).toBe('receive');

    // No gate functions called (already tracked = skip gates)
    expect(getTokenPrice).not.toHaveBeenCalled();
    expect(searchTokens).not.toHaveBeenCalled();
    expect(getTokenSafety).not.toHaveBeenCalled();
  });

  it('duplicate txHash+chain → no duplicate Transaction', async () => {
    await seedHotWallet();

    // Pre-seed the tracked asset and transaction
    await testPrisma.trackedAsset.create({
      data: {
        walletAddress: WALLET_ADDRESS.toLowerCase(),
        tokenAddress: USDC_ADDRESS,
        chain: 'base',
        symbol: 'USDC',
        decimals: 6,
      },
    });
    await testPrisma.transaction.create({
      data: {
        walletAddress: WALLET_ADDRESS.toLowerCase(),
        txHash: TX_HASH,
        type: 'receive',
        status: 'confirmed',
        tokenAddress: USDC_ADDRESS,
        chain: 'base',
      },
    });

    const logs = [buildTransferLog()];
    const mockFetch = buildMockFetch(logs, '0x100000');
    vi.stubGlobal('fetch', mockFetch);

    vi.mocked(resolveTokenMetadataBatch).mockResolvedValue(
      new Map([[USDC_ADDRESS, { address: USDC_ADDRESS, symbol: 'USDC', name: 'USD Coin', decimals: 6 }]])
    );

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    // Still just 1 Transaction
    const txCount = await testPrisma.transaction.count();
    expect(txCount).toBe(1);
  });

  it('block cursor advances on success', async () => {
    await seedHotWallet();

    const mockFetch = buildMockFetch([], '0x100000');
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    // SyncState should have been created with lastBlock
    const syncState = await testPrisma.syncState.findUnique({
      where: { chain: 'base:discovery' },
    });
    expect(syncState).not.toBeNull();
    expect(syncState!.lastBlock).not.toBeNull();
    expect(syncState!.lastSyncStatus).toBe('ok');
  });

  it('block cursor stays put on RPC error', async () => {
    await seedHotWallet();

    // Seed an initial cursor
    await testPrisma.syncState.create({
      data: {
        chain: 'base:discovery',
        lastBlock: '500000',
        lastSyncStatus: 'ok',
        syncCount: 1,
      },
    });

    // Mock fetch: blockNumber succeeds, getLogs returns error
    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts?: any) => {
      if (opts?.body) {
        const body = JSON.parse(opts.body);
        if (body.method === 'eth_blockNumber') {
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x100000' }) };
        }
        if (body.method === 'eth_getLogs') {
          return {
            ok: true,
            json: async () => ({
              jsonrpc: '2.0', id: body.id,
              error: { code: -32000, message: 'rate limited' },
            }),
          };
        }
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    // Cursor should NOT have advanced
    const syncState = await testPrisma.syncState.findUnique({
      where: { chain: 'base:discovery' },
    });
    expect(syncState!.lastBlock).toBe('500000');
    expect(syncState!.lastSyncStatus).toBe('error');
  });

  it('first run defaults to latestBlock - max_initial_lookback', async () => {
    await seedHotWallet();

    const latestBlock = 1048576; // 0x100000
    const defaultLookback = 2000; // use default

    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts?: any) => {
      if (opts?.body) {
        const body = JSON.parse(opts.body);
        if (body.method === 'eth_blockNumber') {
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x100000' }) };
        }
        if (body.method === 'eth_getLogs') {
          // Verify the fromBlock is latestBlock - lookback
          const params = body.params[0];
          const fromBlock = parseInt(params.fromBlock, 16);
          // max_initial_lookback default is 302400
          expect(fromBlock).toBe(latestBlock - 302400);

          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: [] }) };
        }
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    // Verify eth_getLogs was called
    expect(mockFetch).toHaveBeenCalledTimes(2); // eth_blockNumber + eth_getLogs
  });

  it('resumes from SyncState.lastBlock on subsequent runs', async () => {
    await seedHotWallet();

    // Seed cursor at block 900000
    await testPrisma.syncState.create({
      data: {
        chain: 'base:discovery',
        lastBlock: '900000',
        lastSyncStatus: 'ok',
        syncCount: 5,
      },
    });

    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts?: any) => {
      if (opts?.body) {
        const body = JSON.parse(opts.body);
        if (body.method === 'eth_blockNumber') {
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x100000' }) };
        }
        if (body.method === 'eth_getLogs') {
          const params = body.params[0];
          const fromBlock = parseInt(params.fromBlock, 16);
          // Should start from 900001 (lastBlock + 1)
          expect(fromBlock).toBe(900001);

          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: [] }) };
        }
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses separate SyncState key from balance-sync', async () => {
    await seedHotWallet();

    // Seed balance-sync state (should not interfere)
    await testPrisma.syncState.create({
      data: {
        chain: 'base',
        lastSyncStatus: 'ok',
        syncCount: 100,
      },
    });

    const mockFetch = buildMockFetch([], '0x100000');
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    // Discovery uses "base:discovery" key
    const discoveryState = await testPrisma.syncState.findUnique({
      where: { chain: 'base:discovery' },
    });
    expect(discoveryState).not.toBeNull();

    // Balance-sync state untouched
    const balanceState = await testPrisma.syncState.findUnique({
      where: { chain: 'base' },
    });
    expect(balanceState!.syncCount).toBe(100);
  });

  it('per-chain error isolation — one chain failing does not block others', async () => {
    // Seed wallets on two chains
    await seedHotWallet(WALLET_ADDRESS, 'base');
    await seedHotWallet('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'ethereum');

    // Base fails, ethereum succeeds
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (_url: string, opts?: any) => {
      if (opts?.body) {
        const body = JSON.parse(opts.body);
        if (body.method === 'eth_blockNumber') {
          callCount++;
          if (callCount === 1) {
            // First chain (base) — throw
            throw new Error('RPC down');
          }
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x100000' }) };
        }
        if (body.method === 'eth_getLogs') {
          return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: [] }) };
        }
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    // One chain should have error state
    const states = await testPrisma.syncState.findMany({
      where: { chain: { endsWith: ':discovery' } },
    });

    // At least one succeeded (ethereum)
    const okState = states.find((s) => s.lastSyncStatus === 'ok');
    expect(okState).toBeDefined();
  });

  it('token with high sell tax fails safety gate', async () => {
    await seedHotWallet();

    const logs = [buildTransferLog()];
    const mockFetch = buildMockFetch(logs, '0x100000');
    vi.stubGlobal('fetch', mockFetch);

    vi.mocked(resolveTokenMetadataBatch).mockResolvedValue(
      new Map([[USDC_ADDRESS, { address: USDC_ADDRESS, symbol: 'TAX', name: 'Tax Token', decimals: 6 }]])
    );
    vi.mocked(getTokenPrice).mockResolvedValue({ priceUsd: '10.0', source: 'dexscreener', cached: false });
    vi.mocked(searchTokens).mockResolvedValue([{
      address: USDC_ADDRESS, chain: 'base', symbol: 'TAX', name: 'Tax Token',
      priceUsd: '10.0', liquidity: 5000, volume24h: 1000, marketCap: null, fdv: null,
      imageUrl: null, websites: [], socials: [], dexId: 'uniswap', pairAddress: '0xpool',
    }]);
    vi.mocked(getTokenSafety).mockResolvedValue({
      tokenName: 'Tax Token', tokenSymbol: 'TAX', totalSupply: '1000000',
      isHoneypot: false, isMintable: false, isOpenSource: true, isProxy: false,
      isBlacklisted: false, isAntiWhale: false, hasHiddenOwner: false, hasExternalCall: false,
      hasSelfDestruct: false, canTakeBackOwnership: false, transferPausable: false,
      buyTax: '0', sellTax: '55', // > 50% sell tax
      ownerAddress: '', creatorAddress: '', creatorPercent: '0',
      holderCount: 10, holders: [], lpHolderCount: 1, lpTotalSupply: '100', lpHolders: [], dexInfo: [],
    });

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    const count = await testPrisma.trackedAsset.count();
    expect(count).toBe(0);
  });

  it('no price data → token skipped', async () => {
    await seedHotWallet();

    const logs = [buildTransferLog()];
    const mockFetch = buildMockFetch(logs, '0x100000');
    vi.stubGlobal('fetch', mockFetch);

    vi.mocked(resolveTokenMetadataBatch).mockResolvedValue(
      new Map([[USDC_ADDRESS, { address: USDC_ADDRESS, symbol: 'NOPR', name: 'No Price', decimals: 6 }]])
    );
    vi.mocked(getTokenPrice).mockResolvedValue(null);

    const ctx = createMockContext();
    await incomingScanJob.run(ctx);

    const count = await testPrisma.trackedAsset.count();
    expect(count).toBe(0);
  });
});
