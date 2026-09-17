#!/usr/bin/env python3
"""Offline tests for the aggregator's parsing and ranking logic.

No network: each source's HTTP layer is monkeypatched with a recorded-shape
payload, so this runs anywhere.

    python3 scripts/test_fetch_media.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_media as fm  # noqa: E402

MATCH = {
    "Antigravity": ["antigravity", "agentic (ide|coding)"],
    "Hermes": ["hermes", "nous ?research"],
}
EXCLUDE = ["herm[eè]s (paris|birkin|bag)", "hermes (parcel|delivery)"]

# Shape of https://huggingface.co/api/papers/search?q=...
HF_SEARCH_PAYLOAD = [
    {
        "id": "2508.18255",
        "title": "Hermes 4 Technical Report",
        "summary": "Hermes 4, a hybrid reasoning model with tool use.",
        "publishedAt": "2025-08-25T17:45:06.000Z",
        "upvotes": 57,
        "authors": [{"name": "Ryan Teknium"}, {"name": "Roger Jin"}],
    },
    {
        "id": "2505.19443",
        "title": "Vibe Coding vs. Agentic Coding",
        "summary": "A review contrasting the two paradigms of AI-assisted development.",
        "publishedAt": "2025-05-26T03:00:21.000Z",
        "upvotes": 15,
        "authors": [],
    },
    {
        "id": "0000.00000",
        "title": "A paper about protein folding",
        "summary": "Nothing to do with either topic.",
        "publishedAt": "2025-01-01T00:00:00.000Z",
        "upvotes": 99,
    },
]

# Shape of https://huggingface.co/api/daily_papers - papers are wrapped.
HF_DAILY_PAYLOAD = [
    {
        "publishedAt": "2026-09-14T00:00:00.000Z",
        "paper": {
            "id": "2609.15818",
            "title": "Atria Dawn: The Dawn of Agentic Superintelligence",
            "summary": "An agentic coding foundation model trained on verified tool use.",
            "publishedAt": "2026-09-14T00:00:00.000Z",
            "upvotes": 425,
            "authors": [{"name": "Atria Team"}],
        },
    }
]

# Shape of https://hn.algolia.com/api/v1/search_by_date?tags=story
HN_PAYLOAD = {
    "hits": [
        {
            "objectID": "45967814",
            "title": "Google Antigravity",
            "url": "https://antigravity.google/",
            "points": 812,
            "num_comments": 494,
            "author": "meetpateltech",
            "created_at": "2025-11-18T17:02:11.000Z",
        },
        {
            "objectID": "45031326",
            "title": "Nous Research - Hermes 4 405B/70B released",
            "url": "https://nousresearch.com/hermes4/",
            "points": 210,
            "num_comments": 88,
            "author": "tosh",
            "created_at": "2025-08-26T09:14:00.000Z",
        },
        {   # Ask HN with no outbound link - dropped when blogs_only is on.
            "objectID": "99999999",
            "title": "Ask HN: is anyone using Hermes in production?",
            "url": "",
            "points": 40,
            "num_comments": 12,
            "author": "someone",
            "created_at": "2026-01-02T00:00:00.000Z",
        },
        {   # Right word, wrong Hermes.
            "objectID": "88888888",
            "title": "Hermes parcel delivery outage hits UK retailers",
            "url": "https://example.net/parcels",
            "points": 300,
            "num_comments": 100,
            "author": "nobody",
            "created_at": "2026-02-02T00:00:00.000Z",
        },
    ]
}


class TopicMatching(unittest.TestCase):
    def test_matches_each_topic(self):
        self.assertEqual(match("Google Antigravity IDE"), ["Antigravity"])
        self.assertEqual(match("Hermes 4 technical report"), ["Hermes"])

    def test_item_can_carry_both_topics(self):
        self.assertEqual(sorted(match("Hermes inside the Antigravity IDE")),
                         ["Antigravity", "Hermes"])

    def test_exclude_wins_over_a_topic_hit(self):
        self.assertEqual(match("Hermes parcel delivery delays"), [])
        self.assertEqual(match("Hermès Birkin bag resale market"), [])

    def test_no_match_is_empty(self):
        self.assertEqual(match("Rust async runtimes compared"), [])


def match(text):
    return fm.match_topics(text, MATCH, EXCLUDE)


class HuggingFacePapers(unittest.TestCase):
    def setUp(self):
        self.cfg = {"enabled": True, "queries": ["q"], "include_daily": True,
                    "min_upvotes": 0, "max_results_per_query": 12}

    def run_fetch(self, cfg=None, search=None, daily=None):
        payloads = {fm.HF_PAPER_SEARCH: HF_SEARCH_PAYLOAD if search is None else search,
                    fm.HF_DAILY_PAPERS: HF_DAILY_PAYLOAD if daily is None else daily}
        fm.get_json = lambda url, params=None: payloads[url]
        return fm.fetch_hf_papers(cfg or self.cfg, MATCH, EXCLUDE)

    def test_keeps_only_on_topic_papers(self):
        ids = {i["id"] for i in self.run_fetch()}
        self.assertIn("paper-2508.18255", ids)
        self.assertIn("paper-2505.19443", ids)
        self.assertNotIn("paper-0000.00000", ids)

    def test_unwraps_the_daily_papers_shape(self):
        by_id = {i["id"]: i for i in self.run_fetch()}
        atria = by_id["paper-2609.15818"]
        self.assertEqual(atria["title"], "Atria Dawn: The Dawn of Agentic Superintelligence")
        self.assertEqual(atria["extra"]["upvotes"], 425)

    def test_builds_paper_and_arxiv_links(self):
        paper = next(i for i in self.run_fetch() if i["id"] == "paper-2508.18255")
        self.assertEqual(paper["url"], "https://huggingface.co/papers/2508.18255")
        self.assertEqual(paper["extra"]["arxiv_url"], "https://arxiv.org/abs/2508.18255")
        self.assertEqual(paper["published_at"], "2025-08-25")
        self.assertEqual(paper["creator"], "Ryan Teknium")

    def test_creator_is_blank_rather_than_a_platform_name(self):
        """A platform name as `creator` would double-count the source signal
        in the app's ranking, so an author-less paper gets no creator."""
        paper = next(i for i in self.run_fetch() if i["id"] == "paper-2505.19443")
        self.assertEqual(paper["creator"], "")
        self.assertEqual(paper["source"], "paper")

    def test_min_upvotes_filters(self):
        cfg = dict(self.cfg, min_upvotes=50, include_daily=False)
        self.assertEqual([i["id"] for i in self.run_fetch(cfg)], ["paper-2508.18255"])

    def test_disabled_source_returns_nothing(self):
        self.assertEqual(self.run_fetch(dict(self.cfg, enabled=False)), [])

    def test_a_failing_query_does_not_sink_the_run(self):
        def boom(url, params=None):
            if url == fm.HF_PAPER_SEARCH:
                raise OSError("network down")
            return HF_DAILY_PAYLOAD
        fm.get_json = boom
        self.assertEqual([i["id"] for i in fm.fetch_hf_papers(self.cfg, MATCH, EXCLUDE)],
                         ["paper-2609.15818"])

    def test_unexpected_payload_shape_is_ignored(self):
        self.assertEqual(self.run_fetch(search="not a list", daily=None,
                                        cfg=dict(self.cfg, include_daily=False)), [])


