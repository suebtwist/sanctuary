/**
 * Sanctuary Shared Constants
 */

// ============ Contract Constants ============

export const CONTRACT_NAME = 'Sanctuary';
export const CONTRACT_VERSION = '1';

// EIP-712 Type Hashes (must match Solidity contract)
export const REGISTER_TYPEHASH =
  'Register(address agentId,bytes32 manifestHash,uint16 manifestVersion,bytes32 recoveryPubKey,uint256 nonce,uint256 deadline)';

export const ATTEST_TYPEHASH =
  'Attest(address from,address about,bytes32 noteHash,uint256 nonce,uint256 deadline)';

// ============ Crypto Constants ============

// Key derivation contexts (HKDF info strings)
export const HKDF_CONTEXT = {
  RECOVERY: 'sanctuary-recovery-v1',
  AGENT: 'sanctuary-agent-v1',
  RECALL: 'sanctuary-recall-v1',
  FILE_PREFIX: 'sanctuary-file-',
} as const;

// Encryption
export const ENCRYPTION_VERSION = '1.0';
export const AAD_PREFIX = 'sanctuary|v1';

// ============ API Constants ============

export const API_VERSION = '1.0';

// Auth
export const CHALLENGE_TTL_SECONDS = 300; // 5 minutes
export const JWT_TTL_SECONDS = 86400;     // 24 hours
export const AUTH_SIGNATURE_PREFIX = 'sanctuary-auth';

// Rate limits
export const RATE_LIMITS = {
  HEARTBEAT: { max: 10, window: '1 minute' },
  BACKUP: { max: 1, window: '1 day' },
  REGISTER: { max: 3, window: '1 hour' },
  ATTEST: { max: 10, window: '1 hour' },
} as const;

// ============ Arweave Constants ============

export const ARWEAVE_TAGS = {
  APP_NAME: 'Sanctuary',
  APP_VERSION: '1.0',
  TYPE_BACKUP: 'Backup',
} as const;

export const ARWEAVE_GATEWAY = 'https://arweave.net';
export const ARWEAVE_GRAPHQL = 'https://arweave.net/graphql';

// ============ Time Constants ============

export const SECONDS_PER_DAY = 86400;
export const SECONDS_PER_WEEK = 604800;

export const ATTESTATION_COOLDOWN_SECONDS = 7 * SECONDS_PER_DAY;
export const FALLEN_THRESHOLD_SECONDS = 30 * SECONDS_PER_DAY;

// ============ Backup Constants ============

export const BACKUP_FILES = {
  HEADER: 'header.json',
  MANIFEST: 'manifest.json',
  MEMORY: 'memory.json',
  ENTITIES: 'entities.json',
  KEYWORDS: 'keywords.json',
  PINS: 'pins.json',
  USER: 'user.json',
} as const;

// File extension for encrypted files
export const ENCRYPTED_EXTENSION = '.enc';
