/**
 * Tests for strategy source fetcher
 *
 * Tests:
 * - resolveUrl — config vars, parent data vars, missing vars
 * - resolvePath — simple path, nested path, array index, root ($), undefined paths
 * - applySelect — items extraction, field mapping, no items key
 * - getAuthHeaders — bearer, header, none, missing key (mock fetch)
 * - fetchAllSources — mock fetch, parallel independent, sequential dependent
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock network module before importing sources
vi.mock('../../../lib/network', () => ({
  validateExternalUrl: vi.fn().mockResolvedValue(undefined),
  sanitizePathSegment: vi.fn((s: string) => s),
}));

import { resolveUrl, resolvePath, applySelect, getAuthHeaders, fetchAllSources } from '../../../lib/strategy/sources';
import { validateExternalUrl } from '../../../lib/network';
import type { SourceDef, StrategyManifest, StrategyConfig } from '../../../lib/strategy/types';

describe('Strategy Sources', () => {
  describe('resolveUrl()', () => {
    it('should substitute config vars with ${config.x} syntax', () => {
      const config: StrategyConfig = { pair: 'ETH-USD' };
      const result = resolveUrl('https://api.example.com/${config.pair}/price', config);
      expect(result).toBe('https://api.example.com/ETH-USD/price');
    });

    it('should substitute implicit config vars with ${key} syntax', () => {
      const config: StrategyConfig = { symbol: 'BTC' };
      const result = resolveUrl('https://api.example.com/price/${symbol}', config);
      expect(result).toBe('https://api.example.com/price/BTC');
    });

    it('should replace missing config vars with empty string', () => {
      const config: StrategyConfig = {};
      const result = resolveUrl('https://api.example.com/${config.missing}/data', config);
      expect(result).toBe('https://api.example.com//data');
    });

    it('should replace unknown vars with empty string when no parent data', () => {
      const config: StrategyConfig = {};
      const result = resolveUrl('https://api.example.com/${unknown}', config);
      expect(result).toBe('https://api.example.com/');
    });

    it('should extract values from parent data', () => {
      const config: StrategyConfig = {};
      const parentData = [
        { symbol: 'ETH' },
        { symbol: 'BTC' },
      ];
      const result = resolveUrl('https://api.example.com/prices?symbols=${symbol}', config, parentData);
      expect(result).toBe('https://api.example.com/prices?symbols=ETH,BTC');
    });

    it('should prefer config value over parent data', () => {
      const config: StrategyConfig = { symbol: 'SOL' };
      const parentData = [{ symbol: 'ETH' }];
      const result = resolveUrl('https://api.example.com/${symbol}', config, parentData);
      expect(result).toBe('https://api.example.com/SOL');
    });

    it('should handle null/undefined parent data values', () => {
      const config: StrategyConfig = {};
      const parentData = [
        { symbol: 'ETH' },
        { symbol: null },
        { other: 'value' },
      ];
      const result = resolveUrl('https://api.example.com/${symbol}', config, parentData);
      expect(result).toBe('https://api.example.com/ETH');
    });

    it('should handle empty parent data array', () => {
      const config: StrategyConfig = {};
      const result = resolveUrl('https://api.example.com/${symbol}', config, []);
      expect(result).toBe('https://api.example.com/');
    });

    it('should handle multiple substitutions in one URL', () => {
      const config: StrategyConfig = { base: 'ETH', quote: 'USD' };
      const result = resolveUrl('https://api.example.com/${base}/${quote}', config);
      expect(result).toBe('https://api.example.com/ETH/USD');
    });

    it('should return URL unchanged when no template vars', () => {
      const config: StrategyConfig = {};
      const url = 'https://api.example.com/prices';
      expect(resolveUrl(url, config)).toBe(url);
    });
  });

  describe('resolvePath()', () => {
    it('should return root with $ path', () => {
      const data = { foo: 'bar' };
      expect(resolvePath(data, '$')).toEqual({ foo: 'bar' });
    });

    it('should resolve simple path', () => {
      const data = { name: 'Alice' };
      expect(resolvePath(data, '$.name')).toBe('Alice');
    });

    it('should resolve nested path', () => {
      const data = { data: { prices: { eth: 3000 } } };
      expect(resolvePath(data, '$.data.prices.eth')).toBe(3000);
    });

    it('should resolve array index', () => {
      const data = { items: ['a', 'b', 'c'] };
      expect(resolvePath(data, '$.items.1')).toBe('b');
    });

    it('should resolve nested array object', () => {
      const data = { results: [{ name: 'first' }, { name: 'second' }] };
      expect(resolvePath(data, '$.results.0.name')).toBe('first');
    });

    it('should return undefined for non-existent path', () => {
      const data = { foo: 'bar' };
      expect(resolvePath(data, '$.missing.deep')).toBeUndefined();
    });

    it('should return undefined when traversing null', () => {
      const data = { foo: null };
      expect(resolvePath(data, '$.foo.bar')).toBeUndefined();
    });

    it('should handle path without $ prefix', () => {
      const data = { name: 'test' };
      expect(resolvePath(data, 'name')).toBe('test');
    });

    it('should handle path with $. prefix', () => {
      const data = { a: { b: 42 } };
      expect(resolvePath(data, '$.a.b')).toBe(42);
    });
  });

  describe('applySelect()', () => {
    it('should extract items from nested path', () => {
      const data = { data: { tokens: [{ symbol: 'ETH' }, { symbol: 'BTC' }] } };
      const result = applySelect(data, { items: '$.data.tokens' });
      expect(result).toEqual([{ symbol: 'ETH' }, { symbol: 'BTC' }]);
    });

    it('should map fields from items', () => {
      const data = {
        data: [
          { symbol: 'ETH', price_usd: 3000, market_cap: 360e9 },
          { symbol: 'BTC', price_usd: 60000, market_cap: 1.2e12 },
        ],
      };
      const result = applySelect(data, {
        items: '$.data',
        name: '$.symbol',
        price: '$.price_usd',
      });
      expect(result).toEqual([
        { name: 'ETH', price: 3000 },
        { name: 'BTC', price: 60000 },
      ]);
    });

    it('should return raw items when no field selectors', () => {
      const data = [1, 2, 3];
      const result = applySelect(data, { items: '$' });
      expect(result).toEqual([1, 2, 3]);
    });

    it('should wrap non-array result as single-element array', () => {
      const data = { value: 42 };
      const result = applySelect(data, { items: '$.value' });
      expect(result).toEqual([42]);
    });

    it('should return empty array for null items path', () => {
      const data = { other: 'thing' };
      const result = applySelect(data, { items: '$.missing' });
      expect(result).toEqual([]);
    });

    it('should use root data when no items key in select', () => {
      const data = [{ a: 1 }, { a: 2 }];
      const result = applySelect(data, { val: '$.a' });
      expect(result).toEqual([{ val: 1 }, { val: 2 }]);
    });
  });

  describe('getAuthHeaders()', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('should return empty headers for auth=none', async () => {
      const source: SourceDef = { id: 'test', url: 'https://a.com', method: 'GET', auth: 'none' };
      const headers = await getAuthHeaders(source, 'app-1');
      expect(headers).toEqual({});
    });

    it('should return empty headers when auth is undefined', async () => {
      const source: SourceDef = { id: 'test', url: 'https://a.com', method: 'GET' };
      const headers = await getAuthHeaders(source, 'app-1');
      expect(headers).toEqual({});
    });

    it('should return empty headers when no key specified', async () => {
      const source: SourceDef = { id: 'test', url: 'https://a.com', method: 'GET', auth: 'bearer' };
      const headers = await getAuthHeaders(source, 'app-1');
      expect(headers).toEqual({});
    });

    it('should return Bearer auth header via REST API', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, value: 'my-api-key-123' }),
      }) as any;

      const source: SourceDef = {
        id: 'test', url: 'https://a.com', method: 'GET',
        auth: 'bearer', key: 'api_key',
      };
      const headers = await getAuthHeaders(source, 'app-1', 'test-token');
      expect(headers).toEqual({ Authorization: 'Bearer my-api-key-123' });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:4242/apps/app-1/apikey/api_key',
        {
          method: 'GET',
          headers: { 'Authorization': 'Bearer test-token' },
        },
      );
    });

    it('should return custom header auth with default header name', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, value: 'key-456' }),
      }) as any;

      const source: SourceDef = {
        id: 'test', url: 'https://a.com', method: 'GET',
        auth: 'header', key: 'api_key',
      };
      const headers = await getAuthHeaders(source, 'app-1', 'test-token');
      expect(headers).toEqual({ 'X-API-Key': 'key-456' });
    });

    it('should return custom header auth with specified header name', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, value: 'secret' }),
      }) as any;

      const source: SourceDef = {
        id: 'test', url: 'https://a.com', method: 'GET',
        auth: 'header', key: 'api_key', header: 'X-Custom-Auth',
      };
      const headers = await getAuthHeaders(source, 'app-1', 'test-token');
      expect(headers).toEqual({ 'X-Custom-Auth': 'secret' });
    });

    it('should handle missing key in API gracefully (empty string)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ success: false, error: 'API key not found' }),
      }) as any;

      const source: SourceDef = {
        id: 'test', url: 'https://a.com', method: 'GET',
        auth: 'bearer', key: 'missing_key',
      };
      const headers = await getAuthHeaders(source, 'app-1', 'test-token');
      expect(headers).toEqual({ Authorization: 'Bearer ' });
    });

    it('should use empty string when no token provided', async () => {
      const source: SourceDef = {
        id: 'test', url: 'https://a.com', method: 'GET',
        auth: 'bearer', key: 'api_key',
      };
      const headers = await getAuthHeaders(source, 'app-1');
      expect(headers).toEqual({ Authorization: 'Bearer ' });
    });
  });

  describe('fetchAllSources()', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it('should fetch independent sources in parallel', async () => {
      const callOrder: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        const id = url.includes('prices') ? 'prices' : 'news';
        callOrder.push(`start:${id}`);
        await new Promise(r => setTimeout(r, 10));
        callOrder.push(`end:${id}`);
        return {
          ok: true,
          json: async () => [{ id }],
        };
      }) as any;

      const manifest: StrategyManifest = {
        id: 'test',
        name: 'Test',
        ticker: 'standard',
        sources: [
          { id: 'prices', url: 'https://api.example.com/prices', method: 'GET' },
          { id: 'news', url: 'https://api.example.com/news', method: 'GET' },
        ],
        hooks: { tick: 'tick', execute: 'exec' },
        config: {},
        permissions: [],
      };

      const results = await fetchAllSources(manifest, manifest.config);

      expect(results.prices).toEqual([{ id: 'prices' }]);
      expect(results.news).toEqual([{ id: 'news' }]);
    });

    it('should fetch dependent sources after their parents', async () => {
      const callOrder: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('tokens')) {
          callOrder.push('tokens');
          return { ok: true, json: async () => [{ symbol: 'ETH' }] };
        }
        if (url.includes('ETH')) {
          callOrder.push('prices');
          return { ok: true, json: async () => [{ price: 3000 }] };
        }
        return { ok: true, json: async () => [] };
      }) as any;

      const manifest: StrategyManifest = {
        id: 'test',
        name: 'Test',
        ticker: 'standard',
        sources: [
          { id: 'tokens', url: 'https://api.example.com/tokens', method: 'GET' },
          { id: 'prices', url: 'https://api.example.com/prices/${symbol}', method: 'GET', depends: 'tokens' },
        ],
        hooks: { tick: 'tick', execute: 'exec' },
        config: {},
        permissions: [],
      };

      const results = await fetchAllSources(manifest, manifest.config);

      expect(callOrder).toEqual(['tokens', 'prices']);
      expect(results.tokens).toEqual([{ symbol: 'ETH' }]);
      expect(results.prices).toEqual([{ price: 3000 }]);
    });

    it('should return empty array for optional source failures', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        return { ok: false, status: 500 };
      }) as any;

      const manifest: StrategyManifest = {
        id: 'test',
        name: 'Test',
        ticker: 'standard',
        sources: [
          { id: 'optional', url: 'https://api.example.com/data', method: 'GET', optional: true },
        ],
        hooks: { tick: 'tick', execute: 'exec' },
        config: {},
        permissions: [],
      };

      const results = await fetchAllSources(manifest, manifest.config);
      expect(results.optional).toEqual([]);
    });

    it('should throw for non-optional source failures', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        return { ok: false, status: 500, statusText: 'Internal Server Error' };
      }) as any;

      const manifest: StrategyManifest = {
        id: 'test',
        name: 'Test',
        ticker: 'standard',
        sources: [
          { id: 'required', url: 'https://api.example.com/data', method: 'GET' },
        ],
        hooks: { tick: 'tick', execute: 'exec' },
        config: {},
        permissions: [],
      };

      await expect(fetchAllSources(manifest, manifest.config)).rejects.toThrow('returned 500');
    });

    it('should block source URL resolving to private IP', async () => {
      vi.mocked(validateExternalUrl).mockRejectedValue(new Error('Host "evil.com" resolves to private IP 10.0.0.1'));

      const manifest: StrategyManifest = {
        id: 'test',
        name: 'Test',
        ticker: 'standard',
        sources: [
          { id: 'data', url: 'https://evil.com/data', method: 'GET' },
        ],
        hooks: { tick: 'tick', execute: 'exec' },
        config: {},
        permissions: [],
      };

      await expect(fetchAllSources(manifest, manifest.config)).rejects.toThrow('private IP');
    });

    it('should call validateExternalUrl for external sources', async () => {
      vi.mocked(validateExternalUrl).mockResolvedValue(undefined);
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        return { ok: true, json: async () => [{ data: true }] };
      }) as any;

      const manifest: StrategyManifest = {
        id: 'test',
        name: 'Test',
        ticker: 'standard',
        sources: [
          { id: 'data', url: 'https://api.example.com/v1', method: 'GET' },
        ],
        hooks: { tick: 'tick', execute: 'exec' },
        config: {},
        permissions: [],
        allowedHosts: ['api.example.com'],
      };

      await fetchAllSources(manifest, manifest.config);
      expect(validateExternalUrl).toHaveBeenCalledWith('https://api.example.com/v1', ['api.example.com']);
    });

    it('should not call validateExternalUrl for internal sources', async () => {
      vi.mocked(validateExternalUrl).mockClear();
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        return { ok: true, json: async () => [{ data: true }] };
      }) as any;

      const manifest: StrategyManifest = {
        id: 'test',
        name: 'Test',
        ticker: 'standard',
        sources: [
          { id: 'wallets', url: '/wallets', method: 'GET' },
        ],
        hooks: { tick: 'tick', execute: 'exec' },
        config: {},
        permissions: [],
      };

      await fetchAllSources(manifest, manifest.config);
      expect(validateExternalUrl).not.toHaveBeenCalled();
    });

    it('should merge config overrides into source config', async () => {
      let capturedUrl = '';
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        capturedUrl = url;
        return { ok: true, json: async () => [{ data: true }] };
      }) as any;

      const manifest: StrategyManifest = {
        id: 'test',
        name: 'Test',
        ticker: 'standard',
        sources: [
          { id: 'data', url: 'https://api.example.com/${pair}', method: 'GET' },
        ],
        hooks: { tick: 'tick', execute: 'exec' },
        config: { pair: 'ETH-USD' },
        permissions: [],
      };

      await fetchAllSources(manifest, manifest.config, { pair: 'BTC-USD' });
      expect(capturedUrl).toBe('https://api.example.com/BTC-USD');
    });
  });
});
