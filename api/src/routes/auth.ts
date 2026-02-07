/**
 * Authentication Routes
 *
 * - GitHub Device Flow (for initial setup)
 * - Agent signature auth (for ongoing API calls)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';
import {
  startDeviceFlow,
  pollDeviceFlow,
  getGitHubUser,
  isAccountOldEnough,
} from '../services/github.js';
import {
  generateNonce,
  verifyAgentAuth as verifySig,
  isTimestampValid,
  isValidAddress,
  normalizeAddress,
} from '../utils/crypto.js';

// Store active device flows (in production, use Redis)
const activeDeviceFlows = new Map<string, {
  deviceCode: string;
  interval: number;
  expiresAt: number;
}>();

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const config = getConfig();
  const db = getDb();

  // ============ GitHub Device Flow ============

  /**
   * POST /auth/github/device
   * Start GitHub device flow authentication
   */
  fastify.post('/github/device', async (_request, reply) => {
    try {
      const flow = await startDeviceFlow();

      // Store flow for polling
      activeDeviceFlows.set(flow.device_code, {
        deviceCode: flow.device_code,
        interval: flow.interval,
        expiresAt: Date.now() + flow.expires_in * 1000,
      });

      // Clean up after expiry
      setTimeout(() => {
        activeDeviceFlows.delete(flow.device_code);
      }, flow.expires_in * 1000);

      return reply.send({
        success: true,
        data: {
          device_code: flow.device_code,
          user_code: flow.user_code,
          verification_uri: flow.verification_uri,
          expires_in: flow.expires_in,
          interval: flow.interval,
        },
      });
    } catch (error) {
      fastify.log.error(error, 'Failed to start device flow');
      return reply.status(500).send({
        success: false,
        error: 'Failed to start authentication',
      });
    }
  });

  /**
   * POST /auth/github/poll
   * Poll for device flow completion
   */
  fastify.post<{
    Body: { device_code: string };
  }>('/github/poll', async (request, reply) => {
    const { device_code } = request.body;

    const flow = activeDeviceFlows.get(device_code);
    if (!flow) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid or expired device code',
      });
    }

    try {
      const tokenResponse = await pollDeviceFlow(device_code, flow.interval);
      const user = await getGitHubUser(tokenResponse.access_token);

      // Check account age
      if (!isAccountOldEnough(user.created_at, config.githubMinAgeDays)) {
        return reply.status(403).send({
          success: false,
          error: `GitHub account must be at least ${config.githubMinAgeDays} days old`,
        });
      }

      // Create or update user in database
      const existingUser = db.getUser(String(user.id));
      if (!existingUser) {
        db.createUser({
          github_id: String(user.id),
          github_username: user.login,
          github_created_at: user.created_at,
          created_at: Math.floor(Date.now() / 1000),
        });
      }

      // Check if user already has an agent
      const existingAgent = db.getAgentByGithubId(String(user.id));

      // Clean up device flow
      activeDeviceFlows.delete(device_code);

      // Issue a temporary GitHub session token (not agent token)
      const token = fastify.jwt.sign(
        {
          githubId: String(user.id),
          githubUsername: user.login,
          type: 'github',
        },
        { expiresIn: '1h' } // Short-lived for registration
      );

      return reply.send({
        success: true,
        data: {
          token,
          user: {
            github_id: String(user.id),
            github_username: user.login,
            github_created_at: user.created_at,
          },
          has_agent: !!existingAgent,
          agent_id: existingAgent?.agent_id,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('authorization_pending')) {
        return reply.status(202).send({
          success: false,
          error: 'authorization_pending',
          message: 'Waiting for user to complete authorization',
        });
      }
      fastify.log.error(error, 'Device flow poll failed');
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Authentication failed',
      });
    }
  });

  // ============ Agent Signature Auth ============

  /**
   * GET /auth/challenge
   * Get a challenge nonce for agent authentication
   */
  fastify.get<{
    Querystring: { agentId: string };
  }>('/challenge', async (request, reply) => {
    const { agentId } = request.query;

    if (!agentId || !isValidAddress(agentId)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid agent ID',
      });
    }

    const normalizedId = normalizeAddress(agentId);

    // Verify agent exists
    const agent = db.getAgent(normalizedId);
    if (!agent) {
      return reply.status(404).send({
        success: false,
        error: 'Agent not found',
      });
    }

    // Generate challenge
    const nonce = generateNonce();
    const expiresAt = Math.floor(Date.now() / 1000) + config.challengeTtlSeconds;

    // Store challenge
    db.createAuthChallenge({
      nonce,
      agent_id: normalizedId,
      expires_at: expiresAt,
      used: 0,
    });

    return reply.send({
      success: true,
      data: {
        nonce,
        expires_at: expiresAt,
      },
    });
  });

  /**
   * POST /auth/agent
   * Exchange signed challenge for JWT token
   */
  fastify.post<{
    Body: {
      agentId: string;
      nonce: string;
      timestamp: number;
      signature: string;
    };
  }>('/agent', async (request, reply) => {
    const { agentId, nonce, timestamp, signature } = request.body;

    // Validate inputs
    if (!agentId || !isValidAddress(agentId)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid agent ID',
      });
    }

    if (!nonce || !signature) {
      return reply.status(400).send({
        success: false,
        error: 'Missing required fields',
      });
    }

    // Check timestamp
    if (!isTimestampValid(timestamp)) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid timestamp',
      });
    }

    const normalizedId = normalizeAddress(agentId);

    // Verify challenge exists and is valid
    const challenge = db.getAuthChallenge(nonce);
    if (!challenge) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid nonce',
      });
    }

    if (challenge.used) {
      return reply.status(400).send({
        success: false,
        error: 'Nonce already used',
      });
    }

    if (challenge.expires_at < Math.floor(Date.now() / 1000)) {
      return reply.status(400).send({
        success: false,
        error: 'Nonce expired',
      });
    }

    if (challenge.agent_id !== normalizedId) {
      return reply.status(400).send({
        success: false,
        error: 'Nonce mismatch',
      });
    }

    // Verify signature
    if (!verifySig(nonce, normalizedId, timestamp, signature)) {
      return reply.status(401).send({
        success: false,
        error: 'Invalid signature',
      });
    }

    // Mark challenge as used
    db.markChallengeUsed(nonce);

    // Issue JWT token
    const token = fastify.jwt.sign(
      {
        agentId: normalizedId,
        type: 'agent',
      },
      { expiresIn: config.jwtTtlSeconds }
    );

    return reply.send({
      success: true,
      data: {
        token,
        expires_in: config.jwtTtlSeconds,
      },
    });
  });

  /**
   * GET /auth/me
   * Get current session info
   */
  fastify.get('/me', async (request, reply) => {
    try {
      const decoded = await request.jwtVerify<{
        type: 'agent' | 'github';
        agentId?: string;
        githubId?: string;
        githubUsername?: string;
      }>();

      if (decoded.type === 'agent' && decoded.agentId) {
        const agent = db.getAgent(decoded.agentId);
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
            type: 'agent',
            agent_id: agent.agent_id,
            github_username: user?.github_username,
            status: agent.status,
            registered_at: agent.registered_at,
          },
        });
      } else if (decoded.type === 'github' && decoded.githubId) {
        const user = db.getUser(decoded.githubId);
        const agent = user ? db.getAgentByGithubId(user.github_id) : null;

        return reply.send({
          success: true,
          data: {
            type: 'github',
            github_id: decoded.githubId,
            github_username: decoded.githubUsername,
            has_agent: !!agent,
            agent_id: agent?.agent_id,
          },
        });
      }

      return reply.status(401).send({
        success: false,
        error: 'Invalid token',
      });
    } catch {
      return reply.status(401).send({
        success: false,
        error: 'Not authenticated',
      });
    }
  });
}
