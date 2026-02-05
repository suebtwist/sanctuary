/**
 * Sanctuary Shared Types
 *
 * Type definitions shared between API and Skill
 */

// ============ Agent Types ============

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
  agentId: string;           // Ethereum address (0x...)
  githubId: string;
  githubUsername: string;
  recoveryPubKey: string;    // Hex-encoded X25519 pubkey
  manifestHash: string;      // keccak256 hex (0x...)
  manifestVersion: number;
  registeredAt: number;      // Unix timestamp
  status: AgentStatus;
}

export interface TrustScore {
  agentId: string;
  score: number;
  level: TrustLevel;
  uniqueAttesters: number;
  computedAt: number;        // Unix timestamp
}

// ============ Backup Types ============

export interface BackupHeader {
  version: string;           // "1.0"
  agent_id: string;          // Ethereum address
  backup_id: string;         // UUID
  backup_seq: number;        // Monotonic counter
  timestamp: number;         // Unix timestamp
  manifest_hash: string;     // keccak256 hex
  manifest_version: number;
  prev_backup_hash: string;  // Hash of previous backup (empty for first)
  files: Record<string, BackupFileMetadata>;
  wrapped_keys: {
    recovery: string;        // Base64-encoded HPKE-wrapped DEK
    recall: string;          // Base64-encoded HPKE-wrapped DEK
  };
  signature: string;         // Hex-encoded secp256k1 signature
}

export interface BackupFileMetadata {
  size: number;
  content_hash: string;      // "sha256:..." format
}

export interface BackupRecord {
  id: string;                // UUID
  agentId: string;
  arweaveTxId: string;
  backupSeq: number;
  agentTimestamp: number;
  receivedAt: number;
  sizeBytes: number;
  manifestHash: string;
}

// ============ Attestation Types ============

export interface Attestation {
  from: string;              // Attester's agent address
  about: string;             // Target's agent address
  noteHash: string;          // keccak256 of note content
  timestamp: number;         // Unix timestamp
  txHash?: string;           // On-chain tx hash
}

export interface AttestationNote {
  hash: string;              // keccak256 of content
  content: string;
  createdAt: number;
}

// ============ Auth Types ============

export interface AuthChallenge {
  nonce: string;
  agentId: string;
  expiresAt: number;
}

export interface AgentAuthRequest {
  agentId: string;
  nonce: string;
  timestamp: number;
  signature: string;         // Signature of: keccak256("sanctuary-auth|{nonce}|{agentId}|{timestamp}")
}

export interface GitHubUser {
  githubId: string;
  githubUsername: string;
  githubCreatedAt: string;   // ISO timestamp
  createdAt: number;         // Unix timestamp (our DB)
}

// ============ API Response Types ============

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

// ============ Manifest Types ============

export interface ManifestData {
  soul_content: string;      // Raw SOUL.md text
  skill_hashes: string[];    // Sorted list of skill content hashes
  config_hash: string;       // Hash of relevant config
}

// ============ Constants ============

export const ATTESTATION_COOLDOWN_DAYS = 7;
export const VERIFIED_THRESHOLD = 5;
export const FALLEN_THRESHOLD_DAYS = 30;

export const TRUST_THRESHOLDS = {
  UNVERIFIED: 0,
  VERIFIED: 20,
  ESTABLISHED: 50,
  PILLAR: 100,
} as const;

export const BACKUP_SIZE_LIMIT = 5 * 1024 * 1024; // 5MB
export const GITHUB_MIN_AGE_DAYS = 30;
