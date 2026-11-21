"""Movie index for Chobi.

Crawls the movie categories on the h5ai servers (category -> year / language
groups -> movie folders), parses clean titles, years, quality and language from
folder names, and stores the result in cache/movies.json. About 250 small
listing requests per full crawl; refreshed at most once a day.
"""

import concurrent.futures
import gzip
import json
import os
import re
import threading
import time
import urllib.parse
from pathlib import Path

CACHE = Path(os.environ.get("CHOBI_DATA") or Path(__file__).resolve().parent) / "cache" / "movies.json"
MAX_AGE = 24 * 3600
WORKERS = 4
MAX_DEPTH = 3

VIDEO_EXT = {"mkv", "mp4", "avi", "m4v", "mov", "wmv", "flv", "webm", "mpg", "mpeg", "ts", "m2ts", "vob", "divx"}

# Category name (lower-case, partial match) -> default language.
CAT_LANG = [
    ("english", "English"),
    ("hindi dubbed", "Hindi Dubbed"),
    ("south", "South Indian"),
    ("hindi", "Hindi"),
    ("bangla", "Bangla"),
    ("satyajit", "Bangla"),
    ("3d", "English"),
    ("animation", "English"),
]
# Short category labels for the filter.
CAT_SHORT = [
    ("english movies 1080p", "English 1080p"),
    ("english", "English"),
    ("hindi dubbed", "South Hindi Dubbed"),
    ("south", "South Indian"),
    ("hindi", "Hindi"),
    ("kolkata", "Kolkata Bangla"),
    ("satyajit", "Kolkata Bangla"),
    ("animation movies 1080p", "Animation 1080p"),
    ("animation", "Animation"),
    ("foreign", "Foreign"),
    ("imdb", "IMDb Top 250"),
    ("3d", "3D"),
]
LANG_WORDS = {
    "malayalam": "Malayalam", "telugu": "Telugu", "tamil": "Tamil", "kannada": "Kannada",
    "marathi": "Marathi", "punjabi": "Punjabi", "gujarati": "Gujarati", "bengali": "Bangla",
    "bangla": "Bangla", "japan": "Japanese", "japanese": "Japanese", "korea": "Korean",
    "korean": "Korean", "china": "Chinese", "chinese": "Chinese", "french": "French",
    "france": "French", "spanish": "Spanish", "spain": "Spanish", "german": "German",
    "germany": "German", "italian": "Italian", "italy": "Italian", "turkish": "Turkish",
    "thai": "Thai", "indonesian": "Indonesian", "persian": "Persian", "iranian": "Persian",
    "russian": "Russian", "danish": "Danish", "swedish": "Swedish", "norwegian": "Norwegian",
    "dutch": "Dutch", "portuguese": "Portuguese", "brazilian": "Portuguese", "polish": "Polish",
    "arabic": "Arabic", "greece": "Greek", "greek": "Greek", "hungary": "Hungarian",
    "hungarian": "Hungarian", "mexico": "Spanish", "argentina": "Spanish", "israel": "Hebrew",
    "czech": "Czech", "finnish": "Finnish", "finland": "Finnish", "taiwan": "Chinese",
    "hong": "Chinese", "philippines": "Filipino", "pakistan": "Urdu", "urdu": "Urdu",
    "nepali": "Nepali", "sinhala": "Sinhala", "odia": "Odia", "bhojpuri": "Bhojpuri", "filipino": "Filipino", "vietnamese": "Vietnamese",
}
QUALITY_RE = re.compile(r"\b(2160p|4k|uhd|1080p|720p|576p|480p|360p|dvdrip|dvdscr|dvd|vcdrip|vcd)\b", re.I)
JUNK_RE = re.compile(
    r"\b(720p|1080p|2160p|480p|4k|web[- ]?dl|webrip|web|hdrip|brrip|bdrip|bluray|blu[- ]ray|dvdrip|dvdscr|"
    r"hdtv|dthrip|hdcam|camrip|x264|x265|hevc|10bit|aac|nf|amzn|hulu|dsnp|remastered|extended|unrated|"
    r"proper|esub|yify|nonretail|retail|dual audio|multi audio)\b.*$", re.I)


def unq(s):
    return urllib.parse.unquote(s)


