"""
GeoIntel Backend — RSS Feed Ingester
Parses configured RSS feeds using feedparser.
"""
import feedparser
from typing import List, Dict

from config import RSS_FEEDS, BROWSER_HEADERS
from keyword_detector import build_event, extract_keywords


def fetch_rss() -> List[Dict]:
    """
    Fetch and parse all configured RSS feeds.
    Only returns entries that contain at least one severity keyword.
    """
    events = []
    for url, source in RSS_FEEDS:
        events.extend(_parse_feed(url, source))
    print(f'[RSS] total geo-relevant entries: {len(events)}')
    return events


def _parse_feed(url: str, source: str) -> List[Dict]:
    try:
        # feedparser accepts request_headers to send browser UA
        feed = feedparser.parse(
            url,
            request_headers={
                'User-Agent': BROWSER_HEADERS['User-Agent'],
                'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            }
        )
    except Exception as e:
        print(f'[RSS] {source} parse error: {e}')
        return []

    if feed.bozo and not feed.entries:
        print(f'[RSS] {source} bozo error — skipping')
        return []

    entries = feed.entries[:15]  # newest 15 per feed
    events = []
    for entry in entries:
        title = (getattr(entry, 'title', '') or '').strip()
        desc  = (
            getattr(entry, 'summary', '')
            or getattr(entry, 'description', '')
            or ''
        ).strip()

        # Strip any basic HTML tags from summary
        import re
        desc = re.sub(r'<[^>]+>', ' ', desc).strip()
        desc = re.sub(r'\s+', ' ', desc)[:200]

        if not title:
            continue

        # Only keep entries with at least one geopolitical keyword
        combined = (title + ' ' + desc).lower()
        if not _is_relevant(combined):
            continue

        evt = build_event(
            title=title,
            desc=desc,
            source=source,
        )
        events.append(evt)

    print(f'[RSS] {source}: {len(events)} relevant entries')
    return events


def _is_relevant(text: str) -> bool:
    """Quick check — at least one SEV keyword present."""
    return bool(extract_keywords(text))
