/**
 * sanctuary-verify
 *
 * Verify Sanctuary agent identities from any Express/Node service.
 */

export { sanctuaryRouter } from './middleware.js';
export { SanctuaryClient } from './client.js';
export type {
  VerifyResponse,
  TrustBreakdownResponse,
  ChallengeResponse,
  ChallengeVerifyResponse,
  SanctuaryVerifyOptions,
  ErrorResponse,
} from './types.js';
