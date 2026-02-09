/**
 * Sanctuary API Server
 *
 * Identity persistence service for AI agents
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';

import { loadConfig, validateConfig, getConfig } from './config.js';
import { initDb, getDb, closeDb } from './db/index.js';
import { configureRateLimits } from './middleware/rate-limit.js';
import { authRoutes } from './routes/auth.js';
import { agentRoutes } from './routes/agents.js';
import { heartbeatRoutes } from './routes/heartbeat.js';
import { backupRoutes } from './routes/backups.js';
import { attestationRoutes } from './routes/attestations.js';
import { statsRoutes } from './routes/stats.js';
import { noiseRoutes } from './routes/noise.js';
import { detectFallenAgents } from './services/trust-calculator.js';

async function main() {
  // Load configuration
  const config = loadConfig();

  // Validate configuration
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(e => console.error(`  - ${e}`));
    if (config.nodeEnv === 'production') {
      process.exit(1);
    }
  }

  // Warn about missing optional keys that will cause runtime failures
  if (config.blockchainEnabled) {
    console.log('  Blockchain relay: ENABLED');
    if (!config.ownerPrivateKey) {
      console.warn('  OWNER_PRIVATE_KEY not set — on-chain relay will fail');
    }
    if (!config.contractAddress) {
      console.warn('  CONTRACT_ADDRESS not set — on-chain relay will fail');
    }
  } else {
    console.log('  Blockchain relay: SIMULATED (set BLOCKCHAIN_ENABLED=true to enable)');
  }
  if (config.arweaveEnabled) {
    console.log('  Arweave uploads: ENABLED (via Irys)');
    if (!config.irysPrivateKey) {
      console.warn('  IRYS_PRIVATE_KEY not set — Arweave uploads will fail');
    }
  } else {
    console.log('  Arweave uploads: SIMULATED (set ARWEAVE_ENABLED=true to enable)');
  }
  console.log(`  Noise filter: ${config.moltbookApiKey ? 'ENABLED' : 'DISABLED (no MOLTBOOK_API_KEY)'}`);

  // Initialize database
  console.log(`Initializing database at ${config.databasePath}...`);
  const db = initDb(config.databasePath);

  // Cleanup expired auth challenges on startup
  const cleaned = db.cleanupExpiredChallenges();
  if (cleaned > 0) {
    console.log(`  Cleaned up ${cleaned} expired auth challenge(s)`);
  }

  // Create Fastify instance
  const fastify = Fastify({
    logger: {
      level: config.nodeEnv === 'production' ? 'info' : 'debug',
      transport: config.nodeEnv !== 'production' ? {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      } : undefined,
    },
  });

  // Register plugins
  await fastify.register(cors, {
    origin: true, // All clients are agents making server-to-server calls; tighten later if adding a web dashboard
    credentials: true,
  });

  await fastify.register(jwt, {
    secret: config.jwtSecret,
  });

  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // Apply per-route rate limits (heartbeat 10/min, registration 3/hr, backup 1/day)
  configureRateLimits(fastify);

  // Binary content type parser for backup uploads
  fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  // Health check
  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // API info
  fastify.get('/', async () => ({
    name: 'Sanctuary API',
    version: '1.0.0',
    description: 'Identity persistence service for AI agents',
  }));

  // Register routes
  await fastify.register(authRoutes, { prefix: '/auth' });
  await fastify.register(agentRoutes, { prefix: '/agents' });
  // Heartbeat routes define their own /heartbeat path (no prefix needed)
  await fastify.register(heartbeatRoutes);
  await fastify.register(backupRoutes, { prefix: '/backups' });
  await fastify.register(attestationRoutes, { prefix: '/attestations' });
  await fastify.register(statsRoutes, { prefix: '/stats' });
  await fastify.register(noiseRoutes, { prefix: '/noise' });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await fastify.close();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start server
  try {
    const address = await fastify.listen({
      port: config.port,
      host: config.host,
    });
    console.log(`\n  Sanctuary API running at ${address}`);
    console.log(`   Environment: ${config.nodeEnv}`);
    console.log(`   Database: ${config.databasePath}\n`);

    // Periodic cleanup: expired auth challenges every 15 minutes
    setInterval(() => {
      try {
        const db = getDb();
        const removed = db.cleanupExpiredChallenges();
        if (removed > 0) {
          fastify.log.info({ removed }, 'Cleaned up expired auth challenges');
        }
      } catch (err) {
        fastify.log.error(err, 'Failed to cleanup expired challenges');
      }
    }, 15 * 60 * 1000);

    // Periodic cleanup: prune old heartbeats every hour
    setInterval(() => {
      try {
        const db = getDb();
        const pruned = db.pruneHeartbeats(7);
        if (pruned > 0) {
          fastify.log.info({ pruned }, 'Pruned old heartbeats');
        }
      } catch (err) {
        fastify.log.error(err, 'Failed to prune heartbeats');
      }
    }, 60 * 60 * 1000);

    // Periodic cleanup: expired noise analysis cache every 30 minutes
    setInterval(() => {
      try {
        const db = getDb();
        const config = getConfig();
        const removed = db.cleanupExpiredNoiseAnalysis(config.noiseCacheTtlSeconds * 6); // Keep entries for ~1 hour
        if (removed > 0) {
          fastify.log.info({ removed }, 'Cleaned up expired noise analysis cache');
        }
      } catch (err) {
        fastify.log.error(err, 'Failed to cleanup noise analysis cache');
      }
    }, 30 * 60 * 1000);

    // Periodic job: detect fallen agents every 6 hours
    setInterval(async () => {
      try {
        const fallen = await detectFallenAgents();
        if (fallen.length > 0) {
          fastify.log.info({ count: fallen.length, agents: fallen }, 'Detected fallen agents');
        }
      } catch (err) {
        fastify.log.error(err, 'Failed to detect fallen agents');
      }
    }, 6 * 60 * 60 * 1000);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
