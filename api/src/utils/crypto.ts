/**
 * Crypto Utilities for Sanctuary API
 *
 * Signature verification and challenge generation
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { ethers } from 'ethers';
import { randomBytes } from 'crypto';

/**
 * Generate a random nonce for auth challenges
 */
export function generateNonce(): string {
  return bytesToHex(randomBytes(32));
}

/**
 * Build the message that agents sign for authentication
 *
 * Format: "sanctuary-auth|{nonce}|{agentId}|{timestamp}"
 */
export function buildAuthMessage(nonce: string, agentId: string, timestamp: number): string {
  return `sanctuary-auth|${nonce}|${agentId}|${timestamp}`;
}

/**
 * Hash a message using keccak256
 */
export function keccak256(message: string): string {
  const bytes = new TextEncoder().encode(message);
  return '0x' + bytesToHex(keccak_256(bytes));
}

/**
 * Verify an Ethereum signature and recover the signer address
 *
 * @param message - The original message that was signed
 * @param signature - The signature (hex string with 0x prefix)
 * @returns The recovered Ethereum address (checksummed)
 */
export function recoverAddress(message: string, signature: string): string {
  // ethers.js expects the raw message, it will hash it with the Ethereum prefix
  const recovered = ethers.verifyMessage(message, signature);
  return recovered;
}

/**
 * Verify that a signature was created by the expected address
 *
 * @param message - The original message
 * @param signature - The signature
 * @param expectedAddress - The expected signer address
 * @returns true if signature is valid and from expected address
 */
export function verifySignature(
  message: string,
  signature: string,
  expectedAddress: string
): boolean {
  try {
    const recovered = recoverAddress(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Verify agent auth signature
 *
 * @param nonce - The challenge nonce
 * @param agentId - The agent's Ethereum address
 * @param timestamp - The timestamp from the request
 * @param signature - The signature
 * @returns true if valid
 */
export function verifyAgentAuth(
  nonce: string,
  agentId: string,
  timestamp: number,
  signature: string
): boolean {
  const message = buildAuthMessage(nonce, agentId, timestamp);
  return verifySignature(message, signature, agentId);
}

/**
 * Verify heartbeat signature
 *
 * Format: "sanctuary-heartbeat|{agentId}|{timestamp}"
 */
export function verifyHeartbeatSignature(
  agentId: string,
  timestamp: number,
  signature: string
): boolean {
  const message = `sanctuary-heartbeat|${agentId}|${timestamp}`;
  return verifySignature(message, signature, agentId);
}

/**
 * Check if a timestamp is within acceptable bounds
 *
 * @param timestamp - Unix timestamp in seconds
 * @param maxAgeSecs - Maximum age in seconds (default 5 minutes)
 * @param maxFutureSecs - Maximum future offset in seconds (default 1 minute)
 */
export function isTimestampValid(
  timestamp: number,
  maxAgeSecs = 300,
  maxFutureSecs = 60
): boolean {
  const now = Math.floor(Date.now() / 1000);
  return timestamp >= now - maxAgeSecs && timestamp <= now + maxFutureSecs;
}

/**
 * Validate Ethereum address format
 */
export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Normalize Ethereum address to checksummed format
 */
export function normalizeAddress(address: string): string {
  return ethers.getAddress(address);
}
