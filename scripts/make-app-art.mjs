#!/usr/bin/env node
/**
 * Renders the TradeBuddy Android icons and splash screens (replacing Capacitor's default artwork):
 * a green rising line on a dark navy square. Run once after `npx cap add android`, or after changing
 * the design: node scripts/make-app-art.mjs
 */
import { createRequire } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const res = fileURLToPath(new URL('../android/app/src/main/res/', import.meta.url));
const NAVY = '#0f1720';
const GREEN = '#22c55e';

/** the mark, drawn in a 100×100 box */
const mark = (stroke = 9) => `
  <polyline points="14,70 38,46 54,60 84,28" fill="none" stroke="${GREEN}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="64,28 84,28 84,48" fill="none" stroke="${GREEN}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;

const icon = (size, round) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  ${round ? `<circle cx="50" cy="50" r="50" fill="${NAVY}"/>` : `<rect width="100" height="100" rx="22" fill="${NAVY}"/>`}
  <g transform="translate(15 15) scale(0.7)">${mark()}</g></svg>`;
// adaptive-icon foreground: transparent, mark inside the 66/108 safe zone
const foreground = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 108 108">
  <g transform="translate(27 27) scale(0.54)">${mark(10)}</g></svg>`;
const splash = (w, h) => {
  const s = Math.min(w, h) * 0.28;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${NAVY}"/>
  <g transform="translate(${(w - s) / 2} ${(h - s) / 2 - s * 0.15}) scale(${s / 100})">${mark()}</g>
  <text x="${w / 2}" y="${(h + s) / 2 + s * 0.12}" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="${s * 0.22}" fill="#e6edf3">TradeBuddy</text></svg>`;
};

const pngSize = (f) => {
  const b = require('node:fs').readFileSync(f);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(svg, w, h, file) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
}
let n = 0;
for (const dir of readdirSync(res)) {
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png', 'splash.png']) {
    const f = join(res, dir, name);
    if (!existsSync(f)) continue;
    const [w, h] = pngSize(f);
    const svg = name === 'splash.png' ? splash(w, h) : name === 'ic_launcher_foreground.png' ? foreground(w) : icon(w, name === 'ic_launcher_round.png');
    await render(svg, w, h, f);
    n++;
  }
}
await browser.close();
console.log(`Rendered ${n} images`);
