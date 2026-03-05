import { describe, expect, it } from 'vitest';
import { buildApproveUrl, buildPermissionDeniedPayload } from '../../lib/approval-link';

describe('approval link payload helper', () => {
  it('builds approve URL and denial payload', () => {
    const url = buildApproveUrl('http://localhost:4747/', 'abc-123');
    expect(url).toBe('http://localhost:4747/approve/abc-123');

    const payload = buildPermissionDeniedPayload({
      actionId: 'abc-123',
      baseUrl: 'http://localhost:4747',
      reason: 'missing permission: secret:read',
    });

    expect(payload.error).toBe('PERMISSION_REQUIRED');
    expect(payload.actionId).toBe('abc-123');
    expect(payload.approveUrl).toBe('http://localhost:4747/approve/abc-123');
    expect(payload.reason).toContain('missing permission');
  });
});
