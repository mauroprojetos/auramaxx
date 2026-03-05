/**
 * Tests for adapter endpoints: POST /adapters/test, /adapters/telegram/setup-link, /adapters/telegram/detect-chat
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const { sendWhatsAppMessageNativeMock, resolveDefaultTargetFromCredsMock } = vi.hoisted(() => ({
  sendWhatsAppMessageNativeMock: vi.fn(),
  resolveDefaultTargetFromCredsMock: vi.fn(),
}));

// Mock network module to bypass DNS resolution in tests
vi.mock('../../lib/network', () => ({
  validateExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/adapters/whatsapp-native', () => ({
  sendWhatsAppMessageNative: sendWhatsAppMessageNativeMock,
  resolveDefaultTargetFromCreds: resolveDefaultTargetFromCredsMock,
}));

import {
  createTestApp,
  cleanDatabase,
  resetColdWallet,
  setupAndUnlockWallet,
  createToken,
  testPrisma,
} from '../setup';
import { revokeAdminTokens } from '../../lib/auth';
import { lock } from '../../lib/cold';
import { telegramSetupNonces } from '../../routes/adapters';
import { upsertApiKeyCredential } from '../../lib/apikey-migration';

describe('POST /adapters/test', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await cleanDatabase();
    resetColdWallet();
    await testPrisma.apiKey.deleteMany();
    await testPrisma.appConfig.deleteMany();
    sendWhatsAppMessageNativeMock.mockReset();
    resolveDefaultTargetFromCredsMock.mockReset();
    resolveDefaultTargetFromCredsMock.mockResolvedValue('16504415478:1@s.whatsapp.net');
    sendWhatsAppMessageNativeMock.mockResolvedValue({ messageId: 'test-message-id' });
  });

  afterEach(() => {
    revokeAdminTokens();
    lock();
    if (fetchSpy) {
      fetchSpy.mockRestore();
    }
  });

  it('should require authentication', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/adapters/test')
      .send({ type: 'telegram' });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('required');
  });

  it('should require adapter:manage permission', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['wallet:list'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .post('/adapters/test')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'telegram' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('should return 400 for missing type field', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['adapter:manage'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .post('/adapters/test')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('type is required');
  });

  it('should return 400 for unknown adapter type', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['adapter:manage'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .post('/adapters/test')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'unknown-adapter' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown adapter type: unknown-adapter');
  });

  describe('telegram', () => {
    it('should return 400 when bot token not configured', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'telegram' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Telegram bot token not configured');
    });

    it('should return 400 when chat ID not configured', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      // Store bot token but no chat ID in adapter config
      upsertApiKeyCredential('adapter:telegram', 'botToken', '123:ABC_TOKEN', null);

      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/getUpdates')) {
          return new Response(
            JSON.stringify({ ok: true, result: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({ ok: true, result: { username: 'test_bot' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'telegram' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Telegram chat ID not configured');
      expect(res.body.error).toContain('@test_bot');
      expect(res.body.error).toContain('https://t.me/test_bot');
      expect(res.body.error).toContain('/start');
    });

    it('should auto-detect chat ID from recent updates and persist it', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      upsertApiKeyCredential('adapter:telegram', 'botToken', '123:ABC_TOKEN', null);
      await testPrisma.appConfig.upsert({
        where: { id: 'global' },
        update: {
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'telegram', enabled: true, config: {} }],
          }),
        },
        create: {
          id: 'global',
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'telegram', enabled: true, config: {} }],
          }),
        },
      });

      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/getUpdates')) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                { update_id: 1, message: { chat: { id: 77777, type: 'private' }, text: '/start' } },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes('/sendMessage')) {
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 42 } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ ok: false }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'telegram' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const sendCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes('/sendMessage'));
      expect(sendCall).toBeTruthy();
      const sendBody = JSON.parse(sendCall?.[1]?.body as string);
      expect(sendBody.chat_id).toBe('77777');

      const persisted = await testPrisma.appConfig.findUnique({ where: { id: 'global' } });
      const parsed = persisted?.adapterConfig ? JSON.parse(persisted.adapterConfig) : null;
      expect(parsed.adapters[0].config.chatId).toBe(77777);
    });

    it('should use fallback telegram token when botToken key is not used', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      // Store token under a non-standard key (legacy/manual setups)
      upsertApiKeyCredential('adapter:telegram', 'default', '123:ABC_TOKEN', null);

      await testPrisma.appConfig.upsert({
        where: { id: 'global' },
        update: {
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'telegram', enabled: true, config: { chatId: '99999' } }],
          }),
        },
        create: {
          id: 'global',
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'telegram', enabled: true, config: { chatId: '99999' } }],
          }),
        },
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 42 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'telegram' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.telegram.org/bot123:ABC_TOKEN/sendMessage',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should accept legacy chat_id key in telegram adapter config', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      upsertApiKeyCredential('adapter:telegram', 'botToken', '123:ABC_TOKEN', null);

      await testPrisma.appConfig.upsert({
        where: { id: 'global' },
        update: {
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'telegram', enabled: true, config: { chat_id: '77777' } }],
          }),
        },
        create: {
          id: 'global',
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'telegram', enabled: true, config: { chat_id: '77777' } }],
          }),
        },
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 42 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'telegram' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.chat_id).toBe('77777');
    });

    it('should send test message successfully', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      // Store bot token
      upsertApiKeyCredential('adapter:telegram', 'botToken', '123:ABC_TOKEN', null);

      // Store adapter config with chat ID
      await testPrisma.appConfig.upsert({
        where: { id: 'global' },
        update: {
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'telegram', enabled: true, config: { chatId: '99999' } }],
          }),
        },
        create: {
          id: 'global',
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'telegram', enabled: true, config: { chatId: '99999' } }],
          }),
        },
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 42 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'telegram' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify fetch was called with telegram sendMessage
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.telegram.org/bot123:ABC_TOKEN/sendMessage',
        expect.objectContaining({
          method: 'POST',
        })
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.chat_id).toBe('99999');
      expect(body.parse_mode).toBe('HTML');
    });

    it('should handle send failure', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      upsertApiKeyCredential('adapter:telegram', 'botToken', '123:ABC_TOKEN', null);

      await testPrisma.appConfig.upsert({
        where: { id: 'global' },
        update: {
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'telegram', enabled: true, config: { chatId: '99999' } }],
          }),
        },
        create: {
          id: 'global',
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'telegram', enabled: true, config: { chatId: '99999' } }],
          }),
        },
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'telegram' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Bad Request: chat not found');
    });
  });

  describe('discord', () => {
    it('should return 400 when bot token not configured', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      await testPrisma.appConfig.upsert({
        where: { id: 'global' },
        update: {
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'discord', enabled: true, config: { channelId: '123' } }],
          }),
        },
        create: {
          id: 'global',
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'discord', enabled: true, config: { channelId: '123' } }],
          }),
        },
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'discord' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Discord bot token not configured');
    });

    it('should send Discord test message successfully', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();
      upsertApiKeyCredential('adapter:discord', 'botToken', 'discord_token', null);

      await testPrisma.appConfig.upsert({
        where: { id: 'global' },
        update: {
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'discord', enabled: true, config: { channelId: '123' } }],
          }),
        },
        create: {
          id: 'global',
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'discord', enabled: true, config: { channelId: '123' } }],
          }),
        },
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ id: 'msg_1' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'discord' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://discord.com/api/v10/channels/123/messages',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('webhook', () => {
    it('should return 404 when URL not configured', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'webhook' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Webhook URL not configured');
    });

    it('should send test payload successfully', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      await testPrisma.appConfig.upsert({
        where: { id: 'global' },
        update: {
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'webhook', enabled: true, config: { url: 'https://hooks.example.com/test' } }],
          }),
        },
        create: {
          id: 'global',
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'webhook', enabled: true, config: { url: 'https://hooks.example.com/test' } }],
          }),
        },
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('ok', { status: 200 })
      );

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'webhook' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify fetch was called with webhook URL
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://hooks.example.com/test',
        expect.objectContaining({
          method: 'POST',
        })
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.type).toBe('human_action_test');
      expect(body.data?.text).toContain('AuraMaxx');
      expect(body.timestamp).toBeDefined();
    });

    it('should handle failure response', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      await testPrisma.appConfig.upsert({
        where: { id: 'global' },
        update: {
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'webhook', enabled: true, config: { url: 'https://hooks.example.com/test' } }],
          }),
        },
        create: {
          id: 'global',
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'webhook', enabled: true, config: { url: 'https://hooks.example.com/test' } }],
          }),
        },
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Internal Server Error', { status: 500 })
      );

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'webhook' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Webhook returned 500');
    });
  });

  describe('whatsapp', () => {
    it('should return 404 when adapter config is missing', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'whatsapp' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('WhatsApp adapter not configured');
    });

    it('should return 400 when configured auth dirs are missing', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      await testPrisma.appConfig.upsert({
        where: { id: 'global' },
        update: {
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'whatsapp', enabled: true, config: { authDir: '/tmp/does-not-exist-whatsapp-test' } }],
          }),
        },
        create: {
          id: 'global',
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'whatsapp', enabled: true, config: { authDir: '/tmp/does-not-exist-whatsapp-test' } }],
          }),
        },
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'whatsapp' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('WhatsApp session not found');
    });

    it('should succeed when at least one auth dir exists', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const existingAuthDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auramaxx-whatsapp-test-'));

      await testPrisma.appConfig.upsert({
        where: { id: 'global' },
        update: {
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'whatsapp', enabled: true, config: { authDir: existingAuthDir } }],
          }),
        },
        create: {
          id: 'global',
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'whatsapp', enabled: true, config: { authDir: existingAuthDir } }],
          }),
        },
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'whatsapp' });

      await fs.rm(existingAuthDir, { recursive: true, force: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(String(res.body.message || '')).toContain('sent');
      expect(sendWhatsAppMessageNativeMock).toHaveBeenCalledTimes(1);
      expect(sendWhatsAppMessageNativeMock).toHaveBeenCalledWith(expect.objectContaining({
        authDir: existingAuthDir,
        target: '16504415478:1@s.whatsapp.net',
      }));
      const sentPayload = sendWhatsAppMessageNativeMock.mock.calls[0]?.[0] as { text?: string };
      expect(String(sentPayload?.text || '')).toContain('🗿');
    });

    it('should return send failure when native WhatsApp send fails', async () => {
      await setupAndUnlockWallet();
      const app = createTestApp();

      const existingAuthDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auramaxx-whatsapp-test-'));

      await testPrisma.appConfig.upsert({
        where: { id: 'global' },
        update: {
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'whatsapp', enabled: true, config: { authDir: existingAuthDir } }],
          }),
        },
        create: {
          id: 'global',
          adapterConfig: JSON.stringify({
            enabled: true,
            adapters: [{ type: 'whatsapp', enabled: true, config: { authDir: existingAuthDir } }],
          }),
        },
      });

      const token = createToken({
        agentId: 'test-agent',
        permissions: ['adapter:manage'],
        exp: Date.now() + 3600000,
      });
      sendWhatsAppMessageNativeMock.mockRejectedValueOnce(new Error('send failed'));

      const res = await request(app)
        .post('/adapters/test')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'whatsapp' });

      await fs.rm(existingAuthDir, { recursive: true, force: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(String(res.body.error || '')).toContain('WhatsApp test send failed');
    });
  });
});

describe('GET /adapters/:type/secrets/:name', () => {
  beforeEach(async () => {
    await cleanDatabase();
    resetColdWallet();
    await testPrisma.apiKey.deleteMany();
    await testPrisma.appConfig.deleteMany();
  });

  afterEach(() => {
    revokeAdminTokens();
    lock();
  });

  it('should require authentication', async () => {
    const app = createTestApp();
    const res = await request(app)
      .get('/adapters/telegram/secrets/botToken');

    expect(res.status).toBe(401);
  });

  it('should require unlocked wallet', async () => {
    await setupAndUnlockWallet();
    upsertApiKeyCredential('adapter:telegram', 'botToken', '123:ABC_TOKEN', null);
    lock();

    const app = createTestApp();
    const token = createToken({
      agentId: 'test-agent',
      permissions: ['adapter:manage'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .get('/adapters/telegram/secrets/botToken')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Wallet is locked');
  });

  it('should return secret value when configured and unlocked', async () => {
    await setupAndUnlockWallet();
    upsertApiKeyCredential('adapter:telegram', 'botToken', '123:ABC_TOKEN', null);

    const app = createTestApp();
    const token = createToken({
      agentId: 'test-agent',
      permissions: ['adapter:manage'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .get('/adapters/telegram/secrets/botToken')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.value).toBe('123:ABC_TOKEN');
  });

  it('should fallback to any telegram key when botToken key is missing', async () => {
    await setupAndUnlockWallet();
    upsertApiKeyCredential('adapter:telegram', 'default', '123:ABC_TOKEN', null);

    const app = createTestApp();
    const token = createToken({
      agentId: 'test-agent',
      permissions: ['adapter:manage'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .get('/adapters/telegram/secrets/botToken')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.value).toBe('123:ABC_TOKEN');
  });
});

describe('POST /adapters/telegram/setup-link', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await cleanDatabase();
    resetColdWallet();
    await testPrisma.apiKey.deleteMany();
    await testPrisma.appConfig.deleteMany();
    telegramSetupNonces.clear();
  });

  afterEach(() => {
    revokeAdminTokens();
    lock();
    telegramSetupNonces.clear();
    if (fetchSpy) {
      fetchSpy.mockRestore();
    }
  });

  it('should require authentication', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/adapters/telegram/setup-link')
      .send({});

    expect(res.status).toBe(401);
  });

  it('should return 400 when bot token not provided and not saved', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['adapter:manage'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .post('/adapters/telegram/setup-link')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Bot token not provided');
  });

  it('should validate token and return deep link with nonce', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['adapter:manage'],
      exp: Date.now() + 3600000,
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/getMe')) {
        return new Response(
          JSON.stringify({ ok: true, result: { username: 'test_bot' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (urlStr.includes('/deleteWebhook')) {
        return new Response(
          JSON.stringify({ ok: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const res = await request(app)
      .post('/adapters/telegram/setup-link')
      .set('Authorization', `Bearer ${token}`)
      .send({ botToken: '123:ABC_TOKEN' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.botUsername).toBe('test_bot');
    expect(res.body.link).toContain('https://t.me/test_bot?start=');
    expect(res.body.setupToken).toBeDefined();
    expect(typeof res.body.setupToken).toBe('string');
    expect(res.body.setupToken.length).toBeGreaterThan(0);

    // Verify nonce was stored in memory
    expect(telegramSetupNonces.has(res.body.setupToken)).toBe(true);
  });

  it('should return 400 for invalid bot token', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['adapter:manage'],
      exp: Date.now() + 3600000,
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({ ok: false, description: 'Unauthorized' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const res = await request(app)
      .post('/adapters/telegram/setup-link')
      .set('Authorization', `Bearer ${token}`)
      .send({ botToken: 'invalid' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unauthorized');
  });
});

describe('POST /adapters/telegram/detect-chat', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await cleanDatabase();
    resetColdWallet();
    await testPrisma.apiKey.deleteMany();
    await testPrisma.appConfig.deleteMany();
    telegramSetupNonces.clear();
  });

  afterEach(() => {
    revokeAdminTokens();
    lock();
    telegramSetupNonces.clear();
    if (fetchSpy) {
      fetchSpy.mockRestore();
    }
  });

  it('should require authentication', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/adapters/telegram/detect-chat')
      .send({ setupToken: 'test' });

    expect(res.status).toBe(401);
  });

  it('should return 400 for missing setupToken', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['adapter:manage'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .post('/adapters/telegram/detect-chat')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('setupToken is required');
  });

  it('should return 400 for invalid setup token', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['adapter:manage'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .post('/adapters/telegram/detect-chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupToken: 'nonexistent' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or expired setup token');
  });

  it('should return 400 for expired setup token', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    // Manually insert an expired nonce
    telegramSetupNonces.set('expired-nonce', {
      botToken: '123:ABC_TOKEN',
      botUsername: 'test_bot',
      expiresAt: Date.now() - 1000,
    });

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['adapter:manage'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .post('/adapters/telegram/detect-chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupToken: 'expired-nonce' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Setup token expired');
  });

  it('should return chatId when /start <nonce> message found', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const nonce = 'test-nonce-123';
    telegramSetupNonces.set(nonce, {
      botToken: '123:ABC_TOKEN',
      botUsername: 'test_bot',
      expiresAt: Date.now() + 120_000,
    });

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['adapter:manage'],
      exp: Date.now() + 3600000,
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('/getUpdates')) {
        // If this is the confirmation call (has offset), return empty
        if (urlStr.includes('offset=')) {
          return new Response(
            JSON.stringify({ ok: true, result: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            result: [{
              update_id: 100,
              message: {
                text: `/start ${nonce}`,
                chat: { id: 12345, first_name: 'Alice', username: 'alice' },
              },
            }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const res = await request(app)
      .post('/adapters/telegram/detect-chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupToken: nonce });

    expect(res.status).toBe(200);
    expect(res.body.chatId).toBe('12345');
    expect(res.body.firstName).toBe('Alice');
    expect(res.body.username).toBe('alice');
    expect(res.body.verified).toBe(true);

    // Nonce should be cleaned up
    expect(telegramSetupNonces.has(nonce)).toBe(false);
  });

  it('should return timeout when no messages', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const nonce = 'test-nonce-empty';
    telegramSetupNonces.set(nonce, {
      botToken: '123:ABC_TOKEN',
      botUsername: 'test_bot',
      expiresAt: Date.now() + 120_000,
    });

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['adapter:manage'],
      exp: Date.now() + 3600000,
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({ ok: true, result: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const res = await request(app)
      .post('/adapters/telegram/detect-chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ setupToken: nonce });

    expect(res.status).toBe(200);
    expect(res.body.chatId).toBeNull();
    expect(res.body.timeout).toBe(true);
  });
});
