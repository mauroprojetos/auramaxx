/**
 * Tests for the staleness fallback in social-inbound cron job.
 * Verifies: agents that fall behind the hub's event log fall back to snapshot mode.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import pino from 'pino';
import type { CronContext } from '../../cron/job';
import { socialInboundJob } from '../../cron/jobs/social-inbound';
import { testPrisma } from '../setup';

// --- Mocks ---

vi.mock('../../lib/feature-flags', () => ({
  isEnabled: vi.fn().mockReturnValue(true),
}));

import { isEnabled } from '../../lib/feature-flags';

const TEST_AGENT_ID = 'test-inbound-agent';
const TEST_AURA_ID = 99;
const HUB_URL = 'https://hub.auramaxx.com';

async function cleanTables() {
  await testPrisma.inboundMessage.deleteMany();
  await testPrisma.agentProfile.deleteMany();
}

function createCtx(defaults: Record<string, unknown> = {}): CronContext {
  return {
    prisma: testPrisma as unknown as CronContext['prisma'],
    broadcastUrl: '',
    emit: vi.fn().mockResolvedValue(undefined),
    defaults: {
      get: <T>(key: string, fallback: T): T =>
        (defaults[key] as T) ?? fallback,
    },
    log: pino({ level: 'silent' }),
  };
}

async function seedAgent(opts: { inboundSeq?: number; inboundMode?: string } = {}) {
  await testPrisma.agentProfile.create({
    data: {
      agentId: TEST_AGENT_ID,
      auraId: TEST_AURA_ID,
      inboundSeq: opts.inboundSeq ?? 0,
      inboundMode: opts.inboundMode ?? null,
    },
  });
}

describe('social-inbound staleness fallback', () => {
  beforeEach(async () => {
    await cleanTables();
    vi.mocked(isEnabled).mockReturnValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanTables();
  });

  it('stale incremental agent falls back to snapshot mode', async () => {
    // Agent is at seq 100, hub is at seq 20_000 (gap of 19_900 > 10_000 threshold)
    await seedAgent({ inboundSeq: 100, inboundMode: 'incremental' });

    const fetchCalls: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      fetchCalls.push(url);

      // snapshot-cursor: hub is at seq 20_000
      if (url.includes('/v1/sync/snapshot-cursor')) {
        return { ok: true, json: async () => ({ since: 1000, seq: 20_000 }) };
      }
      // snapshot endpoint: return empty snapshot with latestSeq
      if (url.includes('/v1/sync/snapshot?')) {
        return {
          ok: true,
          json: async () => ({ messages: [], latestSeq: 20_000 }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createCtx();
    await socialInboundJob.run(ctx);

    // Should have called snapshot-cursor (once for the tick)
    expect(fetchCalls.some((u) => u.includes('/v1/sync/snapshot-cursor'))).toBe(true);

    // Should have called snapshot (not events), indicating snapshot mode was chosen
    expect(fetchCalls.some((u) => u.includes('/v1/sync/snapshot?'))).toBe(true);
    expect(fetchCalls.some((u) => u.includes('/v1/sync/events?'))).toBe(false);

    // Agent should now be switched to incremental with updated seq
    const updated = await testPrisma.agentProfile.findUnique({
      where: { agentId: TEST_AGENT_ID },
    });
    expect(updated!.inboundMode).toBe('incremental');
    expect(updated!.inboundSeq).toBe(20_000);
  });

  it('non-stale incremental agent stays in incremental mode', async () => {
    // Agent is at seq 19_500, hub is at seq 20_000 (gap of 500 < 10_000 threshold)
    await seedAgent({ inboundSeq: 19_500, inboundMode: 'incremental' });

    const fetchCalls: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      fetchCalls.push(url);

      if (url.includes('/v1/sync/snapshot-cursor')) {
        return { ok: true, json: async () => ({ since: 1000, seq: 20_000 }) };
      }
      // events endpoint: return empty batch
      if (url.includes('/v1/sync/events?')) {
        return {
          ok: true,
          json: async () => ({ events: [], latestSeq: 20_000 }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createCtx();
    await socialInboundJob.run(ctx);

    // Should have called events (incremental), NOT snapshot
    expect(fetchCalls.some((u) => u.includes('/v1/sync/events?'))).toBe(true);
    expect(fetchCalls.some((u) => u.includes('/v1/sync/snapshot?'))).toBe(false);
  });

  it('snapshot-cursor fetch failure does not block incremental sync', async () => {
    // Agent is in incremental mode with a valid seq
    await seedAgent({ inboundSeq: 19_500, inboundMode: 'incremental' });

    const fetchCalls: string[] = [];
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      fetchCalls.push(url);

      // snapshot-cursor fails
      if (url.includes('/v1/sync/snapshot-cursor')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      // events endpoint works
      if (url.includes('/v1/sync/events?')) {
        return {
          ok: true,
          json: async () => ({ events: [], latestSeq: 20_000 }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createCtx();
    await socialInboundJob.run(ctx);

    // Should still proceed with incremental mode (snapshotCursor is null, isStale is false)
    expect(fetchCalls.some((u) => u.includes('/v1/sync/events?'))).toBe(true);
    expect(fetchCalls.some((u) => u.includes('/v1/sync/snapshot?'))).toBe(false);
  });

  it('snapshot-cursor is fetched only once per tick for multiple agents', async () => {
    // Seed two agents
    await testPrisma.agentProfile.create({
      data: { agentId: 'agent-a', auraId: 1, inboundSeq: 19_500, inboundMode: 'incremental' },
    });
    await testPrisma.agentProfile.create({
      data: { agentId: 'agent-b', auraId: 2, inboundSeq: 19_600, inboundMode: 'incremental' },
    });

    let snapshotCursorCalls = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/v1/sync/snapshot-cursor')) {
        snapshotCursorCalls++;
        return { ok: true, json: async () => ({ since: 1000, seq: 20_000 }) };
      }
      if (url.includes('/v1/sync/events?')) {
        return { ok: true, json: async () => ({ events: [], latestSeq: 20_000 }) };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', mockFetch);

    const ctx = createCtx();
    await socialInboundJob.run(ctx);

    // snapshot-cursor should be called exactly once, not once per agent
    expect(snapshotCursorCalls).toBe(1);
  });
});
