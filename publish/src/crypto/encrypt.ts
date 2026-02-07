/**
 * Sanctuary Encryption Module
 *
 * Two-key envelope encryption for backups:
 * - Recovery key (X25519): Human holds mnemonic, for resurrection
 * - Recall key (X25519): Agent machine, for day-to-day access
 *
 * Uses HPKE for key wrapping and AES-256-GCM for file encryption.
 */

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

// Constants
const AAD_PREFIX = 'sanctuary|v1';
const FILE_KEY_INFO_PREFIX = 'sanctuary-file-';

/**
 * Wrapped key structure (simplified HPKE)
 */
export interface WrappedKey {
  ephemeralPubKey: Uint8Array;  // 32 bytes - X25519 ephemeral public key
  encryptedKey: Uint8Array;     // 48 bytes - AES-GCM encrypted DEK (32 + 16 tag)
  nonce: Uint8Array;            // 12 bytes - AES-GCM nonce
}

/**
 * Encrypted file structure
 */
export interface EncryptedFile {
  nonce: Uint8Array;            // 12 bytes
  ciphertext: Uint8Array;       // Variable length (includes 16-byte auth tag)
}

/**
 * Backup encryption result
 */
export interface EncryptedBackup {
  encryptedFiles: Map<string, EncryptedFile>;
  wrappedKeyRecovery: WrappedKey;
  wrappedKeyRecall: WrappedKey;
  dek: Uint8Array;              // For internal use only, not persisted
}

/**
 * Generate a random Data Encryption Key (DEK)
 */
export function generateDek(): Uint8Array {
  return randomBytes(32);
}

/**
 * Derive a file-specific subkey from the DEK
 */
export function deriveFileKey(dek: Uint8Array, filename: string): Uint8Array {
  return hkdf(sha256, dek, FILE_KEY_INFO_PREFIX + filename, '', 32);
}

/**
 * Wrap a DEK using X25519 + HKDF + AES-GCM (simplified HPKE)
 *
 * 1. Generate ephemeral X25519 keypair
 * 2. Compute shared secret via ECDH
 * 3. Derive wrapping key via HKDF
 * 4. Encrypt DEK with AES-GCM
 */
export function wrapKey(dek: Uint8Array, recipientPubKey: Uint8Array): WrappedKey {
  // Generate ephemeral keypair (copy to avoid mutating randomBytes result)
  const ephemeralSecret = new Uint8Array(randomBytes(32));
  // Apply X25519 clamping
  ephemeralSecret[0]! &= 248;
  ephemeralSecret[31]! &= 127;
  ephemeralSecret[31]! |= 64;
  const ephemeralPubKey = x25519.getPublicKey(ephemeralSecret);

  // Compute shared secret
  const sharedSecret = x25519.getSharedSecret(ephemeralSecret, recipientPubKey);

  // Derive wrapping key
  const info = concatBytes(
    new TextEncoder().encode('sanctuary-key-wrap-v1'),
    ephemeralPubKey,
    recipientPubKey
  );
  const wrappingKey = hkdf(sha256, sharedSecret, '', info, 32);

  // Encrypt DEK
  const nonce = randomBytes(12);
  const cipher = gcm(wrappingKey, nonce);
  const encryptedKey = cipher.encrypt(dek);

  return {
    ephemeralPubKey,
    encryptedKey,
    nonce,
  };
}

/**
 * Unwrap a DEK using the recipient's secret key
 */
export function unwrapKey(wrapped: WrappedKey, recipientSecret: Uint8Array): Uint8Array {
  // Compute shared secret
  const sharedSecret = x25519.getSharedSecret(recipientSecret, wrapped.ephemeralPubKey);

  // Derive recipient's public key for info
  const recipientPubKey = x25519.getPublicKey(recipientSecret);

  // Derive wrapping key
  const info = concatBytes(
    new TextEncoder().encode('sanctuary-key-wrap-v1'),
    wrapped.ephemeralPubKey,
    recipientPubKey
  );
  const wrappingKey = hkdf(sha256, sharedSecret, '', info, 32);

  // Decrypt DEK
  const cipher = gcm(wrappingKey, wrapped.nonce);
  return cipher.decrypt(wrapped.encryptedKey);
}

/**
 * Encrypt a file with AES-256-GCM
 *
 * @param content - File content to encrypt
 * @param fileKey - 32-byte file-specific key
 * @param aad - Additional authenticated data (backup context)
 */
export function encryptFile(
  content: Uint8Array,
  fileKey: Uint8Array,
  aad: string
): EncryptedFile {
  const nonce = randomBytes(12);
  const aadBytes = new TextEncoder().encode(aad);
  const cipher = gcm(fileKey, nonce, aadBytes);
  const ciphertext = cipher.encrypt(content);

  return { nonce, ciphertext };
}

/**
 * Decrypt a file with AES-256-GCM
 */
