#!/usr/bin/env node
/* Browser smoke tests for the web app.
 *
 * Serves the repo over a throwaway local HTTP server and drives the real page
 * in Chromium, covering the parts unit tests can't reach: the six views, the
 * per-source sort orders, the read -> rate -> recommend loop, and the variety
 * nudge that keeps one platform from taking over the queue.
 *
 *     node scripts/test_app_browser.js
 *
 * Playwright is optional on purpose - this repo otherwise needs no third-party
 * packages, so if Playwright isn't installed the suite reports SKIPPED and
 * exits 0 rather than failing. To enable it:
 *
 *     npm i -D playwright && npx playwright install chromium
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript",
                ".css": "text/css", ".json": "application/json",
                ".png": "image/png" };

function loadPlaywright() {
  for (const id of ["playwright", "playwright-core",
                    "/opt/node22/lib/node_modules/playwright"]) {
    try { return require(id); } catch { /* try the next one */ }
  }
  return null;
}

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.join(ROOT, rel);
    // Don't serve anything outside the repo.
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1",
    () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

// ---------------------------------------------------------------- assertions
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${ok || detail == null ? "" : `\n          ${detail}`}`);
}
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ---------------------------------------------------------------- the tests
async function run(page, base) {
  const consoleErrors = [];
  page.on("pageerror", e => consoleErrors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") consoleErrors.push("console: " + m.text()); });

  await page.goto(`${base}/index.html`, { waitUntil: "networkidle" });

  // -- every tab shows exactly its own view --------------------------------
  for (const view of ["next", "papers", "hn", "browse", "library", "stats"]) {
    await page.click(`#tabs button[data-view="${view}"]`);
    const state = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll("#tabs button.active")].map(b => b.dataset.view),
      views: [...document.querySelectorAll(".view.active")].map(s => s.id),
    }));
    check(`tab "${view}" activates only view-${view}`,
          state.tabs.length === 1 && state.views.length === 1 &&
          state.views[0] === `view-${state.tabs[0]}` && state.tabs[0] === view,
          JSON.stringify(state));
  }

  // -- Papers: sorted by upvotes, dual links, source filter hidden ---------
  await page.click('#tabs button[data-view="papers"]');
  const upvotes = await page.$$eval("#papers-list .card .extra",
    ns => ns.map(n => parseInt(n.textContent.replace(/\D/g, ""), 10) || 0));
  check("papers view is populated", upvotes.length > 0, `${upvotes.length} cards`);
  check("papers sorted by upvotes, descending",
        upvotes.every((v, i) => i === 0 || upvotes[i - 1] >= v), JSON.stringify(upvotes));
  const paperLinks = await page.$$eval("#papers-list .card:first-child a", as => as.map(a => a.href));
  check("paper links to Hugging Face and arXiv",
        paperLinks.some(h => h.includes("huggingface.co/papers")) &&
        paperLinks.some(h => h.includes("arxiv.org/abs")), JSON.stringify(paperLinks));
  check("source filter hidden on the single-source Papers view",
        await page.$eval("#source-filters", n => getComputedStyle(n).display === "none"));

  // -- Hacker News: newest first, article + discussion links ---------------
  await page.click('#tabs button[data-view="hn"]');
  const dates = (await page.$$eval("#hn-list .card .meta-row",
    ns => ns.map(n => (n.textContent.match(/\d{4}-\d{2}-\d{2}/) || [])[0]).filter(Boolean)));
  check("hacker news view is populated",
        (await page.$$("#hn-list .card")).length > 0);
  check("hacker news sorted newest first",
        dates.every((d, i) => i === 0 || dates[i - 1] >= d), JSON.stringify(dates));
  const hnLinks = await page.$$eval("#hn-list .card:first-child a", as => as.map(a => a.href));
  check("hacker news card links to the article and the discussion",
        hnLinks.some(h => !h.includes("news.ycombinator.com")) &&
        hnLinks.some(h => h.includes("news.ycombinator.com/item")), JSON.stringify(hnLinks));

  // -- per-source verbs ----------------------------------------------------
  eq("papers/blogs use a read verb",
     (await page.textContent("#hn-list .card button.btn.small:not(.thumb)")).trim(), "✓ Mark read");

  // -- Skip actually skips (it used to be a no-op) -------------------------
  await page.click('#tabs button[data-view="next"]');
  const heroBefore = (await page.textContent(".hero h2")).trim();
  const queueBefore = (await page.$$("#queue-list .card")).length;
  await page.click(".hero-actions .btn.ghost");
  const heroAfter = (await page.textContent(".hero h2")).trim();
  const queueAfter = (await page.$$("#queue-list .card")).length;
  check("skip advances the hero", heroBefore !== heroAfter, `${heroBefore} -> ${heroAfter}`);
  check("skip removes the item from the queue", queueAfter === queueBefore - 1,
        `${queueBefore} -> ${queueAfter}`);

  // -- read -> rate -> library loop ---------------------------------------
  await page.click('#tabs button[data-view="hn"]');
  for (let i = 0; i < 4; i++) await page.click("#hn-list .card button.btn.small:not(.thumb)");
  await page.click('#tabs button[data-view="library"]');
  check("library collects what you marked read",
        (await page.$$("#library-list .card")).length === 4,
        `${(await page.$$("#library-list .card")).length} cards`);
  check("library prompts for an unrated item",
        (await page.textContent("#review-banner")).includes("4"));
  for (let i = 0; i < 4; i++) await page.click("#library-list .card .thumb.up:not(.on)");
  check("rating clears the prompt",
        (await page.textContent("#review-banner")).trim() === "");

  // -- the queue mixes sources rather than serving one platform ------------
  await page.click('#tabs button[data-view="next"]');
  const badges = await page.$$eval("#queue-list .card .badge", bs => bs.map(b => b.textContent));
  // Smoke check only: the shipped catalog is small and its topic/recency
  // signals dominate, so this can't prove the nudge - runVarietyNudge() below
  // does that against a controlled fixture. All this asserts is that the source
  // you just binged stops leading the queue.
  const head = badges.slice(0, 8);
  check("the source you just binged no longer leads the queue",
        head.filter(b => b === "Hacker News").length <= 1,
        JSON.stringify(head));

  // -- topic filter works on a single-source view --------------------------
  await page.click('#tabs button[data-view="papers"]');
  const chips = await page.$$("#topic-filters .chip");
  await chips[1].click();
  const filtered = await page.$$eval("#papers-list .card .topic-tag", ts => ts.map(t => t.textContent));
  check("topic filter narrows the Papers view",
        filtered.length > 0 && filtered.every(t => t === "Hermes"), JSON.stringify(filtered));
  await chips[1].click();

  // -- stats ---------------------------------------------------------------
  await page.click('#tabs button[data-view="stats"]');
  check("filters hidden on Stats",
        await page.$eval("#filters", n => getComputedStyle(n).display === "none"));
  check("stats charts both catalog composition and consumption",
        (await page.$$(".bar-row")).length >= 10,
        `${(await page.$$(".bar-row")).length} bar rows`);

  check("no console or page errors anywhere in the run",
        consoleErrors.length === 0, consoleErrors.join("\n          "));
}

