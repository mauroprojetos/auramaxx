/**
 * Tests for address normalization utilities
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeAddress,
  isSolanaChain,
  getNativeAddress,
  getNativeCurrency,
  NATIVE_ADDRESSES,
} from '../../lib/address';

describe('Address Utilities', () => {
  describe('isSolanaChain()', () => {
    it('should return true for solana', () => {
      expect(isSolanaChain('solana')).toBe(true);
    });

    it('should return true for solana-devnet', () => {
      expect(isSolanaChain('solana-devnet')).toBe(true);
    });

    it('should return false for EVM chains', () => {
      expect(isSolanaChain('base')).toBe(false);
      expect(isSolanaChain('ethereum')).toBe(false);
      expect(isSolanaChain('arbitrum')).toBe(false);
      expect(isSolanaChain('optimism')).toBe(false);
      expect(isSolanaChain('polygon')).toBe(false);
    });

    it('should return false for unknown chains', () => {
      expect(isSolanaChain('unknown')).toBe(false);
      expect(isSolanaChain('')).toBe(false);
    });
  });

  describe('normalizeAddress()', () => {
    it('should lowercase EVM addresses', () => {
      const addr = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';
      expect(normalizeAddress(addr)).toBe(addr.toLowerCase());
      expect(normalizeAddress(addr, 'base')).toBe(addr.toLowerCase());
      expect(normalizeAddress(addr, 'ethereum')).toBe(addr.toLowerCase());
    });

    it('should preserve Solana addresses (case-sensitive)', () => {
      const addr = 'So11111111111111111111111111111111111111112';
      expect(normalizeAddress(addr, 'solana')).toBe(addr);
      expect(normalizeAddress(addr, 'solana-devnet')).toBe(addr);
    });

    it('should lowercase when no chain specified (default EVM)', () => {
      const addr = 'So11111111111111111111111111111111111111112';
      expect(normalizeAddress(addr)).toBe(addr.toLowerCase());
    });

    it('should handle already-lowercase EVM addresses', () => {
      const addr = '0xabcdef1234567890abcdef1234567890abcdef12';
      expect(normalizeAddress(addr, 'base')).toBe(addr);
    });
  });

  describe('getNativeAddress()', () => {
    it('should return ETH zero address for EVM chains', () => {
      expect(getNativeAddress('base')).toBe(NATIVE_ADDRESSES.ETH);
      expect(getNativeAddress('ethereum')).toBe(NATIVE_ADDRESSES.ETH);
      expect(getNativeAddress('arbitrum')).toBe(NATIVE_ADDRESSES.ETH);
    });

    it('should return SOL mint address for Solana chains', () => {
      expect(getNativeAddress('solana')).toBe(NATIVE_ADDRESSES.SOL);
      expect(getNativeAddress('solana-devnet')).toBe(NATIVE_ADDRESSES.SOL);
    });
  });

  describe('getNativeCurrency()', () => {
    it('should return ETH for EVM chains', () => {
      expect(getNativeCurrency('base')).toBe('ETH');
      expect(getNativeCurrency('ethereum')).toBe('ETH');
    });

    it('should return SOL for Solana chains', () => {
      expect(getNativeCurrency('solana')).toBe('SOL');
      expect(getNativeCurrency('solana-devnet')).toBe('SOL');
    });
  });

  describe('NATIVE_ADDRESSES', () => {
    it('should have correct ETH address', () => {
      expect(NATIVE_ADDRESSES.ETH).toBe('0x0000000000000000000000000000000000000000');
    });

    it('should have correct SOL address', () => {
      expect(NATIVE_ADDRESSES.SOL).toBe('So11111111111111111111111111111111111111112');
    });
  });
});
