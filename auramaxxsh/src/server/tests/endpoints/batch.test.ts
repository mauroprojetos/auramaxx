/**
 * Batch Endpoint Integration Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../setup';

// Mock token-search and token-safety to avoid real API calls
vi.mock('../../lib/token-search', () => ({
  searchTokens: vi.fn(),
  clearTokenSearchCache: vi.fn(),
}));

vi.mock('../../lib/token-safety', () => ({
  getTokenSafety: vi.fn(),
}));

import { searchTokens } from '../../lib/token-search';
import { getTokenSafety } from '../../lib/token-safety';

const mockedSearchTokens = vi.mocked(searchTokens);
const mockedGetTokenSafety = vi.mocked(getTokenSafety);

const app = createTestApp();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /batch', () => {
  // ── Validation Errors ──

  it('should return 400 for missing requests field', async () => {
    const res = await request(app)
      .post('/batch')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('must be an array');
  });

  it('should return 400 for empty requests array', async () => {
    const res = await request(app)
      .post('/batch')
      .send({ requests: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('must not be empty');
  });

  it('should return 400 for more than 20 requests', async () => {
    const requests = Array.from({ length: 21 }, (_, i) => ({
      id: `r${i}`,
      method: 'GET',
      path: '/health',
    }));

    const res = await request(app)
      .post('/batch')
      .send({ requests });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('exceeds maximum');
  });

  it('should return 400 for circular dependencies', async () => {
    const res = await request(app)
      .post('/batch')
      .send({
        requests: [
          { id: 'a', method: 'GET', path: '/health', dependsOn: 'b' },
          { id: 'b', method: 'GET', path: '/health', dependsOn: 'a' },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Circular dependency');
  });

  it('should return 400 for duplicate IDs', async () => {
    const res = await request(app)
      .post('/batch')
      .send({
        requests: [
          { id: 'a', method: 'GET', path: '/health' },
          { id: 'a', method: 'GET', path: '/health' },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Duplicate');
  });

  // ── Parallel Execution (No Dependencies) ──

  it('should execute independent requests in parallel', async () => {
    mockedSearchTokens.mockResolvedValue([
      { address: '0x6982', chain: 'ethereum', symbol: 'PEPE', name: 'Pepe' } as any,
    ]);

    const res = await request(app)
      .post('/batch')
      .send({
        requests: [
          { id: 'health', method: 'GET', path: '/health' },
          { id: 'search', method: 'GET', path: '/token/search?q=PEPE' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.responses.health.status).toBe(200);
    expect(res.body.responses.health.body.status).toBe('ok');
    expect(res.body.responses.search.status).toBe(200);
    expect(res.body.responses.search.body.success).toBe(true);
    expect(res.body.responses.search.body.results).toHaveLength(1);
  });

  // ── Dependency Chaining ──

  it('should chain search → safety via template resolution', async () => {
    mockedSearchTokens.mockResolvedValue([
      { address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', chain: 'ethereum', symbol: 'PEPE', name: 'Pepe' } as any,
    ]);
    mockedGetTokenSafety.mockResolvedValue({
      tokenName: 'Pepe',
      tokenSymbol: 'PEPE',
      isHoneypot: false,
    } as any);

    const res = await request(app)
      .post('/batch')
      .send({
        requests: [
          { id: 'search', method: 'GET', path: '/token/search?q=PEPE&limit=1' },
          {
            id: 'safety',
            method: 'GET',
            path: '/token/safety/${search.results.0.address}?chain=${search.results.0.chain}',
            dependsOn: 'search',
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.responses.search.status).toBe(200);
    expect(res.body.responses.safety.status).toBe(200);
    expect(res.body.responses.safety.body.safety.tokenSymbol).toBe('PEPE');

    // Verify the safety mock was called with resolved address
    expect(mockedGetTokenSafety).toHaveBeenCalledWith(
      '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
      'ethereum',
    );
  });

  // ── Failed Dependency → 424 ──

  it('should return 424 when dependency fails', async () => {
    mockedSearchTokens.mockResolvedValue([]);

    const res = await request(app)
      .post('/batch')
      .send({
        requests: [
          // This will return 400 since /token/search requires q param
          { id: 'search', method: 'GET', path: '/token/search' },
          {
            id: 'safety',
            method: 'GET',
            path: '/token/safety/${search.results.0.address}',
            dependsOn: 'search',
          },
        ],
      });

    expect(res.status).toBe(200); // Batch always returns 200
    expect(res.body.responses.search.status).toBe(400);
    expect(res.body.responses.safety.status).toBe(424);
    expect(res.body.responses.safety.body.error).toContain('Dependency "search" failed');
  });

  // ── Template Resolution Failure → 422 ──

  it('should return 422 when template reference fails', async () => {
    mockedSearchTokens.mockResolvedValue([]);

    const res = await request(app)
      .post('/batch')
      .send({
        requests: [
          { id: 'search', method: 'GET', path: '/token/search?q=PEPE' },
          {
            id: 'safety',
            method: 'GET',
            // results is empty, so results.0.address doesn't exist
            path: '/token/safety/${search.results.0.address}',
            dependsOn: 'search',
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.responses.search.status).toBe(200);
    expect(res.body.responses.safety.status).toBe(422);
    expect(res.body.responses.safety.body.error).toContain('Template resolution failed');
  });

  // ── Independent Requests Continue When Sibling Fails ──

  it('should execute independent requests even when a sibling fails', async () => {
    const res = await request(app)
      .post('/batch')
      .send({
        requests: [
          // This will fail (no q param)
          { id: 'bad', method: 'GET', path: '/token/search' },
          // This should still succeed
          { id: 'health', method: 'GET', path: '/health' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.responses.bad.status).toBe(400);
    expect(res.body.responses.health.status).toBe(200);
    expect(res.body.responses.health.body.status).toBe('ok');
  });

  // ── Meta / Timings ──

  it('should include timing metadata in response', async () => {
    const res = await request(app)
      .post('/batch')
      .send({
        requests: [
          { id: 'health', method: 'GET', path: '/health' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.total).toBe(1);
    expect(res.body.meta.succeeded).toBe(1);
    expect(res.body.meta.failed).toBe(0);
    expect(res.body.meta.timings.health).toBeGreaterThanOrEqual(0);
  });

  it('should count succeeded and failed correctly', async () => {
    const res = await request(app)
      .post('/batch')
      .send({
        requests: [
          { id: 'good', method: 'GET', path: '/health' },
          { id: 'bad', method: 'GET', path: '/token/search' }, // missing q
        ],
      });

    expect(res.body.meta.total).toBe(2);
    expect(res.body.meta.succeeded).toBe(1);
    expect(res.body.meta.failed).toBe(1);
  });

  // ── Template Resolution in Body ──

  it('should resolve templates in POST body', async () => {
    mockedSearchTokens.mockResolvedValue([
      { address: '0x6982', chain: 'ethereum', symbol: 'PEPE', name: 'Pepe' } as any,
    ]);

    const res = await request(app)
      .post('/batch')
      .send({
        requests: [
          { id: 'search', method: 'GET', path: '/token/search?q=PEPE&limit=1' },
          {
            id: 'lookup',
            method: 'GET',
            // Use the resolved address in a path
            path: '/token/safety/${search.results.0.address}?chain=${search.results.0.chain}',
            dependsOn: 'search',
          },
        ],
      });

    expect(res.status).toBe(200);
    // The search result address should have been interpolated into the safety path
    expect(mockedGetTokenSafety).toHaveBeenCalledWith('0x6982', 'ethereum');
  });

  // ── Edge Cases ──

  it('should handle a single request', async () => {
    const res = await request(app)
      .post('/batch')
      .send({
        requests: [
          { id: 'h', method: 'GET', path: '/health' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.responses.h.status).toBe(200);
    expect(res.body.meta.total).toBe(1);
  });

  it('should handle requests to nonexistent routes', async () => {
    const res = await request(app)
      .post('/batch')
      .send({
        requests: [
          { id: 'missing', method: 'GET', path: '/does-not-exist' },
        ],
      });

    expect(res.status).toBe(200);
    // Express returns 404 for unknown routes
    expect(res.body.responses.missing.status).toBe(404);
  });

  it('should handle parallel siblings depending on same parent', async () => {
    mockedSearchTokens.mockResolvedValue([
      { address: '0x6982', chain: 'ethereum', symbol: 'PEPE', name: 'Pepe' } as any,
    ]);
    mockedGetTokenSafety.mockResolvedValue({ tokenName: 'Pepe', isHoneypot: false } as any);

    const res = await request(app)
      .post('/batch')
      .send({
        requests: [
          { id: 's', method: 'GET', path: '/token/search?q=PEPE&limit=1' },
          {
            id: 'safety',
            method: 'GET',
            path: '/token/safety/${s.results.0.address}?chain=${s.results.0.chain}',
            dependsOn: 's',
          },
          {
            id: 'holders',
            method: 'GET',
            path: '/token/holders/${s.results.0.address}?chain=${s.results.0.chain}',
            dependsOn: 's',
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(3);
    // safety and holders should both execute (wave 1, parallel)
    expect(res.body.responses.safety.status).toBe(200);
    expect(res.body.responses.holders.status).toBe(200);
  });
});
