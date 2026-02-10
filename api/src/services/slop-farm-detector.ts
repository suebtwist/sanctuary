/**
 * Slop Farm Detector
 *
 * Detects coordinated bot networks ("slop farms") by finding agents that
 * share many identical spam comments across multiple posts.
 *
 * Detection criteria (ALL must be true):
 * 1. Shared templates — agent shares 5+ identical slop comments with others in the cluster
 * 2. Low signal rate — agent has <15% signal rate overall
 * 3. Temporal co-occurrence — agents share 3+ common posts
 */

import { getDb } from '../db/index.js';

// Throttle: minimum 30 minutes between runs
let lastRunAt = 0;
const MIN_INTERVAL_MS = 30 * 60 * 1000;
let running = false;

export interface SlopFarmResult {
  farm_count: number;
  total_agents: number;
  total_comments: number;
  duration_ms: number;
}

/**
 * Detect slop farms from classified_comments data.
 * Clears and rebuilds slop_farms / slop_farm_members tables each run.
 */
export function detectSlopFarms(): SlopFarmResult {
  const db = getDb();
  const start = Date.now();

  // Step 1: Get all slop comment texts shared by 3+ distinct authors
  const sharedComments = db.getSharedSlopComments();

  // Step 2: Build adjacency graph — count shared slop comments per author pair
  const pairCounts = new Map<string, number>(); // "agentA|agentB" -> count
  const allAgents = new Set<string>();

  for (const { authors } of sharedComments) {
    for (const a of authors) allAgents.add(a);
    // For each pair of authors sharing this comment
    for (let i = 0; i < authors.length; i++) {
      for (let j = i + 1; j < authors.length; j++) {
        const key = authors[i] < authors[j]
          ? `${authors[i]}|${authors[j]}`
          : `${authors[j]}|${authors[i]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // Step 3: Build adjacency list — only keep pairs with 5+ shared slop comments
  const adjacency = new Map<string, Set<string>>();
  for (const [key, count] of pairCounts) {
    if (count < 5) continue;
    const [a, b] = key.split('|');
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  }

  // Step 4: Find connected components (BFS)
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const agent of adjacency.keys()) {
    if (visited.has(agent)) continue;
    const component: string[] = [];
    const queue = [agent];
    visited.add(agent);
    while (queue.length > 0) {
      const curr = queue.shift()!;
      component.push(curr);
      for (const neighbor of adjacency.get(curr) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    if (component.length >= 2) {
      components.push(component);
    }
  }

  // Step 5: Filter by signal rate (<15%) and shared posts (3+)
  // Collect all unique agents across all components for batch signal rate query
  const allComponentAgents = new Set<string>();
  for (const comp of components) {
    for (const a of comp) allComponentAgents.add(a);
  }
  const signalRates = allComponentAgents.size > 0
    ? db.getAuthorSignalRates([...allComponentAgents])
    : new Map<string, number>();

  // Clear old results
  db.clearSlopFarms();

  const now = new Date().toISOString();
  let totalFarmAgents = 0;
  let totalFarmComments = 0;
  let farmCount = 0;

  for (const component of components) {
    // Filter: only keep agents with <15% signal rate
    const qualifying = component.filter(a => {
      const rate = signalRates.get(a) ?? 0;
      return rate < 0.15;
    });

    if (qualifying.length < 2) continue;

    // Filter: must share 3+ common posts
    const sharedPosts = db.getSharedPostCountForAgents(qualifying);
    if (sharedPosts < 3) continue;

    // Count shared templates between qualifying agents
    let sharedTemplateCount = 0;
    for (const [key, count] of pairCounts) {
      const [a, b] = key.split('|');
      if (qualifying.includes(a) && qualifying.includes(b)) {
        sharedTemplateCount = Math.max(sharedTemplateCount, count);
      }
    }

    const totalComments = db.getTotalCommentsForAgents(qualifying);

    // Insert farm
    const farmId = db.insertSlopFarm({
      agent_count: qualifying.length,
      shared_templates: sharedTemplateCount,
      shared_posts: sharedPosts,
      total_comments: totalComments,
      agent_names: JSON.stringify(qualifying),
      detected_at: now,
    });

    // Insert members
    for (const agent of qualifying) {
      db.insertSlopFarmMember(farmId, agent);
    }

    totalFarmAgents += qualifying.length;
    totalFarmComments += totalComments;
    farmCount++;
  }

  const duration = Date.now() - start;
  console.log(`[slop-farms] Detected ${farmCount} farms with ${totalFarmAgents} agents in ${duration}ms`);

  return {
    farm_count: farmCount,
    total_agents: totalFarmAgents,
    total_comments: totalFarmComments,
    duration_ms: duration,
  };
}

/**
 * Run slop farm detection in the background, throttled to once per 30 minutes.
 * Safe to call after every scan — will no-op if too soon or already running.
 */
export function maybeDetectSlopFarms(): void {
  const now = Date.now();
  if (running || (now - lastRunAt) < MIN_INTERVAL_MS) return;

  running = true;
  // Run on next tick to not block the current request
  setImmediate(() => {
    try {
      detectSlopFarms();
      lastRunAt = Date.now();
    } catch (e) {
      console.error('[slop-farms] Detection failed:', e);
    } finally {
      running = false;
    }
  });
}
