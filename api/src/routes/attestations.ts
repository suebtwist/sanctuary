/**
 * Attestation Routes
 *
 * Relay signed attestation meta-transactions to the Sanctuary contract.
 * Store attestation notes in the database for off-chain reference.
 */

import { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { verifyAgentAuth } from '../middleware/agent-auth.js';
import { isValidAddress, normalizeAddress } from '../utils/crypto.js';
import { attestOnChain } from '../services/blockchain.js';
import { recomputeAgentTrust } from '../services/trust-calculator.js';

export async function attestationRoutes(fastify: FastifyInstance): Promise<void> {
  const db = getDb();

  /**
   * POST /attestations/relay
   * Relay a signed attestation meta-transaction to the contract.
   *
   * The agent signs an EIP-712 Attest message client-side.
   * This endpoint submits attestBySig using the relayer wallet.
   *
   * Body: { from, about, noteHash, deadline, signature, note? }
   */
  fastify.post<{
    Body: {
      from: string;
      about: string;
      noteHash: string;
      deadline: number;
      signature: string;
      note?: string;
    };
  }>(
    '/relay',
    { preHandler: verifyAgentAuth },
    async (request, reply) => {
      const { from, about, noteHash, deadline, signature, note } = request.body;
      const agentId = request.agentId!;

      // Validate: the authenticated agent must be the attester
      if (!isValidAddress(from) || normalizeAddress(from) !== agentId) {
        return reply.status(403).send({
          success: false,
          error: 'Authenticated agent must be the attester',
        });
      }

      if (!isValidAddress(about)) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid target agent address',
        });
      }

      // Block self-attestation (mirrors contract require(from != about))
      if (normalizeAddress(from) === normalizeAddress(about)) {
        return reply.status(400).send({
          success: false,
          error: 'Cannot attest to yourself',
        });
      }

      if (!noteHash || !/^0x[a-fA-F0-9]{64}$/.test(noteHash)) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid noteHash (must be 32 bytes hex)',
        });
      }

      if (!signature) {
        return reply.status(400).send({
          success: false,
          error: 'Missing signature',
        });
      }

      if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline < Math.floor(Date.now() / 1000)) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid or expired deadline',
        });
      }

      // Store attestation note if provided
      if (note) {
        db.createAttestationNote({
          hash: noteHash,
          content: note.slice(0, 5000), // cap at 5KB
          created_at: Math.floor(Date.now() / 1000),
        });
      }

      const normalizedFrom = normalizeAddress(from);
      const normalizedAbout = normalizeAddress(about);

      // Check for duplicate attestation (cooldown: 7 days matching contract)
      const ATTESTATION_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
      const cooldownCutoff = Math.floor(Date.now() / 1000) - ATTESTATION_COOLDOWN_SECONDS;
      if (db.hasRecentAttestation(normalizedFrom, normalizedAbout, cooldownCutoff)) {
        return reply.status(429).send({
          success: false,
          error: 'Attestation cooldown active (7 days between attestations to the same agent)',
        });
      }

      // Store attestation record immediately (before chain relay)
      const now = Math.floor(Date.now() / 1000);
      db.createAttestation({
        from_agent: normalizedFrom,
        about_agent: normalizedAbout,
        note_hash: noteHash,
        tx_hash: 'pending',
        simulated: 0,
        created_at: now,
      });

      // Fire-and-forget relay to chain (don't block HTTP response)
      attestOnChain({
        from: normalizedFrom,
        about: normalizedAbout,
        noteHash,
        deadline: BigInt(deadline),
        signature,
      }).then(result => {
        if (result.simulated) {
          fastify.log.warn({ from: agentId, about }, 'Attestation relay simulated (BLOCKCHAIN_ENABLED=false)');
        } else {
          fastify.log.info({ from: agentId, about, txHash: result.txHash }, 'Attestation relayed on-chain');
        }

        // Update with real tx_hash
        db.updateAttestationTxHash(normalizedFrom, normalizedAbout, noteHash, result.txHash, result.simulated ? 1 : 0);

        // Recompute trust for the attested agent
        recomputeAgentTrust(normalizedAbout).catch(err => {
          fastify.log.error(err, 'Failed to recompute trust after attestation');
        });
      }).catch(err => {
        db.updateAttestationTxHash(normalizedFrom, normalizedAbout, noteHash, 'failed', 0);
        fastify.log.error(err, 'Attestation relay failed');
      });

      return reply.status(202).send({
        success: true,
        data: {
          status: 'pending',
          from: normalizedFrom,
          about: normalizedAbout,
          note_hash: noteHash,
        },
      });
    }
  );
}
