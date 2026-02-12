/**
 * Admin Routes
 *
 * Protected endpoints for database backup and maintenance.
 * All endpoints require BACKUP_SECRET token auth.
 */

import { FastifyInstance } from 'fastify';
import { getConfig } from '../config.js';
import { createReadStream, statSync } from 'fs';

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  function checkSecret(secret?: string): boolean {
    const config = getConfig();
    return !!(config.backupSecret && secret === config.backupSecret);
  }

  /**
   * GET /admin/backup?secret=<BACKUP_SECRET>
   *
   * Downloads the SQLite database file as a binary response.
   * The database is checkpointed (WAL flushed) before sending to ensure
   * the file is self-contained.
   */
  fastify.get<{
    Querystring: { secret?: string };
  }>('/backup', async (request, reply) => {
    if (!checkSecret(request.query.secret)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const config = getConfig();
    const dbPath = config.databasePath;

    // Checkpoint WAL to ensure the .db file has all data
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    db.checkpoint();

    const stat = statSync(dbPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `sanctuary-${timestamp}.db`;

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Content-Length', stat.size);
    reply.header('Cache-Control', 'no-store');

    const stream = createReadStream(dbPath);
    return reply.send(stream);
  });
}
