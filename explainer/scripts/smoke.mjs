// Serves site/, then scrolls the whole page in Chromium at desktop and phone sizes so every part renders its frames.
// Fails on any page error (the episodes' own asserts throw if a drawn number disagrees with the engine), on any
// asset that fails to load, and on sideways scrolling.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("../site/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2", ".ttf": "font/ttf", ".css": "text/css" };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  try {
    const file = join(ROOT, path.endsWith("/") ? `${path}index.html` : path);
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const url = `http://localhost:${server.address().port}/`;

const problems = [];
const browser = await chromium.launch();
for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport, isMobile: name === "phone", hasTouch: name === "phone" });
  page.on("pageerror", (e) => problems.push(`${name}: page error: ${e.message}`));
  page.on("response", (r) => r.status() >= 400 && problems.push(`${name}: ${r.status()} ${r.url()}`));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(800);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += Math.round(viewport.height * 0.7)) {
    await page.evaluate((t) => scrollTo(0, t), y);
    await page.waitForTimeout(40);
  }
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (wide > 0) problems.push(`${name}: page scrolls sideways by ${wide}px`);
  const parts = await page.evaluate(() => document.querySelectorAll("section.part").length);
  console.log(`${name}: scrolled ${height}px through ${parts} parts`);
  if (parts < 10) problems.push(`${name}: only ${parts} parts rendered`);
  await page.close();
}
await browser.close();
server.close();

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("smoke test passed");
