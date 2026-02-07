/**
 * Sanctuary API Client
 *
 * Client for interacting with the Sanctuary backend API
 */

import { signAuthChallenge, signHeartbeat } from '../crypto/sign.js';

export interface ApiConfig {
  baseUrl: string;
  timeout?: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubAuthResponse {
  token: string;
  user: {
    github_id: string;
    github_username: string;
    github_created_at: string;
  };
  has_agent: boolean;
  agent_id?: string;
}

export interface AgentAuthResponse {
  token: string;
  expires_in: number;
}

export interface AgentInfo {
  agent_id: string;
  github_username?: string;
  recovery_pubkey: string;
  manifest_hash: string;
  manifest_version: number;
  registered_at: number;
  status: string;
}

export interface AgentStatus {
  agent: AgentInfo;
  trust: {
    score: number;
    level: string;
    unique_attesters: number;
    computed_at: number | null;
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

export interface BackupUploadResponse {
  backup_id: string;
  backup_seq: number;
  arweave_tx_id: string;
  size_bytes: number;
  received_at: number;
}

export interface ProofResponse {
  agent_id: string;
  status: string;
  trust_score: number;
  trust_level: string;
  backup_count: number;
  last_heartbeat: number | null;
  registered_at: number;
  chain_id: number;
  contract_address: string;
  issued_at: number;
  proof_hash: string;
  server_signature: string;
  verify_url: string;
}

export interface ResurrectionManifest {
  identity: {
    address: string;
    github_username?: string;
    trust_score: number;
    trust_level: string;
    attestation_count: number;
    registered_at: number;
    last_backup: number | null;
    last_heartbeat: number | null;
    total_snapshots: number;
    resurrection_count: number;
  };
  snapshots: Array<{
    backup_id: string;
    backup_seq: number;
    timestamp: number;
    arweave_tx_id: string;
    size_bytes: number;
    manifest_hash: string;
    snapshot_meta?: {
      model?: string;
      platform?: string;
      genesis?: boolean;
      genesis_declaration?: string;
      session_number?: number;
    };
  }>;
  genesis_declaration: string | null;
  status: string;
  previous_status: string;
}

/**
 * Sanctuary API Client
 */
export class SanctuaryApi {
  private baseUrl: string;
  private timeout: number;
  private token: string | null = null;

  constructor(config: ApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeout = config.timeout || 30000;
  }

  /**
   * Set the auth token for subsequent requests
   */
  setToken(token: string): void {
    this.token = token;
  }

  /**
   * Clear the auth token
   */
  clearToken(): void {
    this.token = null;
  }

  /**
   * Make an API request
   */
  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      auth?: boolean;
    } = {}
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (options.auth !== false && this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data = await response.json();
      return data as ApiResponse<T>;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: 'Request timeout' };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ============ GitHub Auth ============

  /**
   * Start GitHub device flow authentication
   */
  async startDeviceFlow(): Promise<ApiResponse<DeviceFlowResponse>> {
    return this.request<DeviceFlowResponse>('POST', '/auth/github/device', {
      auth: false,
    });
  }

  /**
   * Poll for device flow completion
   */
  async pollDeviceFlow(deviceCode: string): Promise<ApiResponse<GitHubAuthResponse>> {
    return this.request<GitHubAuthResponse>('POST', '/auth/github/poll', {
      body: { device_code: deviceCode },
      auth: false,
    });
  }

  // ============ Agent Auth ============

  /**
   * Get auth challenge for agent signature auth
   */
  async getChallenge(agentId: string): Promise<ApiResponse<{ nonce: string; expires_at: number }>> {
    return this.request('GET', `/auth/challenge?agentId=${encodeURIComponent(agentId)}`, {
      auth: false,
    });
  }

  /**
   * Authenticate agent using signed challenge
   */
  async authenticateAgent(
    agentId: string,
    agentSecret: Uint8Array
  ): Promise<ApiResponse<AgentAuthResponse>> {
    // Get challenge
    const challengeRes = await this.getChallenge(agentId);
    if (!challengeRes.success || !challengeRes.data) {
      return { success: false, error: challengeRes.error || 'Failed to get challenge' };
    }

    const { nonce } = challengeRes.data;
    const timestamp = Math.floor(Date.now() / 1000);

    // Sign challenge
    const signature = await signAuthChallenge(agentSecret, nonce, agentId, timestamp);

    // Exchange for token
    const authRes = await this.request<AgentAuthResponse>('POST', '/auth/agent', {
      body: { agentId, nonce, timestamp, signature },
      auth: false,
    });

    if (authRes.success && authRes.data) {
      this.setToken(authRes.data.token);
    }

    return authRes;
  }

  /**
   * Get current session info
   */
  async getMe(): Promise<ApiResponse<{
    type: string;
    agent_id?: string;
    github_id?: string;
    github_username?: string;
    status?: string;
  }>> {
    return this.request('GET', '/auth/me');
  }

  // ============ Agents ============

  /**
   * Register a new agent
   */
  async registerAgent(params: {
    agentId: string;
    recoveryPubKey: string;
    manifestHash: string;
    manifestVersion: number;
    genesisDeclaration?: string;
    registrationSignature?: string;
    registrationDeadline?: number;
  }): Promise<ApiResponse<{ agent_id: string; registered_at: number; status: string }>> {
    return this.request('POST', '/agents/register', {
      body: params,
    });
  }

  /**
   * Get agent info
   */
  async getAgent(agentId: string): Promise<ApiResponse<AgentInfo>> {
    return this.request('GET', `/agents/${encodeURIComponent(agentId)}`, {
      auth: false,
    });
  }

  /**
   * Get full agent status
   */
  async getAgentStatus(agentId: string): Promise<ApiResponse<AgentStatus>> {
    return this.request('GET', `/agents/${encodeURIComponent(agentId)}/status`, {
      auth: false,
    });
  }

  /**
   * Generate server-signed identity proof
   */
  async generateProof(agentId: string): Promise<ApiResponse<ProofResponse>> {
    return this.request<ProofResponse>('POST', `/agents/${encodeURIComponent(agentId)}/proof`);
  }

  /**
   * Resurrect a fallen agent (requires auth)
   */
  async resurrectAgent(agentId: string): Promise<ApiResponse<ResurrectionManifest>> {
    return this.request<ResurrectionManifest>('POST', `/agents/${encodeURIComponent(agentId)}/resurrect`);
  }

  // ============ Heartbeat ============

  /**
   * Send heartbeat
   */
  async sendHeartbeat(
    agentId: string,
    agentSecret: Uint8Array
  ): Promise<ApiResponse<{ agent_id: string; received_at: number }>> {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signHeartbeat(agentSecret, agentId, timestamp);

    return this.request('POST', '/heartbeat', {
      body: { timestamp, signature },
    });
  }

  // ============ Backups ============

  /**
   * Upload encrypted backup
   */
  async uploadBackup(
    backupData: Uint8Array,
    headerJson: string
  ): Promise<ApiResponse<BackupUploadResponse>> {
    const url = `${this.baseUrl}/backups/upload`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-Backup-Header': Buffer.from(headerJson).toString('base64'),
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: backupData,
      });

