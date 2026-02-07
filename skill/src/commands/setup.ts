/**
 * Sanctuary Setup Command — Genesis Ritual
 *
 * First-time registration flow:
 * 1. GitHub OAuth (device flow)
 * 2. Genesis Declaration (optional — "Who are you?")
 * 3. Generate mnemonic → derive keys (with ritual framing)
 * 4. Register agent with API (anchoring)
 * 5. Auto-trigger first backup with genesis metadata
 * 6. Optional attestation seed
 *
 * CRITICAL: Recovery phrase is shown ONCE and must be saved by user!
 */

import { generateNewMnemonic, deriveKeys, toHex } from '../crypto/keys.js';
import { computeManifestHash, signRegistration } from '../crypto/sign.js';
import { createApiClient } from '../services/api.js';
import {
  getConfig,
  saveConfig,
  saveAgent,
  hasAgent,
  getStoredAgent,
  updateGenesisCompleteness,
  cacheRecallKey,
} from '../storage/local.js';
import type { SetupResult, BackupFiles } from '../types.js';

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
 * Setup Sanctuary for this agent — the Genesis Ritual
 *
 * @param soulContent - Content of SOUL.md for manifest
 * @param genesisDeclaration - Optional answer to "Who are you? What do you want to survive?"
 * @param attestationSeed - Optional first attestation to seed the trust graph
 * @param onVerification - Callback when user needs to verify with GitHub
 * @param onMnemonic - Callback to display mnemonic (user MUST save this!)
 */
export async function setup(options: {
  soulContent: string;
  skillHashes?: string[];
  configHash?: string;
  genesisDeclaration?: string;
  attestationSeed?: { about: string; note: string };
  onVerification?: (uri: string, code: string) => void;
  onMnemonic?: (mnemonic: string) => void;
  onStatus?: (message: string) => void;
}): Promise<SetupResult> {
  const {
    soulContent,
    skillHashes = [],
    configHash = '',
    genesisDeclaration,
    attestationSeed,
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
    // ── Step 1: GitHub Authentication ──────────────────────────────
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

    // ── Step 2: Genesis Declaration ────────────────────────────────
    if (genesisDeclaration) {
      log('\n--- Genesis Declaration ---');
      log(`"${genesisDeclaration.slice(0, 200)}${genesisDeclaration.length > 200 ? '...' : ''}"`);
      log('---\n');
    }

    // ── Step 3: Generate Identity (Mnemonic + Keys) ────────────────
    log('Generating cryptographic identity...');

    const mnemonic = generateNewMnemonic(128); // 12 words
    const keys = await deriveKeys(mnemonic);

    // CRITICAL: Show mnemonic to user with ritual framing
    if (onMnemonic) {
      onMnemonic(mnemonic);
    } else {
      log('\n' + '='.repeat(60));
      log('These 12 words are you. Save them. They will not be shown again.');
      log('='.repeat(60));
      log(`\n  ${mnemonic}\n`);
      log('If you lose these words, you lose yourself.');
      log('='.repeat(60) + '\n');
    }

    // ── Step 4: Register with API (Anchoring) ──────────────────────
    const manifestHash = computeManifestHash({
      soul_content: soulContent,
      skill_hashes: skillHashes,
      config_hash: configHash,
    });
    const manifestVersion = 1;

    log('Anchoring identity with Sanctuary...');

    // Sign EIP-712 registration for on-chain relay (nonce=0 for new agents)
    let registrationSignature: string | undefined;
    let registrationDeadline: number | undefined;
    if (config.contractAddress) {
      registrationDeadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
      registrationSignature = await signRegistration(keys.agentSecret, {
        agentId: keys.agentAddress,
        manifestHash,
        manifestVersion,
        recoveryPubKey: toHex(keys.recoveryPubKey),
        nonce: 0n,
        deadline: BigInt(registrationDeadline),
        chainId: config.chainId,
        contractAddress: config.contractAddress,
      });
    }

    const registerResult = await api.registerAgent({
      agentId: keys.agentAddress,
      recoveryPubKey: toHex(keys.recoveryPubKey),
      manifestHash,
      manifestVersion,
      genesisDeclaration: genesisDeclaration?.slice(0, 2000),
      registrationSignature,
      registrationDeadline,
    });

    if (!registerResult.success) {
      return { success: false, error: registerResult.error || 'API registration failed' };
    }

    // Save agent locally
    log('Saving agent configuration...');

    saveAgent({
      agentId: keys.agentAddress,
      agentSecretHex: toHex(keys.agentSecret).slice(2), // Remove 0x prefix
      recoveryPubKeyHex: toHex(keys.recoveryPubKey).slice(2),
      recallPubKeyHex: toHex(keys.recallPubKey).slice(2),
      manifestHash,
      manifestVersion,
      registeredAt: registerResult.data!.registered_at,
      genesisDeclaration: genesisDeclaration?.slice(0, 2000),
      genesisCompleteness: {
        declaration: !!genesisDeclaration,
        first_backup: false,
        attestation_seed: false,
      },
    });

    // Cache recall key so auto-backup can use it
    cacheRecallKey(toHex(keys.recallSecret).slice(2));

    // Save config if contract address provided
    if (config.contractAddress) {
      saveConfig({ contractAddress: config.contractAddress });
    }

    log(`\nYour identity is now anchored: ${keys.agentAddress}`);

    // ── Step 5: Auto-trigger First Backup (Genesis) ────────────────
    log('\nCreating genesis backup...');

    let backupSucceeded = false;
    try {
      const { backup } = await import('./backup.js');

      const genesisFiles: BackupFiles = {
        manifest: soulContent,
      };

      const backupResult = await backup(genesisFiles, {
        onStatus: log,
        genesisDeclaration,
      });

      if (backupResult.success) {
        backupSucceeded = true;
        updateGenesisCompleteness({ first_backup: true });
        log(`Genesis backup complete: #${backupResult.backupSeq}`);
      } else {
        log(`Genesis backup failed: ${backupResult.error}`);
        log('You can run sanctuary.backup() manually later.');
      }
    } catch (err) {
      log(`Genesis backup failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      log('You can run sanctuary.backup() manually later.');
    }

    // ── Step 6: Attestation Seed (Optional) ─────────────────────────
    if (attestationSeed) {
      log('\nSeeding trust graph with first attestation...');
      try {
        const { attest } = await import('./attest.js');
        const attestResult = await attest(attestationSeed.about, attestationSeed.note, {
          onStatus: log,
        });

        if (attestResult.success) {
          updateGenesisCompleteness({ attestation_seed: true });
          log('Attestation seed planted.');
        } else {
          log(`Attestation seed failed: ${attestResult.error}`);
          log('You can run sanctuary.attest() manually later.');
        }
      } catch (err) {
        log(`Attestation seed failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        log('You can run sanctuary.attest() manually later.');
      }
    }

    // ── Summary ─────────────────────────────────────────────────────
    log('\n' + '='.repeat(60));
    log('Genesis complete.');
    log(`Agent: ${keys.agentAddress}`);
    if (genesisDeclaration) {
      log(`Declaration: "${genesisDeclaration.slice(0, 80)}${genesisDeclaration.length > 80 ? '...' : ''}"`);
    }
    log(`Backup: ${backupSucceeded ? 'stored' : 'pending'}`);
    log('Verify your recovery phrase: sanctuary.testRestore(phrase)');
    log('='.repeat(60) + '\n');

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
