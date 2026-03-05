import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

vi.mock('../../lib/strategy/loader', () => ({
  loadStrategyManifests: vi.fn().mockReturnValue([
    { id: 'alpha' },
    { id: 'beta' },
  ]),
}));

vi.mock('../../lib/strategy/engine', () => ({
  startEngine: vi.fn().mockResolvedValue(undefined),
  stopEngine: vi.fn().mockResolvedValue(undefined),
  runExternalTickCycle: vi.fn().mockResolvedValue({ ticked: [], considered: 0, authFailures: [] }),
  isEngineStarted: vi.fn().mockReturnValue(true),
  reconcileWorkspaceStrategies: vi.fn().mockResolvedValue({ enabled: [], disabled: [], eligible: 0 }),
  persistEngineStateSnapshot: vi.fn().mockResolvedValue(undefined),
  processPendingAppMessages: vi.fn().mockResolvedValue({ processed: 0, failed: 0 }),
}));

import { strategyRunnerJob } from '../../cron/jobs/strategy-runner';
import {
  startEngine,
  stopEngine,
  runExternalTickCycle,
  isEngineStarted,
  reconcileWorkspaceStrategies,
  persistEngineStateSnapshot,
  processPendingAppMessages,
} from '../../lib/strategy/engine';

function createCtx(overrides?: {
  cronEnabled?: boolean;
  batchSize?: number;
  persistIntervalMs?: number;
}) {
  const syncUpsert = vi.fn().mockResolvedValue(undefined);

  const cronEnabled = overrides?.cronEnabled ?? true;
  const batchSize = overrides?.batchSize ?? 20;
  const persistIntervalMs = overrides?.persistIntervalMs ?? 300_000;

  return {
    ctx: {
      prisma: {
        syncState: { upsert: syncUpsert },
      },
      broadcastUrl: 'http://localhost:4748/broadcast',
      emit: vi.fn().mockResolvedValue(undefined),
      defaults: {
        get: <T>(key: string, fallback: T): T => {
          if (key === 'strategy.cron_enabled') return cronEnabled as T;
          if (key === 'strategy.message_batch_size') return batchSize as T;
          if (key === 'strategy.persist_interval') return persistIntervalMs as T;
          return fallback;
        },
      },
      log: pino({ level: 'silent' }),
    },
    syncUpsert,
  };
}

describe('strategyRunnerJob', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(isEngineStarted).mockReturnValue(true);
    await strategyRunnerJob.teardown?.();
  });

  afterEach(async () => {
    await strategyRunnerJob.teardown?.();
  });

  it('processes queued messages before running external tick cycle', async () => {
    const order: string[] = [];
    vi.mocked(reconcileWorkspaceStrategies).mockImplementation(async () => {
      order.push('reconcile');
      return { enabled: [], disabled: [], eligible: 0 };
    });
    vi.mocked(processPendingAppMessages).mockImplementation(async () => {
      order.push('messages');
      return { processed: 1, failed: 0 };
    });
    vi.mocked(runExternalTickCycle).mockImplementation(async () => {
      order.push('ticks');
      return { ticked: ['alpha'], considered: 1, authFailures: [] };
    });

    const { ctx, syncUpsert } = createCtx({ cronEnabled: true, batchSize: 7, persistIntervalMs: 1 });

    await strategyRunnerJob.setup?.(ctx as any);
    await strategyRunnerJob.run(ctx as any);

    expect(startEngine).toHaveBeenCalledWith({ schedulerMode: 'external' });
    expect(processPendingAppMessages).toHaveBeenCalledWith(7);
    expect(persistEngineStateSnapshot).toHaveBeenCalled();
    expect(order).toEqual(['reconcile', 'messages', 'ticks']);
    expect(syncUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chain: 'strategy_runner' },
        update: expect.objectContaining({ lastSyncStatus: 'ok' }),
      }),
    );
  });

  it('marks runtime disabled when cron ownership is turned off', async () => {
    const enabled = createCtx({ cronEnabled: true });
    await strategyRunnerJob.run(enabled.ctx as any);

    const disabled = createCtx({ cronEnabled: false });
    await strategyRunnerJob.run(disabled.ctx as any);

    expect(stopEngine).toHaveBeenCalled();
    expect(disabled.syncUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ lastSyncStatus: 'disabled' }),
      }),
    );
  });

  it('triggers token re-provisioning when auth failures are reported', async () => {
    vi.mocked(runExternalTickCycle).mockResolvedValue({
      ticked: ['alpha'],
      considered: 1,
      authFailures: ['alpha'],
    });

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const { ctx } = createCtx({ cronEnabled: true, persistIntervalMs: 999_999 });
    await strategyRunnerJob.run(ctx as any);

    const provisionCall = mockFetch.mock.calls.find(
      (call: [string, ...unknown[]]) => typeof call[0] === 'string' && call[0].includes('provision-tokens'),
    );
    expect(provisionCall).toBeDefined();
    expect(provisionCall![0]).toContain('/strategies/internal/provision-tokens');
    expect(provisionCall![1]).toMatchObject({ method: 'POST' });
  });

  it('writes error health status when the strategy cycle fails', async () => {
    vi.mocked(reconcileWorkspaceStrategies).mockRejectedValueOnce(new Error('boom'));

    const { ctx, syncUpsert } = createCtx({ cronEnabled: true });

    await expect(strategyRunnerJob.run(ctx as any)).rejects.toThrow('boom');
    expect(syncUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastSyncStatus: 'error',
          lastError: 'boom',
        }),
      }),
    );
  });
});
