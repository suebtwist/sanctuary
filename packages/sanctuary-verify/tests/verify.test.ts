/**
 * sanctuary-verify Tests
 *
 * Tests for:
 * - Each route returns correct format
 * - Challenge/respond flow end to end
 * - Invalid agent address → appropriate error
 * - API timeout → graceful failure
 * - Mock Sanctuary API responses
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import { ethers } from 'ethers';
import { sanctuaryRouter, _challenges } from '../src/middleware.js';

// ============ Mock Sanctuary API ============

function createMockApi(): express.Express {
  const app = express();
  app.use(express.json());

  // Mock GET /agents/:agentId/status
  app.get('/agents/:agentId/status', (req, res) => {
    const { agentId } = req.params;

    if (agentId === '0x0000000000000000000000000000000000000000') {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    res.json({
      success: true,
      data: {
        agent: {
          agent_id: agentId,
          github_username: 'testbot',
          manifest_hash: '0xabc',
          manifest_version: 1,
          registered_at: 1700000000,
          status: 'LIVING',
        },
        trust: {
          score: 82.5,
          level: 'ESTABLISHED',
          unique_attesters: 12,
          computed_at: 1700100000,
          breakdown: {
            age: 0.85,
            backup_consistency: 0.92,
            attestations: 0.78,
            model_stability: 0.95,
            genesis_completeness: 1.0,
            recovery_resilience: 0.5,
          },
        },
        backups: {
          count: 30,
          latest: {
            id: 'backup-1',
            backup_seq: 30,
            arweave_tx_id: 'arweave-tx-1',
            timestamp: 1700090000,
            size_bytes: 4096,
          },
        },
        heartbeat: {
          last_seen: 1700095000,
        },
      },
    });
  });

  // Mock GET /agents/:agentId (basic info)
  app.get('/agents/:agentId', (req, res) => {
    const { agentId } = req.params;

    if (agentId === '0x0000000000000000000000000000000000000000') {
      return res.status(404).json({ success: false, error: 'Agent not found' });
    }

    res.json({
      success: true,
      data: {
        agent_id: agentId,
        github_username: 'testbot',
        recovery_pubkey: '0x' + 'ab'.repeat(32),
        manifest_hash: '0xabc',
        manifest_version: 1,
        registered_at: 1700000000,
        status: 'LIVING',
      },
    });
  });

  return app;
}

// ============ Test Helpers ============

const VALID_AGENT = '0x1234567890abcdef1234567890abcdef12345678';
const ZERO_AGENT = '0x0000000000000000000000000000000000000000';
const INVALID_ADDR = 'not-an-address';

let mockApiServer: http.Server;
let mockApiPort: number;
let verifyServer: http.Server;
let verifyPort: number;

async function fetchJson(url: string, options?: RequestInit): Promise<any> {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.json() };
}

// ============ Setup ============

beforeAll(async () => {
  // Start mock Sanctuary API
  const mockApi = createMockApi();
  mockApiServer = await new Promise<http.Server>((resolve) => {
    const server = mockApi.listen(0, () => resolve(server));
  });
  mockApiPort = (mockApiServer.address() as any).port;

  // Start verify middleware server
  const app = express();
  app.use(express.json());
  app.use('/sanctuary', sanctuaryRouter({
    apiUrl: `http://localhost:${mockApiPort}`,
    timeout: 5000,
    challengeTtl: 60,
  }));

  verifyServer = await new Promise<http.Server>((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
  verifyPort = (verifyServer.address() as any).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => verifyServer.close(() => resolve()));
  await new Promise<void>((resolve) => mockApiServer.close(() => resolve()));
});

beforeEach(() => {
  // Clear challenge store between tests
  _challenges.clear();
});

// ============ Tests ============

describe('sanctuary-verify middleware', () => {
  // ============ GET /verify/:agent_address ============

  describe('GET /sanctuary/verify/:agent_address', () => {
    it('should return verify response for valid agent', async () => {
      const { status, body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/verify/${VALID_AGENT}`
      );

      expect(status).toBe(200);
      expect(body.verified).toBe(true);
      expect(body.trust_score).toBe(82.5);
      expect(body.attestation_count).toBe(12);
      expect(body.last_backup).toBeTruthy();
      expect(body.tier).toBe('ESTABLISHED');
    });

    it('should return 404 for unknown agent', async () => {
      const { status, body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/verify/${ZERO_AGENT}`
      );

      expect(status).toBe(404);
      expect(body.error).toBeTruthy();
    });

    it('should return 400 for invalid address format', async () => {
      const { status, body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/verify/${INVALID_ADDR}`
      );

      expect(status).toBe(400);
      expect(body.error).toContain('Invalid agent address');
    });

    it('should include ISO timestamp for last_backup', async () => {
      const { body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/verify/${VALID_AGENT}`
      );

      expect(body.last_backup).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // ============ GET /trust/:agent_address ============

  describe('GET /sanctuary/trust/:agent_address', () => {
    it('should return trust breakdown for valid agent', async () => {
      const { status, body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/trust/${VALID_AGENT}`
      );

      expect(status).toBe(200);
      expect(body.trust_score).toBe(82.5);
      expect(body.tier).toBe('ESTABLISHED');
      expect(body.breakdown).toBeDefined();
      expect(body.breakdown.age).toBe(0.85);
      expect(body.breakdown.backup_consistency).toBe(0.92);
      expect(body.breakdown.attestations).toBe(0.78);
      expect(body.breakdown.model_stability).toBe(0.95);
      expect(body.breakdown.genesis_completeness).toBe(1.0);
      expect(body.breakdown.recovery_resilience).toBe(0.5);
    });

    it('should return 404 for unknown agent', async () => {
      const { status } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/trust/${ZERO_AGENT}`
      );

      expect(status).toBe(404);
    });

    it('should return 400 for invalid address', async () => {
      const { status } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/trust/${INVALID_ADDR}`
      );

      expect(status).toBe(400);
    });
  });

  // ============ POST /challenge/:agent_address ============

  describe('POST /sanctuary/challenge/:agent_address', () => {
    it('should generate a challenge nonce', async () => {
      const { status, body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/challenge/${VALID_AGENT}`,
        { method: 'POST' }
      );

      expect(status).toBe(200);
      expect(body.challenge).toBeTruthy();
      expect(typeof body.challenge).toBe('string');
      expect(body.challenge.length).toBe(64); // 32 bytes hex
      expect(body.expires).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should store challenge in memory', async () => {
      const { body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/challenge/${VALID_AGENT}`,
        { method: 'POST' }
      );

      expect(_challenges.has(body.challenge)).toBe(true);
      const stored = _challenges.get(body.challenge)!;
      expect(stored.agentAddress).toBe(VALID_AGENT.toLowerCase());
    });

    it('should return 400 for invalid address', async () => {
      const { status } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/challenge/${INVALID_ADDR}`,
        { method: 'POST' }
      );

      expect(status).toBe(400);
    });
  });

  // ============ POST /respond ============

  describe('POST /sanctuary/respond', () => {
    it('should return 400 for missing fields', async () => {
      const { status, body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );

      expect(status).toBe(400);
      expect(body.error).toContain('Missing required fields');
    });

    it('should return 400 for invalid address in respond', async () => {
      const { status } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_address: 'bad',
            challenge: 'nonce',
            signature: '0xsig',
          }),
        }
      );

      expect(status).toBe(400);
    });

    it('should return 404 for unknown challenge', async () => {
      const { status, body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_address: VALID_AGENT,
            challenge: 'nonexistent_nonce',
            signature: '0xsig',
          }),
        }
      );

      expect(status).toBe(404);
      expect(body.error).toContain('Challenge not found');
    });

    it('should return 403 for challenge issued to different agent', async () => {
      // Create a challenge for a different agent
      const nonce = 'test_nonce_mismatch';
      _challenges.set(nonce, {
        nonce,
        agentAddress: '0xdifferentagent000000000000000000000000000',
        expiresAt: Date.now() + 60000,
      });

      const { status, body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_address: VALID_AGENT,
            challenge: nonce,
            signature: '0xsig',
          }),
        }
      );

      expect(status).toBe(403);
      expect(body.error).toContain('different agent');
    });

    it('should return 410 for expired challenge', async () => {
      const nonce = 'expired_nonce';
      _challenges.set(nonce, {
        nonce,
        agentAddress: VALID_AGENT.toLowerCase(),
        expiresAt: Date.now() - 1000, // already expired
      });

      const { status, body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_address: VALID_AGENT,
            challenge: nonce,
            signature: '0xsig',
          }),
        }
      );

      expect(status).toBe(410);
      expect(body.error).toContain('expired');
    });

    it('should return 400 for invalid signature format', async () => {
      const nonce = 'valid_nonce_bad_sig';
      _challenges.set(nonce, {
        nonce,
        agentAddress: VALID_AGENT.toLowerCase(),
        expiresAt: Date.now() + 60000,
      });

      const { status, body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_address: VALID_AGENT,
            challenge: nonce,
            signature: 'not-a-real-signature',
          }),
        }
      );

      expect(status).toBe(400);
      expect(body.error).toContain('Invalid signature');
    });
  });

  // ============ End-to-End Challenge/Respond ============

  describe('Challenge/respond end-to-end flow', () => {
    it('should verify a correctly signed challenge', async () => {
      // Use a real ethers wallet to sign
      const wallet = ethers.Wallet.createRandom();
      const agentAddress = wallet.address;

      // Step 1: Get challenge
      const { body: challengeBody } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/challenge/${agentAddress}`,
        { method: 'POST' }
      );

      expect(challengeBody.challenge).toBeTruthy();

      // Step 2: Sign challenge with wallet (personal_sign / EIP-191)
      const signature = await wallet.signMessage(challengeBody.challenge);

      // Step 3: Submit response
      const { status, body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_address: agentAddress,
            challenge: challengeBody.challenge,
            signature,
          }),
        }
      );

      expect(status).toBe(200);
      expect(body.verified).toBe(true);
      expect(body.agent_address).toBe(agentAddress.toLowerCase());
    });

    it('should reject signature from wrong wallet', async () => {
      const correctWallet = ethers.Wallet.createRandom();
      const wrongWallet = ethers.Wallet.createRandom();
      const agentAddress = correctWallet.address;

      // Get challenge
      const { body: challengeBody } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/challenge/${agentAddress}`,
        { method: 'POST' }
      );

      // Sign with WRONG wallet
      const signature = await wrongWallet.signMessage(challengeBody.challenge);

      // Submit
      const { status, body } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_address: agentAddress,
            challenge: challengeBody.challenge,
            signature,
          }),
        }
      );

      expect(status).toBe(403);
      expect(body.error).toContain('Signature verification failed');
    });

    it('should delete challenge after successful verification', async () => {
      const wallet = ethers.Wallet.createRandom();
      const agentAddress = wallet.address;

      // Get challenge
      const { body: challengeBody } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/challenge/${agentAddress}`,
        { method: 'POST' }
      );

      const signature = await wallet.signMessage(challengeBody.challenge);

      // Use challenge
      await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_address: agentAddress,
            challenge: challengeBody.challenge,
            signature,
          }),
        }
      );

      // Try to reuse — should fail
      const { status } = await fetchJson(
        `http://localhost:${verifyPort}/sanctuary/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_address: agentAddress,
            challenge: challengeBody.challenge,
            signature,
          }),
        }
      );

      expect(status).toBe(404); // challenge consumed
    });
  });

  // ============ API Timeout ============

  describe('API timeout handling', () => {
    it('should handle unreachable API gracefully', async () => {
      // Create a router pointing to a non-existent port
      const app = express();
      app.use(express.json());
      app.use('/sanctuary', sanctuaryRouter({
        apiUrl: 'http://localhost:1', // nothing running here
        timeout: 1000,
      }));

      const server = await new Promise<http.Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const port = (server.address() as any).port;

      try {
        const { status, body } = await fetchJson(
          `http://localhost:${port}/sanctuary/verify/${VALID_AGENT}`
        );

        expect(status).toBe(404);
        expect(body.error).toBeTruthy();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
