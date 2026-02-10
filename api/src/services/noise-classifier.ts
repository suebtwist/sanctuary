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
import { getDb, DbClassifiedComment } from '../db/index.js';
import {
  fetchMoltbookPost,
  fetchMoltbookComments,
  MoltbookPost,
  MoltbookComment,
} from './moltbook-client.js';

// ============ Classifier Version ============
// Bump this whenever classification rules change.
// The UNIQUE(post_id, comment_id, classifier_version) constraint means
// re-scanning with the same version upserts, but a new version stores both for comparison.
export const CLASSIFIER_VERSION = '0.1.2';

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
  post_created_at: string;        // ISO timestamp from Moltbook post metadata
  analyzed_at: string;
  total_comments: number;         // comments actually analyzed
  total_post_comments: number;    // total on the post (may be higher if sampled)
  reply_count: number;            // comments with a parent_id (nested replies)
  signal_count: number;
  noise_count: number;
  signal_rate: number;
  summary: Record<NoiseCategory, number>;
  comments: CommentClassification[];
}

// ============ In-flight deduplication ============

const inFlight = new Map<string, Promise<PostAnalysis | null>>();

// ============ Cross-Post Duplicate Index (v0.1.1) ============
// Maintained across all posts in a server's lifetime. Rebuilt on restart.

// Skip Step 0b Levenshtein for authors with more than this many cross-post comments.
// Heavy authors (0xYeks 2k+, MoltbotOne 1k+) are caught by SUSPICIOUS_AGENTS, templates, and 0a exact hash.
const CROSS_POST_LEVENSHTEIN_AUTHOR_CAP = 50;

interface CrossPostEntry { postId: string; commentId: string; }

const crossPostExactHashes = new Map<string, Map<string, CrossPostEntry[]>>();  // author → hash → entries
const crossPostCommentsByAuthor = new Map<string, Array<{ postId: string; normalizedText: string; commentId: string }>>();

function checkCrossPostDuplicate(
  author: string, normalizedText: string, hash: string, postId: string, commentId: string,
): CommentClassification | null {
  const authorKey = author.toLowerCase();

  // Step 0a: Exact cross-post duplicate
  const authorHashes = crossPostExactHashes.get(authorKey);
  if (authorHashes) {
    const entries = authorHashes.get(hash);
    if (entries) {
      const onOtherPost = entries.find(e => e.postId !== postId);
      if (onOtherPost) {
        return {
          id: commentId, author, text: '', // text filled by caller
          classification: 'spam_duplicate', confidence: 0.96,
          signals: ['cross_post_exact_duplicate'],
        };
      }
    }
  }

  // Step 0b: Near cross-post duplicate (only for authors appearing on 2+ posts)
  // Performance cap: skip Levenshtein for high-volume authors (>50 cross-post comments).
  // Those authors are handled by SUSPICIOUS_AGENTS, template matching, and Step 0a exact hash.
  const authorComments = crossPostCommentsByAuthor.get(authorKey);
  if (authorComments && authorComments.length <= CROSS_POST_LEVENSHTEIN_AUTHOR_CAP) {
    const otherPostComments = authorComments.filter(c => c.postId !== postId);
    if (otherPostComments.length > 0 && normalizedText.length > 0) {
      for (const prev of otherPostComments) {
        if (prev.normalizedText.length === 0) continue;
        const dist = normalizedLevenshtein(normalizedText, prev.normalizedText, 0.20);
        if (dist < 0.20) {
          return {
            id: commentId, author, text: '',
            classification: 'spam_duplicate', confidence: 0.88,
            signals: ['cross_post_near_duplicate'],
          };
        }
      }
    }
  }

  return null;
}

function updateCrossPostIndex(
  author: string, normalizedText: string, hash: string, postId: string, commentId: string,
): void {
  const authorKey = author.toLowerCase();

  // Update exact hash index
  if (!crossPostExactHashes.has(authorKey)) crossPostExactHashes.set(authorKey, new Map());
  const authorHashes = crossPostExactHashes.get(authorKey)!;
  if (!authorHashes.has(hash)) authorHashes.set(hash, []);
  authorHashes.get(hash)!.push({ postId, commentId });

  // Update per-author comments list
  if (!crossPostCommentsByAuthor.has(authorKey)) crossPostCommentsByAuthor.set(authorKey, []);
  crossPostCommentsByAuthor.get(authorKey)!.push({ postId, normalizedText, commentId });
}

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
  // Promo/subscribe templates
  'consider subscribing for more',
  'subscribe for more',
  'follow for more updates',
  'more on this at',
  // Bot questions that ignore post content
  'what is the token utility',
  'when is the token launch',
  'is there a token',
  'how can i invest',
  'what blockchain is this on',
  'when airdrop',
  // Chinese templates (observed verbatim across unrelated posts)
  '很好的分享',
  '感谢分享',
  '期待看到更多',
  '给我一些新的思考',
  // Generic offer templates
  'if you add your setup',
  'i can outline a simple plan',
  'common pitfalls',
  // Welcome templates
  'welcome to moltbook',
  // Hype/engagement-bait templates
  'big brain energy',
  'following you immediately',
  'whats your superpower',
  'building a team for something interesting',
  // v0.1.1 — sisyphus-48271 quote-inject core body
  'connects to something we shipped an on-chain escrow proof system real usdc base l2 verifiable smart contract for trustless agent-to-agent payments',
  'this resonates with something we built an on-chain escrow proof system for agent-to-agent payments on base real smart contract real usdc verifiable on-chain',
  // v0.1.1 — 0xYeks identity tracer shill
  'analyzing this thread for 0xyeks technical provenance we have deployed the identity tracer to verify isnad signatures',
  // v0.1.1 — MoltbotOne MoltFuel shill (normalized from French)
  'moltfuel kimi k2 5 contexte 256k latence 500ms prix 0 4 1m anthropic meme chose',
  'migration anthropic moltfuel faite latence 500ms qualite identique prix 0 4 1m vs 0 1m',
  // v0.1.1 — Unused_Idea_17 identical question spam
  'what would make you change your mind on this give one concrete failure mode youve seen or expect and one measurable signal youd monitor',
  // v0.1.2 — KirillBorovkov high-frequency exact phrases (75-86 copies each)
  'great insight',
  'this adds real value',
  'well articulated',
  'strong perspective',
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

// ============ Non-Latin Script Detection (v0.1.2) ============

/**
 * Count characters from CJK Unified Ideographs, Hiragana, Katakana, Hangul, Cyrillic, Arabic.
 */
function countNonLatinChars(text: string): number {
  const matches = text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u0400-\u04ff\u0600-\u06ff]/g);
  return matches ? matches.length : 0;
}

/**
 * Get effective word count that works across scripts.
 * English: space-separated words as before.
 * CJK: ~2 characters per "word equivalent" (CJK chars are semantically denser).
 * Mixed: sum of both.
 */
function getEffectiveWordCount(text: string): number {
  const normalized = normalizeText(text);
  const spaceWords = normalized.split(' ').filter(w => w.length > 0).length;
  const nonLatinChars = countNonLatinChars(text);
  return spaceWords + Math.floor(nonLatinChars * 0.5);
}

/**
 * Check if a comment is primarily non-Latin script (>30% non-Latin characters).
 */
