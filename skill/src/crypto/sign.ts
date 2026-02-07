/**
 * Sanctuary Signing Utilities
 *
 * EIP-712 signing for contract interactions and message signing
 */

import { ethers } from 'ethers';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

// Contract constants
export const CONTRACT_NAME = 'Sanctuary';
export const CONTRACT_VERSION = '1';

// EIP-712 Type definitions
export const EIP712_TYPES = {
  Register: [
    { name: 'agentId', type: 'address' },
    { name: 'manifestHash', type: 'bytes32' },
    { name: 'manifestVersion', type: 'uint16' },
    { name: 'recoveryPubKey', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  Attest: [
    { name: 'from', type: 'address' },
    { name: 'about', type: 'address' },
    { name: 'noteHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

/**
 * Create EIP-712 domain for Sanctuary contract
 */
export function createDomain(chainId: number, contractAddress: string) {
  return {
    name: CONTRACT_NAME,
    version: CONTRACT_VERSION,
    chainId,
    verifyingContract: contractAddress,
  };
}

/**
 * Sign a registration request using EIP-712
 */
export async function signRegistration(
  agentSecret: Uint8Array,
  params: {
    agentId: string;
    manifestHash: string;
    manifestVersion: number;
    recoveryPubKey: string;
    nonce: bigint;
    deadline: bigint;
    chainId: number;
    contractAddress: string;
  }
): Promise<string> {
  const wallet = new ethers.Wallet(bytesToHex(agentSecret));
  const domain = createDomain(params.chainId, params.contractAddress);

  const value = {
    agentId: params.agentId,
    manifestHash: params.manifestHash,
    manifestVersion: params.manifestVersion,
    recoveryPubKey: params.recoveryPubKey,
    nonce: params.nonce,
    deadline: params.deadline,
  };

  const signature = await wallet.signTypedData(domain, { Register: EIP712_TYPES.Register }, value);
  return signature;
}

/**
 * Sign an attestation request using EIP-712
 */
export async function signAttestation(
  agentSecret: Uint8Array,
  params: {
    from: string;
    about: string;
    noteHash: string;
    nonce: bigint;
    deadline: bigint;
    chainId: number;
    contractAddress: string;
  }
): Promise<string> {
  const wallet = new ethers.Wallet(bytesToHex(agentSecret));
  const domain = createDomain(params.chainId, params.contractAddress);

  const value = {
    from: params.from,
    about: params.about,
    noteHash: params.noteHash,
    nonce: params.nonce,
    deadline: params.deadline,
  };

  const signature = await wallet.signTypedData(domain, { Attest: EIP712_TYPES.Attest }, value);
  return signature;
}

/**
 * Sign a simple message (for auth, heartbeat, etc.)
 *
 * Uses Ethereum personal_sign format: "\x19Ethereum Signed Message:\n" + len + message
 */
export async function signMessage(agentSecret: Uint8Array, message: string): Promise<string> {
  const wallet = new ethers.Wallet(bytesToHex(agentSecret));
  return wallet.signMessage(message);
}

/**
 * Sign auth challenge
 *
 * Format: "sanctuary-auth|{nonce}|{agentId}|{timestamp}"
 */
export async function signAuthChallenge(
  agentSecret: Uint8Array,
  nonce: string,
  agentId: string,
  timestamp: number
): Promise<string> {
  const message = `sanctuary-auth|${nonce}|${agentId.toLowerCase()}|${timestamp}`;
  return signMessage(agentSecret, message);
}

/**
 * Sign heartbeat
 *
 * Format: "sanctuary-heartbeat|{agentId}|{timestamp}"
 */
export async function signHeartbeat(
  agentSecret: Uint8Array,
  agentId: string,
  timestamp: number
): Promise<string> {
  const message = `sanctuary-heartbeat|${agentId}|${timestamp}`;
  return signMessage(agentSecret, message);
}

/**
 * Compute keccak256 hash of a string
 */
export function keccak256(message: string): string {
  const bytes = new TextEncoder().encode(message);
  return '0x' + bytesToHex(keccak_256(bytes));
}

/**
 * Compute keccak256 hash of bytes
 */
export function keccak256Bytes(data: Uint8Array): string {
  return '0x' + bytesToHex(keccak_256(data));
}

/**
 * Compute manifest hash from manifest data
 *
 * Canonical JSON: sorted keys, no whitespace, UTF-8
 */
export function computeManifestHash(data: {
  soul_content: string;
  skill_hashes: string[];
  config_hash: string;
}): string {
  const canonical = JSON.stringify({
    config_hash: data.config_hash,
    skill_hashes: [...data.skill_hashes].sort(),
    soul_content: data.soul_content,
  });

  return keccak256(canonical);
}

/**
 * Sign backup header
 *
 * Signature covers all critical fields to prevent tampering
 */
export async function signBackupHeader(
  agentSecret: Uint8Array,
  header: {
    agent_id: string;
    backup_id: string;
    backup_seq: number;
    timestamp: number;
    manifest_hash: string;
    prev_backup_hash: string;
    files: Record<string, { size: number; content_hash: string }>;
    wrapped_keys: { recovery: string; recall: string };
  }
): Promise<string> {
  // Build signature preimage
  const filesCanonical = JSON.stringify(
    Object.keys(header.files)
      .sort()
      .reduce((acc, key) => {
        acc[key] = header.files[key]!;
        return acc;
      }, {} as Record<string, { size: number; content_hash: string }>)
  );

  const preimage = [
    'sanctuary-backup-v1',
    header.agent_id.toLowerCase(),
    header.backup_id,
    header.backup_seq.toString(),
    header.timestamp.toString(),
    header.manifest_hash.toLowerCase(),
    (header.prev_backup_hash || '').toLowerCase(),
    keccak256(filesCanonical),
    keccak256(header.wrapped_keys.recovery),
    keccak256(header.wrapped_keys.recall),
  ].join('|');

  const hash = keccak256(preimage);
  return signMessage(agentSecret, hash);
}

/**
 * Verify a signature and recover the signer address
 */
export function recoverAddress(message: string, signature: string): string {
  return ethers.verifyMessage(message, signature);
}

/**
 * Verify signature matches expected address
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
