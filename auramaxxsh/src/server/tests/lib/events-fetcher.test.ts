/**
 * Tests for server/lib/txhistory/index.ts
 * Tests log fetching logic: V4 swap correlation and token-level queries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma
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

// Mock viem — track all eth_getLogs RPC calls via client.request()
// rawGetLogs in index.ts uses client.request({ method: 'eth_getLogs', params: [...] })
// to bypass viem's getLogs which silently ignores raw topics arrays.
const mockGetLogs = vi.fn().mockResolvedValue([]);
const mockGetBlockNumber = vi.fn().mockResolvedValue(100000n);
const mockGetBlock = vi.fn().mockResolvedValue({ number: 100000n, timestamp: 1700000000n });
const mockMulticall = vi.fn().mockResolvedValue([]);
vi.mock('viem', async () => {
  const actual = await vi.importActual('viem');
  return {
    ...actual,
    createPublicClient: () => ({
      request: async (args: any) => {
        if (args.method === 'eth_getLogs') {
          // Delegate to mockGetLogs with the RPC params (address, topics, fromBlock, toBlock)
          return mockGetLogs(args.params[0]);
        }
        throw new Error(`Unexpected RPC method: ${args.method}`);
      },
      getBlockNumber: mockGetBlockNumber,
      getBlock: mockGetBlock,
      multicall: mockMulticall,
    }),
    http: () => ({}),
  };
});

// Mock fetch
const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({ ok: false }) as any;
  vi.clearAllMocks();
  mockGetBlockNumber.mockResolvedValue(100000n);
  mockGetBlock.mockResolvedValue({ number: 100000n, timestamp: 1700000000n });
  mockGetLogs.mockResolvedValue([]);
  mockMulticall.mockResolvedValue([]);
});

import { fetchAndDecodeEvents } from '../../lib/txhistory';
import { EVENT_SIGNATURES, KNOWN_CONTRACTS } from '../../lib/txhistory/signatures';

// Helper: build a fake raw log
function makeLog(overrides: {
  address?: string;
  topics: string[];
  data?: string;
  transactionHash: string;
  logIndex?: number;
  blockNumber?: bigint;
}) {
  return {
    address: overrides.address ?? '0x0000000000000000000000000000000000000000',
    topics: overrides.topics,
    data: overrides.data ?? '0x',
    transactionHash: overrides.transactionHash,
    logIndex: overrides.logIndex ?? 0,
    blockNumber: overrides.blockNumber ?? 99999n,
  };
}

/** Pad a 20-byte address to 32-byte topic */
function padAddr(addr: string): string {
  return '0x' + addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

// ERC-20 Transfer(address from, address to, uint256 amount)
function makeTransferLog(opts: {
  tokenAddress: string;
  from: string;
  to: string;
  amount: bigint;
  txHash: string;
  logIndex?: number;
  blockNumber?: bigint;
}) {
  const data = '0x' + opts.amount.toString(16).padStart(64, '0');
  return makeLog({
    address: opts.tokenAddress,
    topics: [EVENT_SIGNATURES.TRANSFER, padAddr(opts.from), padAddr(opts.to)],
    data,
    transactionHash: opts.txHash,
    logIndex: opts.logIndex ?? 0,
    blockNumber: opts.blockNumber ?? 99999n,
  });
}

// V4 Swap(bytes32 id, address sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
function makeV4SwapLog(opts: {
  poolId: string;
  sender: string;
  txHash: string;
  logIndex?: number;
  blockNumber?: bigint;
}) {
  // Encode: int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee
  const amount0 = 1000n;
  const amount1 = -500n;
  const sqrtPriceX96 = 79228162514264337593543950336n; // ~1.0
  const liquidity = 1000000n;
  const tick = 0n;
  const fee = 3000n;

  // Properly ABI-encode the data params (6 values, 192 bytes)
  const encode = (val: bigint, bits: number): string => {
    if (val < 0n) {
      // Two's complement for signed
      const mask = (1n << BigInt(bits)) - 1n;
      val = ((1n << 256n) + val) & ((1n << 256n) - 1n);
    }
    return val.toString(16).padStart(64, '0');
  };

  const data = '0x' +
    encode(amount0, 128) +
    encode(amount1, 128) +
    encode(sqrtPriceX96, 160) +
    encode(liquidity, 128) +
    encode(tick, 24) +
    encode(fee, 24);

  const pmAddr = KNOWN_CONTRACTS.base?.v4PoolManager ?? '0x6Ab04E3376fB1d12cC0b27E6F2E7485CC8bFCb53';

  return makeLog({
    address: pmAddr,
    topics: [EVENT_SIGNATURES.SWAP_V4, opts.poolId, padAddr(opts.sender)],
    data,
    transactionHash: opts.txHash,
    logIndex: opts.logIndex ?? 1,
    blockNumber: opts.blockNumber ?? 99999n,
  });
}

describe('fetchAndDecodeEvents', () => {
  describe('V4 swap correlation', () => {
    it('should discover V4 Swap events for orphan transfers', async () => {
      const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const tokenAddr = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const txHash = '0x' + 'ab'.repeat(32);
      const poolId = '0x' + 'cc'.repeat(32);
      const router = '0xdddddddddddddddddddddddddddddddddddddd';

      // Phase 1: wallet-level getLogs returns a Transfer (the ERC-20 movement from the swap)
      const transferLog = makeTransferLog({
        tokenAddress: tokenAddr,
        from: router,
        to: wallet,
        amount: 1000000n,
        txHash,
        blockNumber: 99999n,
      });

      // Phase 2: V4 correlation getLogs returns the V4 Swap in the same tx
      const v4SwapLog = makeV4SwapLog({
        poolId,
        sender: router,
        txHash,
        blockNumber: 99999n,
        logIndex: 2,
      });

      // mockGetLogs is called multiple times:
      // 1-3: wallet chunk queries (topic1, topic2, WETH) — return transfer on first
      // 4: V4 correlation query on PoolManager — return swap
      let callCount = 0;
      mockGetLogs.mockImplementation(async (args: any) => {
        callCount++;
        // Wallet chunk calls (first 3 for each chunk)
        if (callCount <= 3) {
          // Return transfer on the first query (topic1 match)
          return callCount === 1 ? [transferLog] : [];
        }
        // V4 correlation call — check it targets the PoolManager
        if (args.address?.toLowerCase() === KNOWN_CONTRACTS.base?.v4PoolManager?.toLowerCase()) {
          return [v4SwapLog];
        }
        return [];
      });

      const result = await fetchAndDecodeEvents({
        address: wallet,
        chain: 'base',
        fromBlock: 99990n,
        toBlock: 100000n,
        limit: 20,
      });

      // Should contain both the transfer AND the discovered V4 swap
      const types = result.transactions.map(t => t.type);
      expect(types).toContain('transfer');
      // V4 swap should be enriched (type becomes 'swap' or 'swap_v4' depending on pool resolution)
      const hasSwap = result.transactions.some(t => t.type === 'swap' || t.type === 'swap_v4');
      expect(hasSwap).toBe(true);
    });

    it('should NOT query V4 swaps when transfers already have matching swaps', async () => {
      const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const tokenAddr = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const poolAddr = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      const txHash = '0x' + 'ab'.repeat(32);

      // Transfer + V2 Swap in the same tx (V2 works fine with topic matching)
      const transferLog = makeTransferLog({
        tokenAddress: tokenAddr,
        from: '0xcccccccccccccccccccccccccccccccccccccccc',
        to: wallet,
        amount: 1000000n,
        txHash,
      });

      // V2 Swap log
      const v2SwapLog = makeLog({
        address: poolAddr,
        topics: [
          EVENT_SIGNATURES.SWAP_V2,
          padAddr('0xcccccccccccccccccccccccccccccccccccccccc'),
          padAddr(wallet),
        ],
        data: '0x' +
          (1000000n).toString(16).padStart(64, '0') +
          (0n).toString(16).padStart(64, '0') +
          (0n).toString(16).padStart(64, '0') +
          (500000n).toString(16).padStart(64, '0'),
        transactionHash: txHash,
        logIndex: 1,
      });

      let v4QueryMade = false;
      mockGetLogs.mockImplementation(async (args: any) => {
        if (args.address?.toLowerCase() === KNOWN_CONTRACTS.base?.v4PoolManager?.toLowerCase()) {
          v4QueryMade = true;
          return [];
        }
        // Return both transfer and swap on wallet queries
        if (args.topics?.[1] || args.topics?.[2]) {
          return [transferLog, v2SwapLog];
        }
        return [];
      });

      await fetchAndDecodeEvents({
        address: wallet,
        chain: 'base',
        fromBlock: 99990n,
        toBlock: 100000n,
        limit: 20,
      });

      // V4 query should NOT have been made since all transfers have matching swaps
      expect(v4QueryMade).toBe(false);
    });

    it('should exclude V4 Swaps from unrelated transactions', async () => {
      const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const tokenAddr = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const txHash1 = '0x' + 'a1'.repeat(32); // wallet's tx
      const txHash2 = '0x' + 'b2'.repeat(32); // unrelated tx
      const poolId = '0x' + 'cc'.repeat(32);

      const transferLog = makeTransferLog({
        tokenAddress: tokenAddr,
        from: '0xcccccccccccccccccccccccccccccccccccccccc',
        to: wallet,
        amount: 1000000n,
        txHash: txHash1,
        blockNumber: 99999n,
      });

      // V4 Swap in a DIFFERENT tx at the same block
      const v4SwapUnrelated = makeV4SwapLog({
        poolId,
        sender: '0xdddddddddddddddddddddddddddddddddddddd',
        txHash: txHash2,
        blockNumber: 99999n,
        logIndex: 5,
      });

      let callCount = 0;
      mockGetLogs.mockImplementation(async (args: any) => {
        callCount++;
        if (callCount <= 3) {
          return callCount === 1 ? [transferLog] : [];
        }
        // V4 query returns an unrelated swap
        if (args.address?.toLowerCase() === KNOWN_CONTRACTS.base?.v4PoolManager?.toLowerCase()) {
          return [v4SwapUnrelated];
        }
        return [];
      });

      const result = await fetchAndDecodeEvents({
        address: wallet,
        chain: 'base',
        fromBlock: 99990n,
        toBlock: 100000n,
        limit: 20,
      });

      // Should only have the transfer, not the unrelated V4 swap
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].type).toBe('transfer');
    });
  });

  describe('token-level queries', () => {
    it('should use address field instead of topic positions for token queries', async () => {
      const tokenAddr = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const txHash = '0x' + 'ab'.repeat(32);

      const transferLog = makeTransferLog({
        tokenAddress: tokenAddr,
        from: '0xcccccccccccccccccccccccccccccccccccccccc',
        to: '0xdddddddddddddddddddddddddddddddddddddd',
        amount: 5000000n,
        txHash,
      });

      mockGetLogs.mockImplementation(async (args: any) => {
        // Token mode: should query with address field set to the token contract
        if (args.address?.toLowerCase() === tokenAddr.toLowerCase()) {
          return [transferLog];
        }
        return [];
      });

      const result = await fetchAndDecodeEvents({
        address: tokenAddr,
        chain: 'base',
        tokenAddress: tokenAddr,
        fromBlock: 99990n,
        toBlock: 100000n,
        limit: 20,
      });

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].type).toBe('transfer');

      // Verify getLogs was called with address field (token mode), not topic-based wallet queries
      const calls = mockGetLogs.mock.calls;
      // In token mode, we should have a single getLogs call per chunk with the address field
      const tokenCalls = calls.filter(
        (c: any[]) => c[0]?.address?.toLowerCase() === tokenAddr.toLowerCase(),
      );
      expect(tokenCalls.length).toBeGreaterThan(0);
    });

    it('should NOT run V4 correlation for token queries', async () => {
      const tokenAddr = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const txHash = '0x' + 'ab'.repeat(32);

      const transferLog = makeTransferLog({
        tokenAddress: tokenAddr,
        from: '0xcccccccccccccccccccccccccccccccccccccccc',
        to: '0xdddddddddddddddddddddddddddddddddddddd',
        amount: 5000000n,
        txHash,
      });

      let v4QueryMade = false;
      mockGetLogs.mockImplementation(async (args: any) => {
        if (args.address?.toLowerCase() === KNOWN_CONTRACTS.base?.v4PoolManager?.toLowerCase()) {
          v4QueryMade = true;
          return [];
        }
        if (args.address?.toLowerCase() === tokenAddr.toLowerCase()) {
          return [transferLog];
        }
        return [];
      });

      await fetchAndDecodeEvents({
        address: tokenAddr,
        chain: 'base',
        tokenAddress: tokenAddr,
        fromBlock: 99990n,
        toBlock: 100000n,
        limit: 20,
      });

      expect(v4QueryMade).toBe(false);
    });
  });

  describe('backward compatibility', () => {
    it('should work with wallet queries without tokenAddress', async () => {
      const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      // No logs returned — should still work without error
      mockGetLogs.mockResolvedValue([]);

      const result = await fetchAndDecodeEvents({
        address: wallet,
        chain: 'base',
        fromBlock: 99990n,
        toBlock: 100000n,
        limit: 20,
      });

      expect(result.transactions).toEqual([]);
      expect(result.blockRange.from).toBe('99990');
      expect(result.blockRange.to).toBe('100000');
    });

    it('should use topic-based matching for wallet queries', async () => {
      const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const paddedWallet = padAddr(wallet);

      mockGetLogs.mockResolvedValue([]);

      await fetchAndDecodeEvents({
        address: wallet,
        chain: 'base',
        fromBlock: 99990n,
        toBlock: 100000n,
        limit: 20,
      });

      // Should have made topic-based calls (3 per chunk: topic1, topic2, WETH)
      const calls = mockGetLogs.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(3);

      // First call should have paddedWallet in topics[1]
      const firstCall = calls[0][0];
      expect(firstCall.topics[1]).toBe(paddedWallet);

      // Second call should have null in topics[1] and paddedWallet in topics[2]
      const secondCall = calls[1][0];
      expect(secondCall.topics[1]).toBeNull();
      expect(secondCall.topics[2]).toBe(paddedWallet);
    });
  });

  describe('types filter (topic0 filtering)', () => {
    it('should pass only Transfer topic0 when types=transfer', async () => {
      const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      mockGetLogs.mockResolvedValue([]);

      await fetchAndDecodeEvents({
        address: wallet,
        chain: 'base',
        fromBlock: 99990n,
        toBlock: 100000n,
        limit: 20,
        types: ['transfer'],
      });

      const calls = mockGetLogs.mock.calls;
      // First two calls are topic1 and topic2 wallet queries — check topic0 filter
      const firstCall = calls[0][0];
      expect(firstCall.topics[0]).toEqual([EVENT_SIGNATURES.TRANSFER]);
    });

    it('should include Transfer topic0 alongside swap topic0s when types=swap (for V4 correlation)', async () => {
      const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      mockGetLogs.mockResolvedValue([]);

      await fetchAndDecodeEvents({
        address: wallet,
        chain: 'base',
        fromBlock: 99990n,
        toBlock: 100000n,
        limit: 20,
        types: ['swap'],
      });

      const calls = mockGetLogs.mock.calls;
      const firstCall = calls[0][0];
      const topic0 = firstCall.topics[0];
      expect(topic0).toContain(EVENT_SIGNATURES.SWAP_V2);
      expect(topic0).toContain(EVENT_SIGNATURES.SWAP_V3);
      expect(topic0).toContain(EVENT_SIGNATURES.SWAP_V4);
      // Transfer is included so V4 correlation can find orphan transfers
      expect(topic0).toContain(EVENT_SIGNATURES.TRANSFER);
    });

    it('should find V4 swaps via correlation when types=swap and filter out transfers', async () => {
      const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const tokenAddr = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const txHash = '0x' + 'ab'.repeat(32);
      const poolId = '0x' + 'cc'.repeat(32);
      const router = '0xdddddddddddddddddddddddddddddddddddddd';

      const transferLog = makeTransferLog({
        tokenAddress: tokenAddr,
        from: router,
        to: wallet,
        amount: 1000000n,
        txHash,
        blockNumber: 99999n,
      });

      const v4SwapLog = makeV4SwapLog({
        poolId,
        sender: router,
        txHash,
        blockNumber: 99999n,
        logIndex: 2,
      });

      let callCount = 0;
      mockGetLogs.mockImplementation(async (args: any) => {
        callCount++;
        if (callCount <= 3) {
          return callCount === 1 ? [transferLog] : [];
        }
        if (args.address?.toLowerCase() === KNOWN_CONTRACTS.base?.v4PoolManager?.toLowerCase()) {
          return [v4SwapLog];
        }
        return [];
      });

      const result = await fetchAndDecodeEvents({
        address: wallet,
        chain: 'base',
        fromBlock: 99990n,
        toBlock: 100000n,
        limit: 20,
        types: ['swap'],
      });

      // Should contain the V4 swap but NOT the transfer (filtered out by types)
      const types = result.transactions.map(t => t.type);
      expect(types.some(t => t === 'swap' || t === 'swap_v4')).toBe(true);
      expect(types).not.toContain('transfer');
    });

    it('should pass all topic0s when no types filter', async () => {
      const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      mockGetLogs.mockResolvedValue([]);

      await fetchAndDecodeEvents({
        address: wallet,
        chain: 'base',
        fromBlock: 99990n,
        toBlock: 100000n,
        limit: 20,
      });

      const calls = mockGetLogs.mock.calls;
      const firstCall = calls[0][0];
      const topic0 = firstCall.topics[0];
      // Should contain all event signatures
      expect(topic0).toContain(EVENT_SIGNATURES.TRANSFER);
      expect(topic0).toContain(EVENT_SIGNATURES.SWAP_V2);
      expect(topic0).toContain(EVENT_SIGNATURES.SWAP_V3);
      expect(topic0).toContain(EVENT_SIGNATURES.SWAP_V4);
    });
  });
});
