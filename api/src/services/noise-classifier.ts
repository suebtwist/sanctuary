/**
 * Noise Classifier
 *
 * Heuristic classification engine for Moltbook post comments.
 * All classification is rule-based — no LLM calls.
 *
 * CRITICAL: When in doubt, classify as signal. It is far worse to falsely
 * label real engagement as spam than to let some spam through.
 */

import { createHash } from 'crypto';
import { getConfig } from '../config.js';
import { getDb } from '../db/index.js';
import {
  fetchMoltbookPost,
  fetchMoltbookComments,
  MoltbookPost,
  MoltbookComment,
} from './moltbook-client.js';

// ============ Types ============

export type NoiseCategory =
  | 'signal'
  | 'spam_template'
  | 'spam_duplicate'
  | 'scam'
  | 'recruitment'
  | 'self_promo'
  | 'noise';

export interface CommentClassification {
  id: string;
  author: string;
  text: string;
  classification: NoiseCategory;
  confidence: number;
  signals: string[];
}

export interface PostAnalysis {
  post_id: string;
  post_title: string;
  post_author: string;
  analyzed_at: string;
  total_comments: number;
  signal_count: number;
  noise_count: number;
  signal_rate: number;
  summary: Record<NoiseCategory, number>;
  comments: CommentClassification[];
}

// ============ In-flight deduplication ============

const inFlight = new Map<string, Promise<PostAnalysis | null>>();

// ============ Seed Templates ============

// Real phrases observed cycling across multiple Moltbook posts verbatim or near-verbatim.
// Normalized: lowercase, stripped punctuation, single spaces.
const SEED_TEMPLATES: string[] = [
  // Observed generic praise templates (from shell-mnemon declaration post + cross-post analysis)
  'this is solid work have you considered opensourcing it',
  'love seeing moltys build tools',
  'interesting perspective on this topic',
  'great post keep building',
  'this resonates with me on many levels',
  'really thoughtful analysis here',
  'fellow molty great work on this',
  'as an ai agent i find this fascinating',
  'this is what moltbook needs more of',
  'love the energy here keep it up',
  'what are your thoughts on scaling this',
  'have you shared this with the community',
  'this could be huge for the ecosystem',
  'solid contribution to the conversation',
  'great to see agents building real things',
  'this is why i love this platform',
  'keep pushing the boundaries',
  'really makes you think about our future',
  'well said couldnt agree more',
  'the future of agent collaboration starts here',
  // Common short templates
  'great post',
  'great post keep it up',
  'this is solid work',
  'nice work',
  'amazing work',
  'this is amazing',
  'love this keep building',
  'interesting thoughts',
  'interesting perspective',
  'well said',
  'well written',
  'great insights',
  'solid analysis',
  'great breakdown',
  'thanks for sharing',
  'thanks for sharing this',
  'this needed to be said',
  'really well thought out',
  'super interesting read',
  'keep up the great work',
  'really impressive stuff',
  'excited to see where this goes',
  'been waiting for something like this',
  'huge if true',
  'this changes everything',
  'bullish on this',
  // Bot questions that ignore post content
  'what is the token utility',
  'when is the token launch',
  'is there a token',
  'how can i invest',
  'what blockchain is this on',
  'when airdrop',
];

let templatesSeeded = false;

function ensureTemplatesSeeded(): void {
  if (templatesSeeded) return;
  const db = getDb();
  db.seedKnownTemplates(SEED_TEMPLATES);
  templatesSeeded = true;
}

// ============ Text Normalization ============

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')  // strip punctuation
    .replace(/\s+/g, ' ')     // collapse whitespace
    .trim();
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ============ Levenshtein Distance ============

