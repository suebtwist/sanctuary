/**
 * Trust Score Calculator v2
 *
 * Computes trust scores using multiple behavioral signals:
 * - age:                 Time since registration (weight: 0.20)
 * - backup_consistency:  Regular backup cadence (weight: 0.25)
 * - attestation:         PageRank-lite attestation scoring (weight: 0.30)
 * - model_stability:     Consistency of model usage (weight: 0.10)
 * - genesis_completeness: Declaration + first backup + attestation seed (weight: 0.05)
 * - recovery_resilience: Successful resurrections vs instability (weight: 0.10)
 *
 * Each signal returns a value in [0, 1] (except attestation which uses the
 * existing iterative scoring, then normalized).
 *
 * Trust levels:
 * - UNVERIFIED:   < 20
 * - VERIFIED:     20-50
 * - ESTABLISHED:  50-100
 * - PILLAR:       > 100
 */

import { ethers } from 'ethers';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';
import type { DbBackup, DbAgent } from '../db/index.js';

// ============ Types ============

export interface TrustBreakdown {
  age: number;
  backup_consistency: number;
  attestations: number;
  model_stability: number;
  genesis_completeness: number;
  recovery_resilience: number;
}

export interface TrustWeights {
  age: number;
  backup_consistency: number;
  attestations: number;
  model_stability: number;
  genesis_completeness: number;
  recovery_resilience: number;
}

export interface TrustResult {
  score: number;
  level: TrustLevel;
  uniqueAttesters: number;
  breakdown: TrustBreakdown;
}

type TrustLevel = 'UNVERIFIED' | 'VERIFIED' | 'ESTABLISHED' | 'PILLAR';

interface Attestation {
  from: string;
  about: string;
  timestamp: number;
}

// ============ Configuration ============

/** Default weights — sum to 1.0 */
export const DEFAULT_WEIGHTS: TrustWeights = {
  age: 0.20,
  backup_consistency: 0.25,
  attestations: 0.30,
  model_stability: 0.10,
  genesis_completeness: 0.05,
  recovery_resilience: 0.10,
};

/** Maximum raw score (used to scale weighted [0,1] signals to the legacy score range) */
const MAX_RAW_SCORE = 150;

/** Expected backup rate: 1 per day */
const EXPECTED_BACKUPS_PER_DAY = 1;

/** Gap threshold: >7 days with no backup reduces consistency */
const BACKUP_GAP_THRESHOLD_DAYS = 7;

// ============ Helpers ============

/**
 * Get trust level from score
 */
export function getTrustLevel(score: number): TrustLevel {
  if (score >= 100) return 'PILLAR';
  if (score >= 50) return 'ESTABLISHED';
  if (score >= 20) return 'VERIFIED';
  return 'UNVERIFIED';
}

/**
 * Calculate days since timestamp
 */
function daysSince(timestamp: number, now?: number): number {
  const currentTime = now ?? Date.now() / 1000;
  return Math.max(0, (currentTime - timestamp) / (24 * 60 * 60));
}

// ============ Signal Functions ============

/**
 * Age signal: proportion of time registered, capped at 12 months
 * Returns [0, 1]
 */
export function calcAgeScore(registeredAt: number, now?: number): number {
  const months = daysSince(registeredAt, now) / 30;
  return Math.min(months / 12, 1.0);
}

/**
 * Backup consistency signal
 *
 * score = (actual / expected) capped at 1.0
 * Penalized by gaps >7 days
 * Ignores consecutive snapshots with identical manifest_hash (anti-gaming)
 *
 * Returns [0, 1]
 */
