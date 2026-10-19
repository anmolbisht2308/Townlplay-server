import { chromium } from "playwright-core";
const [, , html, outDir, fps, dur, only] = process.argv;
const b = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox"],
});
const pg = await b.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
await pg.goto("file://" + html);
await pg.evaluate(() => document.fonts.ready);
const n = Math.round(+fps * +dur);
const frames = only ? only.split(",").map(Number) : [...Array(n).keys()];
for (const i of frames) {
  await pg.evaluate((t) => window.render(t), i / +fps);
  await pg.screenshot({ path: `${outDir}/f${String(i).padStart(4, "0")}.png` });
}
await b.close();
