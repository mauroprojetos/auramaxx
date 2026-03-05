/**
 * Token Safety Library Unit Tests
 *
 * Tests the GoPlusLabs integration by mocking global fetch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTokenSafety, clearTokenSafetyCache } from '../../lib/token-safety';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenSafetyCache();
});

function goPlusResponse(tokenData: Record<string, any>, address = '0xpepe') {
  return {
    ok: true,
    json: () => Promise.resolve({
      code: 1,
      message: 'OK',
      result: { [address.toLowerCase()]: tokenData },
    }),
  };
}

function fullTokenData(overrides: Record<string, any> = {}) {
  return {
    token_name: 'Pepe',
    token_symbol: 'PEPE',
    total_supply: '420689899653542',
    is_honeypot: '0',
    is_mintable: '0',
    is_open_source: '1',
    is_proxy: '0',
    is_blacklisted: '0',
    is_anti_whale: '0',
    hidden_owner: '0',
    external_call: '0',
    selfdestruct: '0',
    can_take_back_ownership: '0',
    transfer_pausable: '0',
    buy_tax: '0',
    sell_tax: '0',
    owner_address: '0x0000000000000000000000000000000000000000',
    creator_address: '0xcreator',
    creator_percent: '0.000000',
    holder_count: '513429',
    holders: [
      {
        address: '0xholder1',
        balance: '100000000',
        percent: '0.05',
        is_locked: 0,
        is_contract: 1,
        tag: 'Uniswap V2',
      },
    ],
    lp_holder_count: '67',
    lp_total_supply: '1000000',
    lp_holders: [
      {
        address: '0xlp1',
        balance: '500000',
        percent: '0.5',
        is_locked: 1,
        is_contract: 1,
      },
    ],
    dex: [
      { name: 'Uniswap V2', liquidity: '5000000', pair: '0xpair1' },
    ],
    ...overrides,
  };
}

describe('Token Safety Library', () => {
  describe('getTokenSafety', () => {
    it('should return safety data for a valid token', async () => {
      mockFetch.mockResolvedValueOnce(goPlusResponse(fullTokenData()));

      const result = await getTokenSafety('0xpepe', 'ethereum');

      expect(result).not.toBeNull();
      expect(result!.tokenName).toBe('Pepe');
      expect(result!.tokenSymbol).toBe('PEPE');
      expect(result!.isHoneypot).toBe(false);
      expect(result!.isMintable).toBe(false);
      expect(result!.isOpenSource).toBe(true);
      expect(result!.holderCount).toBe(513429);
    });

    it('should use correct GoPlusLabs chain ID for ethereum', async () => {
      mockFetch.mockResolvedValueOnce(goPlusResponse(fullTokenData()));

      await getTokenSafety('0xpepe', 'ethereum');

      expect(mockFetch.mock.calls[0][0]).toContain('/token_security/1?');
    });

    it('should use correct GoPlusLabs chain ID for base', async () => {
      mockFetch.mockResolvedValueOnce(goPlusResponse(fullTokenData()));

      await getTokenSafety('0xpepe', 'base');

      expect(mockFetch.mock.calls[0][0]).toContain('/token_security/8453?');
    });

    it('should use correct GoPlusLabs chain ID for solana', async () => {
      mockFetch.mockResolvedValueOnce(goPlusResponse(fullTokenData()));

      await getTokenSafety('SolAddr123', 'solana');

      expect(mockFetch.mock.calls[0][0]).toContain('/token_security/solana?');
    });

    it('should return null for unsupported chain', async () => {
      const result = await getTokenSafety('0xpepe', 'fantom');

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should detect honeypot token', async () => {
      mockFetch.mockResolvedValueOnce(goPlusResponse(fullTokenData({
        is_honeypot: '1',
        sell_tax: '1',
      })));

      const result = await getTokenSafety('0xscam', 'ethereum');

      expect(result!.isHoneypot).toBe(true);
      expect(result!.sellTax).toBe('1');
    });

    it('should detect mintable token', async () => {
      mockFetch.mockResolvedValueOnce(goPlusResponse(fullTokenData({
        is_mintable: '1',
      })));

      const result = await getTokenSafety('0xmint', 'ethereum');

      expect(result!.isMintable).toBe(true);
    });

    it('should parse holder data correctly', async () => {
      mockFetch.mockResolvedValueOnce(goPlusResponse(fullTokenData()));

      const result = await getTokenSafety('0xpepe', 'ethereum');

      expect(result!.holders).toHaveLength(1);
      expect(result!.holders[0].address).toBe('0xholder1');
      expect(result!.holders[0].isContract).toBe(true);
      expect(result!.holders[0].isLocked).toBe(false);
      expect(result!.holders[0].tag).toBe('Uniswap V2');
    });

    it('should parse LP holder data correctly', async () => {
      mockFetch.mockResolvedValueOnce(goPlusResponse(fullTokenData()));

      const result = await getTokenSafety('0xpepe', 'ethereum');

      expect(result!.lpHolderCount).toBe(67);
      expect(result!.lpHolders).toHaveLength(1);
      expect(result!.lpHolders[0].isLocked).toBe(true);
    });

    it('should parse DEX info correctly', async () => {
      mockFetch.mockResolvedValueOnce(goPlusResponse(fullTokenData()));

      const result = await getTokenSafety('0xpepe', 'ethereum');

      expect(result!.dexInfo).toHaveLength(1);
      expect(result!.dexInfo[0].name).toBe('Uniswap V2');
      expect(result!.dexInfo[0].liquidity).toBe('5000000');
    });

    it('should handle missing optional fields gracefully', async () => {
      mockFetch.mockResolvedValueOnce(goPlusResponse({
        token_name: 'Test',
        token_symbol: 'TEST',
        // All other fields missing
      }));

      const result = await getTokenSafety('0xtest', 'ethereum');

      expect(result).not.toBeNull();
      expect(result!.isHoneypot).toBe(false);
      expect(result!.holderCount).toBe(0);
      expect(result!.holders).toEqual([]);
      expect(result!.lpHolders).toEqual([]);
      expect(result!.dexInfo).toEqual([]);
      expect(result!.buyTax).toBe('0');
    });

    it('should return null when GoPlus returns non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await getTokenSafety('0xpepe', 'ethereum');

      expect(result).toBeNull();
    });

    it('should return null when GoPlus returns error code', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, message: 'Error', result: null }),
      });

      const result = await getTokenSafety('0xpepe', 'ethereum');

      expect(result).toBeNull();
    });

    it('should return null when GoPlus returns empty result', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 1, message: 'OK', result: {} }),
      });

      const result = await getTokenSafety('0xpepe', 'ethereum');

      expect(result).toBeNull();
    });

    it('should return null when fetch throws (timeout)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('timeout'));

      const result = await getTokenSafety('0xpepe', 'ethereum');

      expect(result).toBeNull();
    });

    it('should cache results', async () => {
      mockFetch.mockResolvedValueOnce(goPlusResponse(fullTokenData()));

      const first = await getTokenSafety('0xpepe', 'ethereum');
      const second = await getTokenSafety('0xpepe', 'ethereum');

      expect(first).toEqual(second);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should use separate cache keys per chain', async () => {
      mockFetch.mockResolvedValueOnce(goPlusResponse(fullTokenData()));
      mockFetch.mockResolvedValueOnce(goPlusResponse(fullTokenData({ token_name: 'Base Pepe' })));

      const eth = await getTokenSafety('0xpepe', 'ethereum');
      const base = await getTokenSafety('0xpepe', 'base');

      expect(eth!.tokenName).toBe('Pepe');
      expect(base!.tokenName).toBe('Base Pepe');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should handle boolean values as strings and numbers', async () => {
      mockFetch.mockResolvedValueOnce(goPlusResponse(fullTokenData({
        is_honeypot: 1,      // number
        is_mintable: '1',    // string
        is_open_source: true, // boolean
        is_proxy: '0',       // string false
        is_blacklisted: 0,   // number false
        is_anti_whale: false, // boolean false
      })));

      const result = await getTokenSafety('0xtest', 'ethereum');

      expect(result!.isHoneypot).toBe(true);
      expect(result!.isMintable).toBe(true);
      expect(result!.isOpenSource).toBe(true);
      expect(result!.isProxy).toBe(false);
      expect(result!.isBlacklisted).toBe(false);
      expect(result!.isAntiWhale).toBe(false);
    });
  });
});
