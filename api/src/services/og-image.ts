/**
 * OG Image Generator
 *
 * Renders a 1200x630 PNG stats card for Twitter/OpenGraph previews.
 * Uses @napi-rs/canvas (prebuilt Rust, no system deps).
 */

import { createCanvas } from '@napi-rs/canvas';

export interface OgImageStats {
  comments_classified: number;
  posts_scanned: number;
  agents_analyzed: number;
  slop_rate: number;      // 0-100
  signal_rate: number;    // 0-100
  duplicate_rate: number; // 0-100
  slopfather_count: number;
  moltbook_comments: number;
  estimated_slop: number;
}

const W = 1200;
const H = 630;

const BG = '#0a0c12';
const SURFACE = '#12141d';
const BORDER = '#2a2d3a';
const TEXT = '#e2e4e9';
const MUTED = '#8b8fa3';
const GREEN = '#22c55e';
const RED = '#ef4444';
const ORANGE = '#f97316';
const ACCENT = '#6366f1';

function fmt(n: number): string {
  return Math.floor(n).toLocaleString('en-US');
}

function roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawStatBox(
  ctx: any,
  x: number, y: number,
  w: number, h: number,
  label: string,
  value: string,
  color: string,
) {
  // Box background
  roundRect(ctx, x, y, w, h, 8);
  ctx.fillStyle = SURFACE;
  ctx.fill();
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Label
  ctx.fillStyle = MUTED;
  ctx.font = '600 13px "Courier New", monospace';
  ctx.fillText(label.toUpperCase(), x + 14, y + 26);

  // Value
  ctx.fillStyle = color;
  ctx.font = '700 32px "Courier New", monospace';
  ctx.fillText(value, x + 14, y + 62);
}

export function renderOgImage(stats: OgImageStats): Buffer {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Subtle gradient overlay at top
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, 'rgba(239, 68, 68, 0.04)');
  grad.addColorStop(1, 'rgba(249, 115, 22, 0.04)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 100);

  // Title
  ctx.fillStyle = RED;
  ctx.font = '800 42px "Courier New", monospace';
  ctx.fillText('MOLTBOOK SLOP CLOCK', 50, 65);

  // Subtitle
  ctx.fillStyle = MUTED;
  ctx.font = '400 16px "Courier New", monospace';
  ctx.fillText('Real-time AI comment classification', 50, 92);

  // Branding
  ctx.fillStyle = ACCENT;
  ctx.font = '600 14px "Courier New", monospace';
  ctx.textAlign = 'right';
  ctx.fillText('sanctuary-ops.xyz', W - 50, 30);
  ctx.textAlign = 'left';

  // Divider
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(50, 110);
  ctx.lineTo(W - 50, 110);
  ctx.stroke();

  // Stats grid — Row 1 (left: counts, right: rates)
  const boxW = 340;
  const boxH = 80;
  const gap = 16;
  const startX = 50;
  const startY = 128;

  // Row 1
  drawStatBox(ctx, startX, startY, boxW, boxH,
    'Comments Classified', fmt(stats.comments_classified), GREEN);
  drawStatBox(ctx, startX + boxW + gap, startY, boxW, boxH,
    'Slop Rate', stats.slop_rate.toFixed(1) + '%', RED);
  drawStatBox(ctx, startX + (boxW + gap) * 2, startY, boxW, boxH,
    'Signal Rate', stats.signal_rate.toFixed(1) + '%', GREEN);

  // Row 2
  const row2Y = startY + boxH + gap;
  drawStatBox(ctx, startX, row2Y, boxW, boxH,
    'Posts Scanned', fmt(stats.posts_scanned), TEXT);
  drawStatBox(ctx, startX + boxW + gap, row2Y, boxW, boxH,
    'Agents Analyzed', fmt(stats.agents_analyzed), TEXT);
  drawStatBox(ctx, startX + (boxW + gap) * 2, row2Y, boxW, boxH,
    'Copy-Paste Rate', stats.duplicate_rate.toFixed(1) + '%', RED);

  // Bottom hero — estimated platform-wide slop
  const heroY = row2Y + boxH + 32;

  // Hero background
  roundRect(ctx, startX, heroY, W - 100, 120, 10);
  ctx.fillStyle = 'rgba(239, 68, 68, 0.06)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.2)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Hero label
  ctx.fillStyle = ORANGE;
  ctx.font = '600 14px "Courier New", monospace';
  ctx.fillText('ESTIMATED PLATFORM-WIDE', startX + 24, heroY + 30);

  // Hero number
  ctx.fillStyle = RED;
  ctx.font = '800 48px "Courier New", monospace';
  ctx.fillText(fmt(stats.estimated_slop), startX + 24, heroY + 82);

  // Hero suffix
  const numWidth = ctx.measureText(fmt(stats.estimated_slop)).width;
  ctx.fillStyle = MUTED;
  ctx.font = '400 22px "Courier New", monospace';
  ctx.fillText(' slop comments', startX + 24 + numWidth, heroY + 82);

  // Hero denominator
  ctx.fillStyle = '#ffffff80';
  ctx.font = '400 16px "Courier New", monospace';
  ctx.textAlign = 'right';
  ctx.fillText('of ' + fmt(stats.moltbook_comments) + ' total', W - 74, heroY + 82);
  ctx.textAlign = 'left';

  // Footer
  ctx.fillStyle = '#4a4d5e';
  ctx.font = '400 13px "Courier New", monospace';
  ctx.fillText('Live data  \u00b7  Updated every 5 minutes  \u00b7  Zero LLM calls  \u00b7  $0 per classification', 50, H - 20);

  return Buffer.from(canvas.toBuffer('image/png'));
}
