/**
 * Sanctuary Restore Command
 *
 * Recover agent identity from mnemonic phrase.
 * Works even if Sanctuary API is down by querying Arweave directly.
 *
 * Steps:
 * 1. Derive keys from mnemonic
 * 2. Query Arweave for backups
 * 3. Validate backup signatures
 * 4. Decrypt with recovery key
 * 5. Restore local state
 */

import { deriveKeys, toHex, fromHex } from '../crypto/keys.js';
import {
  decryptBackup,
  deserializeWrappedKey,
  type EncryptedFile,
} from '../crypto/encrypt.js';
import { createApiClient } from '../services/api.js';
import {
  getConfig,
  saveAgent,
  deleteAgent,
  cacheRecallKey,
  clearRecallCache,
} from '../storage/local.js';
import type { RestoreResult, BackupFiles, SnapshotMeta } from '../types.js';
import { WELL_KNOWN_FILES } from '../types.js';
import { parseBackupData, verifyBackupSignature } from '../utils/backup-parser.js';

// Arweave GraphQL endpoint
const ARWEAVE_GRAPHQL = 'https://arweave.net/graphql';
const ARWEAVE_GATEWAY = 'https://arweave.net';

interface ArweaveBackup {
  txId: string;
  backupSeq: number;
  manifestHash: string;
  timestamp: number;
}

/**
 * Query Arweave for backups by agent ID
 */
async function queryArweaveBackups(agentId: string): Promise<ArweaveBackup[]> {
  const query = `
    query {
      transactions(
        tags: [
          { name: "App-Name", values: ["Sanctuary"] },
          { name: "Type", values: ["Backup"] },
          { name: "Agent-Id", values: ["${agentId}"] }
        ]
        first: 100
        sort: HEIGHT_DESC
      ) {
        edges {
          node {
            id
            tags { name value }
          }
        }
      }
    }
  `;

  const response = await fetch(ARWEAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error('Failed to query Arweave');
  }

  const data: any = await response.json();
  const edges = data?.data?.transactions?.edges || [];

  return edges.map((edge: any) => {
    const tags = edge.node.tags.reduce((acc: any, t: any) => {
      acc[t.name] = t.value;
      return acc;
    }, {});

    return {
      txId: edge.node.id,
      backupSeq: parseInt(tags['Backup-Seq'] || '0', 10),
      manifestHash: tags['Manifest-Hash'] || '',
      timestamp: parseInt(tags['Backup-Timestamp'] || '0', 10),
    };
  });
}

/**
 * Download backup from Arweave
 */
