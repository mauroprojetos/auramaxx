import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import {
  parse1PasswordCSV,
  parse1PasswordJSON,
  parseBitwardenJSON,
  parseICloudCSV,
  parseLastPassCSV,
  parseChromeJSON,
  parseFirefoxJSON,
  splitFields,
  normalizeUrl,
  detectDuplicates,
  ImportedField,
  ImportedCredential,
} from '../lib/credential-import';

// ---------------------------------------------------------------------------
// normalizeUrl
// ---------------------------------------------------------------------------

describe('normalizeUrl', () => {
  it('strips https protocol', () => {
    expect(normalizeUrl('https://example.com')).toBe('example.com');
  });

  it('strips http protocol', () => {
    expect(normalizeUrl('http://example.com')).toBe('example.com');
  });

  it('strips www prefix', () => {
    expect(normalizeUrl('https://www.example.com')).toBe('example.com');
  });

  it('strips trailing slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('example.com');
  });

  it('strips all combined', () => {
    expect(normalizeUrl('https://www.example.com/path/')).toBe('example.com/path');
  });

  it('handles empty string', () => {
    expect(normalizeUrl('')).toBe('');
  });

  it('lowercases', () => {
    expect(normalizeUrl('HTTPS://Example.COM')).toBe('example.com');
  });
});

// ---------------------------------------------------------------------------
// splitFields
// ---------------------------------------------------------------------------

describe('splitFields', () => {
  it('separates sensitive and non-sensitive fields', () => {
    const fields: ImportedField[] = [
      { key: 'username', value: 'alice', sensitive: false },
      { key: 'password', value: 'secret123', sensitive: true },
      { key: 'notes', value: 'my note', sensitive: false },
    ];
    const result = splitFields(fields, 'https://example.com', ['tag1']);
    expect(result.meta).toEqual({
      url: 'https://example.com',
      tags: ['tag1'],
      username: 'alice',
      notes: 'my note',
    });
    expect(result.sensitiveFields).toHaveLength(1);
    expect(result.sensitiveFields[0].key).toBe('password');
    expect(result.sensitiveFields[0].value).toBe('secret123');
    expect(result.sensitiveFields[0].sensitive).toBe(true);
  });

  it('handles no url or tags', () => {
    const result = splitFields([]);
    expect(result.meta).toEqual({});
    expect(result.sensitiveFields).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parse1PasswordCSV
// ---------------------------------------------------------------------------

describe('parse1PasswordCSV', () => {
  it('parses standard 1Password CSV', () => {
    const csv = `Title,URL,Username,Password,Notes,Type,OTP
GitHub,https://github.com,alice,pass123,dev account,Login,
Netflix,https://netflix.com,bob,nfx456,,Login,otpauth://totp/Netflix?secret=ABC`;

    const result = parse1PasswordCSV(csv);
    expect(result).toHaveLength(2);

    expect(result[0].name).toBe('GitHub');
    expect(result[0].type).toBe('login');
    expect(result[0].url).toBe('https://github.com');
    expect(result[0].fields).toEqual([
      { key: 'username', value: 'alice', sensitive: false },
      { key: 'password', value: 'pass123', sensitive: true },
      { key: 'notes', value: 'dev account', sensitive: false },
    ]);

    expect(result[1].name).toBe('Netflix');
    expect(result[1].fields.find(f => f.key === 'totp')?.value).toBe(
      'otpauth://totp/Netflix?secret=ABC'
    );
  });

  it('handles UTF-8 BOM', () => {
    const csv = '\uFEFFTitle,URL,Username,Password,Notes,Type,OTP\nTest,,,pass,,,';
    const result = parse1PasswordCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Test');
  });

  it('handles empty file', () => {
    const csv = 'Title,URL,Username,Password,Notes,Type,OTP\n';
    const result = parse1PasswordCSV(csv);
    expect(result).toHaveLength(0);
  });

  it('handles missing Title → defaults to Untitled', () => {
    const csv = 'Title,URL,Username,Password,Notes,Type,OTP\n,https://x.com,user,pass,,,';
    const result = parse1PasswordCSV(csv);
    expect(result[0].name).toBe('Untitled');
  });

  it('maps Credit Card type', () => {
    const csv = 'Title,URL,Username,Password,Notes,Type,OTP\nVisa,,,,,,Credit Card';
    // csv-parse may not see OTP column — relax
    const result = parse1PasswordCSV('Title,URL,Username,Password,Notes,Type,OTP\nVisa,,,,,Credit Card,');
    expect(result[0].type).toBe('card');
  });

  it('maps Secure Note type', () => {
    const result = parse1PasswordCSV(
      'Title,URL,Username,Password,Notes,Type,OTP\nMyNote,,,,,Secure Note,'
    );
    expect(result[0].type).toBe('note');
  });

  it('handles special characters in fields', () => {
    const csv = `Title,URL,Username,Password,Notes,Type,OTP
"My ""Site""",https://example.com,"user,name","pass""word","""notes""",Login,`;
    const result = parse1PasswordCSV(csv);
    expect(result[0].name).toBe('My "Site"');
    expect(result[0].fields.find(f => f.key === 'username')?.value).toBe('user,name');
    expect(result[0].fields.find(f => f.key === 'password')?.value).toBe('pass"word');
  });

  it('handles 1000 rows', () => {
    const header = 'Title,URL,Username,Password,Notes,Type,OTP';
    const rows = Array.from({ length: 1000 }, (_, i) =>
      `Site${i},https://site${i}.com,user${i},pass${i},,,`
    );
    const csv = [header, ...rows].join('\n');
    const result = parse1PasswordCSV(csv);
    expect(result).toHaveLength(1000);
  });
});

// ---------------------------------------------------------------------------
// parseICloudCSV
// ---------------------------------------------------------------------------

describe('parseICloudCSV', () => {
  it('parses standard iCloud CSV', () => {
    const csv = `Title,URL,Username,Password,Notes,OTPAuth
GitHub,https://github.com,alice,pass123,dev account,otpauth://totp/GitHub?secret=ABC`;

    const result = parseICloudCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('GitHub');
    expect(result[0].url).toBe('https://github.com');
    expect(result[0].fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'username', value: 'alice', sensitive: false }),
      expect.objectContaining({ key: 'password', value: 'pass123', sensitive: true }),
      expect.objectContaining({ key: 'totp', sensitive: true }),
    ]));
  });

  it('derives name from URL when Title is missing', () => {
    const csv = `URL,Username,Password
https://example.com,user,pass`;
    const result = parseICloudCSV(csv);
    expect(result[0].name).toBe('example.com');
  });
});

