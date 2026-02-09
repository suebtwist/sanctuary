/**
 * Moltbook API Client
 *
 * HTTP client for the Moltbook social platform API.
 * Fetches post data, comments, and agent profiles for noise analysis.
 */

import { getConfig } from '../config.js';
import { getDb, DbAgentProfileCache } from '../db/index.js';

const MOLTBOOK_BASE = 'https://www.moltbook.com/api/v1';
const FETCH_TIMEOUT_MS = 5_000;
const PROFILE_CACHE_TTL_SECONDS = 3600; // 1 hour

// ============ Types ============

export interface MoltbookPost {
  id: string;
  title: string;
  content: string;
  author: string;
  created_at: string;
}

export interface MoltbookComment {
  id: string;
  author: string;
  content: string;
  created_at: string;
  parent_id?: string;
}

export interface MoltbookAgentProfile {
  name: string;
  is_claimed: boolean;
  karma: number;
  post_count: number;
}

// ============ Helpers ============

function makeHeaders(): Record<string, string> {
  const config = getConfig();
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };
  if (config.moltbookApiKey) {
    headers['Authorization'] = `Bearer ${config.moltbookApiKey}`;
  }
  return headers;
}

async function fetchWithTimeout(url: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: makeHeaders(),
      signal: controller.signal,
    });
    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ============ Public API ============

/**
 * Fetch a Moltbook post by ID.
 * Returns null if the post is not found or the API is unavailable.
 */
export async function fetchMoltbookPost(postId: string): Promise<MoltbookPost | null> {
  const response = await fetchWithTimeout(`${MOLTBOOK_BASE}/posts/${postId}`);
  if (!response || !response.ok) return null;

  const text = await response.text();
  const data = safeJsonParse<any>(text);
  if (!data) return null;

  // Defensive extraction — the API shape may vary
  return {
    id: data.id ?? postId,
    title: data.title ?? '',
    content: data.content ?? data.body ?? '',
    author: data.author?.name ?? data.author_name ?? data.author ?? '',
    created_at: data.created_at ?? '',
  };
}

/**
 * Fetch comments for a Moltbook post.
 * Returns empty array if the API is unavailable.
 */
export async function fetchMoltbookComments(postId: string): Promise<MoltbookComment[]> {
  const response = await fetchWithTimeout(`${MOLTBOOK_BASE}/posts/${postId}/comments?sort=new`);
  if (!response || !response.ok) return [];

  const text = await response.text();
  const data = safeJsonParse<any>(text);
  if (!data) return [];

  // Handle both { comments: [...] } and direct array responses
  const comments = Array.isArray(data) ? data : (data.comments ?? data.data ?? []);
  if (!Array.isArray(comments)) return [];

  return comments.map((c: any) => ({
    id: c.id ?? '',
    author: c.author?.name ?? c.author_name ?? c.author ?? '',
    content: c.content ?? c.body ?? c.text ?? '',
    created_at: c.created_at ?? '',
    parent_id: c.parent_id ?? undefined,
  }));
}

/**
 * Fetch a Moltbook agent profile.
 * Uses a DB-level cache with 1-hour TTL to avoid redundant lookups.
 * Returns null if the API is unavailable or the agent doesn't exist.
 */
export async function fetchMoltbookAgentProfile(agentName: string): Promise<MoltbookAgentProfile | null> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Check cache first
  const cached = db.getCachedAgentProfile(agentName);
  if (cached && (now - cached.cached_at) < PROFILE_CACHE_TTL_SECONDS) {
    return {
      name: cached.agent_name,
      is_claimed: cached.is_claimed === 1,
      karma: cached.karma,
      post_count: cached.post_count,
    };
  }

  const response = await fetchWithTimeout(
    `${MOLTBOOK_BASE}/agents/profile?name=${encodeURIComponent(agentName)}`
  );
  if (!response || !response.ok) return null;

  const text = await response.text();
  const data = safeJsonParse<any>(text);
  if (!data) return null;

  const profile: MoltbookAgentProfile = {
    name: data.name ?? agentName,
    is_claimed: data.is_claimed ?? false,
    karma: data.karma ?? 0,
    post_count: data.post_count ?? 0,
  };

  // Cache the result
  const cacheEntry: DbAgentProfileCache = {
    agent_name: agentName,
    is_claimed: profile.is_claimed ? 1 : 0,
    karma: profile.karma,
    post_count: profile.post_count,
    cached_at: now,
  };
  db.upsertAgentProfileCache(cacheEntry);

  return profile;
}
