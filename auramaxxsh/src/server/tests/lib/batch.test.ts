/**
 * Unit tests for batch execution engine (server/lib/batch.ts)
 */
import { describe, it, expect } from 'vitest';
import {
  validateBatchRequest,
  buildWaves,
  resolveTemplates,
  resolveBodyTemplates,
  type BatchSubRequest,
  type BatchResponse,
} from '../../lib/batch';

// ── Validation ──

describe('validateBatchRequest', () => {
  it('should accept a valid request with no dependencies', () => {
    const result = validateBatchRequest([
      { id: 'a', method: 'GET', path: '/health' },
      { id: 'b', method: 'POST', path: '/send', body: { to: '0x123' } },
    ]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.waves).toEqual([['a', 'b']]);
    }
  });

  it('should accept a valid request with dependencies', () => {
    const result = validateBatchRequest([
      { id: 'search', method: 'GET', path: '/token/search?q=PEPE' },
      { id: 'safety', method: 'GET', path: '/token/safety/${search.results.0.address}', dependsOn: 'search' },
    ]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.waves).toEqual([['search'], ['safety']]);
    }
  });

  it('should reject non-array input', () => {
    const result = validateBatchRequest('not an array');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe('requests must be an array');
  });

  it('should reject empty array', () => {
    const result = validateBatchRequest([]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('must not be empty');
  });

  it('should reject more than 20 items', () => {
    const requests = Array.from({ length: 21 }, (_, i) => ({
      id: `r${i}`,
      method: 'GET',
      path: '/health',
    }));
    const result = validateBatchRequest(requests);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('exceeds maximum');
  });

  it('should reject duplicate IDs', () => {
    const result = validateBatchRequest([
      { id: 'a', method: 'GET', path: '/health' },
      { id: 'a', method: 'GET', path: '/health' },
    ]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('Duplicate request id: a');
  });

  it('should reject missing dependsOn target', () => {
    const result = validateBatchRequest([
      { id: 'a', method: 'GET', path: '/health', dependsOn: 'nonexistent' },
    ]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('unknown request "nonexistent"');
  });

  it('should reject self-dependency', () => {
    const result = validateBatchRequest([
      { id: 'a', method: 'GET', path: '/health', dependsOn: 'a' },
    ]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('cannot depend on itself');
  });

  it('should reject circular dependencies (A→B→A)', () => {
    const result = validateBatchRequest([
      { id: 'a', method: 'GET', path: '/health', dependsOn: 'b' },
      { id: 'b', method: 'GET', path: '/health', dependsOn: 'a' },
    ]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('Circular dependency');
  });

  it('should reject invalid methods', () => {
    const result = validateBatchRequest([
      { id: 'a', method: 'PATCH', path: '/health' },
    ]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('Invalid method');
  });

  it('should reject paths not starting with /', () => {
    const result = validateBatchRequest([
      { id: 'a', method: 'GET', path: 'health' },
    ]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('Path must start with /');
  });

  it('should reject missing id', () => {
    const result = validateBatchRequest([
      { method: 'GET', path: '/health' },
    ]);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('non-empty string id');
  });

  it('should accept all valid HTTP methods', () => {
    const result = validateBatchRequest([
      { id: 'a', method: 'GET', path: '/health' },
      { id: 'b', method: 'POST', path: '/send' },
      { id: 'c', method: 'PUT', path: '/update' },
      { id: 'd', method: 'DELETE', path: '/remove' },
    ]);
    expect(result.valid).toBe(true);
  });

  it('should accept exactly 20 items', () => {
    const requests = Array.from({ length: 20 }, (_, i) => ({
      id: `r${i}`,
      method: 'GET',
      path: '/health',
    }));
    const result = validateBatchRequest(requests);
    expect(result.valid).toBe(true);
  });
});

// ── Wave Building ──

describe('buildWaves', () => {
  it('should put all independent requests in wave 0', () => {
    const requests: BatchSubRequest[] = [
      { id: 'a', method: 'GET', path: '/a' },
      { id: 'b', method: 'GET', path: '/b' },
      { id: 'c', method: 'GET', path: '/c' },
    ];
    const waves = buildWaves(requests);
    expect(waves).toEqual([['a', 'b', 'c']]);
  });

  it('should create a chain of waves for sequential dependencies', () => {
    const requests: BatchSubRequest[] = [
      { id: 'a', method: 'GET', path: '/a' },
      { id: 'b', method: 'GET', path: '/b', dependsOn: 'a' },
      { id: 'c', method: 'GET', path: '/c', dependsOn: 'b' },
    ];
    const waves = buildWaves(requests);
    expect(waves).toEqual([['a'], ['b'], ['c']]);
  });

  it('should handle diamond dependency shape', () => {
    // a → b, a → c, b → d, c → d
    const requests: BatchSubRequest[] = [
      { id: 'a', method: 'GET', path: '/a' },
      { id: 'b', method: 'GET', path: '/b', dependsOn: 'a' },
      { id: 'c', method: 'GET', path: '/c', dependsOn: 'a' },
      { id: 'd', method: 'GET', path: '/d', dependsOn: 'b' }, // d depends on b (wave 2)
    ];
    const waves = buildWaves(requests);
    expect(waves).toHaveLength(3);
    expect(waves[0]).toEqual(['a']);
    expect(waves[1]).toContain('b');
    expect(waves[1]).toContain('c');
    expect(waves[2]).toEqual(['d']);
  });

  it('should handle parallel siblings with shared parent', () => {
    const requests: BatchSubRequest[] = [
      { id: 'parent', method: 'GET', path: '/parent' },
      { id: 'child1', method: 'GET', path: '/c1', dependsOn: 'parent' },
      { id: 'child2', method: 'GET', path: '/c2', dependsOn: 'parent' },
      { id: 'child3', method: 'GET', path: '/c3', dependsOn: 'parent' },
    ];
    const waves = buildWaves(requests);
    expect(waves).toEqual([['parent'], ['child1', 'child2', 'child3']]);
  });

  it('should handle mixed independent and dependent requests', () => {
    const requests: BatchSubRequest[] = [
      { id: 'a', method: 'GET', path: '/a' },
      { id: 'b', method: 'GET', path: '/b' },
      { id: 'c', method: 'GET', path: '/c', dependsOn: 'a' },
    ];
    const waves = buildWaves(requests);
    expect(waves).toHaveLength(2);
    expect(waves[0]).toContain('a');
    expect(waves[0]).toContain('b');
    expect(waves[1]).toEqual(['c']);
  });
});

// ── Template Resolution ──

describe('resolveTemplates', () => {
  const makeResponses = (): Map<string, BatchResponse> => {
    const map = new Map<string, BatchResponse>();
    map.set('search', {
      status: 200,
      body: {
        success: true,
        query: 'PEPE',
        results: [
          { address: '0x6982', chain: 'ethereum', symbol: 'PEPE' },
          { address: '0xaaaa', chain: 'base', symbol: 'PEPE2' },
        ],
      },
    });
    map.set('wallets', {
      status: 200,
      body: {
        wallets: [{ address: '0xMyWallet' }],
      },
    });
    return map;
  };

  it('should resolve a simple template reference', () => {
    const responses = makeResponses();
    const result = resolveTemplates('${search.query}', responses);
    expect(result).toBe('PEPE');
  });

  it('should resolve nested path with array index', () => {
    const responses = makeResponses();
    const result = resolveTemplates('${search.results.0.address}', responses);
    expect(result).toBe('0x6982');
  });

  it('should resolve second array element', () => {
    const responses = makeResponses();
    const result = resolveTemplates('${search.results.1.chain}', responses);
    expect(result).toBe('base');
  });

  it('should resolve multiple templates in one string', () => {
    const responses = makeResponses();
    const result = resolveTemplates(
      '/token/safety/${search.results.0.address}?chain=${search.results.0.chain}',
      responses,
    );
    expect(result).toBe('/token/safety/0x6982?chain=ethereum');
  });

  it('should passthrough strings with no templates', () => {
    const responses = makeResponses();
    const result = resolveTemplates('/health', responses);
    expect(result).toBe('/health');
  });

  it('should throw for unknown request ID', () => {
    const responses = makeResponses();
    expect(() => resolveTemplates('${unknown.field}', responses)).toThrow(
      'request "unknown" not found',
    );
  });

  it('should throw for missing path in response', () => {
    const responses = makeResponses();
    expect(() => resolveTemplates('${search.nonexistent}', responses)).toThrow(
      'path not found',
    );
  });

  it('should throw for accessing property on non-object', () => {
    const responses = makeResponses();
    expect(() => resolveTemplates('${search.query.nested}', responses)).toThrow();
  });

  it('should handle null values in response', () => {
    const responses = new Map<string, BatchResponse>();
    responses.set('r', { status: 200, body: { value: null } });
    const result = resolveTemplates('${r.value}', responses);
    expect(result).toBe('null');
  });

  it('should handle numeric values', () => {
    const responses = new Map<string, BatchResponse>();
    responses.set('r', { status: 200, body: { count: 42 } });
    const result = resolveTemplates('${r.count}', responses);
    expect(result).toBe('42');
  });

  it('should handle boolean values', () => {
    const responses = new Map<string, BatchResponse>();
    responses.set('r', { status: 200, body: { active: true } });
    const result = resolveTemplates('${r.active}', responses);
    expect(result).toBe('true');
  });
});

// ── Body Template Resolution ──

describe('resolveBodyTemplates', () => {
  const makeResponses = (): Map<string, BatchResponse> => {
    const map = new Map<string, BatchResponse>();
    map.set('search', {
      status: 200,
      body: {
        results: [{ address: '0x6982', chain: 'ethereum' }],
      },
    });
    return map;
  };

  it('should resolve string values in a flat object', () => {
    const responses = makeResponses();
    const body = { token: '${search.results.0.address}', amount: '100' };
    const result = resolveBodyTemplates(body, responses);
    expect(result).toEqual({ token: '0x6982', amount: '100' });
  });

  it('should resolve string values in nested objects', () => {
    const responses = makeResponses();
    const body = { config: { chain: '${search.results.0.chain}' } };
    const result = resolveBodyTemplates(body, responses);
    expect(result).toEqual({ config: { chain: 'ethereum' } });
  });

  it('should leave non-string values unchanged', () => {
    const responses = makeResponses();
    const body = { count: 42, active: true, ratio: 3.14, items: null as any };
    const result = resolveBodyTemplates(body, responses);
    expect(result).toEqual({ count: 42, active: true, ratio: 3.14, items: null });
  });

  it('should handle arrays in body', () => {
    const responses = makeResponses();
    const body = { addresses: ['${search.results.0.address}', '0xstatic'] };
    const result = resolveBodyTemplates(body, responses);
    expect(result).toEqual({ addresses: ['0x6982', '0xstatic'] });
  });

  it('should return null/undefined unchanged', () => {
    const responses = makeResponses();
    expect(resolveBodyTemplates(null, responses)).toBe(null);
    expect(resolveBodyTemplates(undefined, responses)).toBe(undefined);
  });

  it('should return primitive values unchanged', () => {
    const responses = makeResponses();
    expect(resolveBodyTemplates(42, responses)).toBe(42);
    expect(resolveBodyTemplates(true, responses)).toBe(true);
  });

  it('should resolve a bare string', () => {
    const responses = makeResponses();
    const result = resolveBodyTemplates('${search.results.0.address}', responses);
    expect(result).toBe('0x6982');
  });
});
