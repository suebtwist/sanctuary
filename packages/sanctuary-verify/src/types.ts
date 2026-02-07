/**
 * Sanctuary Verify — Response Types
 */

export interface VerifyResponse {
  verified: boolean;
  trust_score: number;
  attestation_count: number;
  last_backup: string | null;
  model: string | null;
  tier: string;
}

export interface TrustBreakdownResponse {
  trust_score: number;
  breakdown: {
    age: number;
    backup_consistency: number;
    attestations: number;
    model_stability: number;
    genesis_completeness: number;
    recovery_resilience: number;
  };
  tier: string;
}

export interface ChallengeResponse {
  challenge: string;
  expires: string;
}

export interface ChallengeVerifyResponse {
  verified: boolean;
  agent_address: string;
}

export interface SanctuaryVerifyOptions {
  /** Sanctuary API base URL (default: https://sanctuary-ops.xyz) */
  apiUrl?: string;
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
  /** Challenge TTL in seconds (default: 300 = 5 minutes) */
  challengeTtl?: number;
}

export interface ErrorResponse {
  error: string;
  details?: string;
}
