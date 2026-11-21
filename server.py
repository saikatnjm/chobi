#!/usr/bin/env python3
"""Chobi - one fast, simple front end for the free BDIX FTP / media servers.

Zero dependencies (Python 3.8+ standard library only).

  python3 server.py              # http://127.0.0.1:8090
  python3 server.py --port 9000  # another port

What this server does (see AGENTS.md for the full picture):
  * serves the UI from ./static
  * reads the servers listed in sources.json (DhakaFlix portal, h5ai, plain
    Apache/nginx directory listings) and forwards small JSON requests to them,
    because those servers send no CORS headers
  * builds a movie index (movies.py) so search and filters are instant
  * caches posters, converts .srt subtitles to WebVTT, and picks a working copy
    of a movie when you press Play

Video files are never proxied: the player and download links use the original
server URLs directly.
"""

import argparse
import concurrent.futures
import gzip
import hashlib
import html
import json
import io
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import genres
import movies
import subs

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
# Everything Chobi writes (server list, index, posters, history) lives under DATA.
# Defaults to the project folder; the Docker image sets CHOBI_DATA=/data (a volume).
DATA = Path(os.environ.get("CHOBI_DATA") or ROOT).resolve()
SOURCES_FILE = DATA / "sources.json"
if not SOURCES_FILE.exists() and (ROOT / "sources.json").exists():
    DATA.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / "sources.json", SOURCES_FILE)  # first run in a fresh data folder
POSTER_DIR = DATA / "cache" / "thumbs"
THUMB_W = 300  # poster thumbnails: ~10-25 KB instead of 50-400 KB
TIMEOUT = 12
UA = "Chobi/2.0 (local media front end)"
VIDEO_EXT = movies.VIDEO_EXT
IMAGE_EXT = {"jpg", "jpeg", "png", "webp"}
SUB_EXT = {"srt", "vtt"}

# Built-in copy of the DhakaFlix portal menu, used when 172.16.50.4 cannot be reached.
FALLBACK_PORTAL = {
    "Movies": [
        ["English Movies", "http://172.16.50.7/DHAKA-FLIX-7/English%20Movies/"],
        ["English Movies 1080p", "http://172.16.50.14/DHAKA-FLIX-14/English%20Movies%20%281080p%29/"],
        ["Hindi Movies", "http://172.16.50.14/DHAKA-FLIX-14/Hindi%20Movies/"],
        ["South Indian Movies", "http://172.16.50.14/DHAKA-FLIX-14/SOUTH%20INDIAN%20MOVIES/South%20Movies/"],
        ["South Movie Hindi Dubbed", "http://172.16.50.14/DHAKA-FLIX-14/SOUTH%20INDIAN%20MOVIES/Hindi%20Dubbed/"],
        ["Kolkata Bangla Movies", "http://172.16.50.7/DHAKA-FLIX-7/Kolkata%20Bangla%20Movies/"],
        ["Animation Movies", "http://172.16.50.14/DHAKA-FLIX-14/Animation%20Movies/"],
        ["Animation Movies 1080p", "http://172.16.50.14/DHAKA-FLIX-14/Animation%20Movies%20%281080p%29/"],
        ["Foreign Language Movies", "http://172.16.50.7/DHAKA-FLIX-7/Foreign%20Language%20Movies/"],
        ["IMDb Top-250 Movies", "http://172.16.50.14/DHAKA-FLIX-14/IMDb%20Top-250%20Movies/"],
        ["3D Movies", "http://172.16.50.7/DHAKA-FLIX-7/3D%20Movies/"],
    ],
    "TV Series": [
        ["TV & WEB Series", "http://172.16.50.12/DHAKA-FLIX-12/TV-WEB-Series/"],
        ["KOREAN TV & WEB Series", "http://172.16.50.14/DHAKA-FLIX-14/KOREAN%20TV%20%26%20WEB%20Series/"],
        ["Cartoon TV Series", "http://172.16.50.10/DHAKA-FLIX-10/Anime%20%26%20Cartoon%20TV%20Series/"],
        ["Documentary", "http://172.16.50.10/DHAKA-FLIX-10/Documentary/"],
        ["WWE & AEW Wrestling", "http://172.16.50.10/DHAKA-FLIX-10/WWE%20%26%20AEW%20Wrestling/"],
        ["Award & TV Shows", "http://172.16.50.10/DHAKA-FLIX-10/Awards%20%26%20TV%20Shows/"],
    ],
    "Games": [
        ["PC Games", "http://172.16.50.8/DHAKA-FLIX-8/PC%20Games/"],
        ["Android Games", "http://172.16.50.8/DHAKA-FLIX-8/Android%20Games/"],
        ["Console Games", "http://172.16.50.8/DHAKA-FLIX-8/Console%20Games/"],
    ],
    "Software": [
        ["Software", "http://172.16.50.8/DHAKA-FLIX-8/Software/"],
        ["Tutorials & Training", "http://172.16.50.10/DHAKA-FLIX-10/Tutorial/"],
    ],
}


