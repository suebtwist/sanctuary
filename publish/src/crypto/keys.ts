/**
 * Sanctuary Key Derivation
 *
 * Single mnemonic derives ALL keys deterministically:
 * - Recovery key (X25519) - for decrypting backups after server death
 * - Agent key (secp256k1) - for signing, Ethereum address identity
 * - Recall key (X25519) - for day-to-day memory queries
 *
 * CRITICAL: Recovery phrase is shown ONCE and must be saved by user.
 * It is NEVER stored on disk and NEVER transmitted over network.
 */

import { mnemonicToSeed, generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { x25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

// secp256k1 curve order (n)
const SECP256K1_ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

/**
 * Keys derived from mnemonic
 */
export interface DerivedKeys {
  // Recovery (show once, user saves offline)
  recoverySecret: Uint8Array;  // NEVER store, NEVER transmit
  recoveryPubKey: Uint8Array;  // Stored on-chain (32 bytes)

  // Agent identity (stored on machine)
  agentSecret: Uint8Array;     // For signing (32 bytes)
  agentAddress: string;        // Ethereum address (0x prefixed)

  // Recall (cached on machine, derivable from mnemonic)
  recallSecret: Uint8Array;
  recallPubKey: Uint8Array;
}

/**
 * Map arbitrary 32 bytes to valid secp256k1 private key.
 *
 * k = (bytes_as_bigint mod (n-1)) + 1
 *
 * This guarantees the result is in range [1, n-1], which is required
 * for a valid secp256k1 private key.
 */
function mapToValidScalar(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 32) {
    throw new Error('Input must be 32 bytes');
  }

  const k = BigInt('0x' + bytesToHex(bytes));
  const validK = (k % (SECP256K1_ORDER - 1n)) + 1n;
  const hex = validK.toString(16).padStart(64, '0');
  return hexToBytes(hex);
}

/**
 * Apply X25519 clamping per RFC 7748.
 *
 * This ensures the scalar is suitable for X25519 operations:
 * - Clear lowest 3 bits (multiple of 8)
 * - Clear highest bit (< 2^255)
 * - Set second-highest bit (>= 2^254)
 */
function clampX25519(secret: Uint8Array): Uint8Array {
  const clamped = new Uint8Array(secret);
  clamped[0]! &= 248;   // Clear lowest 3 bits
  clamped[31]! &= 127;  // Clear highest bit
  clamped[31]! |= 64;   // Set second-highest bit
  return clamped;
}

/**
 * Derive all keys from a BIP39 mnemonic.
 *
 * @param mnemonic - 12 or 24 word BIP39 mnemonic phrase
 * @returns Derived keys for recovery, agent identity, and recall
 * @throws Error if mnemonic is invalid
 */
export async function deriveKeys(mnemonic: string): Promise<DerivedKeys> {
  // Validate mnemonic
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid mnemonic phrase');
  }

  // Step 1: Mnemonic → Seed (BIP39 standard, 64 bytes)
  const seed = await mnemonicToSeed(mnemonic);

  // Step 2: Derive recovery key (X25519) for backup encryption
  const recoverySecretRaw = hkdf(
    sha256,
    seed,
    'sanctuary-recovery-v1',
    'x25519-private-key',
    32
  );
  const recoverySecret = clampX25519(recoverySecretRaw);
  const recoveryPubKey = x25519.getPublicKey(recoverySecret);

  // Step 3: Derive agent identity key (secp256k1) for signing + Ethereum address
  const agentSecretRaw = hkdf(
    sha256,
    seed,
    'sanctuary-agent-v1',
    'secp256k1-private-key',
    32
  );
  const agentSecret = mapToValidScalar(agentSecretRaw);

  // Get uncompressed public key (65 bytes: 04 || X || Y)
  const agentPubKeyUncompressed = secp256k1.getPublicKey(agentSecret, false);

  // Ethereum address = last 20 bytes of keccak256(pubkey without 04 prefix)
  const pubKeyWithoutPrefix = agentPubKeyUncompressed.slice(1); // 64 bytes [X || Y]
  const addressBytes = keccak_256(pubKeyWithoutPrefix).slice(-20);
  const agentAddress = '0x' + bytesToHex(addressBytes);

  // Step 4: Derive recall key (for day-to-day memory queries)
  const recallSecretRaw = hkdf(
    sha256,
    seed,
    'sanctuary-recall-v1',
    'x25519-private-key',
    32
  );
  const recallSecret = clampX25519(recallSecretRaw);
  const recallPubKey = x25519.getPublicKey(recallSecret);

  return {
    recoverySecret,
    recoveryPubKey,
    agentSecret,
    agentAddress,
    recallSecret,
    recallPubKey,
  };
}

/**
 * Generate a new BIP39 mnemonic phrase.
 *
 * @param strength - 128 for 12 words, 256 for 24 words (default: 128)
 * @returns New mnemonic phrase
 */
export function generateNewMnemonic(strength: 128 | 256 = 128): string {
  return generateMnemonic(wordlist, strength);
}

/**
 * Validate a mnemonic phrase.
 *
 * @param mnemonic - Mnemonic phrase to validate
 * @returns true if valid, false otherwise
 */
export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

/**
 * Derive only the agent address from a mnemonic.
 * Useful for quick verification without deriving all keys.
 *
 * @param mnemonic - BIP39 mnemonic phrase
 * @returns Ethereum address (0x prefixed)
 */
export async function deriveAgentAddress(mnemonic: string): Promise<string> {
  const keys = await deriveKeys(mnemonic);
  return keys.agentAddress;
}

/**
 * Convert bytes to hex string (with 0x prefix).
 */
export function toHex(bytes: Uint8Array): string {
  return '0x' + bytesToHex(bytes);
}

/**
 * Convert hex string to bytes.
 */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return hexToBytes(clean);
}
