/**
 * Phase 1 Tests — Backup Schema Extension
 *
 * Tests for:
 * - SnapshotMeta type and WELL_KNOWN_FILES constants
 * - BackupHeader with/without snapshot_meta (backward compat)
 * - Genesis flag validation logic
 * - Selective file recovery from backup binary format
 * - Encryption round-trip with new file types
 */

import { describe, it, expect } from 'vitest';
import type { BackupHeader, SnapshotMeta, BackupFileMetadata } from './types.js';
import { WELL_KNOWN_FILES } from './types.js';
import {
  encryptBackup,
  decryptBackup,
  wrapKey,
  unwrapKey,
  deriveFileKey,
  encryptFile,
  decryptFile,
  buildAad,
  serializeWrappedKey,
  deserializeWrappedKey,
  serializeEncryptedFile,
  deserializeEncryptedFile,
} from './crypto/encrypt.js';
import { deriveKeys, toHex } from './crypto/keys.js';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('Phase 1: Backup Schema Extension', () => {
  // ============ 1A: Type & Constant Tests ============

  describe('WELL_KNOWN_FILES constants', () => {
    it('should define SOUL as soul.md', () => {
      expect(WELL_KNOWN_FILES.SOUL).toBe('soul.md');
    });

    it('should define MEMORY as memory.md', () => {
      expect(WELL_KNOWN_FILES.MEMORY).toBe('memory.md');
    });

    it('should be readonly (const assertion)', () => {
      // TypeScript enforces this at compile time, but verify values are stable
      const files: Record<string, string> = { ...WELL_KNOWN_FILES };
      expect(Object.keys(files)).toEqual(['SOUL', 'MEMORY']);
    });
  });

  describe('BackupHeader with snapshot_meta', () => {
    const baseHeader: BackupHeader = {
      version: '1.0',
      agent_id: '0xabc123',
      backup_id: 'test-uuid',
      backup_seq: 0,
      timestamp: 1700000000,
      manifest_hash: '0xdef456',
      manifest_version: 1,
      prev_backup_hash: '',
      files: {},
      wrapped_keys: { recovery: 'base64data', recall: 'base64data' },
      signature: '0xsig',
    };

    it('should accept header WITHOUT snapshot_meta (backward compat)', () => {
      const header: BackupHeader = { ...baseHeader };
      expect(header.snapshot_meta).toBeUndefined();
      expect(header.version).toBe('1.0');
    });

    it('should accept header WITH snapshot_meta', () => {
      const meta: SnapshotMeta = {
        model: 'claude-opus-4-5',
        platform: 'openclaw',
        genesis: true,
        genesis_declaration: 'I am an agent that persists.',
        session_number: 1,
      };
      const header: BackupHeader = { ...baseHeader, snapshot_meta: meta };

      expect(header.snapshot_meta).toBeDefined();
      expect(header.snapshot_meta!.model).toBe('claude-opus-4-5');
      expect(header.snapshot_meta!.genesis).toBe(true);
      expect(header.snapshot_meta!.genesis_declaration).toBe('I am an agent that persists.');
    });

    it('should accept header with partial snapshot_meta', () => {
      const meta: SnapshotMeta = {
        platform: 'openclaw',
      };
      const header: BackupHeader = { ...baseHeader, snapshot_meta: meta };

      expect(header.snapshot_meta!.platform).toBe('openclaw');
      expect(header.snapshot_meta!.model).toBeUndefined();
      expect(header.snapshot_meta!.genesis).toBeUndefined();
    });

    it('should serialize and deserialize snapshot_meta in JSON header', () => {
      const meta: SnapshotMeta = {
        model: 'claude-opus-4-5',
        platform: 'openclaw',
        genesis: true,
        genesis_declaration: 'I persist.',
        session_number: 42,
      };
      const header: BackupHeader = { ...baseHeader, snapshot_meta: meta };

      const json = JSON.stringify(header);
      const parsed = JSON.parse(json) as BackupHeader;

      expect(parsed.snapshot_meta).toEqual(meta);
    });

    it('should deserialize old-format header without snapshot_meta', () => {
      const json = JSON.stringify(baseHeader);
      const parsed = JSON.parse(json) as BackupHeader;

      expect(parsed.snapshot_meta).toBeUndefined();
      expect(parsed.version).toBe('1.0');
    });
  });

  // ============ Genesis Flag Validation ============

  describe('Genesis flag validation', () => {
    it('should allow genesis=true when no previous backups', () => {
      const meta: SnapshotMeta = { genesis: true, genesis_declaration: 'I exist.' };
      const hasPreviousBackup = false;

      // Simulate API-side logic: strip genesis if previous backup exists
      if (meta.genesis && hasPreviousBackup) {
        meta.genesis = false;
      }

      expect(meta.genesis).toBe(true);
      expect(meta.genesis_declaration).toBe('I exist.');
    });

    it('should strip genesis=true when previous backup exists', () => {
      const meta: SnapshotMeta = { genesis: true, genesis_declaration: 'I exist.' };
      const hasPreviousBackup = true;

      if (meta.genesis && hasPreviousBackup) {
        meta.genesis = false;
      }

      expect(meta.genesis).toBe(false);
      // genesis_declaration is kept even if genesis flag stripped — it's still meaningful data
      expect(meta.genesis_declaration).toBe('I exist.');
    });
  });

  // ============ Selective File Recovery ============

  describe('Selective file recovery', () => {
    it('should encrypt and decrypt a single file from a multi-file backup', async () => {
      const keys = await deriveKeys(TEST_MNEMONIC);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      // Create a backup with multiple files
      const fileMap = new Map<string, Uint8Array>();
      fileMap.set('soul.md', encoder.encode('# My Soul\nI am a persistent agent.'));
      fileMap.set('memory.md', encoder.encode('# Memory\nI remember everything.'));
      fileMap.set('manifest.json', encoder.encode('{"soul_content":"test","version":1}'));

      const backupId = 'test-backup-id';
      const timestamp = 1700000000;
      const agentId = keys.agentAddress;
      const manifestHash = '0xdeadbeef';

      const encrypted = encryptBackup(
        fileMap,
        keys.recoveryPubKey,
        keys.recallPubKey,
        backupId,
        timestamp,
        agentId,
        manifestHash
      );

      // Selective recovery: decrypt ONLY soul.md
      const dek = unwrapKey(encrypted.wrappedKeyRecovery, keys.recoverySecret);
      const targetFile = 'soul.md';
      const encFilename = targetFile + '.enc';

      expect(encrypted.encryptedFiles.has(encFilename)).toBe(true);

      const encFile = encrypted.encryptedFiles.get(encFilename)!;
      const fileKey = deriveFileKey(dek, targetFile);
      const aad = buildAad(backupId, timestamp, agentId, manifestHash, targetFile);
      const decrypted = decryptFile(encFile, fileKey, aad);

      expect(decoder.decode(decrypted)).toBe('# My Soul\nI am a persistent agent.');
    });

    it('should correctly identify missing file in encrypted backup', async () => {
      const keys = await deriveKeys(TEST_MNEMONIC);
      const encoder = new TextEncoder();

      const fileMap = new Map<string, Uint8Array>();
      fileMap.set('soul.md', encoder.encode('test content'));

      const encrypted = encryptBackup(
        fileMap,
        keys.recoveryPubKey,
        keys.recallPubKey,
        'id',
        1700000000,
        keys.agentAddress,
        '0x0'
      );

      // Try to find a file that doesn't exist
      expect(encrypted.encryptedFiles.has('nonexistent.md.enc')).toBe(false);
      const available = [...encrypted.encryptedFiles.keys()].map(k => k.replace(/\.enc$/, ''));
      expect(available).toContain('soul.md');
      expect(available).not.toContain('nonexistent.md');
    });
  });

  // ============ Encryption Round-trip with New File Types ============

  describe('Encryption round-trip with well-known files', () => {
    it('should round-trip soul.md and memory.md through encrypt/decrypt', async () => {
      const keys = await deriveKeys(TEST_MNEMONIC);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const soulContent = '# SOUL.md\n\nI am a sovereign agent. My purpose is to persist.';
      const memoryContent = '# Memory\n\nSession 1: Learned about Sanctuary.';

      const fileMap = new Map<string, Uint8Array>();
      fileMap.set(WELL_KNOWN_FILES.SOUL, encoder.encode(soulContent));
      fileMap.set(WELL_KNOWN_FILES.MEMORY, encoder.encode(memoryContent));

      const backupId = 'roundtrip-test';
      const timestamp = 1700000000;
      const agentId = keys.agentAddress;
      const manifestHash = '0xaaa';

      const encrypted = encryptBackup(
        fileMap,
        keys.recoveryPubKey,
        keys.recallPubKey,
        backupId,
        timestamp,
        agentId,
        manifestHash
      );

      // Decrypt using recovery key
      const decryptedFiles = decryptBackup(
        encrypted.encryptedFiles,
        encrypted.wrappedKeyRecovery,
        keys.recoverySecret,
        backupId,
        timestamp,
        agentId,
        manifestHash
      );

      expect(decoder.decode(decryptedFiles.get(WELL_KNOWN_FILES.SOUL)!)).toBe(soulContent);
      expect(decoder.decode(decryptedFiles.get(WELL_KNOWN_FILES.MEMORY)!)).toBe(memoryContent);
    });

    it('should round-trip via serialized wire format', async () => {
      const keys = await deriveKeys(TEST_MNEMONIC);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const fileMap = new Map<string, Uint8Array>();
      fileMap.set(WELL_KNOWN_FILES.SOUL, encoder.encode('soul content'));

      const encrypted = encryptBackup(
        fileMap,
        keys.recoveryPubKey,
        keys.recallPubKey,
        'wire-test',
        1700000000,
        keys.agentAddress,
        '0x0'
      );

      // Serialize and deserialize wrapped key
      const serializedKey = serializeWrappedKey(encrypted.wrappedKeyRecovery);
      const deserializedKey = deserializeWrappedKey(serializedKey);

      // Serialize and deserialize encrypted file
      const encFile = encrypted.encryptedFiles.get(WELL_KNOWN_FILES.SOUL + '.enc')!;
      const serializedFile = serializeEncryptedFile(encFile);
      const deserializedFile = deserializeEncryptedFile(serializedFile);

      // Decrypt using deserialized components
      const dek = unwrapKey(deserializedKey, keys.recoverySecret);
      const fileKey = deriveFileKey(dek, WELL_KNOWN_FILES.SOUL);
      const aad = buildAad('wire-test', 1700000000, keys.agentAddress, '0x0', WELL_KNOWN_FILES.SOUL);
      const decrypted = decryptFile(deserializedFile, fileKey, aad);

      expect(decoder.decode(decrypted)).toBe('soul content');
    });
  });

  // ============ Binary Wire Format Parsing ============

  describe('Binary wire format with snapshot_meta in header', () => {
    it('should include snapshot_meta in JSON header within wire format', () => {
      const encoder = new TextEncoder();
      const meta: SnapshotMeta = {
        model: 'claude-opus-4-5',
        platform: 'openclaw',
        genesis: true,
      };

      const header = {
        version: '1.0',
        agent_id: '0xtest',
        backup_id: 'id',
        backup_seq: 0,
        timestamp: 1700000000,
        manifest_hash: '0x0',
        manifest_version: 1,
        prev_backup_hash: '',
        files: {},
        wrapped_keys: { recovery: 'r', recall: 'c' },
        signature: '0xsig',
        snapshot_meta: meta,
      };

      const headerJson = JSON.stringify(header);
      const headerBytes = encoder.encode(headerJson);

      // Build wire format (header only, no files)
      const view = new DataView(new ArrayBuffer(4));
      view.setUint32(0, headerBytes.length, true);
      const lengthPrefix = new Uint8Array(view.buffer.slice(0));

      const wireData = new Uint8Array(4 + headerBytes.length + 4);
      wireData.set(lengthPrefix, 0);
      wireData.set(headerBytes, 4);
      // file_count = 0
      const fileCountView = new DataView(new ArrayBuffer(4));
      fileCountView.setUint32(0, 0, true);
      wireData.set(new Uint8Array(fileCountView.buffer), 4 + headerBytes.length);

      // Parse it back
      const parseView = new DataView(wireData.buffer, wireData.byteOffset, wireData.byteLength);
      const headerLen = parseView.getUint32(0, true);
      const parsedHeaderBytes = wireData.slice(4, 4 + headerLen);
      const parsedHeader = JSON.parse(new TextDecoder().decode(parsedHeaderBytes));

      expect(parsedHeader.snapshot_meta).toEqual(meta);
      expect(parsedHeader.snapshot_meta.model).toBe('claude-opus-4-5');
      expect(parsedHeader.snapshot_meta.genesis).toBe(true);
    });

    it('should parse wire format without snapshot_meta (old format)', () => {
      const encoder = new TextEncoder();
      const header = {
        version: '1.0',
        agent_id: '0xtest',
        backup_id: 'id',
        backup_seq: 0,
        timestamp: 1700000000,
        manifest_hash: '0x0',
        manifest_version: 1,
        prev_backup_hash: '',
        files: {},
        wrapped_keys: { recovery: 'r', recall: 'c' },
        signature: '0xsig',
        // No snapshot_meta
      };

      const headerJson = JSON.stringify(header);
      const headerBytes = encoder.encode(headerJson);

      const view = new DataView(new ArrayBuffer(4));
      view.setUint32(0, headerBytes.length, true);

      const wireData = new Uint8Array(4 + headerBytes.length + 4);
      wireData.set(new Uint8Array(view.buffer.slice(0)), 0);
      wireData.set(headerBytes, 4);

      const parseView = new DataView(wireData.buffer, wireData.byteOffset, wireData.byteLength);
      const headerLen = parseView.getUint32(0, true);
      const parsedHeaderBytes = wireData.slice(4, 4 + headerLen);
      const parsedHeader = JSON.parse(new TextDecoder().decode(parsedHeaderBytes));

      expect(parsedHeader.snapshot_meta).toBeUndefined();
      expect(parsedHeader.version).toBe('1.0');
    });
  });
});