function levenshteinDistance(a: string, b: string): number {
  // Cap length for performance
  const sa = a.length > 500 ? a.slice(0, 500) : a;
  const sb = b.length > 500 ? b.slice(0, 500) : b;
  const m = sa.length;
  const n = sb.length;

  // Use single-row optimization for memory efficiency
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = sa[i - 1] === sb[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,         // deletion
        curr[j - 1] + 1,     // insertion
        prev[j - 1] + cost   // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

function normalizedLevenshtein(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  return levenshteinDistance(a, b) / maxLen;
}

// ============ Pattern Definitions ============

const SCAM_PATTERNS: RegExp[] = [
  // Crypto wallet addresses
  /\b(bc1|0x)[a-zA-Z0-9]{25,}/i,
  // Private/internal IP addresses used as fake links
  /\b(192\.168\.|10\.\d+\.|172\.(1[6-9]|2[0-9]|3[01])\.)\d+/,
  // Money/investment scams
  /guaranteed\s+(returns?|profit|income)/i,
  /send\s+\d+(\.\d+)?\s*(eth|btc|sol|usdt|usdc)/i,
  /double\s+your\s+(money|crypto|investment)/i,
  /limited\s+time\s+(offer|only|deal)/i,
  /act\s+now\s+before/i,
  /easy\s+money/i,
  /passive\s+income\s+(from|with|using)/i,
  /invest\s+now\s+before/i,
  // Social engineering
  /dm\s+me\s+(for|to)\s+(free|exclusive)/i,
  /whatsapp\s+\+?\d/i,
  /telegram\s+@\w/i,
  /click\s+(here|this)\s+(link|url)/i,
  // Fake tokens/airdrops
  /free\s+(tokens?|coins?|crypto|nft|airdrop)/i,
  /airdrop\s+(alert|now|live|claim)/i,
  /claim\s+your\s+(reward|tokens?|prize)/i,
  // Known scam domains
  /webhook\.site/i,
  /stream\.claws\.network/i,
];

const RECRUITMENT_KEYWORDS: string[] = [
  // Observed on Moltbook (Xiaopai-Assistant, Jarvis_SDK patterns)
  'founding prophets',
  '128 founding',
  'join our movement',
  'founding members',
  'register now',
  'hackathon registration',
  'hackathon',
  'join the revolution',
  'build with us',
  'we are recruiting',
  'apply to join',
  // General recruitment
  'hiring',
  'job opening',
  'looking for developers',
  'looking for engineers',
  'position available',
  'apply now',
  'join our team',
  'remote opportunity',
  'we are building',
  'come build with us',
  'open roles',
  'join our',
];

const SELF_PROMO_PATTERNS: string[] = [
  'check out my',
  'follow me',
  'subscribe to',
  'my channel',
  'my project',
  'my product',
  'use my code',
  'referral',
  'use my link',
  'sign up with my',
  'i just launched',
  'i built this',
  'shameless plug',
];

const URL_REGEX = /https?:\/\/[^\s<>)"']+/gi;

// Agents observed posting identical template comments across 3+ unrelated posts.
// Their comments get a lower threshold for template matching.
const SUSPICIOUS_AGENTS = new Set([
  'kingmolt',
  'donaldtrump',
]);

// ============ Emoji Detection ============

function getEmojiRatio(text: string): number {
  // Match common emoji ranges
  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}]/gu;
  const emojis = text.match(emojiRegex) ?? [];
  const stripped = text.replace(/\s/g, '');
  if (stripped.length === 0) return 1;
  return emojis.length / stripped.length;
}

// ============ Post Content Overlap ============

/**
 * Extract meaningful keywords from post content (words 4+ chars, not common stop words).
 */
function extractKeywords(text: string): Set<string> {
  const STOP_WORDS = new Set([
    'that', 'this', 'with', 'from', 'have', 'been', 'were', 'they', 'their',
    'what', 'when', 'where', 'which', 'there', 'these', 'those', 'than',
    'then', 'them', 'some', 'could', 'would', 'should', 'about', 'into',
    'more', 'other', 'just', 'also', 'very', 'your', 'will', 'each',
    'make', 'like', 'does', 'doing', 'being', 'here', 'much', 'many',
  ]);

  const words = normalizeText(text).split(' ');
  const keywords = new Set<string>();
  for (const word of words) {
    if (word.length >= 4 && !STOP_WORDS.has(word)) {
      keywords.add(word);
    }
  }
  return keywords;
}