def short_cat(name):
    n = name.lower()
    for key, label in CAT_SHORT:
        if key in n:
            return label
    return name


def cat_lang(name):
    n = name.lower()
    for key, lang in CAT_LANG:
        if key in n:
            return lang
    return ""


def year_group(name):
    """'(1996)', '2001', '(2026) 1080p', '(1995) & Before' -> (lo, hi) or None."""
    s = re.sub(r"\b(1080p|720p)\b|&\s*before|and\s*before|[()\[\]]", " ", name, flags=re.I).strip()
    m = re.fullmatch(r"((?:19|20)\d\d)(?:\s*-\s*((?:19|20)\d\d))?", s)
    if not m:
        return None
    lo = int(m.group(1))
    hi = int(m.group(2)) if m.group(2) else lo
    if re.search(r"before", name, re.I):
        lo = 0
    return lo, hi


def is_collection(name):
    if re.search(r"\((?:19|20)\d\d\s*-\s*(?:19|20)\d\d\)", name):
        return True
    has_year = re.search(r"\((?:19|20)\d\d\)", name)
    return bool(not has_year and re.search(r"collection|filmography|complete|trilogy|universe|movies", name, re.I))


COMPOUND_RIGHT = {"man", "men", "woman", "women", "fi", "ray", "up", "in", "off", "on", "out", "over",
                  "day", "night", "time", "boy", "girl", "kun", "chan", "san", "ho", "ha", "la", "o"}
COMPOUND_LEFT = {"x", "t", "sci", "hi", "ex", "self", "half", "ultra", "super", "anti", "non", "pre", "re"}


def tidy_title(t):
    t = re.sub(r"\s+", " ", t).strip(" -_.,[](")
    # The servers write "Title-Subtitle" for "Title: Subtitle".
    out, parts = t, t.split("-")
    if len(parts) > 1:
        rebuilt = parts[0]
        for i in range(1, len(parts)):
            left, right = rebuilt, "-".join(parts[i:])
            nxt = parts[i]
            last = left.split("-")[-1]
            compound = (" " not in last and len(last) <= 7 and
                        (nxt.split(" ")[0].lower() in COMPOUND_RIGHT or last.lower() in COMPOUND_LEFT))
            if (" " in last or " " in nxt.strip()) and nxt[:1].strip() and left[-1:].strip() and not compound:
                rebuilt += ": " + nxt
            else:
                rebuilt += "-" + nxt
        out = rebuilt
    return out.strip()


def parse_name(name, is_file=False):
    raw = name
    s = name
    if is_file:
        s = re.sub(r"\.[A-Za-z0-9]{2,4}$", "", s)
    rank = None
    m = re.match(r"^(\d{1,3})\.\s+", s)
    if m:
        rank, s = int(m.group(1)), s[m.end():]
    year = None
    m = re.match(r"^\((\d{4})[^)]*\)\s*", s)  # "(1958) Jalsaghar"
    if m:
        year, s = int(m.group(1)), s[m.end():]
    if s.count(" ") < 2 and re.search(r"[._]", s):
        s = re.sub(r"[._]+", " ", s)
    title = s
    if year is None:
        ys = list(re.finditer(r"\(((?:19|20)\d\d)\)", s))
        if ys:
            year, title = int(ys[-1].group(1)), s[: ys[-1].start()]
        else:
            m = re.search(r"(?<=\S)[\s(\[]((?:19|20)\d\d)(?=[\s)\].]|$)", s)
            if m and m.start() > 0:
                year, title = int(m.group(1)), s[: m.start()]
    title = JUNK_RE.sub("", title)
    title = re.sub(r"\s*[(\[][^)\]]*$", "", title)  # dangling "(Malayalam" etc.
    title = tidy_title(title) or tidy_title(s) or raw

    q = ""
    m = QUALITY_RE.search(raw)
    if m:
        v = m.group(1).lower()
        q = "4K" if v in ("2160p", "4k", "uhd") else v if v in ("1080p", "720p") else "SD"
    tags = []
    if re.search(r"dual[\s.-]?audio", raw, re.I):
        tags.append("Dual Audio")
    if re.search(r"multi[\s.-]?audio", raw, re.I):
        tags.append("Multi Audio")
    if re.search(r"hindi\s*dub", raw, re.I):
        tags.append("Hindi Dubbed")
    if re.search(r"\b3D\b", raw):
        tags.append("3D")
    lang = ""
    tail = raw[len(title):] if raw.startswith(title) else raw
    for w in re.findall(r"[A-Za-z]+", tail):
        if w.lower() in LANG_WORDS:
            lang = LANG_WORDS[w.lower()]
            break
    return {"t": title, "y": year, "q": q, "tags": tags, "lang": lang, "rank": rank}


