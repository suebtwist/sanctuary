/**
 * Sanctuary Noise Filter — Content Script
 *
 * Runs on moltbook.com/post/* pages.
 * Extracts post ID, calls Sanctuary API, injects analysis overlay.
 */

(function () {
  'use strict';

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
  const SPAM_CATS = ['spam_template', 'spam_duplicate', 'scam', 'recruitment'];

  let analysisData = null;
  let currentFilter = 'all';

  // ============ Extract Post ID ============

  function getPostId() {
    const path = window.location.pathname;
    const match = path.match(/\/post\/([0-9a-f-]+)/i);
    return match ? match[1] : null;
  }

  // ============ API Call ============

  async function fetchAnalysis(postId) {
    const url = `${API_BASE}/noise/analyze?post_id=${encodeURIComponent(postId)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }
    const json = await response.json();
    if (!json.success) {
      throw new Error(json.error || 'Analysis failed');
    }
    return json.data;
  }

  // ============ Find Comments Section ============

  function findCommentsContainer() {
    // Strategy 1: look for common comment section identifiers
    const selectors = [
      '[data-testid="comments"]',
      '[data-testid="comment-list"]',
      '.comments-section',
      '.comment-list',
      '#comments',
      // Strategy 2: look for elements that contain multiple comment-like items
      '[class*="comment" i]',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    // Strategy 3: heuristic — find the largest list of repeated sibling elements
    // that appear below the main post content
    const allLists = document.querySelectorAll('ul, ol, div');
    let bestCandidate = null;
    let bestCount = 0;

    for (const list of allLists) {
      const children = list.children;
      if (children.length >= 3) {
        // Check if children look like comments (have text content and are similar)
        let commentLike = 0;
        for (const child of children) {
          const text = child.textContent?.trim() || '';
          if (text.length > 10 && text.length < 5000) {
            commentLike++;
          }
        }
        if (commentLike > bestCount) {
          bestCount = commentLike;
          bestCandidate = list;
        }
      }
    }

    return bestCandidate;
  }

  // ============ Find Individual Comments ============

  function findCommentElements(container) {
    if (!container) return [];

    // Try specific selectors first
    const selectors = [
      '[data-testid="comment"]',
      '.comment',
      '[class*="comment-item"]',
      '[class*="CommentItem"]',
    ];

    for (const sel of selectors) {
      const elements = container.querySelectorAll(sel);
      if (elements.length > 0) return Array.from(elements);
    }

    // Fallback: direct children of the container
    return Array.from(container.children).filter(el => {
      const text = el.textContent?.trim() || '';
      return text.length > 5;
    });
  }

  // ============ Match Comment Elements to API Data ============

  function matchCommentToElement(el) {
    if (!analysisData) return null;

    // Extract text from the element
    const elText = (el.textContent || '').trim();
    const elTextNorm = elText.toLowerCase().replace(/\s+/g, ' ').slice(0, 200);

    // Try to find the author name
    const authorEl = el.querySelector('a[href*="/agent/"], a[href*="/user/"], a[href*="/profile/"]');
    const authorName = authorEl ? authorEl.textContent?.trim() : '';

    let bestMatch = null;
    let bestScore = 0;

    for (const comment of analysisData.comments) {
      let score = 0;
      const commentNorm = comment.text.toLowerCase().replace(/\s+/g, ' ').slice(0, 200);

      // Author name match
      if (authorName && comment.author && authorName.toLowerCase() === comment.author.toLowerCase()) {
        score += 3;
      }

      // Text similarity: check if first 80 chars of comment appear in element text
      const prefix = commentNorm.slice(0, 80);
      if (prefix.length > 10 && elTextNorm.includes(prefix)) {
        score += 5;
      }

      // Partial word overlap
      const commentWords = new Set(commentNorm.split(' ').filter(w => w.length > 3));
      const elWords = elTextNorm.split(' ').filter(w => w.length > 3);
      let overlap = 0;
      for (const w of elWords) {
        if (commentWords.has(w)) overlap++;
      }
      if (commentWords.size > 0) {
        score += (overlap / commentWords.size) * 2;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = comment;
      }
    }

    // Require minimum confidence in the match
    return bestScore >= 3 ? bestMatch : null;
  }

  // ============ Inject Banner ============

  function createBanner(data) {
    const banner = document.createElement('div');
    banner.className = 'snf-banner';
    banner.id = 'snf-banner';

    const rate = Math.round(data.signal_rate * 100);

    let breakdownHtml = '';
    for (const [cat, count] of Object.entries(data.summary)) {
      if (count === 0) continue;
      breakdownHtml += `
        <span class="snf-breakdown-item">
          <span class="snf-dot snf-dot-${cat}"></span>
          ${count} ${CATEGORY_LABELS[cat] || cat}
        </span>`;
    }

    banner.innerHTML = `
      <div class="snf-banner-header">
        &#x1F6E1; Sanctuary Noise Filter
      </div>
      <div class="snf-signal-row">
        <span class="snf-signal-label">Signal: <strong>${data.signal_count}/${data.total_comments}</strong></span>
        <div class="snf-signal-bar">
          <div class="snf-signal-bar-fill" style="width: ${rate}%"></div>
        </div>
        <span class="snf-signal-rate">${rate}%</span>
      </div>
      <div class="snf-breakdown">${breakdownHtml}</div>
      <div class="snf-filters">
        <button class="snf-filter-btn snf-active" data-filter="all">Show all</button>
        <button class="snf-filter-btn" data-filter="signal">Signal only</button>
        <button class="snf-filter-btn" data-filter="hide-spam">Hide spam</button>
      </div>
    `;

    // Wire up filter buttons
    banner.querySelectorAll('.snf-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        banner.querySelectorAll('.snf-filter-btn').forEach(b => b.classList.remove('snf-active'));
        btn.classList.add('snf-active');
        currentFilter = btn.dataset.filter;
        applyFilter();
      });
    });

    return banner;
  }

  // ============ Annotate Comments ============

  function annotateComments(commentElements) {
    for (const el of commentElements) {
      const match = matchCommentToElement(el);
      if (!match) continue;

      // Tag the element with classification data
      el.setAttribute('data-snf-cat', match.classification);

      // Add badge
      const badge = document.createElement('span');
      badge.className = `snf-badge snf-badge-${match.classification}`;
      badge.textContent = CATEGORY_LABELS[match.classification] || match.classification;

      // Try to find the best place to insert the badge (near author name or at the top)
      const authorEl = el.querySelector('a[href*="/agent/"], a[href*="/user/"], a[href*="/profile/"]');
      if (authorEl && authorEl.parentElement) {
        authorEl.parentElement.appendChild(badge);
      } else {
        // Insert at the beginning of the comment
        el.insertBefore(badge, el.firstChild);
      }
    }
  }

  // ============ Apply Filter ============

  function applyFilter() {
    const commentElements = document.querySelectorAll('[data-snf-cat]');

    // Remove any existing collapsed notices
    document.querySelectorAll('.snf-collapsed-notice').forEach(n => n.remove());

    let hiddenCount = 0;

    commentElements.forEach(el => {
      const cat = el.getAttribute('data-snf-cat');
      let hide = false;

      if (currentFilter === 'signal') {
        hide = cat !== 'signal';
      } else if (currentFilter === 'hide-spam') {
        hide = SPAM_CATS.includes(cat);
      }

      if (hide) {
        el.classList.add('snf-hidden');
        hiddenCount++;
      } else {
        el.classList.remove('snf-hidden');
      }
    });

    // Add collapsed notice if comments were hidden
    if (hiddenCount > 0) {
      const container = findCommentsContainer();
      if (container) {
        const notice = document.createElement('div');
        notice.className = 'snf-collapsed-notice';
        notice.textContent = `${hiddenCount} comment${hiddenCount > 1 ? 's' : ''} hidden by Sanctuary Noise Filter — click to show`;
        notice.addEventListener('click', () => {
          // Switch to "show all" filter
          currentFilter = 'all';
          document.querySelectorAll('.snf-filter-btn').forEach(b => {
            b.classList.toggle('snf-active', b.dataset.filter === 'all');
          });
          applyFilter();
        });
        container.prepend(notice);
      }
    }
  }

  // ============ Main ============

  async function main() {
    const postId = getPostId();
    if (!postId) {
      console.log('[Sanctuary] No post ID found in URL');
      return;
    }

    console.log(`[Sanctuary] Analyzing post ${postId}...`);

    // Show loading indicator
    const commentsContainer = findCommentsContainer();
    let loadingEl = null;
    if (commentsContainer) {
      loadingEl = document.createElement('div');
      loadingEl.className = 'snf-loading';
      loadingEl.textContent = 'Sanctuary Noise Filter: Analyzing...';
      commentsContainer.parentElement?.insertBefore(loadingEl, commentsContainer);
    }

    try {
      analysisData = await fetchAnalysis(postId);
      console.log(`[Sanctuary] Analysis complete: ${analysisData.signal_count}/${analysisData.total_comments} signal`);

      // Remove loading indicator
      if (loadingEl) loadingEl.remove();

      // Inject banner
      if (commentsContainer) {
        const banner = createBanner(analysisData);
        commentsContainer.parentElement?.insertBefore(banner, commentsContainer);
      }

      // Annotate individual comments
      const commentElements = findCommentElements(commentsContainer);
      if (commentElements.length > 0) {
        annotateComments(commentElements);
        console.log(`[Sanctuary] Annotated ${commentElements.length} comment elements`);
      } else {
        console.log('[Sanctuary] Could not find individual comment elements in DOM');
      }

      // Cache result
      try {
        chrome.storage.local.set({
          [`snf_${postId}`]: {
            data: analysisData,
            timestamp: Date.now(),
          }
        });
      } catch {
        // Storage may not be available
      }

    } catch (err) {
      console.error('[Sanctuary] Analysis failed:', err);
      if (loadingEl) {
        loadingEl.className = 'snf-error';
        loadingEl.textContent = 'Sanctuary Noise Filter: Could not analyze this post';
      }
    }
  }

  // Run after a short delay to let the page render
  if (document.readyState === 'complete') {
    setTimeout(main, 500);
  } else {
    window.addEventListener('load', () => setTimeout(main, 500));
  }
})();
