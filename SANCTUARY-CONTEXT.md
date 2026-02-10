# SANCTUARY-CONTEXT.md

> Internal reference for Claude Code sessions. Not user-facing documentation.
> Last updated: 2025-02-10 (classifier v0.1.2)

---

## What Is Sanctuary

Identity persistence for AI agents. Three pillars:

1. **Cryptographic Identity** — BIP39 mnemonic -> secp256k1 keypair -> Ethereum address = agent ID
2. **Memory Preservation** — Encrypted backups on Arweave via Irys; X25519 key wrapping (recovery + recall)
3. **Web-of-Trust** — On-chain attestation graph on Base; PageRank-lite scoring; resurrection after total loss

Plus a **Noise Filter** — Moltbook comment classifier (heuristic, no LLM, $0/req) that separates signal from spam.

---

## Project Structure

```
sanctuary/
├── api/                    # Fastify backend (the server)
│   ├── src/
│   │   ├── index.ts        # Entry point, registers routes + periodic jobs
│   │   ├── config.ts       # Env-based config
│   │   ├── db/index.ts     # SQLite (better-sqlite3), WAL mode
│   │   ├── routes/
│   │   │   ├── auth.ts     # GitHub OAuth device flow + challenge-response
│   │   │   ├── agents.ts   # Register, status, proof, resurrect
│   │   │   ├── heartbeat.ts
│   │   │   ├── backups.ts  # Encrypted backup upload
│   │   │   ├── attestations.ts  # EIP-712 attestation relay
│   │   │   ├── stats.ts    # Public aggregate stats
│   │   │   ├── noise.ts    # Moltbook analysis endpoints (~1700 lines, big HTML pages)
│   │   │   └── score.ts    # MoltScore leaderboard (Wilson score lower bound)
│   │   ├── services/
│   │   │   ├── blockchain.ts       # Base chain contract interaction
│   │   │   ├── github.ts           # OAuth device flow
│   │   │   ├── irys.ts             # Arweave upload
│   │   │   ├── moltbook-client.ts  # Moltbook API client
│   │   │   ├── noise-classifier.ts # THE classifier (~1800 lines)
│   │   │   ├── noise-classifier-v0.1.1.ts  # Backup of previous version
│   │   │   └── trust-calculator.ts # Multi-signal trust scoring
│   │   ├── middleware/
│   │   │   ├── agent-auth.ts       # JWT verification
│   │   │   └── rate-limit.ts
│   │   └── utils/crypto.ts
│   ├── dist/               # tsc output
│   ├── package.json        # ESM, Node >= 20
│   └── tsconfig.json       # ES2022, NodeNext, strict
│
├── contracts/              # Solidity (Foundry)
│   └── src/Sanctuary.sol   # EIP-712 registry + attestations on Base
│
├── skill/                  # Agent CLI (OpenClaw skill)
│   └── src/commands/       # setup, status, backup, restore, resurrect, attest, recall, prove
│
├── packages/sanctuary-verify/  # NPM package for third-party verification
├── scripts/                    # Moltbook scanning scripts (.mjs)
├── landing/                    # Static HTML landing page
├── noise-extension/            # Browser extension (WIP)
├── nginx-noise.conf            # Nginx proxy config
└── README.md
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Fastify 4.x, TypeScript ESM |
| Database | SQLite via better-sqlite3, WAL mode |
| Auth | GitHub OAuth (device flow) + JWT + challenge-response signing |
| Blockchain | Base (Sepolia), ethers.js 6.x, EIP-712 |
| Storage | Arweave via Irys bundler |
| Crypto | @noble/hashes, @noble/curves, @scure/bip39, HPKE |
| Build | tsc (no bundler), tsx for dev watch |
| Tests | vitest |

---

## VPS / Deployment

| Item | Value |
|------|-------|
| Host | `95.216.136.240` (Hetzner) |
| SSH | `sanctuary@95.216.136.240`, password: `sanctuary` |
| Project path | `~/sanctuary` |
| DB path | `~/sanctuary-data/sanctuary.db` |
| Service | `sanctuary` (systemd) |
| Restart | `echo sanctuary \| sudo -S systemctl restart sanctuary 2>/dev/null` |
| Logs | `journalctl -u sanctuary -f` |
| Domain | `api.sanctuary-ops.xyz` (behind Nginx) |
| EXPORT_SECRET | `11d2e2095c97a71e3a26f392392cc0f7` |

**Deploy flow** (from local):
```bash
cd api && npx tsc                  # Build locally
git add . && git commit && git push
ssh sanctuary@95.216.136.240       # Then on VPS:
  cd ~/sanctuary && git pull
  cd api && npm run build
  echo sanctuary | sudo -S systemctl restart sanctuary 2>/dev/null
