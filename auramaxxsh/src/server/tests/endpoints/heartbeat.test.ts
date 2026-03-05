import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createToken, getTokenHash } from '../../lib/auth';
import { listCredentials } from '../../lib/credentials';
import { DIARY_ENTRY_COUNT_KEY } from '../../lib/diary';
import { NOTE_CONTENT_KEY } from '../../../../shared/credential-field-schema';
import {
  cleanDatabase,
  createTestApp,
  setupAndUnlockWallet,
  testPrisma,
} from '../setup';

const app = createTestApp();
let adminToken = '';

describe('Heartbeat endpoint', () => {
  beforeEach(async () => {
    await cleanDatabase();
    const unlocked = await setupAndUnlockWallet();
    adminToken = unlocked.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('returns consolidated no-auth status payload', async () => {
    await testPrisma.humanAction.createMany({
      data: [
        {
          type: 'fund',
          fromTier: 'cold',
          chain: 'base',
          status: 'pending',
          metadata: JSON.stringify({ agentId: 'hb-agent' }),
        },
        {
          type: 'send',
          fromTier: 'hot',
          chain: 'base',
          status: 'approved',
          metadata: JSON.stringify({ agentId: 'hb-agent' }),
        },
      ],
    });

    await createToken('hb-agent', 0, ['wallet:list'], 3600);

    await testPrisma.event.createMany({
      data: [
        {
          type: 'credential:changed',
          source: 'express',
          data: JSON.stringify({
            agentId: 'hb-agent',
            credentialId: 'cred-123',
            change: 'updated',
          }),
        },
        {
          type: 'secret:accessed',
          source: 'express',
          data: JSON.stringify({
            agentId: 'hb-agent',
            credentialName: 'deploy-key',
            surface: 'inject_secret',
            envVar: 'DEPLOY_KEY',
          }),
        },
      ],
    });

    await testPrisma.syncState.create({
      data: {
        chain: 'base',
        lastSyncStatus: 'ok',
        lastBlock: '12345',
      },
    });

    const res = await request(app).get('/what_is_happening');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.humanActions)).toBe(true);
    expect(Array.isArray(res.body.activeTokens)).toBe(true);
    expect(Array.isArray(res.body.recentEvents)).toBe(true);
    expect(Array.isArray(res.body.highlights)).toBe(true);
    expect(res.body.syncHealth.base).toEqual(
      expect.objectContaining({
        status: 'ok',
        lastBlock: '12345',
      }),
    );
    expect(res.body.activeTokens[0]).toEqual(
      expect.objectContaining({
        agentId: 'hb-agent',
        createdAt: expect.any(Number),
      }),
    );
    expect(res.body.endpoints?.diaryWrite).toEqual(expect.objectContaining({
      method: 'POST',
      path: '/what_is_happening/diary',
      noteNamePattern: '{YYYY-MM-DD}_LOGS',
    }));
    expect(res.body.summary?.authorizations).toEqual(expect.objectContaining({
      total: 2,
      pending: 1,
      approved: 1,
      rejected: 0,
    }));
    expect(res.body.summary?.secrets?.count).toBe(2);
    expect(res.body.summary?.secrets?.names).toEqual(expect.arrayContaining(['deploy-key', 'cred-123']));
    expect(typeof res.body.summary?.diaryHint).toBe('string');
    expect(res.body.summary?.diaryHint).toContain('pending / 1 approved / 0 rejected');
  });

  it('filters human actions and events by agentId', async () => {
    await testPrisma.humanAction.createMany({
      data: [
        {
          type: 'fund',
          fromTier: 'cold',
          chain: 'base',
          status: 'pending',
          metadata: JSON.stringify({ agentId: 'agent-a' }),
        },
        {
          type: 'send',
          fromTier: 'hot',
          chain: 'base',
          status: 'pending',
          metadata: JSON.stringify({ agentId: 'agent-b' }),
        },
      ],
    });

    await testPrisma.event.createMany({
      data: [
        {
          type: 'credential:accessed',
          source: 'express',
          data: JSON.stringify({ agentId: 'agent-a', allowed: true }),
        },
        {
          type: 'credential:accessed',
          source: 'express',
          data: JSON.stringify({ agentId: 'agent-b', allowed: true }),
        },
      ],
    });

    const res = await request(app).get('/what_is_happening?agentId=agent-a');
    expect(res.status).toBe(200);
    expect(res.body.humanActions).toHaveLength(1);
    expect(res.body.humanActions[0].metadata).toContain('agent-a');
    expect(res.body.recentEvents).toHaveLength(1);
    expect(res.body.recentEvents[0].data.agentId).toBe('agent-a');
  });

  it('applies since filter to human actions, active tokens, and events', async () => {
    const now = Date.now();
    const oldTime = new Date(now - 3 * 60 * 60 * 1000);
    const recentTime = new Date(now - 20 * 1000);
    const since = now - 60 * 1000;

    await testPrisma.humanAction.create({
      data: {
        type: 'fund',
        fromTier: 'cold',
        chain: 'base',
        status: 'pending',
        metadata: JSON.stringify({ agentId: 'agent-since' }),
        createdAt: oldTime,
      },
    });
    await testPrisma.humanAction.create({
      data: {
        type: 'send',
        fromTier: 'hot',
        chain: 'base',
        status: 'approved',
        metadata: JSON.stringify({ agentId: 'agent-since' }),
        createdAt: recentTime,
      },
    });

    const oldToken = await createToken('token-old', 0, ['wallet:list'], 3600);
    await testPrisma.agentToken.update({
      where: { tokenHash: getTokenHash(oldToken) },
      data: { createdAt: oldTime },
    });

    await createToken('token-new', 0, ['wallet:list'], 3600);

    await testPrisma.event.createMany({
      data: [
        {
          type: 'credential:changed',
          source: 'express',
          data: JSON.stringify({ agentId: 'agent-since', change: 'updated' }),
          timestamp: oldTime,
        },
        {
          type: 'credential:changed',
          source: 'express',
          data: JSON.stringify({ agentId: 'agent-since', change: 'updated' }),
          timestamp: recentTime,
        },
      ],
    });

    const res = await request(app).get(`/what_is_happening?since=${since}&agentId=agent-since`);
    expect(res.status).toBe(200);
    expect(res.body.humanActions).toHaveLength(1);
    expect(res.body.humanActions[0].status).toBe('approved');
    expect(res.body.activeTokens).toHaveLength(1);
    expect(res.body.activeTokens[0].agentId).toBe('token-new');
    expect(res.body.recentEvents).toHaveLength(1);
    expect(res.body.recentEvents[0].data.agentId).toBe('agent-since');
    expect(new Date(res.body.recentEvents[0].timestamp).getTime()).toBeGreaterThanOrEqual(since);
  });

  it('creates and appends heartbeat diary entries to YYYY-MM-DD_LOGS', async () => {
    const first = await request(app)
      .post('/what_is_happening/diary')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ date: '2026-02-18', entry: 'first heartbeat note' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual(expect.objectContaining({
      success: true,
      name: '2026-02-18_LOGS',
      entryCount: 1,
      agentId: expect.any(String),
    }));

    const second = await request(app)
      .post('/what_is_happening/diary')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ date: '2026-02-18', entry: 'second heartbeat note\nstill calm' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(expect.objectContaining({
      success: true,
      name: '2026-02-18_LOGS',
      entryCount: 2,
      agentId: first.body.agentId,
      credentialId: first.body.credentialId,
    }));

    const creds = listCredentials({ agentId: first.body.agentId, query: '2026-02-18_LOGS' });
    expect(creds).toHaveLength(1);
    const note = typeof creds[0].meta?.[NOTE_CONTENT_KEY] === 'string'
      ? creds[0].meta[NOTE_CONTENT_KEY] as string
      : '';
    const entryCountMeta = typeof creds[0].meta?.[DIARY_ENTRY_COUNT_KEY] === 'number'
      ? creds[0].meta[DIARY_ENTRY_COUNT_KEY] as number
      : 0;
    expect(note).toContain('first heartbeat note');
    expect(note).toContain('\n\nsecond heartbeat note\nstill calm');
    expect(entryCountMeta).toBe(2);
  });

  it('rejects diary writes without secret:write permission', async () => {
    const limitedToken = await createToken('no-secret-write', 0, ['wallet:list'], 3600);

    const res = await request(app)
      .post('/what_is_happening/diary')
      .set('Authorization', `Bearer ${limitedToken}`)
      .send({ entry: 'no permission' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('secret:write');
  });
});