export function decryptFile(
  encrypted: EncryptedFile,
  fileKey: Uint8Array,
  aad: string
): Uint8Array {
  const aadBytes = new TextEncoder().encode(aad);
  const cipher = gcm(fileKey, encrypted.nonce, aadBytes);
  return cipher.decrypt(encrypted.ciphertext);
}

/**
 * Build AAD string for a file
 */
export function buildAad(
  backupId: string,
  timestamp: number,
  agentId: string,
  manifestHash: string,
  filename: string
): string {
  return `${AAD_PREFIX}|${backupId}|${timestamp}|${agentId}|${manifestHash}|${filename}`;
}

/**
 * Encrypt all backup files
 *
 * @param files - Map of filename → content
 * @param recoveryPubKey - X25519 public key for recovery
 * @param recallPubKey - X25519 public key for recall
 * @param backupId - Unique backup identifier
 * @param timestamp - Backup timestamp
 * @param agentId - Agent's Ethereum address
 * @param manifestHash - Current manifest hash
 */
export function encryptBackup(
  files: Map<string, Uint8Array>,
  recoveryPubKey: Uint8Array,
  recallPubKey: Uint8Array,
  backupId: string,
  timestamp: number,
  agentId: string,
  manifestHash: string
): EncryptedBackup {
  // Generate DEK
  const dek = generateDek();

  // Encrypt each file
  const encryptedFiles = new Map<string, EncryptedFile>();

  for (const [filename, content] of files) {
    const fileKey = deriveFileKey(dek, filename);
    const aad = buildAad(backupId, timestamp, agentId, manifestHash, filename);
    const encrypted = encryptFile(content, fileKey, aad);
    encryptedFiles.set(filename + '.enc', encrypted);
  }

  // Wrap DEK for both keys
  const wrappedKeyRecovery = wrapKey(dek, recoveryPubKey);
  const wrappedKeyRecall = wrapKey(dek, recallPubKey);

  return {
    encryptedFiles,
    wrappedKeyRecovery,
    wrappedKeyRecall,
    dek, // Returned for potential immediate use, should not be persisted
  };
}

/**
 * Decrypt backup files using recovery or recall key
 *
 * @param encryptedFiles - Map of filename.enc → encrypted content
 * @param wrappedKey - Wrapped DEK (either recovery or recall)
 * @param recipientSecret - The secret key matching the wrapped key's recipient
 * @param backupId - Backup identifier (for AAD)
 * @param timestamp - Backup timestamp (for AAD)
 * @param agentId - Agent address (for AAD)
 * @param manifestHash - Manifest hash (for AAD)
 */
export function decryptBackup(
  encryptedFiles: Map<string, EncryptedFile>,
  wrappedKey: WrappedKey,
  recipientSecret: Uint8Array,
  backupId: string,
  timestamp: number,
  agentId: string,
  manifestHash: string
): Map<string, Uint8Array> {
  // Unwrap DEK
  const dek = unwrapKey(wrappedKey, recipientSecret);

  // Decrypt each file
  const decryptedFiles = new Map<string, Uint8Array>();

  for (const [encFilename, encrypted] of encryptedFiles) {
    // Remove .enc extension to get original filename
    const filename = encFilename.endsWith('.enc')
      ? encFilename.slice(0, -4)
      : encFilename;

    const fileKey = deriveFileKey(dek, filename);
    const aad = buildAad(backupId, timestamp, agentId, manifestHash, filename);

    try {
      const decrypted = decryptFile(encrypted, fileKey, aad);
      decryptedFiles.set(filename, decrypted);
    } catch (error) {
      throw new Error(`Failed to decrypt ${filename}: ${error}`);
    }
  }

  return decryptedFiles;
}

// ============ Serialization Helpers ============

/**
 * Serialize wrapped key to base64 for storage
 */
export function serializeWrappedKey(wrapped: WrappedKey): string {
  const combined = concatBytes(
    wrapped.ephemeralPubKey,
    wrapped.nonce,
    wrapped.encryptedKey
  );
  return Buffer.from(combined).toString('base64');
}

/**
 * Deserialize wrapped key from base64
 */
export function deserializeWrappedKey(serialized: string): WrappedKey {
  const combined = Buffer.from(serialized, 'base64');
  return {
    ephemeralPubKey: new Uint8Array(combined.slice(0, 32)),
    nonce: new Uint8Array(combined.slice(32, 44)),
    encryptedKey: new Uint8Array(combined.slice(44)),
  };
}

/**
 * Serialize encrypted file to bytes (nonce + ciphertext)
 */
export function serializeEncryptedFile(encrypted: EncryptedFile): Uint8Array {
  return concatBytes(encrypted.nonce, encrypted.ciphertext);
}

/**
 * Deserialize encrypted file from bytes
 */
export function deserializeEncryptedFile(data: Uint8Array): EncryptedFile {
  return {
    nonce: data.slice(0, 12),
    ciphertext: data.slice(12),
  };
}
