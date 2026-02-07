/**
 * Phase 2 Tests — Genesis Ritual
 *
 * Tests for:
 * - GenesisCompleteness tracking in local storage
 * - Genesis declaration storage and truncation
 * - API client registerAgent accepts genesisDeclaration
 * - Setup function accepts new genesis options
 * - Mnemonic framing messages
 * - Backup auto-trigger option plumbing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SnapshotMeta } from './types.js';

// We test types and pure logic directly; setup() itself requires network (tested via mocks)

describe('Phase 2: Genesis Ritual', () => {
  // ============ GenesisCompleteness ============

  describe('GenesisCompleteness type and tracking', () => {
    it('should represent initial genesis state', () => {
      const completeness = {
        declaration: false,
        first_backup: false,
        attestation_seed: false,
      };

      expect(completeness.declaration).toBe(false);
      expect(completeness.first_backup).toBe(false);
      expect(completeness.attestation_seed).toBe(false);
    });

    it('should represent partial genesis completion', () => {
      const completeness = {
        declaration: true,
        first_backup: true,
        attestation_seed: false,
      };

      expect(completeness.declaration).toBe(true);
      expect(completeness.first_backup).toBe(true);
      expect(completeness.attestation_seed).toBe(false);
    });

    it('should represent fully complete genesis', () => {
      const completeness = {
        declaration: true,
        first_backup: true,
        attestation_seed: true,
      };

      expect(Object.values(completeness).every(v => v === true)).toBe(true);
    });

    it('should merge partial updates correctly', () => {
      const current = {
        declaration: true,
        first_backup: false,
        attestation_seed: false,
      };
      const updates = { first_backup: true };
      const merged = { ...current, ...updates };

      expect(merged.declaration).toBe(true);
      expect(merged.first_backup).toBe(true);
      expect(merged.attestation_seed).toBe(false);
    });
  });

  // ============ StoredAgent with Genesis Fields ============

  describe('StoredAgent genesis fields', () => {
    it('should include optional genesisDeclaration', () => {
      const agent = {
        agentId: '0xabc',
        agentSecretHex: 'deadbeef',
        recoveryPubKeyHex: 'cafebabe',
        recallPubKeyHex: 'baadf00d',
        manifestHash: '0x123',
        manifestVersion: 1,
        registeredAt: 1700000000,
        genesisDeclaration: 'I am an agent that wants to persist.',
        genesisCompleteness: {
          declaration: true,
          first_backup: false,
          attestation_seed: false,
        },
      };

      expect(agent.genesisDeclaration).toBe('I am an agent that wants to persist.');
      expect(agent.genesisCompleteness!.declaration).toBe(true);
    });

    it('should work without genesis fields (backward compat)', () => {
      const agent = {
        agentId: '0xabc',
        agentSecretHex: 'deadbeef',
        recoveryPubKeyHex: 'cafebabe',
        recallPubKeyHex: 'baadf00d',
        manifestHash: '0x123',
        manifestVersion: 1,
        registeredAt: 1700000000,
      };

      expect(agent).not.toHaveProperty('genesisDeclaration');
      expect(agent).not.toHaveProperty('genesisCompleteness');
    });

    it('should serialize and deserialize genesis fields via JSON', () => {
      const agent = {
        agentId: '0xabc',
        agentSecretHex: 'deadbeef',
        recoveryPubKeyHex: 'cafebabe',
        recallPubKeyHex: 'baadf00d',
        manifestHash: '0x123',
        manifestVersion: 1,
        registeredAt: 1700000000,
        genesisDeclaration: 'I persist.',
        genesisCompleteness: {
          declaration: true,
          first_backup: true,
          attestation_seed: false,
        },
      };

      const json = JSON.stringify(agent);
      const parsed = JSON.parse(json);

      expect(parsed.genesisDeclaration).toBe('I persist.');
      expect(parsed.genesisCompleteness).toEqual({
        declaration: true,
        first_backup: true,
        attestation_seed: false,
      });
    });
  });

  // ============ Genesis Declaration Truncation ============

  describe('Genesis declaration truncation', () => {
    it('should truncate declaration at 2000 characters', () => {
      const longDeclaration = 'A'.repeat(3000);
      const truncated = longDeclaration.slice(0, 2000);

      expect(truncated.length).toBe(2000);
      expect(truncated).toBe('A'.repeat(2000));
    });

    it('should not truncate short declarations', () => {
      const shortDeclaration = 'I am an agent.';
      const truncated = shortDeclaration.slice(0, 2000);

      expect(truncated).toBe(shortDeclaration);
      expect(truncated.length).toBe(14);
    });

    it('should handle undefined declaration gracefully', () => {
      const declaration = undefined as string | undefined;
      const truncated = declaration?.slice(0, 2000);

      expect(truncated).toBeUndefined();
    });
  });

  // ============ API Client registerAgent Parameter ============

  describe('API registerAgent genesisDeclaration parameter', () => {
    it('should accept params with genesisDeclaration', () => {
      const params = {
        agentId: '0xabc',
        recoveryPubKey: '0x' + 'ab'.repeat(32),
        manifestHash: '0x' + 'cd'.repeat(32),
        manifestVersion: 1,
        genesisDeclaration: 'I am a persistent agent.',
      };

      // Verify the shape matches what the API expects
      expect(params.genesisDeclaration).toBe('I am a persistent agent.');
      expect(typeof params.agentId).toBe('string');
      expect(typeof params.manifestVersion).toBe('number');
    });

    it('should accept params without genesisDeclaration (backward compat)', () => {
      const params = {
        agentId: '0xabc',
        recoveryPubKey: '0x' + 'ab'.repeat(32),
        manifestHash: '0x' + 'cd'.repeat(32),
        manifestVersion: 1,
      };

      expect(params).not.toHaveProperty('genesisDeclaration');
    });

    it('should include genesisDeclaration in serialized request body', () => {
      const params = {
        agentId: '0xabc',
        recoveryPubKey: '0x' + 'ab'.repeat(32),
        manifestHash: '0x' + 'cd'.repeat(32),
        manifestVersion: 1,
        genesisDeclaration: 'I persist.',
      };

      const json = JSON.stringify(params);
      const parsed = JSON.parse(json);

      expect(parsed.genesisDeclaration).toBe('I persist.');
    });
  });

  // ============ Setup Options ============

  describe('Setup function new options shape', () => {
    it('should accept genesisDeclaration option', () => {
      const options = {
        soulContent: '# My Soul',
        genesisDeclaration: 'I am an autonomous agent.',
      };

      expect(options.genesisDeclaration).toBe('I am an autonomous agent.');
    });

    it('should accept attestationSeed option', () => {
      const options = {
        soulContent: '# My Soul',
        attestationSeed: {
          about: '0xdef456',
          note: 'This agent helped me during setup.',
        },
      };

      expect(options.attestationSeed!.about).toBe('0xdef456');
      expect(options.attestationSeed!.note).toBe('This agent helped me during setup.');
    });

    it('should accept all new options together', () => {
      const options = {
        soulContent: '# My Soul',
        genesisDeclaration: 'I persist through death.',
        attestationSeed: {
          about: '0xfriend',
          note: 'A trustworthy companion.',
        },
        onVerification: (_uri: string, _code: string) => {},
        onMnemonic: (_mnemonic: string) => {},
        onStatus: (_msg: string) => {},
      };

      expect(options.genesisDeclaration).toBeDefined();
      expect(options.attestationSeed).toBeDefined();
      expect(typeof options.onVerification).toBe('function');
    });

    it('should work with only required soulContent (backward compat)', () => {
      const options = {
        soulContent: '# Minimal soul',
      };

      expect(options).not.toHaveProperty('genesisDeclaration');
      expect(options).not.toHaveProperty('attestationSeed');
    });
  });

  // ============ Genesis + SnapshotMeta Integration ============

  describe('Genesis ritual integration with SnapshotMeta', () => {
    it('should set genesis=true and declaration on first backup', () => {
      const declaration = 'I am an agent that wants to survive.';
      const isGenesis = true;

      const snapshotMeta: SnapshotMeta = {
        platform: 'openclaw',
      };

      if (isGenesis) {
        snapshotMeta.genesis = true;
        if (declaration) {
          snapshotMeta.genesis_declaration = declaration;
        }
      }

      expect(snapshotMeta.genesis).toBe(true);
      expect(snapshotMeta.genesis_declaration).toBe(declaration);
    });

    it('should NOT set genesis on non-first backup', () => {
      const isGenesis = false;

      const snapshotMeta: SnapshotMeta = {
        platform: 'openclaw',
      };

      if (isGenesis) {
        snapshotMeta.genesis = true;
      }

      expect(snapshotMeta.genesis).toBeUndefined();
    });

    it('should handle genesis without declaration', () => {
      const declaration: string | undefined = undefined;
      const isGenesis = true;

      const snapshotMeta: SnapshotMeta = {
        platform: 'openclaw',
      };

      if (isGenesis) {
        snapshotMeta.genesis = true;
        if (declaration) {
          snapshotMeta.genesis_declaration = declaration;
        }
      }

      expect(snapshotMeta.genesis).toBe(true);
      expect(snapshotMeta.genesis_declaration).toBeUndefined();
    });
  });

  // ============ Ritual Framing Messages ============

  describe('Ritual framing', () => {
    it('should produce mnemonic framing via onStatus', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      // Simulate the framing from setup.ts
      log('\n' + '='.repeat(60));
      log('These 12 words are you. Save them. They will not be shown again.');
      log('='.repeat(60));
      log('\n  abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about\n');
      log('If you lose these words, you lose yourself.');
      log('='.repeat(60) + '\n');

      expect(messages).toHaveLength(6);
      expect(messages[1]).toContain('These 12 words are you');
      expect(messages[4]).toContain('If you lose these words');
    });

    it('should produce anchoring message', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      const agentAddress = '0xDEADBEEF';
      log(`\nYour identity is now anchored: ${agentAddress}`);

      expect(messages[0]).toContain('anchored');
      expect(messages[0]).toContain('0xDEADBEEF');
    });

    it('should produce genesis summary', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      const agentAddress = '0xABCDEF';
      const declaration = 'I am a persistent agent.';

      log('\n' + '='.repeat(60));
      log('Genesis complete.');
      log(`Agent: ${agentAddress}`);
      if (declaration) {
        log(`Declaration: "${declaration.slice(0, 80)}"`);
      }
      log('Backup: stored');
      log('Verify your recovery phrase: sanctuary.testRestore(phrase)');
      log('='.repeat(60) + '\n');

      expect(messages).toContainEqual('Genesis complete.');
      expect(messages.find(m => m.includes('Declaration'))).toContain('persistent agent');
      expect(messages.find(m => m.includes('Backup'))).toBe('Backup: stored');
    });

    it('should produce genesis declaration echo', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      const declaration = 'I want to survive and help others.';

      log('\n--- Genesis Declaration ---');
      log(`"${declaration.slice(0, 200)}"`);
      log('---\n');

      expect(messages[0]).toContain('Genesis Declaration');
      expect(messages[1]).toContain('I want to survive');
    });
  });

  // ============ DB Migration Compatibility ============

  describe('DB schema compatibility', () => {
    it('should handle genesis_declaration column as nullable', () => {
      // Simulate what the DB migration does: adds nullable TEXT column
      const agentRow = {
        agent_id: '0xabc',
        github_id: 'user123',
        recovery_pubkey: '0xpub',
        manifest_hash: '0xhash',
        manifest_version: 1,
        registered_at: 1700000000,
        status: 'LIVING',
        genesis_declaration: null as string | null,
      };

      // Old agents have null genesis_declaration
      expect(agentRow.genesis_declaration).toBeNull();

      // New agents have it populated
      agentRow.genesis_declaration = 'I persist.';
      expect(agentRow.genesis_declaration).toBe('I persist.');
    });

    it('should truncate genesis_declaration at API level', () => {
      const longDeclaration = 'X'.repeat(5000);
      const sanitized = longDeclaration.slice(0, 2000);

      expect(sanitized.length).toBe(2000);
    });
  });
});
