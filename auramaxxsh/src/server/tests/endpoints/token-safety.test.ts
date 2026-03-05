/**
 * Token Safety & Holders Endpoint Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../setup';

// Mock the token-safety library
vi.mock('../../lib/token-safety', () => {
  return {
    getTokenSafety: vi.fn(),
    clearTokenSafetyCache: vi.fn(),
  };
});

// Mock token-search (needed by the token router)
vi.mock('../../lib/token-search', () => {
  return {
    searchTokens: vi.fn().mockResolvedValue([]),
    clearTokenSearchCache: vi.fn(),
  };
});

import { getTokenSafety } from '../../lib/token-safety';

const app = createTestApp();
const mockedGetTokenSafety = vi.mocked(getTokenSafety);

beforeEach(() => {
  vi.clearAllMocks();
});

function mockSafetyResult(overrides: Record<string, any> = {}) {
  return {
    tokenName: 'Pepe',
    tokenSymbol: 'PEPE',
    totalSupply: '420689899653542',

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

    ownerAddress: '0x0000000000000000000000000000000000000000',
    creatorAddress: '0xcreator',
    creatorPercent: '0.000000',

    holderCount: 513429,
    holders: [
      {
        address: '0xholder1',
        balance: '100000000',
        percent: '0.05',
        isLocked: false,
        isContract: true,
        tag: 'Uniswap V2',
      },
      {
        address: '0xholder2',
        balance: '50000000',
        percent: '0.025',
        isLocked: true,
        isContract: false,
        tag: '',
      },
    ],

    lpHolderCount: 67,
    lpTotalSupply: '1000000',
    lpHolders: [
      {
        address: '0xlp1',
        balance: '500000',
        percent: '0.5',
        isLocked: true,
        isContract: true,
      },
    ],

    dexInfo: [
      { name: 'Uniswap V2', liquidity: '5000000', pair: '0xpair1' },
    ],

    ...overrides,
  };
}

describe('Token Safety Endpoint', () => {
  describe('GET /token/safety/:address', () => {
    it('should return safety data for a valid token', async () => {
      mockedGetTokenSafety.mockResolvedValue(mockSafetyResult());

      const res = await request(app)
        .get('/token/safety/0x6982508145454Ce325dDbE47a25d4ec3d2311933');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.address).toBe('0x6982508145454Ce325dDbE47a25d4ec3d2311933');
      expect(res.body.chain).toBe('ethereum');
      expect(res.body.safety.isHoneypot).toBe(false);
      expect(res.body.safety.isMintable).toBe(false);
      expect(res.body.safety.isOpenSource).toBe(true);
      expect(res.body.safety.holderCount).toBe(513429);
      expect(res.body.safety.buyTax).toBe('0');
      expect(res.body.safety.sellTax).toBe('0');
    });

    it('should pass chain param to getTokenSafety', async () => {
      mockedGetTokenSafety.mockResolvedValue(mockSafetyResult());

      const res = await request(app)
        .get('/token/safety/0x6982508145454Ce325dDbE47a25d4ec3d2311933?chain=base');

      expect(res.status).toBe(200);
      expect(res.body.chain).toBe('base');
      expect(mockedGetTokenSafety).toHaveBeenCalledWith(
        '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
        'base',
      );
    });

    it('should default to ethereum chain', async () => {
      mockedGetTokenSafety.mockResolvedValue(mockSafetyResult());

      await request(app)
        .get('/token/safety/0x6982508145454Ce325dDbE47a25d4ec3d2311933');

      expect(mockedGetTokenSafety).toHaveBeenCalledWith(
        '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
        'ethereum',
      );
    });

    it('should return 404 when no data found', async () => {
      mockedGetTokenSafety.mockResolvedValue(null);

      const res = await request(app)
        .get('/token/safety/0x0000000000000000000000000000000000000000');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('No safety data found');
    });

    it('should include holder data in safety response', async () => {
      mockedGetTokenSafety.mockResolvedValue(mockSafetyResult());

      const res = await request(app)
        .get('/token/safety/0x6982508145454Ce325dDbE47a25d4ec3d2311933');

      expect(res.body.safety.holders).toHaveLength(2);
      expect(res.body.safety.holders[0].address).toBe('0xholder1');
      expect(res.body.safety.holders[0].isContract).toBe(true);
      expect(res.body.safety.holders[0].tag).toBe('Uniswap V2');
    });

    it('should include LP data in safety response', async () => {
      mockedGetTokenSafety.mockResolvedValue(mockSafetyResult());

      const res = await request(app)
        .get('/token/safety/0x6982508145454Ce325dDbE47a25d4ec3d2311933');

      expect(res.body.safety.lpHolderCount).toBe(67);
      expect(res.body.safety.lpHolders).toHaveLength(1);
      expect(res.body.safety.lpHolders[0].isLocked).toBe(true);
    });

    it('should include DEX info in safety response', async () => {
      mockedGetTokenSafety.mockResolvedValue(mockSafetyResult());

      const res = await request(app)
        .get('/token/safety/0x6982508145454Ce325dDbE47a25d4ec3d2311933');

      expect(res.body.safety.dexInfo).toHaveLength(1);
      expect(res.body.safety.dexInfo[0].name).toBe('Uniswap V2');
    });

    it('should detect honeypot token', async () => {
      mockedGetTokenSafety.mockResolvedValue(mockSafetyResult({
        isHoneypot: true,
        sellTax: '1',
      }));

      const res = await request(app)
        .get('/token/safety/0xscam');

      expect(res.status).toBe(200);
      expect(res.body.safety.isHoneypot).toBe(true);
      expect(res.body.safety.sellTax).toBe('1');
    });

    it('should handle getTokenSafety error gracefully', async () => {
      mockedGetTokenSafety.mockRejectedValue(new Error('GoPlus timeout'));

      const res = await request(app)
        .get('/token/safety/0x6982508145454Ce325dDbE47a25d4ec3d2311933');

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });
});

describe('Token Holders Endpoint', () => {
  describe('GET /token/holders/:address', () => {
    it('should return holder data for a valid token', async () => {
      mockedGetTokenSafety.mockResolvedValue(mockSafetyResult());

      const res = await request(app)
        .get('/token/holders/0x6982508145454Ce325dDbE47a25d4ec3d2311933');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.tokenName).toBe('Pepe');
      expect(res.body.tokenSymbol).toBe('PEPE');
      expect(res.body.holderCount).toBe(513429);
      expect(res.body.holders).toHaveLength(2);
    });

    it('should not include safety fields in holders response', async () => {
      mockedGetTokenSafety.mockResolvedValue(mockSafetyResult());

      const res = await request(app)
        .get('/token/holders/0x6982508145454Ce325dDbE47a25d4ec3d2311933');

      expect(res.body.safety).toBeUndefined();
      expect(res.body.isHoneypot).toBeUndefined();
      expect(res.body.lpHolders).toBeUndefined();
    });

    it('should pass chain param', async () => {
      mockedGetTokenSafety.mockResolvedValue(mockSafetyResult());

      const res = await request(app)
        .get('/token/holders/0x6982508145454Ce325dDbE47a25d4ec3d2311933?chain=base');

      expect(res.body.chain).toBe('base');
      expect(mockedGetTokenSafety).toHaveBeenCalledWith(
        '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
        'base',
      );
    });

    it('should return 404 when no data found', async () => {
      mockedGetTokenSafety.mockResolvedValue(null);

      const res = await request(app)
        .get('/token/holders/0x0000000000000000000000000000000000000000');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('No holder data found');
    });

    it('should include holder details', async () => {
      mockedGetTokenSafety.mockResolvedValue(mockSafetyResult());

      const res = await request(app)
        .get('/token/holders/0x6982508145454Ce325dDbE47a25d4ec3d2311933');

      const holder = res.body.holders[0];
      expect(holder.address).toBe('0xholder1');
      expect(holder.balance).toBe('100000000');
      expect(holder.percent).toBe('0.05');
      expect(holder.isLocked).toBe(false);
      expect(holder.isContract).toBe(true);
      expect(holder.tag).toBe('Uniswap V2');
    });
  });
});
