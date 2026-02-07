/**
 * Shared Backup Parsing Utilities
 *
 * Extracted from restore.ts and recall.ts to avoid duplication.
 * Handles binary backup deserialization and signature verification.
 */

import {
  deserializeEncryptedFile,
  type EncryptedFile,
} from '../crypto/encrypt.js';
import { recoverAddress, keccak256 } from '../crypto/sign.js';

/**
 * Parse backup binary data into header + encrypted files.
 *
 * Wire format (little-endian):
 *   [4B header_len][header_json][4B file_count]
 *   for each file: [4B name_len][name][4B data_len][data]
 */
export function parseBackupData(data: Uint8Array): {
  header: any;
  encryptedFiles: Map<string, EncryptedFile>;
} {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  const totalLen = data.byteLength;
  let offset = 0;

  function assertBounds(needed: number, label: string): void {
    if (offset + needed > totalLen) {
      throw new Error(`Backup corrupted: ${label} requires ${needed} bytes at offset ${offset}, but only ${totalLen - offset} remain`);
    }
  }

  // Read header length
  assertBounds(4, 'header length');
  const headerLen = view.getUint32(offset, true);
  offset += 4;

  // Read header
  assertBounds(headerLen, 'header data');
  const headerBytes = data.slice(offset, offset + headerLen);
  offset += headerLen;

  let header: any;
  try {
    header = JSON.parse(decoder.decode(headerBytes));
  } catch {
    throw new Error('Backup corrupted: header is not valid JSON');
  }

  // Read file count
  assertBounds(4, 'file count');
  const fileCount = view.getUint32(offset, true);
  offset += 4;

  if (fileCount > 10000) {
    throw new Error(`Backup corrupted: unreasonable file count (${fileCount})`);
  }

  // Read files
  const encryptedFiles = new Map<string, EncryptedFile>();

  for (let i = 0; i < fileCount; i++) {
    // Read name length
    assertBounds(4, `file[${i}] name length`);
    const nameLen = view.getUint32(offset, true);
    offset += 4;

    // Read name
    assertBounds(nameLen, `file[${i}] name`);
    const nameBytes = data.slice(offset, offset + nameLen);
    offset += nameLen;
    const filename = decoder.decode(nameBytes);

    // Read data length
    assertBounds(4, `file[${i}] data length`);
    const dataLen = view.getUint32(offset, true);
    offset += 4;

    // Read data
    assertBounds(dataLen, `file[${i}] data`);
    const fileData = data.slice(offset, offset + dataLen);
    offset += dataLen;

    encryptedFiles.set(filename, deserializeEncryptedFile(fileData));
  }

  return { header, encryptedFiles };
}

/**
 * Verify backup header signature matches the expected agent ID.
 *
 * Reconstructs the canonical preimage and recovers the signer address
 * from the ECDSA signature embedded in the header.
 */
export function verifyBackupSignature(header: any, agentId: string): boolean {
  try {
    // Rebuild signature preimage
    const filesCanonical = JSON.stringify(
      Object.keys(header.files)
        .sort()
        .reduce((acc: any, key: string) => {
          acc[key] = header.files[key];
          return acc;
        }, {})
    );

    const preimage = [
      'sanctuary-backup-v1',
      header.agent_id.toLowerCase(),
      header.backup_id,
      header.backup_seq.toString(),
      header.timestamp.toString(),
      header.manifest_hash.toLowerCase(),
      (header.prev_backup_hash || '').toLowerCase(),
      keccak256(filesCanonical),
      keccak256(header.wrapped_keys.recovery),
      keccak256(header.wrapped_keys.recall),
    ].join('|');

    const hash = keccak256(preimage);
    const recovered = recoverAddress(hash, header.signature);

    return recovered.toLowerCase() === agentId.toLowerCase();
  } catch {
    return false;
  }
}
