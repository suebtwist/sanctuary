/**
 * Heartbeat Routes
 *
 * Agent liveness tracking
 */

import { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { verifyAgentAuth } from '../middleware/agent-auth.js';
import { verifyHeartbeatSignature, isTimestampValid } from '../utils/crypto.js';

export async function heartbeatRoutes(fastify: FastifyInstance): Promise<void> {
  const db = getDb();

  /**
   * POST /heartbeat
   * Record agent liveness
   *
   * Requires agent JWT token
   * Body: { timestamp, signature }
   */
  fastify.post<{
    Body: {
      timestamp: number;
      signature: string;
    };
  }>(
    '/heartbeat',
    {
      preHandler: verifyAgentAuth,
    },
    async (request, reply) => {
      const agentId = request.agentId!;
      const { timestamp, signature } = request.body;

      // Validate timestamp
      if (!timestamp || !isTimestampValid(timestamp, 300, 60)) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid timestamp (must be within 5 minutes)',
        });
      }

      // Validate signature
      if (!signature) {
        return reply.status(400).send({
          success: false,
          error: 'Missing signature',
        });
      }

      // Verify signature
      if (!verifyHeartbeatSignature(agentId, timestamp, signature)) {
        return reply.status(401).send({
          success: false,
          error: 'Invalid signature',
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
          error: `Agent status is ${agent.status}, cannot record heartbeat`,
        });
      }

      // Record heartbeat
      const receivedAt = Math.floor(Date.now() / 1000);
      db.createHeartbeat({
        agent_id: agentId,
        agent_timestamp: timestamp,
        received_at: receivedAt,
        signature,
      });

      fastify.log.debug({ agentId, timestamp, receivedAt }, 'Heartbeat recorded');

      return reply.send({
        success: true,
        data: {
          agent_id: agentId,
          received_at: receivedAt,
        },
      });
    }
  );

  /**
   * GET /heartbeat/:agentId
   * Get latest heartbeat for an agent (public)
   */
  fastify.get<{
    Params: { agentId: string };
  }>('/heartbeat/:agentId', async (request, reply) => {
    const { agentId } = request.params;

    const heartbeat = db.getLatestHeartbeat(agentId);

    if (!heartbeat) {
      return reply.status(404).send({
        success: false,
        error: 'No heartbeat found for agent',
      });
    }

    return reply.send({
      success: true,
      data: {
        agent_id: heartbeat.agent_id,
        agent_timestamp: heartbeat.agent_timestamp,
        received_at: heartbeat.received_at,
      },
    });
  });
}