class HackerNews(unittest.TestCase):
    def setUp(self):
        self.cfg = {"enabled": True, "queries": ["antigravity"], "hits_per_query": 20,
                    "min_points": 5, "blogs_only": True, "max_age_days": 540}
        self.calls = []

        def fake(url, params=None):
            self.calls.append((url, params))
            return HN_PAYLOAD
        fm.get_json = fake

    def test_keeps_stories_that_link_to_a_blog(self):
        ids = [i["id"] for i in fm.fetch_hackernews(self.cfg, MATCH, EXCLUDE)]
        self.assertEqual(ids, ["hn-45967814", "hn-45031326"])

    def test_drops_text_posts_when_blogs_only(self):
        ids = [i["id"] for i in fm.fetch_hackernews(self.cfg, MATCH, EXCLUDE)]
        self.assertNotIn("hn-99999999", ids)

    def test_keeps_text_posts_when_blogs_only_is_off(self):
        cfg = dict(self.cfg, blogs_only=False)
        ids = [i["id"] for i in fm.fetch_hackernews(cfg, MATCH, EXCLUDE)]
        self.assertIn("hn-99999999", ids)

    def test_drops_the_wrong_hermes(self):
        ids = [i["id"] for i in fm.fetch_hackernews(dict(self.cfg, blogs_only=False),
                                                    MATCH, EXCLUDE)]
        self.assertNotIn("hn-88888888", ids)

    def test_item_points_at_the_article_and_keeps_the_discussion(self):
        item = fm.fetch_hackernews(self.cfg, MATCH, EXCLUDE)[0]
        self.assertEqual(item["url"], "https://antigravity.google/")
        self.assertEqual(item["extra"]["discussion_url"],
                         "https://news.ycombinator.com/item?id=45967814")
        self.assertEqual(item["extra"]["points"], 812)
        self.assertEqual(item["extra"]["comments"], 494)
        self.assertEqual(item["published_at"], "2025-11-18")
        self.assertEqual(item["source"], "hackernews")
        self.assertEqual(item["creator"], "meetpateltech")  # submitter, not "Hacker News"

    def test_newest_first(self):
        dates = [i["published_at"] for i in fm.fetch_hackernews(self.cfg, MATCH, EXCLUDE)]
        self.assertEqual(dates, sorted(dates, reverse=True))

    def test_sends_point_and_age_filters_to_the_api(self):
        fm.fetch_hackernews(self.cfg, MATCH, EXCLUDE)
        _, params = self.calls[0]
        self.assertEqual(params["tags"], "story")
        self.assertIn("points>=5", params["numericFilters"])
        self.assertIn("created_at_i>", params["numericFilters"])

    def test_no_numeric_filter_when_unconstrained(self):
        fm.fetch_hackernews(dict(self.cfg, min_points=0, max_age_days=0),
                            MATCH, EXCLUDE)
        _, params = self.calls[0]
        self.assertNotIn("numericFilters", params)


