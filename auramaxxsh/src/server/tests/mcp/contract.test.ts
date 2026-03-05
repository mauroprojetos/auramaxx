/**
 * MCP Contract Tests — V1 Launch Surface Freeze
 * ===============================================
 * These tests lock the public MCP tool surface so that v1 clients
 * (Codex, Claude Desktop, OpenClaw, generic MCP) don't break on upgrade.
 *
 * If a test fails, it means the MCP contract changed — update the test
 * only after confirming the change is intentional and backward-compatible.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { TOOLS, toAnthropicTools, toOpenAITools, executeTool } from '../../mcp/tools';

// ── Shared tool contract (TOOLS array) ─────────────────────────────────

describe('MCP Contract — Shared TOOLS surface', () => {
  it('should expose exactly 3 shared tools in order', () => {
    expect(TOOLS.map(t => t.name)).toEqual(['api', 'status', 'list_secrets']);
  });

  describe('api tool contract', () => {
    const api = TOOLS.find(t => t.name === 'api')!;

    it('requires method and endpoint', () => {
      expect(api.parameters.required).toEqual(['method', 'endpoint']);
    });

    it('method is a string enum with exactly GET/POST/PUT/PATCH/DELETE', () => {
      const method = api.parameters.properties.method as Record<string, unknown>;
      expect(method.type).toBe('string');
      expect(method.enum).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    });

    it('endpoint is a plain string', () => {
      const endpoint = api.parameters.properties.endpoint as Record<string, unknown>;
      expect(endpoint.type).toBe('string');
      expect(endpoint.enum).toBeUndefined();
    });

    it('body is an optional object', () => {
      const body = api.parameters.properties.body as Record<string, unknown>;
      expect(body.type).toBe('object');
      expect(api.parameters.required).not.toContain('body');
    });

    it('has exactly 3 properties', () => {
      expect(Object.keys(api.parameters.properties)).toEqual(['method', 'endpoint', 'body']);
    });
  });

  describe('status tool contract', () => {
    const status = TOOLS.find(t => t.name === 'status')!;

    it('has no required params', () => {
      expect(status.parameters.required).toBeUndefined();
    });

    it('has no properties', () => {
      expect(Object.keys(status.parameters.properties)).toEqual([]);
    });
  });

  describe('list_secrets tool contract', () => {
    const ls = TOOLS.find(t => t.name === 'list_secrets')!;

    it('has no required params', () => {
      expect(ls.parameters.required).toBeUndefined();
    });

    it('has q, tag, agent, lifecycle as optional string params', () => {
      const keys = Object.keys(ls.parameters.properties).sort();
      expect(keys).toEqual(['agent', 'lifecycle', 'q', 'tag']);
      for (const key of keys) {
        const prop = ls.parameters.properties[key] as Record<string, unknown>;
        expect(prop.type).toBe('string');
      }
    });

    it('lifecycle has enum constraint', () => {
      const lifecycle = ls.parameters.properties.lifecycle as Record<string, unknown>;
      expect(lifecycle.enum).toEqual(['active', 'archive', 'recently_deleted']);
    });
  });
});

// ── Inline tool registration contract (server.ts) ──────────────────────

describe('MCP Contract — Full tool registration (15 tools)', () => {
  it('should register exactly 15 tools in canonical order', async () => {
    const registeredTools: string[] = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string, _desc: string, _shape: unknown, _handler?: unknown) {
          registeredTools.push(name);
        }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    await import('../../mcp/server.js');

    expect(registeredTools).toEqual([
      'get_secret',
      'put_secret',
      'write_diary',
      'del_secret',
      'inject_secret',
      'share_secret',
      'auth',
      'get_token',
      'approve',
      'start',
      'unlock',
      'doctor',
      // shared TOOLS
      'api',
      'status',
      'list_secrets',
    ]);

    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('should register exactly 3 resources with stable URIs', async () => {
    const resources: Array<{ name: string; uri: string }> = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool() {}
        resource(name: string, uri: string, _metaOrCb: unknown, _cb?: unknown) {
          resources.push({ name, uri });
        }
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    await import('../../mcp/server.js');

    expect(resources).toEqual([
      { name: 'api-reference', uri: 'docs://api' },
      { name: 'auth-reference', uri: 'docs://auth' },
      { name: 'agent-guide', uri: 'docs://guide' },
    ]);

    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });
});

// ── Removed tools must stay removed ────────────────────────────────────

describe('MCP Contract — Removed tools must not reappear', () => {
  const REMOVED = [
    'create_agent',
    'request_human_action',
    'wallet_api',
    'aura_list_wallets',
    'aura_list_agents',
    'aura_list_credentials',
  ];

  it('shared TOOLS must not contain removed names', () => {
    const names = TOOLS.map(t => t.name);
    for (const removed of REMOVED) {
      expect(names).not.toContain(removed);
    }
  });

  it('full registration must not contain removed names', async () => {
    const registeredTools: string[] = [];

    vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: class {
        tool(name: string) { registeredTools.push(name); }
        resource() {}
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class {},
    }));

    vi.resetModules();
    await import('../../mcp/server.js');

    for (const removed of REMOVED) {
      expect(registeredTools).not.toContain(removed);
    }

    vi.doUnmock('@modelcontextprotocol/sdk/server/mcp.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
  });
});

// ── SDK format stability ───────────────────────────────────────────────

describe('MCP Contract — Anthropic/OpenAI format stability', () => {
  it('toAnthropicTools returns input_schema with type=object for every tool', () => {
    const tools = toAnthropicTools();
    expect(tools).toHaveLength(3);
    for (const tool of tools) {
      expect(tool.input_schema.type).toBe('object');
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('toOpenAITools returns type=function wrapper for every tool', () => {
    const tools = toOpenAITools();
    expect(tools).toHaveLength(3);
    for (const tool of tools) {
      expect(tool.type).toBe('function');
      expect(tool.function.parameters.type).toBe('object');
      expect(typeof tool.function.description).toBe('string');
    }
  });
});

// ── executeTool contract ───────────────────────────────────────────────

describe('MCP Contract — executeTool response shapes', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('unknown tool returns {error} shape', async () => {
    const result = JSON.parse(await executeTool('nonexistent', {}));
    expect(result).toEqual({ error: 'Unknown tool: nonexistent' });
  });

  it('api with bad endpoint returns {error} shape', async () => {
    const result = JSON.parse(await executeTool('api', { method: 'GET', endpoint: 'no-slash' }));
    expect(result).toEqual({ error: 'endpoint must start with /' });
  });

  it('api with bad method returns {error} shape', async () => {
    const result = JSON.parse(await executeTool('api', { method: 'OPTIONS', endpoint: '/x' }));
    expect(result).toEqual({ error: 'method must be GET, POST, PUT, PATCH, or DELETE' });
  });

  it('status returns {success, tool, data} shape on 200', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ unlocked: true }), { status: 200 }),
    );
    const result = JSON.parse(await executeTool('status', {}, 'tok'));
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('tool', 'status');
    expect(result).toHaveProperty('data');
  });

  it('list_secrets returns {success, tool, data} shape on 200', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ credentials: [] }), { status: 200 }),
    );
    const result = JSON.parse(await executeTool('list_secrets', {}, 'tok'));
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('tool', 'list_secrets');
    expect(result).toHaveProperty('data');
  });

  it('status returns {success:false, tool, error} shape on error response', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'locked' }), { status: 200 }),
    );
    const result = JSON.parse(await executeTool('status', {}, 'tok'));
    expect(result).toHaveProperty('success', false);
    expect(result).toHaveProperty('tool', 'status');
    expect(result).toHaveProperty('error');
  });


  it('api preserves canonical wallet hard-deny envelope shape', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({
        contractVersion: 'v1',
        requiresHumanApproval: false,
        errorCode: 'route_not_allowlisted',
        error: 'Wallet access escalation denied',
        routeId: 'wallet.access',
        required: ['wallet:access'],
      }), { status: 403 }),
    );
    const result = JSON.parse(await executeTool('api', { method: 'GET', endpoint: '/wallet/0xabc' }, 'tok'));
    expect(result.contractVersion).toBe('v1');
    expect(result.requiresHumanApproval).toBe(false);
    expect(result.errorCode).toBe('route_not_allowlisted');
    expect(result.routeId).toBe('wallet.access');
  });

  it('api blocked endpoints return MCP-inaccessible error', async () => {
    for (const blocked of ['/auth/internal', '/apps/internal/foo', '/strategies/internal']) {
      const result = JSON.parse(await executeTool('api', { method: 'GET', endpoint: blocked }));
      expect(result.error).toContain('not accessible via MCP');
    }
  });

  it('api connection failure returns structured error', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('fetch failed'));
    const result = JSON.parse(await executeTool('api', { method: 'GET', endpoint: '/wallets' }));
    expect(result.error).toContain('not reachable');
  });
});
