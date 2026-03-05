/**
 * Tests for strategy tick runner
 *
 * Tests:
 * - Pre-computed action: intent with `action` → execute hook skipped
 * - Pre-computed action: intent without `action` → execute hook called
 * - Per-action token: intent with `permissions` → requestActionToken called, temp token used
 * - Per-action token: rejection → intent skipped, others still process
 * - Backwards compat: config.approve without intent.permissions → batch approval
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before import
vi.mock('../../../lib/strategy/sources', () => ({
  fetchAllSources: vi.fn().mockResolvedValue({ feed: [{ token: '0xABC' }] }),
}));

vi.mock('../../../lib/strategy/hooks', () => ({
  callHook: vi.fn().mockResolvedValue({ intents: [], state: {} }),
}));

vi.mock('../../../lib/strategy/executor', () => ({
  executeAction: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../../lib/strategy/state', () => ({
  getState: vi.fn().mockReturnValue({}),
  updateState: vi.fn(),
  getConfigOverrides: vi.fn().mockResolvedValue({}),
  restoreState: vi.fn().mockResolvedValue(undefined),
  persistState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/strategy/engine', () => ({
  requestHumanApproval: vi.fn().mockResolvedValue(true),
  requestActionToken: vi.fn().mockResolvedValue({ approved: true, token: 'temp-scoped-token' }),
}));

vi.mock('../../../lib/events', () => ({
  emitWalletEvent: vi.fn(),
}));

vi.mock('../../../lib/strategy/emits', () => ({
  processEmits: vi.fn(),
}));

import { processIntents } from '../../../lib/strategy/tick';
import { callHook } from '../../../lib/strategy/hooks';
import { executeAction } from '../../../lib/strategy/executor';
import { requestHumanApproval, requestActionToken } from '../../../lib/strategy/engine';
import type { StrategyManifest, StrategyConfig, Intent } from '../../../lib/strategy/types';

function makeManifest(overrides: Partial<StrategyManifest> = {}): StrategyManifest {
  return {
    id: 'test-strategy',
    name: 'Test',
    sources: [],
    hooks: { execute: 'Build API call', result: 'Update state' },
    config: {},
    permissions: [],
    ...overrides,
  };
}

describe('processIntents()', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: execute hook returns an action
    vi.mocked(callHook).mockImplementation(async (_manifest, hookName, _ctx) => {
      if (hookName === 'execute') {
        return {
          intents: [{ type: 'action', endpoint: '/swap', method: 'POST', body: { amount: '0.01' } }],
          state: {},
        };
      }
      if (hookName === 'result') {
        return { intents: [], state: {} };
      }
      return { intents: [], state: {} };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('pre-computed action', () => {
    it('should skip execute hook when intent has action field', async () => {
      const manifest = makeManifest();
      const intents: Intent[] = [{
        type: 'snipe',
        action: {
          endpoint: '/swap',
          method: 'POST',
          body: { tokenIn: 'ETH', tokenOut: '0xABC', amountIn: '0.005' },
        },
      }];

      await processIntents(manifest, intents, {}, 'strategy-token');

      // execute hook should NOT be called
      expect(callHook).not.toHaveBeenCalledWith(
        expect.anything(),
        'execute',
        expect.anything(),
      );

      // executeAction should be called with the pre-computed action
      expect(executeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: '/swap',
          method: 'POST',
          body: { tokenIn: 'ETH', tokenOut: '0xABC', amountIn: '0.005' },
        }),
        'test-strategy',
        'strategy-token',
        undefined,
      );
    });

    it('should call execute hook when intent has no action field', async () => {
      const manifest = makeManifest();
      const intents: Intent[] = [{ type: 'buy', token: 'SOL' }];

      await processIntents(manifest, intents, {}, 'strategy-token');

      expect(callHook).toHaveBeenCalledWith(
        manifest,
        'execute',
        expect.objectContaining({ intent: intents[0] }),
      );
    });

    it('should skip intent when no action field and no execute hook', async () => {
      const manifest = makeManifest({ hooks: { tick: 'Do stuff' } });
      const intents: Intent[] = [{ type: 'noop' }];

      await processIntents(manifest, intents, {});

      expect(executeAction).not.toHaveBeenCalled();
    });
  });

  describe('per-action token', () => {
    it('should call requestActionToken when intent has permissions', async () => {
      const manifest = makeManifest();
      const intents: Intent[] = [{
        type: 'snipe',
        permissions: ['swap'],
        limits: { swap: 0.005 },
        summary: 'Snipe $TOKEN — 0.005 ETH',
        action: { endpoint: '/swap', method: 'POST', body: { amount: '0.005' } },
      }];

      await processIntents(manifest, intents, {}, 'strategy-token');

      expect(requestActionToken).toHaveBeenCalledWith('test-strategy', intents[0]);
    });

    it('should use temp token from requestActionToken for execution', async () => {
      vi.mocked(requestActionToken).mockResolvedValue({ approved: true, token: 'temp-xyz' });

      const manifest = makeManifest();
      const intents: Intent[] = [{
        type: 'snipe',
        permissions: ['swap'],
        action: { endpoint: '/swap', method: 'POST', body: {} },
      }];

      await processIntents(manifest, intents, {}, 'strategy-token');

      // Should use the temp token, not the strategy token
      expect(executeAction).toHaveBeenCalledWith(
        expect.anything(),
        'test-strategy',
        'temp-xyz',
        undefined,
      );
    });

    it('should skip intent when per-action token is rejected', async () => {
      vi.mocked(requestActionToken).mockResolvedValue({ approved: false });

      const manifest = makeManifest();
      const intents: Intent[] = [{
        type: 'snipe',
        permissions: ['swap'],
        action: { endpoint: '/swap', method: 'POST', body: {} },
      }];

      await processIntents(manifest, intents, {}, 'strategy-token');

      expect(executeAction).not.toHaveBeenCalled();
    });

    it('should process other intents when one per-action token is rejected', async () => {
      vi.mocked(requestActionToken)
        .mockResolvedValueOnce({ approved: false })
        .mockResolvedValueOnce({ approved: true, token: 'temp-2' });

      const manifest = makeManifest();
      const intents: Intent[] = [
        {
          type: 'snipe-rejected',
          permissions: ['swap'],
          action: { endpoint: '/swap', method: 'POST', body: { token: '0x1' } },
        },
        {
          type: 'snipe-approved',
          permissions: ['swap'],
          action: { endpoint: '/swap', method: 'POST', body: { token: '0x2' } },
        },
      ];

      await processIntents(manifest, intents, {}, 'strategy-token');

      // Only one should be executed (the approved one)
      expect(executeAction).toHaveBeenCalledTimes(1);
      expect(executeAction).toHaveBeenCalledWith(
        expect.objectContaining({ body: { token: '0x2' } }),
        'test-strategy',
        'temp-2',
        undefined,
      );
    });
  });

  describe('backwards compatibility: config.approve', () => {
    it('should use batch approval when config.approve and no intent.permissions', async () => {
      const manifest = makeManifest();
      const intents: Intent[] = [
        { type: 'buy', token: 'SOL' },
        { type: 'sell', token: 'ETH' },
      ];
      const config: StrategyConfig = { approve: true };

      await processIntents(manifest, intents, config, 'strategy-token');

      // Should call requestHumanApproval with all intents
      expect(requestHumanApproval).toHaveBeenCalledWith('test-strategy', intents);
      // Should NOT call requestActionToken
      expect(requestActionToken).not.toHaveBeenCalled();
    });

    it('should not request approval when config.approve is false', async () => {
      const manifest = makeManifest();
      const intents: Intent[] = [{ type: 'buy', token: 'SOL' }];
      const config: StrategyConfig = { approve: false };

      await processIntents(manifest, intents, config, 'strategy-token');

      expect(requestHumanApproval).not.toHaveBeenCalled();
      expect(requestActionToken).not.toHaveBeenCalled();
      // Action should still be executed
      expect(executeAction).toHaveBeenCalled();
    });

    it('should handle mixed intents: batch + per-action', async () => {
      vi.mocked(requestActionToken).mockResolvedValue({ approved: true, token: 'temp-mixed' });

      const manifest = makeManifest();
      const intents: Intent[] = [
        { type: 'monitor' },  // batch (no permissions)
        {
          type: 'snipe',
          permissions: ['swap'],
          action: { endpoint: '/swap', method: 'POST', body: {} },
        },
      ];
      const config: StrategyConfig = { approve: true };

      await processIntents(manifest, intents, config, 'strategy-token');

      // Batch approval for 'monitor'
      expect(requestHumanApproval).toHaveBeenCalledWith('test-strategy', [intents[0]]);
      // Per-action for 'snipe'
      expect(requestActionToken).toHaveBeenCalledWith('test-strategy', intents[1]);
      // Both executed
      expect(executeAction).toHaveBeenCalledTimes(2);
    });
  });
});
