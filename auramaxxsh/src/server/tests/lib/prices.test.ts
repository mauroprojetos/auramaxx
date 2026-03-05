import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, testPrisma } from '../setup';
import { getEthToUsd, getSolToUsd } from '../../lib/prices';

describe('prices helpers', () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterEach(async () => {
    await cleanDatabase();
  });

  it('getEthToUsd returns null when no price cached', async () => {
    const price = await getEthToUsd();
    expect(price).toBeNull();
  });

  it('getSolToUsd returns null when no price cached', async () => {
    const price = await getSolToUsd();
    expect(price).toBeNull();
  });

  it('getEthToUsd returns cached price', async () => {
    await testPrisma.nativePrice.create({
      data: { currency: 'ETH', priceUsd: '3456.78' },
    });

    const price = await getEthToUsd();
    expect(price).toBe(3456.78);
  });

  it('getSolToUsd returns cached price', async () => {
    await testPrisma.nativePrice.create({
      data: { currency: 'SOL', priceUsd: '123.45' },
    });

    const price = await getSolToUsd();
    expect(price).toBe(123.45);
  });

  it('returns null for invalid price string', async () => {
    await testPrisma.nativePrice.create({
      data: { currency: 'ETH', priceUsd: 'not-a-number' },
    });

    const price = await getEthToUsd();
    expect(price).toBeNull();
  });
});
