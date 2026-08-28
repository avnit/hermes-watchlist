/* Antigravity & Hermes — Watch Next
 * Zero-backend recommender. Catalog is loaded from data/catalog.json.
 * Per-viewer watched/liked state lives in localStorage.
 */
(() => {
  "use strict";

  const STORE_KEY = "ahwn.state.v1";
  const SOURCES = ["youtube", "podcast", "website"];
  const SOURCE_LABEL = { youtube: "YouTube", podcast: "Podcast", website: "Web" };

  /** @typedef {{watched:boolean, liked:(null|1|-1), watchedAt:?number}} Entry */
  const state = loadState();            // { [id]: Entry }
  let catalog = [];                     // array of items
  let meta = {};
  const filters = { topics: new Set(), sources: new Set() };

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
      is_example: !!it.is_example,
    };
  }

  // ---------- taste model ----------
  // Affinity = (likes - dislikes) per topic / source / creator, from rated history.
  function buildTaste() {
    const t = { topic: {}, source: {}, creator: {} };
    for (const item of catalog) {
      const e = state[item.id];
      if (!e || e.liked == null) continue;
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
    // small nudge toward sources you've engaged with the least, for variety
    return { s, reasons };
  }

  function passesFilters(item) {
    if (filters.topics.size && !item.topics.some(t => filters.topics.has(t))) return false;
    if (filters.sources.size && !filters.sources.has(item.source)) return false;
    return true;
  }

  function ranked({ watched }) {
    const taste = buildTaste();
    return catalog
      .filter(it => !!(state[it.id] && state[it.id].watched) === watched)
      .filter(passesFilters)
      .map(it => ({ it, ...score(it, taste) }))
      .sort((a, b) => b.s - a.s || (Date.parse(b.it.published_at || 0) - Date.parse(a.it.published_at || 0)));
  }

  // ---------- rendering ----------
  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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
      const c = el("button", "chip", `<span class="dot" style="background:var(--${src === "youtube" ? "yt" : src === "podcast" ? "pod" : "web"})"></span>${SOURCE_LABEL[src]}`);
      c.onclick = () => { toggle(filters.sources, src); c.classList.toggle("on"); render(); };
      sWrap.appendChild(c);
    });
  }
  function toggle(set, v) { set.has(v) ? set.delete(v) : set.add(v); }

  function card(item, { showRateAlways } = {}) {
    const e = state[item.id] || { watched: false, liked: null };
    const c = el("div", "card");
    if (e.liked === 1) c.classList.add("liked");
    if (e.liked === -1) c.classList.add("disliked");

    const topics = item.topics.map(t => `<span class="topic-tag">${esc(t)}</span>`).join("");
    c.appendChild(el("div", "meta-row",
      `<span class="badge ${item.source}">${SOURCE_LABEL[item.source]}</span>${topics}` +
      (item.published_at ? `<span>· ${esc(item.published_at)}</span>` : "") +
      (item.is_example ? `<span title="Seed example — run the fetcher for live items">· example</span>` : "")
    ));
    c.appendChild(el("h4", null, esc(item.title)));
    if (item.creator) c.appendChild(el("div", "meta-row", `${esc(item.creator)}`));
    if (item.description) c.appendChild(el("p", "card-desc", esc(item.description)));

    const actions = el("div", "card-actions");
    const open = el("a", "btn small primary", "Open ↗");
    open.href = item.url; open.target = "_blank"; open.rel = "noopener";
    actions.appendChild(open);

    if (!e.watched) {
      const w = el("button", "btn small", "✓ Mark watched");
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
      wrap.appendChild(emptyState(
        catalog.length ? "You're all caught up 🎉" : "No items yet",
        catalog.length ? "No unwatched items match your filters. Try clearing filters or check your Library."
                        : "Run <code>scripts/fetch_media.py</code> to pull live videos, episodes and articles."
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
    const open = el("a", "btn primary", "Watch / Open ↗");
    open.href = top.it.url; open.target = "_blank"; open.rel = "noopener";
    const done = el("button", "btn", "✓ I watched this");
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
  const skipped = new Set();

  function renderBrowse() {
    const list = $("#browse-list"); list.innerHTML = "";
    const items = catalog.filter(passesFilters)
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
        `You have <b>${unrated.length}</b> watched item${unrated.length > 1 ? "s" : ""} waiting for a 👍 / 👎 — rating them sharpens your recommendations.`));
    }
    if (!watched.length) { list.appendChild(emptyState("No history yet", "Items you mark as watched show up here so you can rate them.")); return; }
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
    cards.appendChild(stat(watched.length, "Watched"));
    cards.appendChild(stat(liked.length, "👍 Liked"));
    cards.appendChild(stat(disliked.length, "👎 Not for me"));
    body.appendChild(cards);

    // breakdown of watched by source
    body.appendChild(el("h3", "section-label", "What you watch, by source"));
    const bySource = {};
    watched.forEach(id => { const it = catalog.find(c => c.id === id); if (it) bySource[it.source] = (bySource[it.source] || 0) + 1; });
    const maxS = Math.max(1, ...Object.values(bySource));
    SOURCES.forEach(src => {
      const v = bySource[src] || 0;
      const row = el("div", "bar-row");
      row.appendChild(el("div", "name", SOURCE_LABEL[src]));
      const bar = el("div", "bar"); bar.appendChild(el("i", null, "")); bar.firstChild.style.width = (v / maxS * 100) + "%";
      row.appendChild(bar); row.appendChild(el("div", "val", String(v)));
      body.appendChild(row);
    });

    // taste summary
    const taste = buildTaste();
    const liks = Object.entries(taste.topic).filter(([, v]) => v > 0).map(([k]) => k);
    const disl = Object.entries(taste.topic).filter(([, v]) => v < 0).map(([k]) => k);
    body.appendChild(el("h3", "section-label", "Your taste so far"));
    body.appendChild(el("p", null,
      (liks.length ? `Leaning into: <b>${liks.map(esc).join(", ")}</b>. ` : "Rate a few items to build your profile. ") +
      (disl.length ? `Less of: ${disl.map(esc).join(", ")}.` : "")));
  }

  function emptyState(title, html) {
    const e = el("div", "empty");
    e.appendChild(el("h3", null, title));
    e.appendChild(el("p", null, html));
    return e;
  }

  // ---------- shell ----------
  let currentView = "next";
  function render() {
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    $("#view-" + currentView).classList.add("active");
    document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === currentView));
    // filters only relevant on next/browse
    $("#filters").style.display = (currentView === "stats") ? "none" : "flex";

    if (currentView === "next") renderNext();
    else if (currentView === "browse") renderBrowse();
    else if (currentView === "library") renderLibrary();
    else if (currentView === "stats") renderStats();

    const dm = $("#data-meta");
    if (meta.error) dm.textContent = "⚠ Could not load catalog.json — serve this folder over http (see README).";
    else dm.textContent = `${catalog.length} items · ${meta.generated_at === "seed" ? "seed data — run the fetcher for live content" : "updated " + (meta.generated_at || "")}`;
  }

  document.getElementById("tabs").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    currentView = b.dataset.view; render();
  });
  document.getElementById("reset-btn").addEventListener("click", () => {
    if (confirm("Clear your watched & liked history on this device?")) {
      for (const k of Object.keys(state)) delete state[k];
      saveState(); render();
    }
  });

  load();
})();
