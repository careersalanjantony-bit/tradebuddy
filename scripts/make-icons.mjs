// Renders public/icons/icon-{16,32,48,128}.png (the navy brand circle with the mint arrow, as in the app's top bar) from an
// inline SVG using the local Playwright Chromium (PW_CHANNEL=msedge uses an installed browser).
// Run once (npm run icons); the PNGs are committed.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const svg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <circle cx="64" cy="64" r="60" fill="#1e293b"/>
  <polyline points="30,88 52,66 68,78 98,44" fill="none" stroke="#10b981" stroke-width="${size <= 16 ? 16 : 12}"
            stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="76,44 98,44 98,66" fill="none" stroke="#10b981" stroke-width="${size <= 16 ? 16 : 12}"
            stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const out = new URL('../public/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
  await page.screenshot({ path: fileURLToPath(new URL(`icon-${size}.png`, out)), omitBackground: true });
  console.log(`icon-${size}.png`);
}
await browser.close();
