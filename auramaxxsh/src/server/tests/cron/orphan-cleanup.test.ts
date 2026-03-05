/**
 * Tests for orphan cleanup cron job
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { orphanCleanupJob } from '../../cron/jobs/orphan-cleanup';

function createCtx() {
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const log = pino({ level: 'silent' });
  vi.spyOn(log, 'warn');

  return {
    ctx: {
      prisma: {
        humanAction: { updateMany },
      },
      broadcastUrl: 'http://localhost:4748/broadcast',
      emit: vi.fn().mockResolvedValue(undefined),
      defaults: {
        get: <T>(_key: string, fallback: T): T => fallback,
      },
      log,
    },
    updateMany,
  };
}

describe('orphanCleanupJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls cleanup on setup', async () => {
    const { ctx, updateMany } = createCtx();
    updateMany.mockResolvedValue({ count: 2 });

    await orphanCleanupJob.setup!(ctx as any);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'pending',
          type: { in: ['strategy:approve', 'action'] },
        }),
        data: expect.objectContaining({
          status: 'rejected',
        }),
      }),
    );
    expect(ctx.log.warn).toHaveBeenCalledWith(
      { count: 2 },
      'Cleaned orphaned pending actions on startup',
    );
  });

  it('calls cleanup on run', async () => {
    const { ctx, updateMany } = createCtx();
    updateMany.mockResolvedValue({ count: 3 });

    await orphanCleanupJob.run(ctx as any);

    expect(updateMany).toHaveBeenCalled();
    expect(ctx.log.warn).toHaveBeenCalledWith(
      { count: 3 },
      'Cleaned orphaned pending actions',
    );
  });

  it('does not log when no orphaned actions found', async () => {
    const { ctx, updateMany } = createCtx();
    updateMany.mockResolvedValue({ count: 0 });

    await orphanCleanupJob.run(ctx as any);

    expect(updateMany).toHaveBeenCalled();
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it('filters by createdAt threshold', async () => {
    const { ctx, updateMany } = createCtx();
    updateMany.mockResolvedValue({ count: 0 });

    await orphanCleanupJob.run(ctx as any);

    const where = updateMany.mock.calls[0][0].where;
    expect(where.createdAt).toBeDefined();
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    // Threshold should be ~15 minutes ago
    const thresholdMs = Date.now() - where.createdAt.lt.getTime();
    expect(thresholdMs).toBeLessThan(16 * 60_000);
    expect(thresholdMs).toBeGreaterThan(14 * 60_000);
  });
});
