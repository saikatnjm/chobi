"""Online subtitle search (English + Bangla) via the free OpenSubtitles.org REST API.

No account needed. For each language we combine:
  1. a file-hash match (OpenSubtitles "moviehash": needs only the first and last
     64 KB of the video from the local BDIX server) -> subtitles made for this
     exact file, so they are in perfect sync;
  2. a title search, narrowed to the right movie (year) or episode, then a search
     by that movie's IMDb id for the complete list.
Downloads are gzipped .srt files; they are cleaned of inserted ad lines and
converted to WebVTT. Results and files are cached in cache/subs/.

(api.opensubtitles.com is blocked by some BD ISPs and podnapisi.net was
unreachable when this was written, so they are not used.)
"""

import concurrent.futures
import gzip
import hashlib
import json
import os
import re
import struct
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://rest.opensubtitles.org/search/"
UA = "TemporaryUserAgent"  # the public user agent the legacy REST API accepts
CACHE = Path(os.environ.get("CHOBI_DATA") or Path(__file__).resolve().parent) / "cache" / "subs"
LANGS = {"eng": "English", "ben": "Bangla"}
AD_RE = re.compile(r"osdb\.link|opensubtitles|watch online movies|advertise your product|subtitles by|"
                   r"api\.opensubtitles|www\.[a-z0-9-]+\.(com|net|org|link)", re.I)
_mem = {}