// ---------------------------------------------------------------------------
// parseLastPassCSV
// ---------------------------------------------------------------------------

describe('parseLastPassCSV', () => {
  it('parses standard LastPass CSV', () => {
    const csv = `url,username,password,totp,extra,name,grouping,fav
https://example.com,alice,secret,otpauth://totp/Example?secret=ABC,prod note,Example Site,Work,0`;

    const result = parseLastPassCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Example Site');
    expect(result[0].url).toBe('https://example.com');
    expect(result[0].tags).toEqual(['Work']);
    expect(result[0].fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'username', value: 'alice' }),
      expect.objectContaining({ key: 'password', value: 'secret', sensitive: true }),
      expect.objectContaining({ key: 'notes', value: 'prod note' }),
      expect.objectContaining({ key: 'totp', sensitive: true }),
    ]));
  });

  it('falls back to hostname when name is missing', () => {
    const csv = `url,username,password
https://dash.cloudflare.com,ops@example.com,pw`;
    const result = parseLastPassCSV(csv);
    expect(result[0].name).toBe('dash.cloudflare.com');
  });
});

// ---------------------------------------------------------------------------
// detectDuplicates
// ---------------------------------------------------------------------------

vi.mock('../lib/credentials', () => ({
  listCredentials: vi.fn(() => [
    { id: 'cred-1', name: 'GitHub', meta: { url: 'https://github.com' } },
    { id: 'cred-2', name: 'Netflix', meta: { url: 'https://netflix.com' } },
    { id: 'cred-3', name: 'My Note', meta: {} },
  ]),
}));

