/**
 * Sanctuary Verify — Express Router Factory
 *
 * Creates an Express router with endpoints to verify Sanctuary agent identities.
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { ethers } from 'ethers';
import { SanctuaryClient } from './client.js';
import type {
  SanctuaryVerifyOptions,
  VerifyResponse,
  TrustBreakdownResponse,
  ChallengeResponse,
  ChallengeVerifyResponse,
  ErrorResponse,
} from './types.js';

// In-memory challenge store with TTL
interface StoredChallenge {
  nonce: string;
  agentAddress: string;
  expiresAt: number;
}

const challenges = new Map<string, StoredChallenge>();

// Cleanup expired challenges periodically
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, challenge] of challenges) {
      if (challenge.expiresAt < now) {
        challenges.delete(key);
      }
    }
  }, 60_000); // every minute
  // Don't block process exit
  if (cleanupInterval.unref) cleanupInterval.unref();
}

function isValidEthAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Create a Sanctuary verification Express router
 */
export function sanctuaryRouter(options?: SanctuaryVerifyOptions): Router {
  const apiUrl = options?.apiUrl ?? 'https://sanctuary-ops.xyz';
  const timeout = options?.timeout ?? 10000;
  const challengeTtl = (options?.challengeTtl ?? 300) * 1000; // convert to ms

  const client = new SanctuaryClient(apiUrl, timeout);
  const router = Router();

  startCleanup();

  /**
   * GET /verify/:agent_address
   * Verify if an agent exists and is registered
   */
  router.get('/verify/:agent_address', async (req: Request, res: Response) => {
    const { agent_address } = req.params;

    if (!agent_address || !isValidEthAddress(agent_address)) {
      return res.status(400).json({
        error: 'Invalid agent address',
        details: 'Must be a valid Ethereum address (0x + 40 hex chars)',
      } satisfies ErrorResponse);
    }

    const status = await client.getAgentStatus(agent_address);

    if (!status) {
      return res.status(404).json({
        error: 'Agent not found or API unreachable',
      } satisfies ErrorResponse);
    }

    // Extract model from latest backup snapshot_meta if available
    let model: string | null = null;
    // The status endpoint doesn't return snapshot_meta directly,
    // so model info comes from the trust breakdown (model_stability signal)
    // We return null for model — callers can query the full status endpoint if needed

    const response: VerifyResponse = {
      verified: true,
      trust_score: status.trust.score,
      attestation_count: status.trust.unique_attesters,
      last_backup: status.backups.latest
        ? new Date(status.backups.latest.timestamp * 1000).toISOString()
        : null,
      model,
      tier: status.trust.level,
    };

    return res.json(response);
  });

  /**
   * GET /trust/:agent_address
   * Get detailed trust breakdown
   */
  router.get('/trust/:agent_address', async (req: Request, res: Response) => {
    const { agent_address } = req.params;

    if (!agent_address || !isValidEthAddress(agent_address)) {
      return res.status(400).json({
        error: 'Invalid agent address',
      } satisfies ErrorResponse);
    }

    const status = await client.getAgentStatus(agent_address);

    if (!status) {
      return res.status(404).json({
        error: 'Agent not found or API unreachable',
      } satisfies ErrorResponse);
    }

    const defaultBreakdown = {
      age: 0,
      backup_consistency: 0,
      attestations: 0,
      model_stability: 0,
      genesis_completeness: 0,
      recovery_resilience: 0,
    };

    const response: TrustBreakdownResponse = {
      trust_score: status.trust.score,
      breakdown: status.trust.breakdown ?? defaultBreakdown,
      tier: status.trust.level,
    };

    return res.json(response);
  });

  /**
   * POST /challenge/:agent_address
   * Generate a challenge nonce for agent to sign
   */
  router.post('/challenge/:agent_address', (req: Request, res: Response) => {
    const { agent_address } = req.params;

    if (!agent_address || !isValidEthAddress(agent_address)) {
      return res.status(400).json({
        error: 'Invalid agent address',
      } satisfies ErrorResponse);
    }

    const nonce = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + challengeTtl;

    challenges.set(nonce, {
      nonce,
      agentAddress: agent_address.toLowerCase(),
      expiresAt,
    });

    const response: ChallengeResponse = {
      challenge: nonce,
      expires: new Date(expiresAt).toISOString(),
    };

    return res.json(response);
  });

  /**
   * POST /respond
   * Verify agent's signed challenge
   */
  router.post('/respond', async (req: Request, res: Response) => {
    const { agent_address, challenge, signature } = req.body || {};

    if (!agent_address || !challenge || !signature) {
      return res.status(400).json({
        error: 'Missing required fields: agent_address, challenge, signature',
      } satisfies ErrorResponse);
    }

    if (!isValidEthAddress(agent_address)) {
      return res.status(400).json({
        error: 'Invalid agent address',
      } satisfies ErrorResponse);
    }

    // Look up challenge
    const stored = challenges.get(challenge);
    if (!stored) {
      return res.status(404).json({
        error: 'Challenge not found or expired',
      } satisfies ErrorResponse);
    }

    // Check expiry
    if (stored.expiresAt < Date.now()) {
      challenges.delete(challenge);
      return res.status(410).json({
        error: 'Challenge expired',
      } satisfies ErrorResponse);
    }

    // Check agent address matches
    if (stored.agentAddress !== agent_address.toLowerCase()) {
      return res.status(403).json({
        error: 'Challenge was issued for a different agent',
      } satisfies ErrorResponse);
    }

    // Verify signature using ethers (personal_sign / EIP-191)
    try {
      const recoveredAddress = ethers.verifyMessage(challenge, signature);

      if (recoveredAddress.toLowerCase() !== agent_address.toLowerCase()) {
        return res.status(403).json({
          error: 'Signature verification failed',
          details: 'Recovered address does not match agent_address',
        } satisfies ErrorResponse);
      }
    } catch {
      return res.status(400).json({
        error: 'Invalid signature format',
      } satisfies ErrorResponse);
    }

    // Clean up used challenge
    challenges.delete(challenge);

    const response: ChallengeVerifyResponse = {
      verified: true,
      agent_address: agent_address.toLowerCase(),
    };

    return res.json(response);
  });

  return router;
}

// Export for testing
export { challenges as _challenges };