def _norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _get_json(path):
    req = urllib.request.Request(API + path, headers={"X-User-Agent": UA, "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode("utf-8", "replace") or "[]")
    return data if isinstance(data, list) else []


def _seg(key, value):
    return f"{key}-{urllib.parse.quote(str(value).lower(), safe='')}"


def movie_hash(url, size=None):
    """OpenSubtitles hash: file size + sum of the 64-bit words of the first and last 64 KB."""
    def rng(a, b):
        req = urllib.request.Request(url, headers={"Range": f"bytes={a}-{b}", "User-Agent": "Chobi/2.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            total = r.headers.get("Content-Range", "").rsplit("/", 1)[-1]
            return r.read(65536), (int(total) if total.isdigit() else None)
    head, total = rng(0, 65535)
    size = size or total
    if not size or size < 131072 or len(head) < 65536:
        return None, size
    tail, _ = rng(size - 65536, size - 1)
    h = size
    for chunk in (head, tail[-65536:]):
        for (q,) in struct.iter_unpack("<Q", chunk[: len(chunk) // 8 * 8]):
            h = (h + q) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}", size


def _row(x, exact_name):
    name = x.get("SubFileName", "")
    rel = (x.get("MovieReleaseName") or "").strip()
    stem = _norm(re.sub(r"\.[a-z0-9]{2,4}$", "", name, flags=re.I))
    return {
        "id": x.get("IDSubtitleFile"),
        "lang": x.get("SubLanguageID"),
        "name": name,
        "release": rel,
        "downloads": int(x.get("SubDownloadsCnt") or 0),
        "rating": float(x.get("SubRating") or 0),
        "hi": x.get("SubHearingImpaired") == "1",
        "cds": int(x.get("SubSumCD") or 1),
        "fmt": x.get("SubFormat", ""),
        "enc": x.get("SubEncoding", ""),
        "link": x.get("SubDownloadLink", ""),
        "movie": x.get("MovieName", ""),
        "year": x.get("MovieYear", ""),
        "imdb": x.get("IDMovieImdb", ""),
        # Same release name as our video file (allowing a ".en"-style suffix), e.g. Heat.1995.BrRip.720p.x264.YIFY
        "exact": bool(exact_name and stem and (stem == exact_name or stem.startswith(exact_name + " ") or
                                               (exact_name.startswith(stem) and len(stem) >= 0.85 * len(exact_name)))),
        "sync": x.get("MatchedBy") == "moviehash",
    }


def _search_lang(lang, title, year, season, episode, mhash, size, file_stem):
    rows, ids = [], set()

    def add(items):
        for x in items:
            if x.get("SubFormat", "srt").lower() not in ("srt", "vtt", "sub", "txt") or x.get("IDSubtitleFile") in ids:
                continue
            if season and (x.get("SeriesSeason") != str(season) or x.get("SeriesEpisode") != str(episode)):
                if x.get("MatchedBy") != "moviehash":
                    continue
            ids.add(x.get("IDSubtitleFile"))
            rows.append(_row(x, file_stem))

    if mhash and size:
        try:
            add(_get_json(f"moviebytesize-{size}/moviehash-{mhash}/sublanguageid-{lang}"))
        except Exception:  # noqa: BLE001
            pass
    try:
        if season:
            add(_get_json("/".join([_seg("episode", episode), _seg("query", title), _seg("season", season),
                                    f"sublanguageid-{lang}"])))
        else:
            found = _get_json(f"{_seg('query', title)}/sublanguageid-{lang}")
            nt = _norm(title)
            good = [x for x in found if _norm(x.get("MovieName")) == nt and
                    (not year or abs(int(x.get("MovieYear") or 0) - int(year)) <= 1)]
            imdb = next((x.get("IDMovieImdb") for x in good if x.get("IDMovieImdb")), None)
            if imdb:
                add(_get_json(f"imdbid-{imdb}/sublanguageid-{lang}"))
            add(good)
    except Exception:  # noqa: BLE001 - return what we have
        pass
    for r in rows:
        r["sync"] = r["sync"] or r["exact"]
    rows.sort(key=lambda r: (not r["exact"], not r["sync"], r["cds"] > 1, -r["downloads"]))
    return rows[:40]


def search(title, year=None, season=None, episode=None, url=None, size=None, file_name=""):
    title = re.sub(r"\s*\(\d{4}\)\s*$", "", title or "").strip()
    if not title:
        raise ValueError("Type a title to search")
    key = json.dumps([title.lower(), year, season, episode, url, size])
    hit = _mem.get(key)
    if hit and time.time() - hit[0] < 86400:
        return hit[1]
    mhash = None
    if url:
        try:
            mhash, size = movie_hash(url, size)
        except Exception:  # noqa: BLE001 - hash is a bonus
            mhash = None
    stem = _norm(re.sub(r"\.[a-z0-9]{2,4}$", "", file_name or "", flags=re.I))
    with concurrent.futures.ThreadPoolExecutor(len(LANGS)) as ex:
        futs = {lang: ex.submit(_search_lang, lang, title, year, season, episode, mhash, size, stem) for lang in LANGS}
        results = {lang: f.result() for lang, f in futs.items()}
    out = {"title": title, "year": year, "season": season, "episode": episode, "hashed": bool(mhash),
           "results": [r for lang in LANGS for r in results[lang]]}
    _mem[key] = (time.time(), out)
    return out


def clean_srt(text):
    """Drop ad cues and HTML font tags; keep the rest untouched."""
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    blocks = re.split(r"\n\s*\n", text.strip())
    keep = [b for b in blocks if not AD_RE.search(b)]
    out = "\n\n".join(keep)
    out = re.sub(r"</?font[^>]*>", "", out, flags=re.I)
    return out + "\n"


def download(link, enc=""):
    """Fetch a subtitle by its OpenSubtitles download link; return cleaned SRT text."""
    p = urllib.parse.urlsplit(link)
    if p.scheme != "https" or p.netloc not in ("dl.opensubtitles.org", "www.opensubtitles.org"):
        raise ValueError("Not an OpenSubtitles download link")
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / (hashlib.sha1(link.encode()).hexdigest()[:20] + ".srt")
    if f.exists():
        return f.read_text(encoding="utf-8")
    req = urllib.request.Request(link, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read(8 * 1024 * 1024)
    if body[:2] == b"\x1f\x8b":
        body = gzip.decompress(body)
    text = None
    for codec in [c for c in (enc, "utf-8", "cp1252") if c]:
        try:
            text = body.decode(codec)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    text = clean_srt(text if text is not None else body.decode("utf-8", "replace"))
    f.write_text(text, encoding="utf-8")
    return text
