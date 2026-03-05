import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../cli/lib/http', () => ({
  fetchJson: vi.fn(async () => ({})),
}));

import { fetchJson } from '../../cli/lib/http';
import {
  persistLocalAgentTrustDefaults,
  resolveLocalAgentModeChoice,
  toLocalAgentTrustDefaults,
} from '../../cli/lib/local-agent-trust';

const fetchJsonMock = vi.mocked(fetchJson);

describe('local agent trust helpers', () => {
  beforeEach(() => {
    fetchJsonMock.mockClear();
  });

  it('resolves mode selection for numbered and named inputs', () => {
    expect(resolveLocalAgentModeChoice('')).toBe('admin');
    expect(resolveLocalAgentModeChoice('1')).toBe('admin');
    expect(resolveLocalAgentModeChoice('maxx')).toBe('admin');
    expect(resolveLocalAgentModeChoice('work')).toBe('admin');
    expect(resolveLocalAgentModeChoice('admin')).toBe('admin');

    expect(resolveLocalAgentModeChoice('2')).toBe('dev');
    expect(resolveLocalAgentModeChoice('mid')).toBe('dev');
    expect(resolveLocalAgentModeChoice('dev')).toBe('dev');

    expect(resolveLocalAgentModeChoice('3')).toBe('strict');
    expect(resolveLocalAgentModeChoice('sus')).toBe('strict');
    expect(resolveLocalAgentModeChoice('local')).toBe('strict');
    expect(resolveLocalAgentModeChoice('strict')).toBe('strict');
  });

  it('derives auto-approve defaults per profile mode', () => {
    expect(toLocalAgentTrustDefaults('dev')).toEqual({
      profile: 'dev',
      profileVersion: 'v1',
      autoApprove: true,
    });
    expect(toLocalAgentTrustDefaults('strict')).toEqual({
      profile: 'strict',
      profileVersion: 'v1',
      autoApprove: false,
    });
    expect(toLocalAgentTrustDefaults('admin')).toEqual({
      profile: 'admin',
      profileVersion: 'v1',
      autoApprove: true,
    });
  });

  it.each([
    { profile: 'dev', autoApprove: true },
    { profile: 'strict', autoApprove: false },
    { profile: 'admin', autoApprove: true },
  ] as const)('persists trust defaults for %s mode', async ({ profile, autoApprove }) => {
    await persistLocalAgentTrustDefaults('session-token', profile);

    expect(fetchJsonMock).toHaveBeenCalledTimes(3);
    expect(fetchJsonMock).toHaveBeenNthCalledWith(
      1,
      '/defaults/trust.localProfile',
      expect.objectContaining({
        method: 'PATCH',
        token: 'session-token',
        body: { value: profile },
      }),
    );
    expect(fetchJsonMock).toHaveBeenNthCalledWith(
      2,
      '/defaults/trust.localProfileVersion',
      expect.objectContaining({
        method: 'PATCH',
        token: 'session-token',
        body: { value: 'v1' },
      }),
    );
    expect(fetchJsonMock).toHaveBeenNthCalledWith(
      3,
      '/defaults/trust.localAutoApprove',
      expect.objectContaining({
        method: 'PATCH',
        token: 'session-token',
        body: { value: autoApprove },
      }),
    );
  });
});
