import { describe, it, expect } from 'vitest';
import {
  escapeForShell,
  isValidEnvVarName,
  validateEnvVarName,
} from '../../cli/lib/credential-resolve';

describe('escapeForShell', () => {
  it('wraps simple values in $\\\'...\\\'', () => {
    expect(escapeForShell('hello')).toBe("$'hello'");
  });

  it('escapes single quotes', () => {
    expect(escapeForShell("it's")).toBe("$'it\\'s'");
  });

  it('escapes newlines (audit finding #1)', () => {
    expect(escapeForShell('line1\nline2')).toBe("$'line1\\nline2'");
  });

  it('escapes carriage returns', () => {
    expect(escapeForShell('a\rb')).toBe("$'a\\rb'");
  });

  it('escapes tabs', () => {
    expect(escapeForShell('a\tb')).toBe("$'a\\tb'");
  });

  it('escapes backslashes', () => {
    expect(escapeForShell('path\\to\\file')).toBe("$'path\\\\to\\\\file'");
  });

  it('escapes null bytes', () => {
    expect(escapeForShell('a\0b')).toBe("$'a\\0b'");
  });

  it('escapes control characters', () => {
    expect(escapeForShell('a\x01b')).toBe("$'a\\x01b'");
  });

  it('handles multiline credential values safely', () => {
    const multiline = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
    const escaped = escapeForShell(multiline);
    // Should not contain literal newlines
    expect(escaped).not.toContain('\n');
    expect(escaped).toContain('\\n');
  });

  it('handles empty string', () => {
    expect(escapeForShell('')).toBe("$''");
  });

  it('handles shell injection attempts', () => {
    const malicious = "'; rm -rf / #";
    const escaped = escapeForShell(malicious);
    expect(escaped).toBe("$'\\'; rm -rf / #'");
  });
});

describe('isValidEnvVarName', () => {
  it('accepts valid names', () => {
    expect(isValidEnvVarName('FOO')).toBe(true);
    expect(isValidEnvVarName('_BAR')).toBe(true);
    expect(isValidEnvVarName('foo_bar_123')).toBe(true);
    expect(isValidEnvVarName('A')).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(isValidEnvVarName('')).toBe(false);
    expect(isValidEnvVarName('123ABC')).toBe(false);
    expect(isValidEnvVarName('FOO BAR')).toBe(false);
    expect(isValidEnvVarName('FOO-BAR')).toBe(false);
    expect(isValidEnvVarName('FOO.BAR')).toBe(false);
    expect(isValidEnvVarName('FOO=BAR')).toBe(false);
  });
});

describe('validateEnvVarName', () => {
  it('does not throw for valid names', () => {
    expect(() => validateEnvVarName('DATABASE_URL')).not.toThrow();
  });

  it('throws for invalid names', () => {
    expect(() => validateEnvVarName('123-bad')).toThrow('Invalid env var name');
  });
});
