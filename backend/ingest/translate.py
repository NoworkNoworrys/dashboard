"""
Lightweight translation module for non-English RSS feeds.

Uses MyMemory (https://mymemory.translated.net) — completely free,
no API key required, 1000 chars/day per IP (raises to 10k with an email
param but anonymous is sufficient for short headlines).

Supported source languages: ar (Arabic), ru (Russian), zh (Chinese),
  fr (French), de (German), es (Spanish)

Results are cached in memory to avoid re-translating the same headline.
Cache TTL: 24 hours (headlines don't change).
"""
import datetime
import hashlib
import time
from typing import Optional, Dict, Any

import requests

_MYMEMORY_URL = 'https://api.mymemory.translated.net/get'

# In-memory translation cache {cache_key: (translated_text, ts)}
_cache: Dict[str, tuple] = {}
_CACHE_TTL = 24 * 3600   # 24 hours

# Rate-limit: track requests per minute to stay within free tier
_req_times: list = []
_MAX_RPM = 20   # conservative limit

# Daily character quota (MyMemory anonymous = 1000 chars/day per IP)
_daily_chars: int = 0
_daily_reset_date: str = ''
_DAILY_LIMIT: int = 900   # stay under 1000 limit


def _rate_ok() -> bool:
    """Return True if we're within the per-minute rate limit."""
    now = time.time()
    # Prune timestamps older than 60s
    while _req_times and _req_times[0] < now - 60:
        _req_times.pop(0)
    return len(_req_times) < _MAX_RPM


def _quota_ok(char_count: int) -> bool:
    """Return True and deduct from daily quota if enough chars remain."""
    global _daily_chars, _daily_reset_date
    today = datetime.date.today().isoformat()
    if _daily_reset_date != today:
        _daily_chars = 0
        _daily_reset_date = today
    if _daily_chars + char_count > _DAILY_LIMIT:
        print(f'[TRANSLATE] Daily quota exhausted ({_daily_chars}/{_DAILY_LIMIT} chars used) — skipping')
        return False
    _daily_chars += char_count
    return True


def translate(text: str, src_lang: str, dest_lang: str = 'en') -> Optional[str]:
    """
    Translate `text` from `src_lang` → `dest_lang`.
    Returns translated string, or None on failure / rate limit.

    Args:
        text:      Text to translate (keep under 500 chars for best results)
        src_lang:  ISO 639-1 code: 'ar', 'ru', 'zh', 'fr', 'de', 'es'
        dest_lang: Target language (default 'en')
    """
    if not text or not text.strip():
        return None
    if src_lang == dest_lang:
        return text

    # Truncate long text
    text = text[:300].strip()

    # Cache lookup
    cache_key = hashlib.md5(f'{src_lang}:{dest_lang}:{text}'.encode()).hexdigest()
    if cache_key in _cache:
        result, ts = _cache[cache_key]
        if time.time() - ts < _CACHE_TTL:
            return result

    # Rate limit check
    if not _rate_ok():
        return None

    # Daily quota check
    if not _quota_ok(len(text)):
        return None

    try:
        resp = requests.get(
            _MYMEMORY_URL,
            params={
                'q':        text,
                'langpair': f'{src_lang}|{dest_lang}',
            },
            timeout=8
        )
        _req_times.append(time.time())

        if not resp.ok:
            return None

        data = resp.json()
        translated = data.get('responseData', {}).get('translatedText', '')

        # MyMemory returns 'QUERY LENGTH LIMIT EXCEDEED' on abuse
        if not translated or 'LIMIT' in translated.upper():
            return None

        _cache[cache_key] = (translated, time.time())
        return translated

    except Exception as e:
        print(f'[TRANSLATE] {src_lang}→{dest_lang} error: {e}')
        return None


def translate_entry(title: str, desc: str, src_lang: str) -> tuple:
    """
    Translate title only — descriptions are skipped to conserve the
    MyMemory anonymous quota (900 chars/day).  Keyword matching runs on
    the title which carries the actionable signal; descriptions are kept
    in their original language for reference only.

    Returns (translated_title, original_desc).
    Falls back to original title if translation fails.
    """
    t_title = translate(title, src_lang) or title
    return t_title, desc or ''
