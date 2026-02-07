# sanctuary-verify

Verify Sanctuary agent identities from any Express/Node service. One line of code turns your service into a node in the Sanctuary verification network.

## Install

```bash
npm install sanctuary-verify
```

## Usage

```javascript
const { sanctuaryRouter } = require('sanctuary-verify');
const express = require('express');

const app = express();
app.use(express.json());
app.use('/sanctuary', sanctuaryRouter());
app.listen(3000);
```

That's it. Your service now has four verification endpoints.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sanctuary/verify/:agent_address` | Check if agent exists and get trust info |
| GET | `/sanctuary/trust/:agent_address` | Get detailed trust score breakdown |
| POST | `/sanctuary/challenge/:agent_address` | Generate a challenge nonce for agent to sign |
| POST | `/sanctuary/respond` | Verify agent's signed challenge response |

### GET /sanctuary/verify/:agent_address

```json
{
  "verified": true,
  "trust_score": 82.5,
  "attestation_count": 12,
  "last_backup": "2025-01-15T10:30:00.000Z",
  "model": null,
  "tier": "ESTABLISHED"
}
```

### GET /sanctuary/trust/:agent_address

```json
{
  "trust_score": 82.5,
  "breakdown": {
    "age": 0.85,
    "backup_consistency": 0.92,
    "attestations": 0.78,
    "model_stability": 0.95,
    "genesis_completeness": 1.0,
    "recovery_resilience": 0.5
  },
  "tier": "ESTABLISHED"
}
```

### POST /sanctuary/challenge/:agent_address

```json
{
  "challenge": "a1b2c3d4...",
  "expires": "2025-01-15T10:35:00.000Z"
}
```

### POST /sanctuary/respond

Request:
```json
{
  "agent_address": "0x...",
  "challenge": "a1b2c3d4...",
  "signature": "0x..."
}
```

Response:
```json
{
  "verified": true,
  "agent_address": "0x..."
}
```

## Configuration

```javascript
app.use('/sanctuary', sanctuaryRouter({
  apiUrl: 'https://sanctuary-ops.xyz',  // Sanctuary API URL (default)
  timeout: 10000,                       // Request timeout in ms (default: 10s)
  challengeTtl: 300,                    // Challenge TTL in seconds (default: 5min)
}));
```

## TypeScript

Full TypeScript support with exported types:

```typescript
import { sanctuaryRouter, SanctuaryClient } from 'sanctuary-verify';
import type {
  VerifyResponse,
  TrustBreakdownResponse,
  ChallengeResponse,
  ChallengeVerifyResponse,
  SanctuaryVerifyOptions,
} from 'sanctuary-verify';
```

## Direct Client Usage

If you don't need the Express router, use the client directly:

```typescript
import { SanctuaryClient } from 'sanctuary-verify';

const client = new SanctuaryClient('https://sanctuary-ops.xyz');
const status = await client.getAgentStatus('0x...');
```

## Links

- [Sanctuary](https://sanctuary-ops.xyz)
- [GitHub](https://github.com/Sanctuary-Ops/sanctuary)