class MovieIndex:
    def __init__(self, list_fn, portal_fn):
        self.list_fn, self.portal_fn = list_fn, portal_fn
        self.lock = threading.Lock()
        self.data = None
        self.building = False
        self.progress = {"done": 0, "queued": 0, "errors": []}
        self.blob = None  # cached JSON bytes
        self.gz = None
        if CACHE.exists():
            try:
                self.data = json.loads(CACHE.read_text())
                self.blob = None
            except (OSError, ValueError):
                self.data = None

    def status(self):
        d = self.data or {}
        return {"ready": self.data is not None, "building": self.building,
                "built": d.get("built"), "count": len(d.get("movies", [])), **self.progress}

    def ensure_fresh(self):
        stale = not self.data or time.time() - self.data.get("built", 0) / 1000 > MAX_AGE
        if stale:
            self.start()

    def start(self):
        with self.lock:
            if self.building:
                return False
            self.building = True
        threading.Thread(target=self._build, daemon=True).start()
        return True

    def etag(self):
        return f'"m{self.data["built"]}"' if self.data else None

    def json_bytes(self):
        """Compact payload for the browser: one array per movie, shared tables for
        languages and tags, paths relative to their category, dates in days."""
        if self.data is None:
            return None
        if self.blob is None:
            cats = self.data["cats"]
            langs, lang_ix, tags, tag_ix = [], {}, [], {}
            rows = []
            for r in self.data["movies"]:
                l = r.get("l") or ""
                if l not in lang_ix:
                    lang_ix[l] = len(langs)
                    langs.append(l)
                bits = 0
                for t in r.get("g") or []:
                    if t not in tag_ix:
                        tag_ix[t] = len(tags)
                        tags.append(t)
                    bits |= 1 << tag_ix[t]
                base = cats[r["c"]]["href"]
                h = r["h"][len(base):] if r["h"].startswith(base) else r["h"]
                row = [r["t"], r.get("y") or 0, r.get("q") or "", lang_ix[l], r["c"], h,
                       int((r.get("m") or 0) / 86400000), bits, r.get("r") or 0, r.get("k") or "",
                       1 if r.get("f") else 0, r.get("s") or 0]
                while row and row[-1] in (0, ""):  # trailing defaults are implied
                    row.pop()
                rows.append(row)
            payload = {"v": 2, "built": self.data["built"], "cats": cats, "langs": langs, "tags": tags,
                       "cols": ["t", "y", "q", "l", "c", "h", "d", "g", "r", "k", "f", "s"], "rows": rows}
            self.blob = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
        return self.blob

    def gzip_bytes(self):
        if self.gz is None:
            self.gz = gzip.compress(self.json_bytes(), 6)
        return self.gz

    # -- crawl -----------------------------------------------------------
    def _build(self):
        try:
            cats, seen_roots = [], set()
            for c in self.portal_fn():  # [{name, host, href, section}]
                key = (c["host"], c["href"])
                if key in seen_roots:
                    continue
                seen_roots.add(key)
                cats.append({"name": c["name"], "short": short_cat(c["name"]), "host": c["host"],
                             "href": c["href"], "source": c.get("source", "")})

            movies, seen = [], set()
            self.progress = {"done": 0, "queued": len(cats), "errors": []}
            # Work items: (cat_index, href, depth, ctx)
            level = [(i, c["href"], 0, {}) for i, c in enumerate(cats)]
            with concurrent.futures.ThreadPoolExecutor(WORKERS) as ex:
                while level:
                    results = list(ex.map(lambda w: (w, self._safe_list(cats[w[0]]["host"], w[1])), level))
                    nxt = []
                    for (ci, href, depth, ctx), items in results:
                        self.progress["done"] += 1
                        if items is None:
                            self.progress["errors"].append(f"{cats[ci]['host']}{unq(href)}")
                            self._carry_over(cats[ci], ci, href, movies, seen)
                            continue
                        nxt += self._classify(cats, ci, items, depth, ctx, movies, seen)
                    self.progress["queued"] += len(nxt)
                    level = nxt

            data = {"built": int(time.time() * 1000), "cats": cats, "movies": movies}
            CACHE.parent.mkdir(exist_ok=True)
            tmp = CACHE.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
            tmp.replace(CACHE)
            self.data, self.blob, self.gz = data, None, None
        finally:
            self.building = False

    def _safe_list(self, host, href):
        for attempt in range(2):  # one retry: these servers sometimes drop a request
            try:
                return self.list_fn(host, href)["items"]
            except Exception:  # noqa: BLE001 - one bad folder must not stop the crawl
                if attempt == 0:
                    time.sleep(1.5)
        return None

    def _carry_over(self, cat, ci, href, movies, seen):
        """A folder failed twice: keep what the previous index had under it."""
        old = self.data or {}
        old_cats = old.get("cats", [])
        for m in old.get("movies", []):
            oc = old_cats[m["c"]] if m["c"] < len(old_cats) else None
            if oc and oc["host"] == cat["host"] and m["h"].startswith(href) and (cat["host"], m["h"]) not in seen:
                seen.add((cat["host"], m["h"]))
                movies.append({**m, "c": ci})

    def _classify(self, cats, ci, items, depth, ctx, movies, seen):
        cat = cats[ci]
        nxt = []
        for it in items:
            href = it["href"]
            is_dir = href.endswith("/")
            name = unq(href.rstrip("/").split("/")[-1])
            if not is_dir:
                ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                if ext in VIDEO_EXT and depth > 0 or (ext in VIDEO_EXT and depth == 0):
                    self._add(cat, ci, href, name, it, ctx, movies, seen, is_file=True)
                continue
            yg = year_group(name)
            if yg and depth < MAX_DEPTH:
                nxt.append((ci, href, depth + 1, {**ctx, "yr": yg}))
                continue
            plain = not re.search(r"(?:19|20)\d\d", name) and not QUALITY_RE.search(name)
            if depth < MAX_DEPTH and is_collection(name) and not (depth == 0 and plain):
                c = dict(ctx)
                c["coll"] = tidy_title(re.sub(r"\(.*$", "", name))
                nxt.append((ci, href, depth + 1, c))
                continue
            if depth == 0 and plain:
                # e.g. "Japanese Language", "Satyajit Ray Films"
                label = re.sub(r"\s+(language|movies?)$", "", name, flags=re.I).strip()
                c = dict(ctx)
                lw = label.lower().split()[0] if label else ""
                if "dubbing" in label.lower():
                    c["lang"] = label.split()[0] + " Dubbed"
                elif lw in LANG_WORDS:
                    c["lang"] = LANG_WORDS[lw]
                c["group"] = label
                nxt.append((ci, href, depth + 1, c))
                continue
            self._add(cat, ci, href, name, it, ctx, movies, seen, is_file=False)
        return nxt

    def _add(self, cat, ci, href, name, it, ctx, movies, seen, is_file):
        key = (cat["host"], href)
        if key in seen:
            return
        seen.add(key)
        p = parse_name(name, is_file)
        year = p["y"]
        yr = ctx.get("yr")
        if year is None and yr and yr[0] == yr[1]:
            year = yr[0]
        lang = p["lang"] or ctx.get("lang") or cat_lang(cat["name"])
        if "Hindi Dubbed" in p["tags"] and not p["lang"]:
            lang = "Hindi Dubbed" if "dubbed" in cat["name"].lower() else lang
        row = {"t": p["t"], "y": year, "q": p["q"], "l": lang, "c": ci, "h": href,
               "m": it.get("time")}
        if p["tags"]:
            row["g"] = p["tags"]
        if p["rank"] and "imdb" in cat["name"].lower():
            row["r"] = p["rank"]
        if ctx.get("coll"):
            row["k"] = ctx["coll"]
        if is_file:
            row["f"] = 1
            row["s"] = it.get("size")
        movies.append(row)
