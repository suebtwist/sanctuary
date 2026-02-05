/**
 * Trust Score Calculator
 *
 * Computes trust scores for all agents using an iterative algorithm.
 * Should be run as a cron job (hourly).
 *
 * Score formula:
 * - Age points: 1 per month, max 12
 * - Backup points: 0.5 per backup, max 50
 * - Attestation weight: sum of attester scores * 0.1 (mutual weighted 0.5x)
 *
 * Trust levels:
 * - UNVERIFIED: < 20
 * - VERIFIED: 20-50
 * - ESTABLISHED: 50-100
 * - PILLAR: > 100
 */

import { ethers } from 'ethers';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';

// Sanctuary contract ABI (minimal for reading attestations)
const SANCTUARY_ABI = [
  'event Attested(address indexed from, address indexed about, bytes32 noteHash, uint256 timestamp)',
  'function attestationCount(address) external view returns (uint256)',
];

interface AgentTrustInput {
  agentId: string;
  registeredAt: number;
  backupCount: number;
}

interface Attestation {
  from: string;
  about: string;
  timestamp: number;
}

type TrustLevel = 'UNVERIFIED' | 'VERIFIED' | 'ESTABLISHED' | 'PILLAR';

/**
 * Get trust level from score
 */
function getTrustLevel(score: number): TrustLevel {
  if (score >= 100) return 'PILLAR';
  if (score >= 50) return 'ESTABLISHED';
  if (score >= 20) return 'VERIFIED';
  return 'UNVERIFIED';
}

/**
 * Calculate months since timestamp
 */
function monthsSince(timestamp: number): number {
  const now = Date.now() / 1000;
  const seconds = now - timestamp;
  return seconds / (30 * 24 * 60 * 60);
}

/**
 * Fetch attestation events from chain
 */
async function fetchAttestations(
  contractAddress: string,
  rpcUrl: string,
  fromBlock: number = 0
): Promise<Attestation[]> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(contractAddress, SANCTUARY_ABI, provider);

  const filter = contract.filters.Attested();
  const events = await contract.queryFilter(filter, fromBlock);

  return events.map(event => {
    const parsed = contract.interface.parseLog({
      topics: event.topics as string[],
      data: event.data,
    });

    return {
      from: parsed?.args[0] as string,
      about: parsed?.args[1] as string,
      timestamp: Number(parsed?.args[3] || 0),
    };
  });
}

/**
 * Compute trust scores for all agents
 *
 * Uses iterative algorithm (3 iterations) to propagate attestation weights.
 */
export async function computeAllTrustScores(options?: {
  useChain?: boolean;
  attestations?: Attestation[];
}): Promise<Map<string, { score: number; level: TrustLevel; uniqueAttesters: number }>> {
  const db = getDb();
  const config = getConfig();

  // Get all agents
  const agents = db.getAllAgents();
  const agentMap = new Map<string, AgentTrustInput>();

  for (const agent of agents) {
    agentMap.set(agent.agent_id.toLowerCase(), {
      agentId: agent.agent_id,
      registeredAt: agent.registered_at,
      backupCount: db.getBackupCount(agent.agent_id),
    });
  }

  // Get attestations
  let attestations: Attestation[] = options?.attestations || [];

  if (!options?.attestations && options?.useChain && config.contractAddress) {
    try {
      attestations = await fetchAttestations(config.contractAddress, config.baseRpcUrl);
    } catch (error) {
      console.error('Failed to fetch attestations from chain:', error);
    }
  }

  // Build attestation lookup
  const attestationsByTarget = new Map<string, Attestation[]>();
  for (const att of attestations) {
    const target = att.about.toLowerCase();
    if (!attestationsByTarget.has(target)) {
      attestationsByTarget.set(target, []);
    }
    attestationsByTarget.get(target)!.push(att);
  }

  // Initialize base scores
  const scores = new Map<string, number>();

  for (const [id, agent] of agentMap) {
    const ageMonths = Math.min(monthsSince(agent.registeredAt), 12);
    const backupScore = Math.min(agent.backupCount * 0.5, 50);
    scores.set(id, ageMonths + backupScore);
  }

  // Iterative attestation scoring (3 iterations)
  for (let iter = 0; iter < 3; iter++) {
    const newScores = new Map(scores);

    for (const [id] of agentMap) {
      const receivedAttestations = attestationsByTarget.get(id) || [];

      // Get unique attesters
      const uniqueAttesters = new Set(receivedAttestations.map(a => a.from.toLowerCase()));

      let attestationScore = 0;
      for (const attesterId of uniqueAttesters) {
        const attesterScore = scores.get(attesterId) || 0;

        // Check for mutual attestation (reduce weight)
        const attesterReceived = attestationsByTarget.get(attesterId) || [];
        const isMutual = attesterReceived.some(a => a.from.toLowerCase() === id);

        const weight = isMutual ? 0.5 : 1.0;
        attestationScore += attesterScore * 0.1 * weight;
      }

      const baseScore = scores.get(id) || 0;
      newScores.set(id, baseScore + attestationScore);
    }

    scores.clear();
    for (const [k, v] of newScores) scores.set(k, v);
  }

  // Build result
  const result = new Map<string, { score: number; level: TrustLevel; uniqueAttesters: number }>();

  for (const [id, agent] of agentMap) {
    const score = scores.get(id) || 0;
    const receivedAttestations = attestationsByTarget.get(id) || [];
    const uniqueAttesters = new Set(receivedAttestations.map(a => a.from.toLowerCase())).size;

    result.set(agent.agentId, {
      score,
      level: getTrustLevel(score),
      uniqueAttesters,
    });
  }

  return result;
}

/**
 * Update trust scores in database
 */
export async function updateTrustScores(options?: { useChain?: boolean }): Promise<number> {
  const db = getDb();
  const scores = await computeAllTrustScores(options);
  const now = Math.floor(Date.now() / 1000);

  let updated = 0;

  for (const [agentId, { score, level, uniqueAttesters }] of scores) {
    db.upsertTrustScore({
      agent_id: agentId,
      score,
      level,
      unique_attesters: uniqueAttesters,
      computed_at: now,
    });
    updated++;
  }

  return updated;
}

/**
 * Job to detect fallen agents (no heartbeat in 30 days)
 */
export async function detectFallenAgents(): Promise<string[]> {
  const db = getDb();
  const FALLEN_THRESHOLD_SECONDS = 30 * 24 * 60 * 60; // 30 days

  const candidates = db.getAgentsWithoutRecentHeartbeat(FALLEN_THRESHOLD_SECONDS);
  const fallen: string[] = [];

  for (const agent of candidates) {
    if (agent.status === 'LIVING') {
      // Mark as fallen in our DB (actual on-chain update requires owner tx)
      db.updateAgentStatus(agent.agent_id, 'FALLEN');
      fallen.push(agent.agent_id);
    }
  }

  return fallen;
}