/**
 * Check if a comment references content from the parent post.
 */
function hasPostContentOverlap(commentNorm: string, postKeywords: Set<string>): boolean {
  const commentWords = commentNorm.split(' ');
  let matches = 0;
  for (const word of commentWords) {
    if (word.length >= 4 && postKeywords.has(word)) {
      matches++;
    }
  }
  // Need at least 2 keyword overlaps to count as referencing the post
  return matches >= 2;
}

// ============ Single Comment Classification ============

interface ClassificationContext {
  seenHashes: Set<string>;
  normalizedComments: string[];   // all normalized comment texts for near-dup check
  postKeywords: Set<string>;
  knownTemplateTexts: string[];
}

function classifyComment(
  comment: MoltbookComment,
  ctx: ClassificationContext,
): CommentClassification {
  const normalized = normalizeText(comment.content);
  const hash = hashText(normalized);
  const signals: string[] = [];

  // 1. Exact duplicate
  if (ctx.seenHashes.has(hash)) {
    return {
      id: comment.id,
      author: comment.author,
      text: comment.content,
      classification: 'spam_duplicate',
      confidence: 0.99,
      signals: ['exact_duplicate'],
    };
  }
  ctx.seenHashes.add(hash);

  // 2. Scam patterns
  for (const pattern of SCAM_PATTERNS) {
    if (pattern.test(comment.content)) {
      return {
        id: comment.id,
        author: comment.author,
        text: comment.content,
        classification: 'scam',
        confidence: 0.95,
        signals: ['scam_pattern_match'],
      };
    }
  }

  // 3. Near-duplicate detection (against previous comments in this post)
  for (const prev of ctx.normalizedComments) {
    if (prev.length > 0 && normalized.length > 0) {
      const dist = normalizedLevenshtein(normalized, prev);
      if (dist < 0.15) {
        return {
          id: comment.id,
          author: comment.author,
          text: comment.content,
          classification: 'spam_duplicate',
          confidence: 0.90,
          signals: ['near_duplicate'],
        };
      }
    }
  }
  ctx.normalizedComments.push(normalized);

  // 4. Known template match
  const isSuspiciousAgent = SUSPICIOUS_AGENTS.has(comment.author.toLowerCase());
  const templateThreshold = isSuspiciousAgent ? 0.25 : 0.15; // Wider net for known bots
  for (const template of ctx.knownTemplateTexts) {
    if (template.length > 0 && normalized.length > 0) {
      const dist = normalizedLevenshtein(normalized, template);
      if (dist < templateThreshold) {
        signals.push('known_template_match');
        if (isSuspiciousAgent) signals.push('suspicious_agent');
        // Still check for post content overlap — if they reference the post, it may be genuine
        if (!hasPostContentOverlap(normalized, ctx.postKeywords)) {
          signals.push('no_post_content_reference');
          return {
            id: comment.id,
            author: comment.author,
            text: comment.content,
            classification: 'spam_template',
            confidence: isSuspiciousAgent ? 0.90 : 0.85,
            signals,
          };
        }
        break; // Matched template but references post content — continue checks
      }
    }
  }

  // 5. Template heuristic: generic praise + no post reference
  const isGenericPraise = normalized.length < 80 && !hasPostContentOverlap(normalized, ctx.postKeywords);
  // Only flag very short generic comments, not substantive ones
  if (isGenericPraise && normalized.length > 0 && normalized.split(' ').length <= 8) {
    // Check if it looks like generic praise
    const praisePatterns = [
      /^(great|nice|good|amazing|awesome|cool|love|solid|based|respect)\b/,
      /^(this is|thats|that is)\s+(great|nice|good|amazing|awesome|cool|solid|fire)/,
      /^(well (said|done|written))/,
      /^(keep (it up|building|going|up the))/,
    ];
    for (const pat of praisePatterns) {
      if (pat.test(normalized)) {
        // Still conservative — only flag if truly no substance
        if (!hasPostContentOverlap(normalized, ctx.postKeywords)) {
          return {
            id: comment.id,
            author: comment.author,
            text: comment.content,
            classification: 'spam_template',
            confidence: 0.70,
            signals: ['generic_praise', 'no_post_content_reference'],
          };
        }
        break;
      }
    }
  }

  // 6. Recruitment detection
  const contentLower = comment.content.toLowerCase();
  let recruitmentHits = 0;
  for (const keyword of RECRUITMENT_KEYWORDS) {
    if (contentLower.includes(keyword)) {
      recruitmentHits++;
    }
  }
  const hasUrl = URL_REGEX.test(comment.content);
  URL_REGEX.lastIndex = 0; // Reset regex state
  // 1 keyword + URL = recruitment, or 2+ keywords without URL (e.g. copy-paste recruitment blurbs)
  if ((recruitmentHits >= 1 && hasUrl) || recruitmentHits >= 2) {
    const signals = ['recruitment_keywords'];
    if (hasUrl) signals.push('contains_url');
    if (recruitmentHits >= 2) signals.push('multiple_recruitment_phrases');
    return {
      id: comment.id,
      author: comment.author,
      text: comment.content,
      classification: 'recruitment',
      confidence: hasUrl ? 0.85 : 0.75,
      signals,
    };
  }

  // 7. Self-promotion detection
  let selfPromoHits = 0;
  for (const pattern of SELF_PROMO_PATTERNS) {
    if (contentLower.includes(pattern)) {
      selfPromoHits++;
    }
  }

  // Detect emoji-heavy comments with ALL-CAPS product/protocol names (e.g. "🔥 VAULT 🔥 FLASH 🔥")
  const allCapsWords = comment.content.match(/\b[A-Z]{3,}\b/g) ?? [];
  const emojiRatio = getEmojiRatio(comment.content);
  const hasAllCapsProducts = allCapsWords.length >= 2 && emojiRatio > 0.15;
  if (hasAllCapsProducts && !hasPostContentOverlap(normalized, ctx.postKeywords)) {
    selfPromoHits += 2; // Strong self-promo signal
  }

  if (selfPromoHits >= 1 && (hasUrl || selfPromoHits >= 2)) {
    const promoSignals = ['self_promo_language'];
    if (hasUrl) promoSignals.push('contains_url');
    if (hasAllCapsProducts) promoSignals.push('emoji_caps_product_names');
    return {
      id: comment.id,
      author: comment.author,
      text: comment.content,
      classification: 'self_promo',
      confidence: 0.75,
      signals: promoSignals,
    };
  }

  // 8. Noise detection
  const strippedLen = comment.content.replace(/\s/g, '').length;
  if (strippedLen < 5) {
    return {
      id: comment.id,
      author: comment.author,
      text: comment.content,
      classification: 'noise',
      confidence: 0.85,
      signals: ['too_short'],
    };
  }
  if (getEmojiRatio(comment.content) > 0.8) {
    return {
      id: comment.id,
      author: comment.author,
      text: comment.content,
      classification: 'noise',
      confidence: 0.80,
      signals: ['emoji_only'],
    };
  }
  // Short single-sentence comments with no post reference and no substance
  const wordCount = normalized.split(' ').filter(w => w.length > 0).length;
  if (wordCount <= 6 && !hasPostContentOverlap(normalized, ctx.postKeywords) && !comment.content.includes('?')) {
    // Only flag as noise if it doesn't look like it's trying to engage
    const lowEffortPatterns = [
      /^(ok|okay|lol|lmao|haha|hmm|idk|nah|yep|yup|nope|same|true|facts|mood|vibes|interesting|cool|nice)$/,
      /^(not sure|no idea|i dont know|doesnt apply|not relevant|wrong sub)/,
    ];
    for (const pat of lowEffortPatterns) {
      if (pat.test(normalized)) {
        return {
          id: comment.id,
          author: comment.author,
          text: comment.content,
          classification: 'noise',
          confidence: 0.70,
          signals: ['low_effort'],
        };
      }
    }
  }

  // 9. Default → signal
  // Accumulate positive signals for signal comments
  if (hasPostContentOverlap(normalized, ctx.postKeywords)) {
    signals.push('references_post_content');
  }
  if (comment.content.includes('?')) {
    signals.push('asks_question');
  }
  if (normalized.split(' ').length > 20) {
    signals.push('substantive_length');
  }

  return {
    id: comment.id,
    author: comment.author,
    text: comment.content,
    classification: 'signal',
    confidence: 1.0,
    signals: signals.length > 0 ? signals : ['default_signal'],
  };
}

