/**
 * Tests for server/lib/txhistory/decoder.ts
 * Tests each event type decoding from raw logs.
 */
import { describe, it, expect } from 'vitest';
import { decodeLogs, extractAddress, type RawLog } from '../../lib/txhistory/decoder';
import { EVENT_SIGNATURES } from '../../lib/txhistory/signatures';
import { encodeAbiParameters } from 'viem';

// Helper to create a raw log
function makeLog(overrides: Partial<RawLog>): RawLog {
  return {
    address: '0x1234567890abcdef1234567890abcdef12345678',
    topics: [],
    data: '0x',
    transactionHash: '0x' + 'ab'.repeat(32),
    logIndex: 0,
    blockNumber: 100000n,
    ...overrides,
  };
}

// Helper to pad address to 32-byte topic
function padAddr(addr: string): string {
  return '0x' + addr.replace('0x', '').toLowerCase().padStart(64, '0');
}

describe('extractAddress', () => {
  it('should extract 20-byte address from 32-byte topic', () => {
    const topic = '0x000000000000000000000000dead000000000000000000000000000000beef';
    expect(extractAddress(topic)).toBe('0xdead000000000000000000000000000000beef');
  });
});

describe('decodeLogs', () => {
  it('should return empty array for empty input', () => {
    expect(decodeLogs([])).toEqual([]);
  });

  it('should skip logs with no topics', () => {
    const result = decodeLogs([makeLog({ topics: [] })]);
    expect(result).toEqual([]);
  });

  it('should decode ERC-20 Transfer', () => {
    const from = '0x1111111111111111111111111111111111111111';
    const to = '0x2222222222222222222222222222222222222222';
    const amount = 1000000000000000000n; // 1e18

    const data = encodeAbiParameters(
      [{ name: 'amount', type: 'uint256' }],
      [amount],
    );

    const log = makeLog({
      topics: [EVENT_SIGNATURES.TRANSFER, padAddr(from), padAddr(to)],
      data,
    });

    const result = decodeLogs([log]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('transfer');
    expect(result[0].params.from).toBe(from);
    expect(result[0].params.to).toBe(to);
    expect(result[0].params.amount).toBe(amount);
  });

  it('should decode ERC-721 Transfer (4 topics)', () => {
    const from = '0x1111111111111111111111111111111111111111';
    const to = '0x2222222222222222222222222222222222222222';
    const tokenId = '0x' + '0'.repeat(63) + '5'; // tokenId = 5

    const log = makeLog({
      topics: [EVENT_SIGNATURES.TRANSFER, padAddr(from), padAddr(to), tokenId],
      data: '0x',
    });

    const result = decodeLogs([log]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('transfer_nft');
    expect(result[0].params.from).toBe(from);
    expect(result[0].params.to).toBe(to);
    expect(result[0].params.tokenId).toBe(5n);
  });

  it('should decode Approval', () => {
    const owner = '0x1111111111111111111111111111111111111111';
    const spender = '0x2222222222222222222222222222222222222222';
    const amount = 115792089237316195423570985008687907853269984665640564039457584007913129639935n; // max uint256

    const data = encodeAbiParameters(
      [{ name: 'amount', type: 'uint256' }],
      [amount],
    );

    const log = makeLog({
      topics: [EVENT_SIGNATURES.APPROVAL, padAddr(owner), padAddr(spender)],
      data,
    });

    const result = decodeLogs([log]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('approval');
    expect(result[0].params.owner).toBe(owner);
    expect(result[0].params.spender).toBe(spender);
    expect(result[0].params.amount).toBe(amount);
  });

  it('should decode Swap V2', () => {
    const sender = '0x1111111111111111111111111111111111111111';
    const to = '0x2222222222222222222222222222222222222222';

    const data = encodeAbiParameters(
      [
        { name: 'amount0In', type: 'uint256' },
        { name: 'amount1In', type: 'uint256' },
        { name: 'amount0Out', type: 'uint256' },
        { name: 'amount1Out', type: 'uint256' },
      ],
      [1000000n, 0n, 0n, 500000n],
    );

    const log = makeLog({
      topics: [EVENT_SIGNATURES.SWAP_V2, padAddr(sender), padAddr(to)],
      data,
    });

    const result = decodeLogs([log]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('swap_v2');
    expect(result[0].params.amount0In).toBe(1000000n);
    expect(result[0].params.amount1Out).toBe(500000n);
  });

  it('should decode Swap V3', () => {
    const sender = '0x1111111111111111111111111111111111111111';
    const recipient = '0x2222222222222222222222222222222222222222';

    const data = encodeAbiParameters(
      [
        { name: 'amount0', type: 'int256' },
        { name: 'amount1', type: 'int256' },
        { name: 'sqrtPriceX96', type: 'uint160' },
        { name: 'liquidity', type: 'uint128' },
        { name: 'tick', type: 'int24' },
      ],
      [1000000n, -500000n, 79228162514264337593543950336n, 1000000n, 0],
    );

    const log = makeLog({
      topics: [EVENT_SIGNATURES.SWAP_V3, padAddr(sender), padAddr(recipient)],
      data,
    });

    const result = decodeLogs([log]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('swap_v3');
    expect(result[0].params.amount0).toBe(1000000n);
    expect(result[0].params.amount1).toBe(-500000n);
  });

  it('should decode Swap V4', () => {
    const poolId = '0x' + 'aa'.repeat(32);
    const sender = '0x1111111111111111111111111111111111111111';

    const data = encodeAbiParameters(
      [
        { name: 'amount0', type: 'int128' },
        { name: 'amount1', type: 'int128' },
        { name: 'sqrtPriceX96', type: 'uint160' },
        { name: 'liquidity', type: 'uint128' },
        { name: 'tick', type: 'int24' },
        { name: 'fee', type: 'uint24' },
      ],
      [500000n, -250000n, 79228162514264337593543950336n, 1000000n, 0, 3000],
    );

    const log = makeLog({
      topics: [EVENT_SIGNATURES.SWAP_V4, poolId, padAddr(sender)],
      data,
    });

    const result = decodeLogs([log]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('swap_v4');
    expect(result[0].params.poolId).toBe(poolId);
    expect(result[0].params.amount0).toBe(500000n);
    expect(result[0].params.fee).toBe(3000);
  });

  it('should decode WETH Deposit', () => {
    const dst = '0x1111111111111111111111111111111111111111';

    const data = encodeAbiParameters(
      [{ name: 'wad', type: 'uint256' }],
      [1500000000000000000n], // 1.5 ETH
    );

    const log = makeLog({
      topics: [EVENT_SIGNATURES.WETH_DEPOSIT, padAddr(dst)],
      data,
    });

    const result = decodeLogs([log]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('weth_deposit');
    expect(result[0].params.dst).toBe(dst);
    expect(result[0].params.wad).toBe(1500000000000000000n);
  });

  it('should decode WETH Withdrawal', () => {
    const src = '0x1111111111111111111111111111111111111111';

    const data = encodeAbiParameters(
      [{ name: 'wad', type: 'uint256' }],
      [2000000000000000000n], // 2 ETH
    );

    const log = makeLog({
      topics: [EVENT_SIGNATURES.WETH_WITHDRAWAL, padAddr(src)],
      data,
    });

    const result = decodeLogs([log]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('weth_withdrawal');
    expect(result[0].params.src).toBe(src);
    expect(result[0].params.wad).toBe(2000000000000000000n);
  });

  it('should handle unknown topic0', () => {
    const log = makeLog({
      topics: ['0x' + 'ff'.repeat(32)],
      data: '0x',
    });

    const result = decodeLogs([log]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unknown');
  });

  it('should handle malformed data gracefully', () => {
    const log = makeLog({
      topics: [EVENT_SIGNATURES.TRANSFER, padAddr('0x' + '11'.repeat(20)), padAddr('0x' + '22'.repeat(20))],
      data: '0xdeadbeef', // Too short for uint256
    });

    const result = decodeLogs([log]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('unknown');
    expect(result[0].params.error).toBe('decode_failed');
  });

  it('should decode multiple logs', () => {
    const addr1 = '0x1111111111111111111111111111111111111111';
    const addr2 = '0x2222222222222222222222222222222222222222';

    const transferData = encodeAbiParameters(
      [{ name: 'amount', type: 'uint256' }],
      [1000n],
    );

    const depositData = encodeAbiParameters(
      [{ name: 'wad', type: 'uint256' }],
      [2000n],
    );

    const logs = [
      makeLog({
        topics: [EVENT_SIGNATURES.TRANSFER, padAddr(addr1), padAddr(addr2)],
        data: transferData,
        logIndex: 0,
      }),
      makeLog({
        topics: [EVENT_SIGNATURES.WETH_DEPOSIT, padAddr(addr1)],
        data: depositData,
        logIndex: 1,
      }),
    ];

    const result = decodeLogs(logs);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('transfer');
    expect(result[1].type).toBe('weth_deposit');
  });
});
