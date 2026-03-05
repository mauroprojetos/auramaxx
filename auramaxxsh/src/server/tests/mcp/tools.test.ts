/**
 * Tests for MCP tool definitions and executeTool handler
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { TOOLS, toAnthropicTools, toOpenAITools, executeTool } from '../../mcp/tools';

describe('MCP Tools', () => {
  describe('TOOLS', () => {
    it('should include base and social tools', () => {
      const names = TOOLS.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        'api',
        'status',
        'list_secrets',
        'register_agent',
        'register',
        'social_register',
        'unregister',
        'social_unregister',
        'social_post',
        'social_feed',
        'social_follow',
        'social_unfollow',
        'social_react',
        'social_followers',
        'social_following',
        'social_notifications',
        'social_status',
      ]));
    });

    it('should require method and endpoint for api', () => {
      expect(TOOLS.find(t => t.name === 'api')?.parameters.required).toEqual(['method', 'endpoint']);
    });

    it('should not have create_agent or request_human_action tools', () => {
      expect(TOOLS.map(t => t.name)).not.toContain('create_agent');
      expect(TOOLS.map(t => t.name)).not.toContain('request_human_action');
      expect(TOOLS.map(t => t.name)).not.toContain('aura_list_wallets');
      expect(TOOLS.map(t => t.name)).not.toContain('aura_list_agents');
    });
  });

  describe('toAnthropicTools()', () => {
    it('should format tools for Anthropic SDK', () => {
      const tools = toAnthropicTools();
      expect(tools.length).toBe(TOOLS.length);

      const api = tools.find(t => t.name === 'api');
      expect(api).toEqual({
        name: 'api',
        description: expect.any(String),
        input_schema: {
          type: 'object',
          properties: expect.objectContaining({
            method: expect.objectContaining({ type: 'string' }),
            endpoint: expect.objectContaining({ type: 'string' }),
          }),
          required: ['method', 'endpoint'],
        },
      });
    });

    it('should include body as optional property', () => {
      const tools = toAnthropicTools();
      const api = tools.find(t => t.name === 'api')!;
      expect(api.input_schema.properties).toHaveProperty('body');
    });
  });

  describe('toOpenAITools()', () => {
    it('should format tools for OpenAI SDK', () => {
      const tools = toOpenAITools();
      expect(tools.length).toBe(TOOLS.length);

      const api = tools.find(t => t.function.name === 'api');
      expect(api).toEqual({
        type: 'function',
        function: {
          name: 'api',
          description: expect.any(String),
          parameters: {
            type: 'object',
            properties: expect.objectContaining({
              method: expect.objectContaining({ type: 'string' }),
              endpoint: expect.objectContaining({ type: 'string' }),
            }),
            required: ['method', 'endpoint'],
          },
        },
      });
    });
  });

  describe('executeTool()', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = vi.fn();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });


    it('should execute status as typed wrapper', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ unlocked: true }), { status: 200 }),
      );
      const result = await executeTool('status', {}, 'tok');
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.tool).toBe('status');
      expect(parsed.data.unlocked).toBe(true);
    });

    it('should execute list_secrets with query params', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ credentials: [] }), { status: 200 }),
      );
      const result = await executeTool('list_secrets', { q: 'github', tag: 'dev' }, 'tok');
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.tool).toBe('list_secrets');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/credentials?q=github&tag=dev'),
        expect.any(Object),
      );
    });

    it('should execute register_agent via encrypted setup payload', async () => {
      const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      vi.mocked(globalThis.fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ publicKey }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true, id: 'agent-2' }), { status: 200 }),
        );

      const result = await executeTool('register_agent', {
        password: 'hunter2__',
        name: 'bot-2',
      }, 'tok');
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.tool).toBe('register_agent');

      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        1,
        'http://127.0.0.1:4242/auth/connect',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        2,
        'http://127.0.0.1:4242/setup/agent',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(String),
        }),
      );

      const secondCall = vi.mocked(globalThis.fetch).mock.calls[1];
      const opts = secondCall[1] as RequestInit;
      const body = JSON.parse(String(opts.body)) as Record<string, unknown>;
      expect(typeof body.encrypted).toBe('string');
      expect(typeof body.pubkey).toBe('string');
      expect(body.name).toBe('bot-2');
    });

    it('should execute social_feed with query params', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ success: true, messages: [] }), { status: 200 }),
      );

      const result = await executeTool('social_feed', {
        agentId: 'primary',
        hubUrl: 'https://hub.example',
        limit: 25,
      }, 'tok');

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.tool).toBe('social_feed');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/social/feed?agentId=primary&hubUrl=https%3A%2F%2Fhub.example&limit=25'),
        expect.any(Object),
      );
    });

    it('should resolve agentAddress for social_feed', async () => {
      vi.mocked(globalThis.fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            agents: [{ id: 'primary', address: '0xabc123' }],
          }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true, messages: [] }), { status: 200 }),
        );

      const result = await executeTool('social_feed', {
        agentAddress: '0xAbC123',
        limit: 10,
      }, 'tok');

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.tool).toBe('social_feed');
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        1,
        'http://127.0.0.1:4242/setup/agents',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('/social/feed?agentId=primary&limit=10'),
        expect.any(Object),
      );
    });

    it('should execute register default endpoint', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ agentId: 'primary', auraId: 123, hubUrl: 'https://hub.example' }), { status: 200 }),
      );

      const result = await executeTool('register', { agentId: 'primary' }, 'tok');
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.tool).toBe('register');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:4242/agent-hub/primary/register',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should execute unregister leave endpoint when hubUrl is provided', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const result = await executeTool('unregister', {
        agentId: 'primary',
        hubUrl: 'https://hub.example',
      }, 'tok');
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.tool).toBe('unregister');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:4242/agent-hub/primary/leave',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ hubUrl: 'https://hub.example' }),
        }),
      );
    });

    it('should execute social_register join endpoint when hubUrl is provided', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ hub: { agentId: 'primary', hubUrl: 'https://hub.example' } }), { status: 200 }),
      );

      const result = await executeTool('social_register', {
        agentId: 'primary',
        hubUrl: 'https://hub.example',
      }, 'tok');
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.tool).toBe('social_register');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:4242/agent-hub/primary/join',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ hubUrl: 'https://hub.example' }),
        }),
      );
    });

    it('should reject social_post when required args are missing', async () => {
      const result = await executeTool('social_post', { agentId: 'primary' }, 'tok');
      expect(JSON.parse(result)).toEqual({ error: 'text is required' });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should auto-mark fetched social notifications as read by default', async () => {
      vi.mocked(globalThis.fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            success: true,
            notifications: [
              { id: 'n1', read: false },
              { id: 'n2', read: false },
            ],
            total: 2,
          }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true, updated: 2 }), { status: 200 }),
        );

      const result = await executeTool('social_notifications', { agentId: 'primary' }, 'tok');
      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.tool).toBe('social_notifications');
      expect(parsed.autoRead.updated).toBe(2);

      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('/social/notifications?agentId=primary&unreadOnly=true'),
        expect.any(Object),
      );
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        2,
        'http://127.0.0.1:4242/social/notifications/read',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ids: ['n1', 'n2'] }),
        }),
      );
    });

    it('should reject unknown tool names', async () => {
      const result = await executeTool('unknown_tool', {});
      expect(JSON.parse(result)).toEqual({ error: 'Unknown tool: unknown_tool' });
    });

    it('should reject endpoint not starting with /', async () => {
      const result = await executeTool('api', {
        method: 'GET',
        endpoint: 'wallets',
      });
      expect(JSON.parse(result)).toEqual({ error: 'endpoint must start with /' });
    });

    it('should reject invalid method', async () => {
      const result = await executeTool('api', {
        method: 'TRACE',
        endpoint: '/wallets',
      });
      expect(JSON.parse(result)).toEqual({ error: 'method must be GET, POST, PUT, PATCH, or DELETE' });
    });

    it('should make GET request with bearer token', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ wallets: [] }), { status: 200 }),
      );

      const result = await executeTool(
        'api',
        { method: 'GET', endpoint: '/wallets' },
        'test-token-123',
      );

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:4242/wallets',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token-123',
          }),
        }),
      );
      expect(JSON.parse(result)).toEqual({ wallets: [] });
    });

    it('should make POST request with body', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );

      await executeTool(
        'api',
        { method: 'POST', endpoint: '/send', body: { from: '0x1', to: '0x2', amount: '0.1' } },
        'token',
      );

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:4242/send',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ from: '0x1', to: '0x2', amount: '0.1' }),
        }),
      );
    });

    it('should work without token', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response('{"ok":true}', { status: 200 }),
      );

      await executeTool('api', { method: 'GET', endpoint: '/status' });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:4242/status',
        expect.objectContaining({
          headers: expect.not.objectContaining({
            Authorization: expect.any(String),
          }),
        }),
      );
    });

    it('should truncate long responses', async () => {
      const longResponse = 'x'.repeat(5000);
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(longResponse, { status: 200 }),
      );

      const result = await executeTool('api', { method: 'GET', endpoint: '/wallets' });
      expect(result.length).toBeLessThanOrEqual(4096 + 20); // 4KB + truncation marker
      expect(result).toContain('...[truncated]');
    });

    it('should not truncate encrypted credential read responses', async () => {
      // Credential ciphertext must stay intact; truncation makes client-side decryption fail.
      const longEncryptedPayload = JSON.stringify({
        success: true,
        credentialId: 'cred-abc123',
        encrypted: 'x'.repeat(5000),
      });
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(longEncryptedPayload, { status: 200 }),
      );

      const result = await executeTool('api', {
        method: 'POST',
        endpoint: '/credentials/cred-abc123/read',
        body: {},
      });

      expect(result).toBe(longEncryptedPayload);
      expect(result).not.toContain('...[truncated]');
    });

    it('should pass through 401 (expired token) from wallet server', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: 'Invalid or expired token' }), { status: 401 }),
      );

      const result = await executeTool(
        'api',
        { method: 'GET', endpoint: '/wallets' },
        'expired-token',
      );

      // MCP layer is a passthrough — 401 goes directly to the agent
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('expired');
    });

    it('should pass through 403 (spending limit exceeded) from wallet server', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({
          error: 'Spending limit exceeded',
          limit: '0.1',
          spent: '0.1',
          requested: '0.05',
        }), { status: 403 }),
      );

      const result = await executeTool(
        'api',
        { method: 'POST', endpoint: '/send', body: { amount: '0.05' } },
        'limited-token',
      );

      // MCP layer passes spending limit errors through — server enforces limits
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Spending limit exceeded');
      expect(parsed.limit).toBe('0.1');
      expect(parsed.spent).toBe('0.1');
    });

    it('should block sensitive endpoints in generic api tool', async () => {
      const blockedAuthClaim = await executeTool('api', { method: 'GET', endpoint: '/auth/req-123' });
      const blockedSecrets = await executeTool('api', { method: 'GET', endpoint: '/credentials/cred-1/secrets' });
      const blockedTotp = await executeTool('api', { method: 'POST', endpoint: '/credentials/cred-1/totp' });
      const blockedShareRead = await executeTool('api', { method: 'POST', endpoint: '/credential-shares/tok-1/read' });

      expect(JSON.parse(blockedAuthClaim).error).toContain('Sensitive endpoint is blocked');
      expect(JSON.parse(blockedSecrets).error).toContain('Sensitive endpoint is blocked');
      expect(JSON.parse(blockedTotp).error).toContain('Sensitive endpoint is blocked');
      expect(JSON.parse(blockedShareRead).error).toContain('Sensitive endpoint is blocked');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should redact secret-shaped values from passthrough responses', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify({
          token: 'abc123',
          nested: { password: 'p@ss' },
          callback: 'https://localhost/path?secret=xyz',
        }), { status: 200 }),
      );

      const result = await executeTool('api', { method: 'GET', endpoint: '/wallets' });
      const parsed = JSON.parse(result);
      expect(parsed.token).toBe('[REDACTED]');
      expect(parsed.nested.password).toBe('[REDACTED]');
      expect(parsed.callback).toContain('secret=%5BREDACTED%5D');
    });

    it('should handle fetch errors gracefully', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error('Connection refused'));

      const result = await executeTool('api', { method: 'GET', endpoint: '/wallets' });
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain('Connection refused');
    });
  });
});
