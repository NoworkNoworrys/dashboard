"""
GeoIntel Backend — RSS Feed Ingester
Parses configured RSS feeds using feedparser.
Supports multi-language feeds via the translate module.
"""
import feedparser
from typing import List, Dict, Optional

from config import RSS_FEEDS, MULTILANG_FEEDS, BROWSER_HEADERS
from keyword_detector import build_event, extract_keywords
from ingest.translate import translate_entry


def fetch_rss() -> List[Dict]:
    """
    Fetch and parse all configured RSS feeds.
    Only returns entries that contain at least one severity keyword.
    Includes multi-language feeds with automatic translation.
    """
    events = []
    for url, source in RSS_FEEDS:
        events.extend(_parse_feed(url, source))

    # Multi-language feeds — translate before keyword extraction
    for url, source, lang in MULTILANG_FEEDS:
        events.extend(_parse_feed(url, source, lang=lang))

    print(f'[RSS] total geo-relevant entries: {len(events)}')
    return events


def _parse_feed(url: str, source: str, lang: Optional[str] = None) -> List[Dict]:
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

        # Translate non-English titles before keyword matching
        translated = False
        orig_title, orig_desc = title, desc
        if lang and lang != 'en':
            t_title, t_desc = translate_entry(title, desc, lang)
            if t_title and t_title != title:
                title, desc = t_title, t_desc
                translated = True

        # Only keep entries with at least one geopolitical keyword
        combined = (title + ' ' + desc).lower()
        if not _is_relevant(combined):
            continue

        evt = build_event(
            title=title,
            desc=desc,
            source=source,
        )
        if translated:
            evt['translated']  = True
            evt['orig_lang']   = lang
            evt['orig_title']  = orig_title[:90]
        events.append(evt)

    print(f'[RSS] {source}: {len(events)} relevant entries')
    return events


def _is_relevant(text: str) -> bool:
    """Quick check — at least one SEV keyword present."""
    return bool(extract_keywords(text))