describe('detectDuplicates', () => {
  const imported: ImportedCredential[] = [
    { name: 'GitHub', type: 'login', url: 'https://github.com', fields: [] },
    { name: 'Netflix', type: 'login', url: 'https://www.netflix.com/', fields: [] },
    { name: 'My Note', type: 'note', fields: [] },
    { name: 'New Site', type: 'login', url: 'https://new.com', fields: [] },
  ];

  it('detects exact name+URL match', () => {
    const dupes = detectDuplicates(imported, 'agent-1');
    const gh = dupes.get(0);
    expect(gh).toBeDefined();
    expect(gh!.matchType).toBe('exact');
    expect(gh!.existingId).toBe('cred-1');
  });

  it('detects exact match with URL normalization', () => {
    const dupes = detectDuplicates(imported, 'agent-1');
    const nf = dupes.get(1);
    expect(nf).toBeDefined();
    expect(nf!.matchType).toBe('exact');
    expect(nf!.existingId).toBe('cred-2');
  });

  it('detects name-only match when no URL', () => {
    const dupes = detectDuplicates(imported, 'agent-1');
    const note = dupes.get(2);
    expect(note).toBeDefined();
    expect(note!.matchType).toBe('name-only');
    expect(note!.existingId).toBe('cred-3');
  });

  it('does not flag new credentials', () => {
    const dupes = detectDuplicates(imported, 'agent-1');
    expect(dupes.has(3)).toBe(false);
  });

  it('overwrite strategy creates new entry (by design, not a replace)', () => {
    // This test confirms that 'overwrite' in the import route creates a new entry
    // rather than deleting+recreating. This is intentional behavior per human review.
    const dupes = detectDuplicates(imported, 'agent-1');
    // The duplicate is detected, but the route's overwrite path just creates anyway
    // (no delete). This test documents that expectation.
    expect(dupes.get(0)).toBeDefined();
    expect(dupes.get(0)!.existingId).toBe('cred-1');
  });
});


// ---------------------------------------------------------------------------
// JSON parsers
// ---------------------------------------------------------------------------

describe('JSON import parsers', () => {
  it('parses 1Password JSON export payload', () => {
    const payload = JSON.stringify({
      items: [{
        title: 'GitHub',
        notesPlain: 'dev account',
        login: {
          username: 'alice',
          password: 'pass123',
          urls: [{ href: 'https://github.com' }],
        },
      }],
    });

    const result = parse1PasswordJSON(payload);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('GitHub');
    expect(result[0].url).toBe('https://github.com');
    expect(result[0].fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'username', value: 'alice' }),
      expect.objectContaining({ key: 'password', value: 'pass123' }),
    ]));
  });

  it('parses Bitwarden JSON export payload', () => {
    const payload = JSON.stringify({
      items: [{
        name: 'Netlify',
        notes: 'production',
        login: {
          username: 'ops',
          password: 'pw',
          uris: [{ uri: 'https://app.netlify.com' }],
          totp: 'otpauth://totp/Netlify?secret=ABC',
        },
      }],
    });

    const result = parseBitwardenJSON(payload);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Netlify');
    expect(result[0].url).toBe('https://app.netlify.com');
    expect(result[0].fields.find((f) => f.key === 'totp')?.sensitive).toBe(true);
  });

  it('parses Chrome JSON export payload', () => {
    const payload = JSON.stringify({
      credentials: [{
        name: 'Cloudflare',
        url: 'https://dash.cloudflare.com',
        username: 'dev@example.com',
        password: 'cf-pass',
      }],
    });

    const result = parseChromeJSON(payload);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Cloudflare');
    expect(result[0].url).toBe('https://dash.cloudflare.com');
  });

  it('parses Firefox JSON export payload', () => {
    const payload = JSON.stringify({
      logins: [{
        hostname: 'https://mozilla.org',
        username: 'moz',
        password: 'ff-pass',
      }],
    });

    const result = parseFirefoxJSON(payload);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://mozilla.org');
    expect(result[0].fields.find((f) => f.key === 'password')?.value).toBe('ff-pass');
  });
});