# --------------------------------------------------------------------------- utils
class TTLCache:
    def __init__(self, ttl, max_items=400):
        self.ttl, self.max_items = ttl, max_items
        self.data, self.lock = {}, threading.Lock()

    def get(self, key):
        with self.lock:
            hit = self.data.get(key)
            if hit and time.time() - hit[0] < self.ttl:
                return hit[1]
            return None

    def put(self, key, value):
        with self.lock:
            if len(self.data) >= self.max_items:
                del self.data[min(self.data, key=lambda k: self.data[k][0])]
            self.data[key] = (time.time(), value)

    def clear(self):
        with self.lock:
            self.data.clear()


list_cache = TTLCache(180, 2000)
search_cache = TTLCache(600, 100)
misc_cache = TTLCache(60, 20)


class UpstreamError(Exception):
    pass


def http(url, data=None, timeout=TIMEOUT, method=None, headers=None, limit=None):
    h = {"User-Agent": UA}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(limit + 1 if limit else -1) if method != "HEAD" else b""
            if limit and len(body) > limit:
                raise UpstreamError("file too large")
            return r.status, r.headers, body
    except urllib.error.HTTPError as e:
        raise UpstreamError(f"{urllib.parse.urlsplit(url).netloc} answered {e.code}") from e
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        raise UpstreamError(f"{urllib.parse.urlsplit(url).netloc} did not answer ({e.__class__.__name__})") from e


def norm_path(path):
    """Normalise a URL path to rawurlencode-style encoding (what h5ai uses)."""
    return urllib.parse.quote(urllib.parse.unquote(path or "/"), safe="/")


def ext_of(name):
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:24] or "src"


# ------------------------------------------------------------------ server registry
REG_LOCK = threading.Lock()
HOSTS = {}       # host id -> {"base": "http://1.2.3.4", "kind": "h5ai"|"autoindex", "source": name}
CATEGORIES = []  # [{section, name, host, href, url, source}]
REG_INFO = {"loaded": 0, "errors": []}


def read_sources():
    try:
        return json.loads(SOURCES_FILE.read_text())
    except (OSError, ValueError):
        return {"sources": [{"id": "dhakaflix", "name": "DhakaFlix", "type": "dhakaflix",
                             "portal": "http://172.16.50.4/"}]}


def write_sources(doc):
    tmp = SOURCES_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(SOURCES_FILE)


def host_for(base, sid, kind, source_name, hosts):
    for hid, h in hosts.items():
        if h["base"] == base:
            return hid
    m = re.fullmatch(r"http://172\.16\.50\.(\d+)", base)
    hid = m.group(1) if m else f"{sid}-{sum(1 for k in hosts if k.startswith(sid + '-')) + 1}"
    hosts[hid] = {"base": base, "kind": kind, "source": source_name}
    return hid


def split_url(url):
    p = urllib.parse.urlsplit(url)
    base = f"{p.scheme}://{p.netloc}"
    path = norm_path(p.path or "/")
    return base, path if path.endswith("/") else path + "/"


