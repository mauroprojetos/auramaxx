/**
 * Tests for POST /apikeys/validate endpoint
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import {
  createTestApp,
  cleanDatabase,
  resetColdWallet,
  setupAndUnlockWallet,
  createToken,
} from '../setup';
import { revokeAdminTokens } from '../../lib/auth';
import { lock } from '../../lib/cold';

describe('POST /apikeys/validate', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await cleanDatabase();
    resetColdWallet();
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
      .post('/apikeys/validate')
      .send({ service: 'alchemy', key: 'test-key' });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain('required');
  });

  it('should require apikey:set permission', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['apikey:get'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .post('/apikeys/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ service: 'alchemy', key: 'test-key' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('should return 400 for missing service field', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['apikey:set'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .post('/apikeys/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'test-key' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('service is required');
  });

  it('should return 400 for missing key field', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['apikey:set'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .post('/apikeys/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ service: 'alchemy' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('key is required');
  });

  it('should return 400 for unknown service', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['apikey:set'],
      exp: Date.now() + 3600000,
    });

    const res = await request(app)
      .post('/apikeys/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ service: 'unknown-service', key: 'test-key' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown service: unknown-service');
  });

  it('should return valid: true for valid alchemy key', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['apikey:set'],
      exp: Date.now() + 3600000,
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', result: '0x1234', id: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const res = await request(app)
      .post('/apikeys/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ service: 'alchemy', key: 'valid-alchemy-key' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('should return valid: false for invalid alchemy key', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['apikey:set'],
      exp: Date.now() + 3600000,
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ jsonrpc: '2.0', error: { message: 'Invalid API key' }, id: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const res = await request(app)
      .post('/apikeys/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ service: 'alchemy', key: 'invalid-key' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toBe('Invalid API key');
  });

  it('should return valid: true for valid anthropic key (200)', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['apikey:set'],
      exp: Date.now() + 3600000,
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'msg_123', content: [{ text: 'hi' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const res = await request(app)
      .post('/apikeys/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ service: 'anthropic', key: 'sk-ant-valid-key' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('should return valid: false for invalid anthropic key (401)', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['apikey:set'],
      exp: Date.now() + 3600000,
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const res = await request(app)
      .post('/apikeys/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ service: 'anthropic', key: 'sk-ant-invalid-key' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toBe('Invalid API key');
  });

  it('should return valid: true for rate-limited anthropic key (429)', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['apikey:set'],
      exp: Date.now() + 3600000,
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const res = await request(app)
      .post('/apikeys/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ service: 'anthropic', key: 'sk-ant-valid-key' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('should return valid: true with bot username for valid telegram token', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['apikey:set'],
      exp: Date.now() + 3600000,
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, result: { id: 123, is_bot: true, username: 'test_bot' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const res = await request(app)
      .post('/apikeys/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ service: 'adapter:telegram', key: '123:ABC_TOKEN' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.info).toEqual({ botUsername: 'test_bot' });
  });

  it('should return valid: false for invalid telegram token', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['apikey:set'],
      exp: Date.now() + 3600000,
    });

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const res = await request(app)
      .post('/apikeys/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ service: 'adapter:telegram', key: 'invalid-bot-token' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toBe('Invalid bot token');
  });

  it('should return valid: false with timeout error on abort', async () => {
    await setupAndUnlockWallet();
    const app = createTestApp();

    const token = createToken({
      agentId: 'test-agent',
      permissions: ['apikey:set'],
      exp: Date.now() + 3600000,
    });

    const abortError = new DOMException('The operation was aborted', 'AbortError');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    const res = await request(app)
      .post('/apikeys/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({ service: 'alchemy', key: 'some-key' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toBe('Validation timed out');
  });
});
