/**
 * ERC-20 and SPL Token Send Tests
 *
 * Tests the tokenAddress parameter in POST /send for both EVM and Solana paths.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { ethers } from 'ethers';
import { createTestApp, cleanDatabase, testPrisma, setupAndUnlockWallet } from './setup';

const app = createTestApp();

// Mock EVM signing — each call returns a unique hash to avoid DB unique constraint
let txCounter = 0;
vi.mock('../lib/hot', async () => {
  const actual = await vi.importActual('../lib/hot');
  return {
    ...actual as object,
    signWithHotWallet: vi.fn().mockImplementation(async () => {
      txCounter++;
      return { hash: '0x' + txCounter.toString().padStart(64, 'a') };
    }),
    getHotWallet: vi.fn().mockImplementation(async (addr: string) => {
      // Return a hot wallet for our test address
      if (addr === '0x1111111111111111111111111111111111111111') {
        return { address: addr, chain: 'base' };
      }
      return null;
    }),
    tokenCanAccessWallet: vi.fn().mockResolvedValue(true),
  };
});

// Mock the resolve module to avoid real ENS lookups
vi.mock('../lib/resolve', () => ({
  resolveName: vi.fn().mockImplementation(async (name: string) => {
    if (name === 'vitalik.eth') return { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', name };
    throw new Error(`Could not resolve: ${name}`);
  }),
  looksLikeName: vi.fn().mockImplementation((value: string) => {
    return value.includes('.') && !value.startsWith('0x') && !value.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  }),
}));

describe('ERC-20 Token Send', () => {
  let adminToken: string;

  beforeAll(async () => {
    await cleanDatabase();
    const result = await setupAndUnlockWallet();
    adminToken = result.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('should build ERC-20 transfer calldata when tokenAddress is provided', async () => {
    const tokenAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC
    const to = '0x2222222222222222222222222222222222222222';
    const amount = '1000000'; // 1 USDC (6 decimals)

    const res = await request(app)
      .post('/send')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        from: '0x1111111111111111111111111111111111111111',
        to,
        amount,
        tokenAddress,
        chain: 'base',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.hash).toBeDefined();
    expect(res.body.tokenAddress).toBe(tokenAddress);
    expect(res.body.tokenAmount).toBe(amount);
    // Should not have native amount fields
    expect(res.body.amount).toBeUndefined();
    expect(res.body.value).toBeUndefined();
  });

  it('should verify the signWithHotWallet was called with ERC-20 calldata', async () => {
    const { signWithHotWallet } = await import('../lib/hot');
    const lastCall = vi.mocked(signWithHotWallet).mock.lastCall;

    if (lastCall) {
      const tx = lastCall[1] as ethers.TransactionRequest;
      // tx.to should be the token contract, not the recipient
      expect(tx.to?.toLowerCase()).toContain('a0b86991'); // USDC contract
      // tx.data should contain ERC-20 transfer selector (0xa9059cbb)
      expect(typeof tx.data).toBe('string');
      expect((tx.data as string).startsWith('0xa9059cbb')).toBe(true);
      // tx.value should be 0 (no native ETH sent)
      expect(tx.value).toBe(0n);
    }
  });

  it('should auto-track the token after a successful send', async () => {
    const tokenAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const wallet = '0x1111111111111111111111111111111111111111';

    const tracked = await testPrisma.trackedAsset.findFirst({
      where: {
        walletAddress: wallet.toLowerCase(),
        tokenAddress: tokenAddress.toLowerCase(),
      },
    });

    expect(tracked).not.toBeNull();
  });

  it('should create transaction record with tokenAddress and tokenAmount', async () => {
    const txRecord = await testPrisma.transaction.findFirst({
      where: {
        tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      },
      orderBy: { createdAt: 'desc' },
    });

    expect(txRecord).not.toBeNull();
    expect(txRecord!.type).toBe('send');
    expect(txRecord!.tokenAmount).toBe('1000000');
  });

  it('should error if tokenAddress is set but to is missing', async () => {
    const res = await request(app)
      .post('/send')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        from: '0x1111111111111111111111111111111111111111',
        amount: '1000000',
        tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        chain: 'base',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('to address is required');
  });

  it('should error if tokenAddress is set but amount is zero', async () => {
    const res = await request(app)
      .post('/send')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        amount: '0',
        tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        chain: 'base',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('amount is required for token sends');
  });

  it('should still handle native ETH sends without tokenAddress', async () => {
    const res = await request(app)
      .post('/send')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        amount: '100000000000000000', // 0.1 ETH
        chain: 'base',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.amount).toBe('0.1');
    expect(res.body.tokenAddress).toBeUndefined();
  });

  it('should resolve ENS name in to field', async () => {
    const res = await request(app)
      .post('/send')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        from: '0x1111111111111111111111111111111111111111',
        to: 'vitalik.eth',
        amount: '100000000000000000',
        chain: 'base',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The resolved address should be used
    expect(res.body.to).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
  });
});