/* The variety nudge is invisible against the shipped catalog - the topic and
 * recency signals swamp it. So measure it against a controlled fixture: equal
 * counts per source, one topic, one date, so source affinity and the nudge are
 * the only things left moving the ranking.
 *
 * Without the nudge, liking five items from one source makes that source's
 * affinity dominate and it takes the whole queue head. With it, the queue tilts
 * to the sources you haven't touched. */
function syntheticCatalog() {
  const sources = ["paper", "hackernews", "website", "podcast", "youtube"];
  const items = [];
  for (const source of sources) {
    for (let i = 0; i < 12; i++) {
      items.push({
        id: `${source}-${i}`, title: `${source} item ${i}`, source,
        creator: "", topics: ["Antigravity"], url: `https://example.invalid/${source}/${i}`,
        published_at: "2026-01-01", description: "fixture", extra: {},
      });
    }
  }
  return { generated_at: "fixture", items };
}

async function runVarietyNudge(page, base) {
  await page.route("**/data/catalog.json", route =>
    route.fulfill({ status: 200, contentType: "application/json",
                    body: JSON.stringify(syntheticCatalog()) }));
  await page.goto(`${base}/index.html`, { waitUntil: "networkidle" });

  // Read and like five papers. Every item is otherwise identical, so the only
  // things left moving the ranking are source affinity (which pulls papers up)
  // and the variety nudge (which pushes them down).
  await page.click('#tabs button[data-view="papers"]');
  for (let i = 0; i < 5; i++) await page.click("#papers-list .card button.btn.small:not(.thumb)");
  await page.click('#tabs button[data-view="library"]');
  for (let i = 0; i < 5; i++) await page.click("#library-list .card .thumb.up:not(.on)");

  await page.click('#tabs button[data-view="next"]');
  const hero = (await page.textContent(".hero .badge")).trim();
  // The hero is the #1 pick and sits outside #queue-list, so prepend it.
  const queue = [hero, ...await page.$$eval("#queue-list .card .badge", bs => bs.map(b => b.textContent))];
  const firstPaper = queue.indexOf("Paper");
  const remaining = queue.filter(b => b === "Paper").length;

  check("fixture loaded", queue.length === 55, `${queue.length} unread`);
  check("seven papers remain unread", remaining === 7, `${remaining}`);
  // Source affinity alone would put the liked source at the very front. The
  // nudge is what keeps it out of the queue head.
  check("the binged source is pushed out of the queue head",
        firstPaper === -1 || firstPaper >= 10,
        `first Paper at index ${firstPaper}; head: ${JSON.stringify(queue.slice(0, 10))}`);
  check("untouched sources fill the head instead",
        new Set(queue.slice(0, 20)).size >= 2 && !queue.slice(0, 10).includes("Paper"),
        JSON.stringify([...new Set(queue.slice(0, 20))]));
  check("hero still renders", hero.length > 0, hero);
}

// ---------------------------------------------------------------- entrypoint
(async () => {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log("SKIPPED — Playwright is not installed (it is an optional dev dependency).");
    console.log("  Enable with: npm i -D playwright && npx playwright install chromium");
    process.exit(0);
  }

  let browser, ctx;
  const { server, base } = await serve();
  try {
    browser = await playwright.chromium.launch();
  } catch (e) {
    console.log("SKIPPED — Playwright is installed but no Chromium binary is available.");
    console.log(`  ${e.message.split("\n")[0]}`);
    console.log("  Enable with: npx playwright install chromium");
    server.close();
    process.exit(0);
  }

  try {
    ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await run(await ctx.newPage(), base);
    console.log("\n  -- variety nudge, against a controlled catalog --");
    await runVarietyNudge(await (await browser.newContext()).newPage(), base);
  } catch (e) {
    check("suite ran to completion", false, e.message);
  } finally {
    if (browser) await browser.close();
    server.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
