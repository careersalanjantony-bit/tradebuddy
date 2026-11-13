// Renders public/icons/icon-{16,32,48,128}.png from an inline SVG using the local Playwright Chromium.
// Run once (npm run icons); the PNGs are committed.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const svg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <rect x="4" y="4" width="120" height="120" rx="26" fill="#1f6feb"/>
  <polyline points="22,92 48,66 66,80 104,38" fill="none" stroke="#ffffff" stroke-width="${size <= 16 ? 16 : 12}"
            stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="80,36 106,36 106,62" fill="none" stroke="#ffffff" stroke-width="${size <= 16 ? 16 : 12}"
            stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
  await page.screenshot({ path: new URL(`icon-${size}.png`, out).pathname, omitBackground: true });
  console.log(`icon-${size}.png`);
}
await browser.close();
