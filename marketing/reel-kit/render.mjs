// Renders one Reel spec to PNG frames.
// Usage: node render.mjs <spec.json> <outDir> [fps] [only=comma,separated,frames]
// Prints {duration, events, frames} as JSON on stdout.
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [, , specPath, outDir, fpsArg = '30', only] = process.argv;
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const fps = Number(fpsArg);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
await page.goto('file://' + resolve(here, 'reel.html'));
await page.evaluate(() => document.fonts.ready);
const meta = await page.evaluate((s) => window.init(s), spec);
const total = Math.round(meta.duration * fps);
const frames = only ? only.split(',').map(Number) : [...Array(total).keys()];
for (const i of frames) {
  await page.evaluate((t) => window.render(t), i / fps);
  await page.screenshot({ path: `${outDir}/f${String(i).padStart(4, '0')}.png` });
}
await browser.close();
console.log(JSON.stringify({ ...meta, frames: total, fps }));
