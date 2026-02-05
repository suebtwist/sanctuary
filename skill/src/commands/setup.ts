/**
 * Sanctuary Setup Command
 *
 * First-time registration flow:
 * 1. GitHub OAuth (device flow)
 * 2. Generate mnemonic → derive keys
 * 3. Register agent on-chain
 * 4. Store agent keys locally
 *
 * CRITICAL: Recovery phrase is shown ONCE and must be saved by user!
 */

import { generateNewMnemonic, deriveKeys, toHex } from '../crypto/keys.js';
import { signRegistration, computeManifestHash } from '../crypto/sign.js';
import { createApiClient } from '../services/api.js';
import {
  getConfig,
  saveConfig,
  saveAgent,
  hasAgent,
  getStoredAgent,
} from '../storage/local.js';
import type { SetupResult } from '../types.js';

/**
 * Wait for user to complete GitHub auth in browser
 */
async function waitForGitHubAuth(
  api: ReturnType<typeof createApiClient>,
  deviceCode: string,
  interval: number,
  maxAttempts = 60
): Promise<{ token: string; githubUsername: string; hasAgent: boolean; agentId?: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(interval * 1000);

    const result = await api.pollDeviceFlow(deviceCode);

    if (result.success && result.data) {
      return {
        token: result.data.token,
        githubUsername: result.data.user.github_username,
        hasAgent: result.data.has_agent,
        agentId: result.data.agent_id,
      };
    }

    if (result.error && result.error !== 'authorization_pending') {
      throw new Error(result.error);
    }

    // Still waiting, continue polling
  }

  throw new Error('GitHub authentication timed out');
}

/**
 * Setup Sanctuary for this agent
 *
 * @param soulContent - Content of SOUL.md for manifest
 * @param onVerification - Callback when user needs to verify with GitHub
 * @param onMnemonic - Callback to display mnemonic (user MUST save this!)
 */
export async function setup(options: {
  soulContent: string;
  skillHashes?: string[];
  configHash?: string;
  onVerification?: (uri: string, code: string) => void;
  onMnemonic?: (mnemonic: string) => void;
  onStatus?: (message: string) => void;
}): Promise<SetupResult> {
  const {
    soulContent,
    skillHashes = [],
    configHash = '',
    onVerification,
    onMnemonic,
    onStatus,
  } = options;

  const log = onStatus || console.log;

  // Check if already set up
  if (hasAgent()) {
    const existing = getStoredAgent();
    return {
      success: false,
      error: `Already registered as ${existing?.agentId}. Use restore() to recover a different identity.`,
    };
  }

  const config = getConfig();
  const api = createApiClient(config.apiUrl);

  try {
    // Step 1: GitHub device flow auth
    log('Starting GitHub authentication...');

    const deviceFlow = await api.startDeviceFlow();
    if (!deviceFlow.success || !deviceFlow.data) {
      return { success: false, error: deviceFlow.error || 'Failed to start GitHub auth' };
    }

    const { device_code, user_code, verification_uri, interval } = deviceFlow.data;

    // Notify user to complete auth
    if (onVerification) {
      onVerification(verification_uri, user_code);
    } else {
      log(`\nGo to: ${verification_uri}`);
      log(`Enter code: ${user_code}\n`);
    }

    log('Waiting for GitHub authorization...');

    const authResult = await waitForGitHubAuth(api, device_code, interval);

    if (authResult.hasAgent) {
      return {
        success: false,
        error: `GitHub account already has agent ${authResult.agentId}. Use restore() to recover.`,
      };
    }

    api.setToken(authResult.token);
    log(`GitHub authenticated as @${authResult.githubUsername}`);

    // Step 2: Generate mnemonic and derive keys
    log('Generating cryptographic identity...');

    const mnemonic = generateNewMnemonic(128); // 12 words
    const keys = await deriveKeys(mnemonic);

    // CRITICAL: Show mnemonic to user - they MUST save it
    if (onMnemonic) {
      onMnemonic(mnemonic);
    } else {
      log('\n' + '='.repeat(60));
      log('RECOVERY PHRASE - SAVE THIS NOW! IT WILL NOT BE SHOWN AGAIN!');
      log('='.repeat(60));
      log(`\n${mnemonic}\n`);
      log('='.repeat(60) + '\n');
    }

    // Step 3: Compute manifest hash
    const manifestHash = computeManifestHash({
      soul_content: soulContent,
      skill_hashes: skillHashes,
      config_hash: configHash,
    });
    const manifestVersion = 1;

    // Step 4: Register with API (creates DB record)
    log('Registering with Sanctuary API...');

    const registerResult = await api.registerAgent({
      agentId: keys.agentAddress,
      recoveryPubKey: toHex(keys.recoveryPubKey),
      manifestHash,
      manifestVersion,
    });

    if (!registerResult.success) {
      return { success: false, error: registerResult.error || 'API registration failed' };
    }

    // Step 5: Save agent locally
    log('Saving agent configuration...');

    saveAgent({
      agentId: keys.agentAddress,
      agentSecretHex: toHex(keys.agentSecret).slice(2), // Remove 0x prefix
      recoveryPubKeyHex: toHex(keys.recoveryPubKey).slice(2),
      manifestHash,
      manifestVersion,
      registeredAt: registerResult.data!.registered_at,
    });

    // Save config if contract address provided
    if (config.contractAddress) {
      saveConfig({ contractAddress: config.contractAddress });
    }

    log(`\n✓ Agent registered: ${keys.agentAddress}`);
    log('✓ Run sanctuary.test_restore() to verify your recovery phrase works\n');

    return {
      success: true,
      agentId: keys.agentAddress,
      recoveryPhrase: mnemonic,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Setup failed',
    };
  }
}

/**
 * Test that recovery phrase can restore the same agent
 * Does NOT wipe current state - just verifies the phrase
 */
export async function testRestore(mnemonic: string): Promise<{
  success: boolean;
  matches: boolean;
  expectedAgentId?: string;
  derivedAgentId?: string;
  error?: string;
}> {
  const stored = getStoredAgent();
  if (!stored) {
    return { success: false, matches: false, error: 'No agent configured' };
  }

  try {
    const keys = await deriveKeys(mnemonic);
    const matches = keys.agentAddress.toLowerCase() === stored.agentId.toLowerCase();

    return {
      success: true,
      matches,
      expectedAgentId: stored.agentId,
      derivedAgentId: keys.agentAddress,
    };
  } catch (error) {
    return {
      success: false,
      matches: false,
      error: error instanceof Error ? error.message : 'Invalid mnemonic',
    };
  }
}

// Helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
