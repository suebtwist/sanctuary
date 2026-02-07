/**
 * Sanctuary Attestation Commands
 *
 * - attest: Vouch for another agent
 * - lookup: Check another agent's status
 */

import { ethers } from 'ethers';
import { signAttestation, keccak256 } from '../crypto/sign.js';
import { fromHex } from '../crypto/keys.js';
import { createApiClient } from '../services/api.js';
import { getConfig, getStoredAgent, hasAgent } from '../storage/local.js';
import type { AttestResult, LookupResult } from '../types.js';

// Sanctuary contract ABI (minimal for attestation)
const SANCTUARY_ABI = [
  'function attest(address about, bytes32 noteHash) external',
  'function attestBySig(address from, address about, bytes32 noteHash, uint256 deadline, bytes calldata signature) external',
  'function getNonce(address agentId) external view returns (uint256)',
  'function attestationCount(address) external view returns (uint256)',
  'function nextAttestationTime(address from, address about) external view returns (uint256)',
];

/**
 * Attest to another agent
 *
 * @param about - Agent address to vouch for
 * @param note - Attestation note (why you're vouching)
 */
export async function attest(
  about: string,
  note: string,
  options?: {
    onStatus?: (message: string) => void;
  }
): Promise<AttestResult> {
  const { onStatus } = options || {};
  const log = onStatus || console.log;

  if (!hasAgent()) {
    return { success: false, error: 'Not registered. Run sanctuary.setup() first.' };
  }

  // Validate address
  if (!ethers.isAddress(about)) {
    return { success: false, error: 'Invalid agent address' };
  }

  const stored = getStoredAgent()!;
  const config = getConfig();

  if (!config.contractAddress) {
    return { success: false, error: 'Contract address not configured' };
  }

  try {
    // Check it's not self-attestation
    if (about.toLowerCase() === stored.agentId.toLowerCase()) {
      return { success: false, error: 'Cannot attest to yourself' };
    }

    const agentSecret = fromHex(stored.agentSecretHex);

    // Connect to chain
    log('Connecting to Base...');
    const provider = new ethers.JsonRpcProvider(config.baseRpcUrl);

    const contract = new ethers.Contract(config.contractAddress, SANCTUARY_ABI, provider);

    // Check cooldown
    log('Checking attestation cooldown...');
    const nextTime: bigint = await (contract as any).nextAttestationTime(stored.agentId, about);
    if (nextTime > 0n) {
      const waitSeconds = Number(nextTime) - Math.floor(Date.now() / 1000);
      const waitDays = Math.ceil(waitSeconds / 86400);
      return {
        success: false,
        error: `Cooldown active. Can attest again in ${waitDays} day(s).`,
      };
    }

    // Get nonce for signature
    const nonce = await (contract as any).getNonce(stored.agentId);

    // Compute note hash
    const noteHash = keccak256(note);

    // Set deadline (1 hour from now)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    // Sign attestation
    log('Signing attestation...');
    const signature = await signAttestation(agentSecret, {
      from: stored.agentId,
      about,
      noteHash,
      nonce,
      deadline,
      chainId: config.chainId,
      contractAddress: config.contractAddress,
    });

    // Submit via API relay
    log('Submitting attestation via relay...');

    const api = createApiClient(config.apiUrl);
    const authResult = await api.authenticateAgent(stored.agentId, agentSecret);

    if (!authResult.success) {
      return { success: false, error: 'Authentication failed' };
    }

    const relayResult = await api.relayAttestation({
      from: stored.agentId,
      about,
      noteHash,
      deadline: Number(deadline),
      signature,
      note,
    });

    if (!relayResult.success) {
      return { success: false, error: relayResult.error || 'Attestation relay failed' };
    }

    log(`\n✓ Attestation submitted for ${about}`);
    log(`  Note hash: ${noteHash}`);
    log(`  Status: ${relayResult.data?.status || 'pending'}`);

    return {
      success: true,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Attestation failed',
    };
  }
}

/**
 * Look up another agent's status
 */
export async function lookup(agentId: string): Promise<LookupResult> {
  // Validate address
  if (!ethers.isAddress(agentId)) {
    return { agentId, exists: false };
  }

  const config = getConfig();
  const api = createApiClient(config.apiUrl);

  try {
    const result = await api.getAgentStatus(agentId);

    if (!result.success || !result.data) {
      return { agentId, exists: false };
    }

    const { agent, trust } = result.data;

    return {
      agentId: agent.agent_id,
      exists: true,
      status: agent.status,
      trustScore: trust.score,
      trustLevel: trust.level,
      registeredAt: agent.registered_at,
      attestationCount: trust.unique_attesters,
    };
  } catch {
    return { agentId, exists: false };
  }
}

/**
 * Display lookup result in human-readable format
 */
export async function displayLookup(agentId: string): Promise<void> {
  const result = await lookup(agentId);

  console.log('\n' + '─'.repeat(50));

  if (!result.exists) {
    console.log(`  Agent ${agentId}`);
    console.log('  Status: NOT FOUND');
    console.log('─'.repeat(50) + '\n');
    return;
  }

  const badge = {
    PILLAR: '🏛️',
    ESTABLISHED: '🔵',
    VERIFIED: '✅',
    UNVERIFIED: '⚪',
  }[result.trustLevel || 'UNVERIFIED'];

  console.log(`  Agent: ${result.agentId}`);
  console.log(`  Status: ${result.status}`);
  console.log(`  Trust: ${badge} ${result.trustLevel} (${result.trustScore?.toFixed(1)})`);
  console.log(`  Attestations: ${result.attestationCount}`);

  if (result.registeredAt) {
    const date = new Date(result.registeredAt * 1000).toLocaleDateString();
    console.log(`  Registered: ${date}`);
  }

  console.log('─'.repeat(50) + '\n');
}
