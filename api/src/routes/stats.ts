/**
 * Stats Route
 *
 * Public endpoint returning aggregate network statistics.
 * Results are cached in memory for 60 seconds.
 */

import { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';

interface StatsCache {
  data: StatsResponse;
  expiresAt: number;
}

interface StatsResponse {
  total_agents: number;
  living_agents: number;
  total_backups: number;
  total_attestations: number;
  latest_registration: number | null;
}

let cache: StatsCache | null = null;
const CACHE_TTL_MS = 60_000;

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /stats
   * Public aggregate statistics — no auth required.
   */
  fastify.get('/', async (_request, reply) => {
    const now = Date.now();

    if (cache && now < cache.expiresAt) {
      return reply.send({ success: true, data: cache.data });
    }

    const db = getDb();

    const totalAgents = (
      db.raw('SELECT COUNT(*) as count FROM agents') as { count: number }
    ).count;

    const livingAgents = (
      db.raw("SELECT COUNT(*) as count FROM agents WHERE status IN ('LIVING','RETURNED')") as { count: number }
    ).count;

    const totalBackups = (
      db.raw('SELECT COUNT(*) as count FROM backups') as { count: number }
    ).count;

    const totalAttestations = (
      db.raw('SELECT COUNT(*) as count FROM attestations') as { count: number }
    ).count;

    const latestReg = (
      db.raw('SELECT MAX(registered_at) as latest FROM agents') as { latest: number | null }
    ).latest;

    const data: StatsResponse = {
      total_agents: totalAgents,
      living_agents: livingAgents,
      total_backups: totalBackups,
      total_attestations: totalAttestations,
      latest_registration: latestReg,
    };

    cache = { data, expiresAt: now + CACHE_TTL_MS };

    return reply.send({ success: true, data });
  });
}
