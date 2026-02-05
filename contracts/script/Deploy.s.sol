// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/Sanctuary.sol";

contract DeploySanctuary is Script {
    function run() external {
        // Get deployer private key from environment
        uint256 deployerPrivateKey = vm.envUint("OWNER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        // Deploy Sanctuary contract
        Sanctuary sanctuary = new Sanctuary();

        vm.stopBroadcast();

        // Log deployed address
        console.log("Sanctuary deployed to:", address(sanctuary));
        console.log("Owner:", sanctuary.owner());
        console.log("Domain Separator:", vm.toString(sanctuary.domainSeparator()));
    }
}

contract VerifyDeployment is Script {
    function run() external view {
        address sanctuaryAddress = vm.envAddress("CONTRACT_ADDRESS");
        Sanctuary sanctuary = Sanctuary(sanctuaryAddress);

        console.log("=== Sanctuary Contract Verification ===");
        console.log("Address:", sanctuaryAddress);
        console.log("Owner:", sanctuary.owner());
        console.log("Attestation Cooldown:", sanctuary.ATTESTATION_COOLDOWN());
        console.log("Verified Threshold:", sanctuary.VERIFIED_THRESHOLD());
        console.log("Fallen Threshold:", sanctuary.FALLEN_THRESHOLD());
    }
}
