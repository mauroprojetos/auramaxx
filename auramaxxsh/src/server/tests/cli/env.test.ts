import { describe, expect, it } from 'vitest';
import { escapeEnvValue, parseAuraFile } from '../../cli/commands/env';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('env CLI', () => {
  describe('escapeEnvValue', () => {
    it('wraps simple values in quotes', () => {
      expect(escapeEnvValue('hello')).toBe('"hello"');
    });

    it('escapes backslashes', () => {
      expect(escapeEnvValue('path\\to\\file')).toBe('"path\\\\to\\\\file"');
    });

    it('escapes dollar signs', () => {
      expect(escapeEnvValue('price$100')).toBe('"price\\$100"');
    });

    it('escapes newlines', () => {
      expect(escapeEnvValue('line1\nline2')).toBe('"line1\\nline2"');
    });

    it('escapes double quotes', () => {
      expect(escapeEnvValue('say "hi"')).toBe('"say \\"hi\\""');
    });

    it('escapes carriage returns', () => {
      expect(escapeEnvValue('a\rb')).toBe('"a\\rb"');
    });

    it('handles combined special chars', () => {
      expect(escapeEnvValue('$HOME\\n"test"')).toBe('"\\$HOME\\\\n\\"test\\""');
    });
  });

  describe('parseAuraFile', () => {
    const tmpFile = join(tmpdir(), `test-aura-${Date.now()}`);

    it('parses simple credential/field mappings', () => {
      writeFileSync(tmpFile, 'DB_URL=database/url\nAPI_KEY=stripe/secret_key\n');
      const mappings = parseAuraFile(tmpFile);
      expect(mappings).toHaveLength(2);
      expect(mappings[0]).toEqual({ envVar: 'DB_URL', agent: null, credentialName: 'database', field: 'url' });
      expect(mappings[1]).toEqual({ envVar: 'API_KEY', agent: null, credentialName: 'stripe', field: 'secret_key' });
      unlinkSync(tmpFile);
    });

    it('parses @agent references', () => {
      writeFileSync(tmpFile, 'TOKEN=@agent/openai/api_key\n');
      const mappings = parseAuraFile(tmpFile);
      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toEqual({ envVar: 'TOKEN', agent: 'agent', credentialName: 'openai', field: 'api_key' });
      unlinkSync(tmpFile);
    });

    it('skips comments and blank lines', () => {
      writeFileSync(tmpFile, '# comment\n\nDB=cred/field\n  # another comment\n');
      const mappings = parseAuraFile(tmpFile);
      expect(mappings).toHaveLength(1);
      unlinkSync(tmpFile);
    });

    it('throws on invalid lines', () => {
      writeFileSync(tmpFile, 'NOEQUALSSIGN\n');
      expect(() => parseAuraFile(tmpFile)).toThrow("missing '='");
      unlinkSync(tmpFile);
    });

    it('handles nested agent/credential/field paths', () => {
      writeFileSync(tmpFile, 'CERT=@prod/tls-cert/private/key\n');
      const mappings = parseAuraFile(tmpFile);
      expect(mappings[0]).toEqual({
        envVar: 'CERT',
        agent: 'prod',
        credentialName: 'tls-cert',
        field: 'private/key',
      });
      unlinkSync(tmpFile);
    });

    it('throws on invalid agent reference with too few parts', () => {
      writeFileSync(tmpFile, 'FOO=@agent/only\n');
      expect(() => parseAuraFile(tmpFile)).toThrow('Invalid agent reference');
      unlinkSync(tmpFile);
    });

    it('throws on invalid reference with no field', () => {
      writeFileSync(tmpFile, 'FOO=credonly\n');
      expect(() => parseAuraFile(tmpFile)).toThrow('Invalid reference');
      unlinkSync(tmpFile);
    });

    it('rejects invalid env var names (audit finding #6)', () => {
      writeFileSync(tmpFile, '123BAD=cred/field\n');
      expect(() => parseAuraFile(tmpFile)).toThrow('Invalid env var name');
      unlinkSync(tmpFile);
    });

    it('rejects env var names with special characters', () => {
      writeFileSync(tmpFile, 'FOO-BAR=cred/field\n');
      expect(() => parseAuraFile(tmpFile)).toThrow('Invalid env var name');
      unlinkSync(tmpFile);
    });
  });
});
