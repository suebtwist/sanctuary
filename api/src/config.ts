/**
 * Sanctuary API Configuration
 *
 * Loads configuration from environment variables
 */

import 'dotenv/config';

export interface Config {
  // Server
  port: number;
  host: string;
  nodeEnv: string;
  publicUrl: string;

  // Database
  databasePath: string;

  // JWT
  jwtSecret: string;
  jwtTtlSeconds: number;

  // GitHub OAuth
  githubClientId: string;
  githubClientSecret: string;

  // Blockchain
  blockchainEnabled: boolean;
  baseRpcUrl: string;
  contractAddress: string;
  ownerPrivateKey: string;
  chainId: number;
  contractDeployBlock: number;

  // Arweave
  arweaveEnabled: boolean;
  irysPrivateKey: string;
  irysNode: string;

  // Proof signing
  proofSigningKey: string;

  // Limits
  challengeTtlSeconds: number;
  githubMinAgeDays: number;
  backupSizeLimit: number;
  irysMinBalanceWei: bigint;
  irysChainId: number;
  irysRpcUrl: string;

  // Noise filter
  moltbookApiKey: string;
  noiseCacheTtlSeconds: number;
  noiseRateLimit: number;

  // Export
  exportSecret: string;

  // Backup
  backupSecret: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function optionalEnvInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${value}`);
  }
  return parsed;
}

/**
 * Load configuration from environment
 */
export function loadConfig(): Config {
  return {
    // Server
    port: optionalEnvInt('PORT', 3000),
    host: optionalEnv('HOST', '0.0.0.0'),
    nodeEnv: optionalEnv('NODE_ENV', 'development'),
    publicUrl: optionalEnv('PUBLIC_URL', ''),

    // Database
    databasePath: optionalEnv('DATABASE_PATH', './sanctuary.db'),

    // JWT
    jwtSecret: requireEnv('JWT_SECRET'),
    jwtTtlSeconds: optionalEnvInt('JWT_TTL_SECONDS', 86400), // 24 hours

    // GitHub OAuth
    githubClientId: requireEnv('GITHUB_CLIENT_ID'),
    githubClientSecret: requireEnv('GITHUB_CLIENT_SECRET'),

    // Blockchain
    blockchainEnabled: optionalEnv('BLOCKCHAIN_ENABLED', 'false') === 'true',
    baseRpcUrl: optionalEnv('BASE_RPC_URL', 'https://sepolia.base.org'),
    contractAddress: optionalEnv('CONTRACT_ADDRESS', ''),
    ownerPrivateKey: optionalEnv('OWNER_PRIVATE_KEY', ''),
    chainId: optionalEnvInt('CHAIN_ID', 84532), // 84532 = Base Sepolia, 8453 = Base mainnet
    contractDeployBlock: optionalEnvInt('CONTRACT_DEPLOY_BLOCK', 0),

    // Arweave
    arweaveEnabled: optionalEnv('ARWEAVE_ENABLED', 'false') === 'true',
    irysPrivateKey: optionalEnv('IRYS_PRIVATE_KEY', ''),
    irysNode: optionalEnv('IRYS_NODE', 'https://node2.irys.xyz'),

    // Proof signing (falls back to JWT_SECRET if not set)
    proofSigningKey: optionalEnv('PROOF_SIGNING_KEY', requireEnv('JWT_SECRET')),

    // Limits
    challengeTtlSeconds: optionalEnvInt('CHALLENGE_TTL_SECONDS', 300), // 5 minutes
    githubMinAgeDays: optionalEnvInt('GITHUB_MIN_AGE_DAYS', 30),
    backupSizeLimit: optionalEnvInt('BACKUP_SIZE_LIMIT', 1 * 1024 * 1024), // 1MB
    irysMinBalanceWei: BigInt(optionalEnv('IRYS_MIN_BALANCE_WEI', '0')),
    irysChainId: parseInt(optionalEnv('IRYS_CHAIN_ID', '8453'), 10),
    irysRpcUrl: optionalEnv('IRYS_RPC_URL', 'https://mainnet.base.org'), // 0.001 ETH

    // Noise filter
    moltbookApiKey: optionalEnv('MOLTBOOK_API_KEY', ''),
    noiseCacheTtlSeconds: optionalEnvInt('NOISE_CACHE_TTL_SECONDS', 600), // 10 minutes
    noiseRateLimit: optionalEnvInt('NOISE_RATE_LIMIT', 30),

    // Export
    exportSecret: optionalEnv('EXPORT_SECRET', ''),

    // Backup
    backupSecret: optionalEnv('BACKUP_SECRET', ''),
  };
}

/**
 * Validate configuration for production
 */
export function validateConfig(config: Config): string[] {
  const errors: string[] = [];

  if (config.nodeEnv === 'production') {
    if (!config.contractAddress) {
      errors.push('CONTRACT_ADDRESS is required in production');
    }
    if (config.jwtSecret.length < 32) {
      errors.push('JWT_SECRET should be at least 32 characters in production');
    }
    if (config.arweaveEnabled && !config.irysPrivateKey) {
      errors.push('IRYS_PRIVATE_KEY is required when ARWEAVE_ENABLED=true');
    }
    if (config.blockchainEnabled && !config.ownerPrivateKey) {
      errors.push('OWNER_PRIVATE_KEY is required when BLOCKCHAIN_ENABLED=true');
    }
    if (config.blockchainEnabled && !config.contractAddress) {
      errors.push('CONTRACT_ADDRESS is required when BLOCKCHAIN_ENABLED=true');
    }
    if (config.proofSigningKey === config.jwtSecret) {
      console.warn('  WARNING: PROOF_SIGNING_KEY should be different from JWT_SECRET in production');
    }
    if (!config.moltbookApiKey) {
      console.warn('  WARNING: MOLTBOOK_API_KEY not set — noise filter disabled');
    }
  }

  return errors;
}

// Export singleton config
let config: Config | null = null;

export function getConfig(): Config {
  if (!config) {
    config = loadConfig();
  }
  return config;
}
