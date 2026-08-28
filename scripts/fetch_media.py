#!/usr/bin/env python3
"""Aggregate Antigravity & Hermes media from YouTube, podcasts and web pages
into data/catalog.json (read by the web app).

Sources and matching rules live in data/sources.json.

Usage:
    export YOUTUBE_API_KEY=...        # needed only for the YouTube source
    python scripts/fetch_media.py     # writes data/catalog.json

Each source degrades gracefully: if a key is missing or a feed is unreachable,
that source is skipped with a warning and the others still run.
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
UA = {"User-Agent": "antigravity-hermes-watchlist/1.0"}


# ----------------------------- helpers -------------------------------------
def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def stable_id(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:16]


def get_json(url: str, params: dict) -> dict:
    q = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{url}?{q}", headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def http_get(url: str) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        charset = r.headers.get_content_charset() or "utf-8"
        return r.read().decode(charset, errors="replace")


def match_topics(text: str, match_rules: dict) -> list[str]:
    text_l = (text or "").lower()
    hits = []
    for topic, patterns in match_rules.items():
        if any(re.search(p, text_l) for p in patterns):
            hits.append(topic)
    return hits


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


# ----------------------------- YouTube -------------------------------------
def parse_iso8601_duration(s: str) -> int | None:
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return None
    h, mi, se = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + se


def fetch_youtube(cfg: dict, match_rules: dict) -> list[dict]:
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
            topics = match_topics(f"{title} {desc}", match_rules)
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
def fetch_podcasts(cfg: dict, match_rules: dict) -> list[dict]:
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
            topics = match_topics(f"{title} {desc}", match_rules)
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
                "description": re.sub(r"<[^>]+>", "", desc or "")[:400],
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


def fetch_websites(cfg: dict, match_rules: dict) -> list[dict]:
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
            topics = match_topics(text, match_rules)
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
def main() -> int:
    sources = json.loads(SOURCES_FILE.read_text())
    match_rules = sources.get("match", {})
    match_rules = {k: v for k, v in match_rules.items() if k != "comment"}

    items: list[dict] = []
    items += fetch_youtube(sources.get("youtube", {}), match_rules)
    items += fetch_podcasts(sources.get("podcasts", {}), match_rules)
    items += fetch_websites(sources.get("websites", {}), match_rules)

    # de-dupe by url
    by_url: dict[str, dict] = {}
    for it in items:
        by_url.setdefault(it["url"], it)
    items = list(by_url.values())
    items.sort(key=lambda x: (x.get("published_at") or "0000"), reverse=True)

    if not items:
        log("\nNo live items fetched (no keys/feeds configured). Keeping existing catalog.json.")
        log("Edit data/sources.json to add YouTube search terms, channel IDs, podcast RSS feeds and web pages.")
        return 0

    catalog = {
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "note": "Generated by scripts/fetch_media.py",
        "items": items,
    }
    CATALOG_FILE.write_text(json.dumps(catalog, indent=2, ensure_ascii=False))
    log(f"\n✓ Wrote {len(items)} items to {CATALOG_FILE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
