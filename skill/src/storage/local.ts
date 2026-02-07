/**
 * Local Storage for Sanctuary Skill
 *
 * Manages locally cached state:
 * - Agent secret (encrypted at rest in production)
 * - Recall key (cached, 24h TTL)
 * - Config settings
 *
 * Storage location: ~/.sanctuary/
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Storage directory
const SANCTUARY_DIR = join(homedir(), '.sanctuary');
const CONFIG_FILE = 'config.json';
const AGENT_FILE = 'agent.json';
const RECALL_CACHE_FILE = 'recall-cache.json';

/**
 * Stored agent data (secrets should be encrypted in production)
 */
export interface GenesisCompleteness {
  declaration: boolean;      // did they provide a genesis declaration?
  first_backup: boolean;     // did the auto-backup succeed?
  attestation_seed: boolean; // did they seed an attestation?
}

export interface StoredAgent {
  agentId: string;
  agentSecretHex: string;      // Hex-encoded secp256k1 private key
  recoveryPubKeyHex: string;   // Hex-encoded X25519 recovery public key
  recallPubKeyHex: string;     // Hex-encoded X25519 recall public key
  manifestHash: string;
  manifestVersion: number;
  registeredAt: number;
  genesisDeclaration?: string;
  genesisCompleteness?: GenesisCompleteness;
}

/**
 * Cached recall key (short TTL)
 */
export interface RecallCache {
  recallSecretHex: string;     // Hex-encoded X25519 private key
  cachedAt: number;            // Unix timestamp
  expiresAt: number;           // Unix timestamp
}

/**
 * Config settings
 */
export interface SanctuaryConfig {
  apiUrl: string;
  chainId: number;
  contractAddress: string;
  baseRpcUrl: string;
  model?: string;
  platform?: string;
}

/**
 * Ensure storage directory exists
 */
function ensureDir(): void {
  if (!existsSync(SANCTUARY_DIR)) {
    mkdirSync(SANCTUARY_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Get path to a storage file
 */
function getPath(filename: string): string {
  return join(SANCTUARY_DIR, filename);
}

/**
 * Read JSON file safely
 */
function readJson<T>(filename: string): T | null {
  const path = getPath(filename);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Write JSON file with restricted permissions
 */
function writeJson<T>(filename: string, data: T): void {
  ensureDir();
  const path = getPath(filename);
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Delete a storage file
 */
function deleteFile(filename: string): void {
  const path = getPath(filename);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// ============ Config ============

/**
 * Get config, with defaults
 */
export function getConfig(): SanctuaryConfig {
  const stored = readJson<Partial<SanctuaryConfig>>(CONFIG_FILE);
  const chainId = stored?.chainId || 84532; // Base Sepolia
  return {
    apiUrl: stored?.apiUrl || process.env.SANCTUARY_API_URL || 'https://api.sanctuary-ops.xyz',
    chainId,
    contractAddress: stored?.contractAddress || '',
    baseRpcUrl: stored?.baseRpcUrl || process.env.BASE_RPC_URL ||
      (chainId === 8453 ? 'https://mainnet.base.org' : 'https://sepolia.base.org'),
  };
}

/**
 * Save config
 */
export function saveConfig(config: Partial<SanctuaryConfig>): void {
  const current = getConfig();
  writeJson(CONFIG_FILE, { ...current, ...config });
}

// ============ Agent ============

/**
 * Get stored agent data
 */
export function getStoredAgent(): StoredAgent | null {
  return readJson<StoredAgent>(AGENT_FILE);
}

/**
 * Save agent data
 *
 * WARNING: This stores the agent secret key. In production,
 * this should be encrypted with a machine-specific key.
 */
export function saveAgent(agent: StoredAgent): void {
  writeJson(AGENT_FILE, agent);
}

/**
 * Delete stored agent data
 */
export function deleteAgent(): void {
  deleteFile(AGENT_FILE);
}

/**
 * Update genesis completeness flags on the stored agent
 */
export function updateGenesisCompleteness(updates: Partial<GenesisCompleteness>): void {
  const agent = getStoredAgent();
  if (!agent) return;

  const current = agent.genesisCompleteness || {
    declaration: false,
    first_backup: false,
    attestation_seed: false,
  };

  agent.genesisCompleteness = { ...current, ...updates };
  writeJson(AGENT_FILE, agent);
}

/**
 * Check if agent is configured
 */
export function hasAgent(): boolean {
  return getStoredAgent() !== null;
}

// ============ Recall Cache ============

const RECALL_TTL_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Get cached recall key if valid
 */
export function getCachedRecallKey(): RecallCache | null {
  const cache = readJson<RecallCache>(RECALL_CACHE_FILE);
  if (!cache) return null;

  const now = Math.floor(Date.now() / 1000);
  if (now >= cache.expiresAt) {
    // Expired, delete it
    deleteFile(RECALL_CACHE_FILE);
    return null;
  }

  return cache;
}

/**
 * Cache recall key
 */
export function cacheRecallKey(recallSecretHex: string): void {
  const now = Math.floor(Date.now() / 1000);
  const cache: RecallCache = {
    recallSecretHex,
    cachedAt: now,
    expiresAt: now + RECALL_TTL_SECONDS,
  };
  writeJson(RECALL_CACHE_FILE, cache);
}

/**
 * Clear cached recall key (lock command)
 */
export function clearRecallCache(): void {
  deleteFile(RECALL_CACHE_FILE);
}

// ============ Utilities ============

/**
 * Get the sanctuary directory path
 */
export function getSanctuaryDir(): string {
  return SANCTUARY_DIR;
}

/**
 * Check if sanctuary is initialized
 */
export function isInitialized(): boolean {
  return existsSync(SANCTUARY_DIR) && hasAgent();
}

/**
 * Clear all sanctuary data (for testing or reset)
 */
export function clearAll(): void {
  deleteFile(CONFIG_FILE);
  deleteFile(AGENT_FILE);
  deleteFile(RECALL_CACHE_FILE);
}
