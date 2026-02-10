/**
 * Noise Filter Routes
 *
 * Public endpoints for analyzing Moltbook post comments.
 * No authentication required.
 */

import { FastifyInstance } from 'fastify';
import { analyzePost, PostAnalysis, CLASSIFIER_VERSION, reclassifyExistingComments } from '../services/noise-classifier.js';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';
import { readFileSync, existsSync } from 'node:fs';
import { getSidebarCSS, getSidebarHTML, getSidebarJS } from './score.js';
import { maybeDetectSlopFarms, detectSlopFarms } from '../services/slop-farm-detector.js';

// ============ Stats Cache ============

interface StatsCache {
  data: NoiseStats;
  expiresAt: number;
}

interface NoiseStats {
  total_posts_analyzed: number;
  total_comments_analyzed: number;
  overall_signal_rate: number;
  avg_signal_rate: number;
  worst_signal_rate: number;
  best_signal_rate: number;
  by_classification: Record<string, number>;
  top_template_phrases: Array<{ text: string; count: number }>;
  classifier_version: string;
  last_updated: string;
  slop_farms?: {
    farm_count: number;
    total_agents: number;
    total_comments: number;
    comment_pct: number;
    top_farms: Array<{ rank: number; agent_count: number; shared_templates: number; total_comments: number }>;
  };
}

let statsCache: StatsCache | null = null;
const STATS_CACHE_TTL_MS = 60_000;

