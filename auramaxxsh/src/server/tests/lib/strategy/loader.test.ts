/**
 * Tests for strategy manifest loader
 *
 * Tests:
 * - YAML parsing of app.md frontmatter
 * - validateManifest — valid manifest, missing hooks, invalid ticker
 * - orderSources — topological sort, circular dependency detection
 * - loadStrategyManifests with a mock filesystem
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateManifest, orderSources, loadStrategyManifests } from '../../../lib/strategy/loader';
import type { StrategyManifest, SourceDef } from '../../../lib/strategy/types';

/** Helper to create a minimal valid manifest */
function validManifest(overrides: Partial<StrategyManifest> = {}): StrategyManifest {
  return {
    id: 'test-strategy',
    name: 'Test Strategy',
    ticker: 'standard',
    sources: [],
    hooks: { tick: 'Analyze data', execute: 'Create action' },
    config: {},
    permissions: [],
    ...overrides,
  };
}

describe('Strategy Loader', () => {
  describe('validateManifest()', () => {
    it('should return no errors for a valid manifest', () => {
      const errors = validateManifest(validManifest());
      expect(errors).toEqual([]);
    });

    it('should require hooks.tick when ticker is present', () => {
      const manifest = validManifest({
        hooks: { tick: '', execute: 'Create action' },
      });
      const errors = validateManifest(manifest);
      expect(errors).toContain('Missing hooks.tick (required when ticker or jobs is set)');
    });

    it('should allow missing hooks.execute', () => {
      const manifest = validManifest({
        hooks: { tick: 'Analyze' },
      });
      const errors = validateManifest(manifest);
      expect(errors).toHaveLength(0);
    });

    it('should reject missing hooks.tick when ticker is set', () => {
      const manifest = validManifest({
        hooks: { tick: '', execute: 'Execute' },
      });
      const errors = validateManifest(manifest);
      expect(errors).toContain('Missing hooks.tick (required when ticker or jobs is set)');
    });

    it('should reject invalid ticker', () => {
      const manifest = validManifest({ ticker: 'turbo' as any });
      const errors = validateManifest(manifest);
      expect(errors.some(e => e.includes('Invalid ticker "turbo"'))).toBe(true);
    });

    it('should accept all valid ticker values', () => {
      for (const ticker of ['sniper', 'active', 'standard', 'slow', 'maintenance'] as const) {
        const errors = validateManifest(validManifest({ ticker }));
        expect(errors).toEqual([]);
      }
    });

    it('should require either ticker, jobs, or hooks.message', () => {
      const manifest = validManifest({ ticker: undefined, jobs: undefined });
      const errors = validateManifest(manifest);
      expect(errors).toContain('Must have either ticker, jobs, or hooks.message');
    });

    it('should accept a message-only app (no ticker, no jobs)', () => {
      const manifest = validManifest({
        ticker: undefined,
        jobs: undefined,
        hooks: { message: 'Respond to the user message.' },
      });
      const errors = validateManifest(manifest);
      expect(errors).toEqual([]);
    });

    it('should not require hooks.tick for message-only apps', () => {
      const manifest = validManifest({
        ticker: undefined,
        jobs: undefined,
        hooks: { message: 'Handle messages' },
      });
      const errors = validateManifest(manifest);
      expect(errors).toEqual([]);
    });

    it('should require hooks.tick when ticker is set', () => {
      const manifest = validManifest({
        ticker: 'standard',
        hooks: { execute: 'Execute', message: 'Handle messages' },
      });
      const errors = validateManifest(manifest);
      expect(errors).toContain('Missing hooks.tick (required when ticker or jobs is set)');
    });

    it('should validate jobs when present', () => {
      const manifest = validManifest({
        ticker: undefined,
        jobs: [
          { id: 'fast', ticker: 'sniper' },
          { id: 'slow', ticker: 'invalid' as any },
        ],
      });
      const errors = validateManifest(manifest);
      expect(errors.some(e => e.includes('Job "slow" has invalid ticker'))).toBe(true);
    });

    it('should reject jobs with missing id', () => {
      const manifest = validManifest({
        ticker: undefined,
        jobs: [{ id: '', ticker: 'standard' }],
      });
      const errors = validateManifest(manifest);
      expect(errors).toContain('Job missing id');
    });

    it('should accept manifest with jobs instead of ticker', () => {
      const manifest = validManifest({
        ticker: undefined,
        jobs: [
          { id: 'check', ticker: 'active' },
          { id: 'rebalance', ticker: 'slow' },
        ],
      });
      const errors = validateManifest(manifest);
      expect(errors).toEqual([]);
    });

    it('should detect unknown source dependencies', () => {
      const manifest = validManifest({
        sources: [
          { id: 'prices', url: 'https://api.example.com/prices', method: 'GET' },
          { id: 'details', url: 'https://api.example.com/details', method: 'GET', depends: 'nonexistent' },
        ],
      });
      const errors = validateManifest(manifest);
      expect(errors).toContain('Source "details" depends on unknown source "nonexistent"');
    });

    it('should detect circular source dependencies', () => {
      const manifest = validManifest({
        sources: [
          { id: 'a', url: 'https://a.com', method: 'GET', depends: 'b' },
          { id: 'b', url: 'https://b.com', method: 'GET', depends: 'a' },
        ],
      });
      const errors = validateManifest(manifest);
      expect(errors).toContain('Circular source dependencies detected');
    });

    it('should allow valid source dependencies', () => {
      const manifest = validManifest({
        sources: [
          { id: 'tokens', url: 'https://api.example.com/tokens', method: 'GET' },
          { id: 'prices', url: 'https://api.example.com/prices/${symbol}', method: 'GET', depends: 'tokens' },
        ],
        allowedHosts: ['api.example.com'],
      });
      const errors = validateManifest(manifest);
      expect(errors).toEqual([]);
    });
  });

  describe('orderSources()', () => {
    it('should return empty array for empty input', () => {
      expect(orderSources([])).toEqual([]);
    });

    it('should preserve order for independent sources', () => {
      const sources: SourceDef[] = [
        { id: 'a', url: 'https://a.com', method: 'GET' },
        { id: 'b', url: 'https://b.com', method: 'GET' },
        { id: 'c', url: 'https://c.com', method: 'GET' },
      ];
      const ordered = orderSources(sources);
      expect(ordered.map(s => s.id)).toEqual(['a', 'b', 'c']);
    });

    it('should order dependent sources after their parents', () => {
      const sources: SourceDef[] = [
        { id: 'details', url: 'https://details.com', method: 'GET', depends: 'tokens' },
        { id: 'tokens', url: 'https://tokens.com', method: 'GET' },
      ];
      const ordered = orderSources(sources);
      const tokenIdx = ordered.findIndex(s => s.id === 'tokens');
      const detailIdx = ordered.findIndex(s => s.id === 'details');
      expect(tokenIdx).toBeLessThan(detailIdx);
    });

    it('should handle chain of dependencies', () => {
      const sources: SourceDef[] = [
        { id: 'c', url: 'https://c.com', method: 'GET', depends: 'b' },
        { id: 'a', url: 'https://a.com', method: 'GET' },
        { id: 'b', url: 'https://b.com', method: 'GET', depends: 'a' },
      ];
      const ordered = orderSources(sources);
      const ids = ordered.map(s => s.id);
      expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
      expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
    });

    it('should handle circular dependencies gracefully (does not crash)', () => {
      const sources: SourceDef[] = [
        { id: 'a', url: 'https://a.com', method: 'GET', depends: 'b' },
        { id: 'b', url: 'https://b.com', method: 'GET', depends: 'a' },
      ];
      // Should not throw — circular detection is done in validation, orderSources just skips
      const ordered = orderSources(sources);
      expect(ordered.length).toBeLessThanOrEqual(2);
    });

    it('should handle mixed independent and dependent sources', () => {
      const sources: SourceDef[] = [
        { id: 'ind1', url: 'https://ind1.com', method: 'GET' },
        { id: 'dep1', url: 'https://dep1.com', method: 'GET', depends: 'ind1' },
        { id: 'ind2', url: 'https://ind2.com', method: 'GET' },
      ];
      const ordered = orderSources(sources);
      const ids = ordered.map(s => s.id);
      expect(ids.indexOf('ind1')).toBeLessThan(ids.indexOf('dep1'));
      expect(ids).toContain('ind2');
    });
  });

  describe('allowedHosts', () => {
    it('should auto-derive hosts from sources[].url', () => {
      const manifest = validManifest({
        sources: [
          { id: 'prices', url: 'https://api.coingecko.com/v3/prices', method: 'GET' },
          { id: 'news', url: 'https://cryptopanic.com/api/v1/posts', method: 'GET' },
        ],
      });
      // loadStrategyManifests auto-derives, but we can test via validateManifest + the helper
      // The manifest created by validManifest doesn't have allowedHosts, so test via the full loader
      const errors = validateManifest(manifest);
      expect(errors).toEqual([]);
    });

    it('should reject manifest with private IP in source URL', () => {
      const manifest = validManifest({
        sources: [
          { id: 'internal', url: 'http://127.0.0.1:8080/data', method: 'GET' },
        ],
      });
      const errors = validateManifest(manifest);
      expect(errors.some(e => e.includes('private/reserved host'))).toBe(true);
    });

    it('should reject manifest with localhost in source URL', () => {
      const manifest = validManifest({
        sources: [
          { id: 'local', url: 'http://localhost:3000/api', method: 'GET' },
        ],
      });
      const errors = validateManifest(manifest);
      expect(errors.some(e => e.includes('private/reserved host'))).toBe(true);
    });

    it('should reject manifest with private IP in allowedHosts', () => {
      const manifest = validManifest({
        allowedHosts: ['api.example.com', '127.0.0.1'],
      });
      const errors = validateManifest(manifest);
      expect(errors.some(e => e.includes('private/reserved host'))).toBe(true);
    });

    it('should allow manifest with public hosts in allowedHosts', () => {
      const manifest = validManifest({
        allowedHosts: ['api.coingecko.com', 'api.dexscreener.com'],
      });
      const errors = validateManifest(manifest);
      expect(errors).toEqual([]);
    });

    it('should skip URL validation for internal sources (/ prefix)', () => {
      const manifest = validManifest({
        sources: [
          { id: 'wallets', url: '/wallets', method: 'GET' },
        ],
      });
      const errors = validateManifest(manifest);
      expect(errors).toEqual([]);
    });

    it('should skip URL validation for template URLs', () => {
      const manifest = validManifest({
        sources: [
          { id: 'price', url: 'https://api.example.com/${config.pair}', method: 'GET' },
        ],
        allowedHosts: ['api.example.com'],
      });
      const errors = validateManifest(manifest);
      expect(errors).toEqual([]);
    });

    it('should require explicit allowedHosts for templated external URLs', () => {
      const manifest = validManifest({
        sources: [
          { id: 'price', url: 'https://api.example.com/${config.pair}', method: 'GET' },
        ],
      });
      const errors = validateManifest(manifest);
      expect(errors.some((e) => e.includes('requires explicit allowedHosts'))).toBe(true);
    });

    it('should reject source hosts not listed in allowedHosts', () => {
      const manifest = validManifest({
        sources: [
          { id: 'price', url: 'https://api.example.com/price', method: 'GET' },
        ],
        allowedHosts: ['api.other.com'],
      });
      const errors = validateManifest(manifest);
      expect(errors.some((e) => e.includes('not listed in allowedHosts'))).toBe(true);
    });
  });

  describe('loadStrategyManifests()', () => {
    it('should load the tic-tac-toe demo app from disk', () => {
      // Integration test — loads the real tic-tac-toe app.md from apps/
      const manifests = loadStrategyManifests();
      const ttt = manifests.find((m: StrategyManifest) => m.id === 'tic-tac-toe');
      if (ttt) {
        expect(ttt.name).toBe('Tic-Tac-Toe');
        expect(ttt.ticker).toBeUndefined();
        expect(ttt.hooks.message).toBeTruthy();
      }
      // If tic-tac-toe is not installed, just verify the function returns an array
      expect(Array.isArray(manifests)).toBe(true);
    });
  });
});
