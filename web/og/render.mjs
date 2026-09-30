// Regenerates ../og-image.png (1200x630) from card.html.
//
//   npm i --no-save playwright-core   # any recent version
//   CHROMIUM=/path/to/chromium node web/og/render.mjs
//
// CHROMIUM is optional when Playwright already has a browser installed.
import { chromium } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}
);
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});
await page.goto(pathToFileURL(path.join(here, 'card.html')).href);
await page.waitForLoadState('networkidle');
await page.screenshot({ path: path.join(here, '..', 'og-image.png') });
await browser.close();
console.log('wrote web/og-image.png');