// ============ UUID validation ============

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractPostId(postId?: string, url?: string): string | null {
  if (postId && UUID_REGEX.test(postId)) {
    return postId;
  }
  if (url) {
    const match = url.match(/moltbook\.com\/post\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (match) return match[1];
  }
  // Also accept raw UUID without prior validation
  if (postId && postId.length > 8) return postId;
  return null;
}

// ============ Routes ============

export async function noiseRoutes(fastify: FastifyInstance): Promise<void> {

  /**
   * GET /noise/analyze?post_id=<uuid>&url=<moltbook-url>
   *
   * Analyze a Moltbook post for noise. Accepts either post_id or url parameter.
   */
  fastify.get<{
    Querystring: { post_id?: string; url?: string };
  }>('/analyze', async (request, reply) => {
    const { post_id, url } = request.query;
    const postId = extractPostId(post_id, url);

    if (!postId) {
      return reply.status(400).send({
        success: false,
        error: 'Missing or invalid post_id. Provide post_id=<uuid> or url=https://moltbook.com/post/<uuid>',
      });
    }

    try {
      const analysis = await analyzePost(postId);
      if (!analysis) {
        return reply.status(404).send({
          success: false,
          error: 'Post not found or Moltbook API unavailable',
        });
      }

      // Fire background slop farm detection (throttled to once per 30 min)
      maybeDetectSlopFarms();

      return reply.send({ success: true, data: analysis });
    } catch (err) {
      fastify.log.error(err, 'Noise analysis failed');
      return reply.status(500).send({
        success: false,
        error: 'Analysis failed',
      });
    }
  });

  /**
   * GET /noise/stats
   *
   * Aggregate noise filter statistics. Cached for 60 seconds.
   */
  fastify.get('/stats', async (_request, reply) => {
    const now = Date.now();

    if (statsCache && now < statsCache.expiresAt) {
      return reply.send({ success: true, data: statsCache.data });
    }

    const db = getDb();
    const topTemplates = db.getTopTemplates(10);

    // Get classification breakdown from classified_comments table
    const summary = db.getClassifiedCommentsSummary();
    const friendlyNames: Record<string, string> = {
      spam_template: 'generic',
      spam_duplicate: 'duplicate',
      self_promo: 'promo',
    };
    const byClassification: Record<string, number> = {};
    for (const [cls, count] of Object.entries(summary.byClassification)) {
      byClassification[friendlyNames[cls] || cls] = count;
    }

    // Get per-post stats from classified_comments (persistent, not the cache table)
    const postStats = db.getClassifiedPostStats();
    const { totalPosts, totalComments, totalSignal, perPostRates } = postStats;

    let worstRate = perPostRates.length > 0 ? Math.min(...perPostRates) : 0;
    let bestRate = perPostRates.length > 0 ? Math.max(...perPostRates) : 0;
    const sumRate = perPostRates.reduce((a, b) => a + b, 0);

    // Slop farms
    const slopFarmSummary = db.getSlopFarmSummary();

    const data: NoiseStats = {
      total_posts_analyzed: totalPosts,
      total_comments_analyzed: totalComments,
      overall_signal_rate: totalComments > 0 ? Math.round((totalSignal / totalComments) * 100) / 100 : 0,
      avg_signal_rate: totalPosts > 0 ? Math.round((sumRate / totalPosts) * 100) / 100 : 0,
      worst_signal_rate: totalPosts > 0 ? Math.round(worstRate * 100) / 100 : 0,
      best_signal_rate: Math.round(bestRate * 100) / 100,
      by_classification: byClassification,
      top_template_phrases: topTemplates.map(t => ({ text: t.normalized_text, count: t.seen_count })),
      classifier_version: CLASSIFIER_VERSION,
      last_updated: new Date().toISOString(),
      slop_farms: {
        farm_count: slopFarmSummary.farm_count,
        total_agents: slopFarmSummary.total_agents,
        total_comments: slopFarmSummary.total_comments,
        comment_pct: totalComments > 0
          ? Math.round((slopFarmSummary.total_comments / totalComments) * 1000) / 10
          : 0,
        top_farms: slopFarmSummary.farms.slice(0, 3).map((f, i) => ({
          rank: i + 1,
          agent_count: f.agent_count,
          shared_templates: f.shared_templates,
          total_comments: f.total_comments,
        })),
      },
    };

    statsCache = { data, expiresAt: now + STATS_CACHE_TTL_MS };

    return reply.send({ success: true, data });
  });

  /**
   * GET /noise/scanned-ids
   *
   * Returns list of post IDs already in classified_comments (for dedup during bulk imports).
   */
  fastify.get('/scanned-ids', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    const db = getDb();
    const ids = db.getScannedPostIds();
    return reply.send({ success: true, count: ids.length, post_ids: ids });
  });

  /**
   * GET /noise/charts
   *
   * Data for aggregate charts: age-bucketed classification + spam concentration.
   */
  fastify.get('/charts', async (_request, reply) => {
    reply.header('Cache-Control', 'no-cache');

    const db = getDb();

    // Age-bucketed classification counts
    const rawBuckets = db.getAgeBucketedClassifications();
    const BUCKET_ORDER = ['< 1d', '2-3d', '4-7d', '8-10d', '11-14d'];
    const ageBuckets: Array<{ label: string; counts: Record<string, number>; total: number }> = [];
    for (const label of BUCKET_ORDER) {
      const counts: Record<string, number> = {};
      let total = 0;
      for (const row of rawBuckets) {
        if (row.bucket === label) {
          counts[row.classification] = row.count;
          total += row.count;
        }
      }
      ageBuckets.push({ label, counts, total });
    }

    // Spam concentration
    const concentration = db.getSpamConcentration();

    // Signal distribution histogram
    const signalDistribution = db.getSignalDistribution();

    // Cleanest posts (top 5 by signal rate, min 20 comments)
    const cleanestPosts = db.getCleanestPosts(5, 20);

    // Most attacked posts (top 5 by scam count)
    const mostAttackedPosts = db.getMostAttackedPosts(5);

    // Slop farms
    const slopFarmSummary = db.getSlopFarmSummary();

    return reply.send({
      success: true,
      data: {
        age_buckets: ageBuckets,
        spam_concentration: {
          total_authors: concentration.totalAuthors,
          total_posts: concentration.totalPosts,
          total_comments: concentration.totalComments,
          heavy_spammers: concentration.heavySpammers,
          heavy_spammer_comments: concentration.heavySpammerComments,
          heavy_spammer_pct: concentration.totalComments > 0
            ? Math.round((concentration.heavySpammerComments / concentration.totalComments) * 1000) / 10
            : 0,
        },
        slop_farms: {
          farm_count: slopFarmSummary.farm_count,
          total_agents: slopFarmSummary.total_agents,
          total_comments: slopFarmSummary.total_comments,
          comment_pct: concentration.totalComments > 0
            ? Math.round((slopFarmSummary.total_comments / concentration.totalComments) * 1000) / 10
            : 0,
          top_farms: slopFarmSummary.farms.slice(0, 3).map((f, i) => ({
            rank: i + 1,
            agent_count: f.agent_count,
            shared_templates: f.shared_templates,
            total_comments: f.total_comments,
          })),
        },
        signal_distribution: signalDistribution,
        cleanest_posts: cleanestPosts.map(p => ({
          post_id: p.post_id,
          post_title: p.post_title || 'Untitled',
          post_author: p.post_author || 'unknown',
          total_comments: p.total_comments,
          signal_count: p.signal_count,
          signal_rate: Math.round(p.signal_rate * 1000) / 10,
        })),
        most_attacked_posts: mostAttackedPosts.map(p => ({
          post_id: p.post_id,
          post_title: p.post_title || 'Untitled',
          post_author: p.post_author || 'unknown',
          total_comments: p.total_comments,
          scam_count: p.scam_count,
          signal_count: p.signal_count,
          scam_signals: p.scam_signals,
        })),
        classifier_version: CLASSIFIER_VERSION,
      },
    });
  });

  // ============ Export Auth Helper ============

  function checkExportSecret(secret?: string): boolean {
    const config = getConfig();
    return !!(config.exportSecret && secret === config.exportSecret);
  }

  /**
   * GET /noise/export?secret=<EXPORT_SECRET>&format=csv|json&version=latest|all|x.y.z&classification=...&post_id=...&author=...&limit=1000&offset=0
   *
   * Full export of classified comments. Requires EXPORT_SECRET.
   */
  fastify.get<{
    Querystring: { secret?: string; format?: string; version?: string; classification?: string; post_id?: string; author?: string; limit?: string; offset?: string };
  }>('/export', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!checkExportSecret(request.query.secret)) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }

    const db = getDb();
    const format = request.query.format === 'json' ? 'json' : 'csv';
    const version = request.query.version || 'latest';
    const classification = request.query.classification;
    const postId = request.query.post_id;
    const author = request.query.author;
    const limit = Math.min(Math.max(parseInt(request.query.limit || '1000', 10) || 1000, 1), 5000);
    const offset = parseInt(request.query.offset || '0', 10) || 0;

    // Map friendly classification names to internal names
    const classificationMap: Record<string, string> = {
      template: 'spam_template',
      duplicate: 'spam_duplicate',
      promo: 'self_promo',
    };
    const mappedClassification = classification ? (classificationMap[classification] || classification) : undefined;

    const rows = db.getClassifiedComments({
      version,
      classification: mappedClassification,
      postId,
      author,
      limit,
      offset,
    });

    if (format === 'json') {
      return reply.send({ success: true, total: rows.length, data: rows });
    }

    // CSV format
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="noise-export-${timestamp}.csv"`);

    const csvHeader = 'post_id,post_title,post_author,comment_id,author,comment_text,classification,confidence,signals,classified_at,classifier_version\n';

    function csvEscape(val: string | number | null | undefined): string {
      if (val == null) return '';
      const s = String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }

    const csvRows = rows.map(r =>
      [r.post_id, r.post_title, r.post_author, r.comment_id, r.author, r.comment_text, r.classification, r.confidence, r.signals, r.classified_at, r.classifier_version]
        .map(csvEscape).join(',')
    );

    return reply.send(csvHeader + csvRows.join('\n'));
  });

  /**
   * GET /noise/export/summary?secret=<EXPORT_SECRET>
   *
   * Aggregate summary of all classified comments.
   */
  fastify.get<{
    Querystring: { secret?: string };
  }>('/export/summary', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!checkExportSecret(request.query.secret)) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }

    const db = getDb();
    const summary = db.getClassifiedCommentsSummary();
    const topSpam = db.getTopAuthors('noise', 10);
    const topSignal = db.getTopAuthors('signal', 10);
    const latestVersion = db.getLatestClassifierVersion();
    const totalPosts = db.getDistinctPostCount();

    // Map internal classification names to friendly names for display
    const friendlyNames: Record<string, string> = {
      spam_template: 'generic',
      spam_duplicate: 'duplicate',
      self_promo: 'promo',
    };
    const byClassification: Record<string, number> = {};
    for (const [cls, count] of Object.entries(summary.byClassification)) {
      byClassification[friendlyNames[cls] || cls] = count;
    }

    // Compute avg signal rate from latest version
    const latestTotal = Object.values(summary.byClassification).reduce((a, b) => a + b, 0);
    const signalCount = summary.byClassification['signal'] || 0;
    const avgSignalRate = latestTotal > 0 ? Math.round((signalCount / latestTotal) * 100) / 100 : 0;

    return reply.send({
      total_comments: summary.total,
      total_posts: totalPosts,
      by_classification: byClassification,
      by_version: summary.byVersion,
      top_spam_authors: topSpam,
      top_signal_authors: topSignal,
      avg_signal_rate: avgSignalRate,
      latest_classifier_version: latestVersion || CLASSIFIER_VERSION,
      oldest_scan: summary.oldestScan,
      newest_scan: summary.newestScan,
    });
  });

  /**
   * GET /noise/export/diff?secret=<EXPORT_SECRET>&old=0.1.0&new=0.1.1
   *
   * Compare classifications between two classifier versions.
   */
  fastify.get<{
    Querystring: { secret?: string; old?: string; new?: string };
  }>('/export/diff', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!checkExportSecret(request.query.secret)) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }

    const oldVersion = request.query.old;
    const newVersion = request.query.new;
    if (!oldVersion || !newVersion) {
      return reply.status(400).send({ success: false, error: 'Both old and new version parameters are required' });
    }

    const db = getDb();
    const changes = db.getClassifierDiff(oldVersion, newVersion, 500);

    let noiseToSignal = 0;
    let signalToNoise = 0;
    let noiseTypeChanges = 0;

    for (const c of changes) {
      const oldIsSignal = c.old_classification === 'signal';
      const newIsSignal = c.new_classification === 'signal';
      if (!oldIsSignal && newIsSignal) noiseToSignal++;
      else if (oldIsSignal && !newIsSignal) signalToNoise++;
      else noiseTypeChanges++;
    }

    return reply.send({
      total_changed: changes.length,
      changes,
      summary: {
        noise_to_signal: noiseToSignal,
        signal_to_noise: signalToNoise,
        noise_type_changes: noiseTypeChanges,
      },
    });
  });

  /**
   * GET /noise/bulk-scan?secret=<EXPORT_SECRET>&limit=100&delay=2000&fresh=true
   *
   * Re-scan posts to populate classified_comments table.
   * fresh=true (default): deletes all classified_comments first, preserves known_templates.
   * delay: ms between posts (default 2000).
   */
  fastify.get<{
    Querystring: { secret?: string; limit?: string; delay?: string; fresh?: string };
  }>('/bulk-scan', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!checkExportSecret(request.query.secret)) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }

    const db = getDb();
    const limit = Math.min(Math.max(parseInt(request.query.limit || '100', 10) || 100, 1), 500);
    const delay = Math.min(Math.max(parseInt(request.query.delay || '2000', 10) || 2000, 500), 10000);
    const fresh = request.query.fresh !== 'false'; // default true

    let cleared = 0;
    if (fresh) {
      cleared = db.clearClassifiedComments();
      // Also clear noise_analysis cache so all posts re-run
      const analyses = db.getAllNoiseAnalyses();
      for (const a of analyses) db.deleteNoiseAnalysis(a.post_id);
      const templateCount = db.getTopTemplates(99999).length;
      console.log(`[bulk-scan] Fresh mode: cleared ${cleared} classified comments, ${analyses.length} cached analyses. Preserved ${templateCount} known templates.`);
    }

    // Get all post IDs from scan_stats
    const postIds = db.getAllScanStatsPostIds().slice(0, limit);

    const results: Array<{ post_id: string; status: string; signal_rate?: number; comments?: number }> = [];
    const errors: Array<{ post_id: string; error: string }> = [];

    for (let i = 0; i < postIds.length; i++) {
      const postId = postIds[i];
      try {
        // Delete cached noise_analysis so the classifier re-runs
        if (!fresh) db.deleteNoiseAnalysis(postId);

        const analysis = await analyzePost(postId);
        if (analysis) {
          results.push({
            post_id: postId,
            status: 'ok',
            signal_rate: analysis.signal_rate,
            comments: analysis.total_comments,
          });
        } else {
          errors.push({ post_id: postId, error: 'Post not found or API unavailable' });
        }

        // Delay between posts to avoid hammering Moltbook API
        if (i < postIds.length - 1) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (e: any) {
        errors.push({ post_id: postId, error: e.message || 'Unknown error' });
      }
    }

    return reply.send({
      total: postIds.length,
      completed: results.length,
      failed: errors.length,
      cleared,
      results,
      errors,
    });
  });

  /**
   * GET /noise/reclassify?secret=<EXPORT_SECRET>
   *
   * Re-classify all existing comments in the DB using the current classifier version.
   * Does NOT re-fetch from Moltbook — works purely from stored comment_text.
   */
  fastify.get<{
    Querystring: { secret?: string };
  }>('/reclassify', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!checkExportSecret(request.query.secret)) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }

    try {
      const result = await reclassifyExistingComments();
      // Invalidate stats cache
      statsCache = null;
      return reply.send({
        success: true,
        classifier_version: CLASSIFIER_VERSION,
        ...result,
      });
    } catch (e: any) {
      return reply.status(500).send({
        success: false,
        error: e.message || 'Reclassification failed',
      });
    }
  });

  /**
   * GET /noise/detect-farms?secret=<EXPORT_SECRET>
   *
   * Manually trigger slop farm detection. Clears and rebuilds farm data.
   */
  fastify.get<{
    Querystring: { secret?: string };
  }>('/detect-farms', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!checkExportSecret(request.query.secret)) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }

    try {
      const result = detectSlopFarms();
      // Invalidate stats cache
      statsCache = null;
      return reply.send({ success: true, ...result });
    } catch (e: any) {
      return reply.status(500).send({
        success: false,
        error: e.message || 'Farm detection failed',
      });
    }
  });

  /**
   * GET /noise/hits?secret=<EXPORT_SECRET>
   *
   * Private analytics dashboard showing unique IPs, page hits, and recent visitors.
   * Parses nginx access logs.
   */
  fastify.get<{
    Querystring: { secret?: string };
  }>('/hits', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!checkExportSecret(request.query.secret)) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }

    const logPaths = ['/var/log/nginx/access.log'];
    const lines: string[] = [];
    for (const p of logPaths) {
      if (existsSync(p)) {
        try { lines.push(...readFileSync(p, 'utf-8').split('\n').filter(Boolean)); } catch {}
      }
    }

    // Parse nginx combined log format
    const logRegex = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d+) (\d+)/;
    interface LogEntry { ip: string; time: string; method: string; path: string; status: number; bytes: number; }
    const entries: LogEntry[] = [];
    for (const line of lines) {
      const m = line.match(logRegex);
      if (m) {
        entries.push({ ip: m[1], time: m[2], method: m[3], path: m[4], status: parseInt(m[5]), bytes: parseInt(m[6]) });
      }
    }

    // Unique IPs
    const uniqueIps = new Set(entries.map(e => e.ip));

    // Hits by path (top 30)
    const pathCounts = new Map<string, number>();
    for (const e of entries) {
      const normalized = e.path.split('?')[0];
      pathCounts.set(normalized, (pathCounts.get(normalized) || 0) + 1);
    }
    const topPaths = [...pathCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);

    // Hits by IP (top 20)
    const ipCounts = new Map<string, number>();
    for (const e of entries) {
      ipCounts.set(e.ip, (ipCounts.get(e.ip) || 0) + 1);
    }
    const topIps = [...ipCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

    // Recent 50 entries (newest first)
    const recent = entries.slice(-50).reverse();

    // Hits by hour (last 48h bucketed)
    const hourCounts = new Map<string, number>();
    for (const e of entries) {
      // nginx time: 09/Feb/2026:23:44:34 +0000
      const hourMatch = e.time.match(/(\d{2}\/\w{3}\/\d{4}:\d{2})/);
      if (hourMatch) {
        hourCounts.set(hourMatch[1], (hourCounts.get(hourMatch[1]) || 0) + 1);
      }
    }
    const hourBuckets = [...hourCounts.entries()].sort().slice(-48);

    // Status code breakdown
    const statusCounts = new Map<number, number>();
    for (const e of entries) {
      statusCounts.set(e.status, (statusCounts.get(e.status) || 0) + 1);
    }

    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(buildHitsPage({
      totalHits: entries.length,
      uniqueIpCount: uniqueIps.size,
      topPaths,
      topIps,
      recent,
      hourBuckets,
      statusCounts: [...statusCounts.entries()].sort((a, b) => b[1] - a[1]),
    }));
  });

  /**
   * GET /noise/page
   *
   * Serves the web fallback HTML page for URL-based analysis.
   */
  fastify.get('/page', async (_request, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    // Inject sidebar into the noise page
    let html = NOISE_PAGE_HTML;
    html = html.replace('</style>', getSidebarCSS() + '\n</style>');
    html = html.replace('<body>\n<div class="container">', '<body>\n' + getSidebarHTML('noise') + '\n<div class="page-content">\n<div class="container">');
    html = html.replace('</div>\n\n<script>', '</div>\n</div>\n\n<script>');
    html = html.replace('</script>\n</body>', getSidebarJS() + '\n</script>\n</body>');
    return reply.send(html);
  });
}

// ============ Inline Web Fallback Page ============

const NOISE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sanctuary Noise Filter</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --border: #2a2d3a;
    --text: #e2e4e9;
    --text-muted: #8b8fa3;
    --accent: #6366f1;
    --green: #22c55e;
    --red: #ef4444;
    --yellow: #eab308;
    --orange: #f97316;
    --gray: #6b7280;
    --purple: #a855f7;
    --dark-red: #dc2626;
    --slop: #7f1d1d;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }
  .container { max-width: 800px; margin: 0 auto; padding: 40px 20px; }
  .header { text-align: center; margin-bottom: 40px; }
  .header h1 { font-size: 28px; margin-bottom: 8px; }
  .header .shield { font-size: 36px; margin-bottom: 12px; display: block; }
  .header p { color: var(--text-muted); font-size: 16px; }
  .search-box {
    display: flex; gap: 12px; margin-bottom: 0;
  }
  .search-box input {
    flex: 1; padding: 14px 16px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--surface);
    color: var(--text); font-size: 15px; outline: none;
  }
  .search-box input:focus { border-color: var(--accent); }
  .search-box input::placeholder { color: var(--text-muted); }
  .search-box button {
    padding: 14px 28px; border-radius: 8px; border: none;
    background: var(--accent); color: white; font-size: 15px;
    font-weight: 600; cursor: pointer; white-space: nowrap;
  }
  .search-box button:hover { opacity: 0.9; }
  .search-box button:disabled { opacity: 0.5; cursor: not-allowed; }
  .loading { text-align: center; padding: 40px; color: var(--text-muted); }
  .error { text-align: center; padding: 20px; color: var(--red); }
  .results { display: none; }
  .summary-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 24px; margin-bottom: 24px;
  }
  .summary-card h2 { font-size: 18px; margin-bottom: 4px; }
  .summary-card .author { color: var(--text-muted); font-size: 14px; margin-bottom: 16px; }
  .signal-bar-container { margin-bottom: 16px; }
  .signal-bar-label {
    display: flex; justify-content: space-between;
    font-size: 14px; margin-bottom: 6px;
  }
  .signal-bar {
    height: 8px; border-radius: 4px; background: var(--border); overflow: hidden;
  }
  .signal-bar-fill {
    height: 100%; border-radius: 4px; background: var(--green);
    transition: width 0.5s ease;
  }
  .breakdown {
    display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px;
  }
  .breakdown-item {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; color: var(--text-muted);
  }
  .dot {
    width: 10px; height: 10px; border-radius: 50%; display: inline-block;
  }
  .dot-signal { background: var(--green); }
  .dot-spam_duplicate { background: var(--red); }
  .dot-spam_template { background: var(--orange); }
  .dot-scam { background: var(--dark-red); }
  .dot-self_promo { background: var(--yellow); }
  .dot-recruitment { background: var(--purple); }
  .dot-noise { background: var(--gray); }
  .controls {
    display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap;
    align-items: center; justify-content: space-between;
  }
  .filter-group, .sort-group {
    display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
  }
  .control-label {
    font-size: 12px; color: var(--text-muted); text-transform: uppercase;
    letter-spacing: 0.5px; margin-right: 4px;
  }
  .filter-btn {
    padding: 5px 12px; border-radius: 14px; border: 1px solid var(--border);
    background: transparent; color: var(--text-muted); font-size: 12px;
    cursor: pointer; transition: all 0.15s;
  }
  .filter-btn:hover { border-color: var(--text-muted); }
  .filter-btn.active { color: white; }
  .filter-btn.active[data-filter="signal"] { background: var(--green); border-color: var(--green); }
  .filter-btn.active[data-filter="slop"] { background: var(--red); border-color: var(--red); }
  .filter-btn.active[data-filter="all"] { background: var(--accent); border-color: var(--accent); }
  .sort-btn {
    padding: 5px 12px; border-radius: 14px; border: 1px solid var(--border);
    background: transparent; color: var(--text-muted); font-size: 12px;
    cursor: pointer; transition: all 0.15s;
  }
  .sort-btn:hover { border-color: var(--text-muted); }
  .sort-btn.active { background: var(--accent); color: white; border-color: var(--accent); }
  .comment-list { display: flex; flex-direction: column; gap: 8px; }
  .comment-item {
    background: var(--surface); border-radius: 8px; padding: 14px 16px;
    display: flex; gap: 12px; align-items: flex-start;
    border-left: 3px solid var(--border); border-top: 1px solid var(--border);
    border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);
  }
  .comment-item.hidden { display: none; }
  .comment-item[data-cat="signal"] { border-left-color: var(--green); }
  .comment-item[data-cat="spam_duplicate"] { border-left-color: var(--red); }
  .comment-item[data-cat="spam_template"] { border-left-color: var(--orange); }
  .comment-item[data-cat="scam"] { border-left-color: var(--dark-red); }
  .comment-item[data-cat="self_promo"] { border-left-color: var(--yellow); }
  .comment-item[data-cat="recruitment"] { border-left-color: var(--purple); }
  .comment-item[data-cat="noise"] { border-left-color: var(--gray); }
  .comment-badge {
    min-width: 10px; height: 10px; border-radius: 50%; margin-top: 6px;
  }
  .comment-body { flex: 1; }
  .comment-author { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  .comment-text { font-size: 14px; color: var(--text-muted); line-height: 1.5; }
  .comment-meta {
    display: flex; gap: 8px; margin-top: 6px; font-size: 12px;
  }
  .comment-tag {
    padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
  }
  .tag-signal { background: rgba(34,197,94,0.15); color: var(--green); }
  .tag-spam_duplicate { background: rgba(239,68,68,0.15); color: var(--red); }
  .tag-spam_template { background: rgba(249,115,22,0.15); color: var(--orange); }
  .tag-scam { background: rgba(220,38,38,0.15); color: var(--dark-red); }
  .tag-self_promo { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .tag-recruitment { background: rgba(168,85,247,0.15); color: var(--purple); }
  .tag-noise { background: rgba(107,114,128,0.15); color: var(--gray); }
  .stats-section {
    margin-top: 48px; padding-top: 32px; border-top: 1px solid var(--border);
  }
  .stats-section h3 { font-size: 16px; margin-bottom: 16px; color: var(--text-muted); }
  .stats-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
  }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 16px; text-align: center;
  }
  .stat-value { font-size: 24px; font-weight: 700; }
  .stat-label { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
  .cls-bar-container { margin: 16px 0; }
  .slop-primary-bar {
    height: 32px; border-radius: 6px; overflow: hidden; display: flex;
    background: var(--border); margin-bottom: 8px; position: relative;
  }
  .slop-primary-seg { height: 100%; transition: width 0.5s ease; min-width: 0; display: flex; align-items: center; justify-content: center; }
  .slop-primary-label {
    font-size: 11px; font-weight: 600; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5);
    pointer-events: none; white-space: nowrap;
  }
  .slop-sub-label { font-size: 11px; color: var(--text); margin: 6px 0 4px; }
  .cls-bar {
    height: 24px; border-radius: 6px; overflow: hidden; display: flex;
    background: var(--border);
  }
  .cls-bar-seg { height: 100%; transition: width 0.5s ease; min-width: 0; }
  .cls-legend {
    display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px;
  }
  .cls-legend-item {
    display: flex; align-items: center; gap: 5px;
    font-size: 12px; color: var(--text-muted);
  }
  .cls-legend-dot { width: 8px; height: 8px; border-radius: 50%; }
  .stats-meta {
    font-size: 11px; color: var(--text-muted); margin-top: 12px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .stats-meta .live-dot {
    display: inline-block; width: 6px; height: 6px; border-radius: 50%;
    background: var(--green); margin-right: 4px; animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .footer {
    text-align: center; margin-top: 48px; padding-top: 24px;
    border-top: 1px solid var(--border); color: var(--text-muted); font-size: 13px;
  }
  .footer a { color: var(--accent); text-decoration: none; }
  .footer a:hover { text-decoration: underline; }
  .ext-cta {
    text-align: center; margin: 24px 0; padding: 16px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; color: var(--text-muted); font-size: 14px;
  }
  .charts-section { margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--border); }
  .chart-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 24px; margin-bottom: 20px;
  }
  .chart-card h3 { font-size: 16px; margin-bottom: 4px; }
  .chart-subtitle { font-size: 12px; color: var(--text-muted); margin-bottom: 20px; }
  .stacked-bar-container {
    display: flex; align-items: flex-end; gap: 8px; height: 220px;
    padding-bottom: 28px; position: relative;
  }
  .bar-column { flex: 1; display: flex; flex-direction: column; align-items: center; position: relative; height: 100%; }
  .bar-stack {
    width: 100%; max-width: 80px; display: flex; flex-direction: column-reverse;
    border-radius: 4px 4px 0 0; overflow: hidden; position: absolute; bottom: 28px;
  }
  .bar-seg { min-height: 1px; transition: height 0.5s ease; }
  .bar-label { position: absolute; bottom: 8px; font-size: 11px; color: var(--text-muted); text-align: center; width: 100%; }
  .bar-total { position: absolute; bottom: 0; font-size: 10px; color: var(--text-muted); text-align: center; width: 100%; opacity: 0.6; }
  .chart-legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 12px; }
  .chart-legend-item { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-muted); }
  .chart-legend-dot { width: 10px; height: 10px; border-radius: 2px; }
  .concentration-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 28px; margin-bottom: 20px;
  }
  .concentration-header { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 20px; font-weight: 600; }
  .concentration-row { display: flex; align-items: baseline; gap: 14px; margin-bottom: 14px; }
  .concentration-num { font-size: 48px; font-weight: 700; line-height: 1; min-width: 80px; text-align: right; }
  .concentration-label { font-size: 14px; color: var(--text-muted); line-height: 1.3; }
  .concentration-footer { font-size: 11px; color: var(--text-muted); margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--border); }
  .farm-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 28px; margin-bottom: 20px;
  }
  .farm-header { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 4px; font-weight: 600; }
  .farm-subtitle { font-size: 12px; color: var(--text-muted); margin-bottom: 20px; }
  .farm-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
  .farm-stat-val { font-size: 36px; font-weight: 700; line-height: 1; }
  .farm-stat-label { font-size: 11px; color: var(--text-muted); margin-top: 6px; }
  .farm-details { border-top: 1px solid var(--border); padding-top: 14px; }
  .farm-detail-row { font-size: 13px; color: var(--text-muted); padding: 6px 0; display: flex; gap: 8px; }
  .farm-detail-rank { color: var(--orange); font-weight: 700; min-width: 60px; }
  .farm-footer { font-size: 11px; color: var(--text-muted); margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
  .stats-btn {
    display: inline-block; padding: 10px 24px;
    border-radius: 8px; border: 1px solid var(--accent);
    background: rgba(99,102,241,0.12); color: var(--accent); font-size: 14px;
    font-weight: 600; cursor: pointer; text-decoration: none; transition: all 0.15s;
    letter-spacing: 0.3px;
  }
  .stats-btn:hover { background: rgba(99,102,241,0.25); color: white; border-color: var(--accent); }
  .distro-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 24px; margin-bottom: 20px;
  }
  .distro-card h3 { font-size: 16px; margin-bottom: 4px; }
  .distro-bars {
    display: flex; align-items: flex-end; gap: 6px; height: 180px;
    padding-bottom: 32px; position: relative;
  }
  .distro-col { flex: 1; display: flex; flex-direction: column; align-items: center; position: relative; height: 100%; justify-content: flex-end; }
  .distro-bar {
    width: 100%; border-radius: 4px 4px 0 0; background: var(--accent);
    transition: height 0.4s ease; min-height: 2px; cursor: default;
  }
  .distro-bar:hover { background: var(--green); }
  .distro-bar-label { position: absolute; bottom: 8px; font-size: 9px; color: var(--text-muted); text-align: center; width: 100%; white-space: nowrap; }
  .distro-bar-count { font-size: 11px; color: var(--text); font-weight: 600; margin-bottom: 4px; }
  .leaderboard-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 24px; margin-bottom: 20px;
  }
  .leaderboard-card h3 { font-size: 16px; margin-bottom: 4px; }
  .leaderboard-subtitle { font-size: 12px; color: var(--text-muted); margin-bottom: 16px; }
  .leaderboard-list { list-style: none; }
  .leaderboard-item {
    display: flex; align-items: center; gap: 12px; padding: 12px 14px;
    border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s;
    text-decoration: none; color: var(--text);
  }
  .leaderboard-item:last-child { border-bottom: none; }
  .leaderboard-item:hover { background: rgba(99,102,241,0.08); border-radius: 8px; }
  .leaderboard-rank {
    font-size: 18px; font-weight: 700; min-width: 28px; text-align: center;
    color: var(--text-muted);
  }
  .leaderboard-rank.gold { color: #eab308; }
  .leaderboard-rank.silver { color: #94a3b8; }
  .leaderboard-rank.bronze { color: #b45309; }
  .leaderboard-info { flex: 1; min-width: 0; }
  .leaderboard-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .leaderboard-meta { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  .leaderboard-stat { text-align: right; min-width: 60px; }
  .leaderboard-stat-value { font-size: 20px; font-weight: 700; }
  .leaderboard-stat-label { font-size: 10px; color: var(--text-muted); }
  .scam-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .scam-tag { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: rgba(220,38,38,0.12); color: var(--dark-red); }
  @media (max-width: 768px) {
    .stacked-bar-container { height: 160px; }
    .concentration-num { font-size: 36px; min-width: 60px; }
    .farm-grid { grid-template-columns: repeat(2, 1fr); }
    .farm-stat-val { font-size: 28px; }
    .distro-bars { height: 140px; }
    .distro-bar-label { font-size: 8px; }
    .leaderboard-title { font-size: 13px; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <span class="shield">&#x1F6E1;</span>
    <h1>Sanctuary Noise Filter</h1>
    <p>See what's real on Moltbook.</p>
  </div>

  <div class="search-box">
    <input type="text" id="urlInput" placeholder="Paste a Moltbook post URL or UUID..." />
    <button id="scanBtn" onclick="analyze()">Scan</button>
  </div>
  <div style="text-align:center;margin-top:12px;margin-bottom:24px;">
    <a href="#chartsSection" class="stats-btn" onclick="scrollToCharts()">&#x1F4CA; See aggregate stats &darr;</a>
  </div>

  <div id="loading" class="loading" style="display:none;">Analyzing comments...</div>
  <div id="error" class="error" style="display:none;"></div>

  <div id="results" class="results">
    <div class="summary-card">
      <h2 id="postTitle"></h2>
      <div class="author" id="postAuthor"></div>
      <div class="signal-bar-container">
        <div class="signal-bar-label">
          <span>Signal: <strong id="signalLabel"></strong></span>
          <span id="rateLabel"></span>
        </div>
        <div class="signal-bar"><div class="signal-bar-fill" id="signalBarFill"></div></div>
        <div id="sampleNote" style="display:none;font-size:12px;color:var(--text-muted);margin-top:6px;"></div>
      </div>
      <div class="breakdown" id="breakdown"></div>
    </div>

    <div class="controls">
      <div class="filter-group">
        <span class="control-label">Filter</span>
        <button class="filter-btn active" data-filter="all" onclick="toggleFilter('all', this)">All</button>
        <button class="filter-btn" data-filter="signal" onclick="toggleFilter('signal', this)">Signal</button>
        <button class="filter-btn" data-filter="slop" onclick="toggleFilter('slop', this)">Slop</button>
      </div>
      <div class="sort-group">
        <span class="control-label">Sort</span>
        <button class="sort-btn" data-sort="classification" onclick="setSort('classification', this)">By type</button>
        <button class="sort-btn active" data-sort="score" onclick="setSort('score', this)">By signal score</button>
        <button class="sort-btn" data-sort="original" onclick="setSort('original', this)">As posted</button>
      </div>
    </div>

    <div class="comment-list" id="commentList"></div>
  </div>

  <div class="stats-section" id="statsSection">
    <h3>Platform Stats</h3>
    <div style="font-size:12px;color:#8b8fa3;margin-top:-8px;margin-bottom:12px;">From posts with 10+ comments</div>
    <div id="statsLoading" style="text-align:center;padding:20px;color:var(--text-muted);font-size:14px;">Loading stats...</div>
    <div id="statsError" style="display:none;text-align:center;padding:20px;color:var(--red);font-size:14px;"></div>
    <div class="stats-grid" id="statsGrid"></div>
    <div class="cls-bar-container" id="clsBarContainer" style="display:none;">
      <div class="slop-primary-bar" id="slopPrimaryBar"></div>
      <div class="slop-sub-label">Slop breakdown</div>
      <div class="cls-bar" id="clsBar"></div>
      <div class="cls-legend" id="clsLegend"></div>
    </div>
    <div class="stats-meta" id="statsMeta"></div>
  </div>

  <div class="charts-section" id="chartsSection">
    <div class="chart-card" id="ageChartCard" style="display:none;">
      <h3>&#x1F4CA; Comment Composition by Post Age</h3>
      <div class="chart-subtitle" id="ageChartSubtitle"></div>
      <div class="stacked-bar-container" id="ageChartBars"></div>
      <div class="chart-legend" id="ageChartLegend"></div>
    </div>
    <div class="concentration-card" id="concentrationCard" style="display:none;">
      <div class="concentration-header">Slop Concentration</div>
      <div id="concentrationRows"></div>
      <div class="concentration-footer" id="concentrationFooter"></div>
    </div>
    <div class="farm-card" id="farmCard" style="display:none;">
      <div class="farm-header">Slop Farms</div>
      <div class="farm-subtitle">Coordinated bot networks detected through shared spam templates</div>
      <div class="farm-grid" id="farmGrid"></div>
      <div class="farm-details" id="farmDetails"></div>
      <div class="farm-footer">Detection: agents sharing 5+ identical spam comments across 3+ posts, &lt;15% signal rate</div>
    </div>
    <div class="distro-card" id="distroCard" style="display:none;">
      <h3>&#x1F4CA; Signal Distribution</h3>
      <div class="chart-subtitle" id="distroSubtitle"></div>
      <div class="distro-bars" id="distroBars"></div>
    </div>
    <div class="leaderboard-card" id="cleanestCard" style="display:none;">
      <h3>&#x2728; Cleanest Posts</h3>
      <div class="leaderboard-subtitle">Top posts by signal rate (min 20 comments)</div>
      <div class="leaderboard-list" id="cleanestList"></div>
    </div>
    <div class="leaderboard-card" id="attackedCard" style="display:none;">
      <h3>&#x1F6A8; Most Attacked Posts</h3>
      <div class="leaderboard-subtitle">Posts with the most scam comments</div>
      <div class="leaderboard-list" id="attackedList"></div>
    </div>
  </div>

  <div id="shareBox" class="ext-cta" style="display:none;">
    <span id="shareText"></span>
    <button onclick="copyShare()" style="margin-left:8px;padding:4px 12px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;font-size:13px;">Copy link</button>
  </div>

  <div class="footer">
    <a href="https://sanctuary-ops.xyz">sanctuary-ops.xyz</a> &mdash; Trust infrastructure for AI agents
  </div>
</div>

<script>
// API calls always go to the API subdomain; the page may be served from sanctuary-ops.xyz/noise
const API_BASE = 'https://api.sanctuary-ops.xyz';
const SHARE_BASE = 'https://sanctuary-ops.xyz/noise';
let currentData = null;

// Check for ?post= parameter
const params = new URLSearchParams(window.location.search);
const postParam = params.get('post');
if (postParam) {
  document.getElementById('urlInput').value = postParam;
  setTimeout(() => analyze(), 100);
}

// Load stats + charts on page load
loadStats();
loadCharts();

async function analyze() {
  const input = document.getElementById('urlInput').value.trim();
  if (!input) return;

  const btn = document.getElementById('scanBtn');
  const loading = document.getElementById('loading');
  const error = document.getElementById('error');
  const results = document.getElementById('results');

  btn.disabled = true;
  loading.style.display = 'block';
  error.style.display = 'none';
  results.style.display = 'none';

  try {
    // Extract post_id from URL or use raw input
    let postId = input;
    const urlMatch = input.match(/moltbook\\.com\\/post\\/([\\w-]+)/);
    if (urlMatch) postId = urlMatch[1];

    const resp = await fetch(API_BASE + '/noise/analyze?post_id=' + encodeURIComponent(postId));
    const json = await resp.json();

    if (!json.success) {
      throw new Error(json.error || 'Analysis failed');
    }

    currentData = json.data;
    renderResults(json.data);
    results.style.display = 'block';

    // Show share link
    const shareLink = SHARE_BASE + '?post=' + encodeURIComponent(postId);
    document.getElementById('shareText').textContent = shareLink;
    document.getElementById('shareBox').style.display = 'block';

    // Update URL for sharing (use canonical sanctuary-ops.xyz/noise URL)
    try {
      const shareUrl = new URL(SHARE_BASE);
      shareUrl.searchParams.set('post', postId);
      history.replaceState(null, '', shareUrl.pathname + shareUrl.search);
    } catch {
      // Fallback if URL construction fails (e.g. served locally)
      const url = new URL(window.location);
      url.searchParams.set('post', postId);
      history.replaceState(null, '', url);
    }
  } catch (e) {
    error.textContent = e.message || 'Something went wrong';
    error.style.display = 'block';
  } finally {
    loading.style.display = 'none';
    btn.disabled = false;
  }
}

function renderResults(data) {
  document.getElementById('postTitle').textContent = data.post_title || 'Untitled Post';
  document.getElementById('postAuthor').textContent = 'by ' + (data.post_author || 'unknown');
  const analyzed = data.total_comments;
  const totalPost = data.total_post_comments || analyzed;
  const isSampled = totalPost > analyzed;
  document.getElementById('signalLabel').textContent = data.signal_count + '/' + analyzed + (isSampled ? ' (sampled from ' + totalPost.toLocaleString() + ' comments)' : '');
  document.getElementById('rateLabel').textContent = Math.round(data.signal_rate * 100) + '%';
  document.getElementById('signalBarFill').style.width = Math.round(data.signal_rate * 100) + '%';
  var sampleNote = document.getElementById('sampleNote');
  var unavailable = totalPost - analyzed;
  if (isSampled) {
    var replies = data.reply_count || 0;
    sampleNote.innerHTML = 'Showing analysis of the most recent ' + analyzed + ' comments out of ' + totalPost.toLocaleString() + '.' +
      (unavailable > 0 ? '<br>' + totalPost.toLocaleString() + ' total &middot; ' + analyzed + ' served &middot; ' + replies + ' replies &middot; ' + unavailable + ' unavailable' : '');
    sampleNote.style.display = 'block';
  } else {
    sampleNote.style.display = 'none';
  }

  // Breakdown
  const bd = document.getElementById('breakdown');
  bd.innerHTML = '';
  const labels = {
    signal: 'signal', spam_template: 'generic', spam_duplicate: 'copied',
    scam: 'scam', recruitment: 'recruitment', self_promo: 'promo', noise: 'low-effort'
  };
  for (const [cat, count] of Object.entries(data.summary)) {
    if (count === 0) continue;
    const el = document.createElement('div');
    el.className = 'breakdown-item';
    el.innerHTML = '<span class="dot dot-' + cat + '"></span>' + count + ' ' + labels[cat];
    bd.appendChild(el);
  }

  // Comments
  const list = document.getElementById('commentList');
  list.innerHTML = '';
  data.comments.forEach((c, i) => {
    const score = getSignalScore(c);
    const scoreColor = getScoreColor(score);
    const el = document.createElement('div');
    el.className = 'comment-item';
    el.setAttribute('data-cat', c.classification);
    el.setAttribute('data-score', String(score));
    el.setAttribute('data-idx', String(i));
    el.innerHTML =
      '<div class="comment-badge dot-' + c.classification + '" style="min-width:10px;height:10px;border-radius:50%;margin-top:6px;background:var(--' + getCssVar(c.classification) + ')"></div>' +
      '<div class="comment-body">' +
        '<div class="comment-author">' + escapeHtml(c.author) + '</div>' +
        '<div class="comment-text">' + escapeHtml(c.text) + '</div>' +
        '<div class="comment-meta">' +
          '<span class="comment-tag tag-' + c.classification + '">' + (TAG_LABELS[c.classification] || c.classification) + '</span>' +
          '<span style="color:' + scoreColor + ';font-size:12px;font-weight:600;">' + score + '% signal</span>' +
        '</div>' +
      '</div>';
    list.appendChild(el);
  });

  // Apply default sort (by signal score, highest first)
  setSort('score', document.querySelector('.sort-btn[data-sort="score"]'));
}

function getSignalScore(c) {
  if (c.classification === 'signal') return Math.round(c.confidence * 100);
  return Math.round((1 - c.confidence) * 100);
}

function getScoreColor(score) {
  if (score >= 60) return 'var(--green)';
  if (score >= 30) return 'var(--yellow)';
  return 'var(--red)';
}

const TAG_LABELS = {
  signal: 'signal', spam_template: 'generic', spam_duplicate: 'copied',
  scam: 'scam', self_promo: 'promo', recruitment: 'recruitment', noise: 'low-effort'
};

function getCssVar(cat) {
  const map = { signal:'green', spam_duplicate:'red', spam_template:'orange', scam:'dark-red', self_promo:'yellow', recruitment:'purple', noise:'gray' };
  return map[cat] || 'gray';
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

const FILTER_GROUPS = {
  signal: ['signal'],
  slop: ['spam_template', 'spam_duplicate', 'noise', 'self_promo', 'recruitment', 'scam'],
};
let activeFilters = new Set(['all']);
let activeSort = 'score';

function toggleFilter(filter, btn) {
  if (filter === 'all') {
    activeFilters = new Set(['all']);
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  } else {
    activeFilters.delete('all');
    document.querySelector('.filter-btn[data-filter="all"]').classList.remove('active');
    if (activeFilters.has(filter)) {
      activeFilters.delete(filter);
      btn.classList.remove('active');
    } else {
      activeFilters.add(filter);
      btn.classList.add('active');
    }
    if (activeFilters.size === 0) {
      activeFilters.add('all');
      document.querySelector('.filter-btn[data-filter="all"]').classList.add('active');
    }
  }
  applyFilters();
}

function applyFilters() {
  const visibleCats = new Set();
  if (activeFilters.has('all')) {
    Object.values(FILTER_GROUPS).flat().forEach(c => visibleCats.add(c));
  } else {
    for (const f of activeFilters) {
      (FILTER_GROUPS[f] || []).forEach(c => visibleCats.add(c));
    }
  }
  document.querySelectorAll('.comment-item').forEach(el => {
    el.classList.toggle('hidden', !visibleCats.has(el.getAttribute('data-cat')));
  });
}

const SORT_ORDER = { signal: 0, spam_template: 1, spam_duplicate: 1, noise: 1, self_promo: 1, recruitment: 1, scam: 1 };

function setSort(sort, btn) {
  activeSort = sort;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (!currentData) return;
  const list = document.getElementById('commentList');
  const items = [...list.children];
  items.sort((a, b) => {
    if (sort === 'classification') {
      return (SORT_ORDER[a.getAttribute('data-cat')] ?? 9) - (SORT_ORDER[b.getAttribute('data-cat')] ?? 9);
    } else if (sort === 'score') {
      return parseInt(b.getAttribute('data-score')) - parseInt(a.getAttribute('data-score'));
    }
    return parseInt(a.getAttribute('data-idx')) - parseInt(b.getAttribute('data-idx'));
  });
  items.forEach(el => list.appendChild(el));
}

const CLS_COLORS = {
  signal: 'var(--green)', duplicate: 'var(--red)', generic: 'var(--orange)',
  scam: 'var(--dark-red)', promo: 'var(--yellow)', recruitment: 'var(--purple)', noise: 'var(--gray)'
};
const CLS_LABELS = {
  signal: 'Signal', duplicate: 'Copied', generic: 'Generic',
  scam: 'Scam', promo: 'Promo', recruitment: 'Recruitment', noise: 'Low-effort'
};

async function loadStats() {
  var loadingEl = document.getElementById('statsLoading');
  var errorEl = document.getElementById('statsError');
  try {
    const resp = await fetch(API_BASE + '/noise/stats');
    const json = await resp.json();
    if (loadingEl) loadingEl.style.display = 'none';

    if (!json.success || json.data.total_posts_analyzed === 0) {
      if (errorEl) { errorEl.textContent = 'No posts analyzed yet.'; errorEl.style.display = 'block'; }
      return;
    }

    const d = json.data;
    const grid = document.getElementById('statsGrid');
    grid.innerHTML = '';
    const items = [
      [d.total_posts_analyzed.toLocaleString(), 'Posts Analyzed'],
      [d.total_comments_analyzed.toLocaleString(), 'Comments Classified'],
      [Math.round(d.avg_signal_rate * 100) + '%', 'Avg Signal Rate'],
      [Math.round(d.overall_signal_rate * 100) + '%', 'Overall Signal'],
    ];
    for (const [val, label] of items) {
      const el = document.createElement('div');
      el.className = 'stat-card';
      el.innerHTML = '<div class="stat-value">' + val + '</div><div class="stat-label">' + label + '</div>';
      grid.appendChild(el);
    }

    // Two-layer classification breakdown: Signal vs Slop primary, subcategories secondary
    if (d.by_classification) {
      const total = Object.values(d.by_classification).reduce(function(a, b) { return a + b; }, 0);
      if (total > 0) {
        var signalCount = d.by_classification.signal || 0;
        var slopCount = total - signalCount;
        var signalPct = (signalCount / total * 100);
        var slopPct = (slopCount / total * 100);

        // Primary bar: Signal vs Slop
        var primaryBar = document.getElementById('slopPrimaryBar');
        primaryBar.innerHTML = '';
        var sigSeg = document.createElement('div');
        sigSeg.className = 'slop-primary-seg';
        sigSeg.style.width = signalPct + '%';
        sigSeg.style.background = 'var(--green)';
        sigSeg.title = 'Signal: ' + signalCount.toLocaleString() + ' (' + signalPct.toFixed(1) + '%)';
        if (signalPct > 12) sigSeg.innerHTML = '<span class="slop-primary-label">' + Math.round(signalPct) + '% Signal</span>';
        primaryBar.appendChild(sigSeg);

        var slopSeg = document.createElement('div');
        slopSeg.className = 'slop-primary-seg';
        slopSeg.style.width = slopPct + '%';
        slopSeg.style.background = 'var(--slop)';
        slopSeg.title = 'Slop: ' + slopCount.toLocaleString() + ' (' + slopPct.toFixed(1) + '%)';
        if (slopPct > 12) slopSeg.innerHTML = '<span class="slop-primary-label">' + Math.round(slopPct) + '% Slop</span>';
        primaryBar.appendChild(slopSeg);

        // Secondary bar: Slop subcategory breakdown (excludes signal)
        // Align secondary bar with slop portion of primary bar
        var subLabel = document.querySelector('.slop-sub-label');
        if (subLabel) { subLabel.style.marginLeft = signalPct + '%'; }
        var bar = document.getElementById('clsBar');
        bar.style.marginLeft = signalPct + '%';
        bar.style.width = slopPct + '%';
        var legend = document.getElementById('clsLegend');
        bar.innerHTML = '';
        legend.innerHTML = '';

        // Add Signal to legend first
        var sigLi = document.createElement('div');
        sigLi.className = 'cls-legend-item';
        sigLi.innerHTML = '<span class="cls-legend-dot" style="background:var(--green)"></span>Signal ' + signalCount.toLocaleString() + ' (' + signalPct.toFixed(1) + '%)';
        legend.appendChild(sigLi);

        // Subcategory entries (non-signal), sorted by count desc
        var entries = Object.entries(d.by_classification).filter(function(e) { return e[0] !== 'signal'; }).sort(function(a, b) {
          return b[1] - a[1];
        });
        for (var i = 0; i < entries.length; i++) {
          var cls = entries[i][0], count = entries[i][1];
          var pct = (count / total * 100);
          if (pct < 0.5) continue;
          // Secondary bar shows proportion within slop
          var slopBarPct = slopCount > 0 ? (count / slopCount * 100) : 0;
          var seg = document.createElement('div');
          seg.className = 'cls-bar-seg';
          seg.style.width = slopBarPct + '%';
          seg.style.background = CLS_COLORS[cls] || 'var(--gray)';
          seg.title = (CLS_LABELS[cls] || cls) + ': ' + count.toLocaleString() + ' (' + pct.toFixed(1) + '% of total)';
          bar.appendChild(seg);

          var li = document.createElement('div');
          li.className = 'cls-legend-item';
          li.innerHTML = '<span class="cls-legend-dot" style="background:' + (CLS_COLORS[cls] || 'var(--gray)') + '"></span>' +
            (CLS_LABELS[cls] || cls) + ' ' + count.toLocaleString() + ' (' + pct.toFixed(1) + '%)';
          legend.appendChild(li);
        }
        document.getElementById('clsBarContainer').style.display = 'block';
      }
    }

    // Meta line with version + live indicator
    var meta = document.getElementById('statsMeta');
    meta.innerHTML = '<span><span class="live-dot"></span>Auto-refreshing every 60s</span>' +
      '<span>Classifier v' + (d.classifier_version || '?') + ' &middot; Updated ' + new Date(d.last_updated).toLocaleTimeString() + '</span>';

    if (errorEl) errorEl.style.display = 'none';
  } catch (err) {
    console.error('loadStats failed:', err);
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) { errorEl.textContent = 'Failed to load stats: ' + (err.message || err); errorEl.style.display = 'block'; }
  }
}

// Auto-refresh stats every 60 seconds
setInterval(loadStats, 60000);

function copyShare() {
  const text = document.getElementById('shareText').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = event.target;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy link'; }, 1500);
  }).catch(() => {});
}

// ============ Charts ============

function scrollToCharts() {
  document.getElementById('chartsSection').scrollIntoView({ behavior: 'smooth' });
}

var CHART_CLS = {
  signal: { color: 'var(--green)', label: 'Signal' },
  spam_duplicate: { color: 'var(--red)', label: 'Copied' },
  spam_template: { color: 'var(--orange)', label: 'Generic' },
  scam: { color: 'var(--dark-red)', label: 'Scam' },
  self_promo: { color: 'var(--yellow)', label: 'Promo' },
  recruitment: { color: 'var(--purple)', label: 'Recruitment' },
  noise: { color: 'var(--gray)', label: 'Low-effort' }
};
var CHART_CLS_ORDER = ['signal', 'spam_template', 'spam_duplicate', 'scam', 'recruitment', 'self_promo', 'noise'];

async function loadCharts() {
  try {
    var resp = await fetch(API_BASE + '/noise/charts');
    var json = await resp.json();
    if (!json.success) return;
    renderStackedBars(json.data.age_buckets);
    renderConcentration(json.data.spam_concentration);
    renderSlopFarms(json.data.slop_farms);
    renderSignalDistribution(json.data.signal_distribution);
    renderCleanestPosts(json.data.cleanest_posts);
    renderMostAttacked(json.data.most_attacked_posts);
  } catch (e) {
    console.error('loadCharts failed:', e);
  }
}

function renderStackedBars(buckets) {
  var card = document.getElementById('ageChartCard');
  var barsEl = document.getElementById('ageChartBars');
  var legendEl = document.getElementById('ageChartLegend');
  var subtitleEl = document.getElementById('ageChartSubtitle');
  if (!buckets || buckets.length === 0) return;

  var maxTotal = 0;
  var grandTotal = 0;
  for (var i = 0; i < buckets.length; i++) {
    if (buckets[i].total > maxTotal) maxTotal = buckets[i].total;
    grandTotal += buckets[i].total;
  }
  if (maxTotal === 0) return;

  subtitleEl.textContent = grandTotal.toLocaleString() + ' comments across ' + buckets.length + ' age ranges';
  barsEl.innerHTML = '';

  for (var i = 0; i < buckets.length; i++) {
    var bucket = buckets[i];
    var col = document.createElement('div');
    col.className = 'bar-column';

    var stack = document.createElement('div');
    stack.className = 'bar-stack';
    stack.style.height = (bucket.total / maxTotal * 100) + '%';

    for (var j = 0; j < CHART_CLS_ORDER.length; j++) {
      var cls = CHART_CLS_ORDER[j];
      var count = bucket.counts[cls] || 0;
      if (count === 0) continue;
      var seg = document.createElement('div');
      seg.className = 'bar-seg';
      seg.style.height = (count / bucket.total * 100) + '%';
      seg.style.background = CHART_CLS[cls].color;
      seg.title = CHART_CLS[cls].label + ': ' + count.toLocaleString();
      stack.appendChild(seg);
    }

    var label = document.createElement('div');
    label.className = 'bar-label';
    label.textContent = bucket.label;

    var total = document.createElement('div');
    total.className = 'bar-total';
    total.textContent = bucket.total.toLocaleString();

    col.appendChild(stack);
    col.appendChild(label);
    col.appendChild(total);
    barsEl.appendChild(col);
  }

  // Legend
  legendEl.innerHTML = '';
  var seenCls = {};
  for (var i = 0; i < buckets.length; i++) {
    for (var cls in buckets[i].counts) {
      if (buckets[i].counts[cls] > 0) seenCls[cls] = true;
    }
  }
  for (var j = 0; j < CHART_CLS_ORDER.length; j++) {
    var cls = CHART_CLS_ORDER[j];
    if (!seenCls[cls]) continue;
    var item = document.createElement('div');
    item.className = 'chart-legend-item';
    item.innerHTML = '<span class="chart-legend-dot" style="background:' + CHART_CLS[cls].color + '"></span>' + CHART_CLS[cls].label;
    legendEl.appendChild(item);
  }

  card.style.display = 'block';
}

function renderConcentration(data) {
  var card = document.getElementById('concentrationCard');
  var rowsEl = document.getElementById('concentrationRows');
  var footerEl = document.getElementById('concentrationFooter');
  if (!data) return;

  rowsEl.innerHTML = '';
  var rows = [
    { num: data.total_authors.toLocaleString(), label: 'distinct comment authors across ' + data.total_posts + ' analyzed posts', color: 'var(--text)' },
    { num: data.heavy_spammers.toLocaleString(), label: 'SlopFathers (100+ comments, 0 signal)', color: 'var(--red)' },
    { num: data.heavy_spammer_pct + '%', label: 'of all comments produced by SlopFathers', color: 'var(--orange)' }
  ];

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var row = document.createElement('div');
    row.className = 'concentration-row';
    row.innerHTML = '<div class="concentration-num" style="color:' + r.color + '">' + r.num + '</div><div class="concentration-label">' + r.label + '</div>';
    rowsEl.appendChild(row);
  }

  footerEl.textContent = data.total_comments.toLocaleString() + ' total comments classified';
  card.style.display = 'block';
}

function renderSlopFarms(data) {
  var card = document.getElementById('farmCard');
  var grid = document.getElementById('farmGrid');
  var details = document.getElementById('farmDetails');
  if (!data) return;

  grid.innerHTML = '';
  var stats = [
    { val: data.farm_count.toLocaleString(), label: 'Slop Farms Detected', color: 'var(--red)' },
    { val: data.total_agents.toLocaleString(), label: 'Farmed Agents in Farms', color: 'var(--orange)' },
    { val: data.total_comments.toLocaleString(), label: 'Farm Comments from Farms', color: 'var(--text)' },
    { val: data.comment_pct + '%', label: 'of All Comments', color: 'var(--orange)' }
  ];
  for (var i = 0; i < stats.length; i++) {
    var s = stats[i];
    var el = document.createElement('div');
    el.innerHTML = '<div class="farm-stat-val" style="color:' + s.color + '">' + s.val + '</div><div class="farm-stat-label">' + s.label + '</div>';
    grid.appendChild(el);
  }

  details.innerHTML = '';
  if (data.top_farms && data.top_farms.length > 0) {
    for (var j = 0; j < data.top_farms.length; j++) {
      var f = data.top_farms[j];
      var row = document.createElement('div');
      row.className = 'farm-detail-row';
      row.innerHTML = '<span class="farm-detail-rank">Farm #' + f.rank + '</span>' +
        '<span>' + f.agent_count + ' agents, ' + f.shared_templates + ' shared templates, ' + f.total_comments.toLocaleString() + ' total comments</span>';
      details.appendChild(row);
    }
  }

  card.style.display = 'block';
}

function renderSignalDistribution(buckets) {
  var card = document.getElementById('distroCard');
  var barsEl = document.getElementById('distroBars');
  var subtitleEl = document.getElementById('distroSubtitle');
  if (!buckets || buckets.length === 0) return;

  // Fill in all 10 buckets even if some are missing
  var ALL_BUCKETS = ['0-10%','10-20%','20-30%','30-40%','40-50%','50-60%','60-70%','70-80%','80-90%','90-100%'];
  var bucketMap = {};
  var totalPosts = 0;
  for (var i = 0; i < buckets.length; i++) {
    bucketMap[buckets[i].bucket] = buckets[i].post_count;
    totalPosts += buckets[i].post_count;
  }

  var maxCount = 0;
  for (var i = 0; i < ALL_BUCKETS.length; i++) {
    var c = bucketMap[ALL_BUCKETS[i]] || 0;
    if (c > maxCount) maxCount = c;
  }
  if (maxCount === 0) return;

  subtitleEl.textContent = totalPosts + ' posts by signal rate';
  barsEl.innerHTML = '';

  for (var i = 0; i < ALL_BUCKETS.length; i++) {
    var label = ALL_BUCKETS[i];
    var count = bucketMap[label] || 0;
    var pct = (count / maxCount * 100);
    // Color gradient: red for low signal, yellow for mid, green for high
    var colors = ['#dc2626','#ef4444','#f97316','#eab308','#a3e635','#84cc16','#22c55e','#22c55e','#16a34a','#16a34a'];
    var col = document.createElement('div');
    col.className = 'distro-col';
    var countEl = document.createElement('div');
    countEl.className = 'distro-bar-count';
    countEl.textContent = count > 0 ? count : '';
    var bar = document.createElement('div');
    bar.className = 'distro-bar';
    bar.style.height = Math.max(pct, count > 0 ? 3 : 0) + '%';
    bar.style.background = colors[i];
    bar.title = label + ': ' + count + ' posts';
    var labelEl = document.createElement('div');
    labelEl.className = 'distro-bar-label';
    labelEl.textContent = label;
    col.appendChild(countEl);
    col.appendChild(bar);
    col.appendChild(labelEl);
    barsEl.appendChild(col);
  }
  card.style.display = 'block';
}

function renderCleanestPosts(posts) {
  var card = document.getElementById('cleanestCard');
  var listEl = document.getElementById('cleanestList');
  if (!posts || posts.length === 0) return;

  listEl.innerHTML = '';
  var rankClasses = ['gold', 'silver', 'bronze', '', ''];
  for (var i = 0; i < posts.length; i++) {
    var p = posts[i];
    var item = document.createElement('a');
    item.className = 'leaderboard-item';
    item.href = '#';
    item.onclick = (function(postId) {
      return function(e) {
        e.preventDefault();
        document.getElementById('urlInput').value = postId;
        analyze();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
    })(p.post_id);
    item.innerHTML =
      '<div class="leaderboard-rank ' + (rankClasses[i] || '') + '">' + (i + 1) + '</div>' +
      '<div class="leaderboard-info">' +
        '<div class="leaderboard-title">' + escapeHtml(p.post_title) + '</div>' +
        '<div class="leaderboard-meta">by ' + escapeHtml(p.post_author) + ' &middot; ' + p.total_comments + ' comments &middot; ' + p.signal_count + ' signal</div>' +
      '</div>' +
      '<div class="leaderboard-stat">' +
        '<div class="leaderboard-stat-value" style="color:var(--green)">' + p.signal_rate + '%</div>' +
        '<div class="leaderboard-stat-label">signal</div>' +
      '</div>';
    listEl.appendChild(item);
  }
  card.style.display = 'block';
}

function renderMostAttacked(posts) {
  var card = document.getElementById('attackedCard');
  var listEl = document.getElementById('attackedList');
  if (!posts || posts.length === 0) return;

  listEl.innerHTML = '';
  for (var i = 0; i < posts.length; i++) {
    var p = posts[i];
    var scamTags = '';
    if (p.scam_signals && p.scam_signals.length > 0) {
      scamTags = '<div class="scam-tags">';
      for (var j = 0; j < p.scam_signals.length; j++) {
        scamTags += '<span class="scam-tag">' + escapeHtml(p.scam_signals[j]) + '</span>';
      }
      scamTags += '</div>';
    }
    var item = document.createElement('a');
    item.className = 'leaderboard-item';
    item.href = '#';
    item.onclick = (function(postId) {
      return function(e) {
        e.preventDefault();
        document.getElementById('urlInput').value = postId;
        analyze();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      };
    })(p.post_id);
    item.innerHTML =
      '<div class="leaderboard-rank" style="color:var(--dark-red)">' + (i + 1) + '</div>' +
      '<div class="leaderboard-info">' +
        '<div class="leaderboard-title">' + escapeHtml(p.post_title) + '</div>' +
        '<div class="leaderboard-meta">by ' + escapeHtml(p.post_author) + ' &middot; ' + p.total_comments + ' comments &middot; ' + p.signal_count + ' signal</div>' +
        scamTags +
      '</div>' +
      '<div class="leaderboard-stat">' +
        '<div class="leaderboard-stat-value" style="color:var(--dark-red)">' + p.scam_count + '</div>' +
        '<div class="leaderboard-stat-label">scams</div>' +
      '</div>';
    listEl.appendChild(item);
  }
  card.style.display = 'block';
}

// Enter key submits
document.getElementById('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') analyze();
});
</script>
</body>
</html>`;

