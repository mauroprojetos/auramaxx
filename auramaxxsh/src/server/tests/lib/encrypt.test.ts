import { describe, it, expect } from 'vitest';
import {
  decryptPrivateKey,
  decryptWithSeed,
  encryptPrivateKey,
  encryptWithSeed,
} from '../../lib/encrypt';

describe('encrypt.ts', () => {
  it('roundtrips private key encryption with password', () => {
    const payload = 'seed words go here';
    const encrypted = encryptPrivateKey(payload, 'test-password-123');

    expect(encrypted.salt.length).toBe(64);
    expect(encrypted.iv.length).toBe(24); // 12-byte GCM IV in hex
    expect(encrypted.mac.length).toBe(32); // 16-byte GCM tag in hex

    const decrypted = decryptPrivateKey(encrypted, 'test-password-123');
    expect(decrypted).toBe(payload);
  });

  it('rejects private key decryption with wrong password', () => {
    const encrypted = encryptPrivateKey('secret', 'right-password');
    expect(() => decryptPrivateKey(encrypted, 'wrong-password')).toThrow('Invalid password or corrupted data');
  });

  it('roundtrips seed-based encryption', () => {
    const payload = JSON.stringify({ token: 'abc123', kind: 'api' });
    const encrypted = encryptWithSeed(payload, 'seed phrase');

    expect(encrypted.salt).toBe('');
    expect(encrypted.iv.length).toBe(24); // 12-byte GCM IV in hex
    expect(encrypted.mac.length).toBe(32); // 16-byte GCM tag in hex

    const decrypted = decryptWithSeed(encrypted, 'seed phrase');
    expect(decrypted).toBe(payload);
  });

  it('rejects seed-based decryption with wrong seed', () => {
    const encrypted = encryptWithSeed('secret', 'correct-seed');
    expect(() => decryptWithSeed(encrypted, 'wrong-seed')).toThrow('Invalid seed or corrupted data');
  });
});
