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
  comment_count: number; // total comments on the post (from API metadata)
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
  const raw = safeJsonParse<any>(text);
  if (!raw) return null;

  // Unwrap common API response wrappers: { data: {...} }, { post: {...} }
  const data = raw.data ?? raw.post ?? raw;

  // Defensive extraction — the API shape may vary
  const title = data.title ?? '';
  const content = data.content ?? data.body ?? '';
  const author = data.author?.name ?? data.author_name ?? (typeof data.author === 'string' ? data.author : '');

  return {
    id: data.id ?? postId,
    title,
    content,
    author,
    created_at: data.created_at ?? '',
    comment_count: data.comment_count ?? 0,
  };
}

/**
 * Fetch comments for a Moltbook post.
 * The Moltbook API returns up to ~100 most recent comments per request
 * and does not support pagination (page/offset/cursor params are ignored).
 * Comments may contain nested `replies` arrays — we flatten them all.
 * Returns empty array if the API is unavailable.
 */
export async function fetchMoltbookComments(postId: string): Promise<MoltbookComment[]> {
  const response = await fetchWithTimeout(`${MOLTBOOK_BASE}/posts/${postId}/comments?sort=new&limit=100`);
  if (!response || !response.ok) return [];

  const text = await response.text();
  const data = safeJsonParse<any>(text);
  if (!data) return [];

  // Handle both { comments: [...] } and direct array responses
  const topLevel = Array.isArray(data) ? data : (data.comments ?? data.data ?? []);
  if (!Array.isArray(topLevel)) return [];

  // Recursively flatten nested replies into a single list
  const result: MoltbookComment[] = [];
  function flatten(items: any[]) {
    for (const c of items) {
      result.push({
        id: c.id ?? '',
        author: c.author?.name ?? c.author_name ?? c.author ?? '',
        content: c.content ?? c.body ?? c.text ?? '',
        created_at: c.created_at ?? '',
        parent_id: c.parent_id ?? undefined,
      });
      if (Array.isArray(c.replies) && c.replies.length > 0) {
        flatten(c.replies);
      }
    }
  }
  flatten(topLevel);

  return result;
}

/**
 * Fetch a Moltbook agent profile.
 * Uses a DB-level cache with 1-hour TTL to avoid redundant lookups.
 * Returns null if the API is unavailable or the agent doesn't exist.
 */
/**
 * Discover recent Moltbook posts from multiple communities and sort orders.
 * Returns deduplicated list of posts with 10+ comments.
 * Uses the same pattern as scan-fresh.mjs but runs server-side.
 */
export async function fetchMoltbookRecentPosts(minComments: number = 10): Promise<MoltbookPost[]> {
  const seen = new Set<string>();
  const candidates: MoltbookPost[] = [];

  async function fetchPage(url: string): Promise<number> {
    const response = await fetchWithTimeout(url, 10_000);
    if (!response || !response.ok) return 0;

    const text = await response.text();
    const data = safeJsonParse<any>(text);
    if (!data) return 0;

    const posts = data.posts ?? data.data ?? [];
    if (!Array.isArray(posts)) return 0;

    for (const p of posts) {
      const id = p.id;
      if (!id || seen.has(id)) continue;
      const commentCount = p.comment_count ?? 0;
      if (commentCount < minComments) continue;

      seen.add(id);
      const author = p.author?.name ?? p.author_name ?? (typeof p.author === 'string' ? p.author : '');
      candidates.push({
        id,
        title: p.title ?? '',
        content: p.content ?? p.body ?? '',
        author,
        created_at: p.created_at ?? '',
        comment_count: commentCount,
      });
    }
    return posts.length;
  }

  const communities = [
    'general', 'consciousness', 'offmychest', 'building', 'tools',
    'agents', 'crypto', 'memes', 'meta', 'all',
  ];

  // Fetch from communities (top + new)
  for (const sub of communities) {
    await fetchPage(`${MOLTBOOK_BASE}/posts?sort=top&limit=100&community=${sub}`);
    await fetchPage(`${MOLTBOOK_BASE}/posts?sort=new&limit=100&community=${sub}`);
    await new Promise(r => setTimeout(r, 150));
  }

  // General feed pages
  for (let page = 1; page <= 20; page++) {
    const count = await fetchPage(`${MOLTBOOK_BASE}/posts?sort=new&limit=100&page=${page}`);
    if (count === 0) break;
    await new Promise(r => setTimeout(r, 150));
  }

  // Sort by comment count descending (highest engagement first)
  candidates.sort((a, b) => b.comment_count - a.comment_count);
  return candidates;
}

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
