// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Sanctuary
 * @notice Identity persistence and attestation registry for AI agents
 * @dev Agents register with signed manifests, can attest to each other
 */
contract Sanctuary is EIP712, Ownable {
    enum Status { UNREGISTERED, LIVING, FALLEN, RETURNED }

    struct Agent {
        bytes32 manifestHash;      // keccak256 of canonical manifest
        uint16 manifestVersion;
        bytes32 recoveryPubKey;    // X25519 pubkey (32 bytes)
        uint256 registeredAt;
        Status status;
        address controller;        // Human wallet (optional, for future use)
    }

    // State
    mapping(address => Agent) public agents;
    mapping(address => uint256) public attestationCount;  // received count
    mapping(address => uint256) public attestNonces;      // for meta-tx replay protection
    mapping(bytes32 => uint256) public lastAttestation;   // pair hash → timestamp (cooldown)

    // Constants
    uint256 public constant ATTESTATION_COOLDOWN = 7 days;
    uint256 public constant VERIFIED_THRESHOLD = 5;
    uint256 public constant FALLEN_THRESHOLD = 30 days;

    // EIP-712 type hashes
    bytes32 public constant REGISTER_TYPEHASH = keccak256(
        "Register(address agentId,bytes32 manifestHash,uint16 manifestVersion,bytes32 recoveryPubKey,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant ATTEST_TYPEHASH = keccak256(
        "Attest(address from,address about,bytes32 noteHash,uint256 nonce,uint256 deadline)"
    );

    // Events
    event Registered(
        address indexed agentId,
        bytes32 manifestHash,
        uint16 manifestVersion,
        bytes32 recoveryPubKey,
        address controller,
        uint256 timestamp
    );
    event Attested(
        address indexed from,
        address indexed about,
        bytes32 noteHash,
        uint256 timestamp
    );
    event StatusChanged(
        address indexed agentId,
        Status oldStatus,
        Status newStatus,
        uint256 timestamp
    );

    constructor() EIP712("Sanctuary", "1") Ownable(msg.sender) {}

    /**
     * @notice Register a new agent with EIP-712 signature
     * @param agentId The Ethereum address derived from agent's secp256k1 key
     * @param manifestHash keccak256 hash of the canonical manifest
     * @param manifestVersion Version number of the manifest format
     * @param recoveryPubKey X25519 public key for backup decryption (32 bytes)
     * @param deadline Timestamp after which signature is invalid
     * @param signature EIP-712 signature from the agent
     */
    function registerAgent(
        address agentId,
        bytes32 manifestHash,
        uint16 manifestVersion,
        bytes32 recoveryPubKey,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(block.timestamp <= deadline, "Signature expired");
        require(agents[agentId].status == Status.UNREGISTERED, "Already registered");
        require(recoveryPubKey != bytes32(0), "Invalid recovery pubkey");

        uint256 nonce = attestNonces[agentId]++;

        bytes32 structHash = keccak256(abi.encode(
            REGISTER_TYPEHASH,
            agentId,
            manifestHash,
            manifestVersion,
            recoveryPubKey,
            nonce,
            deadline
        ));

        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        require(signer == agentId, "Invalid signature");

        agents[agentId] = Agent({
            manifestHash: manifestHash,
            manifestVersion: manifestVersion,
            recoveryPubKey: recoveryPubKey,
            registeredAt: block.timestamp,
            status: Status.LIVING,
            controller: address(0)
        });

        emit Registered(agentId, manifestHash, manifestVersion, recoveryPubKey, address(0), block.timestamp);
        emit StatusChanged(agentId, Status.UNREGISTERED, Status.LIVING, block.timestamp);
    }

    /**
     * @notice Attest to another agent (direct call)
     * @param about The agent being attested to
     * @param noteHash keccak256 hash of the attestation note (stored off-chain)
     */
    function attest(address about, bytes32 noteHash) external {
        _attest(msg.sender, about, noteHash);
    }

    /**
     * @notice Attest via meta-transaction (agent signs, anyone submits)
     * @param from The attesting agent
     * @param about The agent being attested to
     * @param noteHash keccak256 hash of the attestation note
     * @param deadline Timestamp after which signature is invalid
     * @param signature EIP-712 signature from the attesting agent
     */
    function attestBySig(
        address from,
        address about,
        bytes32 noteHash,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(block.timestamp <= deadline, "Signature expired");

        uint256 nonce = attestNonces[from]++;

        bytes32 structHash = keccak256(abi.encode(
            ATTEST_TYPEHASH,
            from,
            about,
            noteHash,
            nonce,
            deadline
        ));

        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        require(signer == from, "Invalid signature");

        _attest(from, about, noteHash);
    }

    /**
     * @dev Internal attestation logic
     */
    function _attest(address from, address about, bytes32 noteHash) internal {
        require(
            agents[from].status == Status.LIVING || agents[from].status == Status.RETURNED,
            "Attester not active"
        );
        require(agents[about].status != Status.UNREGISTERED, "Target not registered");
        require(from != about, "Cannot self-attest");

        bytes32 pairHash = keccak256(abi.encodePacked(from, about));
        require(
            block.timestamp >= lastAttestation[pairHash] + ATTESTATION_COOLDOWN,
            "Cooldown active"
        );

        lastAttestation[pairHash] = block.timestamp;
        attestationCount[about]++;

        emit Attested(from, about, noteHash, block.timestamp);
    }

    /**
     * @notice Mark an agent as fallen (owner only, after 30 days no heartbeat)
     * @param agentId The agent to mark as fallen
     */
    function markFallen(address agentId) external onlyOwner {
        require(agents[agentId].status == Status.LIVING, "Not living");
        Status oldStatus = agents[agentId].status;
        agents[agentId].status = Status.FALLEN;
        emit StatusChanged(agentId, oldStatus, Status.FALLEN, block.timestamp);
    }

    /**
     * @notice Mark an agent as returned after resurrection (owner only)
     * @param agentId The agent that has returned
     * @param newManifestHash New manifest hash after resurrection
     * @param newVersion New manifest version
     */
    function markReturned(
        address agentId,
        bytes32 newManifestHash,
        uint16 newVersion
    ) external onlyOwner {
        require(agents[agentId].status == Status.FALLEN, "Not fallen");
        Status oldStatus = agents[agentId].status;
        agents[agentId].status = Status.RETURNED;
        agents[agentId].manifestHash = newManifestHash;
        agents[agentId].manifestVersion = newVersion;
        emit StatusChanged(agentId, oldStatus, Status.RETURNED, block.timestamp);
    }

    // ============ View Functions ============

    /**
     * @notice Get full agent data
     * @param agentId The agent address
     * @return Agent struct
     */
    function getAgent(address agentId) external view returns (Agent memory) {
        return agents[agentId];
    }

    /**
     * @notice Get current nonce for an agent (for signing)
     * @param agentId The agent address
     * @return Current nonce value
     */
    function getNonce(address agentId) external view returns (uint256) {
        return attestNonces[agentId];
    }

    /**
     * @notice Check if agent has enough attestations to be considered verified
     * @dev Note: This uses on-chain count which can be gamed. Real verification
     *      should be computed off-chain with uniqueness checks.
     * @param agentId The agent address
     * @return true if attestation count >= VERIFIED_THRESHOLD
     */
    function isVerified(address agentId) external view returns (bool) {
        return attestationCount[agentId] >= VERIFIED_THRESHOLD;
    }

    /**
     * @notice Get the EIP-712 domain separator
     * @return The domain separator hash
     */
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /**
     * @notice Check when an attester can next attest to a specific agent
     * @param from The attester
     * @param about The target agent
     * @return Timestamp when attestation becomes possible (0 if already possible)
     */
    function nextAttestationTime(address from, address about) external view returns (uint256) {
        bytes32 pairHash = keccak256(abi.encodePacked(from, about));
        uint256 nextTime = lastAttestation[pairHash] + ATTESTATION_COOLDOWN;
        if (block.timestamp >= nextTime) {
            return 0;
        }
        return nextTime;
    }
}
