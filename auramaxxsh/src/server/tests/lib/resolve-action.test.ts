/**
 * Unit tests for resolveAction — the extracted resolve logic.
 *
 * Tests:
 * - Rejection: updates DB, emits event
 * - Approval: generates token, escrows it, emits events
 * - 404: action not found or already resolved
 * - 400: invalid input (non-boolean approved, strategy:message)
 * - 401: wallet locked for auth/action types
 * - permission_update: generates token with updated permissions
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../lib/db', () => ({
  prisma: {
    humanAction: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    log: {
      create: vi.fn(),
    },
  },
}));

vi.mock('../../lib/events', () => ({
  events: {
    actionResolved: vi.fn(),
    tokenCreated: vi.fn(),
  },
  emitWalletEvent: vi.fn(),
}));

vi.mock('../../lib/strategy/engine', () => ({
  handleAppMessage: vi.fn().mockResolvedValue({ reply: null }),
}));

vi.mock('../../lib/auth', () => ({
  createToken: vi.fn().mockResolvedValue('mock-token-123'),
  getTokenHash: vi.fn().mockReturnValue('hash-123'),
  escrowToken: vi.fn(),
}));

vi.mock('../../lib/credential-transport', () => ({
  isValidAgentPubkey: vi.fn().mockReturnValue(true),
  normalizeAgentPubkey: vi.fn((k: string) => k),
}));

vi.mock('../../lib/cold', () => ({
  isUnlocked: vi.fn().mockReturnValue(true),
  getColdWalletAddress: vi.fn().mockReturnValue('0xcold'),
}));

vi.mock('../../lib/address', () => ({
  normalizeAddress: vi.fn((addr: string) => addr.toLowerCase()),
}));

vi.mock('../../lib/defaults', () => ({
  getDefault: vi.fn().mockImplementation((_key: string, fallback: unknown) => Promise.resolve(fallback)),
  getDefaultSync: vi.fn().mockImplementation((_key: string, fallback: unknown) => fallback),
  parseRateLimit: vi.fn().mockReturnValue({ max: 3, windowMs: 120000 }),
}));

vi.mock('../../lib/logger', () => ({
  logEvent: vi.fn(),
  logger: {
    actionResolved: vi.fn(),
  },
}));

vi.mock('../../lib/error', () => ({
  getErrorMessage: vi.fn((err: Error) => err.message || String(err)),
}));

import { resolveAction } from '../../lib/resolve-action';
import { prisma } from '../../lib/db';
import { events } from '../../lib/events';
import { isUnlocked } from '../../lib/cold';
import { escrowToken } from '../../lib/auth';

// Cast mocked modules for type-safe access
const mockPrisma = vi.mocked(prisma);
const mockEvents = vi.mocked(events);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('resolveAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isUnlocked).mockReturnValue(true);
  });

  it('should return 400 when approved is not boolean', async () => {
    const result = await resolveAction('action-1', 'yes' as unknown as boolean);

    expect(result.statusCode).toBe(400);
    expect(result.success).toBe(false);
    expect(result.data.error).toContain('approved (boolean) is required');
  });

  it('should return 404 when action not found', async () => {
    mockPrisma.humanAction.findUnique.mockResolvedValue(null);

    const result = await resolveAction('nonexistent', true);

    expect(result.statusCode).toBe(404);
    expect(result.data.error).toContain('not found');
  });

  it('should return 404 when action already resolved', async () => {
    mockPrisma.humanAction.findUnique.mockResolvedValue({
      id: 'action-1',
      status: 'approved',
      type: 'auth',
      metadata: '{}',
    });

    const result = await resolveAction('action-1', true);

    expect(result.statusCode).toBe(404);
    expect(result.data.error).toContain('already resolved');
  });

  it('should return 400 for strategy:message type', async () => {
    mockPrisma.humanAction.findUnique.mockResolvedValue({
      id: 'action-1',
      status: 'pending',
      type: 'strategy:message',
      metadata: '{}',
    });

    const result = await resolveAction('action-1', true);

    expect(result.statusCode).toBe(400);
    expect(result.data.error).toContain('not manually resolvable');
  });

  it('should reject an action successfully', async () => {
    mockPrisma.humanAction.findUnique.mockResolvedValue({
      id: 'action-1',
      status: 'pending',
      type: 'agent_access',
      metadata: JSON.stringify({ agentId: 'bot-1' }),
    });

    const result = await resolveAction('action-1', false);

    expect(result.statusCode).toBe(200);
    expect(result.success).toBe(true);
    expect(result.data.approved).toBe(false);

    // Verify DB was updated
    expect(mockPrisma.humanAction.update).toHaveBeenCalledWith({
      where: { id: 'action-1' },
      data: { status: 'rejected', resolvedAt: expect.any(Date) },
    });

    // Verify event was emitted
    expect(mockEvents.actionResolved).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'action-1', approved: false }),
    );
  });

  it('should approve strategy:approve type', async () => {
    mockPrisma.humanAction.findUnique.mockResolvedValue({
      id: 'action-1',
      status: 'pending',
      type: 'strategy:approve',
      metadata: '{}',
    });

    const result = await resolveAction('action-1', true);

    expect(result.statusCode).toBe(200);
    expect(result.data.approved).toBe(true);
    expect(mockPrisma.humanAction.update).toHaveBeenCalledWith({
      where: { id: 'action-1' },
      data: { status: 'approved', resolvedAt: expect.any(Date) },
    });
  });

  it('should return 401 when wallet is locked for auth type', async () => {
    vi.mocked(isUnlocked).mockReturnValue(false);

    mockPrisma.humanAction.findUnique.mockResolvedValue({
      id: 'action-1',
      status: 'pending',
      type: 'auth',
      metadata: JSON.stringify({ agentId: 'bot-1', pubkey: 'test-key' }),
    });

    const result = await resolveAction('action-1', true);

    expect(result.statusCode).toBe(401);
    expect(result.data.error).toContain('locked');
  });

  it('should approve agent_access and return token', async () => {
    mockPrisma.humanAction.findUnique.mockResolvedValue({
      id: 'action-1',
      status: 'pending',
      type: 'agent_access',
      metadata: JSON.stringify({
        agentId: 'bot-1',
        permissions: ['fund', 'send:hot'],
        limit: 0.5,
        ttl: 3600,
        pubkey: 'test-key',
      }),
    });

    const result = await resolveAction('action-1', true);

    expect(result.statusCode).toBe(200);
    expect(result.success).toBe(true);
    expect(result.data.token).toBe('mock-token-123');
    expect(result.data.agentId).toBe('bot-1');
    expect(result.data.limit).toBe(0.5);

    // Verify token was escrowed
    expect(escrowToken).toHaveBeenCalledWith('action-1', 'mock-token-123');

    // Verify events
    expect(mockEvents.tokenCreated).toHaveBeenCalled();
    expect(mockEvents.actionResolved).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'action-1', approved: true }),
    );
  });

  it('should approve permission_update type', async () => {
    mockPrisma.humanAction.findUnique.mockResolvedValue({
      id: 'action-1',
      status: 'pending',
      type: 'permission_update',
      metadata: JSON.stringify({
        agentId: 'bot-1',
        requestedPermissions: ['fund', 'swap'],
        requestedWalletAccess: ['0xABC'],
        requestedLimits: { fund: 1.0, swap: 0.5 },
        requestedPubkey: 'test-key',
      }),
    });

    const result = await resolveAction('action-1', true);

    expect(result.statusCode).toBe(200);
    expect(result.data.token).toBe('mock-token-123');
    expect(result.data.agentId).toBe('bot-1');
    expect(result.data.permissions).toEqual(['fund', 'swap']);
  });

  it('should handle fund_transfer type (generic approval)', async () => {
    mockPrisma.humanAction.findUnique.mockResolvedValue({
      id: 'action-1',
      status: 'pending',
      type: 'fund_transfer',
      metadata: '{}',
    });

    const result = await resolveAction('action-1', true);

    expect(result.statusCode).toBe(200);
    expect(result.data.approved).toBe(true);

    expect(mockPrisma.humanAction.update).toHaveBeenCalledWith({
      where: { id: 'action-1' },
      data: { status: 'approved', resolvedAt: expect.any(Date) },
    });
  });

  it('should pass override limits through', async () => {
    mockPrisma.humanAction.findUnique.mockResolvedValue({
      id: 'action-1',
      status: 'pending',
      type: 'agent_access',
      metadata: JSON.stringify({
        agentId: 'bot-1',
        limit: 0.5,
        permissions: ['fund'],
        ttl: 3600,
        pubkey: 'test-key',
      }),
    });

    const result = await resolveAction('action-1', true, {
      limits: { fund: 2.0, send: 1.0, swap: 0.5 },
    });

    expect(result.statusCode).toBe(200);
    expect(result.data.limits).toEqual(expect.objectContaining({ fund: 2.0 }));
  });
});
