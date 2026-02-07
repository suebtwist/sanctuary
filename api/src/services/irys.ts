/**
 * Irys Upload Service
 *
 * Uploads encrypted backup data to Arweave via Irys bundling service.
 * Uses @irys/upload + @irys/upload-ethereum (replaces deprecated @irys/sdk).
 *
 * When ARWEAVE_ENABLED=false (default), uploads are simulated and a
 * fake TX ID is returned. This allows local development and testing
 * without an Irys wallet or network access.
 */

import { Uploader } from '@irys/upload';
import { Ethereum } from '@irys/upload-ethereum';
import { getConfig } from '../config.js';

export interface UploadResult {
  arweaveTxId: string;
  simulated: boolean;
}

export interface UploadTags {
  agentId: string;
  backupSeq: number;
  manifestHash: string;
  sizeBytes: number;
  agentTimestamp: number;
}

// Lazy singleton — created on first real upload
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let uploaderInstance: any = null;

const BASE_MAINNET_CHAIN_ID = 8453;

async function getUploader() {
  if (!uploaderInstance) {
    const config = getConfig();
    if (!config.irysPrivateKey) {
      throw new Error('IRYS_PRIVATE_KEY not configured');
    }
    let builder = Uploader(Ethereum)
      .withRpc(config.baseRpcUrl)
      .withWallet(config.irysPrivateKey)
      .bundlerUrl(config.irysNode);
    // Use devnet for non-mainnet chains (Base Sepolia = 84532)
    if (config.chainId !== BASE_MAINNET_CHAIN_ID) {
      builder = builder.devnet();
    }
    uploaderInstance = await builder;
  }
  return uploaderInstance;
}

/**
 * Upload backup data to Arweave via Irys.
 *
 * If ARWEAVE_ENABLED is false, returns a simulated TX ID.
 * Tags are stored as Arweave TX metadata for indexing/querying.
 */
export async function uploadToArweave(
  data: Buffer,
  tags: UploadTags,
): Promise<UploadResult> {
  const config = getConfig();

  if (!config.arweaveEnabled) {
    // Simulated mode — return fake TX ID
    const { v4: uuidv4 } = await import('uuid');
    return {
      arweaveTxId: `simulated_${uuidv4()}`,
      simulated: true,
    };
  }

  const uploader = await getUploader();

  const receipt = await uploader.upload(data, {
    tags: [
      { name: 'Content-Type', value: 'application/gzip' },
      { name: 'App-Name', value: 'Sanctuary' },
      { name: 'Type', value: 'Backup' },
      { name: 'Agent-Id', value: tags.agentId },
      { name: 'Backup-Seq', value: String(tags.backupSeq) },
      { name: 'Backup-Timestamp', value: String(tags.agentTimestamp) },
      { name: 'Manifest-Hash', value: tags.manifestHash },
      { name: 'Size-Bytes', value: String(tags.sizeBytes) },
    ],
  });

  return {
    arweaveTxId: receipt.id,
    simulated: false,
  };
}

// ============ Balance Check ============

interface BalanceCache {
  balance: bigint;
  expiresAt: number;
}

let balanceCache: BalanceCache | null = null;
const BALANCE_CACHE_TTL_MS = 60_000;

/**
 * Check the Irys node balance for the configured wallet.
 * Cached for 60 seconds to avoid hammering Irys.
 */
export async function checkIrysBalance(): Promise<bigint> {
  const now = Date.now();
  if (balanceCache && now < balanceCache.expiresAt) {
    return balanceCache.balance;
  }

  const uploader = await getUploader();
  const balance: bigint = await uploader.getBalance();

  balanceCache = { balance, expiresAt: now + BALANCE_CACHE_TTL_MS };
  return balance;
}

/**
 * Reset the uploader singleton (for testing).
 */
export function _resetUploader(): void {
  uploaderInstance = null;
  balanceCache = null;
}
