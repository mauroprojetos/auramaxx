import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase } from '../setup';
import {
  __resetCache,
  getAllDefaults,
  getDefault,
  getDefaultSync,
  invalidateCache,
  parseRateLimit,
  resetDefault,
  setDefault,
} from '../../lib/defaults';

describe('defaults helper', () => {
  beforeEach(async () => {
    __resetCache();
    await cleanDatabase();
  });

  afterEach(() => {
    __resetCache();
  });

  it('returns seeded fallback when key is not in DB', async () => {
    const value = await getDefault('limits.fund', 999);
    expect(value).toBe(0);
  });

  it('defaults local socket auto-approve to on', async () => {
    const value = await getDefault('trust.localAutoApprove', true);
    expect(value).toBe(true);
  });

  it('setDefault persists value and cache serves sync reads', async () => {
    await setDefault('limits.fund', 0.25);

    const asyncValue = await getDefault('limits.fund', 0);
    const syncValue = getDefaultSync('limits.fund', 0);

    expect(asyncValue).toBe(0.25);
    expect(syncValue).toBe(0.25);
  });

  it('invalidateCache clears one key or all keys', async () => {
    await setDefault('limits.fund', 0.25);
    await setDefault('swap.max_slippage', 42);

    invalidateCache('limits.fund');
    expect(getDefaultSync('limits.fund', 0)).toBe(0);
    expect(getDefaultSync('swap.max_slippage', 50)).toBe(42);

    invalidateCache();
    expect(getDefaultSync('swap.max_slippage', 50)).toBe(50);
  });

  it('resetDefault restores seeded value', async () => {
    await setDefault('limits.fund', 0.42);
    await resetDefault('limits.fund');

    const value = await getDefault('limits.fund', 0);
    expect(value).toBe(0);
  });

  it('getAllDefaults returns grouped defaults with updated key', async () => {
    await setDefault('limits.fund', 0.33);

    const grouped = await getAllDefaults();
    expect(grouped.financial).toBeDefined();
    expect(grouped.financial.some((item) => item.key === 'limits.fund' && item.value === 0.33)).toBe(true);
  });

  it('parseRateLimit parses valid value and falls back for invalid input', () => {
    expect(parseRateLimit('5,900000')).toEqual({ max: 5, windowMs: 900000 });
    expect(parseRateLimit(42)).toEqual({ max: 10, windowMs: 60000 });
  });
});
