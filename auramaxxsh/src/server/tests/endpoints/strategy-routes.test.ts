import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import {
  createTestApp,
  cleanDatabase,
  resetColdWallet,
  setupAndUnlockWallet,
  testPrisma,
} from '../setup';
import { lock } from '../../lib/cold';
import { revokeAdminTokens } from '../../lib/auth';
import { setDefault } from '../../lib/defaults';

describe('Strategy Routes (DB-backed v1)', () => {
  beforeEach(async () => {
    await cleanDatabase();
    resetColdWallet();
    await testPrisma.syncState.deleteMany();
    // Disable cron-owned strategy mode so the 503 guard doesn't block test mutations
    await setDefault('strategy.cron_enabled', false);
  });

  afterEach(() => {
    revokeAdminTokens();
    lock();
  });

  it('lists only DB-backed strategies (no legacy app.md strategy listing)', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    const res = await request(app)
      .get('/strategies')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.strategies)).toBe(true);
    expect(res.body.strategies.length).toBe(0);
  });

  it('reports cron runtime health and stale status', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    // Health endpoint needs cron enabled to detect stale status
    await setDefault('strategy.cron_enabled', true);

    await testPrisma.syncState.upsert({
      where: { chain: 'strategy_runner' },
      create: {
        chain: 'strategy_runner',
        lastSyncAt: new Date(),
        lastSyncStatus: 'ok',
        syncCount: 1,
      },
      update: {
        lastSyncAt: new Date(),
        lastSyncStatus: 'ok',
      },
    });

    const healthy = await request(app)
      .get('/strategies/health')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(healthy.status).toBe(200);
    expect(healthy.body.success).toBe(true);
    expect(healthy.body.strategyRuntime.owner).toBe('cron');
    expect(healthy.body.strategyRuntime.healthy).toBe(true);

    await testPrisma.syncState.update({
      where: { chain: 'strategy_runner' },
      data: {
        lastSyncAt: new Date(Date.now() - 120_000),
        lastSyncStatus: 'ok',
      },
    });

    const stale = await request(app)
      .get('/strategies/health')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(stale.status).toBe(503);
    expect(stale.body.success).toBe(false);
    expect(stale.body.strategyRuntime.isStale).toBe(true);
  });

  it('lists v1 strategy templates', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    const res = await request(app)
      .get('/strategies/templates')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.templates)).toBe(true);
    const ids = res.body.templates.map((entry: { id: string }) => entry.id);
    expect(ids).toEqual(expect.arrayContaining([
      'recurring_buy',
      'buy_on_drop',
      'stop_loss',
      'portfolio_report',
    ]));
  });

  it('creates all v1 templates with expected default risk controls', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    const cases = [
      {
        template: 'recurring_buy',
        name: 'Recurring Buy Template',
        config: {
          chain: 'base',
          wallet: '0x1111111111111111111111111111111111111111',
          token: '0x2222222222222222222222222222222222222222',
          amountUsd: '25',
        },
        assertConfig: (cfg: Record<string, unknown>) => {
          expect(cfg.slippageBps).toBe(100);
          expect(cfg.reserveUsd).toBe('1');
          expect(cfg.maxDailySpendUsd).toBe('500');
        },
      },
      {
        template: 'buy_on_drop',
        name: 'Buy On Drop Template',
        config: {
          chain: 'base',
          wallet: '0x1111111111111111111111111111111111111111',
          token: '0x2222222222222222222222222222222222222222',
          dropPercent: 15,
          amountUsd: '40',
        },
        assertConfig: (cfg: Record<string, unknown>) => {
          expect(cfg.cooldownMinutes).toBe(120);
          expect(cfg.expireAfterHours).toBe(72);
          expect(cfg.maxExecutions).toBe(1);
        },
      },
      {
        template: 'stop_loss',
        name: 'Stop Loss Template',
        config: {
          chain: 'base',
          wallet: '0x1111111111111111111111111111111111111111',
          token: '0x2222222222222222222222222222222222222222',
          dropPercent: 10,
        },
        assertConfig: (cfg: Record<string, unknown>) => {
          expect(cfg.cooldownMinutes).toBe(60);
          expect(cfg.expireAfterHours).toBe(72);
          expect(cfg.maxExecutions).toBe(1);
        },
      },
      {
        template: 'portfolio_report',
        name: 'Portfolio Report Template',
        config: {
          watch: [{
            chain: 'base',
            address: '0x3333333333333333333333333333333333333333',
          }],
        },
        assertConfig: (cfg: Record<string, unknown>) => {
          expect(cfg.dedupeWindowMinutes).toBe(60);
          expect(cfg.stalenessMinutes).toBe(30);
          expect(cfg.notifyRateLimitPerHour).toBe(6);
        },
      },
    ] as const;

    for (const testCase of cases) {
      const createRes = await request(app)
        .post('/strategies')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          template: testCase.template,
          name: testCase.name,
          mode: 'headless',
          config: testCase.config,
          enabled: false,
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.success).toBe(true);
      expect(createRes.body.strategy.templateId).toBe(testCase.template);

      const strategyId = createRes.body.strategy.id as string;
      const row = await testPrisma.strategy.findUnique({ where: { id: strategyId } });
      expect(row).not.toBeNull();
      const config = JSON.parse(row!.config || '{}') as Record<string, unknown>;
      testCase.assertConfig(config);

      const enableRes = await request(app)
        .post(`/strategies/${strategyId}/enable`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(enableRes.status).toBe(200);
      expect(enableRes.body.success).toBe(true);

      const disableRes = await request(app)
        .post(`/strategies/${strategyId}/disable`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(disableRes.status).toBe(200);
      expect(disableRes.body.success).toBe(true);
    }
  });

  it('creates and manages a template strategy', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    const createRes = await request(app)
      .post('/strategies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        template: 'portfolio_report',
        name: 'External Watch',
        mode: 'headless',
        config: {
          watch: [{
            chain: 'base',
            address: '0x1111111111111111111111111111111111111111',
          }],
          interval: 'hourly',
        },
        enabled: false,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.strategy.templateId).toBe('portfolio_report');

    const strategyId = createRes.body.strategy.id as string;
    const enableRes = await request(app)
      .post(`/strategies/${strategyId}/enable`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(enableRes.status).toBe(200);
    expect(enableRes.body.enabled).toBe(true);

    const getConfig = await request(app)
      .get(`/strategies/${strategyId}/config`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getConfig.status).toBe(200);
    expect(getConfig.body.success).toBe(true);
    expect(Array.isArray(getConfig.body.config.watch)).toBe(true);

    const putConfig = await request(app)
      .put(`/strategies/${strategyId}/config`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        watch: [{
          chain: 'base',
          address: '0x2222222222222222222222222222222222222222',
        }],
        interval: 'daily',
      });
    expect(putConfig.status).toBe(200);
    expect(putConfig.body.success).toBe(true);
    expect(putConfig.body.config.interval).toBe('daily');

    const getState = await request(app)
      .get(`/strategies/${strategyId}/state`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getState.status).toBe(200);
    expect(getState.body.success).toBe(true);
    expect(getState.body.state).toEqual({});
  });

  it('rejects invalid template config for portfolio_report watch addresses', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    const res = await request(app)
      .post('/strategies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        template: 'portfolio_report',
        name: 'Invalid Watch',
        mode: 'headless',
        config: {
          watch: [{
            chain: 'base',
            address: 'not-an-address',
          }],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('enforces recurring_buy guardrails on bounded daily spend', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    const res = await request(app)
      .post('/strategies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        template: 'recurring_buy',
        name: 'Guardrail Test',
        mode: 'headless',
        config: {
          chain: 'base',
          wallet: '0x1111111111111111111111111111111111111111',
          token: '0x2222222222222222222222222222222222222222',
          amountUsd: '600',
          maxDailySpendUsd: '500',
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toContain('maxDailySpendUsd');
  });

  it('applies portfolio_report risk-control defaults', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    const createRes = await request(app)
      .post('/strategies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        template: 'portfolio_report',
        name: 'Defaults Test',
        mode: 'headless',
        config: {
          watch: [{
            chain: 'base',
            address: '0x1111111111111111111111111111111111111111',
          }],
        },
      });

    expect(createRes.status).toBe(201);
    const strategyId = createRes.body.strategy.id as string;
    const row = await testPrisma.strategy.findUnique({ where: { id: strategyId } });
    expect(row).not.toBeNull();
    const config = JSON.parse(row!.config || '{}');
    expect(config.dedupeWindowMinutes).toBe(60);
    expect(config.stalenessMinutes).toBe(30);
    expect(config.notifyRateLimitPerHour).toBe(6);
  });

  it('installs third-party manifest strategy and enforces explicit approval before enable', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    const installRes = await request(app)
      .post('/strategies/install')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Third Party Strategy',
        mode: 'headless',
        enabled: true,
        manifest: {
          name: 'Third Party Strategy',
          ticker: 'standard',
          sources: [],
          hooks: { tick: 'Analyze inputs and return no intents.' },
          config: {},
          permissions: ['swap'],
          limits: { fund: 1 },
          allowedHosts: [],
        },
      });

    expect(installRes.status).toBe(201);
    expect(installRes.body.success).toBe(true);
    expect(installRes.body.approvalRequired).toBe(true);
    expect(typeof installRes.body.approvalId).toBe('string');

    const strategyId = installRes.body.strategy.id as string;
    const approvalId = installRes.body.approvalId as string;

    const blockedEnable = await request(app)
      .post(`/strategies/${strategyId}/enable`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(blockedEnable.status).toBe(409);
    expect(blockedEnable.body.success).toBe(false);

    const approveRes = await request(app)
      .post(`/strategies/${strategyId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ approvalId, approved: true });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);
    expect(approveRes.body.type).toBe('strategy:install:approve');

    const enabled = await request(app)
      .post(`/strategies/${strategyId}/enable`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(enabled.status).toBe(200);
    expect(enabled.body.success).toBe(true);
    expect(enabled.body.enabled).toBe(true);
  });

  it('installs third-party strategy from local source and captures provenance metadata', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-strategy-test-'));

    try {
      fs.writeFileSync(
        path.join(tmpDir, 'app.md'),
        [
          '---',
          'name: Local Source Strategy',
          'ticker: standard',
          'sources:',
          '  - id: price',
          '    url: https://api.example.com/price',
          '    method: GET',
          'hooks:',
          '  tick: |',
          '    Return no intents for now.',
          'config: {}',
          'permissions: []',
          'allowedHosts:',
          '  - api.example.com',
          '---',
          '',
          'Local source strategy manifest for tests.',
          '',
        ].join('\n'),
        'utf8',
      );

      const installRes = await request(app)
        .post('/strategies/install')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          source: tmpDir,
          mode: 'headless',
          enabled: false,
        });

      expect(installRes.status).toBe(201);
      expect(installRes.body.success).toBe(true);
      expect(installRes.body.approvalRequired).toBe(false);
      expect(installRes.body.strategy.provenance.sourceType).toBe('local');

      const strategyId = installRes.body.strategy.id as string;
      const row = await testPrisma.strategy.findUnique({ where: { id: strategyId } });
      expect(row).not.toBeNull();
      expect(row?.provenance).toContain('"sourceType":"local"');
      expect(row?.provenance).toContain(path.resolve(tmpDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects third-party manifest install with templated external source and no allowedHosts', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    const installRes = await request(app)
      .post('/strategies/install')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Templated Source Strategy',
        mode: 'headless',
        enabled: false,
        manifest: {
          name: 'Templated Source Strategy',
          ticker: 'standard',
          sources: [
            { id: 'price', url: 'https://${config.host}/price', method: 'GET' },
          ],
          hooks: { tick: 'Return no intents.' },
          config: { host: 'api.example.com' },
          permissions: [],
        },
      });

    expect(installRes.status).toBe(400);
    expect(installRes.body.success).toBe(false);
    expect(String(installRes.body.error)).toContain('requires explicit allowedHosts');
  });

  it('returns 404 for deprecated POST /strategies/internal/app-added', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/strategies/internal/app-added')
      .send({ appId: 'test' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for deprecated POST /strategies/internal/app-removed', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/strategies/internal/app-removed')
      .send({ appId: 'test' });
    expect(res.status).toBe(404);
  });

  it('installs third-party strategy with custom external source and host allowlist', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    const installRes = await request(app)
      .post('/strategies/install')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'External Source Strategy',
        mode: 'headless',
        enabled: false,
        manifest: {
          name: 'External Source Strategy',
          ticker: 'standard',
          sources: [
            { id: 'price', url: 'https://api.example.com/price', method: 'GET' },
          ],
          hooks: { tick: 'Return no intents.' },
          config: {},
          permissions: [],
          allowedHosts: ['api.example.com'],
        },
      });

    expect(installRes.status).toBe(201);
    expect(installRes.body.success).toBe(true);
    expect(installRes.body.strategy.provenance.sourceType).toBe('inline');

    const strategyId = installRes.body.strategy.id as string;
    const row = await testPrisma.strategy.findUnique({ where: { id: strategyId } });
    expect(row).not.toBeNull();
    const manifest = JSON.parse(row!.manifest || '{}') as Record<string, unknown>;
    const sources = Array.isArray(manifest.sources) ? manifest.sources as Array<Record<string, unknown>> : [];
    expect(sources[0]?.url).toBe('https://api.example.com/price');
    const allowedHosts = Array.isArray(manifest.allowedHosts) ? manifest.allowedHosts as string[] : [];
    expect(allowedHosts).toContain('api.example.com');
  });

  it('returns 503 for strategy toggle when cron enabled but engine not started', async () => {
    const { adminToken } = await setupAndUnlockWallet();
    const app = createTestApp();

    // Enable cron mode (engine is not started in test env)
    await setDefault('strategy.cron_enabled', true);

    // Create a strategy first (creation is allowed through the guard)
    const createRes = await request(app)
      .post('/strategies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        template: 'portfolio_report',
        name: 'Guard Test',
        mode: 'headless',
        config: {
          watch: [{ chain: 'base', address: '0x1111111111111111111111111111111111111111' }],
        },
        enabled: false,
      });

    expect(createRes.status).toBe(201);
    const strategyId = createRes.body.strategy.id as string;

    // Toggle should be blocked with 503
    const toggleRes = await request(app)
      .post(`/strategies/${strategyId}/toggle`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(toggleRes.status).toBe(503);
    expect(toggleRes.body.success).toBe(false);
    expect(toggleRes.body.error).toContain('not ready');
  });

  it('POST /strategies/internal/provision-tokens returns success from localhost', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/strategies/internal/provision-tokens')
      .set('x-strategy-cron-secret', process.env.STRATEGY_CRON_SHARED_SECRET!)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tokens).toBeDefined();
    expect(typeof res.body.tokens).toBe('object');
  });
});
