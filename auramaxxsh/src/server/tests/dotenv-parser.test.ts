import { describe, it, expect } from 'vitest';
import { parseDotenv, groupByPrefix, noGrouping, generateAuraFile } from '../cli/lib/dotenv-parser';

describe('parseDotenv', () => {
  it('parses simple key=value pairs', () => {
    const result = parseDotenv('FOO=bar\nBAZ=qux');
    expect(result.get('FOO')).toBe('bar');
    expect(result.get('BAZ')).toBe('qux');
  });

  it('handles comments and blank lines', () => {
    const result = parseDotenv('# comment\n\nFOO=bar\n  # another comment\nBAZ=qux');
    expect(result.size).toBe(2);
  });

  it('handles double-quoted values with escapes', () => {
    const result = parseDotenv('FOO="hello\\nworld"\nBAR="has \\"quotes\\""');
    expect(result.get('FOO')).toBe('hello\nworld');
    expect(result.get('BAR')).toBe('has "quotes"');
  });

  it('handles single-quoted values literally', () => {
    const result = parseDotenv("FOO='hello\\nworld'");
    expect(result.get('FOO')).toBe('hello\\nworld');
  });

  it('strips export prefix', () => {
    const result = parseDotenv('export FOO=bar\nexport BAZ=qux');
    expect(result.get('FOO')).toBe('bar');
    expect(result.get('BAZ')).toBe('qux');
  });

  it('strips inline comments on unquoted values', () => {
    const result = parseDotenv('FOO=bar # this is a comment');
    expect(result.get('FOO')).toBe('bar');
  });

  it('preserves # in quoted values', () => {
    const result = parseDotenv('FOO="bar # not a comment"');
    expect(result.get('FOO')).toBe('bar # not a comment');
  });

  it('handles empty values', () => {
    const result = parseDotenv('FOO=\nBAR=""');
    expect(result.get('FOO')).toBe('');
    expect(result.get('BAR')).toBe('');
  });

  it('handles values with = signs', () => {
    const result = parseDotenv('DATABASE_URL=postgres://user:pass@host/db?ssl=true');
    expect(result.get('DATABASE_URL')).toBe('postgres://user:pass@host/db?ssl=true');
  });

  it('skips invalid env var names (audit finding #6)', () => {
    const result = parseDotenv('VALID=ok\n123-BAD=nope\nALSO_VALID=yes');
    expect(result.size).toBe(2);
    expect(result.has('VALID')).toBe(true);
    expect(result.has('ALSO_VALID')).toBe(true);
    expect(result.has('123-BAD')).toBe(false);
  });
});

describe('groupByPrefix', () => {
  it('groups vars with common prefix', () => {
    const vars = new Map([
      ['STRIPE_SECRET_KEY', 'sk_xxx'],
      ['STRIPE_PUBLISHABLE_KEY', 'pk_xxx'],
    ]);
    const groups = groupByPrefix(vars);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('stripe');
    expect(groups[0].fields).toHaveLength(2);
    expect(groups[0].fields.find(f => f.key === 'secret_key')?.value).toBe('sk_xxx');
  });

  it('keeps single vars as individual credentials', () => {
    const vars = new Map([['DATABASE_URL', 'postgres://...']]);
    const groups = groupByPrefix(vars);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('database_url');
    expect(groups[0].fields[0].key).toBe('value');
  });

  it('handles vars without underscore', () => {
    const vars = new Map([['PORT', '3000']]);
    const groups = groupByPrefix(vars);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('port');
    expect(groups[0].fields[0].key).toBe('value');
  });
});

describe('noGrouping', () => {
  it('creates one credential per var', () => {
    const vars = new Map([
      ['STRIPE_SECRET_KEY', 'sk_xxx'],
      ['STRIPE_PUBLISHABLE_KEY', 'pk_xxx'],
    ]);
    const groups = noGrouping(vars);
    expect(groups).toHaveLength(2);
    expect(groups.every(g => g.fields.length === 1 && g.fields[0].key === 'value')).toBe(true);
  });
});

describe('generateAuraFile', () => {
  it('generates valid .aura content', () => {
    const groups = [
      { name: 'stripe', fields: [
        { key: 'secret_key', value: 'sk_xxx', envVar: 'STRIPE_SECRET_KEY' },
        { key: 'publishable_key', value: 'pk_xxx', envVar: 'STRIPE_PUBLISHABLE_KEY' },
      ]},
      { name: 'database_url', fields: [
        { key: 'value', value: 'postgres://...', envVar: 'DATABASE_URL' },
      ]},
    ];
    const content = generateAuraFile(groups);
    expect(content).toContain('STRIPE_SECRET_KEY=stripe/secret_key');
    expect(content).toContain('STRIPE_PUBLISHABLE_KEY=stripe/publishable_key');
    expect(content).toContain('DATABASE_URL=database_url/value');
  });
});
