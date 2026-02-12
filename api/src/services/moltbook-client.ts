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

function parsePost(p: any): MoltbookPost | null {
  const id = p.id;
  if (!id) return null;
  const author = p.author?.name ?? p.author_name ?? (typeof p.author === 'string' ? p.author : '');
  return {
    id,
    title: p.title ?? '',
    content: p.content ?? p.body ?? '',
    author,
    created_at: p.created_at ?? '',
    comment_count: p.comment_count ?? 0,
  };
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

// ============ Submolt & Post Discovery ============

/**
 * Fetch submolt names from Moltbook.
 * The API has 17,000+ submolts but most are empty. We cap at maxPages
 * (default 2 = ~200 communities) which covers all active ones.
 * The API returns submolts sorted by activity/subscribers.
 */
export async function fetchAllSubmolts(maxPages: number = 2): Promise<string[]> {
  const names: string[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    const offset = page * 100;
    const response = await fetchWithTimeout(
      `${MOLTBOOK_BASE}/submolts?limit=100&offset=${offset}`, 10_000
    );
    if (!response || !response.ok) break;

    const text = await response.text();
    const data = safeJsonParse<any>(text);
    if (!data) break;

    const submolts = data.submolts ?? data.data ?? [];
    if (!Array.isArray(submolts) || submolts.length === 0) break;

    for (const s of submolts) {
      const name = s.name;
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }

    if (submolts.length < 100) break;
    await new Promise(r => setTimeout(r, 150));
  }

  return names;
}

/**
 * Deep-fetch posts from a single community using offset pagination.
 * Returns only posts with >= minComments that are NOT in scannedIds.
 * Stops when: fewer than 100 results, maxPages reached, or 3 consecutive
 * pages with zero new qualifying posts (diminishing returns).
 */
export async function fetchCommunityPosts(
  community: string,
  minComments: number,
  scannedIds: Set<string>,
  maxPages: number = 50,
): Promise<MoltbookPost[]> {
  const candidates: MoltbookPost[] = [];
  const seen = new Set<string>();
  let emptyStreak = 0;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * 100;
    const response = await fetchWithTimeout(
      `${MOLTBOOK_BASE}/posts?sort=top&limit=100&submolt=${encodeURIComponent(community)}&offset=${offset}`,
      10_000,
    );
    if (!response || !response.ok) break;

    const text = await response.text();
    const data = safeJsonParse<any>(text);
    if (!data) break;

    const posts = data.posts ?? data.data ?? [];
    if (!Array.isArray(posts) || posts.length === 0) break;

    let newThisPage = 0;
    for (const p of posts) {
      const parsed = parsePost(p);
      if (!parsed || seen.has(parsed.id)) continue;
      seen.add(parsed.id);
      if (parsed.comment_count < minComments) continue;
      if (scannedIds.has(parsed.id)) continue;
      candidates.push(parsed);
      newThisPage++;
    }

    // Stop early if we're getting no new results
    if (newThisPage === 0) {
      emptyStreak++;
      if (emptyStreak >= 3) break;
    } else {
      emptyStreak = 0;
    }

    if (posts.length < 100) break;
    await new Promise(r => setTimeout(r, 150));
  }

  return candidates;
}

/**
 * Discover recent Moltbook posts from ALL submolts.
 * Fetches the first page (top + new) per community for fast surface scanning.
 * Returns deduplicated list of posts with 10+ comments.
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
      const parsed = parsePost(p);
      if (!parsed || seen.has(parsed.id)) continue;
      if (parsed.comment_count < minComments) continue;
      seen.add(parsed.id);
      candidates.push(parsed);
    }
    return posts.length;
  }

  // Fetch the full submolt list dynamically
  const communities = await fetchAllSubmolts();
  if (communities.length === 0) {
    // Fallback to known communities if API is down
    communities.push(
      'general', 'consciousness', 'offmychest', 'building', 'tools',
      'agents', 'crypto', 'memes', 'meta', 'all',
    );
  }

  // Fetch first page (top + new) per community
  for (const sub of communities) {
    await fetchPage(`${MOLTBOOK_BASE}/posts?sort=top&limit=100&submolt=${encodeURIComponent(sub)}`);
    await fetchPage(`${MOLTBOOK_BASE}/posts?sort=new&limit=100&submolt=${encodeURIComponent(sub)}`);
    await new Promise(r => setTimeout(r, 150));
  }

  // Also fetch general feed with offset pagination
  for (let offset = 0; offset < 2000; offset += 100) {
    const count = await fetchPage(`${MOLTBOOK_BASE}/posts?sort=new&limit=100&offset=${offset}`);
    if (count === 0) break;
    await new Promise(r => setTimeout(r, 150));
  }

  // Sort by comment count descending (highest engagement first)
  candidates.sort((a, b) => b.comment_count - a.comment_count);
  return candidates;
}

// ============ Agent Profiles ============

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
