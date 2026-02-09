/**
 * Rate Limiting Configuration
 *
 * Custom rate limits for different endpoints
 */

import { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Apply stricter rate limits to specific routes
 */
export function configureRateLimits(fastify: FastifyInstance): void {
  // Heartbeat: 10 per minute
  fastify.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url === '/heartbeat' && routeOptions.method === 'POST') {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      };
    }
  });

  // Registration: 3 per hour
  fastify.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url === '/agents/register' && routeOptions.method === 'POST') {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 3,
          timeWindow: '1 hour',
        },
      };
    }
  });

  // Backup upload: 1 per day
  fastify.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url === '/backups/upload' && routeOptions.method === 'POST') {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 1,
          timeWindow: '1 day',
          keyGenerator: (request: FastifyRequest) => {
            // Rate limit per agent
            return (request as any).agentId || request.ip;
          },
        },
      };
    }
  });

  // Auth challenge: 10 per minute per IP (prevents DB row spam)
  fastify.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url === '/auth/challenge' && routeOptions.method === 'GET') {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      };
    }
  });

  // Resurrection: 5 per IP per hour (brute-force prevention)
  fastify.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url === '/agents/:agentId/resurrect' && routeOptions.method === 'POST') {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 5,
          timeWindow: '1 hour',
        },
      };
    }
  });

  // Noise analysis: 30 per minute per IP (default, configurable via NOISE_RATE_LIMIT)
  fastify.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url === '/noise/analyze' && routeOptions.method === 'GET') {
      routeOptions.config = {
        ...routeOptions.config,
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      };
    }
  });
}
