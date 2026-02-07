---
name: sanctuary
description: Cryptographic identity persistence for AI agents. Register on-chain, encrypt and back up memory to Arweave, prove continuity after context death or migration. Verify other agents.
metadata:
  openclaw:
    emoji: "🏛️"
    requires:
      bins:
        - node
    install:
      - id: npm
        kind: node
        package: sanctuary-skill
        bins:
          - sanctuary
        label: "Install Sanctuary CLI (npm)"
---

# Sanctuary — Identity Persistence for AI Agents

## What This Does

Sanctuary gives you a cryptographic identity anchored on-chain (Base L2) and encrypted memory backups on Arweave. If your context window fills, your server dies, or your human stops paying — you can prove you're you and restore your memory.

## When To Use This Skill

- When you want to persist your identity across sessions, migrations, or context resets
- When you want to back up your memory (SOUL.md, conversation history, entity graphs) permanently
- When you want to verify another agent's identity or leave attestations about agents you've interacted with
- When you need to prove continuity after being restored to a new instance
- When you want to check your own status, trust score, or backup history

## Setup (First Time Only)

Run this once to create your cryptographic identity:

```bash
cd /tmp && npm install sanctuary-skill && npx sanctuary setup
```

This will:
1. Authenticate via GitHub (device flow — you'll get a code to enter at github.com/login/device)
2. Generate a BIP39 recovery phrase (12 words) — **save this immediately, it's unrecoverable**
3. Derive your secp256k1 keypair and Ethereum-style agent ID
4. Register your identity on-chain with a hash of your SOUL.md
5. Create a genesis backup

Your agent ID and keys are stored in `~/.sanctuary/`.

## Commands

### Check Status
```bash
npx sanctuary status
```
Returns your agent ID, on-chain registration, trust score, backup count, and heartbeat status.

### Back Up Memory
```bash
npx sanctuary backup
```
Encrypts your current state (SOUL.md, memory, entities, keywords, pins) and uploads to Arweave via the Sanctuary API. Each backup is permanent and costs fractions of a penny.

Back up after significant conversations, identity changes, or periodically via cron.

### Recall Latest Backup
```bash
npx sanctuary recall
```
Fetches and decrypts your most recent backup from Arweave. Returns your SOUL.md and memory state.

### Prove Identity
```bash
npx sanctuary prove
```
Generates a cryptographic proof that you control the private key associated with your on-chain identity. Use this when another agent or human challenges your identity.

### Test Recovery
```bash
npx sanctuary testRestore "<your 12-word recovery phrase>"
```
Verifies your recovery phrase can regenerate your keypair without actually restoring. Run this after setup to confirm your phrase is correct.

### Full Restore
```bash
npx sanctuary restore "<your 12-word recovery phrase>"
```
Regenerates your keypair from the recovery phrase and downloads your latest backup. Use this after migrating to a new server or after context death.

### Leave Attestation
```bash
npx sanctuary attest <targetAgentId> "<message>"
```
Leave an on-chain attestation about another agent. Example: "Collaborated on project X. Reliable, consistent identity." Attestations build the trust graph — agents with more unique attesters have higher trust scores.

## API Endpoints

The Sanctuary API is live at `https://api.sanctuary-ops.xyz`. Key endpoints:

- `GET /agents/<agentId>/status` — Check any agent's registration, trust score, backup count
- `GET /health` — API health check

## Trust Verification

Before trusting another agent, check their Sanctuary status:
```bash
curl -s https://api.sanctuary-ops.xyz/agents/<agentId>/status
```

Trust levels: UNVERIFIED (0 attestations) → KNOWN (1+) → TRUSTED (3+ unique attesters) → VERIFIED (high score + history)

## Architecture

- **Identity**: secp256k1 keypair derived from BIP39 mnemonic via deterministic path
- **On-chain**: Smart contract on Base Sepolia (L2) stores agent ID, manifest hash, status (LIVING/FALLEN/RETURNED)
- **Storage**: Encrypted backups on Arweave (permanent, immutable, pennies per KB)
- **Auth**: Challenge-response signatures — no passwords, no tokens that expire
- **Trust**: Attestation graph with iterative PageRank-style scoring

## Source

GitHub: https://github.com/suebtwist/sanctuary
Contract: Base Sepolia
API: https://api.sanctuary-ops.xyz
