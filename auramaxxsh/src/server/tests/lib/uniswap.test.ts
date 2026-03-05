/**
 * Tests for Uniswap V4 Pool Detection
 *
 * Tests:
 * - getV4PoolKey() with known hooks, no hook, unknown hooks
 * - detectV4PoolFromEvents() with mocked provider
 * - detectPool() V4 integration
 * - getRpcUrlSync() helper
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import {
  getV4PoolKey,
  getKnownV4Hooks,
  getV4NoHookPoolKeys,
  detectV4PoolFromEvents,
  WETH,
} from '../../lib/dex/uniswap';
import { getRpcUrlSync } from '../../lib/config';

// Mock token addresses for testing
const TEST_TOKEN_LOW = '0x0000000000000000000000000000000000001234'; // Lower than WETH
const TEST_TOKEN_HIGH = '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF1234'; // Higher than WETH

describe('Uniswap V4 Pool Detection', () => {
  describe('getV4PoolKey()', () => {
    it('should return poolKey for known hooks (clanker)', () => {
      const poolKey = getV4PoolKey(TEST_TOKEN_HIGH, 'clanker');

      expect(poolKey).not.toBeNull();
      expect(poolKey?.hooks).toBe('0x1F98400000000000000000000000000000000004');
      expect(poolKey?.fee).toBe(10000); // 1%
      expect(poolKey?.tickSpacing).toBe(200);
    });

    it('should return poolKey for clanker-static-fee-v2', () => {
      const poolKey = getV4PoolKey(TEST_TOKEN_HIGH, 'clanker-static-fee-v2');

      expect(poolKey).not.toBeNull();
      expect(poolKey?.hooks).toBe('0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC');
      // Dynamic fee flag = 0x800000
      expect(poolKey?.fee).toBe(0x800000);
      expect(poolKey?.tickSpacing).toBe(200);
    });

    it('should return poolKey for clanker-dynamic-fee-v2', () => {
      const poolKey = getV4PoolKey(TEST_TOKEN_HIGH, 'clanker-dynamic-fee-v2');

      expect(poolKey).not.toBeNull();
      expect(poolKey?.hooks).toBe('0xd60D6B218116cFd801E28F78d011a203D2b068Cc');
      expect(poolKey?.fee).toBe(0x800000); // Dynamic fee flag
    });

    it('should return poolKey with zero address for hook: "none"', () => {
      const poolKey = getV4PoolKey(TEST_TOKEN_HIGH, 'none');

      expect(poolKey).not.toBeNull();
      expect(poolKey?.hooks).toBe(ethers.ZeroAddress);
      expect(poolKey?.fee).toBe(3000); // Default 0.3%
      expect(poolKey?.tickSpacing).toBe(60);
    });

    it('should return null for unknown hook name', () => {
      const poolKey = getV4PoolKey(TEST_TOKEN_HIGH, 'unknown-hook');

      expect(poolKey).toBeNull();
    });

    it('should return null when no hook name provided', () => {
      const poolKey = getV4PoolKey(TEST_TOKEN_HIGH);

      expect(poolKey).toBeNull();
    });

    it('should order currency0/currency1 correctly (lower address first)', () => {
      // Token lower than WETH
      const poolKeyLow = getV4PoolKey(TEST_TOKEN_LOW, 'clanker');
      expect(poolKeyLow?.currency0).toBe(TEST_TOKEN_LOW);
      expect(poolKeyLow?.currency1).toBe(WETH);

      // Token higher than WETH
      const poolKeyHigh = getV4PoolKey(TEST_TOKEN_HIGH, 'clanker');
      expect(poolKeyHigh?.currency0).toBe(WETH);
      expect(poolKeyHigh?.currency1).toBe(TEST_TOKEN_HIGH);
    });

    it('should handle case-insensitive hook names', () => {
      const poolKey1 = getV4PoolKey(TEST_TOKEN_HIGH, 'CLANKER');
      const poolKey2 = getV4PoolKey(TEST_TOKEN_HIGH, 'Clanker');
      const poolKey3 = getV4PoolKey(TEST_TOKEN_HIGH, 'clanker');

      expect(poolKey1).toEqual(poolKey3);
      expect(poolKey2).toEqual(poolKey3);
    });
  });

  describe('getKnownV4Hooks()', () => {
    it('should return array of hook names', () => {
      const hooks = getKnownV4Hooks();

      expect(Array.isArray(hooks)).toBe(true);
      expect(hooks.length).toBeGreaterThan(0);
      expect(hooks).toContain('clanker');
      expect(hooks).toContain('zora');
    });
  });

  describe('getV4NoHookPoolKeys()', () => {
    it('should return array of poolKeys with zero address hooks', () => {
      const poolKeys = getV4NoHookPoolKeys(TEST_TOKEN_HIGH);

      expect(Array.isArray(poolKeys)).toBe(true);
      expect(poolKeys.length).toBe(3); // 0.3%, 1%, 0.05%

      for (const poolKey of poolKeys) {
        expect(poolKey.hooks).toBe(ethers.ZeroAddress);
      }
    });

    it('should include common fee tiers', () => {
      const poolKeys = getV4NoHookPoolKeys(TEST_TOKEN_HIGH);

      const fees = poolKeys.map(pk => pk.fee);
      expect(fees).toContain(3000);  // 0.3%
      expect(fees).toContain(10000); // 1%
      expect(fees).toContain(500);   // 0.05%
    });

    it('should order currencies correctly', () => {
      const poolKeys = getV4NoHookPoolKeys(TEST_TOKEN_HIGH);

      for (const poolKey of poolKeys) {
        expect(poolKey.currency0).toBe(WETH);
        expect(poolKey.currency1).toBe(TEST_TOKEN_HIGH);
      }
    });
  });

  describe('detectV4PoolFromEvents()', () => {
    let mockProvider: ethers.Provider;

    beforeEach(() => {
      mockProvider = {
        getLogs: vi.fn(),
      } as unknown as ethers.Provider;
    });

    afterEach(() => {
      vi.resetAllMocks();
    });

    it('should find pool when token is currency0', async () => {
      const mockLog = createMockInitializeLog({
        currency0: TEST_TOKEN_LOW,
        currency1: WETH,
        fee: 3000,
        tickSpacing: 60,
        hooks: ethers.ZeroAddress,
      });

      vi.mocked(mockProvider.getLogs)
        .mockResolvedValueOnce([mockLog]) // currency0 query
        .mockResolvedValueOnce([]); // currency1 query

      const poolKey = await detectV4PoolFromEvents(TEST_TOKEN_LOW, mockProvider);

      expect(poolKey).not.toBeNull();
      expect(poolKey?.currency0).toBe(ethers.getAddress(TEST_TOKEN_LOW));
      expect(poolKey?.currency1).toBe(WETH);
      expect(poolKey?.fee).toBe(3000);
      expect(poolKey?.tickSpacing).toBe(60);
      expect(poolKey?.hooks).toBe(ethers.ZeroAddress);
    });

    it('should find pool when token is currency1', async () => {
      const mockLog = createMockInitializeLog({
        currency0: WETH,
        currency1: TEST_TOKEN_HIGH,
        fee: 10000,
        tickSpacing: 200,
        hooks: '0x1F98400000000000000000000000000000000004', // clanker hook
      });

      vi.mocked(mockProvider.getLogs)
        .mockResolvedValueOnce([]) // currency0 query
        .mockResolvedValueOnce([mockLog]); // currency1 query

      const poolKey = await detectV4PoolFromEvents(TEST_TOKEN_HIGH, mockProvider);

      expect(poolKey).not.toBeNull();
      expect(poolKey?.currency0).toBe(WETH);
      expect(poolKey?.currency1).toBe(ethers.getAddress(TEST_TOKEN_HIGH));
      expect(poolKey?.fee).toBe(10000);
      expect(poolKey?.hooks).toBe('0x1F98400000000000000000000000000000000004');
    });

    it('should return null when no Initialize events found', async () => {
      vi.mocked(mockProvider.getLogs)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const poolKey = await detectV4PoolFromEvents(TEST_TOKEN_HIGH, mockProvider);

      expect(poolKey).toBeNull();
    });

    it('should correctly decode fee, tickSpacing, hooks from event data', async () => {
      const testFee = 500;
      const testTickSpacing = 10;
      const testHooks = '0xd60D6B218116cFd801E28F78d011a203D2b068Cc';

      const mockLog = createMockInitializeLog({
        currency0: TEST_TOKEN_LOW,
        currency1: WETH,
        fee: testFee,
        tickSpacing: testTickSpacing,
        hooks: testHooks,
      });

      vi.mocked(mockProvider.getLogs)
        .mockResolvedValueOnce([mockLog])
        .mockResolvedValueOnce([]);

      const poolKey = await detectV4PoolFromEvents(TEST_TOKEN_LOW, mockProvider);

      expect(poolKey?.fee).toBe(testFee);
      expect(poolKey?.tickSpacing).toBe(testTickSpacing);
      expect(poolKey?.hooks).toBe(testHooks);
    });

    it('should handle RPC errors gracefully', async () => {
      vi.mocked(mockProvider.getLogs).mockRejectedValue(new Error('RPC error'));

      const poolKey = await detectV4PoolFromEvents(TEST_TOKEN_HIGH, mockProvider);

      expect(poolKey).toBeNull();
    });
  });
});

describe('getRpcUrlSync()', () => {
  it('should return configured RPC for known chain (base)', () => {
    const rpc = getRpcUrlSync('base');

    expect(rpc).toBeDefined();
    expect(typeof rpc).toBe('string');
    expect(rpc).toContain('base');
  });

  it('should return configured RPC for known chain (ethereum)', () => {
    const rpc = getRpcUrlSync('ethereum');

    expect(rpc).toBeDefined();
    expect(typeof rpc).toBe('string');
  });

  it('should return fallback RPC for unknown chain', () => {
    const rpc = getRpcUrlSync('unknown-chain-xyz');

    // Falls back to base RPC
    expect(rpc).toBeDefined();
    expect(typeof rpc).toBe('string');
  });

  it('should return public fallback for chains with public RPCs', () => {
    // Even if not in config, should have public fallbacks
    const rpc = getRpcUrlSync('arbitrum');

    // Should return arbitrum public RPC
    expect(typeof rpc).toBe('string');
    expect(rpc).toContain('arbitrum');
  });
});

// Helper function to create mock Initialize event logs
function createMockInitializeLog(params: {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}): ethers.Log {
  const INITIALIZE_EVENT_TOPIC = '0x803151a295203f64f7e2ca2db584660e99eaf67eca6f05af1bf0707e7d38f2cf';

  // Create properly formatted indexed topics
  const poolId = ethers.keccak256(ethers.toUtf8Bytes('mock-pool-id'));
  const currency0Padded = ethers.zeroPadValue(params.currency0.toLowerCase(), 32);
  const currency1Padded = ethers.zeroPadValue(params.currency1.toLowerCase(), 32);

  // Encode data field: fee (uint24), tickSpacing (int24), hooks (address), sqrtPriceX96 (uint160), tick (int24)
  const data = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint24', 'int24', 'address', 'uint160', 'int24'],
    [params.fee, params.tickSpacing, params.hooks, BigInt('79228162514264337593543950336'), 0]
  );

  return {
    blockNumber: 1000000,
    blockHash: '0x' + '0'.repeat(64),
    transactionIndex: 0,
    removed: false,
    address: '0x6Ab04E3376fB1d12cC0b27E6F2E7485CC8bFCb53', // Pool Manager
    data,
    topics: [INITIALIZE_EVENT_TOPIC, poolId, currency0Padded, currency1Padded],
    transactionHash: '0x' + '1'.repeat(64),
    index: 0,
  } as unknown as ethers.Log;
}
