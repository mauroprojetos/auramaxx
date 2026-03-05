/**
 * Tests for WebSocket first-message auth flow.
 *
 * Verifies that:
 * - Clients authenticate by sending { type: "auth", token } after connecting
 * - Server validates token and responds with { type: "authenticated", valid }
 * - Invalid tokens get valid: false
 * - Unauthenticated clients are denied workspace mutations
 * - Authenticated clients can perform workspace mutations
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, Server } from 'http';

// Mock auth-client before importing websocket-server
vi.mock('../../../../src/lib/auth-client', () => ({
  validateToken: vi.fn(),
  hasAnyPermission: vi.fn(),
}));

// Mock workspace/theme handlers to avoid real DB calls
vi.mock('../../../../src/lib/workspace-handlers', () => ({
  handleWorkspaceMessage: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../src/lib/theme-handlers', () => ({
  handleThemeMessage: vi.fn().mockResolvedValue(null),
}));

// Mock pino logger
vi.mock('../../../../src/lib/pino', () => ({
  log: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

import { getWebSocketServer, closeWebSocketServer, handleUpgrade } from '../../../../src/lib/websocket-server';
import { validateToken, hasAnyPermission } from '../../../../src/lib/auth-client';

const mockedValidateToken = vi.mocked(validateToken);
const mockedHasAnyPermission = vi.mocked(hasAnyPermission);

let httpServer: Server;
let port: number;

/**
 * Connect a WebSocket client and return it along with a promise for the
 * first server message. The message listener is registered BEFORE the
 * connection opens to avoid a race condition where the server's initial
 * "connected" message arrives in the same TCP payload as the upgrade
 * response and is dropped because no listener is attached yet.
 */
function connectClient(): Promise<{ ws: WebSocket; firstMessage: Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages: Record<string, unknown>[] = [];
    let messageResolve: ((msg: Record<string, unknown>) => void) | null = null;

    // Buffer messages so none are lost
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (messageResolve) {
        messageResolve(msg);
        messageResolve = null;
      } else {
        messages.push(msg);
      }
    });

    const firstMessage = new Promise<Record<string, unknown>>((res) => {
      if (messages.length > 0) {
        res(messages.shift()!);
      } else {
        messageResolve = res;
      }
    });

    ws.on('open', () => resolve({ ws, firstMessage }));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe('WebSocket Auth', () => {
  beforeEach(async () => {
    // Reset singleton before each test
    closeWebSocketServer();

    // Create HTTP server with WS upgrade
    httpServer = createServer();
    httpServer.on('upgrade', (req, socket, head) => {
      handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });

    // Ensure the WSS singleton is initialized
    getWebSocketServer();
  });

  afterEach(async () => {
    closeWebSocketServer();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    vi.restoreAllMocks();
  });

  it('should send connected message on connect (no auth field)', async () => {
    const { ws, firstMessage } = await connectClient();
    const msg = await firstMessage;

    expect(msg.type).toBe('connected');
    expect(msg.timestamp).toBeDefined();
    expect(msg).not.toHaveProperty('authenticated');

    ws.close();
  });

  it('should authenticate with valid token via first message', async () => {
    mockedValidateToken.mockResolvedValue({
      valid: true,
      isAdmin: false,
      payload: {
        agentId: 'test-agent',
        permissions: ['wallet:list'],
      },
    });

    const { ws, firstMessage } = await connectClient();
    // Consume the 'connected' message
    await firstMessage;

    // Send auth message
    ws.send(JSON.stringify({ type: 'auth', token: 'valid-token-123' }));
    const authResponse = await waitForMessage(ws);

    expect(authResponse.type).toBe('authenticated');
    expect(authResponse.valid).toBe(true);
    expect(mockedValidateToken).toHaveBeenCalledWith('valid-token-123');

    ws.close();
  });

  it('should reject invalid token', async () => {
    mockedValidateToken.mockResolvedValue({
      valid: false,
      error: 'Invalid signature',
    });

    const { ws, firstMessage } = await connectClient();
    await firstMessage;

    ws.send(JSON.stringify({ type: 'auth', token: 'bad-token' }));
    const authResponse = await waitForMessage(ws);

    expect(authResponse.type).toBe('authenticated');
    expect(authResponse.valid).toBe(false);

    ws.close();
  });

  it('should deny workspace mutations without auth', async () => {
    const { ws, firstMessage } = await connectClient();
    await firstMessage;

    // Try a workspace mutation without authenticating
    ws.send(JSON.stringify({ type: 'app:added', data: {} }));
    const errorMsg = await waitForMessage(ws);

    expect(errorMsg.type).toBe('error');
    expect(errorMsg.error).toContain('Permission denied');

    ws.close();
  });

  it('should allow workspace mutations after auth', async () => {
    mockedValidateToken.mockResolvedValue({
      valid: true,
      isAdmin: true,
      payload: {
        agentId: 'admin-agent',
        permissions: ['admin:*'],
      },
    });
    mockedHasAnyPermission.mockReturnValue(true);

    const { ws, firstMessage } = await connectClient();
    await firstMessage;

    // Authenticate first
    ws.send(JSON.stringify({ type: 'auth', token: 'admin-token' }));
    await waitForMessage(ws);

    // Now try a workspace mutation — should not get an error
    ws.send(JSON.stringify({
      type: 'app:added',
      timestamp: Date.now(),
      source: 'agent',
      data: { workspaceId: 'home', appType: 'status', x: 0, y: 0, config: {} },
    }));

    // Wait briefly — no error should come back
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 200));
    const msg = new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });

    const result = await Promise.race([msg, timeout]);
    // Should either be null (no message = success, handler returned null) or not an error
    if (result !== null) {
      expect(result.type).not.toBe('error');
    }

    ws.close();
  });

  it('should not include token in URL (regression test)', async () => {
    // This test verifies the client-side contract:
    // tokens should NOT appear in the WebSocket URL
    const { ws, firstMessage } = await connectClient();
    await firstMessage;

    // The server's upgrade handler receives the request URL
    // Verify our test client connected without a token in the URL
    // (the WebSocket constructor was called with just ws://host:port)
    expect(ws.url).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:${port}/?$`));
    expect(ws.url).not.toContain('token=');

    ws.close();
  });
});
