import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../../cron/scheduler';
import type { CronJob, CronContext } from '../../cron/job';
import pino from 'pino';

function createMockContext(): CronContext {
  return {
    prisma: {} as CronContext['prisma'],
    broadcastUrl: 'http://localhost:4748/broadcast',
    emit: vi.fn().mockResolvedValue(undefined),
    defaults: { get: <T>(_key: string, fallback: T) => fallback },
    log: pino({ level: 'silent' }),
  };
}

function createMockJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'test-job',
    name: 'Test Job',
    intervalKey: 'test.interval',
    defaultInterval: 100,
    run: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('Scheduler', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new Scheduler();
  });

  afterEach(async () => {
    await scheduler.stopAll();
    vi.useRealTimers();
  });

  it('registers and starts jobs', async () => {
    const job = createMockJob();
    const ctx = createMockContext();

    scheduler.register(job);
    await scheduler.startAll(ctx);

    // Job hasn't run yet (setTimeout pending)
    expect(job.run).not.toHaveBeenCalled();

    // Advance timer to trigger first run
    await vi.advanceTimersByTimeAsync(100);
    expect(job.run).toHaveBeenCalledTimes(1);
  });

  it('calls setup before first run', async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    const job = createMockJob({ setup });
    const ctx = createMockContext();

    scheduler.register(job);
    await scheduler.startAll(ctx);

    expect(setup).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledWith(ctx);
  });

  it('chains setTimeout after each run', async () => {
    const job = createMockJob();
    const ctx = createMockContext();

    scheduler.register(job);
    await scheduler.startAll(ctx);

    // First tick
    await vi.advanceTimersByTimeAsync(100);
    expect(job.run).toHaveBeenCalledTimes(1);

    // Second tick
    await vi.advanceTimersByTimeAsync(100);
    expect(job.run).toHaveBeenCalledTimes(2);

    // Third tick
    await vi.advanceTimersByTimeAsync(100);
    expect(job.run).toHaveBeenCalledTimes(3);
  });

  it('skips run when job is already running', async () => {
    let resolveRun: () => void;
    const slowRun = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveRun = resolve; })
    );

    const job = createMockJob({ run: slowRun, defaultInterval: 50 });
    const ctx = createMockContext();

    scheduler.register(job);
    await scheduler.startAll(ctx);

    // Start first run
    await vi.advanceTimersByTimeAsync(50);
    expect(slowRun).toHaveBeenCalledTimes(1);

    // Try to trigger while running
    await scheduler.trigger('test-job');
    // Still just 1 call — skipped because busy
    expect(slowRun).toHaveBeenCalledTimes(1);

    // Complete the run
    resolveRun!();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('stopAll clears timers and calls teardown', async () => {
    const teardown = vi.fn().mockResolvedValue(undefined);
    const job = createMockJob({ teardown });
    const ctx = createMockContext();

    scheduler.register(job);
    await scheduler.startAll(ctx);

    await scheduler.stopAll();

    expect(teardown).toHaveBeenCalledOnce();

    // No more runs after stop
    await vi.advanceTimersByTimeAsync(1000);
    expect(job.run).not.toHaveBeenCalled();
  });

  it('trigger runs a job immediately', async () => {
    const job = createMockJob();
    const ctx = createMockContext();

    scheduler.register(job);
    await scheduler.startAll(ctx);

    // Trigger immediately (before timer fires)
    await scheduler.trigger('test-job');
    expect(job.run).toHaveBeenCalledTimes(1);
  });

  it('handles job errors gracefully', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);

    const job = createMockJob({ run });
    const ctx = createMockContext();

    scheduler.register(job);
    await scheduler.startAll(ctx);

    // First run — fails
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);

    // Second run — succeeds (scheduler continues despite error)
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
