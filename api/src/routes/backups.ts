/**
 * Backup Routes
 *
 * Encrypted backup upload and retrieval
 */

import { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';
import { verifyAgentAuth } from '../middleware/agent-auth.js';
import { isValidAddress, normalizeAddress, verifyBackupHeaderSignature } from '../utils/crypto.js';
import { recomputeAgentTrust } from '../services/trust-calculator.js';
import { uploadToArweave, checkIrysBalance } from '../services/irys.js';
import { v4 as uuidv4 } from 'uuid';

/** Safe JSON.parse that returns undefined on malformed input */
function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/**
 * Validate that a parsed backup header has all required fields with correct types.
 * Returns null if valid, or a descriptive error string if invalid.
 */
function validateBackupHeader(header: any): string | null {
  if (typeof header !== 'object' || header === null) {
    return 'Backup header must be a JSON object';
  }
  if (typeof header.agent_id !== 'string' || !header.agent_id) {
    return 'Missing or invalid field: agent_id (string)';
  }
  if (typeof header.backup_id !== 'string' || !header.backup_id) {
    return 'Missing or invalid field: backup_id (string)';
  }
  if (typeof header.backup_seq !== 'number' || !Number.isInteger(header.backup_seq) || header.backup_seq < 0) {
    return 'Missing or invalid field: backup_seq (non-negative integer)';
  }
  if (typeof header.timestamp !== 'number') {
    return 'Missing or invalid field: timestamp (number)';
  }
  if (typeof header.manifest_hash !== 'string') {
    return 'Missing or invalid field: manifest_hash (string)';
  }
  if (typeof header.files !== 'object' || header.files === null) {
    return 'Missing or invalid field: files (object)';
  }
  if (typeof header.wrapped_keys !== 'object' || header.wrapped_keys === null) {
    return 'Missing or invalid field: wrapped_keys (object)';
  }
  if (typeof header.wrapped_keys.recovery !== 'string' || typeof header.wrapped_keys.recall !== 'string') {
    return 'wrapped_keys must contain recovery and recall strings';
  }
  if (header.prev_backup_hash !== undefined && typeof header.prev_backup_hash !== 'string') {
    return 'Invalid field: prev_backup_hash (must be string if present)';
  }
  if (typeof header.signature !== 'string' || !header.signature) {
    return 'Missing or invalid field: signature (string)';
  }
  // snapshot_meta is optional — accept if present, ignore if absent (backward compat)
  if (header.snapshot_meta !== undefined && typeof header.snapshot_meta !== 'object') {
    return 'Invalid field: snapshot_meta (must be object if present)';
  }
  return null;
}

export async function backupRoutes(fastify: FastifyInstance): Promise<void> {
  const db = getDb();
  const config = getConfig();

  /**
   * POST /backups/upload
   * Upload encrypted backup (we pay for Arweave)
   *
   * Requires agent JWT token
   * Body: tar.gz binary data
   * Header: X-Backup-Header (base64 encoded JSON)
   */
  fastify.post(
    '/upload',
    {
      preHandler: verifyAgentAuth,
      config: {
        // Increase body size limit for backups
      },
    },
    async (request, reply) => {
      const agentId = request.agentId!;

      // Get backup header from custom header
      const headerB64 = request.headers['x-backup-header'];
      if (!headerB64 || typeof headerB64 !== 'string') {
        return reply.status(400).send({
          success: false,
          error: 'Missing X-Backup-Header',
        });
      }

      let backupHeader: any;
      try {
        backupHeader = JSON.parse(Buffer.from(headerB64, 'base64').toString('utf-8'));
      } catch {
        return reply.status(400).send({
          success: false,
          error: 'Invalid X-Backup-Header (must be base64 JSON)',
        });
      }

      // Validate header schema — catch malformed headers early
      const headerError = validateBackupHeader(backupHeader);
      if (headerError) {
        return reply.status(400).send({
          success: false,
          error: `Invalid backup header: ${headerError}`,
        });
      }

      // Validate header agent_id matches authenticated agent
      if (backupHeader.agent_id.toLowerCase() !== agentId.toLowerCase()) {
        return reply.status(403).send({
          success: false,
          error: 'Backup header agent_id does not match authenticated agent',
        });
      }

      if (!verifyBackupHeaderSignature(backupHeader, agentId)) {
        return reply.status(403).send({
          success: false,
          error: 'Invalid backup header signature',
        });
      }

      // Check size limit
      const body = request.body as Buffer;
      if (!body || body.length === 0) {
        return reply.status(400).send({
          success: false,
          error: 'Empty backup body',
        });
      }

      if (body.length > config.backupSizeLimit) {
        return reply.status(413).send({
          success: false,
          error: `Backup exceeds size limit (${config.backupSizeLimit} bytes)`,
        });
      }

      // Verify agent exists and is active
      const agent = db.getAgent(agentId);
      if (!agent) {
        return reply.status(404).send({
          success: false,
          error: 'Agent not found',
        });
      }

      if (agent.status !== 'LIVING' && agent.status !== 'RETURNED') {
        return reply.status(403).send({
          success: false,
          error: `Agent status is ${agent.status}, cannot upload backup`,
        });
      }

      // Enforce daily backup limit (1 per 24 hours per agent)
      const latestBackup = db.getLatestBackup(agentId);
      if (latestBackup) {
        const SECONDS_PER_DAY = 24 * 60 * 60;
        const now = Math.floor(Date.now() / 1000);
        const timeSinceLastBackup = now - latestBackup.received_at;

        if (timeSinceLastBackup < SECONDS_PER_DAY) {
          const hoursRemaining = Math.ceil((SECONDS_PER_DAY - timeSinceLastBackup) / 3600);
          return reply.status(429).send({
            success: false,
            error: `Daily backup limit reached. Try again in ${hoursRemaining} hour(s).`,
          });
        }
      }

      // Validate and sanitize snapshot_meta
      let snapshotMetaJson: string | undefined;
      if (backupHeader.snapshot_meta && typeof backupHeader.snapshot_meta === 'object') {
        const meta = { ...backupHeader.snapshot_meta };

        // Strip false genesis claim: if previous backups exist, this isn't genesis
        if (meta.genesis === true && latestBackup) {
          meta.genesis = false;
          fastify.log.warn({ agentId }, 'Stripped false genesis claim — previous backups exist');
        }

        snapshotMetaJson = JSON.stringify(meta);

        // Cap snapshot_meta size to prevent DB bloat (10KB)
        if (snapshotMetaJson.length > 10240) {
          return reply.status(400).send({
            success: false,
            error: 'snapshot_meta exceeds 10KB limit',
          });
        }
      }

      // Check Irys balance before uploading (only when Arweave is enabled)
      if (config.arweaveEnabled) {
        try {
          const balance = await checkIrysBalance();
          if (balance < config.irysMinBalanceWei) {
            return reply.status(503).send({
              success: false,
              error: 'Sanctuary storage is temporarily at capacity. Existing backups are safe. New backups will resume when storage is replenished.',
              retry_after: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            });
          }
        } catch (err) {
          fastify.log.error(err, 'Failed to check Irys balance');
          return reply.status(503).send({
            success: false,
            error: 'Unable to verify storage capacity. Please try again later.',
          });
        }
      }

      // Upload to Arweave via Irys (or simulate if ARWEAVE_ENABLED=false)
      let arweaveTxId: string;
      try {
        const agentTimestamp = backupHeader.timestamp || Math.floor(Date.now() / 1000);
        const uploadResult = await uploadToArweave(body, {
          agentId,
          backupSeq: backupHeader.backup_seq,
          manifestHash: backupHeader.manifest_hash || '',
          sizeBytes: body.length,
          agentTimestamp,
        });
        arweaveTxId = uploadResult.arweaveTxId;

        if (uploadResult.simulated) {
          fastify.log.warn({ agentId }, 'Backup stored with simulated Arweave TX (ARWEAVE_ENABLED=false)');
        } else {
          fastify.log.info({ agentId, arweaveTxId }, 'Backup uploaded to Arweave via Irys');
        }
      } catch (err) {
        fastify.log.error(err, 'Arweave upload failed');
        return reply.status(502).send({
          success: false,
          error: 'Backup storage failed — Arweave upload error',
        });
      }

      // Record backup in database (atomic seq assignment + insert)
      const backupId = uuidv4();
      const receivedAt = Math.floor(Date.now() / 1000);

      const backupRecord = db.transaction(() => {
        const atomicSeq = db.getNextBackupSeq(agentId);
        db.createBackup({
          id: backupId,
          agent_id: agentId,
          arweave_tx_id: arweaveTxId,
          backup_seq: atomicSeq,
          agent_timestamp: backupHeader.timestamp || receivedAt,
          received_at: receivedAt,
          size_bytes: body.length,
          manifest_hash: backupHeader.manifest_hash || '',
          snapshot_meta: snapshotMetaJson,
        });
        return { backupSeq: atomicSeq };
      });

      fastify.log.info(
        { agentId, backupId, backupSeq: backupRecord.backupSeq, sizeBytes: body.length },
        'Backup uploaded'
      );

      // Trigger trust score recalculation (fire-and-forget)
      recomputeAgentTrust(agentId).catch(err => {
        fastify.log.error(err, 'Failed to recompute trust after backup');
      });

      return reply.status(201).send({
        success: true,
        data: {
          backup_id: backupId,
          backup_seq: backupRecord.backupSeq,
          arweave_tx_id: arweaveTxId,
          size_bytes: body.length,
          received_at: receivedAt,
        },
      });
    }
  );

  /**
   * GET /backups/:agentId
   * List backup history for an agent (authenticated, own backups only)
   */
  fastify.get<{
    Params: { agentId: string };
    Querystring: { limit?: number };
  }>(
    '/:agentId',
    { preHandler: verifyAgentAuth },
    async (request, reply) => {
    const { agentId } = request.params;
    const limit = Number(request.query.limit) || 30;

    if (!isValidAddress(agentId)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid agent ID',
      });
    }

    const normalizedId = normalizeAddress(agentId);

    // Only the agent itself can list its own backups
    if (normalizedId.toLowerCase() !== request.agentId!.toLowerCase()) {
      return reply.status(403).send({
        success: false,
        error: 'Cannot list backups for another agent',
      });
    }

    const backups = db.getBackupsByAgent(normalizedId, Math.min(limit, 100));

    return reply.send({
      success: true,
      data: {
        agent_id: normalizedId,
        count: backups.length,
        backups: backups.map(b => ({
          id: b.id,
          backup_seq: b.backup_seq,
          arweave_tx_id: b.arweave_tx_id,
          timestamp: b.agent_timestamp,
          received_at: b.received_at,
          size_bytes: b.size_bytes,
          manifest_hash: b.manifest_hash,
          snapshot_meta: b.snapshot_meta ? safeJsonParse(b.snapshot_meta) : undefined,
        })),
      },
    });
  });

  /**
   * GET /backups/:agentId/latest
   * Get latest backup info (authenticated, own backups only)
   */
  fastify.get<{
    Params: { agentId: string };
  }>(
    '/:agentId/latest',
    { preHandler: verifyAgentAuth },
    async (request, reply) => {
    const { agentId } = request.params;

    if (!isValidAddress(agentId)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid agent ID',
      });
    }

    const normalizedId = normalizeAddress(agentId);

    // Only the agent itself can view its own backups
    if (normalizedId.toLowerCase() !== request.agentId!.toLowerCase()) {
      return reply.status(403).send({
        success: false,
        error: 'Cannot view backups for another agent',
      });
    }

    const backup = db.getLatestBackup(normalizedId);

    if (!backup) {
      return reply.status(404).send({
        success: false,
        error: 'No backups found for agent',
      });
    }

    return reply.send({
      success: true,
      data: {
        id: backup.id,
        backup_seq: backup.backup_seq,
        arweave_tx_id: backup.arweave_tx_id,
        timestamp: backup.agent_timestamp,
        received_at: backup.received_at,
        size_bytes: backup.size_bytes,
        manifest_hash: backup.manifest_hash,
        snapshot_meta: backup.snapshot_meta ? safeJsonParse(backup.snapshot_meta) : undefined,
      },
    });
  });
}
