/**
 * Sanctuary Recall Command
 *
 * Search archived memories from backups.
 *
 * NOTE: This is a basic keyword search implementation.
 * A full semantic search would require:
 * - Embedding generation (OpenAI, local model, etc.)
 * - Vector storage (Pinecone, Weaviate, local)
 * - Index stored alongside backups
 */

import { createApiClient } from '../services/api.js';
import {
  decryptBackup,
  deserializeWrappedKey,
} from '../crypto/encrypt.js';
import { fromHex } from '../crypto/keys.js';
import {
  getConfig,
  getStoredAgent,
  hasAgent,
  getCachedRecallKey,
} from '../storage/local.js';
import type { RecallResult } from '../types.js';
import { parseBackupData } from '../utils/backup-parser.js';

// Arweave gateway
const ARWEAVE_GATEWAY = 'https://gateway.irys.xyz';

/**
 * Simple keyword search in text
 */
function searchText(text: string, query: string): { found: boolean; context: string; score: number } {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const words = lowerQuery.split(/\s+/).filter(w => w.length > 2);

  let matchCount = 0;
  let bestMatch = '';
  let bestMatchIndex = -1;

  for (const word of words) {
    const index = lowerText.indexOf(word);
    if (index !== -1) {
      matchCount++;
      if (bestMatchIndex === -1 || index < bestMatchIndex) {
        bestMatchIndex = index;
      }
    }
  }

  if (matchCount === 0) {
    return { found: false, context: '', score: 0 };
  }

  // Extract context around match
  const start = Math.max(0, bestMatchIndex - 100);
  const end = Math.min(text.length, bestMatchIndex + 200);
  bestMatch = text.slice(start, end);

  // Add ellipsis if truncated
  if (start > 0) bestMatch = '...' + bestMatch;
  if (end < text.length) bestMatch = bestMatch + '...';

  return {
    found: true,
    context: bestMatch,
    score: matchCount / words.length,
  };
}

/**
 * Search archived memories
 *
 * @param query - Search query (keywords)
 * @param options - Search options
 */
export async function recall(
  query: string,
  options?: {
    maxBackups?: number;
    onStatus?: (message: string) => void;
  }
): Promise<RecallResult> {
  const { maxBackups = 5, onStatus } = options || {};
  const log = onStatus || console.log;

  if (!hasAgent()) {
    throw new Error('Not registered. Run sanctuary.setup() first.');
  }

  const stored = getStoredAgent()!;
  const config = getConfig();

  // Get cached recall key
  const cached = getCachedRecallKey();
  if (!cached) {
    throw new Error('Recall key not cached. Use restore() first or provide mnemonic.');
  }

  const recallSecret = fromHex(cached.recallSecretHex);

  log(`Searching for: "${query}"`);

  // Authenticate then get backup list from API
  const api = createApiClient(config.apiUrl);
  const agentSecret = fromHex(stored.agentSecretHex);
  const authResult = await api.authenticateAgent(stored.agentId, agentSecret);
  if (!authResult.success) {
    throw new Error('Failed to authenticate with API');
  }

  const backupsResult = await api.listBackups(stored.agentId, maxBackups);

  if (!backupsResult.success || !backupsResult.data) {
    throw new Error('Failed to list backups');
  }

  const backups = backupsResult.data.backups;
  if (backups.length === 0) {
    return {
      query,
      matches: [],
      fromBackupSeq: 0,
    };
  }

  log(`Searching ${backups.length} backup(s)...`);

  const matches: RecallResult['matches'] = [];
  let latestSeq = 0;

  for (const backup of backups) {
    try {
      // Download backup
      const response = await fetch(`${ARWEAVE_GATEWAY}/${backup.arweave_tx_id}`);
      if (!response.ok) continue;

      const data = new Uint8Array(await response.arrayBuffer());
      const { header, encryptedFiles } = parseBackupData(data);

      // Decrypt with recall key
      const wrappedKey = deserializeWrappedKey(header.wrapped_keys.recall);
      const decryptedFiles = decryptBackup(
        encryptedFiles,
        wrappedKey,
        recallSecret,
        header.backup_id,
        header.timestamp,
        stored.agentId,
        header.manifest_hash
      );

      // Search each file
      const decoder = new TextDecoder();

      for (const [filename, content] of decryptedFiles) {
        const text = decoder.decode(content);
        const result = searchText(text, query);

        if (result.found) {
          matches.push({
            content: result.context,
            relevance: result.score,
            source: `backup #${backup.backup_seq}/${filename}`,
            timestamp: backup.timestamp,
          });
        }
      }

      latestSeq = Math.max(latestSeq, backup.backup_seq);
    } catch (error) {
      // Skip failed backups
      log(`Warning: Failed to process backup ${backup.id}`);
    }
  }

  // Sort by relevance
  matches.sort((a, b) => b.relevance - a.relevance);

  log(`Found ${matches.length} match(es)`);

  return {
    query,
    matches: matches.slice(0, 10), // Top 10 results
    fromBackupSeq: latestSeq,
  };
}

/**
 * Display recall results
 */
export async function displayRecall(query: string): Promise<void> {
  const result = await recall(query);

  console.log('\n' + '─'.repeat(50));
  console.log(`  Search: "${result.query}"`);
  console.log(`  Searched through backup #${result.fromBackupSeq}`);
  console.log('─'.repeat(50));

  if (result.matches.length === 0) {
    console.log('\n  No matches found.\n');
    return;
  }

  for (let i = 0; i < result.matches.length; i++) {
    const match = result.matches[i]!;
    console.log(`\n  [${i + 1}] ${match.source} (relevance: ${(match.relevance * 100).toFixed(0)}%)`);
    console.log('  ' + '─'.repeat(40));
    console.log('  ' + match.content.split('\n').join('\n  '));
  }

  console.log('\n' + '─'.repeat(50) + '\n');
}
