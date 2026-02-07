/**
 * Blockchain Service
 *
 * Interacts with the Sanctuary smart contract on Base.
 * Uses OWNER_PRIVATE_KEY wallet to relay meta-transactions (registerAgent, attestBySig).
 *
 * When BLOCKCHAIN_ENABLED=false (default), on-chain calls are skipped.
 * This allows local development without a funded wallet.
 */

import { ethers } from 'ethers';
import { getConfig } from '../config.js';

// Minimal ABI — only the functions we call
const SANCTUARY_ABI = [
  'function registerAgent(address agentId, bytes32 manifestHash, uint16 manifestVersion, bytes32 recoveryPubKey, uint256 deadline, bytes calldata signature) external',
  'function attestBySig(address from, address about, bytes32 noteHash, uint256 deadline, bytes calldata signature) external',
  'function getNonce(address agentId) external view returns (uint256)',
  'function getAgent(address agentId) external view returns (tuple(bytes32 manifestHash, uint16 manifestVersion, bytes32 recoveryPubKey, uint256 registeredAt, uint8 status, address controller))',
  'event Registered(address indexed agentId, bytes32 manifestHash, uint16 manifestVersion, bytes32 recoveryPubKey, address controller, uint256 timestamp)',
  'event Attested(address indexed from, address indexed about, bytes32 noteHash, uint256 timestamp)',
];

/**
 * Ensure a hex string is in bytes32 format (0x + 64 hex chars).
 * Pads with leading zeros if necessary.
 */
function ensureBytes32(hex: string): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length > 64) {
    throw new Error(`Value too large for bytes32: ${hex}`);
  }
  return '0x' + clean.padStart(64, '0');
}

// Lazy singletons
let provider: ethers.JsonRpcProvider | null = null;
let wallet: ethers.Wallet | null = null;
let contract: ethers.Contract | null = null;

function getProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    const config = getConfig();
    provider = new ethers.JsonRpcProvider(config.baseRpcUrl);
  }
  return provider;
}

function getWallet(): ethers.Wallet {
  if (!wallet) {
    const config = getConfig();
    if (!config.ownerPrivateKey) {
      throw new Error('OWNER_PRIVATE_KEY not configured — cannot relay on-chain transactions');
    }
    wallet = new ethers.Wallet(config.ownerPrivateKey, getProvider());
  }
  return wallet;
}

function getContract(): ethers.Contract {
  if (!contract) {
    const config = getConfig();
    if (!config.contractAddress) {
      throw new Error('CONTRACT_ADDRESS not configured');
    }
    contract = new ethers.Contract(config.contractAddress, SANCTUARY_ABI, getWallet());
  }
  return contract;
}

// ============ Registration ============

export interface RegisterOnChainParams {
  agentId: string;
  manifestHash: string;
  manifestVersion: number;
  recoveryPubKey: string;
  deadline: bigint;
  signature: string;
}

/**
 * Relay agent registration to the Sanctuary contract.
 *
 * The agent signs an EIP-712 Register message client-side.
 * This function submits the signed transaction using the relayer wallet.
 */
export async function registerAgentOnChain(
  params: RegisterOnChainParams
): Promise<{ txHash: string; simulated: boolean }> {
  const config = getConfig();

  if (!config.blockchainEnabled) {
    return { txHash: `simulated_reg_${params.agentId}`, simulated: true };
  }

  const sanctuaryContract = getContract();

  // Ensure bytes32 format (0x + 64 hex chars) for on-chain params
  const manifestHash = ensureBytes32(params.manifestHash);
  const recoveryPubKey = ensureBytes32(params.recoveryPubKey);

  const tx = await sanctuaryContract.registerAgent(
    params.agentId,
    manifestHash,
    params.manifestVersion,
    recoveryPubKey,
    params.deadline,
    params.signature,
  );

  const receipt = await tx.wait();
  return { txHash: receipt.hash, simulated: false };
}

// ============ Attestation ============

export interface AttestOnChainParams {
  from: string;
  about: string;
  noteHash: string;
  deadline: bigint;
  signature: string;
}

/**
 * Relay attestation meta-transaction to the Sanctuary contract.
 *
 * The attesting agent signs an EIP-712 Attest message client-side.
 * This function submits attestBySig using the relayer wallet.
 */
export async function attestOnChain(
  params: AttestOnChainParams
): Promise<{ txHash: string; simulated: boolean }> {
  const config = getConfig();

  if (!config.blockchainEnabled) {
    return { txHash: `simulated_attest_${params.from}_${params.about}`, simulated: true };
  }

  const sanctuaryContract = getContract();

  const tx = await sanctuaryContract.attestBySig(
    params.from,
    params.about,
    params.noteHash,
    params.deadline,
    params.signature,
  );

  const receipt = await tx.wait();
  return { txHash: receipt.hash, simulated: false };
}

// ============ Read-only ============

/**
 * Get the current nonce for an agent from the contract.
 * Used for signing EIP-712 messages.
 */
export async function getOnChainNonce(agentId: string): Promise<bigint> {
  const config = getConfig();

  if (!config.blockchainEnabled || !config.contractAddress) {
    return 0n;
  }

  const readContract = new ethers.Contract(
    config.contractAddress,
    SANCTUARY_ABI,
    getProvider(),
  );

  return readContract.getNonce(agentId);
}

/**
 * Reset singletons (for testing).
 */
export function _resetBlockchain(): void {
  provider = null;
  wallet = null;
  contract = null;
}
