/**
 * Tests for strategy state manager
 *
 * Tests:
 * - getState — returns empty object for new, returns existing
 * - updateState — merges correctly
 * - persistState / restoreState round-trip (mock fetch)
 * - getConfigOverrides / setConfigOverrides (mock fetch)
 * - persistAllStates
 * - setToken / clearToken — token gating
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getState, updateState, persistState, restoreState, getConfigOverrides, setConfigOverrides, persistAllStates, setToken, clearToken } from '../../../lib/strategy/state';

describe('Strategy State', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('getState()', () => {
    it('should return empty object for new strategy', () => {
      const state = getState('brand-new-strategy-' + Date.now());
      expect(state).toEqual({});
    });

    it('should return same object reference on multiple calls', () => {
      const id = 'same-ref-test-' + Date.now();
      const s1 = getState(id);
      const s2 = getState(id);
      expect(s1).toBe(s2);
    });

    it('should return different objects for different strategies', () => {
      const s1 = getState('strategy-a-' + Date.now());
      const s2 = getState('strategy-b-' + Date.now());
      expect(s1).not.toBe(s2);
    });
  });

  describe('updateState()', () => {
    it('should merge updates into existing state', () => {
      const id = 'merge-test-' + Date.now();
      getState(id);
      updateState(id, { a: 1 });
      updateState(id, { b: 2 });
      const state = getState(id);
      expect(state).toEqual({ a: 1, b: 2 });
    });

    it('should overwrite existing keys', () => {
      const id = 'overwrite-test-' + Date.now();
      updateState(id, { x: 'old' });
      updateState(id, { x: 'new' });
      expect(getState(id).x).toBe('new');
    });

    it('should preserve existing keys when adding new ones', () => {
      const id = 'preserve-test-' + Date.now();
      updateState(id, { a: 1, b: 2 });
      updateState(id, { c: 3 });
      const state = getState(id);
      expect(state).toEqual({ a: 1, b: 2, c: 3 });
    });

    it('should create state if it did not exist', () => {
      const id = 'create-test-' + Date.now();
      updateState(id, { initialized: true });
      const state = getState(id);
      expect(state.initialized).toBe(true);
    });
  });

  describe('persistState()', () => {
    it('should call PUT /apps/:id/storage/_strategy_state with Bearer token', async () => {
      const id = 'persist-test-' + Date.now();
      const token = 'test-token-123';
      setToken(id, token);
      updateState(id, { board: [1, 2, 3] });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      }) as any;

      await persistState(id);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `http://127.0.0.1:4242/apps/${id}/storage/_strategy_state`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ value: { board: [1, 2, 3] } }),
        },
      );

      clearToken(id);
    });

    it('should skip if no state exists', async () => {
      globalThis.fetch = vi.fn() as any;
      await persistState('nonexistent-no-state-' + Date.now());
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should skip and log error if no token set', async () => {
      const id = 'no-token-persist-' + Date.now();
      updateState(id, { x: 1 });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      globalThis.fetch = vi.fn() as any;

      await persistState(id);

      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('no token set'));

      consoleSpy.mockRestore();
    });
  });

  describe('restoreState()', () => {
    it('should call GET /apps/:id/storage/_strategy_state with Bearer token', async () => {
      const id = 'restore-test-' + Date.now();
      const token = 'test-token-456';
      setToken(id, token);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          value: { positions: [{ token: 'abc' }] },
        }),
      }) as any;

      await restoreState(id);
      const state = getState(id);
      expect(state.positions).toEqual([{ token: 'abc' }]);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `http://127.0.0.1:4242/apps/${id}/storage/_strategy_state`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` },
        },
      );

      clearToken(id);
    });

    it('should handle 404 (no stored state) gracefully', async () => {
      const id = 'no-db-row-' + Date.now();
      const token = 'test-token-789';
      setToken(id, token);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ success: false, error: 'Key not found' }),
      }) as any;

      await restoreState(id);
      expect(getState(id)).toBeDefined();

      clearToken(id);
    });

    it('should handle string value (double-stringified) gracefully', async () => {
      const id = 'string-val-' + Date.now();
      const token = 'test-token-str';
      setToken(id, token);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          value: JSON.stringify({ count: 42 }),
        }),
      }) as any;

      await restoreState(id);
      const state = getState(id);
      expect(state).toEqual({ count: 42 });

      clearToken(id);
    });

    it('should skip and log error if no token set', async () => {
      const id = 'no-token-restore-' + Date.now();

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      globalThis.fetch = vi.fn() as any;

      await restoreState(id);

      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('no token set'));

      consoleSpy.mockRestore();
    });
  });

  describe('persistState / restoreState round-trip', () => {
    it('should persist and restore complex state correctly', async () => {
      const id = 'roundtrip-' + Date.now();
      const token = 'roundtrip-token';
      setToken(id, token);
      const originalState = { positions: [{ symbol: 'ETH', amount: 1.5 }], lastTick: 9999 };

      updateState(id, originalState);

      // Capture what persistState sends
      let savedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        if (opts.method === 'PUT') {
          savedBody = JSON.parse(opts.body);
          return { ok: true, json: async () => ({ success: true }) };
        }
        // GET — return what was saved
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, value: savedBody.value }),
        };
      }) as any;

      await persistState(id);
      await restoreState(id);
      const restored = getState(id);

      expect(restored).toEqual(originalState);

      clearToken(id);
    });
  });

  describe('getConfigOverrides()', () => {
    it('should return overrides from REST API', async () => {
      const id = 'cfg-' + Date.now();
      const token = 'cfg-token';
      setToken(id, token);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          value: { mode: 'live', approve: true },
        }),
      }) as any;

      const overrides = await getConfigOverrides(id);
      expect(overrides).toEqual({ mode: 'live', approve: true });

      clearToken(id);
    });

    it('should return null if no overrides exist (404)', async () => {
      const id = 'no-cfg-' + Date.now();
      const token = 'no-cfg-token';
      setToken(id, token);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ success: false, error: 'Key not found' }),
      }) as any;

      const overrides = await getConfigOverrides(id);
      expect(overrides).toBeNull();

      clearToken(id);
    });

    it('should return null if no token set', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const overrides = await getConfigOverrides('no-token-cfg-' + Date.now());
      expect(overrides).toBeNull();
      consoleSpy.mockRestore();
    });
  });

  describe('setConfigOverrides()', () => {
    it('should call PUT /apps/:id/storage/_strategy_config', async () => {
      const id = 'cfg-write-' + Date.now();
      const token = 'cfg-write-token';
      setToken(id, token);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      }) as any;

      await setConfigOverrides(id, { mode: 'paper' });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `http://127.0.0.1:4242/apps/${id}/storage/_strategy_config`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ value: { mode: 'paper' } }),
        },
      );

      clearToken(id);
    });
  });

  describe('persistAllStates()', () => {
    it('should persist all states that have tokens', async () => {
      const ts = Date.now();
      const id1 = 'all-1-' + ts;
      const id2 = 'all-2-' + ts;

      setToken(id1, 'token-1');
      setToken(id2, 'token-2');
      updateState(id1, { x: 1 });
      updateState(id2, { y: 2 });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      }) as any;

      await persistAllStates();

      // Should have called fetch for each state that has a token
      expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThanOrEqual(2);

      clearToken(id1);
      clearToken(id2);
    });
  });
});
