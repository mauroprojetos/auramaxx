import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { cleanDatabase, createTestApp, setupAndUnlockWallet, testPrisma } from '../setup';

const app = createTestApp();

describe('Agent Profile Endpoints', () => {
  let adminToken: string;

  beforeEach(async () => {
    await cleanDatabase();
    const setup = await setupAndUnlockWallet();
    adminToken = setup.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('creates and retrieves an agent profile keyed by path agentId', async () => {
    const putRes = await request(app)
      .put('/agent-profiles/primary')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'ops@example.com',
        phone: '+1 555 0100',
        address: 'New York, US',
        profileImage: 'https://cdn.example.com/avatar.png',
        attributes: {
          team: 'ops',
          region: 'us-east',
        },
      });

    expect(putRes.status).toBe(200);
    expect(putRes.body.success).toBe(true);
    expect(putRes.body.profile.agentId).toBe('primary');
    expect(putRes.body.profile.email).toBe('ops@example.com');
    expect(putRes.body.profile.attributes).toEqual({
      team: 'ops',
      region: 'us-east',
    });

    const getRes = await request(app)
      .get('/agent-profiles/primary')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.profile.agentId).toBe('primary');
    expect(getRes.body.profile.profileImage).toBe('https://cdn.example.com/avatar.png');

    const listRes = await request(app)
      .get('/agent-profiles')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.profiles)).toBe(true);
    expect(listRes.body.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: 'primary',
          email: 'ops@example.com',
        }),
      ]),
    );
  });

  it('rejects mismatched body agentId', async () => {
    const res = await request(app)
      .put('/agent-profiles/primary')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'different-agent',
        email: 'ops@example.com',
      });

    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toContain('must match');
  });

  it('rejects invalid wildcard attribute keys', async () => {
    const res = await request(app)
      .put('/agent-profiles/primary')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        attributes: {
          '   ': 'ops',
        },
      });

    expect(res.status).toBe(400);
    expect(String(res.body.error || '')).toContain('attribute keys');
  });

  it('supports underscore aliases and deletion', async () => {
    const createRes = await request(app)
      .put('/agent-profiles/primary')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        profile_image: 'https://cdn.example.com/avatar.png',
        custom_attributes: { team: 'core' },
      });

    expect(createRes.status).toBe(200);
    expect(createRes.body.profile.profileImage).toBe('https://cdn.example.com/avatar.png');
    expect(createRes.body.profile.attributes).toEqual({ team: 'core' });

    const deleteRes = await request(app)
      .delete('/agent-profiles/primary')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.deleted).toBe(true);

    const missingRes = await request(app)
      .get('/agent-profiles/primary')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(missingRes.status).toBe(404);
  });
});
