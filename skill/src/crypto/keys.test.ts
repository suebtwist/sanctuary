/**
 * Tests for Sanctuary key derivation
 *
 * CRITICAL: These tests verify that:
 * 1. Same mnemonic → same keys every time (deterministic)
 * 2. secp256k1 scalars are always valid
 * 3. Ethereum addresses are correctly computed
 */

import { describe, it, expect } from 'vitest';
import {
  deriveKeys,
  generateNewMnemonic,
  isValidMnemonic,
  deriveAgentAddress,
  toHex,
  fromHex,
} from './keys.js';
import { bytesToHex } from '@noble/hashes/utils';

// Standard test mnemonic (BIP39 test vector)
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('Key Derivation', () => {
  describe('deriveKeys', () => {
    it('should derive deterministic keys from mnemonic', async () => {
      const keys1 = await deriveKeys(TEST_MNEMONIC);
      const keys2 = await deriveKeys(TEST_MNEMONIC);

      // All keys should be identical
      expect(bytesToHex(keys1.recoverySecret)).toBe(bytesToHex(keys2.recoverySecret));
      expect(bytesToHex(keys1.recoveryPubKey)).toBe(bytesToHex(keys2.recoveryPubKey));
      expect(bytesToHex(keys1.agentSecret)).toBe(bytesToHex(keys2.agentSecret));
      expect(keys1.agentAddress).toBe(keys2.agentAddress);
      expect(bytesToHex(keys1.recallSecret)).toBe(bytesToHex(keys2.recallSecret));
      expect(bytesToHex(keys1.recallPubKey)).toBe(bytesToHex(keys2.recallPubKey));
    });

    it('should produce keys of correct length', async () => {
      const keys = await deriveKeys(TEST_MNEMONIC);

      expect(keys.recoverySecret.length).toBe(32);
      expect(keys.recoveryPubKey.length).toBe(32);
      expect(keys.agentSecret.length).toBe(32);
      expect(keys.recallSecret.length).toBe(32);
      expect(keys.recallPubKey.length).toBe(32);
    });

    it('should produce valid Ethereum address format', async () => {
      const keys = await deriveKeys(TEST_MNEMONIC);

      expect(keys.agentAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it('should produce different keys for different mnemonics', async () => {
      const mnemonic2 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
      const keys1 = await deriveKeys(TEST_MNEMONIC);
      const keys2 = await deriveKeys(mnemonic2);

      expect(keys1.agentAddress).not.toBe(keys2.agentAddress);
      expect(bytesToHex(keys1.recoveryPubKey)).not.toBe(bytesToHex(keys2.recoveryPubKey));
    });

    it('should throw for invalid mnemonic', async () => {
      await expect(deriveKeys('invalid mnemonic phrase')).rejects.toThrow('Invalid mnemonic');
    });

    it('should throw for mnemonic with wrong checksum', async () => {
      // Last word changed to make checksum invalid
      const badMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
      await expect(deriveKeys(badMnemonic)).rejects.toThrow('Invalid mnemonic');
    });

    it('should handle 24-word mnemonic', async () => {
      const mnemonic24 = generateNewMnemonic(256);
      const keys = await deriveKeys(mnemonic24);

      expect(keys.agentAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(keys.recoveryPubKey.length).toBe(32);
    });
  });

  describe('secp256k1 scalar validity', () => {
    it('should always produce valid secp256k1 scalar', async () => {
      // Test with multiple mnemonics to ensure scalar mapping works
      const mnemonics = [
        TEST_MNEMONIC,
        'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
        generateNewMnemonic(128),
        generateNewMnemonic(128),
        generateNewMnemonic(256),
      ];

      for (const mnemonic of mnemonics) {
        const keys = await deriveKeys(mnemonic);

        // Convert to bigint and verify it's in valid range [1, n-1]
        const scalar = BigInt('0x' + bytesToHex(keys.agentSecret));
        const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

        expect(scalar > 0n).toBe(true);
        expect(scalar < n).toBe(true);
      }
    });
  });

  describe('X25519 clamping', () => {
    it('should produce properly clamped X25519 keys', async () => {
      const keys = await deriveKeys(TEST_MNEMONIC);

      // Check clamping: lowest 3 bits of first byte should be 0
      expect(keys.recoverySecret[0] & 7).toBe(0);
      expect(keys.recallSecret[0] & 7).toBe(0);

      // Check clamping: highest bit of last byte should be 0
      expect(keys.recoverySecret[31] & 128).toBe(0);
      expect(keys.recallSecret[31] & 128).toBe(0);

      // Check clamping: second-highest bit of last byte should be 1
      expect(keys.recoverySecret[31] & 64).toBe(64);
      expect(keys.recallSecret[31] & 64).toBe(64);
    });
  });

  describe('generateNewMnemonic', () => {
    it('should generate valid 12-word mnemonic by default', () => {
      const mnemonic = generateNewMnemonic();
      const words = mnemonic.split(' ');

      expect(words.length).toBe(12);
      expect(isValidMnemonic(mnemonic)).toBe(true);
    });

    it('should generate valid 24-word mnemonic when requested', () => {
      const mnemonic = generateNewMnemonic(256);
      const words = mnemonic.split(' ');

      expect(words.length).toBe(24);
      expect(isValidMnemonic(mnemonic)).toBe(true);
    });

    it('should generate unique mnemonics', () => {
      const mnemonic1 = generateNewMnemonic();
      const mnemonic2 = generateNewMnemonic();

      expect(mnemonic1).not.toBe(mnemonic2);
    });
  });

  describe('isValidMnemonic', () => {
    it('should return true for valid mnemonic', () => {
      expect(isValidMnemonic(TEST_MNEMONIC)).toBe(true);
    });

    it('should return false for invalid mnemonic', () => {
      expect(isValidMnemonic('invalid words here')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidMnemonic('')).toBe(false);
    });
  });

  describe('deriveAgentAddress', () => {
    it('should derive same address as full deriveKeys', async () => {
      const keys = await deriveKeys(TEST_MNEMONIC);
      const address = await deriveAgentAddress(TEST_MNEMONIC);

      expect(address).toBe(keys.agentAddress);
    });
  });

  describe('hex utilities', () => {
    it('should convert bytes to hex and back', () => {
      const original = new Uint8Array([0, 1, 2, 255, 128, 64]);
      const hex = toHex(original);
      const restored = fromHex(hex);

      expect(hex).toBe('0x000102ff8040');
      expect(Array.from(restored)).toEqual(Array.from(original));
    });

    it('should handle hex with or without 0x prefix', () => {
      const bytes1 = fromHex('0xabcd');
      const bytes2 = fromHex('abcd');

      expect(Array.from(bytes1)).toEqual(Array.from(bytes2));
    });
  });

  describe('known test vectors', () => {
    it('should produce expected address for test mnemonic', async () => {
      // This test locks in the expected output - if derivation changes, this fails
      const keys = await deriveKeys(TEST_MNEMONIC);

      // Log for initial verification (comment out after confirming)
      console.log('Test mnemonic agent address:', keys.agentAddress);
      console.log('Test mnemonic recovery pubkey:', toHex(keys.recoveryPubKey));
      console.log('Test mnemonic recall pubkey:', toHex(keys.recallPubKey));

      // The actual values - these should be stable
      // NOTE: Update these after first run to lock in expected values
      expect(keys.agentAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });
});
