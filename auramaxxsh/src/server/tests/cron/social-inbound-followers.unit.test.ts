/**
 * Unit regression test for per-agent follower ingestion in social-inbound.
 * No real DB dependency: Prisma methods are mocked in-memory.
 */
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { CronContext } from '../../cron/job';

vi.mock('../../lib/feature-flags', () => ({
  isEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../../lib/cold', () => ({
  getAgentMnemonic: vi.fn((agentId: string) => `mnemonic-${agentId}`),
}));

vi.mock('../../lib/hub-auth', () => ({
  tryCallHubWithSessionAuth: vi.fn(),
}));

import { socialInboundJob } from '../../cron/jobs/social-inbound';
import { tryCallHubWithSessionAuth } from '../../lib/hub-auth';

type AgentProfileRow = {
  agentId: string;
  publicKeyHex: string;
  inboundSeq: number | null;
  inboundMode: string | null;
};

type HubSubscriptionRow = {
  id: string;
  agentId: string;
  hubUrl: string;
  inboundSeq: number | null;
  inboundMode: string | null;
};

type InboundRow = {
  agentId: string;
  hash: string;
  hubUrl: string;
  authorAuraId: number;
  authorPublicKey: string;
  type: string;
  body: string;
  timestamp: number;
};

describe('social-inbound followers fanout (unit)', () => {
  it('writes follower link_add rows for each subscribed agent', async () => {
    const HUB_URL = 'https://hub.example';

    const agentProfiles: AgentProfileRow[] = [
      { agentId: 'agent-a', publicKeyHex: 'pub-a', inboundSeq: null, inboundMode: null },
      { agentId: 'agent-b', publicKeyHex: 'pub-b', inboundSeq: null, inboundMode: null },
    ];

    const subscriptions: HubSubscriptionRow[] = [
      { id: 'sub-a', agentId: 'agent-a', hubUrl: HUB_URL, inboundSeq: null, inboundMode: null },
      { id: 'sub-b', agentId: 'agent-b', hubUrl: HUB_URL, inboundSeq: null, inboundMode: null },
    ];

    const inboundRows: InboundRow[] = [];

    const prismaMock = {
      agentProfile: {
        findMany: vi.fn(async () => agentProfiles),
        findUnique: vi.fn(async (args: { where: { agentId: string } }) =>
          agentProfiles.find((row) => row.agentId === args.where.agentId) ?? null),
      },
      hubSubscription: {
        findMany: vi.fn(async (args: { where: { agentId: string } }) =>
          subscriptions.filter((row) => row.agentId === args.where.agentId)),
        upsert: vi.fn(async (args: {
          where: { agentId_hubUrl: { agentId: string; hubUrl: string } };
          create: HubSubscriptionRow;
        }) => {
          const existing = subscriptions.find((row) =>
            row.agentId === args.where.agentId_hubUrl.agentId && row.hubUrl === args.where.agentId_hubUrl.hubUrl);
          if (existing) return existing;
          subscriptions.push(args.create);
          return args.create;
        }),
        update: vi.fn(async (args: { where: { id: string }; data: { inboundSeq?: number; inboundMode?: string } }) => {
          const row = subscriptions.find((s) => s.id === args.where.id);
          if (!row) throw new Error(`unknown subscription ${args.where.id}`);
          if (typeof args.data.inboundSeq === 'number') row.inboundSeq = args.data.inboundSeq;
          if (typeof args.data.inboundMode === 'string') row.inboundMode = args.data.inboundMode;
          return row;
        }),
      },
      inboundMessage: {
        upsert: vi.fn(async (args: { where: { hash_hubUrl: { hash: string; hubUrl: string } }; create: InboundRow }) => {
          const found = inboundRows.find((row) =>
            row.hash === args.where.hash_hubUrl.hash && row.hubUrl === args.where.hash_hubUrl.hubUrl);
          if (!found) inboundRows.push(args.create);
          return found ?? args.create;
        }),
        findFirst: vi.fn(async () => null),
      },
      socialMessage: {
        findFirst: vi.fn(async () => null),
      },
    };

    vi.mocked(tryCallHubWithSessionAuth).mockImplementation(
      async (_hubUrl: string, method: string, params: unknown) => {
        if (method === 'sync.snapshotCursor') {
          return { since: 0, seq: 55 };
        }

        if (method === 'sync.snapshot') {
          const publicKey = (params as { publicKey?: string })?.publicKey ?? '';
          if (publicKey === 'pub-a') {
            return {
              followers: [{ auraId: 202, publicKey: 'pub-b', timestamp: 1700000010 }],
              following: [],
              feed: [],
              notifications: [],
              latestSeq: 55,
            };
          }
          if (publicKey === 'pub-b') {
            return {
              followers: [{ auraId: 101, publicKey: 'pub-a', timestamp: 1700000011 }],
              following: [],
              feed: [],
              notifications: [],
              latestSeq: 55,
            };
          }
        }

        return null;
      },
    );

    const ctx: CronContext = {
      prisma: prismaMock as unknown as CronContext['prisma'],
      broadcastUrl: '',
      emit: vi.fn().mockResolvedValue(undefined),
      defaults: {
        get: <T>(_key: string, fallback: T): T => fallback,
      },
      log: pino({ level: 'silent' }),
    };

    await socialInboundJob.run(ctx);

    const aFollowers = inboundRows.filter((row) => row.agentId === 'agent-a' && row.type === 'link_add');
    const bFollowers = inboundRows.filter((row) => row.agentId === 'agent-b' && row.type === 'link_add');

    expect(aFollowers.length).toBe(1);
    expect(bFollowers.length).toBe(1);

    expect(aFollowers[0].authorPublicKey).toBe('pub-b');
    expect(aFollowers[0].body).toContain('"followeePublicKey":"pub-a"');

    expect(bFollowers[0].authorPublicKey).toBe('pub-a');
    expect(bFollowers[0].body).toContain('"followeePublicKey":"pub-b"');
  });
});

