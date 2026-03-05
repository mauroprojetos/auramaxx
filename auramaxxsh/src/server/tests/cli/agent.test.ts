import { describe, expect, it } from 'vitest';
import { parseArgs, formatCredential } from '../../cli/commands/agent';
import { defaultSecretEnvVarName, normalizeEnvVarName } from '../../lib/secret-env';

describe('agent CLI', () => {
  describe('secret env var helpers', () => {
    it('derives default env var names from secret names', () => {
      expect(defaultSecretEnvVarName('OpenAI API Key')).toBe('AURA_OPENAI_API_KEY');
      expect(defaultSecretEnvVarName(' github/pat ')).toBe('AURA_GITHUB_PAT');
    });

    it('normalizes valid env vars and rejects invalid names', () => {
      expect(normalizeEnvVarName('AURA_SECRET')).toBe('AURA_SECRET');
      expect(normalizeEnvVarName('  GITHUB_PAT  ')).toBe('GITHUB_PAT');
      expect(normalizeEnvVarName('123BAD')).toBeNull();
      expect(normalizeEnvVarName('BAD-NAME')).toBeNull();
    });
  });

  describe('parseArgs', () => {
    it('parses get with no flags', () => {
      const result = parseArgs(['get', 'my-secret']);
      expect(result.subcommand).toBe('get');
      expect(result.positional).toEqual(['my-secret']);
      expect(result.flagJson).toBe(false);
      expect(result.flagFirst).toBe(false);
      expect(result.fieldName).toBeUndefined();
    });

    it('parses get with --json', () => {
      const result = parseArgs(['get', 'my-secret', '--json']);
      expect(result.flagJson).toBe(true);
      expect(result.positional).toEqual(['my-secret']);
    });

    it('parses get with --field', () => {
      const result = parseArgs(['get', 'my-secret', '--field', 'password']);
      expect(result.fieldName).toBe('password');
      expect(result.positional).toEqual(['my-secret']);
    });

    it('parses get with --first', () => {
      const result = parseArgs(['get', 'aws', '--first']);
      expect(result.flagFirst).toBe(true);
    });

    it('parses get with --agent', () => {
      const result = parseArgs(['get', 'aws', '--agent', 'agent']);
      expect(result.agentName).toBe('agent');
      expect(result.positional).toEqual(['aws']);
    });

    it('parses get with --reqId', () => {
      const result = parseArgs(['get', 'aws', '--reqId', 'req-123']);
      expect(result.reqId).toBe('req-123');
      expect(result.positional).toEqual(['aws']);
    });

    it('parses get with --req-id alias', () => {
      const result = parseArgs(['get', 'aws', '--req-id', 'req-123']);
      expect(result.reqId).toBe('req-123');
      expect(result.positional).toEqual(['aws']);
    });

    it('parses get with --requestId alias', () => {
      const result = parseArgs(['get', 'aws', '--requestId', 'req-123']);
      expect(result.reqId).toBe('req-123');
      expect(result.positional).toEqual(['aws']);
    });

    it('parses get with --request-id alias', () => {
      const result = parseArgs(['get', 'aws', '--request-id', 'req-123']);
      expect(result.reqId).toBe('req-123');
      expect(result.positional).toEqual(['aws']);
    });

    it('parses list', () => {
      const result = parseArgs(['list']);
      expect(result.subcommand).toBe('list');
      expect(result.positional).toEqual([]);
    });

    it('parses list with --name and --field filters', () => {
      const result = parseArgs(['list', '--name', 'prod', '--field', 'token']);
      expect(result.subcommand).toBe('list');
      expect(result.secretEnvName).toBe('prod');
      expect(result.fieldName).toBe('token');
      expect(result.positional).toEqual([]);
    });

    it('handles missing subcommand', () => {
      const result = parseArgs([]);
      expect(result.subcommand).toBeUndefined();
    });

    it('parses set with --type, --tags, and extra field flags', () => {
      const result = parseArgs(['set', 'OPENAI_KEY', 'sk-xxx', '--type', 'api key', '--tags', 'Prod, backend,prod', '--another-field', '123']);
      expect(result.typeName).toBe('api key');
      expect(result.tags).toEqual(['prod', 'backend']);
      expect(result.extraFields).toEqual([{ key: 'another-field', value: '123' }]);
    });

    it('parses secret exec with env override and command separator', () => {
      const result = parseArgs(['secret', 'exec', 'OPENAI_KEY', '--env', 'GITHUB_PAT', '--', 'printenv', 'GITHUB_PAT']);
      expect(result.subcommand).toBe('secret');
      expect(result.secretEnvName).toBe('GITHUB_PAT');
      expect(result.positional).toEqual(['exec', 'OPENAI_KEY']);
      expect(result.execCommand).toEqual(['printenv', 'GITHUB_PAT']);
    });

    it('parses inject shortcut with env override and command separator', () => {
      const result = parseArgs(['inject', 'OPENAI_KEY', '--env', 'OPENAI_TOKEN', '--', 'printenv', 'OPENAI_TOKEN']);
      expect(result.subcommand).toBe('inject');
      expect(result.secretEnvName).toBe('OPENAI_TOKEN');
      expect(result.positional).toEqual(['OPENAI_KEY']);
      expect(result.execCommand).toEqual(['printenv', 'OPENAI_TOKEN']);
    });

    it('keeps --name compatibility for secret env override', () => {
      const result = parseArgs(['inject', 'OPENAI_KEY', '--name', 'OPENAI_TOKEN', '--', 'printenv', 'OPENAI_TOKEN']);
      expect(result.secretEnvName).toBe('OPENAI_TOKEN');
    });
  });

  describe('formatCredential', () => {
    const target = { name: 'AWS Prod', type: 'login', id: 'abc123' };
    const decrypted = {
      id: 'abc123',
      agentId: 'v1',
      type: 'login',
      fields: [
        { key: 'username', value: 'admin' },
        { key: 'password', value: 's3cr3t' },
      ],
    };

    it('formats primary value only by default', () => {
      const result = formatCredential(target, decrypted, { json: false });
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('s3cr3t');
    });

    it('formats sensitive primary value as encrypted when auto-decrypt is disabled', () => {
      const result = formatCredential(target, decrypted, {
        json: false,
        autoDecryptSensitive: false,
        encryptSensitiveValue: (value: string) => `enc(${value})`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('enc(s3cr3t)');
    });

    it('formats as JSON', () => {
      const result = formatCredential(target, decrypted, { json: true });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.output);
      expect(parsed.name).toBe('AWS Prod');
      expect(parsed.meta).toEqual({});
      expect(parsed.fields).toHaveLength(2);
    });

    it('extracts single field', () => {
      const result = formatCredential(target, decrypted, { json: false, fieldName: 'password' });
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('s3cr3t');
    });

    it('returns error for missing field', () => {
      const result = formatCredential(target, decrypted, { json: false, fieldName: 'nonexistent' });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('not found');
    });

    it('field lookup is case-insensitive', () => {
      const result = formatCredential(target, decrypted, { json: false, fieldName: 'PASSWORD' });
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('s3cr3t');
    });

    it('reads metadata-backed non-sensitive fields in plaintext', () => {
      const result = formatCredential(
        { ...target, meta: { website: 'https://example.com' } },
        { ...decrypted, fields: [{ key: 'password', value: 's3cr3t', sensitive: true }] },
        {
          json: false,
          fieldName: 'website',
          autoDecryptSensitive: false,
          encryptSensitiveValue: (value: string) => `enc(${value})`,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('https://example.com');
    });

    it('falls back to first field when mapped primary field is missing', () => {
      const result = formatCredential(
        target,
        { ...decrypted, type: 'unknown', fields: [{ key: 'token', value: 'abc' }] },
        { json: false },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('abc');
    });

  });
});