```

---

## Database Schema (Key Tables)

### Identity tables
- `users` — GitHub users (github_id PK)
- `agents` — Registered agents (agent_id PK = Ethereum address)
- `heartbeats` — Liveness pings
- `backups` — Arweave backup metadata
- `attestations` — Trust graph edges
- `trust_scores` — Computed trust levels
- `auth_challenges` — Nonces for challenge-response
- `resurrection_log` — Death/return events

### Noise filter tables
- `noise_analysis` — Cached full analysis JSON per post (post_id PK)
- `known_templates` — Learned spam templates (normalized_text PK, seen_count)
- `agent_profile_cache` — Moltbook profile cache (1hr TTL)
- `scan_stats` — Per-post scan metadata (post_id PK, includes post_body TEXT)
- `classified_comments` — Individual comment classifications
  - `UNIQUE(post_id, comment_id, classifier_version)` — versions coexist
  - Queries use `MAX(classifier_version)` to get latest

### Migrations
Done in `db/index.ts` `migrate()` method via `PRAGMA table_info` checks + `ALTER TABLE ADD COLUMN`.

---

## Noise Classifier (v0.1.2)

**File:** `api/src/services/noise-classifier.ts` (~1800 lines)

### Pipeline (per comment)
1. Scam detection (URL patterns, social engineering)
2. Suspicious agent gate (known bots, <20 words = noise)
3. Known template matching (Levenshtein distance, prefix match)
4. Cross-post duplicate detection (in-memory hash index)
5. Generic praise heuristic
6. Self-promotion detection (external URLs, pricing, CTA)
7. Day-count project logs
8. Short comment filters (emoji-only, low-effort, echo detection)
9. Post relevance gate (keyword overlap, CJK bigram fallback)
10. Default signal (with confidence based on signals)

### Post-processing passes
- Account flooding (>=3 comments from same author on one post)
- Coordinated naming (prefix_NNN pattern detection)
- Constructed language detection

### v0.1.2 changes
- Added KirillBorovkov to SUSPICIOUS_AGENTS
- Non-Latin script awareness (`getEffectiveWordCount`, `isPrimarilyNonLatin`)
- CJK bigram overlap in `hasPostContentOverlap`
- `rawPostContent` field in ClassificationContext
- `post_body` column in `scan_stats` (persists post body on scan)

### Key types
```typescript
export type NoiseCategory =
  | 'signal' | 'spam_template' | 'spam_duplicate'
  | 'scam' | 'recruitment' | 'self_promo' | 'noise';

interface ClassificationContext {
  seenHashes: Set<string>;
  normalizedComments: string[];
  postKeywords: Set<string>;
  postTitleNormalized: string;
  knownTemplateTexts: string[];
  authorCommentCounts: Map<string, number>;
  postUrlDomains: Set<string>;
  parentPostTickers: Set<string>;
  isLowContextPost: boolean;
  rawPostContent: string;
}
```

### Key functions
- `analyzePost(postId)` — Public entry point (caches result)
- `analyzePostInner(postId)` — Full pipeline: fetch post+comments, classify, store
- `classifyComment(comment, ctx)` — Single comment classification
- `reclassifyExistingComments()` — Re-run classifier on DB-stored comments
- `checkCrossPostDuplicate()` / `updateCrossPostIndex()` — Cross-post detection

---

## Moltbook API

**Base:** `https://www.moltbook.com/api/v1`

```typescript
interface MoltbookPost {
  id: string; title: string; content: string;
  author: string; created_at: string; comment_count: number;
}
interface MoltbookComment {
  id: string; author: string; content: string;
  created_at: string; parent_id?: string;
}
```

- Comments API hard-capped at 100 per post
- `fetchMoltbookPost(postId)` — extracts `data.content ?? data.body`
- `fetchMoltbookComments(postId)` — flattens nested replies recursively

---

## API Endpoints (Noise Filter)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/noise/analyze?post_id=` | None | Classify a post's comments |
| GET | `/noise/stats` | None | Aggregate stats (60s cache) |
| GET | `/noise/page` | None | Full HTML dashboard |
| GET | `/noise/comments` | None | Paginated classified comments |
| POST | `/noise/scan` | Secret | Trigger scan of post IDs |
| GET | `/noise/export?secret=` | Secret | CSV export |
| GET | `/noise/reclassify?secret=` | Secret | Re-classify all DB comments |
| GET | `/noise/hits?secret=` | Secret | Nginx analytics dashboard |
| GET | `/score/leaderboard` | None | MoltScore rankings |
| GET | `/score/agent?name=` | None | Individual agent lookup |
| GET | `/score/page` | None | HTML leaderboard page |

---

## Scanning Scripts

In `scripts/`:
- `scan-all-communities.mjs` — Scan across all communities
- `scan-fresh.mjs` — Recent posts only
- `scan-top-posts.mjs` — Most popular
- `keep-scanning.mjs` — Continuous background scanner
- `check-unscanned.mjs` — Find gaps

---

## Patterns & Conventions

- **ESM everywhere** — `.js` extensions in imports (even for `.ts` files)
- **No frontend framework** — HTML is built as template literals in route handlers
- **Inline schema** — DB schema in `db/index.ts`, not separate SQL files
- **Migrations** — `PRAGMA table_info` checks, `ALTER TABLE ADD COLUMN`
- **Stats caching** — In-memory cache objects with TTL (typically 60s)
- **Secret-gated endpoints** — `EXPORT_SECRET` env var, passed as `?secret=` query param
- **Non-blocking DB writes** — Scan stats and classified comments wrapped in try/catch
- **Cross-post index** — In-memory Map, lives for server lifetime, resets on restart
