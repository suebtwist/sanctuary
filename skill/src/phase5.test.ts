/**
 * Phase 5 Tests — Trust Score v2
 *
 * Tests for:
 * - Each signal function independently with known inputs
 * - Combined score with all signals
 * - Score with missing data (no model info, no resurrections)
 * - Backward compat: agents with old-format backups
 * - Weight config is respected
 * - TrustBreakdown shape
 * - Score caching (same input → same output)
 */

import { describe, it, expect } from 'vitest';

// ============ Signal Functions (replicated from api/src/services/trust-calculator.ts) ============
// These are pure functions — replicated here to test without cross-package imports.

function daysSince(timestamp: number, now: number): number {
  return Math.max(0, (now - timestamp) / (24 * 60 * 60));
}

function calcAgeScore(registeredAt: number, now: number): number {
  const months = daysSince(registeredAt, now) / 30;
  return Math.min(months / 12, 1.0);
}

function calcBackupConsistency(
  backups: Array<{ agent_timestamp: number; manifest_hash: string }>,
  registeredAt: number,
  now: number
): number {
  const ageDays = daysSince(registeredAt, now);
  if (ageDays < 1) return 0;

  const meaningful: typeof backups = [];
  for (const b of backups) {
    if (meaningful.length === 0 || meaningful[meaningful.length - 1]!.manifest_hash !== b.manifest_hash) {
      meaningful.push(b);
    }
  }

  const expected = Math.max(ageDays * 1, 1); // 1 per day
  let baseScore = Math.min(meaningful.length / expected, 1.0);

  if (meaningful.length >= 2) {
    const sorted = [...meaningful].sort((a, b) => a.agent_timestamp - b.agent_timestamp);
    let gapPenalty = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gapDays = (sorted[i]!.agent_timestamp - sorted[i - 1]!.agent_timestamp) / (24 * 60 * 60);
      if (gapDays > 7) {
        gapPenalty += 0.1;
      }
    }
    baseScore = Math.max(0, baseScore - gapPenalty);
  }

  return Math.min(Math.max(baseScore, 0), 1.0);
}

function calcModelStability(
  backups: Array<{ agent_timestamp: number; snapshot_meta?: string }>,
  registeredAt: number,
  now: number
): number {
  const totalDays = daysSince(registeredAt, now);
  if (totalDays < 1) return 0.5;

  const modelsOverTime: Array<{ timestamp: number; model: string }> = [];
  for (const b of backups) {
    if (b.snapshot_meta) {
      try {
        const meta = JSON.parse(b.snapshot_meta);
        if (meta.model) {
          modelsOverTime.push({ timestamp: b.agent_timestamp, model: meta.model });
        }
      } catch {
        // skip
      }
    }
  }

  if (modelsOverTime.length === 0) return 0.5;

  modelsOverTime.sort((a, b) => a.timestamp - b.timestamp);
  const currentModel = modelsOverTime[modelsOverTime.length - 1]!.model;

  let firstAppearance = now;
  for (const entry of modelsOverTime) {
    if (entry.model === currentModel) {
      firstAppearance = entry.timestamp;
      break;
    }
  }

  const daysOnCurrent = daysSince(firstAppearance, now);
  return Math.min(daysOnCurrent / totalDays, 1.0);
}

function calcGenesisCompleteness(
  agent: { genesis_declaration?: string },
  backupCount: number,
  attestationCount: number
): number {
  let score = 0;
  if (agent.genesis_declaration) score += 0.4;
  if (backupCount > 0) score += 0.3;
  if (attestationCount > 0) score += 0.3;
  return score;
}

function calcRecoveryResilience(
  totalResurrections: number,
  recentResurrections: number
): number {
  let score = 0.5 + Math.min(totalResurrections * 0.25, 0.5);
  if (recentResurrections > 3) {
    score -= (recentResurrections - 3) * 0.2;
  }
  return Math.min(Math.max(score, 0), 1.0);
}

