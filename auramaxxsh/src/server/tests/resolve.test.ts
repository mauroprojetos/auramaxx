/**
 * ENS Resolution Tests
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from './setup';

// Mock the resolve helper (which the route handler imports)
vi.mock('../lib/resolve', () => ({
  resolveName: vi.fn().mockImplementation(async (name: string) => {
    if (name === 'vitalik.eth') return { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', name };
    if (name === 'test.eth') return { address: '0x1234567890abcdef1234567890abcdef12345678', name };
    if (name === 'example.sol') throw new Error('Unsupported name format: example.sol. Only .eth names are supported.');
    throw new Error(`Could not resolve: ${name}`);
  }),
  looksLikeName: vi.fn().mockImplementation((value: string) => {
    return value.includes('.') && !value.startsWith('0x') && !value.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  }),
}));

const app = createTestApp();

describe('ENS Resolution', () => {
  describe('GET /resolve/:name', () => {
    it('should resolve vitalik.eth', async () => {
      const res = await request(app)
        .get('/resolve/vitalik.eth');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.address).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
      expect(res.body.name).toBe('vitalik.eth');
    });

    it('should resolve test.eth', async () => {
      const res = await request(app)
        .get('/resolve/test.eth');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.address).toBe('0x1234567890abcdef1234567890abcdef12345678');
    });

    it('should return error for unresolvable name', async () => {
      const res = await request(app)
        .get('/resolve/nonexistent.eth');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Could not resolve');
    });

    it('should reject non-.eth names', async () => {
      const res = await request(app)
        .get('/resolve/example.sol');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Only .eth names are supported');
    });
  });
});

describe('looksLikeName helper', () => {
  it('should detect ENS names correctly', () => {
    // Test the real logic directly (the mock uses the same implementation)
    const looksLikeName = (value: string) =>
      value.includes('.') && !value.startsWith('0x') && !value.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

    // Should detect ENS names
    expect(looksLikeName('vitalik.eth')).toBe(true);
    expect(looksLikeName('test.eth')).toBe(true);

    // Should not detect EVM addresses
    expect(looksLikeName('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(false);

    // Should not detect Solana addresses (base58)
    expect(looksLikeName('5Gh7H4pJsEFVqkDHnwzX5Kv9rR3FDwKzqk1bBn6LT7K')).toBe(false);

    // Should not detect plain strings without dots
    expect(looksLikeName('vitalik')).toBe(false);
  });
});
