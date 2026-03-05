import fs from 'fs';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { cleanDatabase, createTestApp, setupAndUnlockWallet, setupColdWallet, testPrisma } from '../setup';
import { DATA_PATHS, getDbPath, getBackupsDir } from '../../lib/config';

const app = createTestApp();

describe('Credential Ops Integration', () => {
  let adminToken: string;

  beforeEach(async () => {
    await cleanDatabase();
    const setup = await setupAndUnlockWallet();
    adminToken = setup.adminToken;
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('should include credential files in backup snapshots', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'note',
        name: 'Ops Secret',
        meta: { tags: ['ops'] },
        fields: [{ key: 'content', value: 'back-me-up', type: 'text', sensitive: true }],
      });
    expect(createRes.status).toBe(200);

    // Backup route currently snapshots getDbPath() directly.
    // Ensure a db file exists at that path in test mode.
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
      fs.writeFileSync(dbPath, '');
    }

    const backupRes = await request(app)
      .post('/backup')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(backupRes.status).toBe(200);
    expect(backupRes.body.backup.credentialsCopied).toBeGreaterThanOrEqual(1);

    const backupsDir = getBackupsDir();
    const timestamp = backupRes.body.backup.timestamp as string;
    const files = fs.readdirSync(backupsDir);
    expect(files.some(file => file.startsWith(`credentials.${timestamp}.cred-`) && file.endsWith('.json'))).toBe(true);
  });

  it('should wipe credential files on nuke', async () => {
    const createRes = await request(app)
      .post('/credentials')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        agentId: 'primary',
        type: 'login',
        name: 'Nuke Me',
        meta: { tags: ['ops'] },
        fields: [{ key: 'password', value: 'delete-me', type: 'secret', sensitive: true }],
      });
    expect(createRes.status).toBe(200);
    const createdId = createRes.body.credential.id as string;
    expect(fs.existsSync(path.join(DATA_PATHS.credentials, `${createdId}.json`))).toBe(true);

    const nukeRes = await request(app)
      .post('/nuke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(nukeRes.status).toBe(200);
    expect(fs.existsSync(DATA_PATHS.nukeStateMarker)).toBe(true);

    const remaining = fs.readdirSync(DATA_PATHS.credentials).filter(file => file.startsWith('cred-') && file.endsWith('.json'));
    expect(remaining).toEqual([]);
  });

  it('should clear nuke marker after primary setup', async () => {
    const nukeRes = await request(app)
      .post('/nuke')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(nukeRes.status).toBe(200);
    expect(fs.existsSync(DATA_PATHS.nukeStateMarker)).toBe(true);

    await setupColdWallet();
    expect(fs.existsSync(DATA_PATHS.nukeStateMarker)).toBe(false);
  });
});