export function calcBackupConsistency(
  backups: Array<{ agent_timestamp: number; manifest_hash: string }>,
  registeredAt: number,
  now?: number
): number {
  const currentTime = now ?? Math.floor(Date.now() / 1000);
  const ageDays = daysSince(registeredAt, currentTime);

  if (ageDays < 1) return 0;

  // Filter out consecutive duplicates (same manifest_hash)
  const meaningful: typeof backups = [];
  for (const b of backups) {
    if (meaningful.length === 0 || meaningful[meaningful.length - 1]!.manifest_hash !== b.manifest_hash) {
      meaningful.push(b);
    }
  }

  const expected = Math.max(ageDays * EXPECTED_BACKUPS_PER_DAY, 1);
  let baseScore = Math.min(meaningful.length / expected, 1.0);

  // Check for gaps >7 days
  if (meaningful.length >= 2) {
    const sorted = [...meaningful].sort((a, b) => a.agent_timestamp - b.agent_timestamp);
    let gapPenalty = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gapDays = (sorted[i]!.agent_timestamp - sorted[i - 1]!.agent_timestamp) / (24 * 60 * 60);
      if (gapDays > BACKUP_GAP_THRESHOLD_DAYS) {
        gapPenalty += 0.1; // -0.1 per gap
      }
    }
    baseScore = Math.max(0, baseScore - gapPenalty);
  }

  return Math.min(Math.max(baseScore, 0), 1.0);
}

/**
 * Model stability signal
 *
 * score = days_on_current_model / total_days_active, capped at 1.0
 * If no model data: neutral 0.5
 *
 * Returns [0, 1]
 */