def parse_portal(page):
    """Pull the category menus out of the DhakaFlix portal's index.html."""
    sections = {}
    for m in re.finditer(
        r'dropdown-toggle[^>]*>\s*([^<]+?)\s*<span class="caret">.*?<ul class="dropdown-menu">(.*?)</ul>',
        page, re.S | re.I,
    ):
        title = html.unescape(m.group(1)).strip()
        links = [[re.sub(r"\s+-\s*", " ", html.unescape(t)).strip(), html.unescape(h)]
                 for h, t in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>([^<]+)</a>', m.group(2))]
        if links:
            sections[title] = links
    known = {l[1].rstrip("/") for links in sections.values() for l in links}
    extra = []
    for h, t in re.findall(r'<h7><a href="([^"]+)">([^<]+)</a></h7>', page):
        h = html.unescape(h)
        if h.rstrip("/") not in known and h.startswith("http://"):
            extra.append([html.unescape(t).strip(), h])
            known.add(h.rstrip("/"))
    if extra:
        sections["More"] = extra
    return sections


def load_registry(force=False):
    if not force and REG_INFO["loaded"] and time.time() - REG_INFO["loaded"] < 300:
        return
    hosts, cats, errors = {}, [], []
    for src in read_sources().get("sources", []):
        if src.get("enabled") is False:
            continue
        sid, sname, kind = slug(src.get("id") or src.get("name", "src")), src.get("name", "Server"), src.get("type")
        if kind == "dhakaflix":
            try:
                _, _, body = http(src.get("portal", "http://172.16.50.4/"), timeout=8)
                sections = parse_portal(body.decode("utf-8", "replace")) or FALLBACK_PORTAL
            except UpstreamError as e:
                errors.append(f"{sname}: portal unreachable ({e}); using built-in menu")
                sections = FALLBACK_PORTAL
            for section, links in sections.items():
                for name, url in links:
                    if not url.startswith("http://"):
                        continue
                    base, path = split_url(url)
                    hid = host_for(base, sid, "h5ai", sname, hosts)
                    cats.append({"section": section, "name": name, "host": hid, "href": path,
                                 "url": base + path, "source": sname})
        elif kind in ("h5ai", "autoindex"):
            for c in src.get("categories", []):
                base, path = split_url(c["url"])
                hid = host_for(base, sid, kind, sname, hosts)
                cats.append({"section": c.get("section", "Other"), "name": c.get("name") or
                             urllib.parse.unquote(path.rstrip("/").split("/")[-1]) or sname,
                             "host": hid, "href": path, "url": base + path, "source": sname})
        else:
            errors.append(f"{sname}: unknown type {kind!r}")
    with REG_LOCK:
        HOSTS.clear()
        HOSTS.update(hosts)
        CATEGORIES[:] = cats
        REG_INFO.update(loaded=time.time(), errors=errors)


def host_info(hid):
    load_registry()
    h = HOSTS.get(hid)
    if not h:
        raise ValueError("Unknown server")
    return h


# ---------------------------------------------------------------------- adapters
def h5ai_call(base, fields, timeout=TIMEOUT):
    _, _, body = http(base + "/_h5ai/public/index.php", data=urllib.parse.urlencode(fields).encode(),
                      timeout=timeout)
    try:
        return json.loads(body.decode("utf-8", "replace"))
    except ValueError as e:
        raise UpstreamError("not an h5ai server") from e


SIZE_RE = re.compile(r"(?<![\w.:-])(\d+(?:\.\d+)?)\s*([KMGT])?(?:i?B)?(?![\w.:-])", re.I)
DATE_RES = [
    (re.compile(r"(\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2})"), "%d-%b-%Y %H:%M"),
    (re.compile(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2})"), "%Y-%m-%d %H:%M"),
    (re.compile(r"(\d{4}-[A-Za-z]{3}-\d{2} \d{2}:\d{2})"), "%Y-%b-%d %H:%M"),
]


def parse_autoindex(page, page_url):
    """Parse Apache / nginx / lighttpd style directory listings."""
    out, seen = [], set()
    cur = urllib.parse.urlsplit(page_url)
    cur_path = norm_path(cur.path)
    chunks = re.split(r"(?i)<a\s", page)[1:]
    for ch in chunks:
        m = re.search(r'href\s*=\s*["\']([^"\']+)["\']', ch)
        if not m:
            continue
        raw = html.unescape(m.group(1))
        if raw.startswith(("?", "#", "mailto:", "javascript:")):
            continue
        absu = urllib.parse.urlsplit(urllib.parse.urljoin(page_url, raw))
        if absu.netloc != cur.netloc:
            continue
        path = norm_path(absu.path)
        if not path.startswith(cur_path) or path == cur_path:
            continue
        rest = path[len(cur_path):]
        if "/" in rest.rstrip("/"):
            continue
        if path in seen:
            continue
        seen.add(path)
        tail = re.sub(r"<[^>]+>", " ", ch.split(">", 1)[-1] if ">" in ch else "")
        tail = html.unescape(tail.split("</a>", 1)[-1] if "</a>" in tail else tail)
        tail = re.sub(r"^[^<]*?</a\s*>", "", tail)
        t = None
        for rx, fmt in DATE_RES:
            dm = rx.search(tail)
            if dm:
                try:
                    t = int(datetime.strptime(dm.group(1), fmt).timestamp() * 1000)
                except ValueError:
                    pass
                tail = tail.replace(dm.group(1), " ")
                break
        size = None
        if not path.endswith("/"):
            sm = SIZE_RE.search(tail)
            if sm:
                mult = {"K": 1024, "M": 1024 ** 2, "G": 1024 ** 3, "T": 1024 ** 4}.get((sm.group(2) or "").upper(), 1)
                size = int(float(sm.group(1)) * mult)
        out.append({"href": path, "time": t, "size": size})
    return out


def list_dir(hid, href):
    key = (hid, href)
    cached = list_cache.get(key)
    if cached:
        return cached
    h = host_info(hid)
    if h["kind"] == "h5ai":
        data = h5ai_call(h["base"], {"action": "get", "items[href]": href, "items[what]": "1"})
        items = data.get("items") or []
        children = []
        for it in items:
            p = it.get("href", "")
            if p == href or not p.startswith(href) or "/" in p[len(href):].rstrip("/"):
                continue
            children.append({"href": p, "time": it.get("time"), "size": it.get("size")})
        exists = any(it.get("href") == href for it in items)
    else:
        _, _, body = http(h["base"] + href, limit=8 * 1024 * 1024)
        children = parse_autoindex(body.decode("utf-8", "replace"), h["base"] + href)
        exists = True
    result = {"host": hid, "href": href, "items": children, "exists": exists}
    list_cache.put(key, result)
    return result


def search_dir(hid, href, q):
    key = (hid, href, q.lower())
    cached = search_cache.get(key)
    if cached:
        return cached
    h = host_info(hid)
    if h["kind"] != "h5ai":
        raise ValueError("This server has no built-in search. Use the Movies page, which searches every server.")
    data = h5ai_call(h["base"], {"action": "get", "search[href]": href, "search[pattern]": q,
                                 "search[ignorecase]": "1"}, timeout=40)
    hits = [{"href": it["href"], "time": it.get("time"), "size": it.get("size")}
            for it in data.get("search") or [] if it.get("href")]
    result = {"host": hid, "href": href, "q": q, "items": hits[:2000], "total": len(hits)}
    search_cache.put(key, result)
    return result


def ping(hid):
    h = HOSTS[hid]
    t0 = time.time()
    try:
        if h["kind"] == "h5ai":
            h5ai_call(h["base"], {"action": "get", "setup": "1"}, timeout=4)
        else:
            http(h["base"] + "/", timeout=4, method="HEAD")
        return {"up": True, "ms": round((time.time() - t0) * 1000)}
    except UpstreamError:
        return {"up": False}


def get_status():
    cached = misc_cache.get("status")
    if cached:
        return cached
    load_registry()
    ids = list(HOSTS)
    with concurrent.futures.ThreadPoolExecutor(max(1, len(ids))) as ex:
        result = dict(zip(ids, ex.map(ping, ids)))
    misc_cache.put("status", result)
    return result


def portal_payload():
    load_registry()
    sections = {}
    for c in CATEGORIES:
        sections.setdefault(c["section"], []).append(c)
    return {"sections": sections,
            "hosts": {k: {"base": v["base"], "source": v["source"], "kind": v["kind"]} for k, v in HOSTS.items()},
            "errors": REG_INFO["errors"]}


def movie_categories():
    load_registry()
    return [c for c in CATEGORIES if c["section"].lower() == "movies" or
            (c["section"].lower() == "more" and re.search(r"film|movie", c["name"], re.I))]


MOVIES = movies.MovieIndex(lambda hid, href: list_dir(hid, href), movie_categories)
GENRES = genres.Genres()

# Watch history ("Continue watching"), kept on this machine only.
HISTORY_FILE = DATA / "cache" / "history.json"
HISTORY_LOCK = threading.Lock()


def read_history():
    try:
        return json.loads(HISTORY_FILE.read_text())
    except (OSError, ValueError):
        return []


def save_history_item(item):
    keep = ("id", "title", "show", "ep", "url", "host", "file", "poster", "pos", "dur", "next", "key")
    item = {k: item[k] for k in keep if k in item}
    if not isinstance(item.get("id"), str) or not item["id"]:
        raise ValueError("Missing id")
    item["at"] = int(time.time() * 1000)
    with HISTORY_LOCK:
        hist = [h for h in read_history() if h.get("id") != item["id"]]
        hist.insert(0, item)
        HISTORY_FILE.parent.mkdir(exist_ok=True)
        tmp = HISTORY_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(hist[:40], ensure_ascii=False))
        tmp.replace(HISTORY_FILE)


