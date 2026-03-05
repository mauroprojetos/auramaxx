import { describe, expect, it } from 'vitest';
import { buildSecretGistDraft } from '../../lib/secret-gist-share';

describe('secret gist payload formatting', () => {
  it('builds AURAMAXX.SH plaintext payload with credential fields', () => {
    const draft = buildSecretGistDraft({
      credentialId: 'cred-123',
      credentialName: 'Prod API Key',
      credentialType: 'login',
      shareUrl: 'https://example.com/share/token-abc',
      accessMode: 'anyone',
      oneTimeOnly: false,
      expiresAfter: '24h',
      fields: [
        { key: 'username', value: 'example-user', sensitive: false },
        { key: 'password', value: 'hunter2', sensitive: true },
        { key: 'tags', value: 'abc,cbs', sensitive: false },
        { key: 'system', value: 'true', sensitive: false },
      ],
    });

    expect(draft.title).toBe('AURAMAXX.SH');
    expect(draft.filename).toBe('auramaxx-sh-prod-api-key.txt');
    expect(draft.marker).toBe('');
    expect(draft.identifier).toBe('');
    expect(draft.content).toContain('AURAMAXX.SH');
    expect(draft.content).toContain('NAME: Prod API Key');
    expect(draft.content).toContain('VALUE: hunter2');
    expect(draft.content).toContain('\n\nUSERNAME: example-user');
    expect(draft.content).toContain('TAGS: abc,cbs');
    expect(draft.content).toContain('SYSTEM: true');
    expect(draft.content).not.toContain('PASSWORD: hunter2');
    expect(draft.content).not.toContain('SHARE_URL:');
  });

  it('is deterministic for the same share input', () => {
    const input = {
      credentialId: 'cred-xyz',
      credentialName: 'Shared Login',
      credentialType: 'login',
      shareUrl: 'https://example.com/share/token-xyz',
      accessMode: 'password' as const,
      oneTimeOnly: true,
      expiresAfter: '1h',
      fields: [
        { key: 'username', value: 'alice', sensitive: false },
        { key: 'password', value: 's3cr3t', sensitive: true },
      ],
    };

    const first = buildSecretGistDraft(input);
    const second = buildSecretGistDraft(input);
    expect(first.marker).toBe('');
    expect(first.identifier).toBe('');
    expect(first.content).toBe(second.content);
    expect(first.title).toBe(second.title);
  });
});
