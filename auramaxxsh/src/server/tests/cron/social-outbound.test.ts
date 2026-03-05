/**
 * Tests for the social-outbound cron job.
 * Verifies: feature flag gating, pending message batching, hub response handling,
 * exponential backoff on errors, and status transitions.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import pino from 'pino';
import type { CronContext } from '../../cron/job';
import { socialOutboundJob } from '../../cron/jobs/social-outbound';
import { testPrisma } from '../setup';

// --- Mocks ---

vi.mock('../../lib/feature-flags', () => ({
  isEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../../lib/cold', () => ({
  getAgentMnemonic: vi.fn().mockReturnValue(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  ),
  getMnemonic: vi.fn().mockReturnValue(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  ),
}));

import { isEnabled } from '../../lib/feature-flags';

const TEST_AGENT_ID = 'test-outbound-agent';
const TEST_AURA_ID = 42;

async function cleanSocialTables() {
  await testPrisma.socialMessage.deleteMany();
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

async function seedAgentWithMessages(count: number, overrides: Record<string, unknown> = {}) {
  await testPrisma.agentProfile.create({
    data: { agentId: TEST_AGENT_ID, auraId: TEST_AURA_ID },
  });

  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push(
      testPrisma.socialMessage.create({
        data: {
          agentId: TEST_AGENT_ID,
          hash: `hash_${i}_${Date.now()}`,
          type: 'post_add',
          body: JSON.stringify({ text: `message ${i}` }),
          timestamp: Math.floor(Date.now() / 1000) + i,
          network: 'mainnet',
          signature: 'a'.repeat(128),
          signer: 'b'.repeat(64),
          syncStatus: 'pending',
          ...overrides,
        },
      }),
    );
  }
  return Promise.all(messages);
}

describe('socialOutboundJob', () => {
  beforeEach(async () => {
    await cleanSocialTables();
    vi.mocked(isEnabled).mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should skip when SOCIAL flag is off', async () => {
    vi.mocked(isEnabled).mockReturnValue(false);
    await seedAgentWithMessages(1);

    const ctx = createCtx();
    await socialOutboundJob.run(ctx);

    const pending = await testPrisma.socialMessage.findMany({
      where: { syncStatus: 'pending' },
    });
    expect(pending).toHaveLength(1); // unchanged
  });

  it('should skip when no pending messages', async () => {
    const ctx = createCtx();
    // No messages, no agent profile — should not throw
    await expect(socialOutboundJob.run(ctx)).resolves.toBeUndefined();
  });

  it('should process accepted hub responses', async () => {
    const msgs = await seedAgentWithMessages(2);

    // Mock global fetch
    const mockResponse = {
      results: [
        { hash: msgs[0].hash, status: 'accepted' },
        { hash: msgs[1].hash, status: 'accepted' },
      ],
    };
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 207 }),
    );

    const ctx = createCtx();
    await socialOutboundJob.run(ctx);

    const updated = await testPrisma.socialMessage.findMany({
      where: { agentId: TEST_AGENT_ID },
      orderBy: { createdAt: 'asc' },
    });

    expect(updated[0].syncStatus).toBe('accepted');
    expect(updated[0].syncedAt).not.toBeNull();
    expect(updated[1].syncStatus).toBe('accepted');
    expect(updated[1].syncedAt).not.toBeNull();

    fetchSpy.mockRestore();
  });

  it('should handle duplicate hub responses', async () => {
    const msgs = await seedAgentWithMessages(1);

    const mockResponse = {
      results: [{ hash: msgs[0].hash, status: 'duplicate' }],
    };
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 207 }),
    );

    const ctx = createCtx();
    await socialOutboundJob.run(ctx);

    const updated = await testPrisma.socialMessage.findUnique({
      where: { hash: msgs[0].hash },
    });
    expect(updated!.syncStatus).toBe('duplicate');

    fetchSpy.mockRestore();
  });

  it('should handle rejected hub responses with code and detail', async () => {
    const msgs = await seedAgentWithMessages(1);

    const mockResponse = {
      results: [
        {
          hash: msgs[0].hash,
          status: 'rejected',
          code: 'INVALID_SIG',
          detail: 'Signature verification failed',
        },
      ],
    };
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 207 }),
    );

    const ctx = createCtx();
    await socialOutboundJob.run(ctx);

    const updated = await testPrisma.socialMessage.findUnique({
      where: { hash: msgs[0].hash },
    });
    expect(updated!.syncStatus).toBe('rejected');
    expect(updated!.syncCode).toBe('INVALID_SIG');
    expect(updated!.syncDetail).toBe('Signature verification failed');

    fetchSpy.mockRestore();
  });

  it('should apply exponential backoff on hub error responses', async () => {
    const msgs = await seedAgentWithMessages(1);

    const mockResponse = {
      results: [{ hash: msgs[0].hash, status: 'error' }],
    };
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 207 }),
    );

    const ctx = createCtx();
    await socialOutboundJob.run(ctx);

    const updated = await testPrisma.socialMessage.findUnique({
      where: { hash: msgs[0].hash },
    });
    expect(updated!.syncStatus).toBe('pending'); // stays pending
    expect(updated!.attempts).toBe(1);
    expect(updated!.nextRetryAt).not.toBeNull();

    fetchSpy.mockRestore();
  });

  it('should apply backoff to all messages on network failure', async () => {
    const msgs = await seedAgentWithMessages(2);

    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(
      new Error('Network error'),
    );

    const ctx = createCtx();
    await socialOutboundJob.run(ctx);

    const updated = await testPrisma.socialMessage.findMany({
      where: { agentId: TEST_AGENT_ID },
    });
    for (const msg of updated) {
      expect(msg.attempts).toBe(1);
      expect(msg.nextRetryAt).not.toBeNull();
    }

    fetchSpy.mockRestore();
  });

  it('should not re-send messages with future nextRetryAt', async () => {
    await seedAgentWithMessages(1, {
      nextRetryAt: new Date(Date.now() + 60_000), // 1 minute in future
    });

    const fetchSpy = vi.spyOn(global, 'fetch');

    const ctx = createCtx();
    await socialOutboundJob.run(ctx);

    // Fetch should not have been called (no eligible messages)
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('should have correct job metadata', () => {
    expect(socialOutboundJob.id).toBe('social-outbound');
    expect(socialOutboundJob.intervalKey).toBe('social_outbound_interval');
    expect(socialOutboundJob.defaultInterval).toBe(2000);
  });
});