def delete_history_item(hid):
    with HISTORY_LOCK:
        hist = [h for h in read_history() if h.get("id") != hid]
        HISTORY_FILE.parent.mkdir(exist_ok=True)
        HISTORY_FILE.write_text(json.dumps(hist, ensure_ascii=False))


# ------------------------------------------------------------- posters & playback
POSTER_LOCK = threading.Lock()
POSTER_SEM = threading.Semaphore(6)
POSTER_MAP_FILE = POSTER_DIR / "index.json"
try:
    POSTER_MAP = json.loads(POSTER_MAP_FILE.read_text())
except (OSError, ValueError):
    POSTER_MAP = {}
_poster_dirty = [0]


def save_poster_map():
    with POSTER_LOCK:
        POSTER_DIR.mkdir(parents=True, exist_ok=True)
        tmp = POSTER_MAP_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(POSTER_MAP))
        tmp.replace(POSTER_MAP_FILE)
        _poster_dirty[0] = 0


def pick_poster(items):
    imgs = [it for it in items if ext_of(it["href"]) in IMAGE_EXT]
    if not imgs:
        return None
    def score(it):
        n = urllib.parse.unquote(it["href"].split("/")[-1]).lower()
        named = 0 if re.search(r"poster|cover|folder|front", n) else 1
        size = it.get("size") or 0
        too_small = 1 if size and size < 12_000 else 0
        return (named, too_small, size)  # smallest real image: saves bandwidth
    return sorted(imgs, key=score)[0]


