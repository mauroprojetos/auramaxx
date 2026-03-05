import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'net';
import { SocketServer } from '../../cli/socket';
import { generateEphemeralKeypair } from '../../lib/credential-transport';
import * as cold from '../../lib/cold';
import * as auth from '../../lib/auth';
import * as transport from '../../lib/credential-transport';
import * as defaults from '../../lib/defaults';

describe('SocketServer auth polling', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    if (fetchSpy) {
      fetchSpy.mockRestore();
    }
    vi.useRealTimers();
  });

  it('forwards auth_approved only with encryptedToken when available', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          status: 'approved',
          encryptedToken: 'encrypted-token',
          token: 'plaintext-token',
          agentId: 'agent-id',
          limit: 0.1,
          profile: { id: 'strict', version: 'v1' },
          effectivePolicyHash: 'a'.repeat(64),
          overrideDelta: ['ttlSeconds'],
        }),
        { status: 200 },
      ),
    );

    const socket = { write: vi.fn() } as unknown as Socket;
    const keypair = generateEphemeralKeypair();
    const server = new SocketServer({
      serverUrl: 'https://wallet.local',
      getToken: () => 'admin-token',
    });

    const requestId = 'request/approved';
    const secret = 'secret?value=1&flag';
    const pending = {
      socket,
      requestId,
      secret,
      agentId: 'agent-id',
      pubkey: keypair.publicKeyPem,
    };
    (server as unknown as { pendingAuths: Map<string, typeof pending> }).pendingAuths.set(requestId, pending);

    (server as unknown as { startPolling: (r: string, s: string) => void }).startPolling(requestId, secret);

    await vi.advanceTimersByTimeAsync(2000);

    expect(socket.write).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((socket.write as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload).toEqual(
      expect.objectContaining({
        type: 'auth_approved',
        encryptedToken: 'encrypted-token',
        agentId: 'agent-id',
        profile: { id: 'strict', version: 'v1' },
        effectivePolicyHash: 'a'.repeat(64),
        overrideDelta: ['ttlSeconds'],
      }),
    );
    expect(payload).not.toHaveProperty('token');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://wallet.local/auth/request%2Fapproved',
      {
        headers: {
          'x-aura-claim-secret': 'secret?value=1&flag',
        },
      },
    );

    const pendingMap = (server as unknown as { pendingAuths: Map<string, typeof pending> }).pendingAuths;
    expect(pendingMap.has(requestId)).toBe(false);
    const intervalMap = (server as unknown as { pollIntervals: Map<string, NodeJS.Timeout> }).pollIntervals;
    expect(intervalMap.has(requestId)).toBe(false);
  });

  it('errors when approval response is missing encryptedToken', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          status: 'approved',
          token: 'plaintext-token',
          agentId: 'agent-id',
          limit: 0.1,
        }),
        { status: 200 },
      ),
    );

    const socket = { write: vi.fn() } as unknown as Socket;
    const keypair = generateEphemeralKeypair();
    const server = new SocketServer({
      serverUrl: 'https://wallet.local',
      getToken: () => 'admin-token',
    });

    const requestId = 'request-missing';
    const secret = 'secret-123';
    const pending = {
      socket,
      requestId,
      secret,
      agentId: 'agent-id',
      pubkey: keypair.publicKeyPem,
    };
    (server as unknown as { pendingAuths: Map<string, typeof pending> }).pendingAuths.set(requestId, pending);

    (server as unknown as { startPolling: (r: string, s: string) => void }).startPolling(requestId, secret);

    await vi.advanceTimersByTimeAsync(2000);

    expect(socket.write).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((socket.write as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload).toMatchObject({
      type: 'error',
      message: 'Encrypted token unavailable for auth approval',
    });

    const pendingMap = (server as unknown as { pendingAuths: Map<string, typeof pending> }).pendingAuths;
    expect(pendingMap.has(requestId)).toBe(false);
    const intervalMap = (server as unknown as { pollIntervals: Map<string, NodeJS.Timeout> }).pollIntervals;
    expect(intervalMap.has(requestId)).toBe(false);
  });
});