class MergeDuplicates(unittest.TestCase):
    def test_merges_extras_across_sources(self):
        web = {"id": "web-1", "url": "https://blog/x", "source": "website",
               "published_at": None, "extra": {}}
        hn = {"id": "hn-1", "url": "https://blog/x", "source": "hackernews",
              "published_at": "2026-03-01",
              "extra": {"points": 120, "discussion_url": "https://news.ycombinator.com/item?id=1"}}
        merged = fm.merge_duplicates([web, hn])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["id"], "web-1")
        self.assertEqual(merged[0]["extra"]["points"], 120)
        self.assertEqual(merged[0]["published_at"], "2026-03-01")

    def test_distinct_urls_are_kept(self):
        a = {"id": "a", "url": "https://one", "source": "paper"}
        b = {"id": "b", "url": "https://two", "source": "paper"}
        self.assertEqual(len(fm.merge_duplicates([a, b])), 2)


class Dates(unittest.TestCase):
    def test_parses_the_shapes_each_api_returns(self):
        self.assertEqual(fm.iso_date("2025-08-25T17:45:06.000Z"), "2025-08-25")  # HF / HN
        self.assertEqual(fm.iso_date("2025-11-20T09:00:00Z"), "2025-11-20")      # YouTube
        self.assertEqual(fm.iso_date("Tue, 26 Aug 2025 09:14:00 +0000"), "2025-08-26")  # RSS
        self.assertIsNone(fm.iso_date(None))


class CatalogFile(unittest.TestCase):
    """The shipped catalog must stay loadable by the web app."""

    def setUp(self):
        import json
        self.catalog = json.loads((fm.CATALOG_FILE).read_text())
        self.items = self.catalog["items"]

    def test_every_item_has_the_fields_the_app_reads(self):
        for it in self.items:
            for field in ("id", "title", "source", "topics", "url"):
                self.assertTrue(it.get(field), f"{it.get('id')} missing {field}")

    def test_ids_are_unique(self):
        ids = [i["id"] for i in self.items]
        self.assertEqual(len(ids), len(set(ids)))

    def test_sources_are_ones_the_app_renders(self):
        known = {"youtube", "podcast", "website", "paper", "hackernews"}
        self.assertTrue({i["source"] for i in self.items} <= known)

    def test_no_platform_name_is_used_as_a_creator(self):
        platforms = {"Hacker News", "Hugging Face Papers"}
        self.assertFalse({i.get("creator") for i in self.items} & platforms)

    def test_looks_beyond_youtube(self):
        sources = {i["source"] for i in self.items}
        self.assertIn("paper", sources)
        self.assertIn("hackernews", sources)
        youtube = sum(1 for i in self.items if i["source"] == "youtube")
        self.assertLess(youtube, len(self.items) / 2,
                        "catalog should not be majority YouTube")


if __name__ == "__main__":
    unittest.main(verbosity=2)
