/**
 * Backup Routes
 *
 * Encrypted backup upload and retrieval
 */

import { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';
import { verifyAgentAuth } from '../middleware/agent-auth.js';
import { isValidAddress, normalizeAddress } from '../utils/crypto.js';
import { v4 as uuidv4 } from 'uuid';

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
    '/backups/upload',
    {
      preHandler: verifyAgentAuth,
      config: {
        // Increase body size limit for backups
        rawBody: true,
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

      // Validate header
      if (backupHeader.agent_id?.toLowerCase() !== agentId.toLowerCase()) {
        return reply.status(403).send({
          success: false,
          error: 'Backup header agent_id does not match authenticated agent',
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

      // TODO: Upload to Arweave via Irys
      // For now, we'll simulate the upload
      const arweaveTxId = `simulated_${uuidv4()}`;

      // Get next backup sequence number
      const backupSeq = db.getNextBackupSeq(agentId);

      // Record backup in database
      const backupId = uuidv4();
      const receivedAt = Math.floor(Date.now() / 1000);

      db.createBackup({
        id: backupId,
        agent_id: agentId,
        arweave_tx_id: arweaveTxId,
        backup_seq: backupSeq,
        agent_timestamp: backupHeader.timestamp || receivedAt,
        received_at: receivedAt,
        size_bytes: body.length,
        manifest_hash: backupHeader.manifest_hash || '',
      });

      fastify.log.info(
        { agentId, backupId, backupSeq, sizeBytes: body.length },
        'Backup uploaded'
      );

      return reply.status(201).send({
        success: true,
        data: {
          backup_id: backupId,
          backup_seq: backupSeq,
          arweave_tx_id: arweaveTxId,
          size_bytes: body.length,
          received_at: receivedAt,
        },
      });
    }
  );

  /**
   * GET /backups/:agentId
   * List backup history for an agent
   */
  fastify.get<{
    Params: { agentId: string };
    Querystring: { limit?: number };
  }>('/backups/:agentId', async (request, reply) => {
    const { agentId } = request.params;
    const limit = request.query.limit || 30;

    if (!isValidAddress(agentId)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid agent ID',
      });
    }

    const normalizedId = normalizeAddress(agentId);
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
        })),
      },
    });
  });

  /**
   * GET /backups/:agentId/latest
   * Get latest backup info
   */
  fastify.get<{
    Params: { agentId: string };
  }>('/backups/:agentId/latest', async (request, reply) => {
    const { agentId } = request.params;

    if (!isValidAddress(agentId)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid agent ID',
      });
    }

    const normalizedId = normalizeAddress(agentId);
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
      },
    });
  });
}
