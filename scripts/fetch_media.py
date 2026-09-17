#!/usr/bin/env python3
"""Aggregate Antigravity & Hermes material from five sources into
data/catalog.json (read by the web app):

    papers      Hugging Face Papers  - research papers (no key needed)
    hackernews  Hacker News (Algolia) - the latest blogs and articles (no key)
    websites    blogs and docs pages  - scraped links (no key)
    podcasts    RSS feeds             - episodes (no key)
    youtube     YouTube Data API v3   - videos (needs YOUTUBE_API_KEY)

Only YouTube needs credentials, so the tracker is useful with no setup at all
and is no longer video-first.

Sources and matching rules live in data/sources.json.

Usage:
    export YOUTUBE_API_KEY=...        # optional, only for the YouTube source
    python scripts/fetch_media.py     # writes data/catalog.json

Each source degrades gracefully: if a key is missing, a source is disabled or a
feed is unreachable, that source is skipped with a warning and the others still
run.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SOURCES_FILE = DATA / "sources.json"
CATALOG_FILE = DATA / "catalog.json"

YT_SEARCH = "https://www.googleapis.com/youtube/v3/search"
YT_VIDEOS = "https://www.googleapis.com/youtube/v3/videos"

# Hugging Face Papers - public, unauthenticated.
HF_PAPER_SEARCH = "https://huggingface.co/api/papers/search"
HF_DAILY_PAPERS = "https://huggingface.co/api/daily_papers"
HF_PAPER_PAGE = "https://huggingface.co/papers/"

# Hacker News via Algolia - public, unauthenticated.
HN_BY_DATE = "https://hn.algolia.com/api/v1/search_by_date"
HN_ITEM_PAGE = "https://news.ycombinator.com/item?id="

UA = {"User-Agent": "antigravity-hermes-watchlist/1.0"}


# ----------------------------- helpers -------------------------------------
def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def stable_id(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def get_json(url: str, params: dict | None = None):
    """GET a JSON endpoint. Returns whatever the endpoint gives (dict or list)."""
    q = urllib.parse.urlencode(params or {})
    full = f"{url}?{q}" if q else url
    req = urllib.request.Request(full, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        charset = r.headers.get_content_charset() or "utf-8"
        return r.read().decode(charset, errors="replace")


def match_topics(text: str, match_rules: dict,
                 exclude: list[str] | None = None) -> list[str]:
    """Topics whose patterns hit `text`, [] if an exclude pattern hits first.

    The exclude list exists because "Hermes" is a busy word - without it the
    Hacker News and web sources happily return luxury handbags and parcel
    couriers.
    """
    text_l = (text or "").lower()
    for pattern in (exclude or []):
        if re.search(pattern, text_l):
            return []
    return [topic for topic, patterns in match_rules.items()
            if any(re.search(p, text_l) for p in patterns)]


def strip_html(value: str | None, limit: int = 400) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value or "")).strip()[:limit]


def iso_date(value: str | None) -> str | None:
    if not value:
        return None
    # normalise a few common shapes to YYYY-MM-DD
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%a, %d %b %Y %H:%M:%S %z",
                "%a, %d %b %Y %H:%M:%S %Z", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue
    return value[:10] if len(value) >= 10 else value


# -------------------- Hugging Face Papers (research) ------------------------
def _hf_paper_pairs(payload) -> list[tuple[dict, dict]]:
    """Normalise the two shapes the Hub returns.

    /api/papers/search gives a bare list of paper objects; /api/daily_papers
    gives a list of entries that wrap the paper under a "paper" key. Anything
    else is ignored rather than crashing the run.
    """
    if isinstance(payload, dict):
        payload = payload.get("items") or payload.get("papers") or []
    if not isinstance(payload, list):
        return []
    pairs = []
    for raw in payload:
        if not isinstance(raw, dict):
            continue
        inner = raw.get("paper")
        pairs.append((raw, inner if isinstance(inner, dict) else raw))
    return pairs


def _hf_paper_item(raw: dict, paper: dict, match_rules: dict,
                   exclude: list[str], min_upvotes: int) -> dict | None:
    pid = str(paper.get("id") or raw.get("id") or "").strip()
    if not pid:
        return None
    title = strip_html(paper.get("title") or raw.get("title"), 300)
    summary = strip_html(paper.get("summary") or paper.get("description")
                         or raw.get("summary"), 500)
    topics = match_topics(f"{title} {summary}", match_rules, exclude)
    if not topics:
        return None
    try:
        upvotes = int(paper.get("upvotes") or 0)
    except (TypeError, ValueError):
        upvotes = 0
    if upvotes < min_upvotes:
        return None
    authors = [a.get("name", "").strip() for a in (paper.get("authors") or [])
               if isinstance(a, dict)]
    authors = [a for a in authors if a]
    return {
        "id": f"paper-{pid}",
        "title": title or f"Paper {pid}",
        "source": "paper",
        # Creator affinity is per-person. Falling back to a platform name here
        # would give every paper the same "creator" and double-count the
        # source signal in the app's ranking, so leave it blank instead.
        "creator": authors[0] if authors else "",
        "topics": topics,
        "url": f"{HF_PAPER_PAGE}{pid}",
        "published_at": iso_date(paper.get("publishedAt") or raw.get("publishedAt")),
        "duration_seconds": None,
        "description": summary,
        "extra": {
            "paper_id": pid,
            "upvotes": upvotes,
            "authors": authors[:6],
            "arxiv_url": f"https://arxiv.org/abs/{pid}",
        },
    }


def fetch_hf_papers(cfg: dict, match_rules: dict, exclude: list[str]) -> list[dict]:
    """Research papers from Hugging Face Papers. No API key required."""
    if not cfg.get("enabled", True):
        log("• Papers: skipped (disabled in sources.json)")
        return []
    items: dict[str, dict] = {}
    min_upvotes = int(cfg.get("min_upvotes", 0))
    per = int(cfg.get("max_results_per_query", 12))

    def collect(payload, limit: int | None = None) -> None:
        pairs = _hf_paper_pairs(payload)
        if limit is not None:
            pairs = pairs[:limit]
        for raw, paper in pairs:
            item = _hf_paper_item(raw, paper, match_rules, exclude, min_upvotes)
            if item:
                items.setdefault(item["id"], item)

    for query in cfg.get("queries", []):
        try:
            collect(get_json(HF_PAPER_SEARCH, {"q": query}), per)
        except Exception as e:  # noqa: BLE001
            log(f"• Papers: search '{query}' failed: {e}")

    if cfg.get("include_daily", True):
        try:
            collect(get_json(HF_DAILY_PAPERS,
                             {"limit": int(cfg.get("daily_limit", 50))}))
        except Exception as e:  # noqa: BLE001
            log(f"• Papers: daily feed failed: {e}")

    out = sorted(items.values(),
                 key=lambda i: i["extra"]["upvotes"], reverse=True)
    log(f"• Papers (Hugging Face): {len(out)} matching papers")
    return out


# -------------------- Hacker News (latest blogs) ----------------------------
def fetch_hackernews(cfg: dict, match_rules: dict, exclude: list[str]) -> list[dict]:
    """Newest Hacker News stories that link out to a blog post or article.

    Uses the public Algolia search endpoint (no key). `blogs_only` drops
    Ask/Tell HN text posts, which have no outbound link.
    """
    if not cfg.get("enabled", True):
        log("• Hacker News: skipped (disabled in sources.json)")
        return []
    per = int(cfg.get("hits_per_query", 20))
    min_points = int(cfg.get("min_points", 0))
    blogs_only = bool(cfg.get("blogs_only", True))
    max_age_days = int(cfg.get("max_age_days", 0))

    numeric = []
    if min_points > 0:
        numeric.append(f"points>={min_points}")
    if max_age_days > 0:
        cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=max_age_days)
        numeric.append(f"created_at_i>{int(cutoff.timestamp())}")

    items: dict[str, dict] = {}
    for query in cfg.get("queries", []):
        params = {"query": query, "tags": "story", "hitsPerPage": per}
        if numeric:
            params["numericFilters"] = ",".join(numeric)
        try:
            data = get_json(HN_BY_DATE, params)
        except Exception as e:  # noqa: BLE001
            log(f"• Hacker News: query '{query}' failed: {e}")
            continue
        for hit in (data or {}).get("hits", []):
            oid = str(hit.get("objectID") or "").strip()
            if not oid or f"hn-{oid}" in items:
                continue
            title = strip_html(hit.get("title") or hit.get("story_title"), 300)
            story_url = (hit.get("url") or "").strip()
            if blogs_only and not story_url:
                continue
            body = strip_html(hit.get("story_text"))
            topics = match_topics(f"{title} {body}", match_rules, exclude)
            if not topics:
                continue
            points = int(hit.get("points") or 0)
            comments = int(hit.get("num_comments") or 0)
            discussion = f"{HN_ITEM_PAGE}{oid}"
            items[f"hn-{oid}"] = {
                "id": f"hn-{oid}",
                "title": title or "(untitled story)",
                "source": "hackernews",
                "creator": hit.get("author", ""),  # the submitter, not "Hacker News"
                "topics": topics,
                "url": story_url or discussion,
                "published_at": iso_date(hit.get("created_at")),
                "duration_seconds": None,
                "description": body or
                    f"{points} points, {comments} comments on Hacker News.",
                "extra": {
                    "points": points,
                    "comments": comments,
                    "discussion_url": discussion,
                    "hn_author": hit.get("author", ""),
                },
            }

    out = sorted(items.values(),
                 key=lambda i: (i.get("published_at") or "0000"), reverse=True)
    log(f"• Hacker News: {len(out)} matching stories")
    return out


# ----------------------------- YouTube -------------------------------------
def parse_iso8601_duration(s: str) -> int | None:
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return None
    h, mi, se = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + se


def fetch_youtube(cfg: dict, match_rules: dict, exclude: list[str]) -> list[dict]:
    if not cfg.get("enabled", True):
        log("• YouTube: skipped (disabled in sources.json)")
        return []
    key = os.environ.get("YOUTUBE_API_KEY")
    if not key:
        log("• YouTube: skipped (set YOUTUBE_API_KEY to enable)")
        return []
    items: dict[str, dict] = {}
    queries = list(cfg.get("search_terms", []))
    channels = list(cfg.get("channel_ids", []))
    per = int(cfg.get("max_results_per_query", 25))

    def collect(params: dict, label: str) -> None:
        try:
            data = get_json(YT_SEARCH, params)
        except Exception as e:  # noqa: BLE001
            log(f"• YouTube: query '{label}' failed: {e}")
            return
        for it in data.get("items", []):
            vid = it.get("id", {}).get("videoId")
            if not vid:
                continue
            sn = it.get("snippet", {})
            title, desc = sn.get("title", ""), sn.get("description", "")
            topics = match_topics(f"{title} {desc}", match_rules, exclude)
            if not topics:
                continue
            items[vid] = {
                "id": f"yt-{vid}",
                "title": title,
                "source": "youtube",
                "creator": sn.get("channelTitle", ""),
                "topics": topics,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "published_at": iso_date(sn.get("publishedAt")),
                "duration_seconds": None,
                "description": desc,
                "_vid": vid,
            }

    for term in queries:
        collect({"key": key, "q": term, "part": "snippet", "type": "video",
                 "maxResults": per, "order": "date"}, term)
    for ch in channels:
        collect({"key": key, "channelId": ch, "part": "snippet", "type": "video",
                 "maxResults": per, "order": "date"}, ch)

    # enrich with durations (batched, 50 ids max per call)
    vids = [v["_vid"] for v in items.values()]
    for i in range(0, len(vids), 50):
        batch = vids[i:i + 50]
        try:
            data = get_json(YT_VIDEOS, {"key": key, "id": ",".join(batch),
                                        "part": "contentDetails"})
            dur = {d["id"]: parse_iso8601_duration(d["contentDetails"]["duration"])
                   for d in data.get("items", [])}
            for v in items.values():
                if v["_vid"] in dur:
                    v["duration_seconds"] = dur[v["_vid"]]
        except Exception as e:  # noqa: BLE001
            log(f"• YouTube: duration lookup failed: {e}")

    out = [{k: v for k, v in it.items() if not k.startswith("_")} for it in items.values()]
    log(f"• YouTube: {len(out)} matching videos")
    return out


# ----------------------------- Podcasts ------------------------------------
def fetch_podcasts(cfg: dict, match_rules: dict, exclude: list[str]) -> list[dict]:
    out: list[dict] = []
    feeds = cfg.get("feeds", [])
    for feed in feeds:
        rss = feed.get("rss", "")
        if not rss or "example.com" in rss:
            log(f"• Podcast '{feed.get('name','?')}': skipped (placeholder RSS)")
            continue
        try:
            xml = http_get(rss)
        except Exception as e:  # noqa: BLE001
            log(f"• Podcast '{feed.get('name','?')}': fetch failed: {e}")
            continue
        count = 0
        for item_xml in re.findall(r"<item[ >].*?</item>", xml, re.S | re.I):
            title = _xml_tag(item_xml, "title")
            desc = _xml_tag(item_xml, "description") or _xml_tag(item_xml, "itunes:summary")
            link = _xml_tag(item_xml, "link") or _enclosure_url(item_xml)
            pub = _xml_tag(item_xml, "pubDate")
            topics = match_topics(f"{title} {desc}", match_rules, exclude)
            if not (feed.get("keep_all") or topics):
                continue
            if not topics:
                topics = list(match_rules.keys())[:1] or ["Other"]
            out.append({
                "id": f"pod-{stable_id(rss, link or title)}",
                "title": title or "(episode)",
                "source": "podcast",
                "creator": feed.get("name", ""),
                "topics": topics,
                "url": link or rss,
                "published_at": iso_date(pub),
                "duration_seconds": None,
                "description": strip_html(desc),
            })
            count += 1
        log(f"• Podcast '{feed.get('name','?')}': {count} matching episodes")
    return out


def _xml_tag(blob: str, tag: str) -> str:
    m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", blob, re.S | re.I)
    if not m:
        return ""
    val = m.group(1).strip()
    cdata = re.match(r"<!\[CDATA\[(.*?)\]\]>", val, re.S)
    return (cdata.group(1) if cdata else val).strip()


def _enclosure_url(blob: str) -> str:
    m = re.search(r'<enclosure[^>]*url="([^"]+)"', blob, re.I)
    return m.group(1) if m else ""


# ----------------------------- Websites ------------------------------------
class LinkGrabber(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._href = dict(attrs).get("href")
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href:
            self.links.append((self._href, " ".join(self._text).strip()))
            self._href = None


def fetch_websites(cfg: dict, match_rules: dict, exclude: list[str]) -> list[dict]:
    out: list[dict] = []
    for page in cfg.get("pages", []):
        url = page.get("url", "")
        if not url or "example.com" in url:
            log(f"• Website '{page.get('name','?')}': skipped (placeholder URL)")
            continue
        try:
            html = http_get(url)
        except Exception as e:  # noqa: BLE001
            log(f"• Website '{page.get('name','?')}': fetch failed: {e}")
            continue
        parser = LinkGrabber()
        parser.feed(html)
        seen, count = set(), 0
        for href, text in parser.links:
            topics = match_topics(text, match_rules, exclude)
            if not topics or not text:
                continue
            abs_url = urllib.parse.urljoin(url, href)
            if abs_url in seen:
                continue
            seen.add(abs_url)
            out.append({
                "id": f"web-{stable_id(abs_url)}",
                "title": text[:140],
                "source": "website",
                "creator": page.get("name", ""),
                "topics": topics,
                "url": abs_url,
                "published_at": None,
                "duration_seconds": None,
                "description": f"From {page.get('name','the web')}",
            })
            count += 1
        log(f"• Website '{page.get('name','?')}': {count} matching links")
    return out


# ------------------------------- main --------------------------------------
def merge_duplicates(items: list[dict]) -> list[dict]:
    """De-dupe by URL, merging the `extra` payloads.

    A blog post can arrive both from a scraped site and from Hacker News. The
    first copy wins, but we keep the other's extras so the Hacker News
    discussion link survives on the merged item.
    """
    by_url: dict[str, dict] = {}
    for item in items:
        existing = by_url.get(item["url"])
        if existing is None:
            by_url[item["url"]] = item
            continue
        merged = dict(existing.get("extra") or {})
        merged.update({k: v for k, v in (item.get("extra") or {}).items()
                       if k not in merged})
        if merged:
            existing["extra"] = merged
        if not existing.get("published_at") and item.get("published_at"):
            existing["published_at"] = item["published_at"]
    return list(by_url.values())


def main() -> int:
    sources = json.loads(SOURCES_FILE.read_text())
    raw_match = sources.get("match", {})
    exclude = list(raw_match.get("exclude", []))
    match_rules = {k: v for k, v in raw_match.items()
                   if k not in ("comment", "exclude")}

    items: list[dict] = []
    # Papers and Hacker News first: they need no credentials, so a fresh clone
    # still produces a useful catalog without a YouTube key.
    items += fetch_hf_papers(sources.get("papers", {}), match_rules, exclude)
    items += fetch_hackernews(sources.get("hackernews", {}), match_rules, exclude)
    items += fetch_websites(sources.get("websites", {}), match_rules, exclude)
    items += fetch_podcasts(sources.get("podcasts", {}), match_rules, exclude)
    items += fetch_youtube(sources.get("youtube", {}), match_rules, exclude)

    items = merge_duplicates(items)
    items.sort(key=lambda x: (x.get("published_at") or "0000"), reverse=True)

    if not items:
        log("\nNo live items fetched. Keeping the existing catalog.json.")
        log("Check network access, then review data/sources.json - papers and "
            "Hacker News need no API key, so an empty run usually means the "
            "queries matched nothing.")
        return 0

    by_source: dict[str, int] = {}
    for it in items:
        by_source[it["source"]] = by_source.get(it["source"], 0) + 1

    catalog = {
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "note": "Generated by scripts/fetch_media.py",
        "counts": by_source,
        "items": items,
    }
    CATALOG_FILE.write_text(json.dumps(catalog, indent=2, ensure_ascii=False))
    breakdown = ", ".join(f"{v} {k}" for k, v in sorted(by_source.items()))
    log(f"\n\u2713 Wrote {len(items)} items to {CATALOG_FILE.relative_to(ROOT)} ({breakdown})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
