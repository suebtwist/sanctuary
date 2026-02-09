/**
 * Sanctuary Noise Filter — Popup Script
 */

const API_BASE = 'https://api.sanctuary-ops.xyz';
const CATEGORY_LABELS = {
  signal: 'signal',
  spam_template: 'template',
  spam_duplicate: 'duplicate',
  scam: 'scam',
  recruitment: 'recruitment',
  self_promo: 'promo',
  noise: 'noise',
};

async function init() {
  const loading = document.getElementById('loading');
  const postSection = document.getElementById('postAnalysis');
  const statsSection = document.getElementById('stats');

  try {
    // Check if we're on a Moltbook post page
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    const match = url.match(/moltbook\.com\/post\/([0-9a-f-]+)/i);

    if (match) {
      // On a Moltbook post page — check cache first, then show analysis
      const postId = match[1];
      const cacheKey = `snf_${postId}`;

      // Try cache
      const cached = await chrome.storage.local.get(cacheKey);
      let data = cached[cacheKey]?.data;

      if (!data) {
        loading.textContent = 'Analyzing...';
        const resp = await fetch(`${API_BASE}/noise/analyze?post_id=${encodeURIComponent(postId)}`);
        const json = await resp.json();
        if (json.success) {
          data = json.data;
        }
      }

      if (data) {
        renderPostAnalysis(data);
        loading.style.display = 'none';
        postSection.style.display = 'block';
      } else {
        loading.textContent = 'Could not analyze this post';
      }
    } else {
      // Not on a Moltbook post — show aggregate stats
      loading.textContent = 'Loading stats...';
      const resp = await fetch(`${API_BASE}/noise/stats`);
      const json = await resp.json();

      if (json.success && json.data.total_posts_analyzed > 0) {
        renderStats(json.data);
        loading.style.display = 'none';
        statsSection.style.display = 'block';
      } else {
        loading.textContent = 'No analysis data yet';
      }
    }
  } catch (err) {
    console.error('[Sanctuary Popup]', err);
    loading.textContent = 'Could not connect to API';
  }
}

function renderPostAnalysis(data) {
  document.getElementById('postTitle').textContent = data.post_title || 'Untitled Post';
  document.getElementById('signalCount').textContent = `${data.signal_count}/${data.total_comments}`;
  document.getElementById('barFill').style.width = `${Math.round(data.signal_rate * 100)}%`;
  document.getElementById('signalRate').textContent = `${Math.round(data.signal_rate * 100)}%`;

  const bd = document.getElementById('breakdown');
  bd.innerHTML = '';
  for (const [cat, count] of Object.entries(data.summary)) {
    if (count === 0) continue;
    const el = document.createElement('span');
    el.className = 'breakdown-item';
    el.innerHTML = `<span class="dot dot-${cat}"></span>${count} ${CATEGORY_LABELS[cat] || cat}`;
    bd.appendChild(el);
  }
}

function renderStats(data) {
  document.getElementById('totalPosts').textContent = data.total_posts_analyzed;
  document.getElementById('totalComments').textContent = data.total_comments_analyzed;
  document.getElementById('avgRate').textContent = `${Math.round(data.avg_signal_rate * 100)}%`;
}

init();
