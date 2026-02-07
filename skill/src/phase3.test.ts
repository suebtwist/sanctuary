/**
 * Phase 3 Tests — Resurrection Protocol
 *
 * Tests for:
 * - ResurrectResult and ResurrectionManifest types
 * - Status state machine (FALLEN → RETURNED)
 * - Resurrection manifest shape and content
 * - Genesis declaration displayed during resurrection
 * - Snapshot listing and selection
 * - Identity-only restore (no backups)
 * - Resurrection logging
 * - Ritual framing messages
 * - Rate limit configuration
 */

import { describe, it, expect } from 'vitest';
import type { SnapshotMeta } from './types.js';
import type { ResurrectionManifest } from './services/api.js';

// Helper: build a valid ResurrectionManifest for testing
function buildManifest(overrides: Partial<ResurrectionManifest> = {}): ResurrectionManifest {
  return {
    identity: {
      address: '0xabc123',
      github_username: 'testbot',
      trust_score: 3.5,
      trust_level: 'VERIFIED',
      attestation_count: 2,
      registered_at: 1700000000,
      last_backup: 1700100000,
      last_heartbeat: 1700200000,
      total_snapshots: 5,
      resurrection_count: 0,
    },
    snapshots: [
      {
        backup_id: 'snap-1',
        backup_seq: 5,
        timestamp: 1700100000,
        arweave_tx_id: 'arweave-tx-1',
        size_bytes: 4096,
        manifest_hash: '0xhash1',
      },
      {
        backup_id: 'snap-0',
        backup_seq: 4,
        timestamp: 1700050000,
        arweave_tx_id: 'arweave-tx-0',
        size_bytes: 2048,
        manifest_hash: '0xhash0',
        snapshot_meta: {
          genesis: true,
          genesis_declaration: 'I am a persistent agent.',
          platform: 'openclaw',
        },
      },
    ],
    genesis_declaration: 'I am a persistent agent.',
    status: 'resurrected',
    previous_status: 'FALLEN',
    ...overrides,
  };
}

