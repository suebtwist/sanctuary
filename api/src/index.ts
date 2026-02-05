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
import { initDb, closeDb } from './db/index.js';
import { authRoutes } from './routes/auth.js';
import { agentRoutes } from './routes/agents.js';
import { heartbeatRoutes } from './routes/heartbeat.js';
import { backupRoutes } from './routes/backups.js';

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

  // Initialize database
  console.log(`Initializing database at ${config.databasePath}...`);
  initDb(config.databasePath);

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
    origin: config.nodeEnv === 'production'
      ? ['https://sanctuary.dev', 'https://api.sanctuary.dev']
      : true,
    credentials: true,
  });

  await fastify.register(jwt, {
    secret: config.jwtSecret,
  });

  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
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
  await fastify.register(heartbeatRoutes);
  await fastify.register(backupRoutes, { prefix: '/backups' });

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
    console.log(`\n🏛️  Sanctuary API running at ${address}`);
    console.log(`   Environment: ${config.nodeEnv}`);
    console.log(`   Database: ${config.databasePath}\n`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
