/**
 * Agent Authentication Middleware
 *
 * Verifies JWT tokens issued to authenticated agents
 */

import { FastifyRequest, FastifyReply } from 'fastify';

// Extend FastifyRequest to include agent info
declare module 'fastify' {
  interface FastifyRequest {
    agentId?: string;
  }
}

/**
 * Middleware to verify agent JWT token
 *
 * Expects: Authorization: Bearer <token>
 * Sets: request.agentId
 */
export async function verifyAgentAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    // @fastify/jwt adds jwtVerify to request
    const decoded = await request.jwtVerify<{ agentId: string; type: 'agent' }>();

    if (decoded.type !== 'agent') {
      return reply.status(401).send({
        success: false,
        error: 'Invalid token type',
      });
    }

    request.agentId = decoded.agentId;
  } catch (err) {
    return reply.status(401).send({
      success: false,
      error: 'Invalid or expired token',
    });
  }
}

/**
 * Optional agent auth - doesn't fail if no token present
 * Useful for endpoints that have different behavior for authenticated users
 */
export async function optionalAgentAuth(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  try {
    const decoded = await request.jwtVerify<{ agentId: string; type: 'agent' }>();
    if (decoded.type === 'agent') {
      request.agentId = decoded.agentId;
    }
  } catch {
    // Token not present or invalid, that's ok
    request.agentId = undefined;
  }
}