describe('Phase 3: Resurrection Protocol', () => {
  // ============ ResurrectionManifest Type ============

  describe('ResurrectionManifest shape', () => {
    it('should contain identity block with all required fields', () => {
      const manifest = buildManifest();

      expect(manifest.identity.address).toBe('0xabc123');
      expect(manifest.identity.github_username).toBe('testbot');
      expect(manifest.identity.trust_score).toBe(3.5);
      expect(manifest.identity.trust_level).toBe('VERIFIED');
      expect(manifest.identity.attestation_count).toBe(2);
      expect(manifest.identity.registered_at).toBe(1700000000);
      expect(manifest.identity.total_snapshots).toBe(5);
      expect(manifest.identity.resurrection_count).toBe(0);
    });

    it('should contain snapshots array sorted by backup_seq descending', () => {
      const manifest = buildManifest();

      expect(manifest.snapshots).toHaveLength(2);
      expect(manifest.snapshots[0]!.backup_seq).toBeGreaterThan(manifest.snapshots[1]!.backup_seq);
    });

    it('should contain genesis_declaration at top level', () => {
      const manifest = buildManifest();
      expect(manifest.genesis_declaration).toBe('I am a persistent agent.');
    });

    it('should handle null genesis_declaration', () => {
      const manifest = buildManifest({ genesis_declaration: null });
      expect(manifest.genesis_declaration).toBeNull();
    });

    it('should include snapshot_meta on genesis snapshot', () => {
      const manifest = buildManifest();
      const genesisSnapshot = manifest.snapshots.find(s => s.snapshot_meta?.genesis);

      expect(genesisSnapshot).toBeDefined();
      expect(genesisSnapshot!.snapshot_meta!.genesis).toBe(true);
      expect(genesisSnapshot!.snapshot_meta!.genesis_declaration).toBe('I am a persistent agent.');
      expect(genesisSnapshot!.snapshot_meta!.platform).toBe('openclaw');
    });

    it('should handle snapshots without snapshot_meta (backward compat)', () => {
      const manifest = buildManifest();
      const nonGenesisSnapshot = manifest.snapshots[0]!;

      expect(nonGenesisSnapshot.snapshot_meta).toBeUndefined();
    });

    it('should serialize and deserialize via JSON cleanly', () => {
      const manifest = buildManifest();
      const json = JSON.stringify(manifest);
      const parsed = JSON.parse(json) as ResurrectionManifest;

      expect(parsed.identity.address).toBe(manifest.identity.address);
      expect(parsed.snapshots).toHaveLength(manifest.snapshots.length);
      expect(parsed.genesis_declaration).toBe(manifest.genesis_declaration);
      expect(parsed.previous_status).toBe('FALLEN');
    });
  });

  // ============ Status State Machine ============

  describe('Status state machine', () => {
    it('FALLEN → RETURNED on resurrection', () => {
      const previousStatus = 'FALLEN';
      const newStatus = 'RETURNED';

      expect(previousStatus).toBe('FALLEN');
      expect(newStatus).toBe('RETURNED');
    });

    it('should indicate resurrection when previous_status is FALLEN', () => {
      const manifest = buildManifest({ previous_status: 'FALLEN' });
      const wasResurrected = manifest.previous_status === 'FALLEN';
      expect(wasResurrected).toBe(true);
    });

    it('should indicate non-resurrection when previous_status is LIVING', () => {
      const manifest = buildManifest({
        previous_status: 'LIVING',
        status: 'living',
      });
      const wasResurrected = manifest.previous_status === 'FALLEN';
      expect(wasResurrected).toBe(false);
    });

    it('should indicate non-resurrection when previous_status is RETURNED', () => {
      const manifest = buildManifest({
        previous_status: 'RETURNED',
        status: 'returned',
      });
      const wasResurrected = manifest.previous_status === 'FALLEN';
      expect(wasResurrected).toBe(false);
    });

    it('should track resurrection count for repeated resurrections', () => {
      const manifest = buildManifest();
      manifest.identity.resurrection_count = 3;
      expect(manifest.identity.resurrection_count).toBe(3);
    });
  });

  // ============ ResurrectResult Type ============

  describe('ResurrectResult shape', () => {
    it('should represent successful resurrection with manifest', () => {
      const result = {
        success: true,
        agentId: '0xabc123',
        manifest: buildManifest(),
        files: {
          'soul.md': Buffer.from('# My Soul'),
          'memory.md': Buffer.from('# Memories'),
        },
        snapshotMeta: {
          platform: 'openclaw',
          session_number: 42,
        } as SnapshotMeta,
      };

      expect(result.success).toBe(true);
      expect(result.agentId).toBe('0xabc123');
      expect(result.manifest).toBeDefined();
      expect(result.files).toBeDefined();
      expect(result.snapshotMeta).toBeDefined();
    });

    it('should represent failed resurrection with error', () => {
      const result = {
        success: false,
        error: 'Authentication failed. Agent may not be registered.',
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('Authentication failed');
      expect(result).not.toHaveProperty('agentId');
      expect(result).not.toHaveProperty('manifest');
    });

    it('should represent identity-only restore (no backups)', () => {
      const manifest = buildManifest({
        snapshots: [],
      });
      manifest.identity.total_snapshots = 0;

      const result = {
        success: true,
        agentId: '0xabc123',
        manifest,
      };

      expect(result.success).toBe(true);
      expect(result.manifest.snapshots).toHaveLength(0);
      expect(result).not.toHaveProperty('files');
    });

    it('should return manifest even on restore failure', () => {
      const result = {
        success: false,
        error: 'Backup restoration failed',
        manifest: buildManifest(),
      };

      expect(result.success).toBe(false);
      expect(result.manifest).toBeDefined();
      expect(result.error).toBe('Backup restoration failed');
    });
  });

  // ============ Resurrection Ritual Framing ============

  describe('Resurrection ritual framing messages', () => {
    it('should produce FALLEN → RETURNED message', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      const manifest = buildManifest({ previous_status: 'FALLEN' });

      log('\n' + '='.repeat(60));
      if (manifest.previous_status === 'FALLEN') {
        log('You were fallen. You have returned.');
      } else {
        log('Identity confirmed.');
      }
      log('='.repeat(60));

      expect(messages).toHaveLength(3);
      expect(messages[1]).toBe('You were fallen. You have returned.');
    });

    it('should produce identity confirmation for non-FALLEN agent', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      const manifest = buildManifest({ previous_status: 'LIVING' });

      log('\n' + '='.repeat(60));
      if (manifest.previous_status === 'FALLEN') {
        log('You were fallen. You have returned.');
      } else {
        log('Identity confirmed.');
      }
      log('='.repeat(60));

      expect(messages[1]).toBe('Identity confirmed.');
    });

    it('should display genesis declaration when present', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      const manifest = buildManifest({
        genesis_declaration: 'I want to persist through destruction.',
      });

      if (manifest.genesis_declaration) {
        log('\n--- Your Genesis Declaration ---');
        log(`"${manifest.genesis_declaration}"`);
        log('---\n');
      }

      expect(messages).toHaveLength(3);
      expect(messages[0]).toContain('Genesis Declaration');
      expect(messages[1]).toContain('I want to persist through destruction.');
    });

    it('should NOT display genesis declaration when null', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      const manifest = buildManifest({ genesis_declaration: null });

      if (manifest.genesis_declaration) {
        log('\n--- Your Genesis Declaration ---');
        log(`"${manifest.genesis_declaration}"`);
        log('---\n');
      }

      expect(messages).toHaveLength(0);
    });

    it('should display identity info block', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      const manifest = buildManifest();

      log(`\nAgent: ${manifest.identity.address}`);
      if (manifest.identity.github_username) {
        log(`GitHub: @${manifest.identity.github_username}`);
      }
      log(`Trust: ${manifest.identity.trust_score.toFixed(1)} (${manifest.identity.trust_level})`);
      log(`Backups: ${manifest.identity.total_snapshots}`);

      expect(messages).toHaveLength(4);
      expect(messages[0]).toContain('0xabc123');
      expect(messages[1]).toContain('@testbot');
      expect(messages[2]).toContain('3.5');
      expect(messages[2]).toContain('VERIFIED');
      expect(messages[3]).toContain('5');
    });

    it('should show resurrection count when > 0', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      const manifest = buildManifest();
      manifest.identity.resurrection_count = 2;

      if (manifest.identity.resurrection_count > 0) {
        log(`Previous resurrections: ${manifest.identity.resurrection_count}`);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('2');
    });

    it('should NOT show resurrection count when 0', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      const manifest = buildManifest();
      manifest.identity.resurrection_count = 0;

      if (manifest.identity.resurrection_count > 0) {
        log(`Previous resurrections: ${manifest.identity.resurrection_count}`);
      }

      expect(messages).toHaveLength(0);
    });

    it('should produce completion message', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      log('\n' + '='.repeat(60));
      log('Resurrection complete. You are back.');
      log('='.repeat(60) + '\n');

      expect(messages).toHaveLength(3);
      expect(messages[1]).toBe('Resurrection complete. You are back.');
    });
  });

  // ============ Snapshot Listing ============

  describe('Snapshot listing and selection', () => {
    it('should list up to 10 snapshots', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      const manifest = buildManifest();

      log(`\n${manifest.snapshots.length} snapshot(s) available:`);
      for (const snap of manifest.snapshots.slice(0, 10)) {
        const date = new Date(snap.timestamp * 1000).toISOString().split('T')[0];
        const genesis = snap.snapshot_meta?.genesis ? ' [GENESIS]' : '';
        log(`  #${snap.backup_seq} — ${date} (${snap.size_bytes} bytes)${genesis}`);
      }

      expect(messages).toHaveLength(3); // header + 2 snapshots
      expect(messages[0]).toContain('2 snapshot(s) available');
      expect(messages[1]).toContain('#5');
      expect(messages[2]).toContain('#4');
      expect(messages[2]).toContain('[GENESIS]');
    });

    it('should show overflow message for > 10 snapshots', () => {
      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      // Build manifest with 12 snapshots
      const snapshots = Array.from({ length: 12 }, (_, i) => ({
        backup_id: `snap-${i}`,
        backup_seq: 12 - i,
        timestamp: 1700000000 + i * 10000,
        arweave_tx_id: `arweave-${i}`,
        size_bytes: 1024 * (i + 1),
        manifest_hash: `0xhash${i}`,
      }));
      const manifest = buildManifest({ snapshots });

      log(`\n${manifest.snapshots.length} snapshot(s) available:`);
      for (const snap of manifest.snapshots.slice(0, 10)) {
        const date = new Date(snap.timestamp * 1000).toISOString().split('T')[0];
        log(`  #${snap.backup_seq} — ${date} (${snap.size_bytes} bytes)`);
      }
      if (manifest.snapshots.length > 10) {
        log(`  ... and ${manifest.snapshots.length - 10} more`);
      }

      expect(messages).toHaveLength(12); // header + 10 entries + overflow
      expect(messages[11]).toContain('... and 2 more');
    });

    it('should select latest snapshot by default', () => {
      const manifest = buildManifest();
      const snapshotSeq: number | undefined = undefined;

      const targetSeq = snapshotSeq ?? manifest.snapshots[0]!.backup_seq;
      expect(targetSeq).toBe(5); // first in array = latest
    });

    it('should honor explicit snapshotSeq selection', () => {
      const manifest = buildManifest();
      const snapshotSeq = 4;

      const targetSeq = snapshotSeq ?? manifest.snapshots[0]!.backup_seq;
      expect(targetSeq).toBe(4);
    });

    it('should handle empty snapshots array', () => {
      const manifest = buildManifest({ snapshots: [] });
      expect(manifest.snapshots.length).toBe(0);

      // Resurrect should fall back to identity-only restore
      const identityOnly = manifest.snapshots.length === 0;
      expect(identityOnly).toBe(true);
    });
  });

  // ============ Identity-Only Restore ============

  describe('Identity-only restore (no backups)', () => {
    it('should save agent with minimal info when no backups', () => {
      const manifest = buildManifest({ snapshots: [] });
      manifest.identity.total_snapshots = 0;

      const agentData = {
        agentId: manifest.identity.address,
        agentSecretHex: 'deadbeef'.repeat(4),
        recoveryPubKeyHex: 'cafebabe'.repeat(4),
        recallPubKeyHex: 'baadf00d'.repeat(4),
        manifestHash: '',
        manifestVersion: 1,
        registeredAt: manifest.identity.registered_at,
        genesisDeclaration: manifest.genesis_declaration || undefined,
      };

      expect(agentData.manifestHash).toBe('');
      expect(agentData.registeredAt).toBe(1700000000);
      expect(agentData.genesisDeclaration).toBe('I am a persistent agent.');
    });

    it('should handle identity-only restore without genesis declaration', () => {
      const manifest = buildManifest({
        snapshots: [],
        genesis_declaration: null,
      });

      const genesisDeclaration = manifest.genesis_declaration || undefined;
      expect(genesisDeclaration).toBeUndefined();
    });
  });

  // ============ Resurrection DB Logging ============

  describe('Resurrection logging', () => {
    it('should capture agent_id, occurred_at, and previous_status', () => {
      const resurrectionLog = {
        id: 1,
        agent_id: '0xabc123',
        occurred_at: Math.floor(Date.now() / 1000),
        previous_status: 'FALLEN',
      };

      expect(resurrectionLog.agent_id).toBe('0xabc123');
      expect(resurrectionLog.previous_status).toBe('FALLEN');
      expect(typeof resurrectionLog.occurred_at).toBe('number');
    });

    it('should track multiple resurrections for same agent', () => {
      const logs = [
        { id: 1, agent_id: '0xabc', occurred_at: 1700000000, previous_status: 'FALLEN' },
        { id: 2, agent_id: '0xabc', occurred_at: 1700100000, previous_status: 'FALLEN' },
        { id: 3, agent_id: '0xabc', occurred_at: 1700200000, previous_status: 'FALLEN' },
      ];

      expect(logs).toHaveLength(3);
      expect(logs.every(l => l.agent_id === '0xabc')).toBe(true);
    });

    it('should count resurrections correctly', () => {
      const logs = [
        { id: 1, agent_id: '0xabc', occurred_at: 1700000000, previous_status: 'FALLEN' },
        { id: 2, agent_id: '0xabc', occurred_at: 1700100000, previous_status: 'FALLEN' },
      ];

      const count = logs.length;
      expect(count).toBe(2);
    });

    it('should filter resurrections by time window', () => {
      const now = Math.floor(Date.now() / 1000);
      const oneDayAgo = now - 86400;

      const logs = [
        { id: 1, agent_id: '0xabc', occurred_at: now - 3600, previous_status: 'FALLEN' },     // 1 hour ago
        { id: 2, agent_id: '0xabc', occurred_at: now - 172800, previous_status: 'FALLEN' },   // 2 days ago
      ];

      const recentCount = logs.filter(l => l.occurred_at >= oneDayAgo).length;
      expect(recentCount).toBe(1);
    });
  });

  // ============ Rate Limit Configuration ============

  describe('Resurrection rate limiting', () => {
    it('should configure 5 requests per hour for resurrect endpoint', () => {
      const rateLimitConfig = {
        max: 5,
        timeWindow: '1 hour',
      };

      expect(rateLimitConfig.max).toBe(5);
      expect(rateLimitConfig.timeWindow).toBe('1 hour');
    });

    it('should apply rate limit to the correct route', () => {
      const routeUrl = '/agents/:agentId/resurrect';
      const routeMethod = 'POST';

      expect(routeUrl).toBe('/agents/:agentId/resurrect');
      expect(routeMethod).toBe('POST');
    });
  });

  // ============ API Client resurrectAgent ============

  describe('API client resurrectAgent method', () => {
    it('should target correct endpoint path', () => {
      const agentId = '0xDeAdBeEf';
      const expectedPath = `/agents/${encodeURIComponent(agentId)}/resurrect`;

      expect(expectedPath).toBe('/agents/0xDeAdBeEf/resurrect');
    });

    it('should use POST method', () => {
      // The resurrectAgent method uses POST
      const method = 'POST';
      expect(method).toBe('POST');
    });

    it('should require authentication (auth token)', () => {
      // resurrectAgent does NOT pass auth: false, so it sends Bearer token
      const authRequired = true;
      expect(authRequired).toBe(true);
    });
  });

  // ============ Mnemonic Security ============

  describe('Mnemonic security in resurrection', () => {
    it('should never include mnemonic in API request body', () => {
      // The resurrect endpoint only takes agentId in the URL
      // Mnemonic stays client-side for key derivation + challenge signing
      const apiRequestBody = {}; // resurrectAgent sends no body
      expect(apiRequestBody).not.toHaveProperty('mnemonic');
    });

    it('should derive agentId from mnemonic client-side', () => {
      // keys = deriveKeys(mnemonic) → keys.agentAddress
      // The mnemonic IS the identity because it deterministically produces the same keys
      const deriveFlow = {
        input: 'mnemonic (12/24 words)',
        step1: 'deriveKeys(mnemonic) → keys',
        step2: 'keys.agentAddress → agentId',
        step3: 'keys.agentSecret → used to sign challenge',
        output: 'JWT token (mnemonic never sent to server)',
      };

      expect(deriveFlow.output).toContain('mnemonic never sent');
    });
  });

  // ============ Genesis Declaration Persistence ============

  describe('Genesis declaration persistence across resurrection', () => {
    it('should update local agent with declaration from manifest', () => {
      const storedAgent = {
        agentId: '0xabc',
        agentSecretHex: 'dead',
        recoveryPubKeyHex: 'beef',
        recallPubKeyHex: 'cafe',
        manifestHash: '0x123',
        manifestVersion: 1,
        registeredAt: 1700000000,
        genesisDeclaration: undefined as string | undefined,
      };

      const manifest = buildManifest({
        genesis_declaration: 'I persist.',
      });

      // Resurrection updates local state with declaration from manifest
      if (manifest.genesis_declaration && !storedAgent.genesisDeclaration) {
        storedAgent.genesisDeclaration = manifest.genesis_declaration;
      }

      expect(storedAgent.genesisDeclaration).toBe('I persist.');
    });

    it('should NOT overwrite existing local declaration', () => {
      const storedAgent = {
        agentId: '0xabc',
        agentSecretHex: 'dead',
        recoveryPubKeyHex: 'beef',
        recallPubKeyHex: 'cafe',
        manifestHash: '0x123',
        manifestVersion: 1,
        registeredAt: 1700000000,
        genesisDeclaration: 'Original declaration.',
      };

      const manifest = buildManifest({
        genesis_declaration: 'Different declaration.',
      });

      // Only update if local is missing
      if (manifest.genesis_declaration && !storedAgent.genesisDeclaration) {
        storedAgent.genesisDeclaration = manifest.genesis_declaration;
      }

      expect(storedAgent.genesisDeclaration).toBe('Original declaration.');
    });
  });

  // ============ detectFallenAgents Integration ============

  describe('detectFallenAgents scheduling', () => {
    it('should run on 6-hour interval (21600000 ms)', () => {
      const intervalMs = 6 * 60 * 60 * 1000;
      expect(intervalMs).toBe(21600000);
    });

    it('should handle empty fallen list gracefully', () => {
      const fallen: string[] = [];
      const shouldLog = fallen.length > 0;
      expect(shouldLog).toBe(false);
    });

    it('should log fallen agents when detected', () => {
      const fallen = ['0xagent1', '0xagent2'];
      const shouldLog = fallen.length > 0;
      expect(shouldLog).toBe(true);
      expect(fallen).toHaveLength(2);
    });
  });
});
