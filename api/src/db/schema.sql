-- Sanctuary Database Schema v2
--
-- NOTE: This file is reference documentation only.
-- The live schema is inlined in db/index.ts to avoid path issues after tsc.
-- Keep this file in sync with the inlined schema + migrations.

-- Users (GitHub identity)
CREATE TABLE IF NOT EXISTS users (
    github_id TEXT PRIMARY KEY,
    github_username TEXT NOT NULL,
    github_created_at TEXT NOT NULL,  -- ISO timestamp from GitHub
    created_at INTEGER NOT NULL       -- Unix timestamp (our DB)
);

-- Agents
CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,        -- Ethereum address (0x...)
    github_id TEXT NOT NULL UNIQUE,   -- One agent per GitHub account
    recovery_pubkey TEXT NOT NULL,    -- Hex-encoded X25519 pubkey
    manifest_hash TEXT NOT NULL,      -- keccak256 hex (0x...)
    manifest_version INTEGER NOT NULL DEFAULT 1,
    registered_at INTEGER NOT NULL,   -- Unix timestamp
    status TEXT NOT NULL DEFAULT 'LIVING',  -- LIVING/FALLEN/RETURNED
    genesis_declaration TEXT,         -- Optional genesis statement
    onchain_tx_hash TEXT,            -- On-chain registration tx hash
    onchain_status TEXT,             -- pending/confirmed/failed/simulated
    FOREIGN KEY (github_id) REFERENCES users(github_id)
);

-- Heartbeats
CREATE TABLE IF NOT EXISTS heartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    agent_timestamp INTEGER NOT NULL,  -- What agent claims
    received_at INTEGER NOT NULL,      -- When we received it (use this for FALLEN detection)
    signature TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

-- Backups
CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY,              -- UUID
    agent_id TEXT NOT NULL,
    arweave_tx_id TEXT NOT NULL,
    backup_seq INTEGER NOT NULL,      -- Monotonic counter for ordering
    agent_timestamp INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    manifest_hash TEXT NOT NULL,      -- For verification
    snapshot_meta TEXT,               -- JSON: model, platform, genesis flag, etc.
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

-- Auth challenges (short-lived)
CREATE TABLE IF NOT EXISTS auth_challenges (
    nonce TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);

-- Trust scores (cached, recomputed periodically)
CREATE TABLE IF NOT EXISTS trust_scores (
    agent_id TEXT PRIMARY KEY,
    score REAL NOT NULL,
    level TEXT NOT NULL,              -- UNVERIFIED/VERIFIED/ESTABLISHED/PILLAR
    unique_attesters INTEGER NOT NULL,
    computed_at INTEGER NOT NULL,
    breakdown TEXT,                   -- JSON: per-signal score breakdown
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

-- Attestation notes (content stored here, hash on-chain)
CREATE TABLE IF NOT EXISTS attestation_notes (
    hash TEXT PRIMARY KEY,            -- keccak256 of content
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Attestations (on-chain + DB record)
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

-- Resurrection log (tracks FALLEN -> RETURNED transitions)
CREATE TABLE IF NOT EXISTS resurrection_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    previous_status TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_agents_github_id ON agents(github_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_heartbeats_agent ON heartbeats(agent_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_backups_agent ON backups(agent_id, backup_seq DESC);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_attestations_from ON attestations(from_agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attestations_about ON attestations(about_agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resurrection_log_agent ON resurrection_log(agent_id, occurred_at DESC);
