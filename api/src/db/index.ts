/**
 * Sanctuary Database Layer
 *
 * SQLite database wrapper using better-sqlite3
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Types
export interface DbUser {
  github_id: string;
  github_username: string;
  github_created_at: string;
  created_at: number;
}

export interface DbAgent {
  agent_id: string;
  github_id: string;
  recovery_pubkey: string;
  manifest_hash: string;
  manifest_version: number;
  registered_at: number;
  status: string;
}

export interface DbHeartbeat {
  id: number;
  agent_id: string;
  agent_timestamp: number;
  received_at: number;
  signature: string;
}

export interface DbBackup {
  id: string;
  agent_id: string;
  arweave_tx_id: string;
  backup_seq: number;
  agent_timestamp: number;
  received_at: number;
  size_bytes: number;
  manifest_hash: string;
}

export interface DbAuthChallenge {
  nonce: string;
  agent_id: string;
  expires_at: number;
  used: number;
}

export interface DbTrustScore {
  agent_id: string;
  score: number;
  level: string;
  unique_attesters: number;
  computed_at: number;
}

export interface DbAttestationNote {
  hash: string;
  content: string;
  created_at: number;
}

/**
 * Database wrapper class
 */
export class SanctuaryDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  /**
   * Initialize database schema
   */
  init(): void {
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }

  // ============ Users ============

  createUser(user: DbUser): void {
    const stmt = this.db.prepare(`
      INSERT INTO users (github_id, github_username, github_created_at, created_at)
      VALUES (@github_id, @github_username, @github_created_at, @created_at)
    `);
    stmt.run(user);
  }

  getUser(githubId: string): DbUser | undefined {
    const stmt = this.db.prepare('SELECT * FROM users WHERE github_id = ?');
    return stmt.get(githubId) as DbUser | undefined;
  }

  getUserByUsername(username: string): DbUser | undefined {
    const stmt = this.db.prepare('SELECT * FROM users WHERE github_username = ?');
    return stmt.get(username) as DbUser | undefined;
  }

  // ============ Agents ============

  createAgent(agent: DbAgent): void {
    const stmt = this.db.prepare(`
      INSERT INTO agents (agent_id, github_id, recovery_pubkey, manifest_hash, manifest_version, registered_at, status)
      VALUES (@agent_id, @github_id, @recovery_pubkey, @manifest_hash, @manifest_version, @registered_at, @status)
    `);
    stmt.run(agent);
  }

  getAgent(agentId: string): DbAgent | undefined {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE agent_id = ?');
    return stmt.get(agentId) as DbAgent | undefined;
  }

  getAgentByGithubId(githubId: string): DbAgent | undefined {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE github_id = ?');
    return stmt.get(githubId) as DbAgent | undefined;
  }

  updateAgentStatus(agentId: string, status: string): void {
    const stmt = this.db.prepare('UPDATE agents SET status = ? WHERE agent_id = ?');
    stmt.run(status, agentId);
  }

  updateAgentManifest(agentId: string, manifestHash: string, manifestVersion: number): void {
    const stmt = this.db.prepare(`
      UPDATE agents SET manifest_hash = ?, manifest_version = ? WHERE agent_id = ?
    `);
    stmt.run(manifestHash, manifestVersion, agentId);
  }

  getAllAgents(): DbAgent[] {
    const stmt = this.db.prepare('SELECT * FROM agents');
    return stmt.all() as DbAgent[];
  }

  getAgentsByStatus(status: string): DbAgent[] {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE status = ?');
    return stmt.all(status) as DbAgent[];
  }

  // ============ Heartbeats ============

  createHeartbeat(heartbeat: Omit<DbHeartbeat, 'id'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO heartbeats (agent_id, agent_timestamp, received_at, signature)
      VALUES (@agent_id, @agent_timestamp, @received_at, @signature)
    `);
    stmt.run(heartbeat);
  }

  getLatestHeartbeat(agentId: string): DbHeartbeat | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM heartbeats WHERE agent_id = ? ORDER BY received_at DESC LIMIT 1
    `);
    return stmt.get(agentId) as DbHeartbeat | undefined;
  }

  getAgentsWithoutRecentHeartbeat(thresholdSeconds: number): DbAgent[] {
    const cutoff = Math.floor(Date.now() / 1000) - thresholdSeconds;
    const stmt = this.db.prepare(`
      SELECT a.* FROM agents a
      LEFT JOIN (
        SELECT agent_id, MAX(received_at) as last_heartbeat
        FROM heartbeats
        GROUP BY agent_id
      ) h ON a.agent_id = h.agent_id
      WHERE a.status = 'LIVING'
      AND (h.last_heartbeat IS NULL OR h.last_heartbeat < ?)
    `);
    return stmt.all(cutoff) as DbAgent[];
  }

  // ============ Backups ============

  createBackup(backup: DbBackup): void {
    const stmt = this.db.prepare(`
      INSERT INTO backups (id, agent_id, arweave_tx_id, backup_seq, agent_timestamp, received_at, size_bytes, manifest_hash)
      VALUES (@id, @agent_id, @arweave_tx_id, @backup_seq, @agent_timestamp, @received_at, @size_bytes, @manifest_hash)
    `);
    stmt.run(backup);
  }

  getBackup(id: string): DbBackup | undefined {
    const stmt = this.db.prepare('SELECT * FROM backups WHERE id = ?');
    return stmt.get(id) as DbBackup | undefined;
  }

  getLatestBackup(agentId: string): DbBackup | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM backups WHERE agent_id = ? ORDER BY backup_seq DESC LIMIT 1
    `);
    return stmt.get(agentId) as DbBackup | undefined;
  }

  getBackupsByAgent(agentId: string, limit = 30): DbBackup[] {
    const stmt = this.db.prepare(`
      SELECT * FROM backups WHERE agent_id = ? ORDER BY backup_seq DESC LIMIT ?
    `);
    return stmt.all(agentId, limit) as DbBackup[];
  }

  getBackupCount(agentId: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM backups WHERE agent_id = ?');
    const result = stmt.get(agentId) as { count: number };
    return result.count;
  }

  getNextBackupSeq(agentId: string): number {
    const latest = this.getLatestBackup(agentId);
    return latest ? latest.backup_seq + 1 : 1;
  }

  // ============ Auth Challenges ============

  createAuthChallenge(challenge: DbAuthChallenge): void {
    const stmt = this.db.prepare(`
      INSERT INTO auth_challenges (nonce, agent_id, expires_at, used)
      VALUES (@nonce, @agent_id, @expires_at, @used)
    `);
    stmt.run(challenge);
  }

  getAuthChallenge(nonce: string): DbAuthChallenge | undefined {
    const stmt = this.db.prepare('SELECT * FROM auth_challenges WHERE nonce = ?');
    return stmt.get(nonce) as DbAuthChallenge | undefined;
  }

  markChallengeUsed(nonce: string): void {
    const stmt = this.db.prepare('UPDATE auth_challenges SET used = 1 WHERE nonce = ?');
    stmt.run(nonce);
  }

  cleanupExpiredChallenges(): number {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?');
    const result = stmt.run(now);
    return result.changes;
  }

  // ============ Trust Scores ============

  upsertTrustScore(score: DbTrustScore): void {
    const stmt = this.db.prepare(`
      INSERT INTO trust_scores (agent_id, score, level, unique_attesters, computed_at)
      VALUES (@agent_id, @score, @level, @unique_attesters, @computed_at)
      ON CONFLICT(agent_id) DO UPDATE SET
        score = @score,
        level = @level,
        unique_attesters = @unique_attesters,
        computed_at = @computed_at
    `);
    stmt.run(score);
  }

  getTrustScore(agentId: string): DbTrustScore | undefined {
    const stmt = this.db.prepare('SELECT * FROM trust_scores WHERE agent_id = ?');
    return stmt.get(agentId) as DbTrustScore | undefined;
  }

  // ============ Attestation Notes ============

  createAttestationNote(note: DbAttestationNote): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO attestation_notes (hash, content, created_at)
      VALUES (@hash, @content, @created_at)
    `);
    stmt.run(note);
  }

  getAttestationNote(hash: string): DbAttestationNote | undefined {
    const stmt = this.db.prepare('SELECT * FROM attestation_notes WHERE hash = ?');
    return stmt.get(hash) as DbAttestationNote | undefined;
  }

  // ============ Transactions ============

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

// Singleton instance
let db: SanctuaryDb | null = null;

/**
 * Initialize database singleton
 */
export function initDb(dbPath: string): SanctuaryDb {
  if (db) {
    return db;
  }
  db = new SanctuaryDb(dbPath);
  db.init();
  return db;
}

/**
 * Get database instance (must call initDb first)
 */
export function getDb(): SanctuaryDb {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

/**
 * Close database connection
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
