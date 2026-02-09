/**
 * Noise Filter Routes
 *
 * Public endpoints for analyzing Moltbook post comments.
 * No authentication required.
 */

import { FastifyInstance } from 'fastify';
import { analyzePost, PostAnalysis, CLASSIFIER_VERSION } from '../services/noise-classifier.js';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';

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
    const analyses = db.getAllNoiseAnalyses();
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

    let totalComments = 0;
    let totalSignal = 0;
    let worstRate = 1;
    let bestRate = 0;
    let sumRate = 0;

    for (const row of analyses) {
      try {
        const parsed = JSON.parse(row.result_json) as PostAnalysis;
        totalComments += parsed.total_comments;
        totalSignal += parsed.signal_count;
        const rate = parsed.signal_rate;
        if (rate < worstRate) worstRate = rate;
        if (rate > bestRate) bestRate = rate;
        sumRate += rate;
      } catch {
        // skip corrupted entries
      }
    }

    const data: NoiseStats = {
      total_posts_analyzed: analyses.length,
      total_comments_analyzed: totalComments,
      overall_signal_rate: totalComments > 0 ? Math.round((totalSignal / totalComments) * 100) / 100 : 0,
      avg_signal_rate: analyses.length > 0 ? Math.round((sumRate / analyses.length) * 100) / 100 : 0,
      worst_signal_rate: analyses.length > 0 ? worstRate : 0,
      best_signal_rate: bestRate,
      by_classification: byClassification,
      top_template_phrases: topTemplates.map(t => ({ text: t.normalized_text, count: t.seen_count })),
      classifier_version: CLASSIFIER_VERSION,
      last_updated: new Date().toISOString(),
    };

    statsCache = { data, expiresAt: now + STATS_CACHE_TTL_MS };

    return reply.send({ success: true, data });
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
   * GET /noise/page
   *
   * Serves the web fallback HTML page for URL-based analysis.
   */
  fastify.get('/page', async (_request, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(NOISE_PAGE_HTML);
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
  .dot-spam_template, .dot-spam_duplicate { background: var(--red); }
  .dot-scam { background: var(--yellow); }
  .dot-recruitment, .dot-self_promo { background: var(--orange); }
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
  .filter-btn.active[data-filter="suspicious"] { background: var(--orange); border-color: var(--orange); }
  .filter-btn.active[data-filter="spam"] { background: var(--red); border-color: var(--red); }
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
  .comment-item[data-cat="spam_template"],
  .comment-item[data-cat="noise"],
  .comment-item[data-cat="self_promo"] { border-left-color: var(--orange); }
  .comment-item[data-cat="spam_duplicate"],
  .comment-item[data-cat="recruitment"],
  .comment-item[data-cat="scam"] { border-left-color: var(--red); }
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
  .tag-spam_template, .tag-spam_duplicate { background: rgba(239,68,68,0.15); color: var(--red); }
  .tag-scam { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .tag-recruitment, .tag-self_promo { background: rgba(249,115,22,0.15); color: var(--orange); }
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
  .stats-btn {
    display: inline-block; padding: 10px 24px;
    border-radius: 8px; border: 1px solid var(--accent);
    background: rgba(99,102,241,0.12); color: var(--accent); font-size: 14px;
    font-weight: 600; cursor: pointer; text-decoration: none; transition: all 0.15s;
    letter-spacing: 0.3px;
  }
  .stats-btn:hover { background: rgba(99,102,241,0.25); color: white; border-color: var(--accent); }
  @media (max-width: 768px) {
    .stacked-bar-container { height: 160px; }
    .concentration-num { font-size: 36px; min-width: 60px; }
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
        <button class="filter-btn" data-filter="suspicious" onclick="toggleFilter('suspicious', this)">Suspicious</button>
        <button class="filter-btn" data-filter="spam" onclick="toggleFilter('spam', this)">Spam</button>
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
    <div id="statsLoading" style="text-align:center;padding:20px;color:var(--text-muted);font-size:14px;">Loading stats...</div>
    <div id="statsError" style="display:none;text-align:center;padding:20px;color:var(--red);font-size:14px;"></div>
    <div class="stats-grid" id="statsGrid"></div>
    <div class="cls-bar-container" id="clsBarContainer" style="display:none;">
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
      <div class="concentration-header">Spam Concentration</div>
      <div id="concentrationRows"></div>
      <div class="concentration-footer" id="concentrationFooter"></div>
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
    signal: 'real', spam_template: 'generic', spam_duplicate: 'duplicate',
    scam: 'scam', recruitment: 'recruitment', self_promo: 'promo', noise: 'noise'
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
          '<span class="comment-tag tag-' + c.classification + '">' + c.classification.replace('_', ' ') + '</span>' +
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

function getCssVar(cat) {
  const map = { signal:'green', spam_template:'red', spam_duplicate:'red', scam:'yellow', recruitment:'orange', self_promo:'orange', noise:'gray' };
  return map[cat] || 'gray';
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

const FILTER_GROUPS = {
  signal: ['signal'],
  suspicious: ['spam_template', 'noise', 'self_promo'],
  spam: ['spam_duplicate', 'recruitment', 'scam'],
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

const SORT_ORDER = { signal: 0, spam_template: 1, noise: 1, self_promo: 1, spam_duplicate: 2, recruitment: 2, scam: 2 };

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
  signal: 'var(--green)', generic: 'var(--red)', duplicate: 'var(--red)',
  scam: 'var(--yellow)', recruitment: 'var(--orange)', promo: 'var(--orange)', noise: 'var(--gray)'
};
const CLS_LABELS = {
  signal: 'Signal', generic: 'Generic', duplicate: 'Duplicate',
  scam: 'Scam', recruitment: 'Recruitment', promo: 'Self-promo', noise: 'Noise'
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

    // Classification breakdown bar
    if (d.by_classification) {
      const total = Object.values(d.by_classification).reduce(function(a, b) { return a + b; }, 0);
      if (total > 0) {
        var bar = document.getElementById('clsBar');
        var legend = document.getElementById('clsLegend');
        bar.innerHTML = '';
        legend.innerHTML = '';
        // Sort: signal first, then by count descending
        var entries = Object.entries(d.by_classification).sort(function(a, b) {
          if (a[0] === 'signal') return -1;
          if (b[0] === 'signal') return 1;
          return b[1] - a[1];
        });
        for (var i = 0; i < entries.length; i++) {
          var cls = entries[i][0], count = entries[i][1];
          var pct = (count / total * 100);
          if (pct < 0.5) continue;
          var seg = document.createElement('div');
          seg.className = 'cls-bar-seg';
          seg.style.width = pct + '%';
          seg.style.background = CLS_COLORS[cls] || 'var(--gray)';
          seg.title = (CLS_LABELS[cls] || cls) + ': ' + count.toLocaleString() + ' (' + pct.toFixed(1) + '%)';
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
  spam_template: { color: 'var(--red)', label: 'Generic' },
  spam_duplicate: { color: '#dc2626', label: 'Duplicate' },
  scam: { color: 'var(--yellow)', label: 'Scam' },
  recruitment: { color: 'var(--orange)', label: 'Recruitment' },
  self_promo: { color: '#fb923c', label: 'Self-promo' },
  noise: { color: 'var(--gray)', label: 'Noise' }
};
var CHART_CLS_ORDER = ['signal', 'spam_template', 'spam_duplicate', 'scam', 'recruitment', 'self_promo', 'noise'];

async function loadCharts() {
  try {
    var resp = await fetch(API_BASE + '/noise/charts');
    var json = await resp.json();
    if (!json.success) return;
    renderStackedBars(json.data.age_buckets);
    renderConcentration(json.data.spam_concentration);
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
    { num: data.heavy_spammers.toLocaleString(), label: 'heavy spammers (100+ comments, 0 signal)', color: 'var(--red)' },
    { num: data.heavy_spammer_pct + '%', label: 'of all comments produced by heavy spammers', color: 'var(--orange)' }
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

// Enter key submits
document.getElementById('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') analyze();
});
</script>
</body>
</html>`;
