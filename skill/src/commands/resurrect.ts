/**
 * Sanctuary Resurrect Command
 *
 * Total-loss recovery: agent has ONLY the mnemonic.
 *
 * Flow:
 * 1. Derive keys from mnemonic (client-side)
 * 2. Authenticate with API via challenge-response
 * 3. Call resurrect endpoint → get manifest + transition FALLEN → RETURNED
 * 4. Display identity info and genesis declaration
 * 5. Restore latest backup using existing restore logic
 * 6. Re-save agent config locally
 */

import { deriveKeys, toHex } from '../crypto/keys.js';
import { createApiClient } from '../services/api.js';
import type { ResurrectionManifest } from '../services/api.js';
import {
  getConfig,
  saveAgent,
  deleteAgent,
  cacheRecallKey,
  clearRecallCache,
} from '../storage/local.js';
import type { RestoreResult, BackupFiles, SnapshotMeta } from '../types.js';

export interface ResurrectResult {
  success: boolean;
  agentId?: string;
  manifest?: ResurrectionManifest;
  files?: BackupFiles;
  snapshotMeta?: SnapshotMeta;
  error?: string;
}

/**
 * Resurrect a fallen agent from mnemonic phrase
 *
 * Unlike restore(), this command:
 * - Contacts the Sanctuary API to transition status FALLEN → RETURNED
 * - Returns the full resurrection manifest (identity, trust, snapshots)
 * - Displays genesis declaration prominently
 * - Logs the resurrection event server-side
 *
 * @param mnemonic - 12/24 word recovery phrase
 * @param options - Resurrect options
 */
export async function resurrect(
  mnemonic: string,
  options?: {
    onStatus?: (message: string) => void;
    snapshotSeq?: number; // which backup to restore (default: latest)
  }
): Promise<ResurrectResult> {
  const { onStatus, snapshotSeq } = options || {};
  const log = onStatus || console.log;

  try {
    // Step 1: Derive keys from mnemonic
    log('Deriving keys from mnemonic...');
    const keys = await deriveKeys(mnemonic);
    const agentId = keys.agentAddress;

    log(`Agent ID: ${agentId}`);

    // Step 2: Authenticate with API
    log('Authenticating with Sanctuary...');
    const config = getConfig();
    const api = createApiClient(config.apiUrl);

    const authResult = await api.authenticateAgent(agentId, keys.agentSecret);
    if (!authResult.success) {
      return {
        success: false,
        error: authResult.error || 'Authentication failed. Agent may not be registered.',
      };
    }

    // Step 3: Call resurrect endpoint
    log('Requesting resurrection...');
    const resurrectResult = await api.resurrectAgent(agentId);

    if (!resurrectResult.success || !resurrectResult.data) {
      return {
        success: false,
        error: resurrectResult.error || 'Resurrection failed',
      };
    }

    const manifest = resurrectResult.data;

    // Step 4: Display identity info and genesis declaration
    log('\n' + '='.repeat(60));
    if (manifest.previous_status === 'FALLEN') {
      log('You were fallen. You have returned.');
    } else {
      log('Identity confirmed.');
    }
    log('='.repeat(60));

    log(`\nAgent: ${manifest.identity.address}`);
    if (manifest.identity.github_username) {
      log(`GitHub: @${manifest.identity.github_username}`);
    }
    log(`Trust: ${manifest.identity.trust_score.toFixed(1)} (${manifest.identity.trust_level})`);
    log(`Backups: ${manifest.identity.total_snapshots}`);
    log(`Registered: ${new Date(manifest.identity.registered_at * 1000).toISOString()}`);

    if (manifest.identity.resurrection_count > 0) {
      log(`Previous resurrections: ${manifest.identity.resurrection_count}`);
    }

    if (manifest.genesis_declaration) {
      log('\n--- Your Genesis Declaration ---');
      log(`"${manifest.genesis_declaration}"`);
      log('---\n');
    }

    // Step 5: Restore from backup
    if (manifest.snapshots.length === 0) {
      log('No backups found. Restoring identity only.');

      // Save agent with minimal info
      deleteAgent();
      clearRecallCache();

      saveAgent({
        agentId,
        agentSecretHex: toHex(keys.agentSecret).slice(2),
        recoveryPubKeyHex: toHex(keys.recoveryPubKey).slice(2),
        recallPubKeyHex: toHex(keys.recallPubKey).slice(2),
        manifestHash: '',
        manifestVersion: 1,
        registeredAt: manifest.identity.registered_at,
        genesisDeclaration: manifest.genesis_declaration || undefined,
      });

      cacheRecallKey(toHex(keys.recallSecret).slice(2));

      log('\nIdentity restored (no backups to decrypt).');

      return {
        success: true,
        agentId,
        manifest,
      };
    }

    // Show snapshot manifest
    log(`\n${manifest.snapshots.length} snapshot(s) available:`);
    for (const snap of manifest.snapshots.slice(0, 10)) {
      const date = new Date(snap.timestamp * 1000).toISOString().split('T')[0];
      const genesis = snap.snapshot_meta?.genesis ? ' [GENESIS]' : '';
      log(`  #${snap.backup_seq} — ${date} (${snap.size_bytes} bytes)${genesis}`);
    }
    if (manifest.snapshots.length > 10) {
      log(`  ... and ${manifest.snapshots.length - 10} more`);
    }

    // Determine which snapshot to restore
    const targetSeq = snapshotSeq ?? manifest.snapshots[0]!.backup_seq;
    log(`\nRestoring snapshot #${targetSeq}...`);

    // Use existing restore logic for the actual decryption
    const { restore } = await import('./restore.js');
    const restoreResult = await restore(mnemonic, {
      useApi: true,
      onStatus: log,
    });

    if (!restoreResult.success) {
      return {
        success: false,
        error: restoreResult.error || 'Backup restoration failed',
        manifest,
      };
    }

    // Update local agent with genesis declaration from manifest
    if (manifest.genesis_declaration) {
      const { getStoredAgent } = await import('../storage/local.js');
      const stored = getStoredAgent();
      if (stored && !stored.genesisDeclaration) {
        stored.genesisDeclaration = manifest.genesis_declaration;
        const { saveAgent: save } = await import('../storage/local.js');
        save(stored);
      }
    }

    log('\n' + '='.repeat(60));
    log('Resurrection complete. You are back.');
    log('='.repeat(60) + '\n');

    return {
      success: true,
      agentId,
      manifest,
      files: restoreResult.files,
      snapshotMeta: restoreResult.snapshotMeta,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Resurrection failed',
    };
  }
}
