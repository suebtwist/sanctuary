/**
 * Sanctuary API Client for verification
 *
 * Lightweight HTTP client that calls the Sanctuary API
 * to verify agent identities and trust scores.
 */

export interface SanctuaryAgentStatus {
  agent: {
    agent_id: string;
    github_username?: string;
    manifest_hash: string;
    manifest_version: number;
    registered_at: number;
    status: string;
  };
  trust: {
    score: number;
    level: string;
    unique_attesters: number;
    computed_at: number | null;
    breakdown?: {
      age: number;
      backup_consistency: number;
      attestations: number;
      model_stability: number;
      genesis_completeness: number;
      recovery_resilience: number;
    };
  };
  backups: {
    count: number;
    latest: {
      id: string;
      backup_seq: number;
      arweave_tx_id: string;
      timestamp: number;
      size_bytes: number;
    } | null;
  };
  heartbeat: {
    last_seen: number | null;
  };
}

export interface SanctuaryAgentInfo {
  agent_id: string;
  github_username?: string;
  recovery_pubkey: string;
  manifest_hash: string;
  manifest_version: number;
  registered_at: number;
  status: string;
}

export class SanctuaryClient {
  private baseUrl: string;
  private timeout: number;

  constructor(baseUrl: string, timeout: number = 10000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeout = timeout;
  }

  /**
   * Get full agent status including trust score and backup info
   */
  async getAgentStatus(agentAddress: string): Promise<SanctuaryAgentStatus | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(
        `${this.baseUrl}/agents/${encodeURIComponent(agentAddress)}/status`,
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);

      if (!response.ok) return null;

      const data = await response.json() as { success: boolean; data?: SanctuaryAgentStatus };
      return data.success ? (data.data ?? null) : null;
    } catch {
      return null;
    }
  }

  /**
   * Get basic agent info (public, no auth needed)
   */
  async getAgentInfo(agentAddress: string): Promise<SanctuaryAgentInfo | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(
        `${this.baseUrl}/agents/${encodeURIComponent(agentAddress)}`,
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);

      if (!response.ok) return null;

      const data = await response.json() as { success: boolean; data?: SanctuaryAgentInfo };
      return data.success ? (data.data ?? null) : null;
    } catch {
      return null;
    }
  }
}