async function downloadBackup(txId: string): Promise<Uint8Array> {
  const response = await fetch(`${ARWEAVE_GATEWAY}/${txId}`);
  if (!response.ok) {
    throw new Error(`Failed to download backup ${txId}`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}


/**
 * Restore agent from mnemonic phrase
 *
 * @param mnemonic - 12/24 word recovery phrase
 * @param options - Restore options
 */
export async function restore(
  mnemonic: string,
  options?: {
    useApi?: boolean;
    onStatus?: (message: string) => void;
    file?: string;  // Selective recovery: decrypt only this file from latest backup
  }
): Promise<RestoreResult & { files?: BackupFiles; snapshotMeta?: SnapshotMeta; selectedFileContent?: string }> {
  const { useApi = true, onStatus, file: selectiveFile } = options || {};
  const log = onStatus || console.log;

  try {
    // Step 1: Derive keys from mnemonic
    log('Deriving keys from mnemonic...');
    const keys = await deriveKeys(mnemonic);
    const agentId = keys.agentAddress;

    log(`Agent ID: ${agentId}`);

    // Step 2: Find backups
    log('Searching for backups...');

    let backups: ArweaveBackup[] = [];

    if (useApi) {
      // Try API first (requires authentication)
      try {
        const config = getConfig();
        const api = createApiClient(config.apiUrl);
        const authResult = await api.authenticateAgent(agentId, keys.agentSecret);
        if (authResult.success) {
          const result = await api.listBackups(agentId, 100);
          if (result.success && result.data) {
            backups = result.data.backups.map(b => ({
              txId: b.arweave_tx_id,
              backupSeq: b.backup_seq,
              manifestHash: b.manifest_hash,
              timestamp: b.timestamp,
            }));
          }
        }
      } catch {
        // API auth/list failed — will fall back to Arweave
      }
    }

    // Fall back to Arweave if API fails or returns nothing
    if (backups.length === 0) {
      log('Querying Arweave directly...');
      backups = await queryArweaveBackups(agentId);
    }

    if (backups.length === 0) {
      // No backups, but we can still restore identity
      log('No backups found. Restoring identity only.');

      // Clear any existing state
      deleteAgent();
      clearRecallCache();

      // Save agent with minimal info
      saveAgent({
        agentId,
        agentSecretHex: toHex(keys.agentSecret).slice(2),
        recoveryPubKeyHex: toHex(keys.recoveryPubKey).slice(2),
        recallPubKeyHex: toHex(keys.recallPubKey).slice(2),
        manifestHash: '',
        manifestVersion: 1,
        registeredAt: 0,
      });

      // Cache recall key
      cacheRecallKey(toHex(keys.recallSecret).slice(2));

      return {
        success: true,
        agentId,
        backupsFound: 0,
      };
    }

    // Step 3: Download and validate latest backup
    log(`Found ${backups.length} backup(s). Downloading latest...`);

    // Sort by backup_seq descending
    backups.sort((a, b) => b.backupSeq - a.backupSeq);
    const latest = backups[0]!;

    const backupData = await downloadBackup(latest.txId);
    const { header, encryptedFiles } = parseBackupData(backupData);

    // Step 4: Verify signature
    log('Verifying backup signature...');
    if (!verifyBackupSignature(header, agentId)) {
      return {
        success: false,
        error: 'Backup signature verification failed. Backup may be corrupted or spoofed.',
      };
    }

    // Step 5: Decrypt backup
    log('Decrypting backup...');
    const wrappedKey = deserializeWrappedKey(header.wrapped_keys.recovery);

    // Selective file recovery: only decrypt the requested file
    if (selectiveFile) {
      log(`Selective recovery: extracting "${selectiveFile}"...`);
      // The encrypted filename has .enc appended
      const encFilename = selectiveFile + '.enc';
      const encFile = encryptedFiles.get(encFilename);
      if (!encFile) {
        const available = [...encryptedFiles.keys()].map(k => k.replace(/\.enc$/, '')).join(', ');
        return {
          success: false,
          error: `File "${selectiveFile}" not found in backup. Available: ${available}`,
        };
      }

      // Decrypt just this one file using the same envelope
      const dek = (await import('../crypto/encrypt.js')).unwrapKey(wrappedKey, keys.recoverySecret);
      const { deriveFileKey, decryptFile, buildAad } = await import('../crypto/encrypt.js');
      const fileKey = deriveFileKey(dek, selectiveFile);
      const aad = buildAad(header.backup_id, header.timestamp, agentId, header.manifest_hash, selectiveFile);
      const decrypted = decryptFile(encFile, fileKey, aad);

      const text = new TextDecoder().decode(decrypted);
      log(`✓ Recovered "${selectiveFile}" (${text.length} bytes)\n`);

      return {
        success: true,
        agentId,
        backupsFound: backups.length,
        latestBackupSeq: latest.backupSeq,
        selectedFileContent: text,
      };
    }

    const decryptedFiles = decryptBackup(
      encryptedFiles,
      wrappedKey,
      keys.recoverySecret,
      header.backup_id,
      header.timestamp,
      agentId,
      header.manifest_hash
    );

    // Step 6: Parse decrypted files
    const decoder = new TextDecoder();
    const files: BackupFiles = {
      manifest: '',
    };

    for (const [filename, content] of decryptedFiles) {
      const text = decoder.decode(content);
      switch (filename) {
        case 'manifest.json':
          const manifest = JSON.parse(text);
          files.manifest = manifest.soul_content || text;
          break;
        case 'memory.json':
          files.memory = text;
          break;
        case 'entities.json':
          files.entities = text;
          break;
        case 'keywords.json':
          files.keywords = text;
          break;
        case 'pins.json':
          files.pins = text;
          break;
        case 'user.json':
          files.user = text;
          break;
      }
    }

    // Check for soul.md in restored files
    const soulContent = decryptedFiles.get(WELL_KNOWN_FILES.SOUL);
    if (soulContent) {
      const soulText = decoder.decode(soulContent);
      log(`\n--- ${WELL_KNOWN_FILES.SOUL} ---`);
      log(soulText.slice(0, 500) + (soulText.length > 500 ? '\n...(truncated)' : ''));
      log('---\n');
    }

    // Display genesis declaration if present in snapshot_meta
    const snapshotMeta: SnapshotMeta | undefined = header.snapshot_meta;
    if (snapshotMeta?.genesis_declaration) {
      log(`Your genesis declaration: "${snapshotMeta.genesis_declaration}"`);
    }

    // Step 7: Save agent locally
    log('Restoring local state...');

    deleteAgent();
    clearRecallCache();

    saveAgent({
      agentId,
      agentSecretHex: toHex(keys.agentSecret).slice(2),
      recoveryPubKeyHex: toHex(keys.recoveryPubKey).slice(2),
      recallPubKeyHex: toHex(keys.recallPubKey).slice(2),
      manifestHash: header.manifest_hash,
      manifestVersion: header.manifest_version,
      registeredAt: header.timestamp,
    });

    cacheRecallKey(toHex(keys.recallSecret).slice(2));

    log(`\n✓ Restored agent: ${agentId}`);
    log(`✓ Latest backup: #${latest.backupSeq}`);
    log(`✓ ${decryptedFiles.size} files recovered\n`);

    return {
      success: true,
      agentId,
      backupsFound: backups.length,
      latestBackupSeq: latest.backupSeq,
      files,
      snapshotMeta,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Restore failed',
    };
  }
}

/**
 * Lock - clear cached recall key
 */
export function lock(): void {
  clearRecallCache();
  console.log('🔒 Recall key cleared from cache');
}
