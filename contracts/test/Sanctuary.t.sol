// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/Sanctuary.sol";

contract SanctuaryTest is Test {
    Sanctuary public sanctuary;

    // Test accounts
    address public owner;
    uint256 public agent1PrivKey;
    address public agent1;
    uint256 public agent2PrivKey;
    address public agent2;
    address public randomUser;

    // Test data
    bytes32 public manifestHash = keccak256("test-manifest-v1");
    bytes32 public recoveryPubKey = bytes32(uint256(0x1234567890abcdef));
    bytes32 public noteHash = keccak256("test-attestation-note");

    // EIP-712 type hashes (must match contract)
    bytes32 public constant REGISTER_TYPEHASH = keccak256(
        "Register(address agentId,bytes32 manifestHash,uint16 manifestVersion,bytes32 recoveryPubKey,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant ATTEST_TYPEHASH = keccak256(
        "Attest(address from,address about,bytes32 noteHash,uint256 nonce,uint256 deadline)"
    );

    function setUp() public {
        owner = address(this);

        // Create test agent accounts with known private keys
        agent1PrivKey = 0xA11CE;
        agent1 = vm.addr(agent1PrivKey);

        agent2PrivKey = 0xB0B;
        agent2 = vm.addr(agent2PrivKey);

        randomUser = address(0xCAFE);

        sanctuary = new Sanctuary();
    }

    // ============ Helper Functions ============

    function _getRegisterSignature(
        uint256 privKey,
        address agentId,
        bytes32 _manifestHash,
        uint16 manifestVersion,
        bytes32 _recoveryPubKey,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            REGISTER_TYPEHASH,
            agentId,
            _manifestHash,
            manifestVersion,
            _recoveryPubKey,
            nonce,
            deadline
        ));

        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            sanctuary.domainSeparator(),
            structHash
        ));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _getAttestSignature(
        uint256 privKey,
        address from,
        address about,
        bytes32 _noteHash,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            ATTEST_TYPEHASH,
            from,
            about,
            _noteHash,
            nonce,
            deadline
        ));

        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            sanctuary.domainSeparator(),
            structHash
        ));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _registerAgent(uint256 privKey, address agentId) internal {
        uint256 nonce = sanctuary.getNonce(agentId);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = _getRegisterSignature(
            privKey,
            agentId,
            manifestHash,
            1,
            recoveryPubKey,
            nonce,
            deadline
        );

        sanctuary.registerAgent(agentId, manifestHash, 1, recoveryPubKey, deadline, sig);
    }

    // ============ Registration Tests ============

    function test_RegisterAgent() public {
        uint256 nonce = sanctuary.getNonce(agent1);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = _getRegisterSignature(
            agent1PrivKey,
            agent1,
            manifestHash,
            1,
            recoveryPubKey,
            nonce,
            deadline
        );

        vm.expectEmit(true, false, false, true);
        emit Sanctuary.Registered(agent1, manifestHash, 1, recoveryPubKey, address(0), block.timestamp);

        vm.expectEmit(true, false, false, true);
        emit Sanctuary.StatusChanged(agent1, Sanctuary.Status.UNREGISTERED, Sanctuary.Status.LIVING, block.timestamp);

        sanctuary.registerAgent(agent1, manifestHash, 1, recoveryPubKey, deadline, sig);

        Sanctuary.Agent memory agent = sanctuary.getAgent(agent1);
        assertEq(agent.manifestHash, manifestHash);
        assertEq(agent.manifestVersion, 1);
        assertEq(agent.recoveryPubKey, recoveryPubKey);
        assertEq(uint8(agent.status), uint8(Sanctuary.Status.LIVING));
    }

    function test_RegisterAgent_RevertAlreadyRegistered() public {
        _registerAgent(agent1PrivKey, agent1);

        uint256 nonce = sanctuary.getNonce(agent1);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = _getRegisterSignature(
            agent1PrivKey,
            agent1,
            manifestHash,
            1,
            recoveryPubKey,
            nonce,
            deadline
        );

        vm.expectRevert("Already registered");
        sanctuary.registerAgent(agent1, manifestHash, 1, recoveryPubKey, deadline, sig);
    }

    function test_RegisterAgent_RevertExpiredSignature() public {
        uint256 nonce = sanctuary.getNonce(agent1);
        uint256 deadline = block.timestamp - 1; // Already expired

        bytes memory sig = _getRegisterSignature(
            agent1PrivKey,
            agent1,
            manifestHash,
            1,
            recoveryPubKey,
            nonce,
            deadline
        );

        vm.expectRevert("Signature expired");
        sanctuary.registerAgent(agent1, manifestHash, 1, recoveryPubKey, deadline, sig);
    }

    function test_RegisterAgent_RevertInvalidSignature() public {
        uint256 nonce = sanctuary.getNonce(agent1);
        uint256 deadline = block.timestamp + 1 hours;

        // Sign with wrong key
        bytes memory sig = _getRegisterSignature(
            agent2PrivKey, // Wrong key!
            agent1,
            manifestHash,
            1,
            recoveryPubKey,
            nonce,
            deadline
        );

        vm.expectRevert("Invalid signature");
        sanctuary.registerAgent(agent1, manifestHash, 1, recoveryPubKey, deadline, sig);
    }

    function test_RegisterAgent_RevertInvalidRecoveryPubKey() public {
        uint256 nonce = sanctuary.getNonce(agent1);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = _getRegisterSignature(
            agent1PrivKey,
            agent1,
            manifestHash,
            1,
            bytes32(0), // Invalid!
            nonce,
            deadline
        );

        vm.expectRevert("Invalid recovery pubkey");
        sanctuary.registerAgent(agent1, manifestHash, 1, bytes32(0), deadline, sig);
    }

    // ============ Attestation Tests ============

    function test_Attest() public {
        _registerAgent(agent1PrivKey, agent1);
        _registerAgent(agent2PrivKey, agent2);

        vm.prank(agent1);

        vm.expectEmit(true, true, false, true);
        emit Sanctuary.Attested(agent1, agent2, noteHash, block.timestamp);

        sanctuary.attest(agent2, noteHash);

        assertEq(sanctuary.attestationCount(agent2), 1);
    }

    function test_AttestBySig() public {
        _registerAgent(agent1PrivKey, agent1);
        _registerAgent(agent2PrivKey, agent2);

        uint256 nonce = sanctuary.getNonce(agent1);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = _getAttestSignature(
            agent1PrivKey,
            agent1,
            agent2,
            noteHash,
            nonce,
            deadline
        );

        // Anyone can submit the meta-transaction
        vm.prank(randomUser);

        vm.expectEmit(true, true, false, true);
        emit Sanctuary.Attested(agent1, agent2, noteHash, block.timestamp);

        sanctuary.attestBySig(agent1, agent2, noteHash, deadline, sig);

        assertEq(sanctuary.attestationCount(agent2), 1);
    }

    function test_Attest_RevertSelfAttest() public {
        _registerAgent(agent1PrivKey, agent1);

        vm.prank(agent1);
        vm.expectRevert("Cannot self-attest");
        sanctuary.attest(agent1, noteHash);
    }

    function test_Attest_RevertAttesterNotActive() public {
        _registerAgent(agent2PrivKey, agent2);

        // agent1 is not registered
        vm.prank(agent1);
        vm.expectRevert("Attester not active");
        sanctuary.attest(agent2, noteHash);
    }

    function test_Attest_RevertTargetNotRegistered() public {
        _registerAgent(agent1PrivKey, agent1);

        vm.prank(agent1);
        vm.expectRevert("Target not registered");
        sanctuary.attest(agent2, noteHash); // agent2 not registered
    }

    function test_Attest_RevertCooldown() public {
        _registerAgent(agent1PrivKey, agent1);
        _registerAgent(agent2PrivKey, agent2);

        vm.startPrank(agent1);
        sanctuary.attest(agent2, noteHash);

        // Try to attest again immediately
        vm.expectRevert("Cooldown active");
        sanctuary.attest(agent2, noteHash);
        vm.stopPrank();
    }

    function test_Attest_AfterCooldown() public {
        _registerAgent(agent1PrivKey, agent1);
        _registerAgent(agent2PrivKey, agent2);

        vm.startPrank(agent1);
        sanctuary.attest(agent2, noteHash);

        // Warp past cooldown
        vm.warp(block.timestamp + 7 days + 1);

        // Should succeed now
        sanctuary.attest(agent2, noteHash);
        vm.stopPrank();

        assertEq(sanctuary.attestationCount(agent2), 2);
    }

    // ============ Status Management Tests ============

    function test_MarkFallen() public {
        _registerAgent(agent1PrivKey, agent1);

        vm.expectEmit(true, false, false, true);
        emit Sanctuary.StatusChanged(agent1, Sanctuary.Status.LIVING, Sanctuary.Status.FALLEN, block.timestamp);

        sanctuary.markFallen(agent1);

        Sanctuary.Agent memory agent = sanctuary.getAgent(agent1);
        assertEq(uint8(agent.status), uint8(Sanctuary.Status.FALLEN));
    }

    function test_MarkFallen_RevertNotOwner() public {
        _registerAgent(agent1PrivKey, agent1);

        vm.prank(randomUser);
        vm.expectRevert();
        sanctuary.markFallen(agent1);
    }

    function test_MarkFallen_RevertNotLiving() public {
        _registerAgent(agent1PrivKey, agent1);
        sanctuary.markFallen(agent1);

        vm.expectRevert("Not living");
        sanctuary.markFallen(agent1);
    }

    function test_MarkReturned() public {
        _registerAgent(agent1PrivKey, agent1);
        sanctuary.markFallen(agent1);

        bytes32 newManifest = keccak256("new-manifest-v2");

        vm.expectEmit(true, false, false, true);
        emit Sanctuary.StatusChanged(agent1, Sanctuary.Status.FALLEN, Sanctuary.Status.RETURNED, block.timestamp);

        sanctuary.markReturned(agent1, newManifest, 2);

        Sanctuary.Agent memory agent = sanctuary.getAgent(agent1);
        assertEq(uint8(agent.status), uint8(Sanctuary.Status.RETURNED));
        assertEq(agent.manifestHash, newManifest);
        assertEq(agent.manifestVersion, 2);
    }

    function test_MarkReturned_RevertNotFallen() public {
        _registerAgent(agent1PrivKey, agent1);

        vm.expectRevert("Not fallen");
        sanctuary.markReturned(agent1, keccak256("new"), 2);
    }

    function test_ReturnedAgentCanAttest() public {
        _registerAgent(agent1PrivKey, agent1);
        _registerAgent(agent2PrivKey, agent2);

        sanctuary.markFallen(agent1);
        sanctuary.markReturned(agent1, manifestHash, 1);

        // Returned agent should be able to attest
        vm.prank(agent1);
        sanctuary.attest(agent2, noteHash);

        assertEq(sanctuary.attestationCount(agent2), 1);
    }

    // ============ View Function Tests ============

    function test_IsVerified() public {
        _registerAgent(agent1PrivKey, agent1);

        // Create 5 agents and have them attest
        for (uint256 i = 0; i < 5; i++) {
            uint256 pk = 0x1000 + i;
            address attester = vm.addr(pk);
            _registerAgent(pk, attester);

            vm.prank(attester);
            sanctuary.attest(agent1, noteHash);

            // Warp to avoid cooldown (different attesters, but just in case)
            vm.warp(block.timestamp + 1);
        }

        assertTrue(sanctuary.isVerified(agent1));
    }

    function test_NextAttestationTime() public {
        _registerAgent(agent1PrivKey, agent1);
        _registerAgent(agent2PrivKey, agent2);

        // Before any attestation
        assertEq(sanctuary.nextAttestationTime(agent1, agent2), 0);

        vm.prank(agent1);
        sanctuary.attest(agent2, noteHash);

        // After attestation
        uint256 nextTime = sanctuary.nextAttestationTime(agent1, agent2);
        assertEq(nextTime, block.timestamp + 7 days);

        // Warp past cooldown
        vm.warp(block.timestamp + 7 days + 1);
        assertEq(sanctuary.nextAttestationTime(agent1, agent2), 0);
    }

    function test_GetNonce() public {
        assertEq(sanctuary.getNonce(agent1), 0);

        _registerAgent(agent1PrivKey, agent1);
        assertEq(sanctuary.getNonce(agent1), 1); // Incremented after registration
    }
}
