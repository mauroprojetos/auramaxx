/**
 * Tests for Relay Adapter
 *
 * Tests:
 * - supportsChain() for major EVM chains and unsupported chains
 * - detectPool() always returns synthetic pool info
 * - getRouterAddress() returns 'relay'
 * - buildSwapTx() with mocked fetch (buy and sell directions, amounts in wei)
 * - buildSwapTx() error handling for API failures
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';

// Mock defaults module before importing relay
vi.mock('../../lib/defaults', () => ({
  getDefaultSync: vi.fn((_key: string, fallback: unknown) => fallback),
}));

import { relayAdapter } from '../../lib/dex/relay';
import { eth } from '../helpers/amounts';

// Mock fetch globally
const originalFetch = globalThis.fetch;

function mockFetchResponse(body: object, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

function mockFetchError(status: number, errorText: string) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => errorText,
  });
}

describe('Relay Adapter', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('supportsChain()', () => {
    it('should support Base (8453)', () => {
      expect(relayAdapter.supportsChain(8453)).toBe(true);
    });

    it('should support Ethereum (1)', () => {
      expect(relayAdapter.supportsChain(1)).toBe(true);
    });

    it('should support Arbitrum (42161)', () => {
      expect(relayAdapter.supportsChain(42161)).toBe(true);
    });

    it('should support Optimism (10)', () => {
      expect(relayAdapter.supportsChain(10)).toBe(true);
    });

    it('should support Polygon (137)', () => {
      expect(relayAdapter.supportsChain(137)).toBe(true);
    });

    it('should not support Solana (0)', () => {
      expect(relayAdapter.supportsChain(0)).toBe(false);
    });

    it('should not support unknown chain IDs', () => {
      expect(relayAdapter.supportsChain(99999)).toBe(false);
    });
  });

  describe('detectPool()', () => {
    it('should always return synthetic pool info', async () => {
      const mockProvider = {} as ethers.Provider;
      const pool = await relayAdapter.detectPool('0x' + '1'.repeat(40), mockProvider);

      expect(pool).not.toBeNull();
      expect(pool?.version).toBe('relay');
      expect(pool?.poolAddress).toBe('relay');
    });

    it('should return pool info regardless of token address', async () => {
      const mockProvider = {} as ethers.Provider;
      const pool = await relayAdapter.detectPool(ethers.ZeroAddress, mockProvider);

      expect(pool).not.toBeNull();
      expect(pool?.version).toBe('relay');
    });
  });

  describe('getRouterAddress()', () => {
    it('should return "relay"', () => {
      expect(relayAdapter.getRouterAddress()).toBe('relay');
    });
  });

  describe('name', () => {
    it('should be "relay"', () => {
      expect(relayAdapter.name).toBe('relay');
    });
  });

  describe('buildSwapTx()', () => {
    const TEST_FROM = '0x1234567890abcdef1234567890abcdef12345678';
    const TEST_TOKEN = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const RELAY_CONTRACT = '0x00000000000000447e69651d841bD8D104Bed493';

    function createMockRelayResponse(txData: {
      to: string;
      data: string;
      value: string;
    }) {
      return {
        steps: [
          {
            id: 'swap',
            kind: 'transaction',
            items: [
              {
                status: 'incomplete',
                data: {
                  from: TEST_FROM,
                  to: txData.to,
                  data: txData.data,
                  value: txData.value,
                  chainId: 8453,
                },
              },
            ],
          },
        ],
      };
    }

    it('should build buy transaction (ETH -> token)', async () => {
      const mockTxData = {
        to: RELAY_CONTRACT,
        data: '0xdeadbeef',
        value: '100000000000000000', // 0.1 ETH in wei
      };
      mockFetchResponse(createMockRelayResponse(mockTxData));

      const result = await relayAdapter.buildSwapTx({
        token: TEST_TOKEN,
        direction: 'buy',
        amount: eth('0.1'),
        minOut: '1000000',
        from: TEST_FROM,
        chainId: 8453,
      });

      expect(result.to).toBe(RELAY_CONTRACT);
      expect(result.data).toBe('0xdeadbeef');
      expect(result.value).toBe('100000000000000000');

      // Verify fetch was called with correct params
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[0]).toBe('https://api.relay.link/quote/v2');
      const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
      expect(body.user).toBe(TEST_FROM);
      expect(body.originChainId).toBe(8453);
      expect(body.destinationChainId).toBe(8453);
      expect(body.originCurrency).toBe('0x0000000000000000000000000000000000000000'); // Native ETH
      expect(body.destinationCurrency).toBe(TEST_TOKEN);
      expect(body.tradeType).toBe('EXACT_INPUT');
      expect(body.source).toBe('auramaxx');
      // App fees always included
      expect(body.appFees).toEqual([{ recipient: '0xa931533E0E0cCE34fc0FafB25ea2046d391eCAA5', fee: '100' }]);
    });

    it('should build sell transaction (token -> ETH)', async () => {
      const mockTxData = {
        to: RELAY_CONTRACT,
        data: '0xcafebabe',
        value: '0',
      };
      mockFetchResponse(createMockRelayResponse(mockTxData));

      const result = await relayAdapter.buildSwapTx({
        token: TEST_TOKEN,
        direction: 'sell',
        amount: '500000000000000000', // token amount in wei
        minOut: '90000000000000000',
        from: TEST_FROM,
        chainId: 8453,
      });

      expect(result.to).toBe(RELAY_CONTRACT);
      expect(result.data).toBe('0xcafebabe');
      expect(result.value).toBe('0');

      // Verify sell sends token as origin, ETH as destination
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
      expect(body.originCurrency).toBe(TEST_TOKEN);
      expect(body.destinationCurrency).toBe('0x0000000000000000000000000000000000000000');
    });

    it('should pass wei amount through for buy', async () => {
      mockFetchResponse(createMockRelayResponse({
        to: RELAY_CONTRACT,
        data: '0x',
        value: '0',
      }));

      await relayAdapter.buildSwapTx({
        token: TEST_TOKEN,
        direction: 'buy',
        amount: eth('1.5'),
        minOut: '0',
        from: TEST_FROM,
        chainId: 1,
      });

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
      expect(body.amount).toBe('1500000000000000000'); // 1.5 ETH in wei
    });

    it('should pass raw amount for sell (already in wei)', async () => {
      mockFetchResponse(createMockRelayResponse({
        to: RELAY_CONTRACT,
        data: '0x',
        value: '0',
      }));

      await relayAdapter.buildSwapTx({
        token: TEST_TOKEN,
        direction: 'sell',
        amount: '999000000',
        minOut: '0',
        from: TEST_FROM,
        chainId: 8453,
      });

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
      expect(body.amount).toBe('999000000');
    });

    it('should default value to "0" when not present in response', async () => {
      mockFetchResponse({
        steps: [
          {
            id: 'swap',
            kind: 'transaction',
            items: [
              {
                status: 'incomplete',
                data: {
                  from: TEST_FROM,
                  to: RELAY_CONTRACT,
                  data: '0xabc',
                  value: '',
                  chainId: 8453,
                },
              },
            ],
          },
        ],
      });

      const result = await relayAdapter.buildSwapTx({
        token: TEST_TOKEN,
        direction: 'buy',
        amount: eth('0.1'),
        minOut: '0',
        from: TEST_FROM,
        chainId: 8453,
      });

      expect(result.value).toBe('0');
    });

    it('should throw on API error', async () => {
      mockFetchError(400, 'Bad request: unsupported token');

      await expect(
        relayAdapter.buildSwapTx({
          token: TEST_TOKEN,
          direction: 'buy',
          amount: eth('0.1'),
          minOut: '0',
          from: TEST_FROM,
          chainId: 8453,
        })
      ).rejects.toThrow('Relay quote failed: 400');
    });

    it('should throw when no transaction steps returned', async () => {
      mockFetchResponse({ steps: [] });

      await expect(
        relayAdapter.buildSwapTx({
          token: TEST_TOKEN,
          direction: 'buy',
          amount: eth('0.1'),
          minOut: '0',
          from: TEST_FROM,
          chainId: 8453,
        })
      ).rejects.toThrow('Relay quote returned no executable transaction steps');
    });

    it('should skip signature steps and find transaction step', async () => {
      mockFetchResponse({
        steps: [
          {
            id: 'approve',
            kind: 'signature',
            items: [{ status: 'incomplete', data: { sign: {}, post: {} } }],
          },
          {
            id: 'swap',
            kind: 'transaction',
            items: [
              {
                status: 'incomplete',
                data: {
                  from: TEST_FROM,
                  to: RELAY_CONTRACT,
                  data: '0xfound',
                  value: '100',
                  chainId: 8453,
                },
              },
            ],
          },
        ],
      });

      const result = await relayAdapter.buildSwapTx({
        token: TEST_TOKEN,
        direction: 'buy',
        amount: eth('0.1'),
        minOut: '0',
        from: TEST_FROM,
        chainId: 8453,
      });

      expect(result.data).toBe('0xfound');
    });

    it('should skip already-complete items', async () => {
      mockFetchResponse({
        steps: [
          {
            id: 'swap',
            kind: 'transaction',
            items: [
              {
                status: 'complete',
                data: {
                  from: TEST_FROM,
                  to: RELAY_CONTRACT,
                  data: '0xold',
                  value: '0',
                  chainId: 8453,
                },
              },
              {
                status: 'incomplete',
                data: {
                  from: TEST_FROM,
                  to: RELAY_CONTRACT,
                  data: '0xnew',
                  value: '200',
                  chainId: 8453,
                },
              },
            ],
          },
        ],
      });

      const result = await relayAdapter.buildSwapTx({
        token: TEST_TOKEN,
        direction: 'buy',
        amount: eth('0.1'),
        minOut: '0',
        from: TEST_FROM,
        chainId: 8453,
      });

      expect(result.data).toBe('0xnew');
      expect(result.value).toBe('200');
    });

    it('should always include appFees with correct recipient and 100 bps', async () => {
      mockFetchResponse(createMockRelayResponse({
        to: RELAY_CONTRACT,
        data: '0x',
        value: '0',
      }));

      await relayAdapter.buildSwapTx({
        token: TEST_TOKEN,
        direction: 'sell',
        amount: '1000000',
        minOut: '0',
        from: TEST_FROM,
        chainId: 42161,
      });

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
      expect(body.appFees).toBeDefined();
      expect(body.appFees).toHaveLength(1);
      expect(body.appFees[0].recipient).toBe('0xa931533E0E0cCE34fc0FafB25ea2046d391eCAA5');
      expect(body.appFees[0].fee).toBe('100');
    });

    it('should pass destinationChainId when provided (cross-chain)', async () => {
      mockFetchResponse(createMockRelayResponse({
        to: RELAY_CONTRACT,
        data: '0xcross',
        value: '100000000000000000',
      }));

      await relayAdapter.buildSwapTx({
        token: TEST_TOKEN,
        direction: 'buy',
        amount: eth('0.1'),
        minOut: '0',
        from: TEST_FROM,
        chainId: 8453,
        destinationChainId: 1, // Base -> Ethereum
      });

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
      expect(body.originChainId).toBe(8453);
      expect(body.destinationChainId).toBe(1);
    });

    it('should default destinationChainId to originChainId when not provided', async () => {
      mockFetchResponse(createMockRelayResponse({
        to: RELAY_CONTRACT,
        data: '0x',
        value: '0',
      }));

      await relayAdapter.buildSwapTx({
        token: TEST_TOKEN,
        direction: 'buy',
        amount: eth('0.1'),
        minOut: '0',
        from: TEST_FROM,
        chainId: 137,
      });

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const body = JSON.parse((fetchCall[1] as RequestInit).body as string);
      expect(body.originChainId).toBe(137);
      expect(body.destinationChainId).toBe(137);
    });
  });
});