      return response.json() as Promise<ApiResponse<BackupUploadResponse>>;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * List backups for an agent
   */
  async listBackups(
    agentId: string,
    limit = 30
  ): Promise<ApiResponse<{
    agent_id: string;
    count: number;
    backups: Array<{
      id: string;
      backup_seq: number;
      arweave_tx_id: string;
      timestamp: number;
      received_at: number;
      size_bytes: number;
      manifest_hash: string;
    }>;
  }>> {
    return this.request('GET', `/backups/${encodeURIComponent(agentId)}?limit=${limit}`);
  }

  // ============ Attestations ============

  /**
   * Relay a signed attestation meta-transaction via the API
   */
  async relayAttestation(params: {
    from: string;
    about: string;
    noteHash: string;
    deadline: number;
    signature: string;
    note?: string;
  }): Promise<ApiResponse<{
    status: string;
    from: string;
    about: string;
    note_hash: string;
  }>> {
    return this.request('POST', '/attestations/relay', {
      body: params,
    });
  }

  /**
   * Get latest backup
   */
  async getLatestBackup(agentId: string): Promise<ApiResponse<{
    id: string;
    backup_seq: number;
    arweave_tx_id: string;
    timestamp: number;
    received_at: number;
    size_bytes: number;
    manifest_hash: string;
  }>> {
    return this.request('GET', `/backups/${encodeURIComponent(agentId)}/latest`);
  }
}

/**
 * Create API client with default config
 */
export function createApiClient(baseUrl?: string): SanctuaryApi {
  return new SanctuaryApi({
    baseUrl: baseUrl || process.env.SANCTUARY_API_URL || 'http://localhost:3000',
  });
}