def make_thumb(data, ext):
    """Shrink a poster to THUMB_W px wide. Uses Pillow or ffmpeg if present, else keeps the original."""
    try:
        from PIL import Image  # optional
        im = Image.open(io.BytesIO(data))
        im.draft("RGB", (THUMB_W * 2, THUMB_W * 3))  # fast JPEG downscale while decoding
        im = im.convert("RGB")
        if im.width > THUMB_W:
            im = im.resize((THUMB_W, round(im.height * THUMB_W / im.width)), Image.LANCZOS)
        out = io.BytesIO()
        try:
            im.save(out, "WEBP", quality=70, method=4)
            return out.getvalue(), "webp"
        except (OSError, KeyError, ValueError):
            out = io.BytesIO()
            im.save(out, "JPEG", quality=76, optimize=True, progressive=True)
            return out.getvalue(), "jpg"
    except Exception:  # noqa: BLE001 - Pillow missing or bad image
        pass
    ff = shutil.which("ffmpeg")
    if ff:
        try:
            r = subprocess.run([ff, "-loglevel", "error", "-i", "pipe:0", "-vf", f"scale={THUMB_W}:-2",
                                "-q:v", "6", "-f", "mjpeg", "pipe:1"], input=data, capture_output=True, timeout=15)
            if r.returncode == 0 and r.stdout:
                return r.stdout, "jpg"
        except (OSError, subprocess.SubprocessError):
            pass
    return data, ext


def get_poster(hid, href):
    """Return a local file path for the folder's poster, or None."""
    key = f"{hid}|{href}"
    known = POSTER_MAP.get(key)
    if known == "":
        return None
    if known and (POSTER_DIR / known).exists():
        return POSTER_DIR / known
    with POSTER_SEM:
        try:
            listing = list_dir(hid, href)
            img = pick_poster(listing["items"])
            if not img:
                POSTER_MAP[key] = ""
                _poster_dirty[0] += 1
                return None
            h = host_info(hid)
            _, headers, body = http(h["base"] + img["href"], limit=3 * 1024 * 1024, timeout=15)
        except (UpstreamError, ValueError):
            return None  # transient; try again next time
    body, ext = make_thumb(body, ext_of(img["href"]) or "jpg")
    name = hashlib.sha1(key.encode()).hexdigest()[:20] + "." + ext
    POSTER_DIR.mkdir(parents=True, exist_ok=True)
    (POSTER_DIR / name).write_bytes(body)
    POSTER_MAP[key] = name
    _poster_dirty[0] += 1
    if _poster_dirty[0] >= 20:
        save_poster_map()
    return POSTER_DIR / name


def check_url(url, timeout=5):
    t0 = time.time()
    try:
        http(url, timeout=timeout, headers={"Range": "bytes=0-0"}, limit=2)
        return True, round((time.time() - t0) * 1000), ""
    except UpstreamError as e:
        if "too large" in str(e):  # server ignored Range but answered
            return True, round((time.time() - t0) * 1000), ""
        return False, None, str(e)


def resolve(cands):
    """cands: [(host, href)] in preferred order. Find the video file in each and test them in turn."""
    out, found = [], False
    for hid, href in cands[:12]:
        entry = {"host": hid, "href": href}
        try:
            h = host_info(hid)
            if href.endswith("/"):
                items = list_dir(hid, href)["items"]
                vids = sorted((it for it in items if ext_of(it["href"]) in VIDEO_EXT),
                              key=lambda it: -(it.get("size") or 0))
                if not vids:
                    entry["error"] = "no video file in this folder"
                    out.append(entry)
                    continue
                entry["file"] = vids[0]["href"]
                entry["size"] = vids[0].get("size")
                entry["subs"] = [it["href"] for it in items if ext_of(it["href"]) in SUB_EXT]
            else:
                entry["file"] = href
                entry["subs"] = []
            entry["url"] = h["base"] + entry["file"]
            entry["source"] = h["source"]
            if not found:
                ok, ms, err = check_url(entry["url"])
                entry["ok"], entry["ms"] = ok, ms
                if err:
                    entry["error"] = err
                found = ok
        except (UpstreamError, ValueError) as e:
            entry["error"] = str(e)
            entry["ok"] = False
        out.append(entry)
    return out


