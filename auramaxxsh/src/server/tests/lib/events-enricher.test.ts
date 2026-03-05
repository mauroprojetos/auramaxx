/**
 * Tests for server/lib/txhistory/enricher.ts
 * Tests metadata resolution and event enrichment with mocked dependencies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DecodedEvent } from '../../lib/txhistory/decoder';

// Mock prisma before importing enricher
vi.mock('../../lib/db', () => ({
  prisma: {
    tokenMetadata: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    poolMetadata: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

// Mock config
vi.mock('../../lib/config', () => ({
  getRpcUrl: vi.fn().mockResolvedValue('https://mock-rpc.test'),
}));

// Mock viem
const mockMulticall = vi.fn();
const mockGetLogs = vi.fn().mockResolvedValue([]);
vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    createPublicClient: () => ({
      multicall: mockMulticall,
      getLogs: mockGetLogs,
    }),
    http: () => ({}),
  };
});

// Mock fetch for DexScreener
const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: false }) as any;
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.clearAllMocks();
});

import { resolveTokenMetadataBatch, enrichEvents } from '../../lib/txhistory/enricher';
import { prisma } from '../../lib/db';

describe('resolveTokenMetadataBatch', () => {
  it('should return cached tokens from DB', async () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    (prisma.tokenMetadata.findMany as any).mockResolvedValueOnce([
      { tokenAddress: addr, chain: 'base', symbol: 'TEST', name: 'Test Token', decimals: 18, icon: null },
    ]);

    const result = await resolveTokenMetadataBatch([addr], 'base');
    expect(result.size).toBe(1);
    expect(result.get(addr)?.symbol).toBe('TEST');
    expect(result.get(addr)?.decimals).toBe(18);
  });

  it('should fall back to multicall for cache misses', async () => {
    const addr = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    (prisma.tokenMetadata.findMany as any).mockResolvedValueOnce([]);

    mockMulticall.mockResolvedValueOnce([
      { status: 'success', result: 'MOCK' },   // symbol
      { status: 'success', result: 'Mock Token' }, // name
      { status: 'success', result: 6 },           // decimals
    ]);

    const result = await resolveTokenMetadataBatch([addr], 'base');
    expect(result.size).toBe(1);
    expect(result.get(addr)?.symbol).toBe('MOCK');
    expect(result.get(addr)?.name).toBe('Mock Token');
    expect(result.get(addr)?.decimals).toBe(6);
  });

  it('should handle multicall failures gracefully', async () => {
    const addr = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    (prisma.tokenMetadata.findMany as any).mockResolvedValueOnce([]);

    mockMulticall.mockResolvedValueOnce([
      { status: 'failure' },
      { status: 'failure' },
      { status: 'failure' },
    ]);

    const result = await resolveTokenMetadataBatch([addr], 'base');
    expect(result.get(addr)?.symbol).toBe('UNKNOWN');
    expect(result.get(addr)?.decimals).toBe(18);
  });

  it('should return empty map for empty input', async () => {
    const result = await resolveTokenMetadataBatch([], 'base');
    expect(result.size).toBe(0);
  });

  it('should deduplicate addresses', async () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    (prisma.tokenMetadata.findMany as any).mockResolvedValueOnce([
      { tokenAddress: addr, chain: 'base', symbol: 'DUP', name: 'Dup', decimals: 18, icon: null },
    ]);

    const result = await resolveTokenMetadataBatch([addr, addr, addr], 'base');
    expect(result.size).toBe(1);
  });
});

describe('enrichEvents', () => {
  beforeEach(() => {
    // Reset mocks for each test
    (prisma.tokenMetadata.findMany as any).mockResolvedValue([]);
    (prisma.poolMetadata.findUnique as any).mockResolvedValue(null);
    mockMulticall.mockResolvedValue([]);
  });

  it('should enrich incoming transfer', async () => {
    const queryAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const tokenAddr = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    // Mock token resolution
    (prisma.tokenMetadata.findMany as any).mockResolvedValueOnce([
      { tokenAddress: tokenAddr, chain: 'base', symbol: 'USDC', name: 'USD Coin', decimals: 6, icon: null },
    ]);

    const events: DecodedEvent[] = [{
      type: 'transfer',
      txHash: '0x' + 'ab'.repeat(32),
      logIndex: 0,
      blockNumber: 100000n,
      contractAddress: tokenAddr,
      params: {
        from: '0xcccccccccccccccccccccccccccccccccccccccc',
        to: queryAddr,
        amount: 500000000n, // 500 USDC
      },
    }];

    const result = await enrichEvents(events, queryAddr, 'base');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('transfer');
    expect(result[0].summary).toContain('Received');
    expect(result[0].summary).toContain('500');
    expect(result[0].summary).toContain('USDC');
    expect(result[0].details.direction).toBe('in');
  });

  it('should enrich outgoing transfer', async () => {
    const queryAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const tokenAddr = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    (prisma.tokenMetadata.findMany as any).mockResolvedValueOnce([
      { tokenAddress: tokenAddr, chain: 'base', symbol: 'WETH', name: 'Wrapped ETH', decimals: 18, icon: null },
    ]);

    const events: DecodedEvent[] = [{
      type: 'transfer',
      txHash: '0x' + 'ab'.repeat(32),
      logIndex: 0,
      blockNumber: 100000n,
      contractAddress: tokenAddr,
      params: {
        from: queryAddr,
        to: '0xcccccccccccccccccccccccccccccccccccccccc',
        amount: 1500000000000000000n, // 1.5 WETH
      },
    }];

    const result = await enrichEvents(events, queryAddr, 'base');
    expect(result).toHaveLength(1);
    expect(result[0].summary).toContain('Sent');
    expect(result[0].summary).toContain('1.5');
    expect(result[0].summary).toContain('WETH');
    expect(result[0].details.direction).toBe('out');
  });

  it('should enrich WETH deposit as wrap', async () => {
    const queryAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const events: DecodedEvent[] = [{
      type: 'weth_deposit',
      txHash: '0x' + 'ab'.repeat(32),
      logIndex: 0,
      blockNumber: 100000n,
      contractAddress: '0x4200000000000000000000000000000000000006',
      params: { dst: queryAddr, wad: 2000000000000000000n },
    }];

    const result = await enrichEvents(events, queryAddr, 'base');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('wrap');
    expect(result[0].summary).toContain('Wrapped');
    expect(result[0].summary).toContain('2');
    expect(result[0].summary).toContain('ETH');
  });

  it('should enrich WETH withdrawal as unwrap', async () => {
    const queryAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const events: DecodedEvent[] = [{
      type: 'weth_withdrawal',
      txHash: '0x' + 'ab'.repeat(32),
      logIndex: 0,
      blockNumber: 100000n,
      contractAddress: '0x4200000000000000000000000000000000000006',
      params: { src: queryAddr, wad: 1000000000000000000n },
    }];

    const result = await enrichEvents(events, queryAddr, 'base');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unwrap');
    expect(result[0].summary).toContain('Unwrapped');
    expect(result[0].summary).toContain('1');
    expect(result[0].summary).toContain('WETH');
  });

  it('should enrich approval', async () => {
    const queryAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const tokenAddr = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const spender = '0xcccccccccccccccccccccccccccccccccccccccc';

    (prisma.tokenMetadata.findMany as any).mockResolvedValueOnce([
      { tokenAddress: tokenAddr, chain: 'base', symbol: 'USDC', name: 'USD Coin', decimals: 6, icon: null },
    ]);

    const events: DecodedEvent[] = [{
      type: 'approval',
      txHash: '0x' + 'ab'.repeat(32),
      logIndex: 0,
      blockNumber: 100000n,
      contractAddress: tokenAddr,
      params: { owner: queryAddr, spender, amount: 115792089237316195423570985008687907853269984665640564039457584007913129639935n },
    }];

    const result = await enrichEvents(events, queryAddr, 'base');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('approval');
    expect(result[0].summary).toContain('Approved');
    expect(result[0].summary).toContain('USDC');
  });

  it('should handle swap_v2 without pool metadata', async () => {
    const queryAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const poolAddr = '0xdddddddddddddddddddddddddddddddddddddd';

    const events: DecodedEvent[] = [{
      type: 'swap_v2',
      txHash: '0x' + 'ab'.repeat(32),
      logIndex: 0,
      blockNumber: 100000n,
      contractAddress: poolAddr,
      params: {
        sender: queryAddr,
        to: queryAddr,
        amount0In: 1000000n,
        amount1In: 0n,
        amount0Out: 0n,
        amount1Out: 500000n,
      },
    }];

    const result = await enrichEvents(events, queryAddr, 'base');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('swap_v2');
    expect(result[0].protocol).toBe('uniswap_v2');
    expect(result[0].summary).toContain('Swapped');
  });

  it('should handle unknown event types', async () => {
    const queryAddr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const events: DecodedEvent[] = [{
      type: 'unknown',
      txHash: '0x' + 'ab'.repeat(32),
      logIndex: 0,
      blockNumber: 100000n,
      contractAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      params: { topic0: '0xdeadbeef' },
    }];

    const result = await enrichEvents(events, queryAddr, 'base');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unknown');
    expect(result[0].summary).toContain('Unknown event');
  });
});