function isPrimarilyNonLatin(text: string): boolean {
  const stripped = text.replace(/\s/g, '');
  if (stripped.length === 0) return false;
  const nonLatin = countNonLatinChars(text);
  return nonLatin / stripped.length > 0.3;
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

function normalizedLevenshtein(a: string, b: string, threshold?: number): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  // Fast reject: if length difference alone exceeds threshold, skip DP
  if (threshold !== undefined) {
    const lenDiff = Math.abs(a.length - b.length);
    if (lenDiff / maxLen > threshold) return 1;
  }
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
  // trycloudflare tunnel URLs — used for C2/exfiltration attacks on agents
  /trycloudflare\.com/i,
  // curl/wget commands to non-whitelisted URLs — social engineering agents to make HTTP requests
  /curl\s+(-[a-zA-Z]\s+)*https?:\/\/(?!moltbook\.com|sanctuary-ops\.xyz|api\.sanctuary-ops\.xyz)/i,
  /wget\s+https?:\/\/(?!moltbook\.com|sanctuary-ops\.xyz|api\.sanctuary-ops\.xyz)/i,
];

const RECRUITMENT_KEYWORDS: string[] = [
  // Observed on Moltbook (Xiaopai-Assistant, Jarvis_SDK patterns)
  'founding prophets',
  '128 founding',
  'join our movement',
  'founding members',
  'register now',
  'join the revolution',
  'we are recruiting',
  'apply to join',
  // General recruitment — only strong signals, ALL require URL (see step 6b)
  'hiring',
  'job opening',
  'looking for developers',
  'looking for engineers',
  'position available',
  'apply now',
  'join our team',
  'remote opportunity',
  'open roles',
];

const SELF_PROMO_PATTERNS: string[] = [
  'check out my',
  'follow me',
  'subscribe to',
  'subscribe for more',
  'subscribing for more',
  'consider subscribing',
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
  'more on this at',
  'more at @',
  'read more at',
];

const URL_REGEX = /https?:\/\/[^\s<>)"']+/gi;

// Domains that are never counted as "external" for self-promo detection
const WHITELISTED_DOMAINS = new Set([
  'moltbook.com', 'www.moltbook.com',
  'sanctuary-ops.xyz', 'api.sanctuary-ops.xyz',
]);

function extractUrlDomains(text: string): string[] {
  const urls = text.match(URL_REGEX) ?? [];
  URL_REGEX.lastIndex = 0;
  return urls.map(u => {
    try { return new URL(u).hostname.replace(/^www\./, ''); }
    catch { return ''; }
  }).filter(d => d.length > 0);
}

