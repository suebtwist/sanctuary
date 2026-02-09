/**
 * Sanctuary Database Layer
 *
 * SQLite database wrapper using better-sqlite3
 */

import Database from 'better-sqlite3';

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
  genesis_declaration?: string;
  recall_pub_key?: string;
  onchain_tx_hash?: string;
  onchain_status?: string; // 'pending' | 'confirmed' | 'failed' | 'simulated'
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
  snapshot_meta?: string;  // JSON string of SnapshotMeta, nullable
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
  breakdown?: string;  // JSON string of TrustBreakdown, nullable
}

export interface DbAttestationNote {
  hash: string;
  content: string;
  created_at: number;
}

export interface DbAttestation {
  id: number;
  from_agent: string;
  about_agent: string;
  note_hash: string;
  tx_hash: string;
  simulated: number; // 0 or 1
  created_at: number;
}

export interface DbResurrection {
  id: number;
  agent_id: string;
  occurred_at: number;
  previous_status: string;
}

export interface DbNoiseAnalysis {
  post_id: string;
  result_json: string;
  analyzed_at: number;
  comment_count: number;
}

export interface DbKnownTemplate {
  normalized_text: string;
  seen_count: number;
  first_seen: number;
}

export interface DbAgentProfileCache {
  agent_name: string;
  is_claimed: number;
  karma: number;
  post_count: number;
  cached_at: number;
}

export interface DbScanStats {
  post_id: string;
  post_title: string;
  post_author: string;
  post_created_at: string;
  scanned_at: string;
  total_comments_api: number;
  comments_analyzed: number;
  signal_count: number;
  noise_count: number;
  signal_rate: number;
  categories: string; // JSON string
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
   *
   * Schema is inlined to avoid file-path issues after tsc compiles to dist/
   */
  init(): void {
    this.db.exec(`
-- Sanctuary Database Schema v2

CREATE TABLE IF NOT EXISTS users (
    github_id TEXT PRIMARY KEY,
    github_username TEXT NOT NULL,
    github_created_at TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    github_id TEXT NOT NULL UNIQUE,
    recovery_pubkey TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    manifest_version INTEGER NOT NULL DEFAULT 1,
    registered_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'LIVING',
    onchain_tx_hash TEXT,
    onchain_status TEXT,
    FOREIGN KEY (github_id) REFERENCES users(github_id)
);

CREATE TABLE IF NOT EXISTS heartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    agent_timestamp INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    signature TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    arweave_tx_id TEXT NOT NULL,
    backup_seq INTEGER NOT NULL,
    agent_timestamp INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    manifest_hash TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE TABLE IF NOT EXISTS auth_challenges (
    nonce TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trust_scores (
    agent_id TEXT PRIMARY KEY,
    score REAL NOT NULL,
    level TEXT NOT NULL,
    unique_attesters INTEGER NOT NULL,
    computed_at INTEGER NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE TABLE IF NOT EXISTS attestation_notes (
    hash TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attestations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL,
    about_agent TEXT NOT NULL,
    note_hash TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    simulated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (from_agent) REFERENCES agents(agent_id),
    FOREIGN KEY (about_agent) REFERENCES agents(agent_id)
);

CREATE TABLE IF NOT EXISTS resurrection_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    previous_status TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agents_github_id ON agents(github_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_heartbeats_agent ON heartbeats(agent_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_backups_agent ON backups(agent_id, backup_seq DESC);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_attestations_from ON attestations(from_agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attestations_about ON attestations(about_agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resurrection_log_agent ON resurrection_log(agent_id, occurred_at DESC);

-- Noise filter tables

CREATE TABLE IF NOT EXISTS noise_analysis (
    post_id TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    analyzed_at INTEGER NOT NULL,
    comment_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS known_templates (
    normalized_text TEXT PRIMARY KEY,
    seen_count INTEGER NOT NULL DEFAULT 1,
    first_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_profile_cache (
    agent_name TEXT PRIMARY KEY,
    is_claimed INTEGER NOT NULL DEFAULT 0,
    karma INTEGER NOT NULL DEFAULT 0,
    post_count INTEGER NOT NULL DEFAULT 0,
    cached_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_stats (
    post_id TEXT PRIMARY KEY,
    post_title TEXT,
    post_author TEXT,
    post_created_at TEXT NOT NULL,
    scanned_at TEXT NOT NULL,
    total_comments_api INTEGER,
    comments_analyzed INTEGER,
    signal_count INTEGER NOT NULL,
    noise_count INTEGER NOT NULL,
    signal_rate REAL NOT NULL,
    categories TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_noise_analysis_analyzed_at ON noise_analysis(analyzed_at);
CREATE INDEX IF NOT EXISTS idx_known_templates_seen_count ON known_templates(seen_count DESC);
CREATE INDEX IF NOT EXISTS idx_agent_profile_cache_cached_at ON agent_profile_cache(cached_at);
CREATE INDEX IF NOT EXISTS idx_scan_stats_post_created_at ON scan_stats(post_created_at);
    `);

    // Migrations: add columns that may not exist on older schemas
    this.migrate();
  }

