import { describe, expect, it, vi } from 'vitest';

import { handlePermissionDenied } from '../../cli/lib/escalation';

describe('cli escalation guidance', () => {
  it('fails closed on unknown contractVersion', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handled = await handlePermissionDenied(403, {
      contractVersion: 'v999',
      requiresHumanApproval: true,
      reqId: 'req-unknown',
      error: 'Permission denied',
    });

    expect(handled).toBe(true);
    const payload = JSON.parse(String(errorSpy.mock.calls[errorSpy.mock.calls.length - 1][0])) as {
      contractVersion?: string;
      requiresHumanApproval?: boolean;
      errorCode?: string;
    };
    expect(payload.contractVersion).toBe('v1');
    expect(payload.requiresHumanApproval).toBe(false);
    expect(payload.errorCode).toBe('unsupported_contract_version');

    errorSpy.mockRestore();
  });

  it('fails closed when escalation payload omits contractVersion', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handled = await handlePermissionDenied(403, {
      requiresHumanApproval: true,
      reqId: 'req-missing-version',
      error: 'Permission denied',
    });

    expect(handled).toBe(true);
    const payload = JSON.parse(String(errorSpy.mock.calls[errorSpy.mock.calls.length - 1][0])) as {
      errorCode?: string;
      error?: string;
    };
    expect(payload.errorCode).toBe('unsupported_contract_version');
    expect(payload.error).toContain('missing');

    errorSpy.mockRestore();
  });

  it('prints approve -> claim -> retry guidance for canonical approval payloads', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handled = await handlePermissionDenied(403, {
      contractVersion: 'v1',
      requiresHumanApproval: true,
      reqId: 'req-123',
      approveUrl: 'http://localhost:4747/approve/req-123',
      approvalScope: 'one_shot_read',
      error: 'Excluded field requires approval',
    }, {
      retryCommandTemplate: 'npx auramaxx get OURSECRET',
    });

    expect(handled).toBe(true);
    const payload = JSON.parse(String(errorSpy.mock.calls[errorSpy.mock.calls.length - 1][0])) as {
      reqId?: string;
      claimAction?: { command?: string };
      retryAction?: { command?: string };
      instructions?: string[];
      claimStatus?: string;
      retryReady?: boolean;
    };
    expect(payload.reqId).toBe('req-123');
    expect(payload.claimAction?.command).toBe('npx auramaxx auth claim req-123 --json');
    expect(payload.retryAction?.command).toBe('npx auramaxx get OURSECRET --reqId req-123');
    expect(payload.claimStatus).toBe('pending');
    expect(payload.retryReady).toBe(false);
    expect(payload.instructions?.[0]).toContain('approve');
    expect(payload.instructions?.[1]).toContain('Claim');
    expect(payload.instructions?.[2]).toContain('exact command');

    errorSpy.mockRestore();
  });


  it('prints canonical hard-deny payload for wallet migration parity', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handled = await handlePermissionDenied(403, {
      contractVersion: 'v1',
      requiresHumanApproval: false,
      errorCode: 'route_not_allowlisted',
      error: 'Wallet access escalation denied',
      routeId: 'wallet.access',
      required: ['wallet:access'],
    });

    expect(handled).toBe(true);
    const payload = JSON.parse(String(errorSpy.mock.calls[errorSpy.mock.calls.length - 1][0])) as {
      contractVersion?: string;
      requiresHumanApproval?: boolean;
      errorCode?: string;
      routeId?: string;
      required?: string[];
    };
    expect(payload.contractVersion).toBe('v1');
    expect(payload.requiresHumanApproval).toBe(false);
    expect(payload.errorCode).toBe('route_not_allowlisted');
    expect(payload.routeId).toBe('wallet.access');
    expect(payload.required).toEqual(['wallet:access']);

    errorSpy.mockRestore();
  });

  it('fills missing action/instruction fields for deterministic errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handled = await handlePermissionDenied(400, {
      contractVersion: 'v1',
      errorCode: 'missing_or_expired_claim',
      error: 'Claim missing',
      reqId: 'req-456',
      claimStatus: 'expired',
      retryReady: false,
    }, {
      retryCommandTemplate: 'npx auramaxx get OURSECRET --json',
    });

    expect(handled).toBe(true);
    const payload = JSON.parse(String(errorSpy.mock.calls[errorSpy.mock.calls.length - 1][0])) as {
      claimAction?: { command?: string };
      retryAction?: { command?: string };
      instructions?: string[];
    };
    expect(payload.claimAction?.command).toBe('npx auramaxx auth claim req-456 --json');
    expect(payload.retryAction?.command).toBe('npx auramaxx get OURSECRET --json --reqId req-456');
    expect(payload.instructions?.length).toBeGreaterThan(0);

    errorSpy.mockRestore();
  });
});
