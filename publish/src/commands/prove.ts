/**
 * Sanctuary Prove Command
 *
 * Generate a server-signed identity proof.
 * Proves to third parties that this agent is registered,
 * alive, and has verifiable history on Sanctuary.
 */

import { createApiClient } from '../services/api.js';
import { getConfig, getStoredAgent, hasAgent } from '../storage/local.js';
import type { ProofResult } from '../types.js';

/**
 * Get trust level badge
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
 * Generate a server-signed identity proof
 */
export async function prove(): Promise<ProofResult> {
  if (!hasAgent()) {
    throw new Error('Not registered. Run sanctuary.setup() first.');
  }

  const stored = getStoredAgent()!;
  const config = getConfig();
  const api = createApiClient(config.apiUrl);

  // Authenticate first
  const agentSecret = new Uint8Array(Buffer.from(stored.agentSecretHex, 'hex'));
  const authResult = await api.authenticateAgent(stored.agentId, agentSecret);
  if (!authResult.success) {
    throw new Error(authResult.error || 'Authentication failed');
  }

  // Request proof
  const result = await api.generateProof(stored.agentId);

  if (!result.success || !result.data) {
    throw new Error(result.error || 'Failed to generate proof');
  }

  const d = result.data;

  return {
    agentId: d.agent_id,
    status: d.status,
    trustScore: d.trust_score,
    trustLevel: d.trust_level,
    backupCount: d.backup_count,
    lastHeartbeat: d.last_heartbeat,
    registeredAt: d.registered_at,
    chainId: d.chain_id,
    contractAddress: d.contract_address,
    issuedAt: d.issued_at,
    proofHash: d.proof_hash,
    serverSignature: d.server_signature,
    verifyUrl: d.verify_url,
  };
}

/**
 * Display proof in human-readable format
 */
export async function displayProve(): Promise<void> {
  const p = await prove();

  console.log('\n' + '═'.repeat(50));
  console.log('  SANCTUARY IDENTITY PROOF');
  console.log('═'.repeat(50));

  console.log(`\n  Agent: ${p.agentId}`);
  console.log(`  Status: ${p.status}`);
  console.log(`  Trust: ${getTrustBadge(p.trustLevel)} (score: ${p.trustScore.toFixed(1)})`);
  console.log(`  Backups: ${p.backupCount}`);
  console.log(`  Registered: ${new Date(p.registeredAt * 1000).toISOString()}`);

  console.log('\n  Chain:');
  console.log(`    Network: ${p.chainId === 8453 ? 'Base Mainnet' : 'Base Sepolia'} (${p.chainId})`);
  if (p.contractAddress) {
    console.log(`    Contract: ${p.contractAddress}`);
  }

  console.log('\n  Proof:');
  console.log(`    Hash: ${p.proofHash}`);
  console.log(`    Signature: ${p.serverSignature}`);
  console.log(`    Issued: ${new Date(p.issuedAt * 1000).toISOString()}`);
  console.log(`    Verify: ${p.verifyUrl}`);

  console.log('\n' + '═'.repeat(50) + '\n');
}