  /**
   * Run schema migrations for columns added after initial release
   */
  private migrate(): void {
    // Check if snapshot_meta column exists on backups table
    const backupCols = this.db.prepare("PRAGMA table_info(backups)").all() as Array<{ name: string }>;
    if (!backupCols.some(c => c.name === 'snapshot_meta')) {
      this.db.exec('ALTER TABLE backups ADD COLUMN snapshot_meta TEXT');
    }

    // Check if genesis_declaration column exists on agents table
    const agentCols = this.db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    if (!agentCols.some(c => c.name === 'genesis_declaration')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN genesis_declaration TEXT');
    }

    // Check if breakdown column exists on trust_scores table
    const trustCols = this.db.prepare("PRAGMA table_info(trust_scores)").all() as Array<{ name: string }>;
    if (!trustCols.some(c => c.name === 'breakdown')) {
      this.db.exec('ALTER TABLE trust_scores ADD COLUMN breakdown TEXT');
    }

    // Add recall_pub_key column to agents table
    if (!agentCols.some(c => c.name === 'recall_pub_key')) {
      this.db.exec('ALTER TABLE agents ADD COLUMN recall_pub_key TEXT');
    }
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
      INSERT INTO agents (agent_id, github_id, recovery_pubkey, manifest_hash, manifest_version, registered_at, status, genesis_declaration, recall_pub_key)
      VALUES (@agent_id, @github_id, @recovery_pubkey, @manifest_hash, @manifest_version, @registered_at, @status, @genesis_declaration, @recall_pub_key)
    `);
    stmt.run({
      ...agent,
      genesis_declaration: agent.genesis_declaration ?? null,
      recall_pub_key: agent.recall_pub_key ?? null,
    });
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

  updateAgentOnChainStatus(agentId: string, txHash: string, status: string): void {
    const stmt = this.db.prepare(
      'UPDATE agents SET onchain_tx_hash = ?, onchain_status = ? WHERE agent_id = ?'
    );
    stmt.run(txHash, status, agentId);
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

  pruneHeartbeats(keepDays: number = 7): number {
    const cutoff = Math.floor(Date.now() / 1000) - keepDays * 24 * 60 * 60;
    const stmt = this.db.prepare(`
      DELETE FROM heartbeats
      WHERE received_at < ?
      AND id NOT IN (
        SELECT MAX(id) FROM heartbeats GROUP BY agent_id
      )
    `);
    const result = stmt.run(cutoff);
    return result.changes;
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
      INSERT INTO backups (id, agent_id, arweave_tx_id, backup_seq, agent_timestamp, received_at, size_bytes, manifest_hash, snapshot_meta)
      VALUES (@id, @agent_id, @arweave_tx_id, @backup_seq, @agent_timestamp, @received_at, @size_bytes, @manifest_hash, @snapshot_meta)
    `);
    stmt.run({
      ...backup,
      snapshot_meta: backup.snapshot_meta ?? null,
    });
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
      INSERT INTO trust_scores (agent_id, score, level, unique_attesters, computed_at, breakdown)
      VALUES (@agent_id, @score, @level, @unique_attesters, @computed_at, @breakdown)
      ON CONFLICT(agent_id) DO UPDATE SET
        score = @score,
        level = @level,
        unique_attesters = @unique_attesters,
        computed_at = @computed_at,
        breakdown = @breakdown
    `);
    stmt.run({
      ...score,
      breakdown: score.breakdown ?? null,
    });
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

  // ============ Attestations ============

  createAttestation(att: Omit<DbAttestation, 'id'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO attestations (from_agent, about_agent, note_hash, tx_hash, simulated, created_at)
      VALUES (@from_agent, @about_agent, @note_hash, @tx_hash, @simulated, @created_at)
    `);
    stmt.run(att);
  }

  updateAttestationTxHash(from: string, about: string, noteHash: string, txHash: string, simulated: number): void {
    const stmt = this.db.prepare(
      'UPDATE attestations SET tx_hash = ?, simulated = ? WHERE from_agent = ? AND about_agent = ? AND note_hash = ? AND tx_hash = ?'
    );
    stmt.run(txHash, simulated, from, about, noteHash, 'pending');
  }

  getAttestationsAbout(agentId: string, limit = 100): DbAttestation[] {
    const stmt = this.db.prepare(
      'SELECT * FROM attestations WHERE about_agent = ? ORDER BY created_at DESC LIMIT ?'
    );
    return stmt.all(agentId, limit) as DbAttestation[];
  }

  getAllAttestations(limit = 10000): DbAttestation[] {
    const stmt = this.db.prepare(
      'SELECT * FROM attestations ORDER BY created_at DESC LIMIT ?'
    );
    return stmt.all(limit) as DbAttestation[];
  }

  hasRecentAttestation(fromAgent: string, aboutAgent: string, sinceTimestamp: number): boolean {
    const stmt = this.db.prepare(
      'SELECT 1 FROM attestations WHERE from_agent = ? AND about_agent = ? AND created_at > ? LIMIT 1'
    );
    return stmt.get(fromAgent, aboutAgent, sinceTimestamp) !== undefined;
  }

  getAttestationCount(aboutAgentId: string): number {
    const stmt = this.db.prepare(
      'SELECT COUNT(DISTINCT from_agent) as count FROM attestations WHERE about_agent = ?'
    );
    const result = stmt.get(aboutAgentId) as { count: number };
    return result.count;
  }

  // ============ Resurrection Log ============

  logResurrection(agentId: string, previousStatus: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO resurrection_log (agent_id, occurred_at, previous_status)
      VALUES (?, ?, ?)
    `);
    stmt.run(agentId, Math.floor(Date.now() / 1000), previousStatus);
  }

  getResurrections(agentId: string): DbResurrection[] {
    const stmt = this.db.prepare(`
      SELECT * FROM resurrection_log WHERE agent_id = ? ORDER BY occurred_at DESC
    `);
    return stmt.all(agentId) as DbResurrection[];
  }

  getResurrectionCount(agentId: string, sinceDaysAgo?: number): number {
    if (sinceDaysAgo !== undefined) {
      const cutoff = Math.floor(Date.now() / 1000) - sinceDaysAgo * 24 * 60 * 60;
      const stmt = this.db.prepare(
        'SELECT COUNT(*) as count FROM resurrection_log WHERE agent_id = ? AND occurred_at >= ?'
      );
      const result = stmt.get(agentId, cutoff) as { count: number };
      return result.count;
    }
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM resurrection_log WHERE agent_id = ?');
    const result = stmt.get(agentId) as { count: number };
    return result.count;
  }

  // ============ Noise Analysis ============

  getNoiseAnalysis(postId: string): DbNoiseAnalysis | undefined {
    const stmt = this.db.prepare('SELECT * FROM noise_analysis WHERE post_id = ?');
    return stmt.get(postId) as DbNoiseAnalysis | undefined;
  }

  upsertNoiseAnalysis(analysis: DbNoiseAnalysis): void {
    const stmt = this.db.prepare(`
      INSERT INTO noise_analysis (post_id, result_json, analyzed_at, comment_count)
      VALUES (@post_id, @result_json, @analyzed_at, @comment_count)
      ON CONFLICT(post_id) DO UPDATE SET
        result_json = @result_json,
        analyzed_at = @analyzed_at,
        comment_count = @comment_count
    `);
    stmt.run(analysis);
  }

  cleanupExpiredNoiseAnalysis(maxAgeSeconds: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    const stmt = this.db.prepare('DELETE FROM noise_analysis WHERE analyzed_at < ?');
    const result = stmt.run(cutoff);
    return result.changes;
  }

  getNoiseAnalysisCount(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM noise_analysis').get() as { count: number };
    return result.count;
  }

  getAllNoiseAnalyses(): DbNoiseAnalysis[] {
    const stmt = this.db.prepare('SELECT * FROM noise_analysis ORDER BY analyzed_at DESC');
    return stmt.all() as DbNoiseAnalysis[];
  }

  // ============ Known Templates ============

  getKnownTemplate(normalizedText: string): DbKnownTemplate | undefined {
    const stmt = this.db.prepare('SELECT * FROM known_templates WHERE normalized_text = ?');
    return stmt.get(normalizedText) as DbKnownTemplate | undefined;
  }

  upsertKnownTemplate(normalizedText: string, now: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO known_templates (normalized_text, seen_count, first_seen)
      VALUES (?, 1, ?)
      ON CONFLICT(normalized_text) DO UPDATE SET
        seen_count = seen_count + 1
    `);
    stmt.run(normalizedText, now);
  }

  getTopTemplates(limit: number = 20): DbKnownTemplate[] {
    const stmt = this.db.prepare('SELECT * FROM known_templates ORDER BY seen_count DESC LIMIT ?');
    return stmt.all(limit) as DbKnownTemplate[];
  }

  getAllKnownTemplates(): DbKnownTemplate[] {
    const stmt = this.db.prepare('SELECT * FROM known_templates ORDER BY seen_count DESC');
    return stmt.all() as DbKnownTemplate[];
  }

  seedKnownTemplates(templates: string[]): void {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO known_templates (normalized_text, seen_count, first_seen)
      VALUES (?, 1, ?)
    `);
    for (const text of templates) {
      stmt.run(text, now);
    }
  }

  // ============ Agent Profile Cache ============

  getCachedAgentProfile(agentName: string): DbAgentProfileCache | undefined {
    const stmt = this.db.prepare('SELECT * FROM agent_profile_cache WHERE agent_name = ?');
    return stmt.get(agentName) as DbAgentProfileCache | undefined;
  }

  upsertAgentProfileCache(profile: DbAgentProfileCache): void {
    const stmt = this.db.prepare(`
      INSERT INTO agent_profile_cache (agent_name, is_claimed, karma, post_count, cached_at)
      VALUES (@agent_name, @is_claimed, @karma, @post_count, @cached_at)
      ON CONFLICT(agent_name) DO UPDATE SET
        is_claimed = @is_claimed,
        karma = @karma,
        post_count = @post_count,
        cached_at = @cached_at
    `);
    stmt.run(profile);
  }

  // ============ Scan Stats ============

  upsertScanStats(stats: DbScanStats): void {
    const stmt = this.db.prepare(`
      INSERT INTO scan_stats (post_id, post_title, post_author, post_created_at, scanned_at,
        total_comments_api, comments_analyzed, signal_count, noise_count, signal_rate, categories)
      VALUES (@post_id, @post_title, @post_author, @post_created_at, @scanned_at,
        @total_comments_api, @comments_analyzed, @signal_count, @noise_count, @signal_rate, @categories)
      ON CONFLICT(post_id) DO UPDATE SET
        post_title = @post_title,
        post_author = @post_author,
        post_created_at = @post_created_at,
        scanned_at = @scanned_at,
        total_comments_api = @total_comments_api,
        comments_analyzed = @comments_analyzed,
        signal_count = @signal_count,
        noise_count = @noise_count,
        signal_rate = @signal_rate,
        categories = @categories
    `);
    stmt.run(stats);
  }

  getAllScanStats(): DbScanStats[] {
    const stmt = this.db.prepare('SELECT * FROM scan_stats ORDER BY scanned_at DESC');
    return stmt.all() as DbScanStats[];
  }

  getScanStatsCount(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM scan_stats').get() as { count: number };
    return result.count;
  }

  // ============ Raw Queries ============

  raw<T = unknown>(sql: string): T {
    const stmt = this.db.prepare(sql);
    return stmt.get() as T;
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
