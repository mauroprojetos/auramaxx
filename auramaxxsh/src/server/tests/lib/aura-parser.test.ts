import { describe, expect, it } from 'vitest';
import {
  assertCompat,
  parse,
  validate,
  validateSignatureEnvelope,
  makeError,
} from '../../../../packages/aura-parser/src';

describe('aura-parser v1 contracts', () => {
  it('parses assignment/comment/blank nodes with required fields', () => {
    const ast = parse('# comment\n\nAPI_KEY=${agent://prod/api?field=token}\nDB_URL="postgres://localhost/db"\nREF=${API_KEY}\n');

    expect(ast.version).toBe('aura.v1');
    expect(ast.nodes.some((n) => n.type === 'comment')).toBe(true);
    const assignment = ast.nodes.find((n) => n.type === 'assignment' && n.keyNorm === 'DB_URL');
    expect(assignment).toBeTruthy();
    expect(assignment?.loc.startLine).toBeGreaterThan(0);
    expect(assignment?.valueType).toBe('quoted');
    expect(assignment?.valueNorm).toBe('postgres://localhost/db');
  });

  it('rejects duplicate keys with stable parse code', () => {
    expect(() => parse('FOO=1\nFOO=2\n')).toThrowError(
      expect.objectContaining({ code: 'E_PARSE_DUPLICATE_KEY', category: 'parse' })
    );
  });

  it('rejects invalid unicode escapes', () => {
    expect(() => parse('FOO="bad\\u12G4"\n')).toThrowError(
      expect.objectContaining({ code: 'E_PARSE_BAD_UNICODE_ESCAPE' })
    );
  });

  it('returns deterministic normalized map ordering + metadata', () => {
    const doc = parse('BETA=${ALPHA}\nALPHA=${agent://v/secret?field=x}\n');
    const result = validate(doc);

    expect(result.normalized.entries.map((e) => e.key)).toEqual(['ALPHA', 'BETA']);
    expect(result.normalized.entries[0]).toMatchObject({
      key: 'ALPHA',
      providerRef: { provider: 'agent', resource: 'v/secret', query: 'field=x' },
      dependencies: [],
    });
    expect(result.normalized.entries[1].dependencies).toEqual(['ALPHA']);
  });

  it('enforces compatibility matrix major hard-fail', () => {
    expect(() => assertCompat('2.0', '1.4.0')).toThrowError(
      expect.objectContaining({ code: 'E_COMPAT_SPEC_UNSUPPORTED' })
    );
    expect(() => assertCompat('1.1', '2.0.0')).toThrowError(
      expect.objectContaining({ code: 'E_COMPAT_PROVIDER_API' })
    );
    expect(() => assertCompat('1.0', '1.9.3')).not.toThrow();
  });

  it('validates signature envelope constraints for v1', () => {
    expect(() =>
      validateSignatureEnvelope({
        algorithm: 'ed25519',
        keyId: 'key-1',
        sig: 'abc',
        createdAt: '2026-02-17T00:00:00Z',
        payloadSha256: 'a'.repeat(64),
      })
    ).not.toThrow();

    expect(() =>
      validateSignatureEnvelope({
        algorithm: 'ed25519',
        keyId: 'key-1',
        sig: 'abc',
        createdAt: '2026-02-17T00:00:00Z',
        payloadSha256: 'xyz',
      })
    ).toThrowError(expect.objectContaining({ code: 'E_TRUST_BAD_PAYLOAD_HASH' }));
  });

  it('builds machine-readable error envelope fields', () => {
    const err = makeError({
      code: 'E_POLICY_CAPABILITY_ESCALATION',
      category: 'policy',
      severity: 'error',
      message: 'Escalation denied',
      details: { requested: 'resolve.write' },
    });

    expect(err).toMatchObject({
      code: 'E_POLICY_CAPABILITY_ESCALATION',
      category: 'policy',
      severity: 'error',
      retryable: false,
    });
  });
});
