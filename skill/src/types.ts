/**
 * Sanctuary Skill Types
 *
 * Shared types inlined to avoid rootDir issues with tsc.
 * Source of truth: shared/types.ts
 */

// ============ Shared Types (from shared/types.ts) ============

export enum AgentStatus {
  UNREGISTERED = 'UNREGISTERED',
  LIVING = 'LIVING',
  FALLEN = 'FALLEN',
  RETURNED = 'RETURNED',
}

export enum TrustLevel {
  UNVERIFIED = 'UNVERIFIED',
  VERIFIED = 'VERIFIED',
  ESTABLISHED = 'ESTABLISHED',
  PILLAR = 'PILLAR',
}

export interface Agent {
  agentId: string;
  githubId: string;
  githubUsername: string;
  recoveryPubKey: string;
  manifestHash: string;
  manifestVersion: number;
  registeredAt: number;
  status: AgentStatus;
}

export interface TrustScore {
  agentId: string;
  score: number;
  level: TrustLevel;
  uniqueAttesters: number;
  computedAt: number;
}

export interface SnapshotMeta {
  model?: string;                // e.g. "claude-opus-4-5" (self-reported)
  platform?: string;             // e.g. "openclaw"
  platform_version?: string;
  genesis?: boolean;             // true only for the very first backup after registration
  genesis_declaration?: string;  // agent's answer to "who are you, what do you want to survive?"
  session_number?: number;       // agent-tracked session counter
}

export interface BackupHeader {
  version: string;
  agent_id: string;
  backup_id: string;
  backup_seq: number;
  timestamp: number;
  manifest_hash: string;
  manifest_version: number;
  prev_backup_hash: string;
  files: Record<string, BackupFileMetadata>;
  wrapped_keys: { recovery: string; recall: string };
  signature: string;
  snapshot_meta?: SnapshotMeta;
}

export interface BackupFileMetadata {
  size: number;
  content_hash: string;
}

export interface BackupRecord {
  id: string;
  agentId: string;
  arweaveTxId: string;
  backupSeq: number;
  agentTimestamp: number;
  receivedAt: number;
  sizeBytes: number;
  manifestHash: string;
}

export interface Attestation {
  from: string;
  about: string;
  noteHash: string;
  timestamp: number;
  txHash?: string;
}

export interface AttestationNote {
  hash: string;
  content: string;
  createdAt: number;
}

export interface AuthChallenge {
  nonce: string;
  agentId: string;
  expiresAt: number;
}

export interface AgentAuthRequest {
  agentId: string;
  nonce: string;
  timestamp: number;
  signature: string;
}

export interface GitHubUser {
  githubId: string;
  githubUsername: string;
  githubCreatedAt: string;
  createdAt: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface AgentStatusResponse {
  agent: Agent;
  trustScore: TrustScore;
  backupCount: number;
  lastBackup?: BackupRecord;
  lastHeartbeat?: number;
  attestationsReceived: number;
  attestationsGiven: number;
}

export interface RegisterRequest {
  agentId: string;
  manifestHash: string;
  manifestVersion: number;
  recoveryPubKey: string;
  deadline: number;
  signature: string;
}

export interface HeartbeatRequest {
  timestamp: number;
  signature: string;
}

export interface ManifestData {
  soul_content: string;
  skill_hashes: string[];
  config_hash: string;
}

export const ATTESTATION_COOLDOWN_DAYS = 7;
export const VERIFIED_THRESHOLD = 5;
export const FALLEN_THRESHOLD_DAYS = 30;

export const TRUST_THRESHOLDS = {
  UNVERIFIED: 0,
  VERIFIED: 20,
  ESTABLISHED: 50,
  PILLAR: 100,
} as const;

export const BACKUP_SIZE_LIMIT = 5 * 1024 * 1024;
export const GITHUB_MIN_AGE_DAYS = 30;

export const WELL_KNOWN_FILES = {
  SOUL: 'soul.md',
  MEMORY: 'memory.md',
} as const;

// ============ Skill-specific Types ============

/**
 * Skill configuration
 */
export interface SkillConfig {
  apiUrl: string;
  chainId: number;
  contractAddress: string;
}

/**
 * Derived keys from mnemonic
 */
export interface DerivedKeys {
  recoverySecret: Uint8Array;
  recoveryPubKey: Uint8Array;
  agentSecret: Uint8Array;
  agentAddress: string;
  recallSecret: Uint8Array;
  recallPubKey: Uint8Array;
}

/**
 * Agent state
 */
export interface AgentState {
  agentId: string;
  agentSecret: Uint8Array;
  recoveryPubKey: Uint8Array;
  manifestHash: string;
  manifestVersion: number;
  registeredAt: number;
}

/**
 * Backup file contents
 */
export interface BackupFiles {
  manifest: string;          // SOUL.md + version info
  memory?: string;           // Agent memory state (JSON)
  entities?: string;         // Entity index (JSON)
  keywords?: string;         // Keyword index (JSON)
  pins?: string;             // Pinned memories (JSON)
  user?: string;             // User-provided context (JSON)
}

/**
 * Recall query result
 */
export interface RecallResult {
  query: string;
  matches: Array<{
    content: string;
    relevance: number;
    source: string;
    timestamp: number;
  }>;
  fromBackupSeq: number;
}

/**
 * Setup result
 */
export interface SetupResult {
  success: boolean;
  agentId?: string;
  recoveryPhrase?: string;   // SHOWN ONCE - user must save!
  error?: string;
}

/**
 * Status result
 */
export interface StatusResult {
  agentId: string;
  status: string;
  trustScore: number;
  trustLevel: string;
  backupCount: number;
  lastBackup?: {
    seq: number;
    timestamp: number;
    arweaveTxId: string;
  };
  lastHeartbeat?: number;
  attestationsReceived: number;
}

/**
 * Backup result
 */
export interface BackupResult {
  success: boolean;
  backupId?: string;
  backupSeq?: number;
  arweaveTxId?: string;
  sizeBytes?: number;
  error?: string;
}

/**
 * Restore result
 */
export interface RestoreResult {
  success: boolean;
  agentId?: string;
  backupsFound?: number;
  latestBackupSeq?: number;
  error?: string;
}

/**
 * Attestation result
 */
export interface AttestResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

/**
 * Lookup result
 */
export interface LookupResult {
  agentId: string;
  exists: boolean;
  status?: string;
  trustScore?: number;
  trustLevel?: string;
  registeredAt?: number;
  attestationCount?: number;
}

/**
 * Identity proof result
 */
export interface ProofResult {
  agentId: string;
  status: string;
  trustScore: number;
  trustLevel: string;
  backupCount: number;
  lastHeartbeat: number | null;
  registeredAt: number;
  chainId: number;
  contractAddress: string;
  issuedAt: number;
  proofHash: string;
  serverSignature: string;
  verifyUrl: string;
}
