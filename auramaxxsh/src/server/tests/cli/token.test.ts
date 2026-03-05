import { describe, expect, it } from 'vitest';
import { formatPolicyPreview, parseTokenArgs } from '../../cli/commands/token';

describe('token CLI', () => {
  describe('parseTokenArgs', () => {
    it('parses preview with required profile', () => {
      const parsed = parseTokenArgs(['preview', '--profile', 'dev']);
      expect(parsed.subcommand).toBe('preview');
      expect(parsed.profile).toBe('dev');
      expect(parsed.json).toBe(false);
    });

    it('parses optional flags', () => {
      const parsed = parseTokenArgs([
        'preview',
        '--profile', 'strict',
        '--profile-version', 'v1',
        '--overrides', '{"ttlSeconds":900}',
        '--token', 'abc123',
        '--json',
      ]);

      expect(parsed.profileVersion).toBe('v1');
      expect(parsed.overridesRaw).toBe('{"ttlSeconds":900}');
      expect(parsed.token).toBe('abc123');
      expect(parsed.json).toBe(true);
    });
  });

  describe('formatPolicyPreview', () => {
    it('renders deterministic summary with deny examples', () => {
      const out = formatPolicyPreview({
        version: 'PolicyPreviewV1',
        profile: { id: 'dev', version: 'v1' },
        request: { profile: 'dev', profileVersion: 'v1' },
        effectivePolicy: {
          permissions: ['secret:read'],
          credentialAccess: { read: ['prod/*'], write: [] },
          excludeFields: ['password'],
          ttlSeconds: 3600,
          maxReads: null,
          rateBudget: {
            state: 'explicit',
            requests: 20,
            windowSeconds: 60,
            source: 'override',
          },
        },
        effectivePolicyHash: 'a'.repeat(64),
        warnings: ['Scope narrowed by override.'],
        denyExamples: [{ code: 'DENY_PERMISSION_MISSING', message: 'missing permission: secret:write' }],
      });

      expect(out).toContain('Profile: dev@v1');
      expect(out).toContain('Hash: ' + 'a'.repeat(64));
      expect(out).toContain('Permissions: secret:read');
      expect(out).toContain('Expected deny examples:');
      expect(out).toContain('DENY_PERMISSION_MISSING');
    });
  });
});
