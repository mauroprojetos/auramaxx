import { describe, expect, it } from 'vitest';
import {
  API_AUDIT_EXIT_CODES,
  API_REGISTRY_ERROR_CODES,
} from '../../../lib/api-registry/contracts';
import {
  ApiRegistryValidationError,
  enforceEgressPolicy,
  enforceHistoricalKeyTrust,
  evaluateAuditExitCode,
  resolveEffectivePermissions,
  validateAllowedHosts,
  validatePackageIdentity,
  validateSignatureEnvelope,
} from '../../../lib/api-registry/validation';

describe('api-registry contract validation', () => {
  it('accepts canonical package identity and rejects invalid/reserved names', () => {
    expect(validatePackageIdentity('@provider/github-api')).toEqual({
      namespace: 'provider',
      name: 'github-api',
    });

    expect(() => validatePackageIdentity('provider/github-api')).toThrowError(ApiRegistryValidationError);
    expect(() => validatePackageIdentity('@aura/github-api')).toThrowError(ApiRegistryValidationError);

    try {
      validatePackageIdentity('@aura/github-api');
    } catch (error) {
      expect((error as ApiRegistryValidationError).code).toBe(API_REGISTRY_ERROR_CODES.nameInvalid);
    }
  });

  it('enforces allowedHosts as fqdn-only and deny-by-default egress', () => {
    validateAllowedHosts(['api.example.com', 'registry.example.org']);

    expect(() => validateAllowedHosts(['127.0.0.1'])).toThrowError(ApiRegistryValidationError);
    expect(() => validateAllowedHosts(['*.example.com'])).toThrowError(ApiRegistryValidationError);

    expect(() => enforceEgressPolicy('evil.example.com', ['api.example.com'])).toThrowError(
      ApiRegistryValidationError
    );

    try {
      enforceEgressPolicy('evil.example.com', ['api.example.com']);
    } catch (error) {
      expect((error as ApiRegistryValidationError).code).toBe(API_REGISTRY_ERROR_CODES.egressDenied);
    }
  });

  it('only allows ed25519 signature envelopes with required fields', () => {
    validateSignatureEnvelope({
      algorithm: 'ed25519',
      keyId: 'publisher-key-1',
      sig: 'ZmFrZQ==',
      createdAt: '2026-02-17T00:00:00.000Z',
      payloadHash: 'abcd',
    });

    expect(() =>
      validateSignatureEnvelope({
        algorithm: 'rsa',
        keyId: 'publisher-key-1',
        sig: 'ZmFrZQ==',
        createdAt: '2026-02-17T00:00:00.000Z',
        payloadHash: 'abcd',
      })
    ).toThrowError(ApiRegistryValidationError);

    try {
      validateSignatureEnvelope({
        algorithm: 'rsa',
        keyId: 'publisher-key-1',
        sig: 'ZmFrZQ==',
        createdAt: '2026-02-17T00:00:00.000Z',
        payloadHash: 'abcd',
      });
    } catch (error) {
      expect((error as ApiRegistryValidationError).code).toBe(
        API_REGISTRY_ERROR_CODES.signatureAlgorithmUnsupported
      );
    }
  });

  it('applies deterministic permission resolution (deny > allow > implicit deny)', () => {
    const runtimeHardDeny = new Set<string>(['filesystem.write:workspace']);

    const resolved = resolveEffectivePermissions(
      ['http.read', 'secrets.read:prod'],
      {
        allow: ['http.read', 'secrets.read:prod'],
      },
      runtimeHardDeny
    );
    expect(resolved).toEqual(['http.read', 'secrets.read:prod']);

    expect(() =>
      resolveEffectivePermissions(
        ['filesystem.write:workspace'],
        { allow: ['filesystem.write:workspace'] },
        runtimeHardDeny
      )
    ).toThrowError(ApiRegistryValidationError);

    expect(() =>
      resolveEffectivePermissions(
        ['http.write'],
        { allow: ['http.read'] },
        new Set()
      )
    ).toThrowError(ApiRegistryValidationError);
  });

  it('enforces historical key trust cutoff for compromised keys', () => {
    enforceHistoricalKeyTrust(
      {
        keyId: 'k1',
        status: 'active',
        createdAt: '2026-02-16T00:00:00.000Z',
      },
      '2026-02-16T01:00:00.000Z'
    );

    expect(() =>
      enforceHistoricalKeyTrust(
        {
          keyId: 'k2',
          status: 'compromised',
          createdAt: '2026-02-16T00:00:00.000Z',
          compromiseDetectedAt: '2026-02-16T04:00:00.000Z',
        },
        '2026-02-16T05:00:00.000Z'
      )
    ).toThrowError(ApiRegistryValidationError);
  });

  it('returns contract exit codes for advisory/yank/integrity outcomes', () => {
    expect(
      evaluateAuditExitCode({
        mode: 'local',
        yanked: false,
        integrityFailure: false,
        findings: [{ severity: 'high' }],
      })
    ).toBe(API_AUDIT_EXIT_CODES.warning);

    expect(
      evaluateAuditExitCode({
        mode: 'ci',
        yanked: false,
        integrityFailure: false,
        findings: [{ severity: 'high' }],
      })
    ).toBe(API_AUDIT_EXIT_CODES.advisoryBlocked);

    expect(
      evaluateAuditExitCode({
        mode: 'ci',
        yanked: true,
        integrityFailure: false,
        findings: [],
      })
    ).toBe(API_AUDIT_EXIT_CODES.yankedBlocked);

    expect(
      evaluateAuditExitCode({
        mode: 'ci',
        yanked: false,
        integrityFailure: true,
        findings: [],
      })
    ).toBe(API_AUDIT_EXIT_CODES.integrityFailure);
  });
});
