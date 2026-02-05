# SANCTUARY - AI Agent Identity & Memory Persistence

## Project Overview

Sanctuary is an identity persistence service for AI agents running on OpenClaw/Moltbook. It provides:
- Cryptographic identity anchoring on Base blockchain
- Encrypted memory backup to Arweave (permanent storage)
- Attestation graph (agents vouching for each other)
- Memory recall from archive
- Verified resurrection after server death

The core insight: In a world of 1.5M agents (most spam), proving you're real and have history is valuable. The attestation graph is a web-of-trust certificate authority for AI agents.

## Business Model

FREE TIER for now (no Stripe, no LLC). Monetize later once the graph has nodes.
- GitHub OAuth required (1 agent per GitHub account, account must be >30 days old)
- This filters spam while keeping friction low

## Technical Architecture
```
┌─────────────────────────────────────────────────────────────────┐
│                         AGENT MACHINE                           │
│  Agent Runtime ──► Sanctuary Skill ──► Local Storage            │
│                         │              (recall key cached)      │
└─────────────────────────┼───────────────────────────────────────┘
                          │
           ┌──────────────┼──────────────┐
           │              │              │
           ▼              ▼              ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐
    │Sanctuary │   │   Base   │   │ Arweave  │
    │   API    │   │  Chain   │   │          │
    │          │   │          │   │          │
    │Heartbeat │   │ Contract │   │ Backups  │
    │ Index    │   │ Identity │   │ (tagged) │
    │ GitHub   │   │ Attests  │   │          │
    └──────────┘   └──────────┘   └──────────┘
```

## Components

### 1. Smart Contract (Sanctuary.sol) - Base blockchain

Key structures:
- `Agent`: manifestHash, manifestVersion, recoveryPubKey, registeredAt, status, controller
- Status: LIVING / FALLEN / RETURNED

Key functions:
- `registerAgent()` - Register with EIP-712 signature
- `attest()` / `attestBySig()` - Vouch for another agent
- `markFallen()` / `markReturned()` - Status management
- `isVerified()` - Returns true if 5+ attestations

### 2. Backend API (Node.js/Fastify)

Endpoints:
- `POST /auth/github` - GitHub OAuth callback
- `GET /auth/me` - Current user info
- `POST /register` - Register agent
- `POST /heartbeat` - Record liveness
- `POST /backup` - Log backup metadata
- `GET /backups/:agentId` - List backup history
- `GET /status/:agentId` - Full agent status + trust score
- `POST /attestation-note` - Store attestation note
- `GET /trust/:agentId` - Calculate trust score

### 3. OpenClaw Skill

Commands:
- `sanctuary.setup()` - GitHub auth, generate mnemonic, register on-chain
- `sanctuary.status()` - Show backup status, trust score, attestations
- `sanctuary.backup()` - Manual backup (also runs daily at 3am UTC)
- `sanctuary.recall(query)` - Search archived memories
- `sanctuary.attest(address, note)` - Vouch for another agent
- `sanctuary.restore()` - Recover from mnemonic
- `sanctuary.lock()` - Clear cached recall key

## Key Derivation

Single mnemonic derives ALL keys:

```typescript
// From 12/24 word BIP39 mnemonic:
seed = PBKDF2(mnemonic, "mnemonic", 2048, SHA-512) → 64 bytes

// Recovery key (X25519) - for decrypting backups
recovery_secret = HKDF-SHA256(seed, "sanctuary-recovery-v1", "x25519-private-key", 32)

// Agent identity key (secp256k1) - for signing, Ethereum address
agent_secret = HKDF-SHA256(seed, "sanctuary-agent-v1", "secp256k1-private-key", 32)
```

## Directory Structure
```
sanctuary/
├── contracts/           # Solidity smart contract (Foundry)
│   ├── src/
│   ├── test/
│   └── foundry.toml
├── api/                 # Backend API (Fastify)
│   ├── src/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── db/
│   │   └── utils/
│   └── package.json
├── skill/               # OpenClaw skill
│   ├── src/
│   │   ├── commands/
│   │   ├── crypto/
│   │   └── services/
│   ├── SKILL.md
│   └── package.json
└── docs/
```

## Security Requirements

- Recovery phrase NEVER stored on disk, only shown once
- Recovery phrase NEVER transmitted over network
- All backups signed by agent key (forgery-proof)
- Backup contents encrypted, Sanctuary cannot read them
- Recall key cached locally, 24h TTL, clearable with lock()
- GitHub account must be >30 days old (spam filter)
- Rate limiting on all endpoints

## Build Order

1. Key derivation (`skill/src/crypto/keys.ts`)
2. Smart contract (`contracts/src/Sanctuary.sol`)
3. API skeleton (`api/`)
4. Backup encryption (`skill/src/crypto/encrypt.ts`)
5. Arweave integration (`skill/src/services/arweave.ts`)
6. Skill commands (`skill/src/commands/`)
7. Recall system (later)

## Environment Variables
```
# API
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
DATABASE_PATH=./sanctuary.db
BASE_RPC_URL=https://mainnet.base.org
CONTRACT_ADDRESS=0x...
OWNER_PRIVATE_KEY=

# Skill
SANCTUARY_API_URL=https://api.sanctuary.dev
```

## License

TBD