def srt_to_vtt(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    if text.startswith("WEBVTT"):
        return text
    text = re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", text)
    return "WEBVTT\n\n" + text


# --------------------------------------------------------------- adding servers
def detect_server(url):
    url = url.strip()
    if not re.match(r"^https?://", url, re.I):
        url = "http://" + url
    p = urllib.parse.urlsplit(url)
    if not p.netloc:
        raise ValueError("That doesn't look like a server address")
    base = f"{p.scheme}://{p.netloc}"
    path = norm_path(p.path or "/")
    if not path.endswith("/"):
        path += "/"
    kind = None
    try:
        data = h5ai_call(base, {"action": "get", "setup": "1"}, timeout=6)
        if "setup" in data:
            kind = "h5ai"
    except UpstreamError:
        pass
    items = []
    if kind == "h5ai":
        data = h5ai_call(base, {"action": "get", "items[href]": path, "items[what]": "1"})
        items = [{"href": it["href"]} for it in data.get("items") or []
                 if it.get("href", "").startswith(path) and it["href"] != path
                 and "/" not in it["href"][len(path):].rstrip("/")]
        if not items:
            kind = None  # e.g. a portal page served next to h5ai: look at the page itself
    if kind is None:
        _, headers, body = http(base + path, timeout=10, limit=8 * 1024 * 1024)
        page = body.decode("utf-8", "replace")
        items = parse_autoindex(page, base + path)
        if items:
            kind = "autoindex"
        else:
            # A portal page linking to other listings (like DhakaFlix's front page)?
            links = [html.unescape(l) for l in re.findall(r'href="(https?://[^"]+/)"', page)]
            if links:
                return {"kind": "portal", "base": base, "href": path, "links": sorted(set(links))[:200],
                        "folders": []}
            raise ValueError("No folder listing found at that address. Paste the address of a page that "
                             "shows a list of folders.")
    folders = []
    for it in items:
        if not it["href"].endswith("/"):
            continue
        name = urllib.parse.unquote(it["href"].rstrip("/").split("/")[-1])
        n = name.lower()
        section = ("Movies" if re.search(r"movie|film|cinema|hollywood|bollywood|tollywood|imdb|3d", n) else
                   "TV Series" if re.search(r"tv|series|show|drama|anime|cartoon|documentar|season", n) else
                   "Games" if re.search(r"game", n) else
                   "Software" if re.search(r"soft|app|program|tutorial", n) else "Other")
        folders.append({"name": name, "href": it["href"], "section": section})
    return {"kind": kind, "base": base, "href": path, "folders": folders}


def add_server(body):
    name = (body.get("name") or "").strip()[:60]
    kind = body.get("kind")
    base = body.get("base", "").rstrip("/")
    cats = body.get("categories") or []
    if kind not in ("h5ai", "autoindex") or not re.match(r"^https?://[^/\s]+$", base) or not cats:
        raise ValueError("Pick at least one folder to add")
    doc = read_sources()
    sid = slug(name or urllib.parse.urlsplit(base).netloc)
    ids = {s.get("id") for s in doc["sources"]}
    n, base_sid = 2, sid
    while sid in ids:
        sid, n = f"{base_sid}-{n}", n + 1
    entry = {"id": sid, "name": name or urllib.parse.urlsplit(base).netloc, "type": kind, "categories": []}
    for c in cats[:100]:
        href = norm_path(c.get("href", "/"))
        entry["categories"].append({"section": c.get("section", "Other")[:30],
                                    "name": (c.get("name") or href)[:80], "url": base + href})
    doc["sources"].append(entry)
    write_sources(doc)
    return entry


def remove_server(sid):
    doc = read_sources()
    before = len(doc["sources"])
    doc["sources"] = [s for s in doc["sources"] if s.get("id") != sid]
    if len(doc["sources"]) == before:
        raise ValueError("No such server")
    write_sources(doc)


def after_sources_change():
    load_registry(force=True)
    misc_cache.clear()
    list_cache.clear()
    MOVIES.start()


# ------------------------------------------------------------------------ HTTP
STATIC_CACHE = {}  # path -> (mtime, etag, raw, gz)
# The browser loads one minified bundle; edit the files in static/js and reload.
JS_ORDER = ["core", "movies", "player", "browse", "servers", "foryou", "main"]


def minify_js(src):
    """Very small, safe minifier for this codebase: drops comment-only lines and indentation."""
    src = re.sub(r"(?m)^\s*/\*.*?\*/\s*$", "", src, flags=re.S)  # leading block comments
    out = []
    for line in src.split("\n"):
        t = line.strip()
        if not t or t.startswith("// "):
            continue
        out.append(t)
    return "\n".join(out)


def minify_css(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"\s+", " ", src)
    src = re.sub(r"\s*([{};,>])\s*", r"\1", src)
    return src.replace(";}", "}").strip()


def build_asset(name):
    """Return (mtime, etag, raw, gz) for the virtual /app.js and /app.min.css."""
    files = [STATIC / "js" / f"{n}.js" for n in JS_ORDER] if name == "app.js" else [STATIC / "app.css"]
    mtime = max(f.stat().st_mtime for f in files)
    hit = STATIC_CACHE.get(name)
    if hit and hit[0] == mtime:
        return hit
    if name == "app.js":
        raw = ";\n".join(minify_js(f.read_text()) for f in files).encode()
    else:
        raw = minify_css(files[0].read_text()).encode()
    hit = (mtime, '"%x-%x"' % (int(mtime), len(raw)), raw, gzip.compress(raw, 9))
    STATIC_CACHE[name] = hit
    return hit


class Handler(SimpleHTTPRequestHandler):
    server_version = "Chobi/2.0"
    protocol_version = "HTTP/1.1"  # keep-alive: fewer round trips
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".vtt": "text/vtt"}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or "") and "/api/poster" not in (self.path or ""):
            super().log_message(fmt, *args)

    def serve_static(self, path):
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        if rel in ("app.js", "app.min.css"):
            _, tag, raw, gz = build_asset(rel)
            ctype = "text/javascript; charset=utf-8" if rel == "app.js" else "text/css; charset=utf-8"
            hdr = {"ETag": tag, "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
            if self.headers.get("If-None-Match") == tag:
                return self.send_bytes(304, b"", ctype, hdr)
            if "gzip" in self.headers.get("Accept-Encoding", ""):
                return self.send_bytes(200, gz, ctype, {**hdr, "Content-Encoding": "gzip"})
            return self.send_bytes(200, raw, ctype, hdr)
        if rel.endswith("/"):
            rel += "index.html"
        f = (STATIC / rel).resolve()
        if STATIC not in f.parents or not f.is_file():
            return self.send_bytes(404, b"Not found", "text/plain")
        st = f.stat()
        hit = STATIC_CACHE.get(f)
        if not hit or hit[0] != st.st_mtime:
            raw = f.read_bytes()
            hit = (st.st_mtime, '"%x-%x"' % (int(st.st_mtime), st.st_size), raw,
                   gzip.compress(raw, 9) if f.suffix in (".html", ".css", ".js", ".json", ".svg") else None)
            STATIC_CACHE[f] = hit
        _, tag, raw, gz = hit
        hdr = {"ETag": tag, "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
        ctype = self.guess_type(str(f))
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        if self.headers.get("If-None-Match") == tag:
            return self.send_bytes(304, b"", ctype, hdr)
        if gz and "gzip" in self.headers.get("Accept-Encoding", ""):
            return self.send_bytes(200, gz, ctype, {**hdr, "Content-Encoding": "gzip"})
        return self.send_bytes(200, raw, ctype, hdr)

    def do_HEAD(self):
        return self.do_GET()

    def send_bytes(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if code != 304:
            self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, code, obj, cache="no-store"):
        body = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode()
        extra = {"Cache-Control": cache}
        if len(body) > 4096 and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(body, 5)
            extra["Content-Encoding"] = "gzip"
        self.send_bytes(code, body, "application/json; charset=utf-8", extra)

    def same_origin(self):
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        if origin and urllib.parse.urlsplit(origin).netloc != host:
            return False
        return self.headers.get("Content-Type", "").startswith("application/json")

    def read_body(self):
        # Always drain the body so keep-alive connections stay in sync.
        n = int(self.headers.get("Content-Length") or 0)
        self._body = self.rfile.read(min(n, 256 * 1024)) if n else b""
        if n > 256 * 1024:
            self.close_connection = True

    def read_json(self):
        if len(self._body) >= 256 * 1024:
            raise ValueError("Request too large")
        return json.loads(self._body or b"{}")

    # -- GET ------------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        if not parsed.path.startswith("/api/"):
            return self.serve_static(parsed.path)
        qs = urllib.parse.parse_qs(parsed.query)
        q1 = {k: v[0] for k, v in qs.items()}
        route = parsed.path[len("/api/"):]
        try:
            if route == "portal":
                return self.send_json(200, portal_payload())
            if route == "status":
                return self.send_json(200, get_status())
            if route == "movies":
                MOVIES.ensure_fresh()
                blob = MOVIES.json_bytes()
                if blob is None:
                    return self.send_json(202, MOVIES.status())
                tag = MOVIES.etag()
                hdr = {"ETag": tag, "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
                if self.headers.get("If-None-Match") == tag:
                    return self.send_bytes(304, b"", "application/json", hdr)
                if "gzip" in self.headers.get("Accept-Encoding", ""):
                    return self.send_bytes(200, MOVIES.gzip_bytes(), "application/json; charset=utf-8",
                                           {**hdr, "Content-Encoding": "gzip"})
                return self.send_bytes(200, blob, "application/json; charset=utf-8", hdr)
            if route == "genres":
                GENRES.ensure_fresh()
                res = GENRES.for_library(MOVIES.data)
                if res is None:
                    return self.send_json(202, {"building": GENRES.building, "error": GENRES.error})
                return self.send_json(200, res, cache="no-cache")
            if route == "subs/search":
                # Online subtitles (English + Bangla). host+file let us hash the video for perfect-sync matches.
                url, size = None, None
                if q1.get("host") and q1.get("file"):
                    h = host_info(q1["host"])
                    url = h["base"] + norm_path(q1["file"])
                num = lambda k: int(q1[k]) if q1.get(k, "").isdigit() else None
                try:
                    res = subs.search(q1.get("title", ""), num("year"), num("season"), num("episode"), url, size,
                                      urllib.parse.unquote(q1.get("file", "").rsplit("/", 1)[-1]))
                except (OSError, ValueError) as e:
                    if isinstance(e, ValueError):
                        raise
                    raise UpstreamError(f"OpenSubtitles did not answer ({e.__class__.__name__})") from e
                return self.send_json(200, res)
            if route == "subs/get":
                try:
                    text = subs.download(q1.get("link", ""), q1.get("enc", ""))
                except OSError as e:
                    raise UpstreamError(f"Could not download the subtitle ({e.__class__.__name__})") from e
                return self.send_bytes(200, srt_to_vtt(text).encode(), "text/vtt; charset=utf-8",
                                       {"Cache-Control": "max-age=86400"})
            if route == "history":
                return self.send_json(200, {"items": read_history()})
            if route == "movies/status":
                return self.send_json(200, MOVIES.status())
            if route == "sources":
                doc = read_sources()
                load_registry()
                return self.send_json(200, {"sources": doc.get("sources", []), "errors": REG_INFO["errors"]})
            if route == "detect":
                return self.send_json(200, detect_server(q1.get("url", "")))
            if route == "resolve":
                cands = []
                for v in qs.get("v", []):
                    hid, _, href = v.partition("|")
                    cands.append((hid, norm_path(href)))
                return self.send_json(200, {"candidates": resolve(cands)})

            hid = q1.get("host", "")
            h = host_info(hid)
            href = norm_path(q1.get("href", "/"))
            if not href.startswith("/") or ".." in urllib.parse.unquote(href).split("/"):
                raise ValueError("Bad path")
            if route == "list":
                return self.send_json(200, list_dir(hid, href if href.endswith("/") else href + "/"))
            if route == "search":
                q = q1.get("q", "").strip()
                if not 2 <= len(q) <= 100:
                    raise ValueError("Search needs 2 to 100 characters")
                return self.send_json(200, search_dir(hid, href if href.endswith("/") else href + "/", q))
            if route == "poster":
                path = get_poster(hid, href if href.endswith("/") else href + "/")
                if not path:
                    return self.send_bytes(404, b"", "text/plain", {"Cache-Control": "max-age=3600"})
                ctype = {".png": "image/png", ".webp": "image/webp"}.get(path.suffix, "image/jpeg")
                return self.send_bytes(200, path.read_bytes(), ctype, {"Cache-Control": "max-age=604800"})
            if route == "subtitle":
                if ext_of(href) not in SUB_EXT:
                    raise ValueError("Not a subtitle file")
                _, _, body = http(h["base"] + href, limit=3 * 1024 * 1024)
                try:
                    text = body.decode("utf-8")
                except UnicodeDecodeError:
                    text = body.decode("cp1252", "replace")
                return self.send_bytes(200, srt_to_vtt(text).encode(), "text/vtt; charset=utf-8",
                                       {"Cache-Control": "max-age=86400"})
            if route == "play.m3u":
                title = re.sub(r"[^\w .()-]", "", q1.get("title", "video"))[:80] or "video"
                body = f"#EXTM3U\n#EXTINF:-1,{title}\n{h['base']}{href}\n".encode()
                return self.send_bytes(200, body, "audio/x-mpegurl",
                                       {"Content-Disposition": f'attachment; filename="{title}.m3u"'})
            return self.send_json(404, {"error": "No such API route"})
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})
        except UpstreamError as e:
            return self.send_json(502, {"error": str(e)})

    # -- POST / DELETE (local UI only) ---------------------------------
    def do_POST(self):
        self.read_body()
        if not self.same_origin():
            return self.send_json(403, {"error": "Forbidden"})
        route = urllib.parse.urlsplit(self.path).path
        try:
            if route == "/api/sources":
                entry = add_server(self.read_json())
                after_sources_change()
                return self.send_json(200, {"added": entry})
            if route == "/api/history":
                save_history_item(self.read_json())
                return self.send_json(200, {"ok": True})
            if route == "/api/movies/reindex":
                return self.send_json(200, {"started": MOVIES.start()})
            return self.send_json(404, {"error": "No such API route"})
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})

    def do_DELETE(self):
        self.read_body()
        if not self.same_origin():
            return self.send_json(403, {"error": "Forbidden"})
        parsed = urllib.parse.urlsplit(self.path)
        qid = urllib.parse.parse_qs(parsed.query).get("id", [""])[0]
        if parsed.path == "/api/history":
            delete_history_item(qid)
            return self.send_json(200, {"ok": True})
        if parsed.path != "/api/sources":
            return self.send_json(404, {"error": "No such API route"})
        try:
            remove_server(urllib.parse.parse_qs(parsed.query).get("id", [""])[0])
            after_sources_change()
            return self.send_json(200, {"ok": True})
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--bind", default="127.0.0.1", help="use 0.0.0.0 to reach it from other devices")
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.bind, args.port), Handler)
    threading.Thread(target=lambda: (load_registry(), MOVIES.ensure_fresh(), GENRES.ensure_fresh()), daemon=True).start()

    def autosave():
        while True:
            time.sleep(30)
            if _poster_dirty[0]:
                save_poster_map()
    threading.Thread(target=autosave, daemon=True).start()
    print(f"Chobi running at http://127.0.0.1:{args.port}/", flush=True)
    if args.bind == "0.0.0.0" and not os.environ.get("CHOBI_IN_DOCKER"):
        try:  # the address other devices on your Wi-Fi can use (no packet is sent)
            s = __import__("socket").socket(2, 2)
            s.connect(("172.16.50.4", 80))
            print(f"On your phone/TV (same Wi-Fi): http://{s.getsockname()[0]}:{args.port}/", flush=True)
            s.close()
        except OSError:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if _poster_dirty[0]:
            save_poster_map()


if __name__ == "__main__":
    main()
