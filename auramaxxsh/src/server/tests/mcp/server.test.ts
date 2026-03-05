/**
 * Tests for MCP server — zod schema generation, tool registration, token passthrough
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { TOOLS, jsonSchemaToZod } from '../../mcp/tools';
import { buildOperationBindingHashes } from '../../lib/temp-policy';

describe('MCP Server — Zod Schema Generation', () => {
  describe('string types', () => {
    it('should convert string type to z.string()', () => {
      const shape = jsonSchemaToZod(
        { name: { type: 'string', description: 'A name' } },
        ['name'],
      );
      expect(() => shape.name.parse('hello')).not.toThrow();
      expect(() => shape.name.parse(123)).toThrow();
    });

    it('should convert string with enum to z.enum()', () => {
      const shape = jsonSchemaToZod(
        { method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method' } },
        ['method'],
      );
      expect(() => shape.method.parse('GET')).not.toThrow();
      expect(() => shape.method.parse('POST')).not.toThrow();
      expect(() => shape.method.parse('DELETE')).toThrow();
    });
  });

  describe('object types', () => {
    it('should convert object type to z.record(z.unknown())', () => {
      const shape = jsonSchemaToZod(
        { body: { type: 'object', description: 'Request body' } },
        ['body'],
      );
      expect(() => shape.body.parse({ key: 'value' })).not.toThrow();
      expect(() => shape.body.parse('not-an-object')).toThrow();
    });
  });

  describe('array types', () => {
    it('should convert array type to z.array(z.unknown())', () => {
      const shape = jsonSchemaToZod(
        { permissions: { type: 'array', description: 'Permissions list' } },
        ['permissions'],
      );
      expect(() => shape.permissions.parse(['swap', 'send:hot'])).not.toThrow();
      expect(() => shape.permissions.parse('not-an-array')).toThrow();
    });
  });

  describe('number types', () => {
    it('should convert number type to z.number()', () => {
      const shape = jsonSchemaToZod(
        { ttl: { type: 'number', description: 'Time to live' } },
        [],
      );
      expect(() => shape.ttl.parse(120)).not.toThrow();
      expect(() => shape.ttl.parse('120')).toThrow();
    });
  });

  describe('unknown types', () => {
    it('should fall back to z.unknown() for unrecognized types', () => {
      const shape = jsonSchemaToZod(
        { weird: { type: 'boolean', description: 'Some bool' } },
        ['weird'],
      );
      // z.unknown() accepts anything
      expect(() => shape.weird.parse(true)).not.toThrow();
      expect(() => shape.weird.parse('anything')).not.toThrow();
      expect(() => shape.weird.parse(42)).not.toThrow();
    });
  });

  describe('required vs optional', () => {
    it('should make required fields non-optional', () => {
      const shape = jsonSchemaToZod(
        { name: { type: 'string' } },
        ['name'],
      );
      expect(shape.name.isOptional()).toBe(false);
    });

    it('should make non-required fields optional', () => {
      const shape = jsonSchemaToZod(
        { name: { type: 'string' } },
        [],
      );
      expect(shape.name.isOptional()).toBe(true);
    });

    it('should handle mixed required and optional fields', () => {
      const shape = jsonSchemaToZod(
        {
          method: { type: 'string', enum: ['GET', 'POST'] },
          endpoint: { type: 'string' },
          body: { type: 'object' },
        },
        ['method', 'endpoint'],
      );
      expect(shape.method.isOptional()).toBe(false);
      expect(shape.endpoint.isOptional()).toBe(false);
      expect(shape.body.isOptional()).toBe(true);
    });
  });

  describe('descriptions', () => {
    it('should preserve descriptions on zod types', () => {
      const shape = jsonSchemaToZod(
        { name: { type: 'string', description: 'The name field' } },
        ['name'],
      );
      expect(shape.name.description).toBe('The name field');
    });

    it('should handle missing descriptions', () => {
      const shape = jsonSchemaToZod(
        { name: { type: 'string' } },
        ['name'],
      );
      expect(shape.name.description).toBeUndefined();
    });
  });
});

describe('MCP Server — Tool Schema Compatibility', () => {
  it('should generate valid zod schemas for api tool', () => {
    const tool = TOOLS.find((t) => t.name === 'api')!;
    const shape = jsonSchemaToZod(
      tool.parameters.properties,
      tool.parameters.required || [],
    );

    // Required fields
    expect(shape.method.isOptional()).toBe(false);
    expect(shape.endpoint.isOptional()).toBe(false);
    // Optional fields
    expect(shape.body.isOptional()).toBe(true);

    // Valid input
    const schema = z.object(shape);
    expect(() => schema.parse({ method: 'GET', endpoint: '/wallets' })).not.toThrow();
    expect(() => schema.parse({ method: 'POST', endpoint: '/send', body: { amount: '0.1' } })).not.toThrow();

    // PATCH is valid
    expect(() => schema.parse({ method: 'PATCH', endpoint: '/defaults/limits.fund', body: { value: 0 } })).not.toThrow();

    // method is an enum — rejects invalid values
    expect(() => schema.parse({ method: 'TRACE', endpoint: '/wallets' })).toThrow();

    // Missing required fields
    expect(() => schema.parse({ method: 'GET' })).toThrow();
    expect(() => schema.parse({ endpoint: '/wallets' })).toThrow();
  });

  it('should generate schemas for all TOOLS without errors', () => {
    for (const tool of TOOLS) {
      expect(() => {
        jsonSchemaToZod(
          tool.parameters.properties,
          tool.parameters.required || [],
        );
      }).not.toThrow();
    }
  });
});

describe('MCP Server — Tool Registration', () => {
  it('should register all tools with McpServer', async () => {
    const registeredTools: Array<{ name: string; description: string }> = [];

    // Mock McpServer and StdioServerTransport
    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, description: string, _shape: unknown, _handler: unknown) {
          registeredTools.push({ name, description });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    // Import server module (triggers registration)
    await import('../../mcp/server.js');

    // 12 inline tools + 3 shared tools = 15 total
    expect(registeredTools.length).toBe(15);
    expect(registeredTools[0].name).toBe('get_secret');
    expect(registeredTools[1].name).toBe('put_secret');
    expect(registeredTools[2].name).toBe('write_diary');
    expect(registeredTools[3].name).toBe('del_secret');
    expect(registeredTools[4].name).toBe('inject_secret');
    expect(registeredTools[5].name).toBe('share_secret');
    expect(registeredTools[6].name).toBe('auth');
    expect(registeredTools[7].name).toBe('get_token');
    expect(registeredTools[8].name).toBe('approve');
    expect(registeredTools[9].name).toBe('start');
    expect(registeredTools[10].name).toBe('unlock');
    expect(registeredTools[11].name).toBe('doctor');
    // Shared tools from TOOLS array
    expect(registeredTools[12].name).toBe('api');
    expect(registeredTools[13].name).toBe('status');
    expect(registeredTools[14].name).toBe('list_secrets');

    // Removed tools should NOT be present
    expect(registeredTools.map(t => t.name)).not.toContain('create_agent');
    expect(registeredTools.map(t => t.name)).not.toContain('request_human_action');
    expect(registeredTools.map(t => t.name)).not.toContain('wallet_api');
    expect(registeredTools.map(t => t.name)).not.toContain('aura_list_wallets');
    expect(registeredTools.map(t => t.name)).not.toContain('aura_list_agents');
    expect(registeredTools.map(t => t.name)).not.toContain('aura_list_credentials');

    for (const tool of registeredTools) {
      expect(tool.description).toBeTruthy();
    }

    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('should register API/auth/guide resources', async () => {
    const registeredResources: Array<{ name: string; uri: string }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool() {}
        resource(name: string, uri: string, _metaOrCb: unknown, _cb?: unknown) {
          registeredResources.push({ name, uri });
        }
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    await import('../../mcp/server.js');

    expect(registeredResources).toHaveLength(3);
    expect(registeredResources[0]).toEqual({ name: 'api-reference', uri: 'docs://api' });
    expect(registeredResources[1]).toEqual({ name: 'auth-reference', uri: 'docs://auth' });
    expect(registeredResources[2]).toEqual({ name: 'agent-guide', uri: 'docs://guide' });

    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('should pass AURA_TOKEN from env to executeTool handler', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    // Set env before import
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'test-env-token';

    // Re-import to get fresh module with env token
    vi.resetModules();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }),
    );

    await import('../../mcp/server.js');

    const apiTool = capturedHandlers.find((tool) => tool.name === 'api');
    expect(apiTool).toBeDefined();
    await apiTool!.handler({ method: 'GET', endpoint: '/wallets' });

    // Verify token was passed through
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/wallets'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-env-token',
        }),
      }),
    );

    // Cleanup
    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('should return MCP-formatted content from tool handler', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"wallets":[]}', { status: 200 }),
    );

    await import('../../mcp/server.js');

    const apiTool = capturedHandlers.find((tool) => tool.name === 'api');
    expect(apiTool).toBeDefined();
    const result = await apiTool!.handler({ method: 'GET', endpoint: '/wallets' });

    // MCP responses must be { content: [{ type: 'text', text: string }] }
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: '{"wallets":[]}',
        },
      ],
    });

    globalThis.fetch = originalFetch;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('approve should call /actions/:id/approve with current token and return API payload', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'admin-token';

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (url.endsWith('/actions/act_123/approve') && method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          id: 'act_123',
        }), { status: 200 });
      }
      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');

    const approveTool = capturedHandlers.find((tool) => tool.name === 'approve');
    expect(approveTool).toBeDefined();

    const result = await approveTool!.handler({
      actionId: 'act_123',
      walletAccess: ['0xabc'],
      limits: { fund: 0.1 },
    }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text) as {
      success?: boolean;
      status?: string;
      id?: string;
    };
    expect(payload.success).toBe(true);
    expect(payload.status).toBe('approved');
    expect(payload.id).toBe('act_123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchArgs = fetchMock.mock.calls[0];
    expect(String(fetchArgs[0])).toContain('/actions/act_123/approve');
    const init = fetchArgs[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer admin-token');
    expect(JSON.parse(String(init.body))).toEqual({
      walletAccess: ['0xabc'],
      limits: { fund: 0.1 },
    });

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('approve should return session escalation payload when admin permission is missing', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'non-admin-token';

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/actions/act_403/approve') && method === 'POST') {
        return new Response(JSON.stringify({
          contractVersion: 'v1',
          error: 'Admin access required',
          requiresHumanApproval: true,
          reqId: 'req-approve-admin',
          secret: 'sec-approve-admin',
          approvalScope: 'session_token',
          approveUrl: 'http://localhost:4747/approve/req-approve-admin',
          claimStatus: 'pending',
          retryReady: false,
          claimAction: { transport: 'mcp', kind: 'tool', tool: 'get_token', args: { reqId: 'req-approve-admin' } },
          retryAction: { transport: 'mcp', kind: 'tool', tool: '<retry_original_tool>', args: { reqId: 'req-approve-admin' } },
          instructions: [
            '1) Ask human to approve: http://localhost:4747/approve/req-approve-admin',
            '2) Claim now: call MCP tool get_token with {"reqId":"req-approve-admin"}',
            '3) Retry now: rerun the same MCP tool call and include {"reqId":"req-approve-admin"}',
          ],
        }), { status: 403 });
      }

      if (url.endsWith('/auth/req-approve-admin') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          status: 'pending',
        }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');

    const approveTool = capturedHandlers.find((tool) => tool.name === 'approve');
    expect(approveTool).toBeDefined();

    const result = await approveTool!.handler({ actionId: 'act_403' }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text) as {
      requiresHumanApproval?: boolean;
      reqId?: string;
      approvalScope?: string;
      claimAction?: { tool?: string; args?: { reqId?: string } };
      retryAction?: { tool?: string; args?: { reqId?: string } };
    };
    expect(payload.requiresHumanApproval).toBe(true);
    expect(payload.reqId).toBe('req-approve-admin');
    expect(payload.approvalScope).toBe('session_token');
    expect(payload.claimAction?.tool).toBe('get_token');
    expect(payload.claimAction?.args?.reqId).toBe('req-approve-admin');
    expect(payload.retryAction?.tool).toBe('<retry_original_tool>');
    expect(payload.retryAction?.args?.reqId).toBe('req-approve-admin');

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('approve e2e should escalate, claim by reqId, then succeed on retry with activated session token', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        privateDecrypt: vi.fn((_opts: unknown, ciphertext: Buffer) => {
          const marker = ciphertext.toString('utf8');
          if (marker === 'session-admin-cipher') return Buffer.from('session-admin-token', 'utf8');
          throw new Error(`Unexpected privateDecrypt input: ${marker}`);
        }),
      };
    });

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'non-admin-token';

    const approvalAuthHeaders: string[] = [];
    const sessionCipher = Buffer.from('session-admin-cipher', 'utf8').toString('base64');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/actions/act_e2e/approve') && method === 'POST') {
        const headers = init?.headers as Record<string, string> | undefined;
        const authHeader = headers?.Authorization || '';
        approvalAuthHeaders.push(authHeader);
        if (authHeader === 'Bearer non-admin-token') {
          return new Response(JSON.stringify({
            contractVersion: 'v1',
            error: 'Admin access required',
            requiresHumanApproval: true,
            reqId: 'req-approve-e2e',
            secret: 'sec-approve-e2e',
            approvalScope: 'session_token',
            approveUrl: 'http://localhost:4747/approve/req-approve-e2e',
            claimStatus: 'pending',
            retryReady: false,
            claimAction: { transport: 'mcp', kind: 'tool', tool: 'get_token', args: { reqId: 'req-approve-e2e' } },
            retryAction: { transport: 'mcp', kind: 'tool', tool: '<retry_original_tool>', args: { reqId: 'req-approve-e2e' } },
            instructions: [
              '1) Ask human to approve: http://localhost:4747/approve/req-approve-e2e',
              '2) Claim now: call MCP tool get_token with {"reqId":"req-approve-e2e"}',
              '3) Retry now: rerun the same MCP tool call and include {"reqId":"req-approve-e2e"}',
            ],
          }), { status: 403 });
        }
        if (authHeader === 'Bearer session-admin-token') {
          return new Response(JSON.stringify({
            success: true,
            status: 'approved',
            id: 'act_e2e',
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      }

      if (url.endsWith('/auth/req-approve-e2e') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: sessionCipher,
          ttl: 900,
        }), { status: 200 });
      }

      if (url.endsWith('/auth/validate') && method === 'POST') {
        return new Response(JSON.stringify({ valid: true }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');

    const approveTool = capturedHandlers.find((tool) => tool.name === 'approve');
    const getTokenTool = capturedHandlers.find((tool) => tool.name === 'get_token');
    expect(approveTool).toBeDefined();
    expect(getTokenTool).toBeDefined();

    const firstApprove = await approveTool!.handler({ actionId: 'act_e2e' }) as { content: Array<{ text: string }> };
    const deniedPayload = JSON.parse(firstApprove.content[0].text) as {
      requiresHumanApproval?: boolean;
      reqId?: string;
      approvalScope?: string;
      claimAction?: { tool?: string; args?: { reqId?: string } };
      retryAction?: { tool?: string; args?: { reqId?: string } };
    };
    expect(deniedPayload.requiresHumanApproval).toBe(true);
    expect(deniedPayload.reqId).toBe('req-approve-e2e');
    expect(deniedPayload.approvalScope).toBe('session_token');
    expect(deniedPayload.claimAction?.tool).toBe('get_token');
    expect(deniedPayload.claimAction?.args?.reqId).toBe('req-approve-e2e');
    expect(deniedPayload.retryAction?.tool).toBe('<retry_original_tool>');
    expect(deniedPayload.retryAction?.args?.reqId).toBe('req-approve-e2e');

    const claimed = await getTokenTool!.handler({ reqId: 'req-approve-e2e' }) as { content: Array<{ text: string }> };
    const claimPayload = JSON.parse(claimed.content[0].text) as {
      hasToken?: boolean;
      claimStatus?: string;
      retryReady?: boolean;
      requiresHumanApproval?: boolean;
    };
    expect(claimPayload.hasToken).toBe(true);
    expect(claimPayload.claimStatus).toBe('approved');
    expect(claimPayload.retryReady).toBe(true);
    expect(claimPayload.requiresHumanApproval).toBe(false);

    const secondApprove = await approveTool!.handler({ actionId: 'act_e2e' }) as { content: Array<{ text: string }> };
    const approvedPayload = JSON.parse(secondApprove.content[0].text) as {
      success?: boolean;
      status?: string;
      id?: string;
    };
    expect(approvedPayload.success).toBe(true);
    expect(approvedPayload.status).toBe('approved');
    expect(approvedPayload.id).toBe('act_e2e');

    expect(approvalAuthHeaders).toEqual([
      'Bearer non-admin-token',
      'Bearer session-admin-token',
    ]);

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('crypto');
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('auth should return explicit approve->claim->retry guidance and never auto-poll in background', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    delete process.env.AURA_TOKEN;

    let requestedProfile: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/auth') && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as { profile?: string };
        requestedProfile = body.profile;
        return new Response(JSON.stringify({
          requestId: 'req-auth',
          secret: 'sec-auth',
          approveUrl: 'http://localhost:4747/approve/req-auth',
        }), { status: 200 });
      }

      if (url.endsWith('/auth/req-auth')) {
        return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');

    const authTool = capturedHandlers.find((tool) => tool.name === 'auth');
    expect(authTool).toBeDefined();

    const authResult = await authTool!.handler({ agentId: 'codex-test' }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(authResult.content[0].text) as {
      requiresHumanApproval?: boolean;
      reqId?: string;
      approveUrl?: string;
      pollUrl?: string;
      claim?: { method?: string; endpoint?: string };
      approvalFlow?: { mode?: string; steps?: string[] };
    };
    expect(payload.requiresHumanApproval).toBe(true);
    expect(payload.reqId).toBe('req-auth');
    expect(payload.approveUrl).toBe('http://localhost:4747/approve/req-auth');
    expect(payload.pollUrl).toBe('http://127.0.0.1:4242/auth/req-auth');
    expect(payload.claim?.method).toBe('GET');
    expect(payload.claim?.endpoint).toBe('/auth/req-auth');
    expect(payload.approvalFlow?.mode).toBe('manual_auth_claim');
    expect(payload.approvalFlow?.steps?.[0]).toContain('Approve in dashboard');
    expect(payload.approvalFlow?.steps?.[1]).toContain('Claim token');
    expect(requestedProfile).toBe('dev');

    // `auth` must not auto-poll.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/req-auth')),
    ).toBe(false);

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_token should explicitly poll/claim pending auth requests (no background polling)', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    delete process.env.AURA_TOKEN;

    let claimPollCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/auth') && method === 'POST') {
        return new Response(JSON.stringify({
          requestId: 'req-auth',
          secret: 'sec-auth',
          approveUrl: 'http://localhost:4747/approve/req-auth',
        }), { status: 200 });
      }

      if (url.endsWith('/auth/req-auth') && method === 'GET') {
        claimPollCalls += 1;
        return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');

    const authTool = capturedHandlers.find((tool) => tool.name === 'auth');
    const getTokenTool = capturedHandlers.find((tool) => tool.name === 'get_token');
    expect(authTool).toBeDefined();
    expect(getTokenTool).toBeDefined();

    await authTool!.handler({ agentId: 'codex-test' });

    // No background auto-poll before explicit get_token call.
    expect(claimPollCalls).toBe(0);

    const firstPoll = await getTokenTool!.handler({ reqId: 'req-auth' }) as { content: Array<{ text: string }> };
    const firstPayload = JSON.parse(firstPoll.content[0].text) as {
      hasToken?: boolean;
      reqId?: string;
      status?: string;
      requiresHumanApproval?: boolean;
      pollUrl?: string;
      claim?: { method?: string; endpoint?: string };
      approvalFlow?: { mode?: string; steps?: string[] };
      claimAction?: { tool?: string; args?: { reqId?: string } };
      retryAction?: { tool?: string; args?: { reqId?: string } };
    };
    expect(firstPayload.hasToken).toBe(false);
    expect(firstPayload.reqId).toBe('req-auth');
    expect(firstPayload.status).toBe('polling');
    expect(firstPayload.requiresHumanApproval).toBe(true);
    expect(firstPayload.pollUrl).toBe('http://127.0.0.1:4242/auth/req-auth');
    expect(firstPayload.claim?.method).toBe('GET');
    expect(firstPayload.claim?.endpoint).toBe('/auth/req-auth');
    expect(firstPayload.approvalFlow?.mode).toBe('manual_auth_claim');
    expect(firstPayload.approvalFlow?.steps?.[1]).toContain('Claim token');
    expect(firstPayload.claimAction?.tool).toBe('get_token');
    expect(firstPayload.claimAction?.args?.reqId).toBe('req-auth');
    expect(firstPayload.retryAction?.tool).toBe('<retry_original_tool>');
    expect(firstPayload.retryAction?.args?.reqId).toBe('req-auth');
    expect(claimPollCalls).toBe(1);

    await getTokenTool!.handler({ reqId: 'req-auth' });
    expect(claimPollCalls).toBe(2);

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_token should poll and activate pending auth even when a stale session token already exists', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        privateDecrypt: vi.fn((_opts: unknown, ciphertext: Buffer) => {
          const marker = ciphertext.toString('utf8');
          if (marker === 'fresh-session-cipher') return Buffer.from('fresh-session-token', 'utf8');
          throw new Error(`Unexpected privateDecrypt input: ${marker}`);
        }),
      };
    });

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'stale-session-token';

    const freshCipher = Buffer.from('fresh-session-cipher', 'utf8').toString('base64');
    let claimPollCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/auth') && method === 'POST') {
        return new Response(JSON.stringify({
          requestId: 'req-refresh',
          secret: 'sec-refresh',
          approveUrl: 'http://localhost:4747/approve/req-refresh',
        }), { status: 200 });
      }

      if (url.endsWith('/auth/req-refresh') && method === 'GET') {
        claimPollCalls += 1;
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: freshCipher,
          ttl: 120,
        }), { status: 200 });
      }

      if (url.includes('/wallets') && method === 'GET') {
        const headers = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({
          seenAuth: headers.Authorization || null,
        }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');

    const authTool = capturedHandlers.find((tool) => tool.name === 'auth');
    const getTokenTool = capturedHandlers.find((tool) => tool.name === 'get_token');
    const apiTool = capturedHandlers.find((tool) => tool.name === 'api');
    expect(authTool).toBeDefined();
    expect(getTokenTool).toBeDefined();
    expect(apiTool).toBeDefined();

    await authTool!.handler({ agentId: 'codex-test', profile: 'strict' });

    const claimed = await getTokenTool!.handler({ reqId: 'req-refresh' }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(claimed.content[0].text) as {
      hasToken?: boolean;
      status?: string;
      claimStatus?: string;
      retryReady?: boolean;
      requiresHumanApproval?: boolean;
    };
    expect(claimPollCalls).toBe(1);
    expect(payload.hasToken).toBe(true);
    expect(payload.status).toBe('approved');
    expect(payload.claimStatus).toBe('approved');
    expect(payload.retryReady).toBe(true);
    expect(payload.requiresHumanApproval).toBe(false);

    const apiResult = await apiTool!.handler({ method: 'GET', endpoint: '/wallets' }) as { content: Array<{ text: string }> };
    const apiPayload = JSON.parse(apiResult.content[0].text) as { seenAuth?: string };
    expect(apiPayload.seenAuth).toBe('Bearer fresh-session-token');

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('crypto');
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_token should include pollUrl + claim details when auth request is rejected', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    delete process.env.AURA_TOKEN;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/auth') && method === 'POST') {
        return new Response(JSON.stringify({
          requestId: 'req-auth-rejected',
          secret: 'sec-auth-rejected',
          approveUrl: 'http://localhost:4747/approve/req-auth-rejected',
        }), { status: 200 });
      }

      if (url.endsWith('/auth/req-auth-rejected') && method === 'GET') {
        return new Response('rejected', { status: 403 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');

    const authTool = capturedHandlers.find((tool) => tool.name === 'auth');
    const getTokenTool = capturedHandlers.find((tool) => tool.name === 'get_token');
    expect(authTool).toBeDefined();
    expect(getTokenTool).toBeDefined();

    await authTool!.handler({ agentId: 'codex-test' });
    const denied = await getTokenTool!.handler({ reqId: 'req-auth-rejected' }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(denied.content[0].text) as {
      hasToken?: boolean;
      reqId?: string;
      status?: string;
      requiresHumanApproval?: boolean;
      approveUrl?: string;
      pollUrl?: string;
      claim?: { method?: string; endpoint?: string; command?: string };
      approvalFlow?: { mode?: string; steps?: string[] };
      claimAction?: { tool?: string; args?: { reqId?: string } };
      retryAction?: { tool?: string; args?: { reqId?: string } };
    };
    expect(payload.hasToken).toBe(false);
    expect(payload.reqId).toBe('req-auth-rejected');
    expect(payload.status).toBe('rejected');
    expect(payload.requiresHumanApproval).toBe(true);
    expect(payload.approveUrl).toBe('http://localhost:4747/approve/req-auth-rejected');
    expect(payload.pollUrl).toBe('http://127.0.0.1:4242/auth/req-auth-rejected');
    expect(payload.claim?.method).toBe('GET');
    expect(payload.claim?.endpoint).toBe('/auth/req-auth-rejected');
    expect(payload.claim?.command).toContain('curl -s');
    expect(payload.approvalFlow?.mode).toBe('manual_auth_claim');
    expect(payload.claimAction?.tool).toBe('get_token');
    expect(payload.claimAction?.args?.reqId).toBe('req-auth-rejected');
    expect(payload.retryAction?.tool).toBe('<retry_original_tool>');
    expect(payload.retryAction?.args?.reqId).toBe('req-auth-rejected');

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_token should map 410 claim poll to expired deterministically', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    delete process.env.AURA_TOKEN;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/auth') && method === 'POST') {
        return new Response(JSON.stringify({
          requestId: 'req-auth-expired',
          secret: 'sec-auth-expired',
          approveUrl: 'http://localhost:4747/approve/req-auth-expired',
        }), { status: 200 });
      }

      if (url.endsWith('/auth/req-auth-expired') && method === 'GET') {
        return new Response('consumed', { status: 410 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');

    const authTool = capturedHandlers.find((tool) => tool.name === 'auth');
    const getTokenTool = capturedHandlers.find((tool) => tool.name === 'get_token');
    expect(authTool).toBeDefined();
    expect(getTokenTool).toBeDefined();

    await authTool!.handler({ agentId: 'codex-test' });
    const expired = await getTokenTool!.handler({ reqId: 'req-auth-expired' }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(expired.content[0].text) as {
      reqId?: string;
      status?: string;
      claimStatus?: string;
      retryReady?: boolean;
      note?: string;
    };
    expect(payload.reqId).toBe('req-auth-expired');
    expect(payload.status).toBe('expired');
    expect(payload.claimStatus).toBe('expired');
    expect(payload.retryReady).toBe(false);
    expect(String(payload.note || '')).toContain('expired');

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_token should surface claim_poll_failed when session claim poll returns non-OK', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    delete process.env.AURA_TOKEN;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/auth') && method === 'POST') {
        return new Response(JSON.stringify({
          requestId: 'req-auth-poll-failed',
          secret: 'sec-auth-poll-failed',
          approveUrl: 'http://localhost:4747/approve/req-auth-poll-failed',
        }), { status: 200 });
      }

      if (url.endsWith('/auth/req-auth-poll-failed') && method === 'GET') {
        return new Response('upstream error', { status: 500 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');

    const authTool = capturedHandlers.find((tool) => tool.name === 'auth');
    const getTokenTool = capturedHandlers.find((tool) => tool.name === 'get_token');
    expect(authTool).toBeDefined();
    expect(getTokenTool).toBeDefined();

    await authTool!.handler({ agentId: 'codex-test' });
    const failed = await getTokenTool!.handler({ reqId: 'req-auth-poll-failed' }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(failed.content[0].text) as {
      success?: boolean;
      reqId?: string;
      status?: string;
      claimStatus?: string;
      retryReady?: boolean;
      errorCode?: string;
      error?: string;
    };
    expect(payload.success).toBe(false);
    expect(payload.reqId).toBe('req-auth-poll-failed');
    expect(payload.status).toBe('polling');
    expect(payload.claimStatus).toBe('pending');
    expect(payload.retryReady).toBe(false);
    expect(payload.errorCode).toBe('claim_poll_failed');
    expect(String(payload.error || '')).toContain('500');

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_token should surface claim_network_error when session claim poll throws', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    delete process.env.AURA_TOKEN;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/auth') && method === 'POST') {
        return new Response(JSON.stringify({
          requestId: 'req-auth-network-failed',
          secret: 'sec-auth-network-failed',
          approveUrl: 'http://localhost:4747/approve/req-auth-network-failed',
        }), { status: 200 });
      }

      if (url.endsWith('/auth/req-auth-network-failed') && method === 'GET') {
        throw new Error('socket hang up');
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');

    const authTool = capturedHandlers.find((tool) => tool.name === 'auth');
    const getTokenTool = capturedHandlers.find((tool) => tool.name === 'get_token');
    expect(authTool).toBeDefined();
    expect(getTokenTool).toBeDefined();

    await authTool!.handler({ agentId: 'codex-test' });
    const failed = await getTokenTool!.handler({ reqId: 'req-auth-network-failed' }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(failed.content[0].text) as {
      success?: boolean;
      reqId?: string;
      status?: string;
      claimStatus?: string;
      retryReady?: boolean;
      errorCode?: string;
      error?: string;
    };
    expect(payload.success).toBe(false);
    expect(payload.reqId).toBe('req-auth-network-failed');
    expect(payload.status).toBe('polling');
    expect(payload.claimStatus).toBe('pending');
    expect(payload.retryReady).toBe(false);
    expect(payload.errorCode).toBe('claim_network_error');
    expect(String(payload.error || '')).toContain('socket hang up');

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_token with reqId should return deterministic missing_or_expired_claim when no bound claim exists', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'test-env-token';

    await import('../../mcp/server.js');
    const getTokenTool = capturedHandlers.find((tool) => tool.name === 'get_token');
    expect(getTokenTool).toBeDefined();

    const result = await getTokenTool!.handler({ reqId: 'req-missing' }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text) as {
      errorCode?: string;
      claimStatus?: string;
      retryReady?: boolean;
      reqId?: string;
    };
    expect(payload.reqId).toBe('req-missing');
    expect(payload.errorCode).toBe('missing_or_expired_claim');
    expect(payload.claimStatus).toBe('expired');
    expect(payload.retryReady).toBe(false);

    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_secret should return human-approval escalation on read 403 and never mint delegated tokens', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'test-env-token';

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/setup') && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), { status: 200 });
      }

      if (url.endsWith('/setup/agents') && method === 'GET') {
        return new Response(JSON.stringify({ agents: [{ id: 'primary', name: 'primary' }] }), { status: 200 });
      }

      if (url.includes('/credentials?q=github') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-1', name: 'github', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-1/read') && method === 'POST') {
        return new Response(JSON.stringify({
          contractVersion: 'v1',
          success: false,
          error: 'Insufficient permissions',
          requiresHumanApproval: true,
          reqId: 'req-session-escalation',
          secret: 'sec-session-escalation',
          approvalScope: 'session_token',
          approveUrl: 'http://localhost:4747/approve/req-session-escalation',
          claimStatus: 'pending',
          retryReady: false,
          claimAction: { transport: 'http', method: 'GET', endpoint: '/auth/req-session-escalation' },
          retryAction: { transport: 'http', method: 'POST', endpoint: '/credentials/cred-1/read' },
          instructions: [
            '1) Ask human to approve: http://localhost:4747/approve/req-session-escalation',
            '2) Claim now: call MCP tool get_token with {"reqId":"req-session-escalation"}',
            '3) Retry now: rerun the same MCP tool call and include {"reqId":"req-session-escalation"}',
          ],
        }), { status: 403 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const getSecret = capturedHandlers.find((tool) => tool.name === 'get_secret');
    expect(getSecret).toBeDefined();

    const result = await getSecret!.handler({ name: 'github' }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text) as {
      contractVersion?: string;
      requiresHumanApproval?: boolean;
      reqId?: string;
      approvalScope?: string;
      approveUrl?: string;
      claimAction?: { tool?: string; args?: { reqId?: string } };
      retryAction?: { tool?: string; args?: { reqId?: string } };
      instructions?: string[];
    };
    expect(payload.contractVersion).toBe('v1');
    expect(payload.requiresHumanApproval).toBe(true);
    expect(payload.reqId).toBe('req-session-escalation');
    expect(payload.approvalScope).toBe('session_token');
    expect(payload.approveUrl).toBe('http://localhost:4747/approve/req-session-escalation');
    expect(payload.claimAction?.tool).toBe('get_token');
    expect(payload.claimAction?.args?.reqId).toBe('req-session-escalation');
    expect(payload.retryAction?.tool).toBe('<retry_original_tool>');
    expect(payload.retryAction?.args?.reqId).toBe('req-session-escalation');
    expect(payload.instructions?.[2]).toContain('Retry');

    const readCall = fetchMock.mock.calls.find(([url, reqInit]) =>
      String(url).endsWith('/credentials/cred-1/read') && (reqInit?.method || 'GET') === 'POST',
    );
    expect(readCall).toBeDefined();
    expect((readCall?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer test-env-token');
    expect(
      fetchMock.mock.calls.some(([url, reqInit]) =>
        String(url).endsWith('/actions/token') && (reqInit?.method || 'GET') === 'POST'),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([url, reqInit]) =>
        String(url).endsWith('/auth') && (reqInit?.method || 'GET') === 'POST'),
    ).toBe(false);

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_secret should return explicit approve->claim->retry guidance and never auto-poll claim path', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'test-env-token';

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/setup') && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), { status: 200 });
      }

      if (url.endsWith('/setup/agents') && method === 'GET') {
        return new Response(JSON.stringify({ agents: [{ id: 'primary', name: 'primary' }] }), { status: 200 });
      }

      if (url.includes('/credentials?q=github') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-1', name: 'github', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-1/read') && method === 'POST') {
        return new Response(JSON.stringify({
          contractVersion: 'v1',
          success: false,
          requiresHumanApproval: true,
          reqId: 'req-escalated',
          secret: 'sec-escalated',
          approvalScope: 'one_shot_read',
          approveUrl: 'http://localhost:4747/approve/req-escalated',
          pollUrl: 'http://127.0.0.1:4242/auth/req-escalated',
          claim: { method: 'GET', endpoint: '/auth/req-escalated' },
          approvalFlow: {
            mode: 'one_time_scoped_read',
            steps: [
              '1) Approve in dashboard',
              '2) Claim approval token',
              '3) Retry',
            ],
          },
          reasonCode: 'DENY_EXCLUDED_FIELD',
          credential: { id: 'cred-1', name: 'github' },
        }), { status: 403 });
      }

      if (url.endsWith('/auth/req-escalated')) {
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: 'unused-in-this-test',
          ttl: 60,
        }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const getSecret = capturedHandlers.find((tool) => tool.name === 'get_secret');
    expect(getSecret).toBeDefined();

    const first = await getSecret!.handler({ name: 'github' }) as { content: Array<{ text: string }> };
    const firstPayload = JSON.parse(first.content[0].text) as {
      requiresHumanApproval?: boolean;
      reqId?: string;
      approveUrl?: string;
      pollUrl?: string;
      claim?: { endpoint?: string; method?: string; command?: string };
      approvalFlow?: { mode?: string; summary?: string; retryBehavior?: string; steps?: string[] };
    };
    expect(firstPayload.requiresHumanApproval).toBe(true);
    expect(firstPayload.reqId).toBe('req-escalated');
    expect(firstPayload.approveUrl).toBe('http://localhost:4747/approve/req-escalated');
    expect(firstPayload.pollUrl).toBe('http://127.0.0.1:4242/auth/req-escalated');
    expect(firstPayload.claim?.method).toBe('GET');
    expect(firstPayload.claim?.endpoint).toBe('/auth/req-escalated');
    expect(firstPayload.claim?.command).toBeUndefined();
    expect(firstPayload.approvalFlow?.mode).toBe('one_time_scoped_read');
    expect(firstPayload.approvalFlow?.steps?.[0]).toContain('Approve in dashboard');
    expect(firstPayload.approvalFlow?.steps?.[1]).toContain('Claim approval token');
    expect(firstPayload.approvalFlow?.steps?.[2]).toContain('Retry');

    // Must not auto-poll claim path in background.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/req-escalated')),
    ).toBe(false);

    // Without explicit claim, retries should continue to return approval guidance.
    const second = await getSecret!.handler({ name: 'github' }) as { content: Array<{ text: string }> };
    const secondPayload = JSON.parse(second.content[0].text) as { requiresHumanApproval?: boolean; reqId?: string };
    expect(secondPayload.requiresHumanApproval).toBe(true);
    expect(secondPayload.reqId).toBe('req-escalated');
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/req-escalated')),
    ).toBe(false);

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('inject_secret should return explicit claim guidance and never auto-poll claim path', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'test-env-token';

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/setup') && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), { status: 200 });
      }

      if (url.endsWith('/setup/agents') && method === 'GET') {
        return new Response(JSON.stringify({ agents: [{ id: 'primary', name: 'primary' }] }), { status: 200 });
      }

      if (url.includes('/credentials?q=github') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-1', name: 'github', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-1/read') && method === 'POST') {
        return new Response(JSON.stringify({
          contractVersion: 'v1',
          success: false,
          requiresHumanApproval: true,
          reqId: 'req-escalated',
          secret: 'sec-escalated',
          approvalScope: 'one_shot_read',
          approveUrl: 'http://localhost:4747/approve/req-escalated',
          pollUrl: 'http://127.0.0.1:4242/auth/req-escalated',
          claim: { method: 'GET', endpoint: '/auth/req-escalated' },
          approvalFlow: {
            mode: 'one_time_scoped_read',
            steps: [
              '1) Approve in dashboard',
              '2) Claim approval token',
              '3) Retry',
            ],
          },
          reasonCode: 'DENY_EXCLUDED_FIELD',
          credential: { id: 'cred-1', name: 'github' },
        }), { status: 403 });
      }

      if (url.endsWith('/auth/req-escalated')) {
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: 'unused-in-this-test',
          ttl: 60,
        }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const injectSecret = capturedHandlers.find((tool) => tool.name === 'inject_secret');
    expect(injectSecret).toBeDefined();

    const denied = await injectSecret!.handler({ name: 'github', envVar: 'GITHUB_TOKEN' }) as { content: Array<{ text: string }> };
    const deniedPayload = JSON.parse(denied.content[0].text) as {
      requiresHumanApproval?: boolean;
      reqId?: string;
      approveUrl?: string;
      pollUrl?: string;
      approvalFlow?: { mode?: string };
      claim?: { endpoint?: string; method?: string; command?: string };
    };
    expect(deniedPayload.requiresHumanApproval).toBe(true);
    expect(deniedPayload.reqId).toBe('req-escalated');
    expect(deniedPayload.approveUrl).toBe('http://localhost:4747/approve/req-escalated');
    expect(deniedPayload.pollUrl).toBe('http://127.0.0.1:4242/auth/req-escalated');
    expect(deniedPayload.approvalFlow?.mode).toBe('one_time_scoped_read');
    expect(deniedPayload.claim?.method).toBe('GET');
    expect(deniedPayload.claim?.endpoint).toBe('/auth/req-escalated');
    expect(deniedPayload.claim?.command).toBeUndefined();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/req-escalated')),
    ).toBe(false);

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_secret should pass through deterministic operation_binding_mismatch from server without re-escalation', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'test-env-token';

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/setup') && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), { status: 200 });
      }

      if (url.endsWith('/setup/agents') && method === 'GET') {
        return new Response(JSON.stringify({ agents: [{ id: 'primary', name: 'primary' }] }), { status: 200 });
      }

      if (url.includes('/credentials?q=github') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-1', name: 'github', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-1/read') && method === 'POST') {
        return new Response(JSON.stringify({
          contractVersion: 'v1',
          success: false,
          errorCode: 'operation_binding_mismatch',
          error: 'Claimed token is bound to POST credentials.read; this retry does not match the bound operation.',
          reqId: 'req-bind-pass',
          approvalScope: 'one_shot_read',
          claimStatus: 'approved',
          retryReady: false,
          policyHash: 'pol-pass',
          compilerVersion: 'v1',
          claimAction: { transport: 'http', method: 'GET', endpoint: '/auth/req-bind-pass' },
          retryAction: { transport: 'http', method: 'POST', endpoint: '/credentials/cred-1/read' },
        }), { status: 403 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const getSecret = capturedHandlers.find((tool) => tool.name === 'get_secret');
    expect(getSecret).toBeDefined();

    const result = await getSecret!.handler({ name: 'github' }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text) as {
      contractVersion?: string;
      errorCode?: string;
      reqId?: string;
      policyHash?: string;
      compilerVersion?: string;
      claimAction?: { tool?: string; args?: { reqId?: string } };
      retryAction?: { tool?: string; args?: { reqId?: string } };
    };
    expect(payload.contractVersion).toBe('v1');
    expect(payload.errorCode).toBe('operation_binding_mismatch');
    expect(payload.reqId).toBe('req-bind-pass');
    expect(payload.policyHash).toBe('pol-pass');
    expect(payload.compilerVersion).toBe('v1');
    expect(payload.claimAction?.tool).toBe('get_token');
    expect(payload.claimAction?.args?.reqId).toBe('req-bind-pass');
    expect(payload.retryAction?.tool).toBe('<retry_original_tool>');
    expect(payload.retryAction?.args?.reqId).toBe('req-bind-pass');
    expect(
      fetchMock.mock.calls.some(([url, reqInit]) =>
        String(url).endsWith('/auth') && (reqInit?.method || 'GET') === 'POST'),
    ).toBe(false);

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_secret with explicit reqId should fail deterministically when claim is missing (even with a session token)', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'test-env-token';
    globalThis.fetch = vi.fn(async () => new Response('not expected', { status: 500 })) as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const getSecret = capturedHandlers.find((tool) => tool.name === 'get_secret');
    expect(getSecret).toBeDefined();

    const result = await getSecret!.handler({ name: 'github', reqId: 'req-missing' }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text) as {
      errorCode?: string;
      claimStatus?: string;
      retryReady?: boolean;
      reqId?: string;
    };
    expect(payload.reqId).toBe('req-missing');
    expect(payload.errorCode).toBe('missing_or_expired_claim');
    expect(payload.claimStatus).toBe('expired');
    expect(payload.retryReady).toBe(false);

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('expired one-shot reqId should fail deterministically with no session fallback leakage', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        privateDecrypt: vi.fn((_opts: unknown, ciphertext: Buffer) => {
          const marker = ciphertext.toString('utf8');
          if (marker === 'claim-expiry-cipher') return Buffer.from('one-shot-expiry-bearer', 'utf8');
          throw new Error(`Unexpected privateDecrypt input: ${marker}`);
        }),
      };
    });

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'base-session-token';

    const claimCipher = Buffer.from('claim-expiry-cipher', 'utf8').toString('base64');
    const nowStart = Date.now();
    let now = nowStart;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let readCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/setup') && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), { status: 200 });
      }

      if (url.endsWith('/setup/agents') && method === 'GET') {
        return new Response(JSON.stringify({ agents: [{ id: 'primary', name: 'primary' }] }), { status: 200 });
      }

      if (url.includes('/credentials?q=github') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-1', name: 'github', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-1/read') && method === 'POST') {
        readCalls += 1;
        const headers = init?.headers as Record<string, string>;
        if (headers.Authorization === 'Bearer base-session-token') {
          return new Response(JSON.stringify({
            contractVersion: 'v1',
            success: false,
            requiresHumanApproval: true,
            reqId: 'req-expiry',
            secret: 'sec-expiry',
            approveUrl: 'http://localhost:4747/approve/req-expiry',
            reasonCode: 'DENY_EXCLUDED_FIELD',
            credential: { id: 'cred-1', name: 'github' },
          }), { status: 403 });
        }
        return new Response('unexpected token usage', { status: 500 });
      }

      if (url.endsWith('/auth/req-expiry') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: claimCipher,
          ttl: 1,
        }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const getSecret = capturedHandlers.find((tool) => tool.name === 'get_secret');
    const getToken = capturedHandlers.find((tool) => tool.name === 'get_token');
    expect(getSecret).toBeDefined();
    expect(getToken).toBeDefined();

    const denied = await getSecret!.handler({ name: 'github' }) as { content: Array<{ text: string }> };
    const deniedPayload = JSON.parse(denied.content[0].text) as { reqId?: string; requiresHumanApproval?: boolean };
    expect(deniedPayload.reqId).toBe('req-expiry');
    expect(deniedPayload.requiresHumanApproval).toBe(true);

    const claimed = await getToken!.handler({ reqId: 'req-expiry' }) as { content: Array<{ text: string }> };
    const claimPayload = JSON.parse(claimed.content[0].text) as { claimStatus?: string; retryReady?: boolean };
    expect(claimPayload.claimStatus).toBe('approved');
    expect(claimPayload.retryReady).toBe(true);

    now += 16_000;
    const expiredRetry = await getSecret!.handler({ name: 'github', reqId: 'req-expiry' }) as { content: Array<{ text: string }> };
    const expiredPayload = JSON.parse(expiredRetry.content[0].text) as { errorCode?: string; claimStatus?: string };
    expect(expiredPayload.errorCode).toBe('missing_or_expired_claim');
    expect(expiredPayload.claimStatus).toBe('expired');
    expect(readCalls).toBe(1);

    nowSpy.mockRestore();
    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('crypto');
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('one-shot flow should succeed once after claim and fail deterministically on replay', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        privateDecrypt: vi.fn((_opts: unknown, ciphertext: Buffer) => {
          const marker = ciphertext.toString('utf8');
          if (marker === 'claim-cipher') return Buffer.from('one-shot-bearer', 'utf8');
          if (marker === 'cred-cipher') {
            return Buffer.from(JSON.stringify({
              id: 'cred-1',
              agentId: 'primary',
              type: 'note',
              fields: [{ key: 'value', value: 'secret-from-one-shot', sensitive: true }],
            }), 'utf8');
          }
          throw new Error(`Unexpected privateDecrypt input: ${marker}`);
        }),
      };
    });

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'base-token';

    const claimCipher = Buffer.from('claim-cipher', 'utf8').toString('base64');
    const credentialCipher = Buffer.from('cred-cipher', 'utf8').toString('base64');
    let readCallCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/setup') && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), { status: 200 });
      }

      if (url.endsWith('/setup/agents') && method === 'GET') {
        return new Response(JSON.stringify({ agents: [{ id: 'primary', name: 'primary' }] }), { status: 200 });
      }

      if (url.includes('/credentials?q=github') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-1', name: 'github', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-1/read') && method === 'POST') {
        readCallCount += 1;
        const headers = init?.headers as Record<string, string>;
        if (headers.Authorization === 'Bearer base-token') {
          return new Response(JSON.stringify({
            contractVersion: 'v1',
            success: false,
            requiresHumanApproval: true,
            reqId: 'req-os',
            secret: 'sec-os',
            approveUrl: 'http://localhost:4747/approve/req-os',
            reasonCode: 'DENY_EXCLUDED_FIELD',
            credential: { id: 'cred-1', name: 'github' },
          }), { status: 403 });
        }
        if (headers.Authorization === 'Bearer one-shot-bearer') {
          return new Response(JSON.stringify({ encrypted: credentialCipher }), { status: 200 });
        }
      }

      if (url.endsWith('/auth/req-os') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: claimCipher,
          ttl: 60,
        }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const getSecret = capturedHandlers.find((tool) => tool.name === 'get_secret');
    const getToken = capturedHandlers.find((tool) => tool.name === 'get_token');
    expect(getSecret).toBeDefined();
    expect(getToken).toBeDefined();

    const denied = await getSecret!.handler({ name: 'github' }) as { content: Array<{ text: string }> };
    const deniedPayload = JSON.parse(denied.content[0].text) as {
      requiresHumanApproval?: boolean;
      reqId?: string;
      claimAction?: { args?: { reqId?: string } };
    };
    expect(deniedPayload.requiresHumanApproval).toBe(true);
    expect(deniedPayload.reqId).toBe('req-os');
    expect(deniedPayload.claimAction?.args?.reqId).toBe('req-os');

    const claimed = await getToken!.handler({ reqId: 'req-os' }) as { content: Array<{ text: string }> };
    const claimedPayload = JSON.parse(claimed.content[0].text) as {
      claimStatus?: string;
      retryReady?: boolean;
      requiresHumanApproval?: boolean;
    };
    expect(claimedPayload.claimStatus).toBe('approved');
    expect(claimedPayload.retryReady).toBe(true);
    expect(claimedPayload.requiresHumanApproval).toBe(false);

    const retried = await getSecret!.handler({ name: 'github', reqId: 'req-os' }) as { content: Array<{ text: string }> };
    const retriedPayload = JSON.parse(retried.content[0].text) as { success?: boolean; credentialId?: string };
    expect(retriedPayload.success).toBe(true);
    expect(retriedPayload.credentialId).toBe('cred-1');

    const replay = await getSecret!.handler({ name: 'github', reqId: 'req-os' }) as { content: Array<{ text: string }> };
    const replayPayload = JSON.parse(replay.content[0].text) as { errorCode?: string; claimStatus?: string };
    expect(replayPayload.errorCode).toBe('missing_or_expired_claim');
    expect(replayPayload.claimStatus).toBe('expired');
    expect(readCallCount).toBe(2);

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('crypto');
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('keeps concurrent one-shot reqIds isolated with no cross-token leakage', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        privateDecrypt: vi.fn((_opts: unknown, ciphertext: Buffer) => {
          const marker = ciphertext.toString('utf8');
          if (marker === 'claim-cipher-a') return Buffer.from('one-shot-a', 'utf8');
          if (marker === 'claim-cipher-b') return Buffer.from('one-shot-b', 'utf8');
          if (marker === 'cred-cipher-a') {
            return Buffer.from(JSON.stringify({
              id: 'cred-a',
              agentId: 'primary',
              type: 'note',
              fields: [{ key: 'value', value: 'alpha-secret', sensitive: true }],
            }), 'utf8');
          }
          if (marker === 'cred-cipher-b') {
            return Buffer.from(JSON.stringify({
              id: 'cred-b',
              agentId: 'primary',
              type: 'note',
              fields: [{ key: 'value', value: 'beta-secret', sensitive: true }],
            }), 'utf8');
          }
          throw new Error(`Unexpected privateDecrypt input: ${marker}`);
        }),
      };
    });

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'base-token';

    const claimCipherA = Buffer.from('claim-cipher-a', 'utf8').toString('base64');
    const claimCipherB = Buffer.from('claim-cipher-b', 'utf8').toString('base64');
    const credentialCipherA = Buffer.from('cred-cipher-a', 'utf8').toString('base64');
    const credentialCipherB = Buffer.from('cred-cipher-b', 'utf8').toString('base64');
    const bindingA = buildOperationBindingHashes({
      actorId: 'mcp-stdio',
      method: 'POST',
      routeId: 'credentials.read',
      resource: { credentialId: 'cred-a' },
      body: {},
      policyHash: 'pol-a',
    });
    const bindingB = buildOperationBindingHashes({
      actorId: 'mcp-stdio',
      method: 'POST',
      routeId: 'credentials.read',
      resource: { credentialId: 'cred-b' },
      body: {},
      policyHash: 'pol-b',
    });

    let readWithOneShotA = 0;
    let readWithOneShotB = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/setup') && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), { status: 200 });
      }

      if (url.endsWith('/setup/agents') && method === 'GET') {
        return new Response(JSON.stringify({ agents: [{ id: 'primary', name: 'primary' }] }), { status: 200 });
      }

      if (url.includes('/credentials?q=alpha') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-a', name: 'alpha', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.includes('/credentials?q=beta') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-b', name: 'beta', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-a/read') && method === 'POST') {
        const headers = init?.headers as Record<string, string>;
        if (headers.Authorization === 'Bearer base-token') {
          return new Response(JSON.stringify({
            contractVersion: 'v1',
            success: false,
            requiresHumanApproval: true,
            reqId: 'req-a',
            secret: 'sec-a',
            approveUrl: 'http://localhost:4747/approve/req-a',
            reasonCode: 'DENY_EXCLUDED_FIELD',
            credential: { id: 'cred-a', name: 'alpha' },
            policyHash: 'pol-a',
            compilerVersion: 'v1',
            binding: bindingA,
          }), { status: 403 });
        }
        if (headers.Authorization === 'Bearer one-shot-a') {
          readWithOneShotA += 1;
          return new Response(JSON.stringify({ encrypted: credentialCipherA }), { status: 200 });
        }
      }

      if (url.endsWith('/credentials/cred-b/read') && method === 'POST') {
        const headers = init?.headers as Record<string, string>;
        if (headers.Authorization === 'Bearer base-token') {
          return new Response(JSON.stringify({
            contractVersion: 'v1',
            success: false,
            requiresHumanApproval: true,
            reqId: 'req-b',
            secret: 'sec-b',
            approveUrl: 'http://localhost:4747/approve/req-b',
            reasonCode: 'DENY_EXCLUDED_FIELD',
            credential: { id: 'cred-b', name: 'beta' },
            policyHash: 'pol-b',
            compilerVersion: 'v1',
            binding: bindingB,
          }), { status: 403 });
        }
        if (headers.Authorization === 'Bearer one-shot-b') {
          readWithOneShotB += 1;
          return new Response(JSON.stringify({ encrypted: credentialCipherB }), { status: 200 });
        }
      }

      if (url.endsWith('/auth/req-a') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: claimCipherA,
          ttl: 60,
        }), { status: 200 });
      }

      if (url.endsWith('/auth/req-b') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: claimCipherB,
          ttl: 60,
        }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const getSecret = capturedHandlers.find((tool) => tool.name === 'get_secret');
    const getToken = capturedHandlers.find((tool) => tool.name === 'get_token');
    expect(getSecret).toBeDefined();
    expect(getToken).toBeDefined();

    const deniedAlpha = await getSecret!.handler({ name: 'alpha' }) as { content: Array<{ text: string }> };
    const deniedAlphaPayload = JSON.parse(deniedAlpha.content[0].text) as { reqId?: string };
    expect(deniedAlphaPayload.reqId).toBe('req-a');

    const deniedBeta = await getSecret!.handler({ name: 'beta' }) as { content: Array<{ text: string }> };
    const deniedBetaPayload = JSON.parse(deniedBeta.content[0].text) as { reqId?: string };
    expect(deniedBetaPayload.reqId).toBe('req-b');

    const claimA = await getToken!.handler({ reqId: 'req-a' }) as { content: Array<{ text: string }> };
    const claimAPayload = JSON.parse(claimA.content[0].text) as { claimStatus?: string; retryReady?: boolean };
    expect(claimAPayload.claimStatus).toBe('approved');
    expect(claimAPayload.retryReady).toBe(true);

    const unclaimedRetry = await getSecret!.handler({ name: 'beta', reqId: 'req-b' }) as { content: Array<{ text: string }> };
    const unclaimedPayload = JSON.parse(unclaimedRetry.content[0].text) as { errorCode?: string; reqId?: string; approvalScope?: string };
    expect(unclaimedPayload.errorCode).toBe('missing_or_expired_claim');
    expect(unclaimedPayload.reqId).toBe('req-b');
    expect(unclaimedPayload.approvalScope).toBe('one_shot_read');

    const alphaRetry = await getSecret!.handler({ name: 'alpha', reqId: 'req-a' }) as { content: Array<{ text: string }> };
    const alphaRetryPayload = JSON.parse(alphaRetry.content[0].text) as { success?: boolean; credentialId?: string };
    expect(alphaRetryPayload.success).toBe(true);
    expect(alphaRetryPayload.credentialId).toBe('cred-a');

    const claimB = await getToken!.handler({ reqId: 'req-b' }) as { content: Array<{ text: string }> };
    const claimBPayload = JSON.parse(claimB.content[0].text) as { claimStatus?: string; retryReady?: boolean };
    expect(claimBPayload.claimStatus).toBe('approved');
    expect(claimBPayload.retryReady).toBe(true);

    const betaRetry = await getSecret!.handler({ name: 'beta', reqId: 'req-b' }) as { content: Array<{ text: string }> };
    const betaRetryPayload = JSON.parse(betaRetry.content[0].text) as { success?: boolean; credentialId?: string };
    expect(betaRetryPayload.success).toBe(true);
    expect(betaRetryPayload.credentialId).toBe('cred-b');

    expect(readWithOneShotA).toBe(1);
    expect(readWithOneShotB).toBe(1);

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('crypto');
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('session flow should claim by reqId, then allow retry with and without reqId', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        privateDecrypt: vi.fn((_opts: unknown, ciphertext: Buffer) => {
          const marker = ciphertext.toString('utf8');
          if (marker === 'session-cipher') return Buffer.from('session-bearer', 'utf8');
          if (marker === 'cred-session-cipher') {
            return Buffer.from(JSON.stringify({
              id: 'cred-1',
              agentId: 'primary',
              type: 'note',
              fields: [{ key: 'value', value: 'session-secret', sensitive: true }],
            }), 'utf8');
          }
          throw new Error(`Unexpected privateDecrypt input: ${marker}`);
        }),
      };
    });

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    delete process.env.AURA_TOKEN;

    const sessionCipher = Buffer.from('session-cipher', 'utf8').toString('base64');
    const credentialCipher = Buffer.from('cred-session-cipher', 'utf8').toString('base64');
    let readWithSessionBearer = 0;
    let requestedProfile: string | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/auth') && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as { profile?: string };
        requestedProfile = body.profile;
        return new Response(JSON.stringify({
          requestId: 'req-session',
          secret: 'sec-session',
          approveUrl: 'http://localhost:4747/approve/req-session',
        }), { status: 200 });
      }

      if (url.endsWith('/auth/req-session') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: sessionCipher,
          ttl: 60,
        }), { status: 200 });
      }

      if (url.endsWith('/setup') && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), { status: 200 });
      }

      if (url.endsWith('/setup/agents') && method === 'GET') {
        return new Response(JSON.stringify({ agents: [{ id: 'primary', name: 'primary' }] }), { status: 200 });
      }

      if (url.includes('/credentials?q=github') && method === 'GET') {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer session-bearer');
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-1', name: 'github', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-1/read') && method === 'POST') {
        const headers = init?.headers as Record<string, string>;
        if (headers.Authorization === 'Bearer session-bearer') {
          readWithSessionBearer += 1;
          return new Response(JSON.stringify({ encrypted: credentialCipher }), { status: 200 });
        }
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const authTool = capturedHandlers.find((tool) => tool.name === 'auth');
    const getTokenTool = capturedHandlers.find((tool) => tool.name === 'get_token');
    const getSecret = capturedHandlers.find((tool) => tool.name === 'get_secret');
    expect(authTool).toBeDefined();
    expect(getTokenTool).toBeDefined();
    expect(getSecret).toBeDefined();

    const authResult = await authTool!.handler({ agentId: 'codex-test', profile: 'admin' }) as { content: Array<{ text: string }> };
    const authPayload = JSON.parse(authResult.content[0].text) as {
      reqId?: string;
      claimAction?: { args?: { reqId?: string } };
      retryAction?: { args?: { reqId?: string } };
    };
    expect(authPayload.reqId).toBe('req-session');
    expect(requestedProfile).toBe('admin');
    expect(authPayload.claimAction?.args?.reqId).toBe('req-session');
    expect(authPayload.retryAction?.args?.reqId).toBe('req-session');

    const claimed = await getTokenTool!.handler({ reqId: 'req-session' }) as { content: Array<{ text: string }> };
    const claimPayload = JSON.parse(claimed.content[0].text) as {
      claimStatus?: string;
      retryReady?: boolean;
      requiresHumanApproval?: boolean;
    };
    expect(claimPayload.claimStatus).toBe('approved');
    expect(claimPayload.retryReady).toBe(true);
    expect(claimPayload.requiresHumanApproval).toBe(false);

    const firstRetry = await getSecret!.handler({ name: 'github', reqId: 'req-session' }) as { content: Array<{ text: string }> };
    const firstRetryPayload = JSON.parse(firstRetry.content[0].text) as { success?: boolean };
    expect(firstRetryPayload.success).toBe(true);

    const secondRetry = await getSecret!.handler({ name: 'github' }) as { content: Array<{ text: string }> };
    const secondRetryPayload = JSON.parse(secondRetry.content[0].text) as { success?: boolean };
    expect(secondRetryPayload.success).toBe(true);
    expect(readWithSessionBearer).toBe(2);

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('crypto');
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('one-shot retry should fail deterministically when operation binding does not match', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        privateDecrypt: vi.fn((_opts: unknown, ciphertext: Buffer) => {
          const marker = ciphertext.toString('utf8');
          if (marker === 'claim-cipher-binding') return Buffer.from('one-shot-bearer-binding', 'utf8');
          if (marker === 'cred-cipher-binding') {
            return Buffer.from(JSON.stringify({
              id: 'cred-1',
              agentId: 'primary',
              type: 'note',
              fields: [{ key: 'value', value: 'binding-secret', sensitive: true }],
            }), 'utf8');
          }
          throw new Error(`Unexpected privateDecrypt input: ${marker}`);
        }),
      };
    });

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'base-token';

    const claimCipher = Buffer.from('claim-cipher-binding', 'utf8').toString('base64');
    let readCallCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/setup') && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), { status: 200 });
      }

      if (url.endsWith('/setup/agents') && method === 'GET') {
        return new Response(JSON.stringify({ agents: [{ id: 'primary', name: 'primary' }] }), { status: 200 });
      }

      if (url.includes('/credentials?q=github') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-1', name: 'github', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-1/read') && method === 'POST') {
        readCallCount += 1;
        const headers = init?.headers as Record<string, string>;
        if (headers.Authorization === 'Bearer base-token') {
          return new Response(JSON.stringify({
            contractVersion: 'v1',
            success: false,
            requiresHumanApproval: true,
            reqId: 'req-bind',
            secret: 'sec-bind',
            approveUrl: 'http://localhost:4747/approve/req-bind',
            reasonCode: 'DENY_EXCLUDED_FIELD',
            credential: { id: 'cred-1', name: 'github' },
            policyHash: 'pol-bind',
            compilerVersion: 'v1',
            binding: {
              actorId: 'mcp-stdio',
              method: 'POST',
              routeId: 'wallet.send',
              resourceHash: 'x',
              bodyHash: 'y',
              bindingHash: 'z',
            },
          }), { status: 403 });
        }
      }

      if (url.endsWith('/auth/req-bind') && method === 'GET') {
        return new Response(JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: claimCipher,
          ttl: 60,
        }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const getSecret = capturedHandlers.find((tool) => tool.name === 'get_secret');
    const getToken = capturedHandlers.find((tool) => tool.name === 'get_token');
    expect(getSecret).toBeDefined();
    expect(getToken).toBeDefined();

    const denied = await getSecret!.handler({ name: 'github' }) as { content: Array<{ text: string }> };
    const deniedPayload = JSON.parse(denied.content[0].text) as { reqId?: string };
    expect(deniedPayload.reqId).toBe('req-bind');

    const claimed = await getToken!.handler({ reqId: 'req-bind' }) as { content: Array<{ text: string }> };
    const claimedPayload = JSON.parse(claimed.content[0].text) as { claimStatus?: string; retryReady?: boolean };
    expect(claimedPayload.claimStatus).toBe('approved');
    expect(claimedPayload.retryReady).toBe(true);

    const retried = await getSecret!.handler({ name: 'github', reqId: 'req-bind' }) as { content: Array<{ text: string }> };
    const retriedPayload = JSON.parse(retried.content[0].text) as {
      errorCode?: string;
      policyHash?: string;
      compilerVersion?: string;
    };
    expect(retriedPayload.errorCode).toBe('operation_binding_mismatch');
    expect(retriedPayload.policyHash).toBe('pol-bind');
    expect(retriedPayload.compilerVersion).toBe('v1');
    expect(readCallCount).toBe(1);

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('crypto');
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_secret should auto-inject default env var and return redacted WHATDO metadata', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        privateDecrypt: vi.fn((_opts: unknown, ciphertext: Buffer) => {
          const marker = ciphertext.toString('utf8');
          if (marker === 'cred-cipher') {
            return Buffer.from(JSON.stringify({
              id: 'cred-1',
              agentId: 'primary',
              type: 'note',
              fields: [{ key: 'value', value: 'super-secret', sensitive: true }],
            }), 'utf8');
          }
          throw new Error(`Unexpected privateDecrypt input: ${marker}`);
        }),
      };
    });

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    const originalEnvSecret = process.env.AURA_GITHUB;
    process.env.AURA_TOKEN = 'base-token';

    const credentialCipher = Buffer.from('cred-cipher', 'utf8').toString('base64');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/setup') && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), { status: 200 });
      }

      if (url.endsWith('/setup/agents') && method === 'GET') {
        return new Response(JSON.stringify({ agents: [{ id: 'primary', name: 'primary' }] }), { status: 200 });
      }

      if (url.includes('/credentials?q=github') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-1', name: 'github', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-1/read') && method === 'POST') {
        return new Response(JSON.stringify({ encrypted: credentialCipher }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const getSecret = capturedHandlers.find((tool) => tool.name === 'get_secret');
    expect(getSecret).toBeDefined();

    const result = await getSecret!.handler({ name: 'github' }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text) as {
      success?: boolean;
      envVar?: string;
      secret?: string;
      scope?: string;
      whatDo?: string[];
    };

    expect(payload.success).toBe(true);
    expect(payload.envVar).toBe('AURA_GITHUB');
    expect(payload.secret).toBe('*******');
    expect(payload.scope).toBe('mcp-server-process');
    expect(payload.whatDo).toContain('Saved to env variable AURA_GITHUB.');
    expect(payload.whatDo).toContain("Scope: current MCP server process only. Use '-- <command>' to inject into a child command.");
    expect(process.env.AURA_GITHUB).toBe('super-secret');

    if (originalEnvSecret === undefined) delete process.env.AURA_GITHUB;
    else process.env.AURA_GITHUB = originalEnvSecret;
    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('crypto');
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_secret should run command with default env var injection', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        privateDecrypt: vi.fn((_opts: unknown, ciphertext: Buffer) => {
          const marker = ciphertext.toString('utf8');
          if (marker === 'cred-cipher') {
            return Buffer.from(JSON.stringify({
              id: 'cred-1',
              agentId: 'primary',
              type: 'note',
              fields: [{ key: 'value', value: 'command-secret', sensitive: true }],
            }), 'utf8');
          }
          throw new Error(`Unexpected privateDecrypt input: ${marker}`);
        }),
      };
    });

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    const originalEnvSecret = process.env.AURA_GITHUB;
    process.env.AURA_TOKEN = 'base-token';

    const credentialCipher = Buffer.from('cred-cipher', 'utf8').toString('base64');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/setup') && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), { status: 200 });
      }

      if (url.endsWith('/setup/agents') && method === 'GET') {
        return new Response(JSON.stringify({ agents: [{ id: 'primary', name: 'primary' }] }), { status: 200 });
      }

      if (url.includes('/credentials?q=github') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-1', name: 'github', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-1/read') && method === 'POST') {
        return new Response(JSON.stringify({ encrypted: credentialCipher }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const getSecret = capturedHandlers.find((tool) => tool.name === 'get_secret');
    expect(getSecret).toBeDefined();

    const result = await getSecret!.handler({
      name: 'github',
      command: ['node', '-e', 'process.exit(process.env.AURA_GITHUB ? 0 : 7)'],
    }) as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0].text) as {
      success?: boolean;
      exitCode?: number;
      envVar?: string;
      secret?: string;
    };

    expect(payload.success).toBe(true);
    expect(payload.exitCode).toBe(0);
    expect(payload.envVar).toBe('AURA_GITHUB');
    expect(payload.secret).toBe('*******');
    expect(process.env.AURA_GITHUB).toBe('command-secret');

    if (originalEnvSecret === undefined) delete process.env.AURA_GITHUB;
    else process.env.AURA_GITHUB = originalEnvSecret;
    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('crypto');
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('inject_secret should redact by default and reveal plaintext when dangerPlaintext=true', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        privateDecrypt: vi.fn((_opts: unknown, ciphertext: Buffer) => {
          const marker = ciphertext.toString('utf8');
          if (marker === 'cred-cipher') {
            return Buffer.from(JSON.stringify({
              id: 'cred-1',
              agentId: 'primary',
              type: 'note',
              fields: [{ key: 'value', value: 'inject-secret', sensitive: true }],
            }), 'utf8');
          }
          throw new Error(`Unexpected privateDecrypt input: ${marker}`);
        }),
      };
    });

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    const originalEnvSecret = process.env.MY_SECRET;
    process.env.AURA_TOKEN = 'base-token';

    const credentialCipher = Buffer.from('cred-cipher', 'utf8').toString('base64');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/setup') && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), { status: 200 });
      }

      if (url.endsWith('/setup/agents') && method === 'GET') {
        return new Response(JSON.stringify({ agents: [{ id: 'primary', name: 'primary' }] }), { status: 200 });
      }

      if (url.includes('/credentials?q=github') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-1', name: 'github', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-1/read') && method === 'POST') {
        return new Response(JSON.stringify({ encrypted: credentialCipher }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const injectSecret = capturedHandlers.find((tool) => tool.name === 'inject_secret');
    expect(injectSecret).toBeDefined();

    const redacted = await injectSecret!.handler({ name: 'github', envVar: 'MY_SECRET' }) as { content: Array<{ text: string }> };
    const redactedPayload = JSON.parse(redacted.content[0].text) as { secret?: string; envVar?: string };
    expect(redactedPayload.envVar).toBe('MY_SECRET');
    expect(redactedPayload.secret).toBe('*******');
    expect(process.env.MY_SECRET).toBe('inject-secret');

    const revealed = await injectSecret!.handler({
      name: 'github',
      envVar: 'MY_SECRET',
      dangerPlaintext: true,
    }) as { content: Array<{ text: string }> };
    const revealPayload = JSON.parse(revealed.content[0].text) as { secret?: string };
    expect(revealPayload.secret).toBe('inject-secret');

    if (originalEnvSecret === undefined) delete process.env.MY_SECRET;
    else process.env.MY_SECRET = originalEnvSecret;
    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('crypto');
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('get_secret and inject_secret should enforce explicit field reads without primary fallback', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual<typeof import('crypto')>('crypto');
      return {
        ...actual,
        privateDecrypt: vi.fn((_opts: unknown, ciphertext: Buffer) => {
          const marker = ciphertext.toString('utf8');
          if (marker === 'cred-cipher') {
            return Buffer.from(JSON.stringify({
              id: 'cred-1',
              agentId: 'primary',
              type: 'card',
              fields: [
                { key: 'number', value: '1234567890', sensitive: true },
                { key: 'cvv', value: '321', sensitive: true },
              ],
            }), 'utf8');
          }
          throw new Error(`Unexpected privateDecrypt input: ${marker}`);
        }),
      };
    });

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    const originalGetEnv = process.env.AURA_VISA_7890;
    const originalInjectEnv = process.env.MY_SECRET;
    process.env.AURA_TOKEN = 'base-token';

    const readRequestBodies: Array<{ requestedFields?: string[] }> = [];
    const credentialCipher = Buffer.from('cred-cipher', 'utf8').toString('base64');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/setup') && method === 'GET') {
        return new Response(JSON.stringify({ projectScopeMode: 'auto' }), { status: 200 });
      }

      if (url.endsWith('/setup/agents') && method === 'GET') {
        return new Response(JSON.stringify({ agents: [{ id: 'primary', name: 'primary' }] }), { status: 200 });
      }

      if (url.includes('/credentials?q=visa_7890') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{ id: 'cred-1', name: 'visa_7890', type: 'card', agentId: 'primary' }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-1/read') && method === 'POST') {
        if (init?.body) {
          readRequestBodies.push(JSON.parse(String(init.body)) as { requestedFields?: string[] });
        } else {
          readRequestBodies.push({});
        }
        return new Response(JSON.stringify({ encrypted: credentialCipher }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const getSecret = capturedHandlers.find((tool) => tool.name === 'get_secret');
    const injectSecret = capturedHandlers.find((tool) => tool.name === 'inject_secret');
    expect(getSecret).toBeDefined();
    expect(injectSecret).toBeDefined();

    const getCvv = await getSecret!.handler({
      name: 'visa_7890',
      field: 'cvv',
      dangerPlaintext: true,
    }) as { content: Array<{ text: string }> };
    const getCvvPayload = JSON.parse(getCvv.content[0].text) as { secret?: string };
    expect(getCvvPayload.secret).toBe('321');
    expect(process.env.AURA_VISA_7890).toBe('321');

    const getMissing = await getSecret!.handler({
      name: 'visa_7890',
      field: 'security_code',
    }) as { content: Array<{ text: string }> };
    const getMissingPayload = JSON.parse(getMissing.content[0].text) as { error?: string; availableFields?: string };
    expect(getMissingPayload.error).toContain('Field "security_code" not found on credential "visa_7890"');
    expect(getMissingPayload.availableFields).toContain('number');
    expect(getMissingPayload.availableFields).toContain('cvv');

    const injectCvv = await injectSecret!.handler({
      name: 'visa_7890',
      field: 'cvv',
      envVar: 'MY_SECRET',
      dangerPlaintext: true,
    }) as { content: Array<{ text: string }> };
    const injectCvvPayload = JSON.parse(injectCvv.content[0].text) as { secret?: string };
    expect(injectCvvPayload.secret).toBe('321');
    expect(process.env.MY_SECRET).toBe('321');

    const injectMissing = await injectSecret!.handler({
      name: 'visa_7890',
      field: 'security_code',
      envVar: 'MY_SECRET',
    }) as { content: Array<{ text: string }> };
    const injectMissingPayload = JSON.parse(injectMissing.content[0].text) as { error?: string; availableFields?: string };
    expect(injectMissingPayload.error).toContain('Field "security_code" not found on credential "visa_7890"');
    expect(injectMissingPayload.availableFields).toContain('number');
    expect(injectMissingPayload.availableFields).toContain('cvv');

    expect(readRequestBodies).toEqual([
      { requestedFields: ['cvv'] },
      { requestedFields: ['security_code'] },
      { requestedFields: ['cvv'] },
      { requestedFields: ['security_code'] },
    ]);

    if (originalGetEnv === undefined) delete process.env.AURA_VISA_7890;
    else process.env.AURA_VISA_7890 = originalGetEnv;
    if (originalInjectEnv === undefined) delete process.env.MY_SECRET;
    else process.env.MY_SECRET = originalInjectEnv;
    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('crypto');
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('write_diary should create a new diary note using primary agent', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock('../../lib/cold', () => ({
      listAgents: () => [{ id: 'primary', name: 'primary', isPrimary: true }, { id: 'agent-agent', name: 'agent' }],
      AGENT_AGENT_NAME: 'agent',
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'test-env-token';

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.includes('/credentials?agent=primary') && method === 'GET') {
        return new Response(JSON.stringify({ credentials: [] }), { status: 200 });
      }

      if (url.endsWith('/credentials') && method === 'POST') {
        return new Response(JSON.stringify({ credential: { id: 'cred-new' } }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const writeDiary = capturedHandlers.find((tool) => tool.name === 'write_diary');
    expect(writeDiary).toBeDefined();

    const result = await writeDiary!.handler({
      date: '2026-02-18',
      entry: 'Checked in, all good.',
    }) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.date).toBe('2026-02-18');
    expect(payload.entryCount).toBe(1);
    expect(payload.agentId).toBe('primary');

    const createCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith('/credentials') && (init?.method || 'GET') === 'POST',
    );
    expect(createCall).toBeDefined();
    const createBody = JSON.parse(String(createCall![1]?.body));
    expect(createBody).toEqual(expect.objectContaining({
      agentId: 'primary',
      name: '2026-02-18_LOGS',
    }));
    expect(createBody.fields[0].key).toBe('content');
    expect(createBody.fields[0].sensitive).toBe(false);
    expect(createBody.fields[0].type).toBe('text');
    expect(createBody.meta.tags).toEqual(['diary', 'heartbeat']);

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('../../lib/cold');
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('write_diary should append to an existing diary note', async () => {
    const capturedHandlers: Array<{
      name: string;
      handler: (input: unknown) => Promise<unknown>;
    }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, handler: (input: unknown) => Promise<unknown>) {
          capturedHandlers.push({ name, handler });
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock('../../lib/cold', () => ({
      listAgents: () => [{ id: 'primary', name: 'primary', isPrimary: true }],
      AGENT_AGENT_NAME: 'agent',
    }));

    vi.resetModules();
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.AURA_TOKEN;
    process.env.AURA_TOKEN = 'test-env-token';

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.includes('/credentials?agent=primary') && method === 'GET') {
        return new Response(JSON.stringify({
          credentials: [{
            id: 'cred-existing',
            name: 'diary-2026-02-18',
            agentId: 'primary',
            meta: { tags: ['diary'] },
          }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-existing/read') && method === 'POST') {
        return new Response(JSON.stringify({
          fields: [{ key: 'value', value: '--- 09:00 UTC ---\nprior note', sensitive: true }],
        }), { status: 200 });
      }

      if (url.endsWith('/credentials/cred-existing') && method === 'PUT') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }

      return new Response('not mocked', { status: 500 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await import('../../mcp/server.js');
    const writeDiary = capturedHandlers.find((tool) => tool.name === 'write_diary');
    expect(writeDiary).toBeDefined();

    const result = await writeDiary!.handler({
      date: '2026-02-18',
      entry: 'second note',
    }) as { content: Array<{ text: string }> };

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.entryCount).toBe(2);
    expect(payload.credentialId).toBe('cred-existing');
    expect(payload.agentId).toBe('primary');

    const updateCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith('/credentials/cred-existing') && (init?.method || 'GET') === 'PUT',
    );
    expect(updateCall).toBeDefined();
    const updateBody = JSON.parse(String(updateCall![1]?.body));
    expect(updateBody.name).toBe('2026-02-18_LOGS');
    expect(updateBody.sensitiveFields).toEqual([]);
    expect(updateBody.meta.tags).toEqual(['diary', 'heartbeat']);
    const updatedValue = updateBody.meta.content as string;
    expect(updatedValue).toContain('prior note');
    expect(updatedValue).toContain('\n\nsecond note');

    globalThis.fetch = originalFetch;
    process.env.AURA_TOKEN = originalToken;
    vi.doUnmock('../../lib/cold');
    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });
});
