/* Antigravity & Hermes — Watch Next
 * Zero-backend recommender. Catalog is loaded from data/catalog.json.
 * Per-viewer watched/liked state lives in localStorage.
 *
 * Five sources, only one of which is video: research papers (Hugging Face),
 * the latest blogs surfaced on Hacker News, web/blog posts, podcasts, YouTube.
 */
(() => {
  "use strict";

  const STORE_KEY = "ahwn.state.v1";
  const SOURCES = ["paper", "hackernews", "website", "podcast", "youtube"];
  const SOURCE_LABEL = {
    paper: "Paper",
    hackernews: "Hacker News",
    website: "Web",
    podcast: "Podcast",
    youtube: "YouTube",
  };
  // CSS custom property suffix per source, e.g. var(--paper).
  const SOURCE_VAR = {
    paper: "paper", hackernews: "hn", website: "web",
    podcast: "pod", youtube: "yt",
  };
  // Papers and blogs are read, podcasts are listened to, videos are watched.
  // The stored flag stays `watched` either way so existing history keeps working.
  const SOURCE_VERB = {
    paper: { open: "Read", mark: "✓ Mark read", hero: "Read it ↗" },
    hackernews: { open: "Read", mark: "✓ Mark read", hero: "Read it ↗" },
    website: { open: "Read", mark: "✓ Mark read", hero: "Read it ↗" },
    podcast: { open: "Listen", mark: "✓ Mark listened", hero: "Listen ↗" },
    youtube: { open: "Watch", mark: "✓ Mark watched", hero: "Watch it ↗" },
  };

  /** @typedef {{watched:boolean, liked:(null|1|-1), watchedAt:?number}} Entry */
  const state = loadState();            // { [id]: Entry }
  let catalog = [];                     // array of items
  let meta = {};
  const filters = { topics: new Set(), sources: new Set() };
  const skipped = new Set();            // "skip for now" — session-only, not persisted

  // ---------- persistence ----------
  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
  }
  function entry(id) {
    if (!state[id]) state[id] = { watched: false, liked: null, watchedAt: null };
    return state[id];
  }

  // ---------- data load ----------
  async function load() {
    try {
      const res = await fetch("data/catalog.json", { cache: "no-store" });
      const data = await res.json();
      catalog = (data.items || []).map(normalize);
      meta = data;
    } catch (e) {
      catalog = [];
      meta = { error: String(e) };
    }
    buildFilters();
    render();
  }
  function normalize(it) {
    return {
      id: it.id,
      title: it.title || "(untitled)",
      source: SOURCES.includes(it.source) ? it.source : "website",
      creator: it.creator || "",
      topics: Array.isArray(it.topics) && it.topics.length ? it.topics : ["Other"],
      url: it.url || "#",
      published_at: it.published_at || null,
      description: it.description || "",
      duration_seconds: it.duration_seconds || null,
      extra: (it.extra && typeof it.extra === "object") ? it.extra : {},
      is_example: !!it.is_example,
    };
  }

  // ---------- taste model ----------
  // Affinity = (likes - dislikes) per topic / source / creator, from rated history.
  // watchedBySource drives the variety nudge in score().
  function buildTaste() {
    const t = { topic: {}, source: {}, creator: {}, watchedBySource: {}, watchedTotal: 0 };
    for (const item of catalog) {
      const e = state[item.id];
      if (!e) continue;
      if (e.watched) {
        t.watchedBySource[item.source] = (t.watchedBySource[item.source] || 0) + 1;
        t.watchedTotal++;
      }
      if (e.liked == null) continue;
      const w = e.liked; // +1 like, -1 dislike
      item.topics.forEach(tp => t.topic[tp] = (t.topic[tp] || 0) + w);
      t.source[item.source] = (t.source[item.source] || 0) + w;
      if (item.creator) t.creator[item.creator] = (t.creator[item.creator] || 0) + w;
    }
    return t;
  }

  function recencyScore(item) {
    if (!item.published_at) return 0;
    const ts = Date.parse(item.published_at);
    if (isNaN(ts)) return 0;
    const days = (Date.now() - ts) / 8.64e7;
    // newer -> closer to 1, ~1 year half-life
    return Math.max(0, 1 - days / 365);
  }

  function score(item, taste) {
    let s = 0;
    const reasons = [];
    for (const tp of item.topics) {
      const a = taste.topic[tp] || 0;
      if (a) { s += a * 2.0; if (a > 0) reasons.push(`you like ${tp}`); }
    }
    const sa = taste.source[item.source] || 0;
    if (sa) { s += sa * 1.0; if (sa > 0) reasons.push(`more ${SOURCE_LABEL[item.source]}`); }
    const ca = taste.creator[item.creator] || 0;
    if (ca) { s += ca * 1.5; if (ca > 0) reasons.push(`from ${item.creator}`); }
    s += recencyScore(item) * 1.2;

    // Variety: nudge toward the sources you've consumed least, so whichever
    // platform you binge (usually video) doesn't take over the whole queue.
    if (taste.watchedTotal >= 3) {
      const avg = taste.watchedTotal / SOURCES.length;
      const seen = taste.watchedBySource[item.source] || 0;
      const variety = (avg - seen) / (avg + 1);
      s += variety * 0.8;
      if (variety > 0.25) reasons.push("a change from your usual sources");
    }
    return { s, reasons };
  }

  function passesFilters(item, { ignoreSource } = {}) {
    if (filters.topics.size && !item.topics.some(t => filters.topics.has(t))) return false;
    if (!ignoreSource && filters.sources.size && !filters.sources.has(item.source)) return false;
    return true;
  }

  function ranked({ watched }) {
    const taste = buildTaste();
    return catalog
      .filter(it => !!(state[it.id] && state[it.id].watched) === watched)
      .filter(it => watched || !skipped.has(it.id))
      .filter(it => passesFilters(it))
      .map(it => ({ it, ...score(it, taste) }))
      .sort((a, b) => b.s - a.s || (Date.parse(b.it.published_at || 0) - Date.parse(a.it.published_at || 0)));
  }

  // ---------- rendering ----------
  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const verb = src => SOURCE_VERB[src] || SOURCE_VERB.website;

  function buildFilters() {
    const topics = [...new Set(catalog.flatMap(i => i.topics))].sort();
    const tWrap = $("#topic-filters"); tWrap.innerHTML = "";
    topics.forEach(tp => {
      const c = el("button", "chip", `${esc(tp)}`);
      c.onclick = () => { toggle(filters.topics, tp); c.classList.toggle("on"); render(); };
      tWrap.appendChild(c);
    });
    const sWrap = $("#source-filters"); sWrap.innerHTML = "";
    SOURCES.forEach(src => {
      const c = el("button", "chip", `<span class="dot" style="background:var(--${SOURCE_VAR[src]})"></span>${SOURCE_LABEL[src]}`);
      c.onclick = () => { toggle(filters.sources, src); c.classList.toggle("on"); render(); };
      sWrap.appendChild(c);
    });
  }
  function toggle(set, v) { set.has(v) ? set.delete(v) : set.add(v); }

  /** Source-specific detail line: paper upvotes/authors, HN points/comments. */
  function extraRow(item) {
    const x = item.extra || {};
    const bits = [];
    if (item.source === "paper") {
      if (x.upvotes) bits.push(`▲ ${esc(x.upvotes)} on Hugging Face`);
      if (Array.isArray(x.authors) && x.authors.length) {
        bits.push(esc(x.authors.slice(0, 3).join(", ")) + (x.authors.length > 3 ? " et al." : ""));
      }
    } else if (item.source === "hackernews") {
      if (x.points) bits.push(`▲ ${esc(x.points)} points`);
      if (x.comments) bits.push(`${esc(x.comments)} comments`);
      if (x.hn_author) bits.push(`by ${esc(x.hn_author)}`);
    }
    return bits.length ? el("div", "meta-row extra", bits.join(" · ")) : null;
  }

  /** Second link where one exists: arXiv for a paper, the HN thread for a story. */
  function secondaryLink(item) {
    const x = item.extra || {};
    if (item.source === "paper" && x.arxiv_url) return { href: x.arxiv_url, label: "arXiv ↗" };
    if (x.discussion_url && x.discussion_url !== item.url) {
      return { href: x.discussion_url, label: "Discussion ↗" };
    }
    return null;
  }

  function card(item, { showRateAlways } = {}) {
    const e = state[item.id] || { watched: false, liked: null };
    const c = el("div", "card");
    c.classList.add(item.source + "-card");
    if (e.liked === 1) c.classList.add("liked");
    if (e.liked === -1) c.classList.add("disliked");

    const topics = item.topics.map(t => `<span class="topic-tag">${esc(t)}</span>`).join("");
    c.appendChild(el("div", "meta-row",
      `<span class="badge ${item.source}">${SOURCE_LABEL[item.source]}</span>${topics}` +
      (item.published_at ? `<span>· ${esc(item.published_at)}</span>` : "") +
      (item.is_example ? `<span title="Placeholder — run the fetcher for live items">· example</span>` : "")
    ));
    c.appendChild(el("h4", null, esc(item.title)));
    if (item.creator) c.appendChild(el("div", "meta-row", `${esc(item.creator)}`));
    const x = extraRow(item);
    if (x) c.appendChild(x);
    if (item.description) c.appendChild(el("p", "card-desc", esc(item.description)));

    const actions = el("div", "card-actions");
    const open = el("a", "btn small primary", `${verb(item.source).open} ↗`);
    open.href = item.url; open.target = "_blank"; open.rel = "noopener";
    actions.appendChild(open);

    const second = secondaryLink(item);
    if (second) {
      const link = el("a", "btn small ghost", second.label);
      link.href = second.href; link.target = "_blank"; link.rel = "noopener";
      actions.appendChild(link);
    }

    if (!e.watched) {
      const w = el("button", "btn small", verb(item.source).mark);
      w.onclick = () => { markWatched(item.id); };
      actions.appendChild(w);
    }
    c.appendChild(actions);

    // Rating prompt: shown right after watching (or always in library)
    if (e.watched || showRateAlways) {
      c.appendChild(ratePrompt(item.id));
    }
    return c;
  }

  function ratePrompt(id) {
    const e = entry(id);
    const box = el("div", "rate");
    box.appendChild(el("span", null, e.liked == null ? "Did you like it?" : "Your rating:"));
    const up = el("button", "btn small thumb up" + (e.liked === 1 ? " on" : ""), "👍");
    const down = el("button", "btn small thumb down" + (e.liked === -1 ? " on" : ""), "👎");
    up.onclick = () => rate(id, 1);
    down.onclick = () => rate(id, -1);
    box.appendChild(up); box.appendChild(down);
    return box;
  }

  function markWatched(id) {
    const e = entry(id);
    e.watched = true; e.watchedAt = Date.now();
    saveState(); render();
  }
  function rate(id, val) {
    const e = entry(id);
    e.liked = e.liked === val ? null : val; // toggle off if same
    if (e.liked != null) { e.watched = true; if (!e.watchedAt) e.watchedAt = Date.now(); }
    saveState(); render();
  }

  // ---------- views ----------
  function renderNext() {
    const wrap = $("#next-card-wrap"); wrap.innerHTML = "";
    const q = ranked({ watched: false });
    if (!q.length) {
      const allSkipped = catalog.length && skipped.size;
      wrap.appendChild(emptyState(
        catalog.length ? "You're all caught up 🎉" : "No items yet",
        allSkipped ? "Everything left is skipped for now. Reload the page to bring skipped items back, or head to Browse."
          : catalog.length ? "Nothing unread matches your filters. Try clearing filters or check your Library."
                           : "Run <code>scripts/fetch_media.py</code> to pull live papers, blogs, episodes and videos."
      ));
      $("#queue-label").style.display = "none";
      $("#queue-list").innerHTML = "";
      return;
    }
    const top = q[0];
    const hero = el("div", "hero");
    hero.appendChild(el("div", "eyebrow", "▶ Up next for you"));
    hero.appendChild(el("h2", null, esc(top.it.title)));
    const m = `<span class="badge ${top.it.source}">${SOURCE_LABEL[top.it.source]}</span> ` +
              top.it.topics.map(t => `<span class="topic-tag">${esc(t)}</span>`).join(" ") +
              (top.it.creator ? ` · ${esc(top.it.creator)}` : "");
    hero.appendChild(el("div", "meta-row", m));
    if (top.it.description) hero.appendChild(el("p", "desc", esc(top.it.description)));
    hero.appendChild(el("p", "why", top.reasons.length ? "Recommended because " + top.reasons.slice(0, 2).join(" · ") : "A fresh pick to get you started"));

    const a = el("div", "hero-actions");
    const open = el("a", "btn primary", verb(top.it.source).hero);
    open.href = top.it.url; open.target = "_blank"; open.rel = "noopener";
    const done = el("button", "btn", verb(top.it.source).mark);
    done.onclick = () => markWatched(top.it.id);
    const skip = el("button", "btn ghost", "Skip for now");
    skip.onclick = () => { skipped.add(top.it.id); render(); };
    a.appendChild(open); a.appendChild(done); a.appendChild(skip);
    hero.appendChild(a);
    wrap.appendChild(hero);

    $("#queue-label").style.display = "block";
    const list = $("#queue-list"); list.innerHTML = "";
    q.slice(1).forEach(x => list.appendChild(card(x.it)));
  }

  /** Papers and Hacker News are single-source views, so the source filter
   *  chips are hidden there and only the topic filter applies. */
  function renderSourceView(source, mountSel, sortFn, empty) {
    const list = $(mountSel); list.innerHTML = "";
    const items = catalog
      .filter(i => i.source === source)
      .filter(i => passesFilters(i, { ignoreSource: true }))
      .sort(sortFn);
    if (!items.length) { list.appendChild(emptyState(empty.title, empty.body)); return; }
    items.forEach(i => list.appendChild(card(i)));
  }

  function renderPapers() {
    renderSourceView("paper", "#papers-list",
      (a, b) => (b.extra.upvotes || 0) - (a.extra.upvotes || 0) ||
                Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0),
      { title: "No papers yet",
        body: "Add queries under <code>papers</code> in <code>data/sources.json</code> and run <code>scripts/fetch_media.py</code> — Hugging Face Papers needs no API key." });
  }

  function renderHackerNews() {
    renderSourceView("hackernews", "#hn-list",
      (a, b) => Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0) ||
                (b.extra.points || 0) - (a.extra.points || 0),
      { title: "No stories yet",
        body: "Add queries under <code>hackernews</code> in <code>data/sources.json</code> and run <code>scripts/fetch_media.py</code> — the Hacker News API needs no key." });
  }

  function renderBrowse() {
    const list = $("#browse-list"); list.innerHTML = "";
    const items = catalog.filter(i => passesFilters(i))
      .sort((a, b) => Date.parse(b.published_at || 0) - Date.parse(a.published_at || 0));
    if (!items.length) { list.appendChild(emptyState("Nothing here", "No items match your filters.")); return; }
    items.forEach(it => list.appendChild(card(it)));
  }

  function renderLibrary() {
    const list = $("#library-list"); list.innerHTML = "";
    const watched = ranked({ watched: true });
    const banner = $("#review-banner"); banner.innerHTML = "";
    const unrated = watched.filter(x => (state[x.it.id].liked == null));
    if (unrated.length) {
      banner.appendChild(el("div", "banner",
        `You have <b>${unrated.length}</b> item${unrated.length > 1 ? "s" : ""} waiting for a 👍 / 👎 — rating them sharpens your recommendations.`));
    }
    if (!watched.length) { list.appendChild(emptyState("No history yet", "Items you mark as read, watched or listened to show up here so you can rate them.")); return; }
    // unrated first so the "did you like it?" prompt is front and center
    [...unrated, ...watched.filter(x => state[x.it.id].liked != null)]
      .forEach(x => list.appendChild(card(x.it, { showRateAlways: true })));
  }

  function renderStats() {
    const body = $("#stats-body"); body.innerHTML = "";
    const ids = Object.keys(state);
    const watched = ids.filter(id => state[id].watched);
    const liked = ids.filter(id => state[id].liked === 1);
    const disliked = ids.filter(id => state[id].liked === -1);
    const cards = el("div", "stat-cards");
    const stat = (num, lbl) => { const s = el("div", "stat"); s.appendChild(el("div", "num", num)); s.appendChild(el("div", "lbl", lbl)); return s; };
    cards.appendChild(stat(catalog.length, "In catalog"));
    cards.appendChild(stat(watched.length, "Read / watched"));
    cards.appendChild(stat(liked.length, "👍 Liked"));
    cards.appendChild(stat(disliked.length, "👎 Not for me"));
    body.appendChild(cards);

    // what the catalog itself is made of — the point of looking past YouTube
    body.appendChild(el("h3", "section-label", "What's in the catalog, by source"));
    const catBySource = {};
    catalog.forEach(it => catBySource[it.source] = (catBySource[it.source] || 0) + 1);
    barChart(body, catBySource);

    // breakdown of what you've actually consumed
    body.appendChild(el("h3", "section-label", "What you consume, by source"));
    const bySource = {};
    watched.forEach(id => { const it = catalog.find(c => c.id === id); if (it) bySource[it.source] = (bySource[it.source] || 0) + 1; });
    barChart(body, bySource);

    // taste summary
    const taste = buildTaste();
    const liks = Object.entries(taste.topic).filter(([, v]) => v > 0).map(([k]) => k);
    const disl = Object.entries(taste.topic).filter(([, v]) => v < 0).map(([k]) => k);
    body.appendChild(el("h3", "section-label", "Your taste so far"));
    body.appendChild(el("p", null,
      (liks.length ? `Leaning into: <b>${liks.map(esc).join(", ")}</b>. ` : "Rate a few items to build your profile. ") +
      (disl.length ? `Less of: ${disl.map(esc).join(", ")}.` : "")));
  }

  function barChart(body, counts) {
    const max = Math.max(1, ...Object.values(counts));
    SOURCES.forEach(src => {
      const v = counts[src] || 0;
      const row = el("div", "bar-row");
      row.appendChild(el("div", "name", SOURCE_LABEL[src]));
      const bar = el("div", "bar"); bar.appendChild(el("i", null, ""));
      bar.firstChild.style.width = (v / max * 100) + "%";
      row.appendChild(bar); row.appendChild(el("div", "val", String(v)));
      body.appendChild(row);
    });
  }

  function emptyState(title, html) {
    const e = el("div", "empty");
    e.appendChild(el("h3", null, title));
    e.appendChild(el("p", null, html));
    return e;
  }

  // ---------- shell ----------
  const VIEWS = {
    next: renderNext,
    papers: renderPapers,
    hn: renderHackerNews,
    browse: renderBrowse,
    library: renderLibrary,
    stats: renderStats,
  };
  // Views that are already pinned to one source, so the source chips would
  // only ever empty them out.
  const SINGLE_SOURCE_VIEWS = new Set(["papers", "hn"]);

  let currentView = "next";
  function render() {
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    $("#view-" + currentView).classList.add("active");
    document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === currentView));

    $("#filters").style.display = (currentView === "stats") ? "none" : "flex";
    $("#source-filters").style.display = SINGLE_SOURCE_VIEWS.has(currentView) ? "none" : "flex";

    (VIEWS[currentView] || renderNext)();

    const dm = $("#data-meta");
    if (meta.error) dm.textContent = "⚠ Could not load catalog.json — serve this folder over http (see README).";
    else dm.textContent = `${catalog.length} items · ${meta.generated_at === "seed" ? "seed data — run the fetcher for live content" : "updated " + (meta.generated_at || "")}`;
  }

  document.getElementById("tabs").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    currentView = b.dataset.view; render();
  });
  document.getElementById("reset-btn").addEventListener("click", () => {
    if (confirm("Clear your read & liked history on this device?")) {
      for (const k of Object.keys(state)) delete state[k];
      saveState(); render();
    }
  });

  load();
})();
