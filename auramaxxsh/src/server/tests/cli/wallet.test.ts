import { describe, it, expect } from 'vitest';
import { parseArgs, resolveRoute } from '../../cli/commands/wallet';

describe('wallet CLI command parser', () => {
  it('parses read command', () => {
    const parsed = parseArgs(['status']);
    expect(parsed?.command).toBe('status');
    expect(parsed?.noAuth).toBe(false);
  });

  it('parses mutating flags', () => {
    const parsed = parseArgs(['swap', '--body', '{"fromToken":"ETH"}', '--yes', '--no-auth']);
    expect(parsed?.command).toBe('swap');
    expect(parsed?.bodyRaw).toContain('fromToken');
    expect(parsed?.yes).toBe(true);
    expect(parsed?.noAuth).toBe(true);
  });

  it('maps routes correctly', () => {
    expect(resolveRoute('assets')).toEqual({ method: 'GET', route: '/wallet/assets' });
    expect(resolveRoute('swap')).toEqual({ method: 'POST', route: '/swap' });
  });
});