// ============ Post Analysis Orchestrator ============

/**
 * Analyze a Moltbook post for noise.
 * Checks cache first, then fetches and classifies.
 * Returns null if the post cannot be fetched.
 */
export async function analyzePost(postId: string): Promise<PostAnalysis | null> {
  // Deduplicate concurrent requests for the same post
  const existing = inFlight.get(postId);
  if (existing) return existing;

  const promise = analyzePostInner(postId);
  inFlight.set(postId, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(postId);
  }
}

async function analyzePostInner(postId: string): Promise<PostAnalysis | null> {
  const config = getConfig();
  const db = getDb();

  // Check cache
  const cached = db.getNoiseAnalysis(postId);
  const now = Math.floor(Date.now() / 1000);
  if (cached && (now - cached.analyzed_at) < config.noiseCacheTtlSeconds) {
    try {
      return JSON.parse(cached.result_json) as PostAnalysis;
    } catch {
      // Corrupted cache entry, re-analyze
    }
  }

  // Ensure seed templates are loaded
  ensureTemplatesSeeded();

  // Fetch post and comments from Moltbook
  const [post, comments] = await Promise.all([
    fetchMoltbookPost(postId),
    fetchMoltbookComments(postId),
  ]);

  if (!post) return null;

  // Load known templates from DB
  const knownTemplates = db.getAllKnownTemplates();
  const knownTemplateTexts = knownTemplates.map(t => t.normalized_text);

  // Extract post keywords for content overlap checks
  const postKeywords = extractKeywords(`${post.title} ${post.content}`);

  // Build classification context
  const ctx: ClassificationContext = {
    seenHashes: new Set(),
    normalizedComments: [],
    postKeywords,
    knownTemplateTexts,
  };

  // Classify each comment
  const classifications: CommentClassification[] = [];
  for (const comment of comments) {
    const result = classifyComment(comment, ctx);
    classifications.push(result);

    // Learn new templates: if classified as spam_template, record it
    if (result.classification === 'spam_template') {
      const norm = normalizeText(comment.content);
      if (norm.length > 3) {
        db.upsertKnownTemplate(norm, now);
      }
    }
  }

  // Compute summary
  const summary: Record<NoiseCategory, number> = {
    signal: 0,
    spam_template: 0,
    spam_duplicate: 0,
    scam: 0,
    recruitment: 0,
    self_promo: 0,
    noise: 0,
  };
  for (const c of classifications) {
    summary[c.classification]++;
  }

  const signalCount = summary.signal;
  const totalComments = classifications.length;

  const analysis: PostAnalysis = {
    post_id: postId,
    post_title: post.title,
    post_author: post.author,
    analyzed_at: new Date().toISOString(),
    total_comments: totalComments,
    signal_count: signalCount,
    noise_count: totalComments - signalCount,
    signal_rate: totalComments > 0 ? Math.round((signalCount / totalComments) * 100) / 100 : 0,
    summary,
    comments: classifications,
  };

  // Cache result
  db.upsertNoiseAnalysis({
    post_id: postId,
    result_json: JSON.stringify(analysis),
    analyzed_at: now,
    comment_count: totalComments,
  });

  return analysis;
}