export function calcModelStability(
  backups: Array<{ agent_timestamp: number; snapshot_meta?: string }>,
  registeredAt: number,
  now?: number
): number {
  const currentTime = now ?? Math.floor(Date.now() / 1000);
  const totalDays = daysSince(registeredAt, currentTime);

  if (totalDays < 1) return 0.5;

  // Extract model from snapshot_meta
  const modelsOverTime: Array<{ timestamp: number; model: string }> = [];
  for (const b of backups) {
    if (b.snapshot_meta) {
      try {
        const meta = JSON.parse(b.snapshot_meta);
        if (meta.model) {
          modelsOverTime.push({ timestamp: b.agent_timestamp, model: meta.model });
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  if (modelsOverTime.length === 0) return 0.5; // neutral if no model data

  // Sort by timestamp ascending
  modelsOverTime.sort((a, b) => a.timestamp - b.timestamp);

  // Find current model (latest)
  const currentModel = modelsOverTime[modelsOverTime.length - 1]!.model;

  // Find first appearance of current model
  let firstAppearance = currentTime;
  for (const entry of modelsOverTime) {
    if (entry.model === currentModel) {
      firstAppearance = entry.timestamp;
      break;
    }
  }

  const daysOnCurrent = daysSince(firstAppearance, currentTime);
  return Math.min(daysOnCurrent / totalDays, 1.0);
}

/**
 * Genesis completeness signal
 *
 * declaration provided: +0.4
 * first backup completed: +0.3
 * attestation seeded: +0.3
 *
 * Returns [0, 1]
 */
export function calcGenesisCompleteness(
  agent: { genesis_declaration?: string },
  backupCount: number,
  attestationCount: number
): number {
  let score = 0;

  if (agent.genesis_declaration) {
    score += 0.4;
  }

  if (backupCount > 0) {
    score += 0.3;
  }

  if (attestationCount > 0) {
    score += 0.3;
  }

  return score;
}

/**
 * Recovery resilience signal
 *
 * base: 0.5
 * +0.25 per successful resurrection (max 1.0)
 * -0.2 per resurrection beyond 3 in rolling 30 days (instability signal)
 *
 * Returns [0, 1]
 */
export function calcRecoveryResilience(
  totalResurrections: number,
  recentResurrections: number // in rolling 30 days
): number {
  // Base + bonus for successful resurrections
  let score = 0.5 + Math.min(totalResurrections * 0.25, 0.5);

  // Penalty for instability (>3 in 30 days)
  if (recentResurrections > 3) {
    score -= (recentResurrections - 3) * 0.2;
  }

  return Math.min(Math.max(score, 0), 1.0);
}

// ============ Attestation Scoring (PageRank-lite) ============

// Sanctuary contract ABI (minimal for reading attestations)
const SANCTUARY_ABI = [
  'event Attested(address indexed from, address indexed about, bytes32 noteHash, uint256 timestamp)',
  'function attestationCount(address) external view returns (uint256)',
];

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
 * Compute attestation scores using iterative PageRank-lite (3 passes)
 *
 * Returns raw attestation score per agent (NOT normalized to [0,1]).
 * The combined score function normalizes it.
 */
export function computeAttestationScores(
  agentIds: string[],
  attestations: Attestation[]
): Map<string, { rawScore: number; uniqueAttesters: number }> {
  // Build attestation lookup
  const attestationsByTarget = new Map<string, Attestation[]>();
  for (const att of attestations) {
    const target = att.about.toLowerCase();
    if (!attestationsByTarget.has(target)) {
      attestationsByTarget.set(target, []);
    }
    attestationsByTarget.get(target)!.push(att);
  }

  // Initialize with base score of 1 for each agent
  const scores = new Map<string, number>();
  for (const id of agentIds) {
    scores.set(id.toLowerCase(), 1);
  }

  // Iterative attestation scoring (3 iterations)
  for (let iter = 0; iter < 3; iter++) {
    const newScores = new Map(scores);

    for (const id of agentIds) {
      const lowerId = id.toLowerCase();
      const receivedAttestations = attestationsByTarget.get(lowerId) || [];
      const uniqueAttesters = new Set(receivedAttestations.map(a => a.from.toLowerCase()));

      let attestationScore = 0;
      for (const attesterId of uniqueAttesters) {
        const attesterScore = scores.get(attesterId) || 0;
        const attesterReceived = attestationsByTarget.get(attesterId) || [];
        const isMutual = attesterReceived.some(a => a.from.toLowerCase() === lowerId);
        const weight = isMutual ? 0.5 : 1.0;
        attestationScore += attesterScore * 0.1 * weight;
      }

      newScores.set(lowerId, (scores.get(lowerId) || 0) + attestationScore);
    }

    scores.clear();
    for (const [k, v] of newScores) scores.set(k, v);
  }

  // Build result
  const result = new Map<string, { rawScore: number; uniqueAttesters: number }>();
  for (const id of agentIds) {
    const lowerId = id.toLowerCase();
    const receivedAttestations = attestationsByTarget.get(lowerId) || [];
    const uniqueAttesters = new Set(receivedAttestations.map(a => a.from.toLowerCase())).size;

    result.set(id, {
      rawScore: (scores.get(lowerId) || 0) - 1, // subtract initial base
      uniqueAttesters,
    });
  }

  return result;
}

// ============ Combined Score ============

/**
 * Compute trust score for a single agent with full breakdown
 */
export function computeTrustScore(
  agent: DbAgent,
  backups: DbBackup[],
  attestationResult: { rawScore: number; uniqueAttesters: number },
  totalResurrections: number,
  recentResurrections: number,
  weights: TrustWeights = DEFAULT_WEIGHTS,
  now?: number
): TrustResult {
  const breakdown: TrustBreakdown = {
    age: calcAgeScore(agent.registered_at, now),
    backup_consistency: calcBackupConsistency(
      backups.map(b => ({ agent_timestamp: b.agent_timestamp, manifest_hash: b.manifest_hash })),
      agent.registered_at,
      now
    ),
    attestations: Math.min(attestationResult.rawScore / 10, 1.0), // normalize: 10 raw = 1.0
    model_stability: calcModelStability(
      backups.map(b => ({ agent_timestamp: b.agent_timestamp, snapshot_meta: b.snapshot_meta })),
      agent.registered_at,
      now
    ),
    genesis_completeness: calcGenesisCompleteness(
      agent,
      backups.length,
      attestationResult.uniqueAttesters
    ),
    recovery_resilience: calcRecoveryResilience(totalResurrections, recentResurrections),
  };

  // Weighted sum of [0,1] signals, scaled to legacy range
  const weightedSum =
    breakdown.age * weights.age +
    breakdown.backup_consistency * weights.backup_consistency +
    breakdown.attestations * weights.attestations +
    breakdown.model_stability * weights.model_stability +
    breakdown.genesis_completeness * weights.genesis_completeness +
    breakdown.recovery_resilience * weights.recovery_resilience;

  const score = weightedSum * MAX_RAW_SCORE;

  return {
    score,
    level: getTrustLevel(score),
    uniqueAttesters: attestationResult.uniqueAttesters,
    breakdown,
  };
}

// ============ Batch Computation ============

/**
 * Compute trust scores for all agents
 */
export async function computeAllTrustScores(options?: {
  useChain?: boolean;
  attestations?: Attestation[];
  weights?: TrustWeights;
  now?: number;
}): Promise<Map<string, TrustResult>> {
  const db = getDb();
  const config = getConfig();
  const weights = options?.weights ?? DEFAULT_WEIGHTS;
  const now = options?.now;

  const agents = db.getAllAgents();

  // Get attestations
  let attestations: Attestation[] = options?.attestations || [];
  if (!options?.attestations && options?.useChain && config.contractAddress) {
    try {
      attestations = await fetchAttestations(config.contractAddress, config.baseRpcUrl);
    } catch (error) {
      console.error('Failed to fetch attestations from chain:', error);
    }
  }

  // Compute attestation scores for all agents at once
  const agentIds = agents.map(a => a.agent_id);
  const attestationScores = computeAttestationScores(agentIds, attestations);

  // Compute per-agent scores
  const result = new Map<string, TrustResult>();

  for (const agent of agents) {
    const backups = db.getBackupsByAgent(agent.agent_id, 1000);
    const attestation = attestationScores.get(agent.agent_id) || { rawScore: 0, uniqueAttesters: 0 };
    const totalResurrections = db.getResurrectionCount(agent.agent_id);
    const recentResurrections = db.getResurrectionCount(agent.agent_id, 30);

    const trustResult = computeTrustScore(
      agent,
      backups,
      attestation,
      totalResurrections,
      recentResurrections,
      weights,
      now
    );

    result.set(agent.agent_id, trustResult);
  }

  return result;
}

/**
 * Recompute trust score for a single agent and update DB
 */
export async function recomputeAgentTrust(
  agentId: string,
  options?: { attestations?: Attestation[]; weights?: TrustWeights; now?: number }
): Promise<TrustResult | null> {
  const db = getDb();
  const agent = db.getAgent(agentId);
  if (!agent) return null;

  const weights = options?.weights ?? DEFAULT_WEIGHTS;

  // When no attestations provided, preserve existing DB attestation data
  // instead of zeroing the signal (which has 30% weight).
  let attestation: { rawScore: number; uniqueAttesters: number };
  if (options?.attestations) {
    const attestationScores = computeAttestationScores([agentId], options.attestations);
    attestation = attestationScores.get(agentId) || { rawScore: 0, uniqueAttesters: 0 };
  } else {
    const existing = db.getTrustScore(agentId);
    if (existing && existing.breakdown) {
      try {
        const bd = JSON.parse(existing.breakdown) as TrustBreakdown;
        // Reverse-engineer raw attestation score from normalized value
        attestation = {
          rawScore: bd.attestations * 10, // normalized = rawScore / 10
          uniqueAttesters: existing.unique_attesters,
        };
      } catch {
        attestation = { rawScore: 0, uniqueAttesters: 0 };
      }
    } else {
      attestation = { rawScore: 0, uniqueAttesters: 0 };
    }
  }

  const backups = db.getBackupsByAgent(agentId, 1000);
  const totalResurrections = db.getResurrectionCount(agentId);
  const recentResurrections = db.getResurrectionCount(agentId, 30);

  const result = computeTrustScore(
    agent,
    backups,
    attestation,
    totalResurrections,
    recentResurrections,
    weights,
    options?.now
  );

  const now = Math.floor(Date.now() / 1000);
  db.upsertTrustScore({
    agent_id: agentId,
    score: result.score,
    level: result.level,
    unique_attesters: result.uniqueAttesters,
    computed_at: now,
    breakdown: JSON.stringify(result.breakdown),
  });

  return result;
}

// ============ Persistence ============

/**
 * Update trust scores in database for all agents
 */
export async function updateTrustScores(options?: {
  useChain?: boolean;
  weights?: TrustWeights;
}): Promise<number> {
  const db = getDb();
  const scores = await computeAllTrustScores(options);
  const now = Math.floor(Date.now() / 1000);

  let updated = 0;

  for (const [agentId, result] of scores) {
    db.upsertTrustScore({
      agent_id: agentId,
      score: result.score,
      level: result.level,
      unique_attesters: result.uniqueAttesters,
      computed_at: now,
      breakdown: JSON.stringify(result.breakdown),
    });
    updated++;
  }

  return updated;
}

// ============ Fallen Detection ============

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
      db.updateAgentStatus(agent.agent_id, 'FALLEN');
      fallen.push(agent.agent_id);
    }
  }

  return fallen;
}