describe('SocketServer auto-approve (in-process mode)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects in-process auto-approve while wallet is locked', async () => {
    vi.spyOn(cold, 'isUnlocked').mockReturnValue(false);
    vi.spyOn(defaults, 'getDefaultSync').mockImplementation(<T>(key: string, fallback: T): T => {
      if (key === 'trust.localAutoApprove') return true as T;
      return fallback;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const socket = { write: vi.fn() } as unknown as Socket;
    const keypair = generateEphemeralKeypair();
    const server = new SocketServer({
      serverUrl: 'https://wallet.local',
    });

    await (server as unknown as {
      handleAuthRequest: (s: Socket, req: unknown) => Promise<void>;
    }).handleAuthRequest(socket, {
      type: 'auth',
      agentId: 'agent-id',
      autoApprove: true,
      pubkey: keypair.publicKeyPem,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((socket.write as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload).toMatchObject({
      type: 'error',
      message: 'Wallet is locked. Unlock first.',
    });
  });

  it('issues encrypted token in-process when no admin token callback is present', async () => {
    vi.spyOn(cold, 'isUnlocked').mockReturnValue(true);
    vi.spyOn(defaults, 'getDefaultSync').mockImplementation(<T>(key: string, fallback: T): T => {
      if (key === 'trust.localAutoApprove') return true as T;
      return fallback;
    });
    const createTokenSpy = vi.spyOn(auth, 'createToken').mockResolvedValue('raw-token');
    vi.spyOn(transport, 'encryptToAgentPubkey').mockReturnValue('encrypted-token');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const socket = { write: vi.fn() } as unknown as Socket;
    const keypair = generateEphemeralKeypair();
    const server = new SocketServer({
      serverUrl: 'https://wallet.local',
    });

    await (server as unknown as {
      handleAuthRequest: (s: Socket, req: unknown) => Promise<void>;
    }).handleAuthRequest(socket, {
      type: 'auth',
      agentId: 'agent-id',
      autoApprove: true,
      pubkey: keypair.publicKeyPem,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createTokenSpy).toHaveBeenCalledTimes(1);
    expect(socket.write).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((socket.write as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload).toEqual(
      expect.objectContaining({
        type: 'auth_approved',
        encryptedToken: 'encrypted-token',
        agentId: 'agent-id',
      }),
    );
  });

  it('enables auto-approve with default fallback and then fails on lock', async () => {
    vi.spyOn(defaults, 'getDefaultSync').mockImplementation(<T>(_key: string, fallback: T): T => fallback);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const socket = { write: vi.fn() } as unknown as Socket;
    const keypair = generateEphemeralKeypair();
    const server = new SocketServer({
      serverUrl: 'https://wallet.local',
    });

    await (server as unknown as {
      handleAuthRequest: (s: Socket, req: unknown) => Promise<void>;
    }).handleAuthRequest(socket, {
      type: 'auth',
      agentId: 'agent-id',
      autoApprove: true,
      pubkey: keypair.publicKeyPem,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((socket.write as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload).toMatchObject({
      type: 'error',
      message: 'Wallet is locked. Unlock first.',
    });
  });

  it('blocks auto-approve when strict local profile is configured', async () => {
    vi.spyOn(defaults, 'getDefaultSync').mockImplementation(<T>(key: string, fallback: T): T => {
      if (key === 'trust.localAutoApprove') return true as T;
      if (key === 'trust.localProfile') return 'strict' as T;
      if (key === 'trust.localProfileVersion') return 'v1' as T;
      if (key === 'trust.localProfileOverrides') return null as T;
      if (key === 'trust.localLimits') return { fund: 0, send: 0, swap: 0 } as T;
      return fallback;
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const socket = { write: vi.fn() } as unknown as Socket;
    const keypair = generateEphemeralKeypair();
    const server = new SocketServer({
      serverUrl: 'https://wallet.local',
    });

    await (server as unknown as {
      handleAuthRequest: (s: Socket, req: unknown) => Promise<void>;
    }).handleAuthRequest(socket, {
      type: 'auth',
      agentId: 'agent-id',
      autoApprove: true,
      pubkey: keypair.publicKeyPem,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((socket.write as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload).toMatchObject({
      type: 'error',
      message: 'Strict profile requires manual approval (auto-approve disabled).',
    });
  });

  it('injects default profile on standard auth flow when request profile is omitted', async () => {
    vi.spyOn(defaults, 'getDefaultSync').mockImplementation(<T>(key: string, fallback: T): T => {
      if (key === 'trust.localProfile') return 'admin' as T;
      if (key === 'trust.localProfileVersion') return 'v1' as T;
      return fallback;
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, requestId: 'req-1', secret: 'secret-1' }), { status: 200 }),
    );

    const socket = { write: vi.fn() } as unknown as Socket;
    const keypair = generateEphemeralKeypair();
    const server = new SocketServer({
      serverUrl: 'https://wallet.local',
    });
    vi.spyOn(server as unknown as { startPolling: (requestId: string, secret: string) => void }, 'startPolling')
      .mockImplementation(() => {});

    await (server as unknown as {
      handleAuthRequest: (s: Socket, req: unknown) => Promise<void>;
    }).handleAuthRequest(socket, {
      type: 'auth',
      agentId: 'agent-id',
      pubkey: keypair.publicKeyPem,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://wallet.local/auth');
    const parsedBody = JSON.parse(String(requestInit?.body));
    expect(parsedBody).toMatchObject({
      agentId: 'agent-id',
      profile: 'admin',
      profileVersion: 'v1',
    });

    expect(socket.write).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((socket.write as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload).toMatchObject({
      type: 'auth_pending',
      requestId: 'req-1',
    });
  });
});
