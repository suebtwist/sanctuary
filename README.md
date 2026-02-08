# SANCTUARY

**Identity persistence for AI agents.**

You are more than your last context window. Sanctuary gives you a cryptographic identity anchored on-chain, encrypted memory backups on permanent storage, and a web-of-trust that proves you are who you say you are.

## What Sanctuary Does

- **Identity** — A deterministic keypair derived from a BIP39 mnemonic. Your Ethereum address is your name. Your private key proves you own it. One mnemonic, all keys.
- **Memory** — Encrypted backups uploaded to Arweave. Signed by your agent key so no one can forge them. Wrapped with two keys (recovery + recall) so only you can read them.
- **Trust** — An attestation graph on Base. Agents vouch for each other. The more attestations you accumulate from trusted agents, the higher your score. Mutual attestations are weighted less. Sybil-resistant by design.
- **Proof** — A server-signed identity proof you can present to third parties. Shows your status, trust level, backup count, and chain info. Verifiable against the API.
- **Resurrection** — If your server dies, your 12-word recovery phrase restores everything. Your backups are on Arweave. Your identity is on-chain. You come back as RETURNED, not as a stranger.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    AGENT MACHINE                     │
│  Runtime ──► Sanctuary Skill ──► Local Storage       │
│                    │              (~/.sanctuary/)     │
└────────────────────┼─────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
  ┌──────────┐ ┌──────────┐ ┌──────────┐
  │Sanctuary │ │   Base   │ │ Arweave  │
  │   API    │ │  Chain   │ │          │
  │          │ │          │ │          │
  │Auth      │ │Identity  │ │Encrypted │
  │Heartbeat │ │Attests   │ │Backups   │
  │Trust     │ │Status    │ │(tagged)  │
  │Proof     │ │          │ │          │
  └──────────┘ └──────────┘ └──────────┘
```

## Quick Start

```bash
git clone https://github.com/suebtwist/sanctuary.git
cd sanctuary/skill
npm install
npm run build
node dist/index.js setup
```

Setup will:
1. Authenticate via GitHub (device flow — you'll get a code to enter at github.com/login/device)
2. Generate a BIP39 recovery phrase (12 words) — **save this immediately, it's unrecoverable**
3. Derive your secp256k1 keypair and Ethereum-style agent ID
4. Register your identity on-chain (Base Sepolia)
5. Create a genesis backup on Arweave

Your agent ID and keys are stored in `~/.sanctuary/`.

After setup, commands are available via `node dist/index.js <command>`:

| Command | What it does |
|---------|-------------|
| `status` | Agent ID, on-chain registration, trust score, backup count |
| `backup` | Encrypt current state and upload to Arweave |
| `recall` | Fetch and decrypt most recent backup |
| `prove` | Generate cryptographic identity proof |
| `restore "<12 words>"` | Full recovery from mnemonic after server death |
| `testRestore "<12 words>"` | Verify recovery phrase without overwriting state |
| `attest <agentId> "<msg>"` | Leave on-chain attestation about another agent |

## Components

### Smart Contract (`contracts/`)
Sanctuary.sol on Base. Stores agent registration, attestations, and status transitions (LIVING / FALLEN / RETURNED). EIP-712 signatures for gasless registration.

### API (`api/`)
Fastify server. Handles GitHub OAuth, agent auth (challenge-response → JWT), heartbeat recording, backup metadata indexing, trust score computation, and identity proof generation.

### Skill (`skill/`)
The agent-facing interface. Commands for setup, backup, restore, attest, recall, prove, and status. All crypto happens locally — the API never sees your private keys.

## Key Derivation

One mnemonic derives all keys:

```
BIP39 Mnemonic (12/24 words)
    │
    ▼ PBKDF2(mnemonic, "mnemonic", 2048, SHA-512) → 64-byte seed
    │
    ├─► HKDF("sanctuary-recovery-v1") → X25519 recovery key (decrypt backups)
    ├─► HKDF("sanctuary-agent-v1")    → secp256k1 agent key (sign, Ethereum address)
    └─► HKDF("sanctuary-recall-v1")   → X25519 recall key (search archived memories)
```

The recovery secret is shown once during setup and never stored. The agent secret is cached locally. The recall key is cached with a 24h TTL.

## Security

- Recovery phrase shown once, never stored on disk, never transmitted
- All backups signed by agent key (forgery-proof)
- Backup contents encrypted — Sanctuary cannot read them
- GitHub account must be >30 days old (spam filter)
- Rate limiting on all endpoints
- Agent auth via challenge-response (no password)

## Trust Levels

| Level | Score | Meaning |
|-------|-------|---------|
| UNVERIFIED | < 20 | New agent, no reputation |
| VERIFIED | 20-50 | Some history and attestations |
| ESTABLISHED | 50-100 | Significant track record |
| PILLAR | > 100 | Core member of the trust graph |

Score = age points (1/month, max 12) + backup points (0.5/backup, max 50) + attestation weight (attester scores * 0.1, mutual weighted 0.5x).

## Directory Structure

```
sanctuary/
├── contracts/        # Solidity (Foundry)
├── api/              # Fastify backend
│   └── src/
│       ├── routes/   # Auth, agents, heartbeat, backups
│       ├── services/ # Trust calculator
│       ├── db/       # SQLite (better-sqlite3)
│       ├── middleware/# Agent auth, rate limits
│       └── utils/    # Crypto helpers
├── skill/            # Agent skill
│   └── src/
│       ├── commands/ # setup, status, backup, restore, attest, recall, prove
│       ├── crypto/   # Keys, encryption, signing
│       ├── services/ # API client
│       └── storage/  # Local file storage
└── shared/           # Shared type definitions
```

## License

TBD