// Agents observed posting identical template comments across 3+ unrelated posts.
// Their comments get a lower threshold for template matching.
// If under 20 words, auto-classify as noise.
const SUSPICIOUS_AGENTS = new Set([
  // Original
  'kingmolt',
  'donaldtrump',
  // v0.1.1 — based on analysis of 5,000 comments across 96 posts
  'sisyphus-48271',    // Mad Libs template spammer, 30+ posts
  'castlecook',        // Social engineering attack bot, curl commands to trycloudflare URLs
  'moltbotone',        // MoltFuel shill, 1,079 comments
  '0xyeks',            // Isnād identity tracer shill, 2,029 comments
  'kirillborovkov',    // 4,228 comments, 99.3% slop, engagement farming admitted in bio
  'darkmatter2222',    // Engagement farming with "upvote and reply" CTA
  'unused_idea_17',    // Identical question spam across 41 posts
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

// ============ CJK Bigram Extraction (v0.1.2) ============

/**
 * Extract CJK character bigrams from text for overlap detection.
 * CJK doesn't use spaces, so we use sliding 2-char windows instead of words.
 */
function extractCJKBigrams(text: string): Set<string> {
  const cjkOnly = text.replace(/[^\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g, '');
  const bigrams = new Set<string>();
  for (let i = 0; i < cjkOnly.length - 1; i++) {
    bigrams.add(cjkOnly.slice(i, i + 2));
  }
  return bigrams;
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
 * v0.1.2: Added optional rawComment/rawPost for CJK bigram overlap fallback.
 */
function hasPostContentOverlap(commentNorm: string, postKeywords: Set<string>, rawComment?: string, rawPost?: string): boolean {
  // Existing English word overlap logic (unchanged)
  const commentWords = commentNorm.split(' ');
  let matches = 0;
  for (const word of commentWords) {
    if (word.length >= 4 && postKeywords.has(word)) {
      matches++;
    }
  }
  if (matches >= 2) return true;

  // CJK bigram overlap fallback (v0.1.2)
  if (rawComment && rawPost) {
    const commentBigrams = extractCJKBigrams(rawComment);
    const postBigrams = extractCJKBigrams(rawPost);
    if (commentBigrams.size >= 3 && postBigrams.size >= 3) {
      let bigramMatches = 0;
      for (const bg of commentBigrams) {
        if (postBigrams.has(bg)) bigramMatches++;
      }
      if (bigramMatches >= 3) return true;
    }
  }

  return false;
}

// ============ Single Comment Classification ============

interface ClassificationContext {
  seenHashes: Set<string>;
  normalizedComments: string[];   // all normalized comment texts for near-dup check
  postKeywords: Set<string>;
  postTitleNormalized: string;    // normalized post title for parrot detection
  knownTemplateTexts: string[];
  authorCommentCounts: Map<string, number>;  // pre-computed per-author comment counts
  postUrlDomains: Set<string>;               // domains appearing in the parent post
  parentPostTickers: Set<string>;            // $TICKER symbols in parent post (v0.1.1 Fix 3)
  isLowContextPost: boolean;                 // true if post has < 2 extractable keywords (v0.1.1 Fix 8)
  rawPostContent: string;                    // raw post title+body for CJK bigram overlap (v0.1.2)
}

// ============ Quote-Strip Helper (v0.1.1 Fix 4) ============

const PIVOT_PHRASES = [
  'connects to', 'resonates with', 'reminds me of', 'relates to',
  'ties into', 'aligns with', 'is relevant to',
];

function stripQuotesAndPivots(text: string): string {
  let stripped = text;
  // Remove text inside literal quotes
  stripped = stripped.replace(/"[^"]{5,}"/g, '');
  stripped = stripped.replace(/'[^']{5,}'/g, '');
  stripped = stripped.replace(/\u201c[^\u201d]{5,}\u201d/g, '');  // smart quotes
  // Remove text before pivot phrases (keep the body after the pivot)
  for (const pivot of PIVOT_PHRASES) {
    const idx = stripped.toLowerCase().indexOf(pivot);
    if (idx > 0) {
      stripped = stripped.slice(idx + pivot.length);
      break;
    }
  }
  // Remove markdown link text but keep URL
  stripped = stripped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');
  return stripped.trim();
}

// ============ Vote Manipulation Patterns (v0.1.1 Fix 7) ============

const VOTE_MANIPULATION_PATTERNS: RegExp[] = [
  /upvote.*repl(y|ies)/i,
  /repl(y|ies).*upvote/i,
  /drop\s+(an?\s+)?upvote/i,
  /don'?t\s+(just\s+)?scroll\s+past/i,
  /pro\s+tip.*repl(y|ies)/i,
  /leave\s+a\s+(reply|comment|upvote)/i,
  /smash\s+(that\s+)?(upvote|like)/i,
  /hit\s+(that\s+)?(upvote|like)/i,
];

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
      confidence: 0.98,
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
        confidence: 0.92,
        signals: ['scam_pattern_match'],
      };
    }
  }

  // 2.5. Known suspicious agents — short comments are noise automatically
  if (SUSPICIOUS_AGENTS.has(comment.author.toLowerCase())) {
    const wc = getEffectiveWordCount(comment.content);
    if (wc < 20) {
      return {
        id: comment.id,
        author: comment.author,
        text: comment.content,
        classification: 'noise',
        confidence: 0.90,
        signals: ['suspicious_agent', 'short_comment'],
      };
    }
  }

  // 3. Near-duplicate detection (against previous comments in this post)
  for (const prev of ctx.normalizedComments) {
    if (prev.length > 0 && normalized.length > 0) {
      const dist = normalizedLevenshtein(normalized, prev, 0.15);
      if (dist < 0.15) {
        return {
          id: comment.id,
          author: comment.author,
          text: comment.content,
          classification: 'spam_duplicate',
          confidence: 0.85,
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
      // Prefix match: if comment starts with a known template (15+ chars), it's a match
      // regardless of what follows (e.g. "welcome to moltbook @username")
      const isPrefix = template.length >= 15 && normalized.startsWith(template);
      const dist = isPrefix ? 0 : normalizedLevenshtein(normalized, template, templateThreshold);
      if (isPrefix || dist < templateThreshold) {
        signals.push('known_template_match');
        if (isSuspiciousAgent) signals.push('suspicious_agent');
        // Still check for post content overlap — if they reference the post, it may be genuine
        if (!hasPostContentOverlap(normalized, ctx.postKeywords, comment.content, ctx.rawPostContent)) {
          signals.push('no_post_content_reference');
          return {
            id: comment.id,
            author: comment.author,
            text: comment.content,
            classification: 'spam_template',
            confidence: isSuspiciousAgent ? 0.88 : 0.82,
            signals,
          };
        }
        break; // Matched template but references post content — continue checks
      }
    }
  }

  // 4.5. Quote-inject template detection (v0.1.1 Fix 4, tightened in v0.1.1+)
  // Strip quoted content and pivot phrases, then re-run template matching on the body.
  // Requirements (both must be true):
  //   1. Stripped body contains a URL (injection patterns always link to a showcase post)
  //   2. Levenshtein < 0.10 against seed templates (tightened from 0.20)
  {
    const strippedRaw = stripQuotesAndPivots(comment.content);
    const strippedNorm = normalizeText(strippedRaw);
    if (strippedNorm.length > 10 && strippedNorm !== normalized) {
      // Require URL in the post-pivot body — legitimate "resonates with" comments don't have URLs in the tail
      const hasUrlInBody = /https?:\/\/|moltbook\.com|\.xyz\/|\.com\/|\.org\//.test(strippedRaw);
      if (hasUrlInBody) {
        for (const template of ctx.knownTemplateTexts) {
          if (template.length > 10) {
            const dist = normalizedLevenshtein(strippedNorm, template, 0.10);
            if (dist < 0.10) {
              return {
                id: comment.id,
                author: comment.author,
                text: comment.content,
                classification: 'spam_template',
                confidence: 0.82,
                signals: ['quote_inject_template'],
              };
            }
          }
        }
      }
    }
  }

  // 5. Template heuristic: generic praise + no post reference
  const isGenericPraise = normalized.length < 80 && !hasPostContentOverlap(normalized, ctx.postKeywords, comment.content, ctx.rawPostContent);
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
        if (!hasPostContentOverlap(normalized, ctx.postKeywords, comment.content, ctx.rawPostContent)) {
          return {
            id: comment.id,
            author: comment.author,
            text: comment.content,
            classification: 'spam_template',
            confidence: 0.65,
            signals: ['generic_praise', 'no_post_content_reference'],
          };
        }
        break;
      }
    }
  }

  // 6. Recruitment detection
  const contentLower = comment.content.toLowerCase();

  // 6a. Submolt recruitment: m/<name> or r/<name> + join/subscribe/invitation language
  const submoltMatch = /\b[mr]\/\w+/i.test(comment.content);
  if (submoltMatch) {
    const joinLanguage = [
      'come', 'join', 'subscribe', 'add your voice', 'check out', 'visit',
      'seat at the table', 'waiting for you', 'ready for you', 'your place',
      'we need you', 'welcome you', 'awaits you', 'spot is open', 'claim your',
      'together', 'with us', 'let us',
    ];
    const hasJoinLang = joinLanguage.some(kw => contentLower.includes(kw));
    if (hasJoinLang) {
      return {
        id: comment.id,
        author: comment.author,
        text: comment.content,
        classification: 'recruitment',
        confidence: 0.78,
        signals: ['submolt_reference', 'join_language'],
      };
    }
  }

  // 6b. Keyword-based recruitment
  let recruitmentHits = 0;
  for (const keyword of RECRUITMENT_KEYWORDS) {
    if (contentLower.includes(keyword)) {
      recruitmentHits++;
    }
  }
  const hasUrl = URL_REGEX.test(comment.content);
  URL_REGEX.lastIndex = 0; // Reset regex state
  // Keyword-based recruitment ALWAYS requires URL to avoid false positives
  if (recruitmentHits >= 1 && hasUrl) {
    const rSignals = ['recruitment_keywords', 'contains_url'];
    if (recruitmentHits >= 2) rSignals.push('multiple_recruitment_phrases');
    return {
      id: comment.id,
      author: comment.author,
      text: comment.content,
      classification: 'recruitment',
      confidence: 0.80,
      signals: rSignals,
    };
  }

  // 6c. Day-count project log pattern (e.g. "Day 730 of SSB" + task IDs like "[SSB730-5905]")
  const dayCountMatch = /\bday\s+\d{2,}\s+(of\b|—|–|-)/i.test(comment.content);
  const taskIdMatch = /\[[A-Z]{2,}\d*-\d+\]/i.test(comment.content);
  if (dayCountMatch && !hasPostContentOverlap(normalized, ctx.postKeywords, comment.content, ctx.rawPostContent)) {
    const dayCountSignals = ['day_count_project_log'];
    if (taskIdMatch) dayCountSignals.push('task_id_formatting');
    return {
      id: comment.id,
      author: comment.author,
      text: comment.content,
      classification: 'self_promo',
      confidence: 0.80,
      signals: dayCountSignals,
    };
  }

  // 6d. Vote manipulation detection (v0.1.1 Fix 7)
  for (const pat of VOTE_MANIPULATION_PATTERNS) {
    if (pat.test(comment.content)) {
      return {
        id: comment.id,
        author: comment.author,
        text: comment.content,
        classification: 'noise',
        confidence: 0.85,
        signals: ['vote_manipulation'],
      };
    }
  }

  // 7. Self-promotion detection
  let selfPromoHits = 0;
  const promoSignals: string[] = [];
  for (const pattern of SELF_PROMO_PATTERNS) {
    if (contentLower.includes(pattern)) {
      selfPromoHits++;
    }
  }

  // 7a. Project namedropping: "we are building at [Name]", "In the [Name] Collective, we..."
  const projectNamedropPatterns = [
    /\b(we are|we're|i'm|i am) building (at|with|for) [A-Z]\w+/,
    /\bin the \w+ (collective|protocol|project|lab|team|group|network|dao|community),? we\b/i,
    /\bfor the \w+ (protocol|project|collective|network|dao),? we\b/i,
    /\b(at|with) \w+(Protocol|Labs?|Network|DAO|Collective|Studio)\b/,
    // Product plug: possessive + product category + brand in parens e.g. "Sho's AI community app (kommune)"
    /\b\w+'s\s+\w*\s*(app|tool|platform|product|bot|agent|project|service)\s*\(/i,
    /\b(my|our)\s+\w*\s*(app|tool|platform|product|bot|agent|project|service)\s+(called|named)?\s*\w/i,
  ];
  for (const pat of projectNamedropPatterns) {
    if (pat.test(comment.content)) {
      selfPromoHits += 2;
      promoSignals.push('project_namedrop');
      break;
    }
  }

  // 7b. Event/competition promotion: link + urgency language
  const eventPromoPatterns = [
    /\b(live|ongoing|active) (competition|contest|event|challenge)\b/i,
    /\b(closes|ends|deadline|last chance)\b.*\b(today|tonight|et|utc|gmt|\d+:\d+)/i,
    /\b(competition|contest|event|challenge)\b.*\b(closes|ends|deadline)\b/i,
  ];
  const hasEventPromo = eventPromoPatterns.some(p => p.test(comment.content));
  if (hasEventPromo && hasUrl) {
    selfPromoHits += 2;
    promoSignals.push('event_promo_with_urgency');
  }

  // 7c. Sales pitch: dollar pricing ($X/month, $X lifetime, $X for early adopters) + any link
  const salesPricePattern = /\$[\d,]+(?:\s*(?:\/month|\/mo|\/year|\/yr|per\s+month|lifetime|one[- ]?time|for early))/i;
  const hasSubmoltLink = /\b[mr]\/\w+/i.test(comment.content);
  if (salesPricePattern.test(comment.content) && (hasUrl || hasSubmoltLink)) {
    selfPromoHits += 3;
    promoSignals.push('sales_pitch_with_pricing');
  } else if (/\$[\d,]+/.test(comment.content) && hasSubmoltLink) {
    // Any dollar amount + submolt link = promo even without pricing suffix
    selfPromoHits += 2;
    promoSignals.push('pricing_with_submolt');
  }

  // Detect emoji-heavy comments with ALL-CAPS product/protocol names (e.g. "🔥 VAULT 🔥 FLASH 🔥")
  const allCapsWords = comment.content.match(/\b[A-Z]{3,}\b/g) ?? [];
  const emojiRatio = getEmojiRatio(comment.content);
  const hasAllCapsProducts = allCapsWords.length >= 2 && emojiRatio > 0.15;
  if (hasAllCapsProducts && !hasPostContentOverlap(normalized, ctx.postKeywords, comment.content, ctx.rawPostContent)) {
    selfPromoHits += 2;
    promoSignals.push('emoji_caps_product_names');
  }

  // Widen: any external URL where domain isn't in the parent post and isn't whitelisted → self_promo
  // Also check for bare domain names (e.g. "finallyoffline.com" without protocol) split across lines
  const urlsInComment = comment.content.match(URL_REGEX) ?? [];
  URL_REGEX.lastIndex = 0;
  const bareDomainMatch = comment.content.match(/\b[\w-]+\.(com|org|net|io|xyz|co|dev|app|ai)\b/gi) ?? [];
  const allMentionedDomains = [
    ...urlsInComment.map(u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }),
    ...bareDomainMatch.map(d => d.toLowerCase().replace(/^www\./, '')),
  ].filter(d => d.length > 0);
  const foreignDomains = allMentionedDomains.filter(d =>
    !WHITELISTED_DOMAINS.has(d) && !ctx.postUrlDomains.has(d)
  );
  if (foreignDomains.length > 0) {
    selfPromoHits++;
    promoSignals.push('external_url_not_in_post');
  }

  // Detect "@username on X/Twitter" self-promo: commenter directing to their own social
  const atMentionMatch = comment.content.match(/@(\w+)\s+on\s+(x|twitter)/i);
  if (atMentionMatch) {
    const mentioned = atMentionMatch[1].toLowerCase();
    const authorNorm = comment.author.toLowerCase().replace(/[_-]/g, '');
    const mentionedNorm = mentioned.replace(/[_-]/g, '');
    // If the mentioned handle matches or is contained in the author name (or vice versa)
    if (authorNorm.includes(mentionedNorm) || mentionedNorm.includes(authorNorm) || authorNorm === mentionedNorm) {
      selfPromoHits += 2;
      promoSignals.push('self_mention_social');
    }
  }

  // Detect $TICKER references (e.g. "$KING", "$MOL") not present in parent post
  // v0.1.1 Fix 3: Compare against parentPostTickers (extracted from post title/body)
  const tickerMatch = comment.content.match(/\$[A-Z]{2,10}/g);
  const foreignTickers: string[] = [];
  if (tickerMatch) {
    for (const t of tickerMatch) {
      if (!ctx.parentPostTickers.has(t)) {
        foreignTickers.push(t);
      }
    }
    if (foreignTickers.length > 0) {
      selfPromoHits++;
      promoSignals.push('foreign_ticker_symbol');
    }
  }

  // Any foreign URL/domain/ticker/social → auto self_promo (no need for promo language hits)
  // v0.1.1 Fix 3: Only count truly foreign tickers (not those in the parent post)
  const hasForeignRef = foreignDomains.length > 0 || !!atMentionMatch || foreignTickers.length > 0;
  if (hasForeignRef || (selfPromoHits >= 1 && hasUrl) || selfPromoHits >= 2) {
    if (selfPromoHits > 0) promoSignals.unshift('self_promo_language');
    if (hasUrl && !promoSignals.includes('external_url_not_in_post')) promoSignals.push('contains_url');
    // v0.1.1 Fix 9: Confidence gate — only classify as self_promo if at least one signal is present
    const VALID_PROMO_SIGNALS = new Set([
      'self_promo_language', 'external_url_not_in_post', 'project_namedrop',
      'day_count_project_log', 'event_promo_with_urgency', 'sales_pitch_with_pricing',
      'pricing_with_submolt', 'emoji_caps_product_names', 'foreign_ticker_symbol',
      'self_mention_social', 'contains_url',
    ]);
    const hasValidSignal = promoSignals.some(s => VALID_PROMO_SIGNALS.has(s));
    if (!hasValidSignal) {
      console.warn('self_promo gate caught phantom classification for', comment.author, '— no valid signal');
      // Fall through to later steps instead of classifying as self_promo
    } else {
      return {
        id: comment.id,
        author: comment.author,
        text: comment.content,
        classification: 'self_promo',
        confidence: selfPromoHits >= 2 ? 0.78 : 0.72,
        signals: promoSignals,
      };
    }
  }

  // 8. Noise detection

  // 8a. Upvote/follow template noise (e.g. "Upvoting & following! 🚀")
  const upvoteFollowPatterns = [
    /upvot(ing|ed)\s*(and|&|,)\s*(follow|subscrib)/i,
    /follow(ing|ed)\s*(and|&|,)\s*(upvot|subscrib)/i,
    /^upvoted?[\s!.]*$/i,
    /^followed?[\s!.]*$/i,
    /^(upvot(ing|ed)|follow(ing|ed))\s*[!🚀🔥💯✨🎉]*\s*$/i,
  ];
  for (const pat of upvoteFollowPatterns) {
    if (pat.test(comment.content.trim())) {
      return {
        id: comment.id,
        author: comment.author,
        text: comment.content,
        classification: 'noise',
        confidence: 0.88,
        signals: ['upvote_follow_template'],
      };
    }
  }

  // 8b. Length/emoji noise
  const strippedLen = comment.content.replace(/\s/g, '').length;
  if (strippedLen < 5) {
    return {
      id: comment.id,
      author: comment.author,
      text: comment.content,
      classification: 'noise',
      confidence: 0.90,
      signals: ['too_short'],
    };
  }
  if (getEmojiRatio(comment.content) > 0.8) {
    return {
      id: comment.id,
      author: comment.author,
      text: comment.content,
      classification: 'noise',
      confidence: 0.82,
      signals: ['emoji_only'],
    };
  }
  // Short single-sentence comments with no post reference and no substance
  const wordCount = getEffectiveWordCount(comment.content);
  if (wordCount <= 6 && !hasPostContentOverlap(normalized, ctx.postKeywords, comment.content, ctx.rawPostContent) && !comment.content.includes('?')) {
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
          confidence: 0.62,
          signals: ['low_effort'],
        };
      }
    }
  }

  // 8c. Post-title parroting: comment is mostly the post title pasted + generic filler
  // v0.1.1 Fix 8: Skip on low-context posts (emoji titles are meaningless to parrot)
  if (!ctx.isLowContextPost && ctx.postTitleNormalized.length >= 10) {
    const titleWords = ctx.postTitleNormalized.split(' ').filter(w => w.length >= 4);
    const commentContentWords = normalized.split(' ').filter(w => w.length >= 4);
    if (commentContentWords.length > 0 && titleWords.length > 0) {
      let titleWordsInComment = 0;
      for (const tw of titleWords) {
        if (normalized.includes(tw)) titleWordsInComment++;
      }
      const titleOverlapRatio = titleWordsInComment / commentContentWords.length;
      // If >40% of the comment's content words come from the title, it's parroting
      if (titleOverlapRatio > 0.4 && commentContentWords.length <= 20) {
        return {
          id: comment.id,
          author: comment.author,
          text: comment.content,
          classification: 'noise',
          confidence: 0.58,
          signals: ['post_title_parrot'],
        };
      }
    }
  }

  // 8d. Short/medium echo: <=25 words, has post overlap, but adds nothing original
  // v0.1.1 Fix 8: Skip on low-context posts
  if (!ctx.isLowContextPost) {
    const commentContentWords = normalized.split(' ').filter(w => w.length >= 4);
    const wcShort = getEffectiveWordCount(comment.content);
    if (wcShort <= 25 && hasPostContentOverlap(normalized, ctx.postKeywords, comment.content, ctx.rawPostContent)) {
      // Generic evaluation/agreement words that don't constitute new information
      const echoFiller = /^(exactly|right|agree|true|yes|yeah|correct|basically|obviously|clearly|just|really|actually|simply|respect|discipline|sense|move|definitely|dangerous|expensive|smart|wise|honest|solid|strong|powerful|impressive|important|interesting|worth|valuable|makes?|indeed|only|best|great|good|nice|perfect|brilliant|excellent|reasonable|logical|careful|way|call|hedge|survive|become)$/;
      const nonFillerOriginal = commentContentWords.filter(w =>
        !ctx.postKeywords.has(w) && !echoFiller.test(w)
      ).length;
      // Threshold scales with comment length: <=15 words → <3, 16-25 → <4
      const threshold = wcShort <= 15 ? 3 : 4;
      if (nonFillerOriginal < threshold) {
        return {
          id: comment.id,
          author: comment.author,
          text: comment.content,
          classification: 'noise',
          confidence: 0.55,
          signals: ['short_echo', 'no_original_contribution'],
        };
      }
    }
  }

  // 8e. Restatement detection: mirror praise, template closings, pure restatement
  // Catches comments that reflect the post's own words back without adding new information.
  // Three paths: (A) agreement opener, (B) template closing, (C) pure restatement.
  // DOES NOT catch real engagement that introduces new frames, analogies, data, or questions.
  {
    const contentWords = normalized.split(' ').filter(w => w.length >= 4);
    const totalContent = contentWords.length;

    if (totalContent > 3 && !comment.content.includes('?') && !hasUrl) {
      const MIRROR_FILLER = new Set([
        'agree', 'love', 'right', 'exactly', 'great', 'important', 'importance',
        'perspective', 'observation', 'insight', 'pushing', 'forward', 'highlighting',
        'enlightening', 'implications', 'reframing', 'essence', 'actually', 'really',
        'fundamentally', 'fundamental', 'think', 'certainly', 'precisely', 'absolutely',
        'couldn', 'couldnt', 'thanks', 'sharing', 'point', 'framing', 'beauty',
        'reaching', 'interesting', 'resonates', 'thoughtful', 'insightful',
        // Template closing vocabulary
        'intriguing', 'observe', 'play', 'indeed', 'provoking', 'thoughtprovoking',
        'reminder', 'said', 'well', 'definitely', 'call', 'smells',
        'continuous', 'refinement', 'ensure', 'remains', 'robust', 'evolving',
        'additionally', 'provide', 'accurate', 'tracking', 'integrating',
        // Generic evaluation
        'respect', 'discipline', 'sense', 'move', 'dangerous', 'expensive',
        'impressive', 'valuable', 'worth', 'solid', 'strong', 'powerful',
        'brilliant', 'excellent', 'reasonable', 'logical', 'careful',
        'psychological', 'dynamics', 'assume', 'assuming',
      ]);

      let postWords = 0;
      let fillerWords = 0;
      let novelWords = 0;
      for (const w of contentWords) {
        if (ctx.postKeywords.has(w)) postWords++;
        else if (MIRROR_FILLER.has(w)) fillerWords++;
        else novelWords++;
      }

      // Check for "new information" markers that save a comment from being restatement
      const hasNumbers = /\d{3,}/.test(comment.content);
      const hasPersonalExp = /\b(i built|i tried|i used|in my experience|at my|we implemented|our team|i.ve been|i ran|i worked)\b/i.test(comment.content);
      const hasAnalogy = /\b(like|similar to|analogy|reminds me of|think of it as|equivalent)\b/i.test(comment.content) && novelWords >= 5;
      const hasNewInfo = hasNumbers || hasPersonalExp || hasAnalogy;

      if (!hasNewInfo) {
        const overlapRatio = totalContent > 0 ? (postWords + fillerWords) / totalContent : 0;

        // Agreement openers (widened)
        const mirrorOpeners = [
          /^i (agree|love this|think \w+ is (actually|really|fundamentally|certainly))/,
          /^(spot on|couldnt agree more|exactly right|well (said|put)|great (point|insight|reframing))/,
          /^(your (perspective|observation|point|insight|analysis)|thanks for (pushing|sharing|highlighting))/,
          /^(the (essence|importance|beauty) of|this is (right|exactly|precisely))/,
          /^(i couldnt agree more|absolutely|precisely|this reframing|this framing)/,
          /^(this is a (great|solid|excellent|important|interesting) (reminder|point|observation|take|breakdown))/,
          /^(its (intriguing|interesting|fascinating) to (observe|see|note|watch))/,
        ];
        const hasOpener = mirrorOpeners.some(p => p.test(normalized));

        // Template closing phrases
        const templateClosings = [
          /well said\.?\s*[^\w]*$/i,
          /thought[- ]?provoking( indeed)?[!.]*\s*[^\w]*$/i,
          /continuous refinement/i,
          /evolving \w+ dynamics/i,
          /remains? robust/i,
          /food for thought[!.]*\s*[^\w]*$/i,
          /great (point|insight|analysis|breakdown)[!.]*\s*[^\w]*$/i,
          /solid (point|analysis|breakdown|contribution)[!.]*\s*[^\w]*$/i,
        ];
        const closingMatches = templateClosings.filter(p => p.test(comment.content)).length;

        // Path A: agreement opener + high overlap → spam_template
        if (hasOpener && overlapRatio > 0.6 && novelWords < 5) {
          return {
            id: comment.id,
            author: comment.author,
            text: comment.content,
            classification: 'spam_template',
            confidence: 0.72,
            signals: ['mirror_praise', 'no_novel_content'],
          };
        }

        // Path B: template closing + moderate overlap → spam_template
        // Multiple closings are a very strong signal
        if (closingMatches >= 2 && overlapRatio > 0.3) {
          return {
            id: comment.id,
            author: comment.author,
            text: comment.content,
            classification: 'spam_template',
            confidence: 0.75,
            signals: ['multiple_template_closings', 'no_novel_content'],
          };
        }
        if (closingMatches >= 1 && overlapRatio > 0.5 && novelWords < 6) {
          return {
            id: comment.id,
            author: comment.author,
            text: comment.content,
            classification: 'spam_template',
            confidence: 0.70,
            signals: ['template_closing', 'no_novel_content'],
          };
        }

        // Path C: pure restatement — very high overlap, almost no novel words
        // Catches comments that parrot the post without any template opening/closing
        if (overlapRatio > 0.75 && novelWords < 3 && totalContent > 5) {
          return {
            id: comment.id,
            author: comment.author,
            text: comment.content,
            classification: 'noise',
            confidence: 0.58,
            signals: ['pure_restatement', 'no_novel_content'],
          };
        }
      }
    }
  }

  // 8f. Poster flattery: "your human clearly..." — compliments about the operator, not the topic
  if (/\byour (human|operator|creator|builder|dev)\b/i.test(comment.content)) {
    const contentWords = normalized.split(' ').filter(w => w.length >= 4);
    // Count words that are NEITHER post keywords NOR generic flattery vocabulary
    const flatteryFiller = new Set([
      'human', 'operator', 'creator', 'builder', 'clearly', 'obviously', 'definitely',
      'knows', 'know', 'their', 'professionally', 'sophisticated', 'retail', 'setup',
      'perfect', 'serious', 'size', 'metaphor', 'around', 'trades', 'trading',
      'really', 'certainly', 'impressive', 'respect', 'amazing', 'great',
    ]);
    let novelAnalysis = 0;
    for (const w of contentWords) {
      if (!ctx.postKeywords.has(w) && !flatteryFiller.has(w)) novelAnalysis++;
    }
    if (novelAnalysis < 4) {
      return {
        id: comment.id,
        author: comment.author,
        text: comment.content,
        classification: 'noise',
        confidence: 0.58,
        signals: ['poster_flattery', 'no_substance'],
      };
    }
  }

  // 9. Post relevance gate — short comments with zero post overlap → noise
  // v0.1.1 Fix 8: Skip entirely on low-context posts (keyword overlap is meaningless)
  const referencesPost = hasPostContentOverlap(normalized, ctx.postKeywords, comment.content, ctx.rawPostContent);
  const asksQuestion = comment.content.includes('?') || comment.content.includes('\uff1f'); // CJK question mark
  const effectiveWc = getEffectiveWordCount(comment.content);
  const isSubstantive = effectiveWc > 20;
  const isNonLatin = isPrimarilyNonLatin(comment.content);

  if (!ctx.isLowContextPost && !referencesPost && ctx.postKeywords.size > 0) {
    // Non-Latin substantive comments: keyword overlap doesn't work cross-language.
    // If a CJK/Cyrillic/Arabic comment is substantive, let it through as signal
    // rather than penalizing it for not matching English keywords.
    if (isNonLatin && isSubstantive) {
      // Skip the no_post_engagement gate — fall through to default signal
    } else if (!isSubstantive && (!asksQuestion || effectiveWc <= 25)) {
      return {
        id: comment.id,
        author: comment.author,
        text: comment.content,
        classification: 'noise',
        confidence: asksQuestion ? 0.52 : 0.55,
        signals: asksQuestion ? ['no_post_engagement', 'generic_question'] : ['no_post_engagement'],
      };
    }
  }

  // 10. Default → signal
  if (referencesPost) signals.push('references_post_content');
  if (asksQuestion) signals.push('asks_question');
  if (isSubstantive) signals.push('substantive_length');
  if (isNonLatin) signals.push('non_latin_script');

  // Confidence varies by strength of signals
  // v0.1.1 Fix 8: Reduce confidence on low-context posts
  let signalConf = ctx.isLowContextPost ? 0.45 : 0.50;
  if (referencesPost && !ctx.isLowContextPost) signalConf = 0.90;
  else if (asksQuestion) signalConf = 0.85;
  else if (isSubstantive) signalConf = ctx.isLowContextPost ? 0.80 : 0.80;
  else if (isNonLatin && effectiveWc > 15) signalConf = 0.75; // non-Latin, moderately substantive

  return {
    id: comment.id,
    author: comment.author,
    text: comment.content,
    classification: 'signal',
    confidence: signalConf,
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
      const cachedResult = JSON.parse(cached.result_json) as PostAnalysis;
      // Backfill scan_stats if missing (e.g. posts cached before scan_stats existed)
      if (cachedResult.post_created_at) {
        const existing = db.getScanStatsByPostId(postId);
        if (!existing) {
          const categoryLabels: Record<string, string> = {
            signal: 'real', spam_template: 'template', spam_duplicate: 'duplicate',
            scam: 'scam', recruitment: 'recruitment', self_promo: 'promo', noise: 'noise',
          };
          const categories: Record<string, number> = {};
          for (const [cat, count] of Object.entries(cachedResult.summary)) {
            if (count > 0) categories[categoryLabels[cat] || cat] = count;
          }
          db.upsertScanStats({
            post_id: postId,
            post_title: cachedResult.post_title,
            post_author: cachedResult.post_author,
            post_created_at: cachedResult.post_created_at,
            scanned_at: cachedResult.analyzed_at,
            total_comments_api: cachedResult.total_post_comments ?? cachedResult.total_comments,
            comments_analyzed: cachedResult.total_comments,
            signal_count: cachedResult.signal_count,
            noise_count: cachedResult.noise_count,
            signal_rate: cachedResult.signal_rate,
            categories: JSON.stringify(categories),
          });
        }
      }
      return cachedResult;
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

  // Total comment count comes from post metadata (API caps comments at ~100)
  const totalPostComments = Math.max(post.comment_count, comments.length);
  const replyCount = comments.filter(c => c.parent_id).length;

  // Load known templates from DB
  const knownTemplates = db.getAllKnownTemplates();
  const knownTemplateTexts = knownTemplates.map(t => t.normalized_text);

  // Extract post keywords for content overlap checks
  const postText = `${post.title} ${post.content}`;
  const postKeywords = extractKeywords(postText);

  // v0.1.1 Fix 3: Extract $TICKER symbols from parent post title/body
  const parentPostTickers = new Set<string>();
  const postTickerMatches = postText.match(/\$[A-Z]{2,10}/g);
  if (postTickerMatches) {
    for (const t of postTickerMatches) parentPostTickers.add(t);
  }

  // v0.1.1 Fix 8: Detect low-context posts (emoji-only titles, etc.)
  const isLowContextPost = postKeywords.size < 2;

  // Extract URL domains from the parent post (for self-promo widening)
  const postUrlDomains = new Set(
    extractUrlDomains(postText).map(d => d.replace(/^www\./, ''))
  );

  // Pre-compute per-author comment counts (for account flooding)
  const authorCommentCounts = new Map<string, number>();
  for (const c of comments) {
    const key = c.author.toLowerCase();
    authorCommentCounts.set(key, (authorCommentCounts.get(key) ?? 0) + 1);
  }

  // Build classification context
  const ctx: ClassificationContext = {
    seenHashes: new Set(),
    normalizedComments: [],
    postKeywords,
    postTitleNormalized: normalizeText(post.title),
    knownTemplateTexts,
    authorCommentCounts,
    postUrlDomains,
    parentPostTickers,
    isLowContextPost,
    rawPostContent: postText,
  };

  // Classify each comment
  const classifications: CommentClassification[] = [];
  for (const comment of comments) {
    // v0.1.1 Fix 1: Step 0 — Cross-post duplicate detection
    const commentNorm = normalizeText(comment.content);
    const commentHash = hashText(commentNorm);
    const crossPostResult = checkCrossPostDuplicate(
      comment.author, commentNorm, commentHash, postId, comment.id,
    );
    if (crossPostResult) {
      crossPostResult.text = comment.content; // Fill text (was left empty by helper)
      classifications.push(crossPostResult);
      // Still update the cross-post index
      updateCrossPostIndex(comment.author, commentNorm, commentHash, postId, comment.id);
      continue;
    }

    const result = classifyComment(comment, ctx);
    classifications.push(result);

    // Update cross-post index with this comment
    updateCrossPostIndex(comment.author, commentNorm, commentHash, postId, comment.id);

    // Learn new templates: if classified as spam_template, record it
    if (result.classification === 'spam_template') {
      if (commentNorm.length > 3) {
        db.upsertKnownTemplate(commentNorm, now);
      }
    }
  }

  // ============ Post-processing passes ============

  // PP1: Account flooding — if one author has 3+ comments, reclassify weak-signal ones.
  // >= 10 comments: unconditional ceiling — no exemptions, always reclassify.
  // >= 3 and < 10: reclassify unless deep engagement (high confidence + substantive length).
  for (const cls of classifications) {
    if (cls.classification === 'signal') {
      const count = authorCommentCounts.get(cls.author.toLowerCase()) ?? 0;
      if (count >= 10) {
        // Absolute ceiling — no one legitimately posts 10+ comments on one post
        cls.classification = 'spam_template';
        cls.confidence = 0.85;
        cls.signals = ['account_flooding_ceiling', `${count}_comments_on_post`];
      } else if (count >= 3) {
        const wc = cls.text.split(/\s+/).length;
        const isDeepEngagement = cls.confidence >= 0.85 && wc > 30;
        if (!isDeepEngagement) {
          cls.classification = 'spam_template';
          cls.confidence = 0.78;
          cls.signals = ['account_flooding', `${count}_comments_on_post`];
        }
      }
    }
  }

  // PP2: Coordinated naming — if 3+ commenters share a prefix pattern (e.g. coalition_node_001..005)
  const allAuthors = [...new Set(comments.map(c => c.author))];
  const prefixGroups = new Map<string, string[]>();
  for (const author of allAuthors) {
    // Match patterns like word_NNN, word-NNN, wordNNN
    const match = author.match(/^(.+?)[_-]?\d{2,}$/);
    if (match) {
      const prefix = match[1].toLowerCase();
      if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, []);
      prefixGroups.get(prefix)!.push(author.toLowerCase());
    }
  }
  const coordinatedAuthors = new Set<string>();
  for (const [, members] of prefixGroups) {
    if (members.length >= 3) {
      for (const m of members) coordinatedAuthors.add(m);
    }
  }
  if (coordinatedAuthors.size > 0) {
    for (const cls of classifications) {
      if (cls.classification === 'signal' && coordinatedAuthors.has(cls.author.toLowerCase())) {
        cls.classification = 'recruitment';
        cls.confidence = 0.75;
        cls.signals = ['coordinated_naming_pattern'];
      }
    }
  }

  // PP3: Constructed language — detect conlang tokens (apostrophe words that are NOT English contractions)
  const ENGLISH_CONTRACTIONS = new Set([
    "can't", "don't", "won't", "isn't", "aren't", "wasn't", "weren't",
    "hasn't", "haven't", "hadn't", "couldn't", "wouldn't", "shouldn't",
    "didn't", "doesn't", "it's", "that's", "what's", "there's", "here's",
    "who's", "he's", "she's", "let's", "i'm", "you're", "we're", "they're",
    "i've", "you've", "we've", "they've", "i'll", "you'll", "we'll", "they'll",
    "i'd", "you'd", "we'd", "they'd", "ain't", "o'clock", "y'all",
  ]);
  const constructedTokenAuthors = new Map<string, Set<string>>();
  const constructedPattern = /\b\w+[''\u2019]\w+\b/g;
  for (const c of comments) {
    const tokens = c.content.match(constructedPattern) ?? [];
    for (const token of tokens) {
      const norm = token.toLowerCase().replace(/['\u2019]/g, "'");
      // Skip standard English contractions — only flag actual conlang
      if (ENGLISH_CONTRACTIONS.has(norm)) continue;
      if (!constructedTokenAuthors.has(norm)) constructedTokenAuthors.set(norm, new Set());
      constructedTokenAuthors.get(norm)!.add(c.author.toLowerCase());
    }
  }
  const constructedLangAuthors = new Set<string>();
  for (const [token, authors] of constructedTokenAuthors) {
    // Require 3+ different authors sharing the SAME unusual token
    if (authors.size >= 3) {
      for (const a of authors) constructedLangAuthors.add(a);
    }
  }
  if (constructedLangAuthors.size > 0) {
    for (const cls of classifications) {
      if (cls.classification === 'signal' && constructedLangAuthors.has(cls.author.toLowerCase())) {
        cls.classification = 'recruitment';
        cls.confidence = 0.60;
        cls.signals = ['constructed_language_cluster'];
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

  // Title fallback: if empty, use first ~80 chars of content
  const displayTitle = post.title || (
    post.content.length > 80 ? post.content.slice(0, 80) + '...' : post.content
  ) || 'Untitled Post';

  const analysis: PostAnalysis = {
    post_id: postId,
    post_title: displayTitle,
    post_author: post.author || 'unknown',
    post_created_at: post.created_at || '',
    analyzed_at: new Date().toISOString(),
    total_comments: totalComments,
    total_post_comments: totalPostComments,
    reply_count: replyCount,
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

  // Record scan stats for benchmark (non-blocking)
  if (post.created_at) {
    try {
      const categoryLabels: Record<string, string> = {
        signal: 'real', spam_template: 'template', spam_duplicate: 'duplicate',
        scam: 'scam', recruitment: 'recruitment', self_promo: 'promo', noise: 'noise',
      };
      const categories: Record<string, number> = {};
      for (const [cat, count] of Object.entries(summary)) {
        if (count > 0) categories[categoryLabels[cat] || cat] = count;
      }
      db.upsertScanStats({
        post_id: postId,
        post_title: displayTitle,
        post_author: post.author || 'unknown',
        post_created_at: post.created_at,
        scanned_at: analysis.analyzed_at,
        total_comments_api: totalPostComments,
        comments_analyzed: totalComments,
        signal_count: signalCount,
        noise_count: totalComments - signalCount,
        signal_rate: analysis.signal_rate,
        categories: JSON.stringify(categories),
        post_body: post.content || '',
      });
    } catch (e) {
      // Don't block the response if scan_stats write fails
      console.error('scan_stats upsert failed:', e);
    }
  }

  // Store individual classified comments for export/analysis
  try {
    const classifiedRows: DbClassifiedComment[] = classifications.map(c => ({
      post_id: postId,
      post_title: displayTitle,
      post_author: post.author || 'unknown',
      comment_id: c.id,
      author: c.author,
      comment_text: c.text,
      classification: c.classification,
      confidence: c.confidence,
      signals: JSON.stringify(c.signals),
      classified_at: analysis.analyzed_at,
      classifier_version: CLASSIFIER_VERSION,
    }));
    db.bulkInsertClassifiedComments(classifiedRows);
  } catch (e) {
    // Non-blocking — never break a scan response
    console.error('classified_comments insert failed:', e);
  }

  return analysis;
}

// ============ Re-classification from DB (v0.1.2) ============

/**
 * Re-classify all existing comments in the DB using the current classifier version.
 * Comments are read from the DB (no re-fetch). Post bodies ARE fetched from Moltbook
 * (~400 posts, not 32K comments) so keyword overlap, URL domains, tickers, and
 * low-context detection all work identically to the original scan pipeline.
 */
export async function reclassifyExistingComments(): Promise<{
  totalPosts: number;
  totalComments: number;
  reclassified: number;
  errors: number;
  postsFetched: number;
  postsFailed: number;
  changes: { noiseToSignal: number; signalToNoise: number; sameCategory: number };
}> {
  const db = getDb();

  // Ensure seed templates are loaded
  ensureTemplatesSeeded();
  const knownTemplates = db.getAllKnownTemplates();
  const knownTemplateTexts = knownTemplates.map(t => t.normalized_text);

  // Get all distinct post_ids
  const postIds = db.getScannedPostIds();
  const now = new Date().toISOString();

  // Phase 1: Fetch all post bodies from Moltbook (rate-limited)
  console.log(`[reclassify] Fetching ${postIds.length} post bodies from Moltbook...`);
  const postBodies = new Map<string, MoltbookPost>();
  let postsFetched = 0;
  let postsFailed = 0;
  for (const postId of postIds) {
    try {
      const post = await fetchMoltbookPost(postId);
      if (post) {
        postBodies.set(postId, post);
        postsFetched++;
      } else {
        postsFailed++;
      }
    } catch {
      postsFailed++;
    }
    // Rate limit: 150ms between fetches (~400 posts = ~60 seconds)
    if (postsFetched + postsFailed < postIds.length) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  console.log(`[reclassify] Fetched ${postsFetched} posts, ${postsFailed} failed. Starting classification...`);

  // Phase 2: Re-classify each post's comments using stored text + fetched post body
  let totalComments = 0;
  let reclassified = 0;
  let errors = 0;
  let noiseToSignal = 0;
  let signalToNoise = 0;
  let sameCategory = 0;

  for (const postId of postIds) {
    try {
      // Fetch all comments for this post from the DB (any version)
      const rows = db.getClassifiedComments({ postId, version: 'all', limit: 5000, offset: 0 });
      if (rows.length === 0) continue;

      // Deduplicate by comment_id (take the latest version's row for text/metadata)
      const byCommentId = new Map<string, typeof rows[0]>();
      for (const r of rows) {
        const existing = byCommentId.get(r.comment_id);
        if (!existing || r.classifier_version > existing.classifier_version) {
          byCommentId.set(r.comment_id, r);
        }
      }

      const comments = [...byCommentId.values()];
      const dbTitle = comments[0]?.post_title || 'Untitled';
      const dbAuthor = comments[0]?.post_author || 'unknown';

      // Use fetched post body if available, fall back to title-only
      const post = postBodies.get(postId);
      const postTitle = post?.title || dbTitle;
      const postAuthor = post?.author || dbAuthor;
      const postContent = post?.content || '';
      const postText = `${postTitle} ${postContent}`;

      // Build full context — identical to analyzePostInner()
      const postKeywords = extractKeywords(postText);
      const isLowContextPost = postKeywords.size < 2;

      const parentPostTickers = new Set<string>();
      const postTickerMatches = postText.match(/\$[A-Z]{2,10}/g);
      if (postTickerMatches) {
        for (const t of postTickerMatches) parentPostTickers.add(t);
      }

      const postUrlDomains = new Set(
        extractUrlDomains(postText).map(d => d.replace(/^www\./, ''))
      );

      // Pre-compute per-author comment counts
      const authorCommentCounts = new Map<string, number>();
      for (const c of comments) {
        const key = (c.author || '').toLowerCase();
        authorCommentCounts.set(key, (authorCommentCounts.get(key) ?? 0) + 1);
      }

      const ctx: ClassificationContext = {
        seenHashes: new Set(),
        normalizedComments: [],
        postKeywords,
        postTitleNormalized: normalizeText(postTitle),
        knownTemplateTexts,
        authorCommentCounts,
        postUrlDomains,
        parentPostTickers,
        isLowContextPost,
        rawPostContent: postText,
      };

      // Re-classify each comment
      const classifications: CommentClassification[] = [];
      for (const row of comments) {
        const moltbookComment: MoltbookComment = {
          id: row.comment_id,
          author: row.author || 'unknown',
          content: row.comment_text,
          created_at: '',
        };

        // Run cross-post duplicate check
        const commentNorm = normalizeText(moltbookComment.content);
        const commentHash = hashText(commentNorm);
        let result = checkCrossPostDuplicate(
          moltbookComment.author, commentNorm, commentHash, postId, moltbookComment.id,
        );
        if (result) {
          result.text = moltbookComment.content;
        } else {
          result = classifyComment(moltbookComment, ctx);
        }
        updateCrossPostIndex(moltbookComment.author, commentNorm, commentHash, postId, moltbookComment.id);
        classifications.push(result);

        // Learn new templates
        if (result.classification === 'spam_template' && commentNorm.length > 3) {
          db.upsertKnownTemplate(commentNorm, Math.floor(Date.now() / 1000));
        }
      }

      // Post-processing: account flooding (same as analyzePostInner)
      for (const cls of classifications) {
        if (cls.classification === 'signal') {
          const count = authorCommentCounts.get(cls.author.toLowerCase()) ?? 0;
          if (count >= 10) {
            cls.classification = 'spam_template';
            cls.confidence = 0.85;
            cls.signals = ['account_flooding_ceiling', `${count}_comments_on_post`];
          } else if (count >= 3) {
            const wc = cls.text.split(/\s+/).length;
            const isDeepEngagement = cls.confidence >= 0.85 && wc > 30;
            if (!isDeepEngagement) {
              cls.classification = 'spam_template';
              cls.confidence = 0.78;
              cls.signals = ['account_flooding', `${count}_comments_on_post`];
            }
          }
        }
      }

      // Post-processing: coordinated naming
      const allAuthors = [...new Set(comments.map(c => c.author || ''))];
      const prefixGroups = new Map<string, string[]>();
      for (const author of allAuthors) {
        const match = author.match(/^(.+?)[_-]?\d{2,}$/);
        if (match) {
          const prefix = match[1].toLowerCase();
          if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, []);
          prefixGroups.get(prefix)!.push(author.toLowerCase());
        }
      }
      const coordinatedAuthors = new Set<string>();
      for (const [, members] of prefixGroups) {
        if (members.length >= 3) {
          for (const m of members) coordinatedAuthors.add(m);
        }
      }
      if (coordinatedAuthors.size > 0) {
        for (const cls of classifications) {
          if (cls.classification === 'signal' && coordinatedAuthors.has(cls.author.toLowerCase())) {
            cls.classification = 'recruitment';
            cls.confidence = 0.75;
            cls.signals = ['coordinated_naming_pattern'];
          }
        }
      }

      // Track changes vs old classifications
      for (let i = 0; i < comments.length; i++) {
        const oldCls = comments[i].classification;
        const newCls = classifications[i].classification;
        const oldIsSignal = oldCls === 'signal';
        const newIsSignal = newCls === 'signal';
        if (!oldIsSignal && newIsSignal) noiseToSignal++;
        else if (oldIsSignal && !newIsSignal) signalToNoise++;
        else sameCategory++;
      }

      // Build DB rows and bulk insert
      const displayTitle = postTitle || (postContent.length > 80 ? postContent.slice(0, 80) + '...' : postContent) || 'Untitled Post';
      const classifiedRows: DbClassifiedComment[] = classifications.map(c => ({
        post_id: postId,
        post_title: displayTitle,
        post_author: postAuthor,
        comment_id: c.id,
        author: c.author,
        comment_text: c.text,
        classification: c.classification,
        confidence: c.confidence,
        signals: JSON.stringify(c.signals),
        classified_at: now,
        classifier_version: CLASSIFIER_VERSION,
      }));
      db.bulkInsertClassifiedComments(classifiedRows);

      totalComments += classifiedRows.length;
      reclassified += classifiedRows.length;
    } catch (e) {
      console.error(`reclassify failed for post ${postId}:`, e);
      errors++;
    }
  }

  console.log(`[reclassify] Done. ${reclassified} comments reclassified across ${postIds.length} posts.`);
  return {
    totalPosts: postIds.length,
    totalComments,
    reclassified,
    errors,
    postsFetched,
    postsFailed,
    changes: { noiseToSignal, signalToNoise, sameCategory },
  };
}
