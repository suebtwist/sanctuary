/**
 * Sanctuary Skill
 *
 * Identity persistence and encrypted memory backup for AI agents.
 *
 * Commands:
 * - setup()      - First-time registration
 * - status()     - Show current status
 * - backup()     - Upload encrypted backup
 * - restore()    - Recover from mnemonic
 * - attest()     - Vouch for another agent
 * - lookup()     - Check another agent
 * - lock()       - Clear cached recall key
 * - testRestore() - Verify recovery phrase
 */

// Re-export commands
export { setup, testRestore } from './commands/setup.js';
export { status, displayStatus, isHealthy } from './commands/status.js';
export { backup, pin } from './commands/backup.js';
export { restore, lock } from './commands/restore.js';
export { attest, lookup, displayLookup } from './commands/attest.js';

// Re-export utilities
export { generateNewMnemonic, deriveKeys, isValidMnemonic } from './crypto/keys.js';
export { createApiClient } from './services/api.js';
export {
  getConfig,
  saveConfig,
  hasAgent,
  getStoredAgent,
  isInitialized,
} from './storage/local.js';

// Re-export types
export type {
  SetupResult,
  StatusResult,
  BackupResult,
  RestoreResult,
  AttestResult,
  LookupResult,
  BackupFiles,
  SkillConfig,
} from './types.js';

/**
 * Sanctuary namespace object for convenient access
 */
export const sanctuary = {
  // Commands
  setup: async (options: Parameters<typeof import('./commands/setup.js').setup>[0]) => {
    const { setup } = await import('./commands/setup.js');
    return setup(options);
  },

  status: async () => {
    const { status } = await import('./commands/status.js');
    return status();
  },

  displayStatus: async () => {
    const { displayStatus } = await import('./commands/status.js');
    return displayStatus();
  },

  backup: async (
    files: import('./types.js').BackupFiles,
    options?: Parameters<typeof import('./commands/backup.js').backup>[1]
  ) => {
    const { backup } = await import('./commands/backup.js');
    return backup(files, options);
  },

  pin: (note: string) => {
    const { pin } = require('./commands/backup.js');
    return pin(note);
  },

  restore: async (
    mnemonic: string,
    options?: Parameters<typeof import('./commands/restore.js').restore>[1]
  ) => {
    const { restore } = await import('./commands/restore.js');
    return restore(mnemonic, options);
  },

  lock: () => {
    const { lock } = require('./commands/restore.js');
    return lock();
  },

  attest: async (
    about: string,
    note: string,
    options?: Parameters<typeof import('./commands/attest.js').attest>[2]
  ) => {
    const { attest } = await import('./commands/attest.js');
    return attest(about, note, options);
  },

  lookup: async (agentId: string) => {
    const { lookup } = await import('./commands/attest.js');
    return lookup(agentId);
  },

  displayLookup: async (agentId: string) => {
    const { displayLookup } = await import('./commands/attest.js');
    return displayLookup(agentId);
  },

  testRestore: async (mnemonic: string) => {
    const { testRestore } = await import('./commands/setup.js');
    return testRestore(mnemonic);
  },

  isHealthy: async () => {
    const { isHealthy } = await import('./commands/status.js');
    return isHealthy();
  },

  // Utilities
  isInitialized: () => {
    const { isInitialized } = require('./storage/local.js');
    return isInitialized();
  },

  getConfig: () => {
    const { getConfig } = require('./storage/local.js');
    return getConfig();
  },

  saveConfig: (config: Partial<import('./types.js').SkillConfig>) => {
    const { saveConfig } = require('./storage/local.js');
    return saveConfig(config);
  },
};

// Default export
export default sanctuary;
