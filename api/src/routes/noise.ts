/**
 * Noise Filter Routes
 *
 * Public endpoints for analyzing Moltbook post comments.
 * No authentication required.
 */

import { FastifyInstance } from 'fastify';
import { analyzePost, PostAnalysis } from '../services/noise-classifier.js';
import { getDb } from '../db/index.js';

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
  top_template_phrases: Array<{ text: string; count: number }>;
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
      top_template_phrases: topTemplates.map(t => ({ text: t.normalized_text, count: t.seen_count })),
      last_updated: new Date().toISOString(),
    };

    statsCache = { data, expiresAt: now + STATS_CACHE_TTL_MS };

    return reply.send({ success: true, data });
  });

  /**
   * GET /noise/benchmark
   *
   * Signal rate vs post age benchmark. Cached for 5 minutes.
   */
  fastify.get('/benchmark', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');

    const db = getDb();
    const rows = db.getAllScanStats();

    if (rows.length < 5) {
      return reply.send({ total_posts_scanned: rows.length, insufficient_data: true });
    }

    const nowMs = Date.now();
    const BUCKETS = [
      { label: '<1h',  min: 0,   max: 1 },
      { label: '6h',   min: 1,   max: 6 },
      { label: '24h',  min: 6,   max: 24 },
      { label: '2d',   min: 24,  max: 48 },
      { label: '3d',   min: 48,  max: 72 },
      { label: '4d',   min: 72,  max: 96 },
      { label: '5d',   min: 96,  max: 120 },
      { label: '6d',   min: 120, max: 144 },
      { label: '7d',   min: 144, max: 168 },
      { label: '8d',   min: 168, max: 192 },
      { label: '9d',   min: 192, max: 216 },
      { label: '10d',  min: 216, max: 240 },
      { label: '11d',  min: 240, max: 264 },
      { label: '12d',  min: 264, max: 288 },
      { label: '13d',  min: 288, max: 312 },
      { label: '14d',  min: 312, max: 336 },
      { label: '21d',  min: 336, max: 504 },
      { label: '30d',  min: 504, max: 720 },
      { label: '30d+', min: 720, max: Infinity },
    ];

    const bucketData: Map<string, { rates: number[]; comments: number[] }> = new Map();
    for (const b of BUCKETS) bucketData.set(b.label, { rates: [], comments: [] });

    let overallSum = 0;
    for (const row of rows) {
      const createdMs = new Date(row.post_created_at).getTime();
      if (isNaN(createdMs)) continue;
      const ageHours = (nowMs - createdMs) / 3_600_000;
      for (const b of BUCKETS) {
        if (ageHours >= b.min && ageHours < b.max) {
          const bd = bucketData.get(b.label)!;
          bd.rates.push(row.signal_rate);
          bd.comments.push(row.comments_analyzed);
          break;
        }
      }
      overallSum += row.signal_rate;
    }

    const buckets = [];
    for (const b of BUCKETS) {
      const bd = bucketData.get(b.label)!;
      if (bd.rates.length < 2) continue;
      buckets.push({
        label: b.label,
        min_age_hours: b.min,
        max_age_hours: b.max === Infinity ? null : b.max,
        avg_signal_rate: Math.round((bd.rates.reduce((a, c) => a + c, 0) / bd.rates.length) * 100) / 100,
        post_count: bd.rates.length,
        avg_comments: Math.round(bd.comments.reduce((a, c) => a + c, 0) / bd.comments.length),
      });
    }

    return reply.send({
      total_posts_scanned: rows.length,
      generated_at: new Date().toISOString(),
      overall_avg_signal_rate: Math.round((overallSum / rows.length) * 100) / 100,
      buckets,
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
    display: flex; gap: 12px; margin-bottom: 32px;
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
  .benchmark-section { display: none; margin-bottom: 20px; }
  .benchmark-toggle {
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 0; cursor: pointer; color: var(--text-muted); font-size: 13px;
    border-bottom: 1px solid var(--border); user-select: none;
  }
  .benchmark-toggle:hover { color: var(--text); }
  .benchmark-chevron { transition: transform 0.2s; font-size: 11px; }
  .benchmark-chevron.open { transform: rotate(90deg); }
  .benchmark-body {
    max-height: 0; overflow: hidden; transition: max-height 0.3s ease;
  }
  .benchmark-body.open { max-height: 400px; }
  .benchmark-inner { padding: 16px 0 8px; }
  .benchmark-chart { width: 100%; height: 190px; }
  .benchmark-context {
    font-size: 12px; color: var(--text-muted); margin-top: 10px; line-height: 1.5;
  }
  .benchmark-stats { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
  @media (max-width: 768px) {
    .benchmark-chart { height: 150px; }
    .benchmark-body.open { max-height: 360px; }
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

    <div class="benchmark-section" id="benchmarkSection">
      <div class="benchmark-toggle" onclick="toggleBenchmark()">
        <span id="benchmarkLabel"></span>
        <span class="benchmark-chevron" id="benchmarkChevron">&#9656;</span>
      </div>
      <div class="benchmark-body" id="benchmarkBody">
        <div class="benchmark-inner">
          <svg class="benchmark-chart" id="benchmarkChart"></svg>
          <div class="benchmark-context">Signal rates tend to increase as posts age. Spam clusters early; real engagement accumulates.</div>
          <div class="benchmark-stats" id="benchmarkStats"></div>
        </div>
      </div>
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

  <div class="stats-section" id="statsSection" style="display:none;">
    <h3>Platform Stats</h3>
    <div class="stats-grid" id="statsGrid"></div>
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

// Load stats on page load
loadStats();

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

    // Load benchmark in background (non-blocking)
    loadBenchmark(json.data);

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
    signal: 'real', spam_template: 'template', spam_duplicate: 'duplicate',
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

async function loadStats() {
  try {
    const resp = await fetch(API_BASE + '/noise/stats');
    const json = await resp.json();
    if (!json.success || json.data.total_posts_analyzed === 0) return;

    const d = json.data;
    const grid = document.getElementById('statsGrid');
    grid.innerHTML = '';
    const items = [
      [d.total_posts_analyzed, 'Posts Analyzed'],
      [d.total_comments_analyzed, 'Comments Scanned'],
      [Math.round(d.avg_signal_rate * 100) + '%', 'Avg Signal Rate'],
      [Math.round(d.overall_signal_rate * 100) + '%', 'Overall Signal'],
    ];
    for (const [val, label] of items) {
      const el = document.createElement('div');
      el.className = 'stat-card';
      el.innerHTML = '<div class="stat-value">' + val + '</div><div class="stat-label">' + label + '</div>';
      grid.appendChild(el);
    }
    document.getElementById('statsSection').style.display = 'block';
  } catch {}
}

function copyShare() {
  const text = document.getElementById('shareText').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = event.target;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy link'; }, 1500);
  }).catch(() => {});
}

// ============ Benchmark ============
let benchmarkCache = null;
let benchmarkOpen = false;

function toggleBenchmark() {
  benchmarkOpen = !benchmarkOpen;
  document.getElementById('benchmarkBody').classList.toggle('open', benchmarkOpen);
  document.getElementById('benchmarkChevron').classList.toggle('open', benchmarkOpen);
}

function getPostAgeLabel(ms) {
  var h = ms / 3600000;
  if (h < 1) return Math.round(h * 60) + ' minutes old';
  if (h < 24) return Math.round(h) + ' hours old';
  var d = h / 24;
  if (d < 7) return Math.round(d) + ' days old';
  if (d < 30) return Math.round(d / 7) + ' weeks old';
  return Math.round(d / 30) + ' months old';
}

async function loadBenchmark(postData) {
  var section = document.getElementById('benchmarkSection');
  section.style.display = 'none';
  if (!postData.post_created_at) return;

  try {
    if (!benchmarkCache) {
      var resp = await fetch(API_BASE + '/noise/benchmark');
      var json = await resp.json();
      if (json.insufficient_data) return;
      benchmarkCache = json;
    }
    var bm = benchmarkCache;
    if (!bm.buckets || bm.buckets.length === 0) return;

    document.getElementById('benchmarkLabel').textContent =
      '\\u{1F4CA} Signal vs Post Age \\u2014 ' + bm.total_posts_scanned + ' posts analyzed';
    section.style.display = 'block';

    // Current post age
    var postAgeMs = Date.now() - new Date(postData.post_created_at).getTime();
    var postAgeHours = postAgeMs / 3600000;
    var postRate = postData.signal_rate;

    // Stats line
    document.getElementById('benchmarkStats').textContent =
      'Based on ' + bm.total_posts_scanned + ' posts analyzed. \\u25CF This post: ' +
      getPostAgeLabel(postAgeMs) + ', ' + Math.round(postRate * 100) + '% signal';

    renderBenchmarkChart(bm.buckets, postAgeHours, postRate);
  } catch (e) { /* hide silently */ }
}

function renderBenchmarkChart(buckets, postAgeH, postRate) {
  var svg = document.getElementById('benchmarkChart');
  var W = svg.clientWidth || 700;
  var H = svg.clientHeight || 190;
  var pad = { t: 20, r: 20, b: 36, l: 44 };
  var cW = W - pad.l - pad.r;
  var cH = H - pad.t - pad.b;

  // Map bucket labels to x positions (midpoint in hours, log-ish scale)
  var mids = buckets.map(function(b) {
    var lo = b.min_age_hours;
    var hi = b.max_age_hours != null ? b.max_age_hours : lo * 2;
    return (lo + hi) / 2;
  });
  var xMin = mids[0], xMax = mids[mids.length - 1];
  var xRange = xMax - xMin || 1;
  function xPos(h) { return pad.l + ((h - xMin) / xRange) * cW; }
  function yPos(r) { return pad.t + (1 - r) * cH; }

  var lines = '';
  // Gridlines
  [0, 0.25, 0.5, 0.75, 1].forEach(function(r) {
    var y = yPos(r);
    lines += '<line x1="' + pad.l + '" y1="' + y + '" x2="' + (W - pad.r) + '" y2="' + y +
      '" stroke="' + (r === 0 ? 'var(--border)' : 'rgba(255,255,255,0.05)') + '" stroke-width="1"/>';
    lines += '<text x="' + (pad.l - 6) + '" y="' + (y + 4) +
      '" fill="var(--text-muted)" font-size="10" text-anchor="end">' + Math.round(r * 100) + '%</text>';
  });

  // X labels — thin when crowded to avoid overlap
  var labelStep = buckets.length > 12 ? 3 : buckets.length > 8 ? 2 : 1;
  buckets.forEach(function(b, i) {
    // Always show first, last, and every Nth label
    if (i > 0 && i < buckets.length - 1 && i % labelStep !== 0) return;
    lines += '<text x="' + xPos(mids[i]) + '" y="' + (H - 6) +
      '" fill="var(--text-muted)" font-size="10" text-anchor="middle">' + b.label + '</text>';
  });

  // Data line
  var pts = buckets.map(function(b, i) { return xPos(mids[i]) + ',' + yPos(b.avg_signal_rate); });
  lines += '<polyline points="' + pts.join(' ') +
    '" fill="none" stroke="var(--green)" stroke-width="2" stroke-linejoin="round"/>';

  // Data dots + invisible hover targets
  buckets.forEach(function(b, i) {
    var cx = xPos(mids[i]), cy = yPos(b.avg_signal_rate);
    lines += '<circle cx="' + cx + '" cy="' + cy + '" r="4" fill="var(--green)" stroke="var(--bg)" stroke-width="2"/>';
    lines += '<circle cx="' + cx + '" cy="' + cy +
      '" r="14" fill="transparent" stroke="none"><title>Posts aged ' + b.label + ': ' +
      Math.round(b.avg_signal_rate * 100) + '% avg signal (' + b.post_count + ' posts)</title></circle>';
  });

  // Current post marker — interpolate x from age
  var postX = Math.max(pad.l, Math.min(W - pad.r, xPos(postAgeH)));
  // Interpolate y along the line
  var postLineY = yPos(postRate);
  // Find the interpolated benchmark rate at this age for the dashed line
  var interpRate = null;
  for (var i = 0; i < mids.length - 1; i++) {
    if (postAgeH >= mids[i] && postAgeH <= mids[i + 1]) {
      var t = (postAgeH - mids[i]) / (mids[i + 1] - mids[i]);
      interpRate = buckets[i].avg_signal_rate + t * (buckets[i + 1].avg_signal_rate - buckets[i].avg_signal_rate);
      break;
    }
  }
  if (interpRate === null) {
    interpRate = postAgeH <= mids[0] ? buckets[0].avg_signal_rate : buckets[buckets.length - 1].avg_signal_rate;
  }

  // Dashed line at this post's rate if different from benchmark
  if (Math.abs(postRate - interpRate) > 0.08) {
    var dashY = yPos(postRate);
    lines += '<line x1="' + pad.l + '" y1="' + dashY + '" x2="' + (W - pad.r) + '" y2="' + dashY +
      '" stroke="rgba(255,255,255,0.15)" stroke-width="1" stroke-dasharray="4,4"/>';
  }

  // Current post dot (glow ring)
  lines += '<circle cx="' + postX + '" cy="' + yPos(interpRate) +
    '" r="8" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2"/>';
  lines += '<circle cx="' + postX + '" cy="' + yPos(interpRate) +
    '" r="5" fill="white" stroke="var(--bg)" stroke-width="2">' +
    '<title>This post: ' + Math.round(postRate * 100) + '% signal</title></circle>';

  svg.innerHTML = lines;
}

// Enter key submits
document.getElementById('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') analyze();
});
</script>
</body>
</html>`;