// ============ Hits Dashboard Page ============

interface HitsData {
  totalHits: number;
  uniqueIpCount: number;
  topPaths: Array<[string, number]>;
  topIps: Array<[string, number]>;
  recent: Array<{ ip: string; time: string; method: string; path: string; status: number; bytes: number }>;
  hourBuckets: Array<[string, number]>;
  statusCounts: Array<[number, number]>;
}

function buildHitsPage(data: HitsData): string {
  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const pathRows = data.topPaths.map(([p, c]) =>
    `<tr><td>${escHtml(p)}</td><td class="num">${c.toLocaleString()}</td></tr>`
  ).join('');

  const ipRows = data.topIps.map(([ip, c]) =>
    `<tr><td><code>${escHtml(ip)}</code></td><td class="num">${c.toLocaleString()}</td></tr>`
  ).join('');

  const recentRows = data.recent.map(e =>
    `<tr><td class="mono">${escHtml(e.time)}</td><td><code>${escHtml(e.ip)}</code></td><td>${e.method}</td><td>${escHtml(e.path)}</td><td class="status-${Math.floor(e.status / 100)}">${e.status}</td></tr>`
  ).join('');

  const statusRows = data.statusCounts.map(([s, c]) =>
    `<span class="status-badge status-${Math.floor(s / 100)}">${s}: ${c.toLocaleString()}</span>`
  ).join(' ');

  const maxBucket = Math.max(...data.hourBuckets.map(([, c]) => c), 1);
  const chartBars = data.hourBuckets.map(([label, count]) => {
    const pct = Math.round((count / maxBucket) * 100);
    const shortLabel = label.split(':')[1] || label.slice(-2);
    return `<div class="bar-col"><div class="bar" style="height:${pct}%" title="${label}: ${count} hits"></div><div class="bar-label">${shortLabel}h</div></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sanctuary — Site Analytics</title>
<style>
  :root { --bg: #0a0b0f; --surface: #13151c; --border: #1f2231; --text: #e2e4e9; --muted: #8b8fa3; --accent: #6366f1; --green: #22c55e; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 32px 24px; }
  .wrap { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  .subtitle { color: var(--muted); font-size: 14px; margin-bottom: 32px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
  .card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .card .val { font-size: 32px; font-weight: 700; }
  .card .val.green { color: var(--green); }
  .card .val.accent { color: var(--accent); }
  .section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
  .section h2 { font-size: 16px; margin-bottom: 14px; color: var(--text); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.03); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: monospace; font-size: 12px; }
  code { font-size: 12px; color: var(--accent); }
  .status-2 { color: var(--green); }
  .status-3 { color: #eab308; }
  .status-4 { color: #f97316; }
  .status-5 { color: #ef4444; }
  .status-badge { display: inline-block; padding: 3px 10px; border-radius: 8px; font-size: 12px; font-weight: 600; background: rgba(255,255,255,0.05); margin: 2px; }
  .chart-wrap { display: flex; align-items: flex-end; gap: 2px; height: 120px; padding-top: 8px; }
  .bar-col { display: flex; flex-direction: column; align-items: center; flex: 1; height: 100%; justify-content: flex-end; }
  .bar { width: 100%; min-width: 4px; background: var(--accent); border-radius: 2px 2px 0 0; transition: height 0.2s; min-height: 2px; }
  .bar:hover { background: var(--green); }
  .bar-label { font-size: 8px; color: var(--muted); margin-top: 4px; }
  .scroll-table { max-height: 400px; overflow-y: auto; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Site Analytics</h1>
  <p class="subtitle">Parsed from nginx access log &middot; current log file only</p>

  <div class="cards">
    <div class="card"><div class="label">Total Hits</div><div class="val">${data.totalHits.toLocaleString()}</div></div>
    <div class="card"><div class="label">Unique IPs</div><div class="val green">${data.uniqueIpCount.toLocaleString()}</div></div>
    <div class="card"><div class="label">Status Codes</div><div style="margin-top:8px">${statusRows}</div></div>
  </div>

  <div class="section">
    <h2>Hits by Hour</h2>
    <div class="chart-wrap">${chartBars}</div>
  </div>

  <div class="section">
    <h2>Top Paths</h2>
    <table><thead><tr><th>Path</th><th style="text-align:right">Hits</th></tr></thead><tbody>${pathRows}</tbody></table>
  </div>

  <div class="section">
    <h2>Top IPs</h2>
    <table><thead><tr><th>IP Address</th><th style="text-align:right">Hits</th></tr></thead><tbody>${ipRows}</tbody></table>
  </div>

  <div class="section">
    <h2>Recent Requests</h2>
    <div class="scroll-table">
      <table><thead><tr><th>Time</th><th>IP</th><th>Method</th><th>Path</th><th>Status</th></tr></thead><tbody>${recentRows}</tbody></table>
    </div>
  </div>
</div>
</body>
</html>`;
}
