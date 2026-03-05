import { describe, expect, it } from 'vitest';
import { parseStartArgs } from '../../cli/commands/start';

describe('start CLI args', () => {
  it('parses default flags as disabled', () => {
    expect(parseStartArgs([])).toEqual({
      headless: false,
      background: false,
      debug: false,
      dev: false,
      help: false,
    });
  });

  it('parses headless/background/debug flags', () => {
    expect(parseStartArgs(['--headless', '--background', '--debug'])).toEqual({
      headless: true,
      background: true,
      debug: true,
      dev: false,
      help: false,
    });
  });

  it('parses dev flag', () => {
    expect(parseStartArgs(['--dev'])).toEqual({
      headless: false,
      background: false,
      debug: false,
      dev: true,
      help: false,
    });
  });

  it('parses short daemon and help flags', () => {
    expect(parseStartArgs(['-d', '-h'])).toEqual({
      headless: false,
      background: true,
      debug: false,
      dev: false,
      help: true,
    });
  });
});