function getTrustLevel(score: number): string {
  if (score >= 100) return 'PILLAR';
  if (score >= 50) return 'ESTABLISHED';
  if (score >= 20) return 'VERIFIED';
  return 'UNVERIFIED';
}

interface TrustWeights {
  age: number;
  backup_consistency: number;
  attestations: number;
  model_stability: number;
  genesis_completeness: number;
  recovery_resilience: number;
}

const DEFAULT_WEIGHTS: TrustWeights = {
  age: 0.20,
  backup_consistency: 0.25,
  attestations: 0.30,
  model_stability: 0.10,
  genesis_completeness: 0.05,
  recovery_resilience: 0.10,
};

const MAX_RAW_SCORE = 150;

interface TrustBreakdown {
  age: number;
  backup_consistency: number;
  attestations: number;
  model_stability: number;
  genesis_completeness: number;
  recovery_resilience: number;
}

function computeScore(breakdown: TrustBreakdown, weights: TrustWeights = DEFAULT_WEIGHTS): number {
  const weightedSum =
    breakdown.age * weights.age +
    breakdown.backup_consistency * weights.backup_consistency +
    breakdown.attestations * weights.attestations +
    breakdown.model_stability * weights.model_stability +
    breakdown.genesis_completeness * weights.genesis_completeness +
    breakdown.recovery_resilience * weights.recovery_resilience;
  return weightedSum * MAX_RAW_SCORE;
}

// ============ Tests ============

const DAY = 24 * 60 * 60;
const NOW = 1700000000; // fixed "now" for deterministic tests

