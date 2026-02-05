/**
 * Sanctuary Status Command
 *
 * Display current agent status:
 * - Registration status
 * - Trust score and level
 * - Backup history
 * - Heartbeat status
 */

import { createApiClient } from '../services/api.js';
import { getConfig, getStoredAgent, hasAgent } from '../storage/local.js';
import type { StatusResult } from '../types.js';

/**
 * Get trust level badge/emoji
 */
function getTrustBadge(level: string): string {
  switch (level) {
    case 'PILLAR':
      return '🏛️ PILLAR';
    case 'ESTABLISHED':
      return '🔵 ESTABLISHED';
    case 'VERIFIED':
      return '✅ VERIFIED';
    default:
      return '⚪ UNVERIFIED';
  }
}

/**
 * Format timestamp to relative time
 */
function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} days ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

/**
 * Get current agent status
 */
export async function status(): Promise<StatusResult> {
  if (!hasAgent()) {
    throw new Error('Not registered. Run sanctuary.setup() first.');
  }

  const stored = getStoredAgent()!;
  const config = getConfig();
  const api = createApiClient(config.apiUrl);

  const result = await api.getAgentStatus(stored.agentId);

  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to get agent status');
  }

  const { agent, trust, backups, heartbeat } = result.data;

  return {
    agentId: agent.agent_id,
    status: agent.status,
    trustScore: trust.score,
    trustLevel: trust.level,
    backupCount: backups.count,
    lastBackup: backups.latest
      ? {
          seq: backups.latest.backup_seq,
          timestamp: backups.latest.timestamp,
          arweaveTxId: backups.latest.arweave_tx_id,
        }
      : undefined,
    lastHeartbeat: heartbeat.last_seen || undefined,
    attestationsReceived: trust.unique_attesters,
  };
}

/**
 * Display status in human-readable format
 */
export async function displayStatus(): Promise<void> {
  const s = await status();

  console.log('\n' + '═'.repeat(50));
  console.log('  SANCTUARY STATUS');
  console.log('═'.repeat(50));

  console.log(`\n  Agent: ${s.agentId}`);
  console.log(`  Status: ${s.status}`);
  console.log(`  Trust: ${getTrustBadge(s.trustLevel)} (score: ${s.trustScore.toFixed(1)})`);

  console.log('\n  Backups:');
  console.log(`    Total: ${s.backupCount}`);
  if (s.lastBackup) {
    console.log(`    Last: #${s.lastBackup.seq} - ${formatRelativeTime(s.lastBackup.timestamp)}`);
    console.log(`    Arweave: ${s.lastBackup.arweaveTxId}`);
  } else {
    console.log('    Last: None');
  }

  console.log('\n  Heartbeat:');
  if (s.lastHeartbeat) {
    console.log(`    Last seen: ${formatRelativeTime(s.lastHeartbeat)}`);
  } else {
    console.log('    Last seen: Never');
  }

  console.log('\n  Attestations:');
  console.log(`    Received from: ${s.attestationsReceived} unique agents`);

  console.log('\n' + '═'.repeat(50) + '\n');
}

/**
 * Quick check if agent is healthy
 */
export async function isHealthy(): Promise<{
  healthy: boolean;
  issues: string[];
}> {
  const issues: string[] = [];

  if (!hasAgent()) {
    return { healthy: false, issues: ['Not registered'] };
  }

  try {
    const s = await status();

    // Check status
    if (s.status === 'FALLEN') {
      issues.push('Agent marked as FALLEN - needs resurrection');
    }

    // Check heartbeat (warn if > 24 hours)
    if (s.lastHeartbeat) {
      const hoursSinceHeartbeat = (Date.now() / 1000 - s.lastHeartbeat) / 3600;
      if (hoursSinceHeartbeat > 24) {
        issues.push(`No heartbeat in ${Math.floor(hoursSinceHeartbeat)} hours`);
      }
    } else {
      issues.push('No heartbeat recorded');
    }

    // Check backups (warn if > 7 days)
    if (s.lastBackup) {
      const daysSinceBackup = (Date.now() / 1000 - s.lastBackup.timestamp) / 86400;
      if (daysSinceBackup > 7) {
        issues.push(`No backup in ${Math.floor(daysSinceBackup)} days`);
      }
    } else {
      issues.push('No backups recorded');
    }

    return { healthy: issues.length === 0, issues };
  } catch (error) {
    return {
      healthy: false,
      issues: [error instanceof Error ? error.message : 'Status check failed'],
    };
  }
}
