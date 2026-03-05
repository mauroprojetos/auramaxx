import { parseEther } from 'ethers';

/**
 * Convert ETH decimal to wei string for use in test payloads.
 * Usage: eth('0.1') → '100000000000000000'
 */
export const eth = (val: string): string => parseEther(val).toString();

/**
 * Convert SOL decimal to lamports string for use in test payloads.
 * Usage: sol('0.5') → '500000000'
 */
export const sol = (val: string): string =>
  BigInt(Math.round(parseFloat(val) * 1e9)).toString();