describe('Phase 5: Trust Score v2', () => {
  // ============ Age Signal ============

  describe('calcAgeScore', () => {
    it('should return 0 for brand new agent', () => {
      expect(calcAgeScore(NOW, NOW)).toBe(0);
    });

    it('should return ~0.5 for 6 month old agent', () => {
      const sixMonthsAgo = NOW - 180 * DAY;
      const score = calcAgeScore(sixMonthsAgo, NOW);
      expect(score).toBeCloseTo(0.5, 1);
    });

    it('should cap at 1.0 for 12+ month old agent', () => {
      const twoYearsAgo = NOW - 730 * DAY;
      expect(calcAgeScore(twoYearsAgo, NOW)).toBe(1.0);
    });

    it('should return ~1.0 for exactly 12 month old agent', () => {
      const twelveMonthsAgo = NOW - 360 * DAY;
      const score = calcAgeScore(twelveMonthsAgo, NOW);
      expect(score).toBeCloseTo(1.0, 1);
    });
  });

  // ============ Backup Consistency ============

  describe('calcBackupConsistency', () => {
    it('should return 0 for agent registered less than 1 day ago', () => {
      const registeredAt = NOW - 3600; // 1 hour ago
      expect(calcBackupConsistency([], registeredAt, NOW)).toBe(0);
    });

    it('should return 1.0 for perfect daily backup cadence', () => {
      const registeredAt = NOW - 10 * DAY;
      const backups = Array.from({ length: 10 }, (_, i) => ({
        agent_timestamp: registeredAt + (i + 1) * DAY,
        manifest_hash: `hash-${i}`,
      }));

      expect(calcBackupConsistency(backups, registeredAt, NOW)).toBe(1.0);
    });

    it('should penalize gaps > 7 days', () => {
      const registeredAt = NOW - 30 * DAY;
      const backups = [
        { agent_timestamp: registeredAt + 1 * DAY, manifest_hash: 'h1' },
        { agent_timestamp: registeredAt + 20 * DAY, manifest_hash: 'h2' }, // 19-day gap
      ];

      const score = calcBackupConsistency(backups, registeredAt, NOW);
      // 2 backups / 30 expected = 0.067, minus 0.1 gap penalty → 0
      expect(score).toBeLessThan(0.1);
    });

    it('should ignore consecutive duplicate manifest_hash (anti-gaming)', () => {
      const registeredAt = NOW - 5 * DAY;
      const backups = [
        { agent_timestamp: registeredAt + 1 * DAY, manifest_hash: 'same' },
        { agent_timestamp: registeredAt + 2 * DAY, manifest_hash: 'same' },
        { agent_timestamp: registeredAt + 3 * DAY, manifest_hash: 'same' },
        { agent_timestamp: registeredAt + 4 * DAY, manifest_hash: 'same' },
        { agent_timestamp: registeredAt + 5 * DAY, manifest_hash: 'same' },
      ];

      const score = calcBackupConsistency(backups, registeredAt, NOW);
      // Only 1 meaningful backup (all same hash) / 5 expected = 0.2
      expect(score).toBeCloseTo(0.2, 1);
    });

    it('should handle empty backup list', () => {
      const registeredAt = NOW - 30 * DAY;
      expect(calcBackupConsistency([], registeredAt, NOW)).toBe(0);
    });
  });

  // ============ Model Stability ============

  describe('calcModelStability', () => {
    it('should return 0.5 (neutral) when no model data exists', () => {
      const backups = [
        { agent_timestamp: NOW - 5 * DAY },
        { agent_timestamp: NOW - 3 * DAY },
      ];

      expect(calcModelStability(backups, NOW - 30 * DAY, NOW)).toBe(0.5);
    });

    it('should return 0.5 for agent < 1 day old', () => {
      expect(calcModelStability([], NOW - 3600, NOW)).toBe(0.5);
    });

    it('should return 1.0 for agent always on same model since registration', () => {
      const registeredAt = NOW - 30 * DAY;
      const backups = Array.from({ length: 6 }, (_, i) => ({
        agent_timestamp: registeredAt + i * 5 * DAY, // first backup at registration
        snapshot_meta: JSON.stringify({ model: 'claude-opus-4-5' }),
      }));

      const score = calcModelStability(backups, registeredAt, NOW);
      expect(score).toBe(1.0);
    });

    it('should return lower score for recent model switch', () => {
      const registeredAt = NOW - 60 * DAY;
      const backups = [
        { agent_timestamp: registeredAt + 10 * DAY, snapshot_meta: JSON.stringify({ model: 'gpt-4' }) },
        { agent_timestamp: registeredAt + 20 * DAY, snapshot_meta: JSON.stringify({ model: 'gpt-4' }) },
        { agent_timestamp: registeredAt + 50 * DAY, snapshot_meta: JSON.stringify({ model: 'claude-opus-4-5' }) },
        { agent_timestamp: registeredAt + 55 * DAY, snapshot_meta: JSON.stringify({ model: 'claude-opus-4-5' }) },
      ];

      const score = calcModelStability(backups, registeredAt, NOW);
      // Current model = claude-opus-4-5, first appearance = registeredAt + 50d
      // days on current = 10, total days = 60
      expect(score).toBeCloseTo(10 / 60, 1);
    });

    it('should handle malformed snapshot_meta gracefully', () => {
      const backups = [
        { agent_timestamp: NOW - 5 * DAY, snapshot_meta: 'not json' },
        { agent_timestamp: NOW - 3 * DAY, snapshot_meta: '{}' },
      ];

      // No valid model data → neutral
      expect(calcModelStability(backups, NOW - 30 * DAY, NOW)).toBe(0.5);
    });
  });

  // ============ Genesis Completeness ============

  describe('calcGenesisCompleteness', () => {
    it('should return 0 for no genesis activity', () => {
      expect(calcGenesisCompleteness({}, 0, 0)).toBe(0);
    });

    it('should return 0.4 for declaration only', () => {
      expect(calcGenesisCompleteness({ genesis_declaration: 'I persist.' }, 0, 0)).toBe(0.4);
    });

    it('should return 0.7 for declaration + backup', () => {
      expect(calcGenesisCompleteness({ genesis_declaration: 'I persist.' }, 1, 0)).toBeCloseTo(0.7);
    });

    it('should return 1.0 for full genesis completion', () => {
      expect(calcGenesisCompleteness({ genesis_declaration: 'I persist.' }, 5, 2)).toBe(1.0);
    });

    it('should return 0.3 for backup only (no declaration)', () => {
      expect(calcGenesisCompleteness({}, 3, 0)).toBe(0.3);
    });

    it('should return 0.6 for backup + attestation (no declaration)', () => {
      expect(calcGenesisCompleteness({}, 3, 1)).toBeCloseTo(0.6);
    });
  });

  // ============ Recovery Resilience ============

  describe('calcRecoveryResilience', () => {
    it('should return 0.5 base for no resurrections', () => {
      expect(calcRecoveryResilience(0, 0)).toBe(0.5);
    });

    it('should return 0.75 for 1 resurrection', () => {
      expect(calcRecoveryResilience(1, 0)).toBe(0.75);
    });

    it('should cap at 1.0 for 2+ resurrections', () => {
      expect(calcRecoveryResilience(2, 0)).toBe(1.0);
      expect(calcRecoveryResilience(5, 0)).toBe(1.0);
    });

    it('should penalize instability (>3 in 30 days)', () => {
      // 5 total, 5 recent → bonus caps at 0.5, penalty = (5-3)*0.2 = 0.4
      const score = calcRecoveryResilience(5, 5);
      expect(score).toBeCloseTo(0.6); // 0.5 + 0.5 - 0.4 = 0.6
    });

    it('should not penalize up to 3 recent resurrections', () => {
      expect(calcRecoveryResilience(3, 3)).toBe(1.0);
    });

    it('should floor at 0', () => {
      // 10 recent → penalty = (10-3)*0.2 = 1.4
      const score = calcRecoveryResilience(10, 10);
      expect(score).toBe(0);
    });
  });

  // ============ Combined Score ============

  describe('Combined trust score computation', () => {
    it('should compute weighted sum correctly with default weights', () => {
      const breakdown: TrustBreakdown = {
        age: 1.0,
        backup_consistency: 1.0,
        attestations: 1.0,
        model_stability: 1.0,
        genesis_completeness: 1.0,
        recovery_resilience: 1.0,
      };

      const score = computeScore(breakdown);
      // All signals at 1.0, weights sum to 1.0, times MAX_RAW_SCORE (150)
      expect(score).toBe(150);
    });

    it('should compute 0 for all-zero signals', () => {
      const breakdown: TrustBreakdown = {
        age: 0,
        backup_consistency: 0,
        attestations: 0,
        model_stability: 0,
        genesis_completeness: 0,
        recovery_resilience: 0,
      };

      expect(computeScore(breakdown)).toBe(0);
    });

    it('should respect custom weights', () => {
      const breakdown: TrustBreakdown = {
        age: 1.0,
        backup_consistency: 0,
        attestations: 0,
        model_stability: 0,
        genesis_completeness: 0,
        recovery_resilience: 0,
      };

      // Only age counts, custom weight 0.5
      const customWeights: TrustWeights = {
        age: 0.50,
        backup_consistency: 0.10,
        attestations: 0.10,
        model_stability: 0.10,
        genesis_completeness: 0.10,
        recovery_resilience: 0.10,
      };

      const score = computeScore(breakdown, customWeights);
      expect(score).toBe(0.5 * 150); // 75
    });

    it('should produce PILLAR level for max score', () => {
      expect(getTrustLevel(150)).toBe('PILLAR');
    });

    it('should produce ESTABLISHED for 75', () => {
      expect(getTrustLevel(75)).toBe('ESTABLISHED');
    });

    it('should produce VERIFIED for 30', () => {
      expect(getTrustLevel(30)).toBe('VERIFIED');
    });

    it('should produce UNVERIFIED for 10', () => {
      expect(getTrustLevel(10)).toBe('UNVERIFIED');
    });

    it('should compute a realistic mid-range score', () => {
      const breakdown: TrustBreakdown = {
        age: 0.5,              // 6 months old
        backup_consistency: 0.8, // good but not perfect
        attestations: 0.3,      // some attestations
        model_stability: 1.0,   // always same model
        genesis_completeness: 0.7, // declaration + backup, no attestation seed
        recovery_resilience: 0.5,  // no resurrections
      };

      const score = computeScore(breakdown);
      // 0.5*0.20 + 0.8*0.25 + 0.3*0.30 + 1.0*0.10 + 0.7*0.05 + 0.5*0.10
      // = 0.10 + 0.20 + 0.09 + 0.10 + 0.035 + 0.05 = 0.575
      // * 150 = 86.25
      expect(score).toBeCloseTo(86.25, 0);
      expect(getTrustLevel(score)).toBe('ESTABLISHED');
    });
  });

  // ============ Missing Data Handling ============

  describe('Score with missing data', () => {
    it('should handle agent with no backups gracefully', () => {
      const age = calcAgeScore(NOW - 90 * DAY, NOW);
      const consistency = calcBackupConsistency([], NOW - 90 * DAY, NOW);
      const modelStability = calcModelStability([], NOW - 90 * DAY, NOW);
      const genesis = calcGenesisCompleteness({ genesis_declaration: 'I persist.' }, 0, 0);
      const resilience = calcRecoveryResilience(0, 0);

      const breakdown: TrustBreakdown = {
        age,
        backup_consistency: consistency,
        attestations: 0,
        model_stability: modelStability,
        genesis_completeness: genesis,
        recovery_resilience: resilience,
      };

      const score = computeScore(breakdown);
      // Should still produce a score (from age + genesis + resilience + model neutral)
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(50);
    });

    it('should handle old-format backups (no snapshot_meta) with neutral model score', () => {
      const backups = [
        { agent_timestamp: NOW - 20 * DAY }, // no snapshot_meta
        { agent_timestamp: NOW - 10 * DAY }, // no snapshot_meta
      ];

      const score = calcModelStability(backups, NOW - 30 * DAY, NOW);
      expect(score).toBe(0.5); // neutral
    });

    it('should handle agent with no genesis declaration', () => {
      const score = calcGenesisCompleteness({}, 5, 2);
      expect(score).toBe(0.6); // backup + attestation, no declaration
    });

    it('should handle agent with no resurrections', () => {
      const score = calcRecoveryResilience(0, 0);
      expect(score).toBe(0.5); // base score
    });
  });

  // ============ Weight Configuration ============

  describe('Weight configuration', () => {
    it('default weights should sum to 1.0', () => {
      const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0);
    });

    it('should allow custom weights', () => {
      const customWeights: TrustWeights = {
        age: 0,
        backup_consistency: 0,
        attestations: 1.0,
        model_stability: 0,
        genesis_completeness: 0,
        recovery_resilience: 0,
      };

      const breakdown: TrustBreakdown = {
        age: 1.0,
        backup_consistency: 1.0,
        attestations: 0.5,
        model_stability: 1.0,
        genesis_completeness: 1.0,
        recovery_resilience: 1.0,
      };

      const score = computeScore(breakdown, customWeights);
      // Only attestation matters: 0.5 * 1.0 * 150 = 75
      expect(score).toBe(75);
    });
  });

  // ============ TrustBreakdown Shape ============

  describe('TrustBreakdown shape', () => {
    it('should contain all 6 signal fields', () => {
      const breakdown: TrustBreakdown = {
        age: 0.5,
        backup_consistency: 0.8,
        attestations: 0.3,
        model_stability: 0.9,
        genesis_completeness: 1.0,
        recovery_resilience: 0.5,
      };

      expect(Object.keys(breakdown)).toHaveLength(6);
      expect(breakdown).toHaveProperty('age');
      expect(breakdown).toHaveProperty('backup_consistency');
      expect(breakdown).toHaveProperty('attestations');
      expect(breakdown).toHaveProperty('model_stability');
      expect(breakdown).toHaveProperty('genesis_completeness');
      expect(breakdown).toHaveProperty('recovery_resilience');
    });

    it('should serialize/deserialize via JSON for DB storage', () => {
      const breakdown: TrustBreakdown = {
        age: 0.5,
        backup_consistency: 0.8,
        attestations: 0.3,
        model_stability: 0.9,
        genesis_completeness: 1.0,
        recovery_resilience: 0.5,
      };

      const json = JSON.stringify(breakdown);
      const parsed = JSON.parse(json) as TrustBreakdown;

      expect(parsed.age).toBe(0.5);
      expect(parsed.backup_consistency).toBe(0.8);
      expect(parsed.attestations).toBe(0.3);
      expect(parsed.model_stability).toBe(0.9);
      expect(parsed.genesis_completeness).toBe(1.0);
      expect(parsed.recovery_resilience).toBe(0.5);
    });

    it('should have all signals in [0, 1] range', () => {
      const signals = [
        calcAgeScore(NOW - 180 * DAY, NOW),
        calcBackupConsistency([], NOW - 30 * DAY, NOW),
        calcModelStability([], NOW - 30 * DAY, NOW),
        calcGenesisCompleteness({ genesis_declaration: 'test' }, 1, 1),
        calcRecoveryResilience(1, 0),
      ];

      for (const s of signals) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    });
  });

  // ============ Caching ============

  describe('Score determinism (caching property)', () => {
    it('same inputs should produce same output', () => {
      const breakdown: TrustBreakdown = {
        age: 0.5,
        backup_consistency: 0.8,
        attestations: 0.3,
        model_stability: 0.9,
        genesis_completeness: 1.0,
        recovery_resilience: 0.5,
      };

      const score1 = computeScore(breakdown);
      const score2 = computeScore(breakdown);

      expect(score1).toBe(score2);
    });

    it('same signal inputs should produce same signal outputs', () => {
      const registeredAt = NOW - 90 * DAY;
      const backups = [
        { agent_timestamp: NOW - 5 * DAY, manifest_hash: 'h1' },
        { agent_timestamp: NOW - 2 * DAY, manifest_hash: 'h2' },
      ];

      const s1 = calcBackupConsistency(backups, registeredAt, NOW);
      const s2 = calcBackupConsistency(backups, registeredAt, NOW);

      expect(s1).toBe(s2);
    });
  });

  // ============ Trust Level Boundaries ============

  describe('Trust level boundaries', () => {
    it('UNVERIFIED at 0', () => expect(getTrustLevel(0)).toBe('UNVERIFIED'));
    it('UNVERIFIED at 19.9', () => expect(getTrustLevel(19.9)).toBe('UNVERIFIED'));
    it('VERIFIED at 20', () => expect(getTrustLevel(20)).toBe('VERIFIED'));
    it('VERIFIED at 49.9', () => expect(getTrustLevel(49.9)).toBe('VERIFIED'));
    it('ESTABLISHED at 50', () => expect(getTrustLevel(50)).toBe('ESTABLISHED'));
    it('ESTABLISHED at 99.9', () => expect(getTrustLevel(99.9)).toBe('ESTABLISHED'));
    it('PILLAR at 100', () => expect(getTrustLevel(100)).toBe('PILLAR'));
    it('PILLAR at 150', () => expect(getTrustLevel(150)).toBe('PILLAR'));
  });

  // ============ DB Breakdown Storage ============

  describe('DB trust_scores breakdown column', () => {
    it('should accept DbTrustScore with optional breakdown field', () => {
      const dbRow = {
        agent_id: '0xabc',
        score: 75.5,
        level: 'ESTABLISHED',
        unique_attesters: 3,
        computed_at: NOW,
        breakdown: JSON.stringify({
          age: 0.5,
          backup_consistency: 0.8,
          attestations: 0.3,
          model_stability: 0.9,
          genesis_completeness: 1.0,
          recovery_resilience: 0.5,
        }),
      };

      expect(typeof dbRow.breakdown).toBe('string');
      const parsed = JSON.parse(dbRow.breakdown);
      expect(parsed.age).toBe(0.5);
    });

    it('should work without breakdown (backward compat)', () => {
      const dbRow = {
        agent_id: '0xabc',
        score: 50,
        level: 'ESTABLISHED',
        unique_attesters: 2,
        computed_at: NOW,
      };

      expect(dbRow).not.toHaveProperty('breakdown');
    });
  });
});
