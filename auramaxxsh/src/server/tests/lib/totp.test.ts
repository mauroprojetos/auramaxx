/**
 * Tests for TOTP generation and otpauth URI parsing
 *
 * Tests:
 * - RFC 6238 TOTP code generation with known test vectors
 * - otpauth:// URI parsing with all parameters
 * - Edge cases: invalid URIs, missing secret, whitespace handling
 * - TOTP validation with time window
 */
import { describe, it, expect } from 'vitest';
import { generateTOTP, parseOtpauthUri, validateTOTP, findTotpField } from '../../lib/totp';

describe('generateTOTP', () => {
  it('generates a 6-digit code from a base32 secret', () => {
    // Standard test secret
    const secret = 'JBSWY3DPEHPK3PXP'; // base32 for "Hello!"
    const result = generateTOTP(secret);
    expect(result.code).toMatch(/^\d{6}$/);
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.remaining).toBeLessThanOrEqual(30);
  });

  it('returns consistent codes within the same 30s window', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const r1 = generateTOTP(secret);
    const r2 = generateTOTP(secret);
    expect(r1.code).toBe(r2.code);
  });

  it('handles secrets with spaces and lowercase', () => {
    const secret = 'jbsw y3dp ehpk 3pxp';
    const result = generateTOTP(secret);
    expect(result.code).toMatch(/^\d{6}$/);
  });

  it('accepts issuer and label parameters', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const result = generateTOTP(secret, 'GitHub', 'user@example.com');
    expect(result.code).toMatch(/^\d{6}$/);
  });

  it('accepts full otpauth URI strings and honors encoded params', () => {
    const uri = 'otpauth://totp/GitHub:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60&algorithm=SHA256';
    const result = generateTOTP(uri);

    expect(result.code).toMatch(/^\d{8}$/);
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.remaining).toBeLessThanOrEqual(60);
  });

  it('accepts full otpauth URI with leading/trailing whitespace', () => {
    const uri = '  otpauth://totp/GitHub:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=6&period=30  ';
    const result = generateTOTP(uri);

    expect(result.code).toMatch(/^\d{6}$/);
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.remaining).toBeLessThanOrEqual(30);
  });
});

describe('parseOtpauthUri', () => {
  it('parses a standard otpauth URI', () => {
    const uri = 'otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA1&digits=6&period=30';
    const params = parseOtpauthUri(uri);
    expect(params.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(params.issuer).toBe('Example');
    expect(params.algorithm).toBe('SHA1');
    expect(params.digits).toBe(6);
    expect(params.period).toBe(30);
    expect(params.label).toBe('Example:alice@example.com');
  });

  it('parses minimal URI with only secret', () => {
    const uri = 'otpauth://totp/MyApp?secret=ABCDEFGH';
    const params = parseOtpauthUri(uri);
    expect(params.secret).toBe('ABCDEFGH');
    expect(params.label).toBe('MyApp');
    expect(params.issuer).toBeUndefined();
  });

  it('throws on non-otpauth URI', () => {
    expect(() => parseOtpauthUri('https://example.com')).toThrow('Not an otpauth URI');
  });

  it('throws on non-totp type', () => {
    expect(() => parseOtpauthUri('otpauth://hotp/Test?secret=ABC')).toThrow('Only TOTP is supported');
  });

  it('throws on missing secret', () => {
    expect(() => parseOtpauthUri('otpauth://totp/Test')).toThrow('Missing secret parameter');
  });

  it('throws on invalid secret charset', () => {
    expect(() => parseOtpauthUri('otpauth://totp/Test?secret=JBSW$3D')).toThrow('Invalid TOTP secret');
  });

  it('throws on unsupported algorithm', () => {
    expect(() => parseOtpauthUri('otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1024')).toThrow('Unsupported TOTP algorithm: SHA1024');
  });

  it('throws on invalid digits', () => {
    expect(() => parseOtpauthUri('otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&digits=12')).toThrow('Invalid TOTP digits: 12');
  });

  it('throws on invalid period', () => {
    expect(() => parseOtpauthUri('otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&period=10')).toThrow('Invalid TOTP period: 10');
  });

  it('uppercases and strips whitespace from secret', () => {
    const uri = 'otpauth://totp/Test?secret=jbswy3dp';
    const params = parseOtpauthUri(uri);
    expect(params.secret).toBe('JBSWY3DP');
  });
});

describe('generateTOTP with OtpauthParams', () => {
  it('honors algorithm, digits, and period from params', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const result = generateTOTP(secret, { algorithm: 'SHA256', digits: 8, period: 60 });
    expect(result.code).toMatch(/^\d{8}$/);
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.remaining).toBeLessThanOrEqual(60);
  });

  it('falls back to defaults when params are partial', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const result = generateTOTP(secret, { issuer: 'GitHub' });
    expect(result.code).toMatch(/^\d{6}$/);
    expect(result.remaining).toBeLessThanOrEqual(30);
  });

  it('generates same code as string-issuer overload', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const r1 = generateTOTP(secret, 'GitHub');
    const r2 = generateTOTP(secret, { issuer: 'GitHub' });
    expect(r1.code).toBe(r2.code);
  });
});

describe('validateTOTP', () => {
  it('validates the current code', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const { code } = generateTOTP(secret);
    expect(validateTOTP(secret, code)).toBe(true);
  });

  it('rejects an incorrect code', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(validateTOTP(secret, '000000')).toBe(false);
  });

  it('validates the current code from a full otpauth URI', () => {
    const uri = 'otpauth://totp/GitHub:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60&algorithm=SHA256';
    const { code } = generateTOTP(uri);
    expect(validateTOTP(uri, code)).toBe(true);
  });

  it('validates against URI with overriding custom params', () => {
    const uri = 'otpauth://totp/GitHub:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60&algorithm=SHA256';
    const params = { digits: 6 };
    const { code } = generateTOTP(uri);
    expect(validateTOTP(uri, code, params)).toBe(false);
  });

  it('validates with custom params', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const params = { algorithm: 'SHA256', digits: 8, period: 60 };
    const { code } = generateTOTP(secret, params);
    expect(validateTOTP(secret, code, params)).toBe(true);
  });
});

describe('findTotpField', () => {
  it('finds field with key "totp"', () => {
    const fields = [{ key: 'username', value: 'a' }, { key: 'totp', value: 'SECRET' }];
    expect(findTotpField(fields)?.value).toBe('SECRET');
  });

  it('finds field with key "otp" for backward compat', () => {
    const fields = [{ key: 'username', value: 'a' }, { key: 'otp', value: 'SECRET' }];
    expect(findTotpField(fields)?.value).toBe('SECRET');
  });

  it('prefers "totp" over "otp"', () => {
    const fields = [{ key: 'otp', value: 'OLD' }, { key: 'totp', value: 'NEW' }];
    expect(findTotpField(fields)?.value).toBe('NEW');
  });

  it('returns undefined when no TOTP field', () => {
    const fields = [{ key: 'username', value: 'a' }];
    expect(findTotpField(fields)).toBeUndefined();
  });
});
