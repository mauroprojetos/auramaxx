import { describe, expect, it } from 'vitest';
import {
  buildNpxLatestCommand,
  buildUpdateCommand,
  buildUpdateFallbackCommand,
  buildUpdateForceCommand,
  buildVersionInfo,
  isNewerVersion,
} from '../../lib/update-check';

describe('update-check helpers', () => {
  it('detects newer versions', () => {
    expect(isNewerVersion('1.2.3', '1.2.4')).toBe(true);
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.3', '1.2.2')).toBe(false);
  });

  it('builds version info and update command', () => {
    const info = buildVersionInfo('1.0.0', '1.1.0');
    expect(info.updateAvailable).toBe(true);
    expect(buildUpdateCommand()).toBe('npm install -g auramaxx --foreground-scripts');
    expect(buildUpdateForceCommand()).toBe('npm install -g auramaxx --foreground-scripts --force');
    expect(buildNpxLatestCommand()).toBe('npx --yes auramaxx@latest');
    expect(buildNpxLatestCommand('auramaxx', ['restart'])).toBe('npx --yes auramaxx@latest restart');
    expect(buildUpdateFallbackCommand()).toBe('npx --yes auramaxx@latest start');
  });
});
