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

  // Database
  databasePath: string;

  // JWT
  jwtSecret: string;
  jwtTtlSeconds: number;

  // GitHub OAuth
  githubClientId: string;
  githubClientSecret: string;

  // Blockchain
  baseRpcUrl: string;
  contractAddress: string;
  ownerPrivateKey: string;

  // Arweave
  irysPrivateKey: string;
  irysNode: string;

  // Limits
  challengeTtlSeconds: number;
  githubMinAgeDays: number;
  backupSizeLimit: number;
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

    // Database
    databasePath: optionalEnv('DATABASE_PATH', './sanctuary.db'),

    // JWT
    jwtSecret: requireEnv('JWT_SECRET'),
    jwtTtlSeconds: optionalEnvInt('JWT_TTL_SECONDS', 86400), // 24 hours

    // GitHub OAuth
    githubClientId: requireEnv('GITHUB_CLIENT_ID'),
    githubClientSecret: requireEnv('GITHUB_CLIENT_SECRET'),

    // Blockchain
    baseRpcUrl: optionalEnv('BASE_RPC_URL', 'https://sepolia.base.org'),
    contractAddress: optionalEnv('CONTRACT_ADDRESS', ''),
    ownerPrivateKey: optionalEnv('OWNER_PRIVATE_KEY', ''),

    // Arweave
    irysPrivateKey: optionalEnv('IRYS_PRIVATE_KEY', ''),
    irysNode: optionalEnv('IRYS_NODE', 'https://node2.irys.xyz'),

    // Limits
    challengeTtlSeconds: optionalEnvInt('CHALLENGE_TTL_SECONDS', 300), // 5 minutes
    githubMinAgeDays: optionalEnvInt('GITHUB_MIN_AGE_DAYS', 30),
    backupSizeLimit: optionalEnvInt('BACKUP_SIZE_LIMIT', 5 * 1024 * 1024), // 5MB
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
    if (!config.ownerPrivateKey) {
      errors.push('OWNER_PRIVATE_KEY is required in production');
    }
    if (!config.irysPrivateKey) {
      errors.push('IRYS_PRIVATE_KEY is required in production');
    }
    if (config.jwtSecret.length < 32) {
      errors.push('JWT_SECRET should be at least 32 characters in production');
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
