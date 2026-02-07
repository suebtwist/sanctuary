/**
 * Agent Routes
 *
 * Registration and status endpoints
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHash, createHmac } from 'crypto';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';
import { isValidAddress, normalizeAddress } from '../utils/crypto.js';
import { verifyAgentAuth } from '../middleware/agent-auth.js';
import { recomputeAgentTrust } from '../services/trust-calculator.js';
import { registerAgentOnChain } from '../services/blockchain.js';

/** Safe JSON.parse that returns undefined on malformed input */
function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

export async function agentRoutes(fastify: FastifyInstance): Promise<void> {
  const db = getDb();

  /**
   * POST /agents/register
   * Register a new agent (requires GitHub auth token)
   */
  fastify.post<{
    Body: {
      agentId: string;
      recoveryPubKey: string;
      manifestHash: string;
      manifestVersion: number;
      genesisDeclaration?: string;
      recallPubKey?: string;
      // On-chain registration (optional — required when BLOCKCHAIN_ENABLED=true)
      registrationSignature?: string;
      registrationDeadline?: number;
    };
  }>('/register', async (request, reply) => {
    // Verify GitHub auth token
    let decoded: { type: string; githubId?: string };
    try {
      decoded = await request.jwtVerify<{
        type: string;
        githubId?: string;
      }>();
    } catch {
      return reply.status(401).send({
        success: false,
        error: 'Authentication required',
      });
    }

    if (decoded.type !== 'github' || !decoded.githubId) {
      return reply.status(401).send({
        success: false,
        error: 'GitHub authentication required for registration',
      });
    }

    const { agentId, recoveryPubKey, manifestHash, manifestVersion, genesisDeclaration,
            recallPubKey, registrationSignature, registrationDeadline } = request.body;

    // Validate inputs
    if (!agentId || !isValidAddress(agentId)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid agent ID (must be valid Ethereum address)',
      });
    }

    if (!recoveryPubKey || !/^0x[a-fA-F0-9]{64}$/.test(recoveryPubKey)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid recovery public key (must be 32 bytes hex)',
      });
    }

    if (!manifestHash || !/^0x[a-fA-F0-9]{64}$/.test(manifestHash)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid manifest hash',
      });
    }

    if (manifestVersion !== undefined && (manifestVersion < 0 || manifestVersion > 65535 || !Number.isInteger(manifestVersion))) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid manifest version (must be integer 0–65535)',
      });
    }

    if (recallPubKey && !/^0x[a-fA-F0-9]{64}$/.test(recallPubKey)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid recall public key (must be 32 bytes hex)',
      });
    }

    const normalizedId = normalizeAddress(agentId);

    // Check if agent already exists
    const existingAgent = db.getAgent(normalizedId);
    if (existingAgent) {
      return reply.status(409).send({
        success: false,
        error: 'Agent already registered',
      });
    }

    // Check if GitHub user already has an agent
    const existingAgentForUser = db.getAgentByGithubId(decoded.githubId);
    if (existingAgentForUser) {
      return reply.status(409).send({
        success: false,
        error: 'GitHub account already has a registered agent',
        existing_agent_id: existingAgentForUser.agent_id,
      });
    }

    // Verify user exists
    const user = db.getUser(decoded.githubId);
    if (!user) {
      return reply.status(400).send({
        success: false,
        error: 'User not found. Complete GitHub auth first.',
      });
    }

    // Create agent
    const now = Math.floor(Date.now() / 1000);
    // Truncate genesis_declaration to 2000 chars to prevent abuse
    const sanitizedDeclaration = genesisDeclaration
      ? genesisDeclaration.slice(0, 2000)
      : undefined;
    db.createAgent({
      agent_id: normalizedId,
      github_id: decoded.githubId,
      recovery_pubkey: recoveryPubKey.toLowerCase(),
      manifest_hash: manifestHash.toLowerCase(),
      manifest_version: manifestVersion || 1,
      registered_at: now,
      status: 'LIVING',
      genesis_declaration: sanitizedDeclaration,
      recall_pub_key: recallPubKey?.toLowerCase(),
    });

    fastify.log.info({ agentId: normalizedId, githubId: decoded.githubId }, 'Agent registered');

    // On-chain registration (fire-and-forget)
    const config = getConfig();
    if (registrationSignature && registrationDeadline) {
      registerAgentOnChain({
        agentId: normalizedId,
        manifestHash: manifestHash.toLowerCase(),
        manifestVersion: manifestVersion || 1,
        recoveryPubKey: recoveryPubKey.toLowerCase(),
        deadline: BigInt(registrationDeadline),
        signature: registrationSignature,
      }).then(result => {
        const status = result.simulated ? 'simulated' : 'confirmed';
        db.updateAgentOnChainStatus(normalizedId, result.txHash, status);
        if (result.simulated) {
          fastify.log.warn({ agentId: normalizedId }, 'On-chain registration simulated (BLOCKCHAIN_ENABLED=false)');
        } else {
          fastify.log.info({ agentId: normalizedId, txHash: result.txHash }, 'Agent registered on-chain');
        }
      }).catch(err => {
        db.updateAgentOnChainStatus(normalizedId, '', 'failed');
        fastify.log.error(err, 'On-chain registration failed (DB registration succeeded)');
      });
    } else if (config.blockchainEnabled) {
      db.updateAgentOnChainStatus(normalizedId, '', 'skipped');
      fastify.log.warn({ agentId: normalizedId }, 'Registered without on-chain signature — on-chain registration skipped');
    }

    return reply.status(201).send({
      success: true,
      data: {
        agent_id: normalizedId,
        registered_at: now,
        status: 'LIVING',
      },
    });
  });

  /**
   * GET /agents/:agentId
   * Get agent info
   */
  fastify.get<{
    Params: { agentId: string };
  }>('/:agentId', async (request, reply) => {
    const { agentId } = request.params;

    if (!isValidAddress(agentId)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid agent ID',
      });
    }

    const normalizedId = normalizeAddress(agentId);
    const agent = db.getAgent(normalizedId);

    if (!agent) {
      return reply.status(404).send({
        success: false,
        error: 'Agent not found',
      });
    }

    const user = db.getUser(agent.github_id);

    return reply.send({
      success: true,
      data: {
        agent_id: agent.agent_id,
        github_username: user?.github_username,
        recovery_pubkey: agent.recovery_pubkey,
        recall_pub_key: agent.recall_pub_key,
        manifest_hash: agent.manifest_hash,
        manifest_version: agent.manifest_version,
        registered_at: agent.registered_at,
        status: agent.status,
      },
    });
  });

  /**
   * GET /agents/:agentId/status
   * Get full agent status including trust score and backup info
   */
  fastify.get<{
    Params: { agentId: string };
  }>('/:agentId/status', async (request, reply) => {
    const { agentId } = request.params;

    if (!isValidAddress(agentId)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid agent ID',
      });
    }

    const normalizedId = normalizeAddress(agentId);
    const agent = db.getAgent(normalizedId);

    if (!agent) {
      return reply.status(404).send({
        success: false,
        error: 'Agent not found',
      });
    }

    const user = db.getUser(agent.github_id);
    const trustScore = db.getTrustScore(normalizedId);
    const latestHeartbeat = db.getLatestHeartbeat(normalizedId);
    const latestBackup = db.getLatestBackup(normalizedId);
    const backupCount = db.getBackupCount(normalizedId);

    return reply.send({
      success: true,
      data: {
        agent: {
          agent_id: agent.agent_id,
          github_username: user?.github_username,
          manifest_hash: agent.manifest_hash,
          manifest_version: agent.manifest_version,
          registered_at: agent.registered_at,
          status: agent.status,
        },
        trust: trustScore ? {
          score: trustScore.score,
          level: trustScore.level,
          unique_attesters: trustScore.unique_attesters,
          computed_at: trustScore.computed_at,
          breakdown: trustScore.breakdown ? safeJsonParse(trustScore.breakdown) : undefined,
        } : {
          score: 0,
          level: 'UNVERIFIED',
          unique_attesters: 0,
          computed_at: null,
          breakdown: undefined,
        },
        backups: {
          count: backupCount,
          latest: latestBackup ? {
            id: latestBackup.id,
            backup_seq: latestBackup.backup_seq,
            arweave_tx_id: latestBackup.arweave_tx_id,
            timestamp: latestBackup.agent_timestamp,
            size_bytes: latestBackup.size_bytes,
          } : null,
        },
        heartbeat: {
          last_seen: latestHeartbeat?.received_at || null,
        },
      },
    });
  });

  /**
   * POST /agents/:agentId/proof
   * Generate a server-signed identity proof (requires agent auth)
   *
   * Returns a JSON payload with HMAC-SHA256 server signature
   * that third parties can verify against the API.
   */
  fastify.post<{
    Params: { agentId: string };
  }>('/:agentId/proof', { preHandler: [verifyAgentAuth] }, async (request, reply) => {
    const { agentId } = request.params;

    if (!isValidAddress(agentId)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid agent ID',
      });
    }

    const normalizedId = normalizeAddress(agentId);

    // Verify requester owns this agent
    if (normalizedId !== request.agentId) {
      return reply.status(403).send({
        success: false,
        error: 'Can only generate proof for your own agent',
      });
    }

    const agent = db.getAgent(normalizedId);
    if (!agent) {
      return reply.status(404).send({
        success: false,
        error: 'Agent not found',
      });
    }

    const config = getConfig();
    const trustScore = db.getTrustScore(normalizedId);
    const latestHeartbeat = db.getLatestHeartbeat(normalizedId);
    const backupCount = db.getBackupCount(normalizedId);
    const now = Math.floor(Date.now() / 1000);

    // Build proof payload (deterministic key order)
    const payload = {
      agent_id: agent.agent_id,
      backup_count: backupCount,
      chain_id: config.chainId,
      contract_address: config.contractAddress,
      issued_at: now,
      last_heartbeat: latestHeartbeat?.received_at || null,
      registered_at: agent.registered_at,
      status: agent.status,
      trust_level: trustScore?.level || 'UNVERIFIED',
      trust_score: trustScore?.score || 0,
    };

    // Hash the payload
    const payloadJson = JSON.stringify(payload);
    const proofHash = createHash('sha256').update(payloadJson).digest('hex');

    // Sign with HMAC-SHA256 using proof signing key
    const serverSignature = createHmac('sha256', config.proofSigningKey)
      .update(proofHash)
      .digest('hex');

    return reply.send({
      success: true,
      data: {
        ...payload,
        proof_hash: proofHash,
        server_signature: serverSignature,
        verify_url: config.publicUrl
          ? `${config.publicUrl}/agents/${normalizedId}/status`
          : `http://localhost:${config.port}/agents/${normalizedId}/status`,
      },
    });
  });

  /**
   * POST /agents/:agentId/resurrect
   * Resurrect a fallen agent (requires agent auth via challenge-response)
   *
   * The mnemonic proves identity client-side (used to sign the challenge).
   * This endpoint transitions FALLEN → RETURNED and returns the resurrection manifest.
   */
  fastify.post<{
    Params: { agentId: string };
  }>('/:agentId/resurrect', { preHandler: [verifyAgentAuth] }, async (request, reply) => {
    const { agentId } = request.params;

    if (!isValidAddress(agentId)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid agent ID',
      });
    }

    const normalizedId = normalizeAddress(agentId);

    // Verify requester owns this agent
    if (normalizedId !== request.agentId) {
      return reply.status(403).send({
        success: false,
        error: 'Can only resurrect your own agent',
      });
    }

    const agent = db.getAgent(normalizedId);
    if (!agent) {
      return reply.status(404).send({
        success: false,
        error: 'No Sanctuary identity found for this agent',
      });
    }

    // Transition status if FALLEN
    const previousStatus = agent.status;
    if (agent.status === 'FALLEN') {
      db.updateAgentStatus(normalizedId, 'RETURNED');
      db.logResurrection(normalizedId, previousStatus);
      fastify.log.info({ agentId: normalizedId, previousStatus }, 'Agent resurrected');

      // Trigger trust score recalculation (fire-and-forget)
      recomputeAgentTrust(normalizedId).catch(err => {
        fastify.log.error(err, 'Failed to recompute trust after resurrection');
      });
    }

    // Build resurrection manifest
    const user = db.getUser(agent.github_id);
    const trustScore = db.getTrustScore(normalizedId);
    const latestHeartbeat = db.getLatestHeartbeat(normalizedId);
    const backupCount = db.getBackupCount(normalizedId);
    const latestBackup = db.getLatestBackup(normalizedId);
    const backups = db.getBackupsByAgent(normalizedId, 100);
    const resurrectionCount = db.getResurrectionCount(normalizedId);

    // Build snapshot list with parsed snapshot_meta
    const snapshots = backups.map(b => ({
      backup_id: b.id,
      backup_seq: b.backup_seq,
      timestamp: b.agent_timestamp,
      arweave_tx_id: b.arweave_tx_id,
      size_bytes: b.size_bytes,
      manifest_hash: b.manifest_hash,
      snapshot_meta: b.snapshot_meta ? safeJsonParse(b.snapshot_meta) : undefined,
    }));

    return reply.send({
      success: true,
      data: {
        identity: {
          address: agent.agent_id,
          github_username: user?.github_username,
          trust_score: trustScore?.score || 0,
          trust_level: trustScore?.level || 'UNVERIFIED',
          attestation_count: trustScore?.unique_attesters || 0,
          registered_at: agent.registered_at,
          last_backup: latestBackup?.agent_timestamp || null,
          last_heartbeat: latestHeartbeat?.received_at || null,
          total_snapshots: backupCount,
          resurrection_count: resurrectionCount,
        },
        snapshots,
        genesis_declaration: agent.genesis_declaration || null,
        status: agent.status === 'FALLEN' ? 'resurrected' : agent.status.toLowerCase(),
        previous_status: previousStatus,
      },
    });
  });
}
