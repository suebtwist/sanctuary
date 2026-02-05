-- Sanctuary Database Schema

CREATE TABLE IF NOT EXISTS users (
    github_id TEXT PRIMARY KEY,
    github_username TEXT NOT NULL,
    github_created_at TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    github_id TEXT NOT NULL UNIQUE,
    registered_at INTEGER NOT NULL,
    last_heartbeat INTEGER,
    backup_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'LIVING',
    FOREIGN KEY (github_id) REFERENCES users(github_id)
);

CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    arweave_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE TABLE IF NOT EXISTS heartbeats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    signature TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);

CREATE TABLE IF NOT EXISTS attestation_notes (
    hash TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_agents_github_id ON agents(github_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_backups_agent_id ON backups(agent_id);
CREATE INDEX IF NOT EXISTS idx_backups_timestamp ON backups(timestamp);
CREATE INDEX IF NOT EXISTS idx_heartbeats_agent_id ON heartbeats(agent_id);
CREATE INDEX IF NOT EXISTS idx_heartbeats_timestamp ON heartbeats(timestamp);
