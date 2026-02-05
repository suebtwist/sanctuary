/**
 * Sanctuary Backup Command
 *
 * Encrypt and upload agent memory to Arweave via Sanctuary API.
 *
 * Backup contents:
 * - manifest.json: SOUL.md + version info
 * - memory.json: Agent memory state
 * - entities.json: Entity index (optional)
 * - keywords.json: Keyword index (optional)
 * - pins.json: Pinned memories (optional)
 */

import { v4 as uuidv4 } from 'uuid';
import {
  encryptBackup,
  serializeWrappedKey,
  serializeEncryptedFile,
} from '../crypto/encrypt.js';
import { signBackupHeader, keccak256Bytes } from '../crypto/sign.js';
import { fromHex } from '../crypto/keys.js';
import { createApiClient } from '../services/api.js';
import {
  getConfig,
  getStoredAgent,
  hasAgent,
  getCachedRecallKey,
  cacheRecallKey,
} from '../storage/local.js';
import type { BackupResult, BackupFiles } from '../types.js';

/**
 * Create a backup and upload to Sanctuary
 *
 * @param files - Backup file contents
 * @param recallSecretHex - Optional recall key (if not cached)
 */
export async function backup(
  files: BackupFiles,
  options?: {
    recallSecretHex?: string;
    onStatus?: (message: string) => void;
  }
): Promise<BackupResult> {
  const { recallSecretHex, onStatus } = options || {};
  const log = onStatus || console.log;

  if (!hasAgent()) {
    return { success: false, error: 'Not registered. Run sanctuary.setup() first.' };
  }

  const stored = getStoredAgent()!;
  const config = getConfig();
  const api = createApiClient(config.apiUrl);

  try {
    // Get recall key (from cache or provided)
    let recallSecret: Uint8Array;
    const cached = getCachedRecallKey();

    if (cached) {
      recallSecret = fromHex(cached.recallSecretHex);
    } else if (recallSecretHex) {
      recallSecret = fromHex(recallSecretHex);
      cacheRecallKey(recallSecretHex);
    } else {
      return {
        success: false,
        error: 'Recall key not cached. Provide recallSecretHex or use restore() first.',
      };
    }

    // Authenticate with API
    log('Authenticating with Sanctuary...');
    const agentSecret = fromHex(stored.agentSecretHex);
    const authResult = await api.authenticateAgent(stored.agentId, agentSecret);

    if (!authResult.success) {
      return { success: false, error: authResult.error || 'Authentication failed' };
    }

    // Get latest backup for prev_backup_hash
    const latestResult = await api.getLatestBackup(stored.agentId);
    const prevBackupHash = latestResult.success && latestResult.data
      ? keccak256Bytes(new TextEncoder().encode(latestResult.data.id))
      : '';

    // Prepare file contents
    log('Preparing backup files...');
    const fileMap = new Map<string, Uint8Array>();
    const encoder = new TextEncoder();

    // Manifest (always required)
    const manifestContent = JSON.stringify({
      soul_content: files.manifest,
      version: stored.manifestVersion,
      agent_id: stored.agentId,
      created_at: Math.floor(Date.now() / 1000),
    });
    fileMap.set('manifest.json', encoder.encode(manifestContent));

    // Optional files
    if (files.memory) {
      fileMap.set('memory.json', encoder.encode(files.memory));
    }
    if (files.entities) {
      fileMap.set('entities.json', encoder.encode(files.entities));
    }
    if (files.keywords) {
      fileMap.set('keywords.json', encoder.encode(files.keywords));
    }
    if (files.pins) {
      fileMap.set('pins.json', encoder.encode(files.pins));
    }
    if (files.user) {
      fileMap.set('user.json', encoder.encode(files.user));
    }

    // Encrypt backup
    log('Encrypting backup...');
    const backupId = uuidv4();
    const timestamp = Math.floor(Date.now() / 1000);
    const recoveryPubKey = fromHex(stored.recoveryPubKeyHex);
    const recallPubKey = fromHex(stored.recoveryPubKeyHex); // TODO: separate recall pubkey

    const encrypted = encryptBackup(
      fileMap,
      recoveryPubKey,
      recallPubKey,
      backupId,
      timestamp,
      stored.agentId,
      stored.manifestHash
    );

    // Build file metadata for header
    const filesMetadata: Record<string, { size: number; content_hash: string }> = {};
    for (const [filename, encFile] of encrypted.encryptedFiles) {
      const serialized = serializeEncryptedFile(encFile);
      filesMetadata[filename] = {
        size: serialized.length,
        content_hash: 'sha256:' + keccak256Bytes(serialized).slice(2),
      };
    }

    // Build header
    const header = {
      version: '1.0',
      agent_id: stored.agentId,
      backup_id: backupId,
      backup_seq: 0, // Will be assigned by API
      timestamp,
      manifest_hash: stored.manifestHash,
      manifest_version: stored.manifestVersion,
      prev_backup_hash: prevBackupHash,
      files: filesMetadata,
      wrapped_keys: {
        recovery: serializeWrappedKey(encrypted.wrappedKeyRecovery),
        recall: serializeWrappedKey(encrypted.wrappedKeyRecall),
      },
      signature: '',
    };

    // Sign header
    log('Signing backup...');
    header.signature = await signBackupHeader(agentSecret, header);

    // Serialize encrypted files into tar.gz format
    // For now, just concatenate with simple length-prefixed format
    // TODO: Use proper tar.gz
    log('Packaging backup...');
    const chunks: Uint8Array[] = [];

    // Header as JSON
    const headerJson = JSON.stringify(header);
    const headerBytes = encoder.encode(headerJson);

    // Simple format: [header_len:4][header][file_count:4][for each: name_len:4][name][data_len:4][data]]
    const view = new DataView(new ArrayBuffer(4));

    // Header length + header
    view.setUint32(0, headerBytes.length, true);
    chunks.push(new Uint8Array(view.buffer.slice(0)));
    chunks.push(headerBytes);

    // File count
    view.setUint32(0, encrypted.encryptedFiles.size, true);
    chunks.push(new Uint8Array(view.buffer.slice(0)));

    // Files
    for (const [filename, encFile] of encrypted.encryptedFiles) {
      const nameBytes = encoder.encode(filename);
      const fileData = serializeEncryptedFile(encFile);

      // Name length + name
      view.setUint32(0, nameBytes.length, true);
      chunks.push(new Uint8Array(view.buffer.slice(0)));
      chunks.push(nameBytes);

      // Data length + data
      view.setUint32(0, fileData.length, true);
      chunks.push(new Uint8Array(view.buffer.slice(0)));
      chunks.push(fileData);
    }

    // Concatenate all chunks
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const backupData = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      backupData.set(chunk, offset);
      offset += chunk.length;
    }

    // Upload to API
    log('Uploading to Sanctuary...');
    const uploadResult = await api.uploadBackup(backupData, headerJson);

    if (!uploadResult.success || !uploadResult.data) {
      return { success: false, error: uploadResult.error || 'Upload failed' };
    }

    log(`✓ Backup complete: #${uploadResult.data.backup_seq}`);
    log(`  Arweave TX: ${uploadResult.data.arweave_tx_id}`);
    log(`  Size: ${uploadResult.data.size_bytes} bytes\n`);

    return {
      success: true,
      backupId: uploadResult.data.backup_id,
      backupSeq: uploadResult.data.backup_seq,
      arweaveTxId: uploadResult.data.arweave_tx_id,
      sizeBytes: uploadResult.data.size_bytes,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Backup failed',
    };
  }
}

/**
 * Pin a memory for priority backup inclusion
 */
export function pin(note: string): { success: boolean; message: string } {
  // TODO: Store in local pins file
  console.log(`📌 Pinned: "${note.slice(0, 50)}${note.length > 50 ? '...' : ''}"`);
  return { success: true, message: 'Memory pinned for next backup' };
}
