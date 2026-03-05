/**
 * Tests for Solana wallet derivation and encrypt/decrypt roundtrip
 *
 * Tests:
 * - SLIP-0010 keypair derivation from mnemonic
 * - Cold keypair derivation (index 0)
 * - Different indices produce different keypairs
 * - Encrypt/decrypt roundtrip for Solana secret keys
 */
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import * as bip39 from 'bip39';
import { deriveSolanaKeypair, deriveSolanaColdKeypair } from '../../lib/solana/wallet';
import { encryptWithSeed, decryptWithSeed } from '../../lib/encrypt';

// Fixed test mnemonic (DO NOT use in production)
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('Solana Wallet Derivation', () => {
  describe('deriveSolanaKeypair()', () => {
    it('should derive a valid Solana keypair from mnemonic', () => {
      const keypair = deriveSolanaKeypair(TEST_MNEMONIC, 0);

      expect(keypair).toBeInstanceOf(Keypair);
      expect(keypair.publicKey).toBeDefined();
      expect(keypair.secretKey).toHaveLength(64); // Ed25519 secret key is 64 bytes
    });

    it('should produce a valid base58 public key', () => {
      const keypair = deriveSolanaKeypair(TEST_MNEMONIC, 0);
      const address = keypair.publicKey.toBase58();

      // Solana addresses are base58-encoded, typically 32-44 chars
      expect(address.length).toBeGreaterThanOrEqual(32);
      expect(address.length).toBeLessThanOrEqual(44);
      // Should NOT start with 0x (that's EVM)
      expect(address.startsWith('0x')).toBe(false);
    });

    it('should produce deterministic results', () => {
      const keypair1 = deriveSolanaKeypair(TEST_MNEMONIC, 0);
      const keypair2 = deriveSolanaKeypair(TEST_MNEMONIC, 0);

      expect(keypair1.publicKey.toBase58()).toBe(keypair2.publicKey.toBase58());
      expect(Buffer.from(keypair1.secretKey).toString('hex'))
        .toBe(Buffer.from(keypair2.secretKey).toString('hex'));
    });

    it('should derive different keypairs for different indices', () => {
      const keypair0 = deriveSolanaKeypair(TEST_MNEMONIC, 0);
      const keypair1 = deriveSolanaKeypair(TEST_MNEMONIC, 1);
      const keypair2 = deriveSolanaKeypair(TEST_MNEMONIC, 2);

      expect(keypair0.publicKey.toBase58()).not.toBe(keypair1.publicKey.toBase58());
      expect(keypair1.publicKey.toBase58()).not.toBe(keypair2.publicKey.toBase58());
      expect(keypair0.publicKey.toBase58()).not.toBe(keypair2.publicKey.toBase58());
    });

    it('should derive different keypairs for different mnemonics', () => {
      const mnemonic2 = bip39.generateMnemonic();
      const keypair1 = deriveSolanaKeypair(TEST_MNEMONIC, 0);
      const keypair2 = deriveSolanaKeypair(mnemonic2, 0);

      expect(keypair1.publicKey.toBase58()).not.toBe(keypair2.publicKey.toBase58());
    });
  });

  describe('deriveSolanaColdKeypair()', () => {
    it('should derive the same keypair as index 0', () => {
      const coldKeypair = deriveSolanaColdKeypair(TEST_MNEMONIC);
      const index0Keypair = deriveSolanaKeypair(TEST_MNEMONIC, 0);

      expect(coldKeypair.publicKey.toBase58()).toBe(index0Keypair.publicKey.toBase58());
    });

    it('should return a valid Keypair', () => {
      const coldKeypair = deriveSolanaColdKeypair(TEST_MNEMONIC);

      expect(coldKeypair).toBeInstanceOf(Keypair);
      expect(coldKeypair.secretKey).toHaveLength(64);
    });
  });

  describe('Encrypt/Decrypt Roundtrip', () => {
    it('should encrypt and decrypt a Solana secret key', () => {
      const keypair = deriveSolanaKeypair(TEST_MNEMONIC, 0);
      const secretKeyHex = Buffer.from(keypair.secretKey).toString('hex');

      // Encrypt
      const encrypted = encryptWithSeed(secretKeyHex, TEST_MNEMONIC);
      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.mac).toBeDefined();

      // Decrypt
      const decrypted = decryptWithSeed(encrypted, TEST_MNEMONIC);
      expect(decrypted).toBe(secretKeyHex);

      // Verify the decrypted key produces the same keypair
      const recoveredKey = Uint8Array.from(Buffer.from(decrypted, 'hex'));
      const recoveredKeypair = Keypair.fromSecretKey(recoveredKey);
      expect(recoveredKeypair.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
    });

    it('should reject decryption with wrong seed', () => {
      const keypair = deriveSolanaKeypair(TEST_MNEMONIC, 0);
      const secretKeyHex = Buffer.from(keypair.secretKey).toString('hex');

      const encrypted = encryptWithSeed(secretKeyHex, TEST_MNEMONIC);

      expect(() => {
        decryptWithSeed(encrypted, 'wrong seed phrase here');
      }).toThrow('Invalid seed or corrupted data');
    });

    it('should produce different ciphertext each time (random IV)', () => {
      const keypair = deriveSolanaKeypair(TEST_MNEMONIC, 0);
      const secretKeyHex = Buffer.from(keypair.secretKey).toString('hex');

      const encrypted1 = encryptWithSeed(secretKeyHex, TEST_MNEMONIC);
      const encrypted2 = encryptWithSeed(secretKeyHex, TEST_MNEMONIC);

      // Different IVs → different ciphertext
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);

      // But both decrypt to the same value
      expect(decryptWithSeed(encrypted1, TEST_MNEMONIC)).toBe(secretKeyHex);
      expect(decryptWithSeed(encrypted2, TEST_MNEMONIC)).toBe(secretKeyHex);
    });

    it('should roundtrip a randomly generated Solana keypair', () => {
      const keypair = Keypair.generate();
      const secretKeyHex = Buffer.from(keypair.secretKey).toString('hex');

      const encrypted = encryptWithSeed(secretKeyHex, TEST_MNEMONIC);
      const decrypted = decryptWithSeed(encrypted, TEST_MNEMONIC);

      const recovered = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(decrypted, 'hex')));
      expect(recovered.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
    });
  });
});
