"""Genre lookup for suggestions.

The media servers only have folder names, so genres come from Wikidata (free, no
account): one query per genre, about 700 KB in total, cached in
cache/genres.json and refreshed every 30 days. Titles are matched to the movie
index by normalised title and year (+/- 1).

Only generic genre queries are sent; nothing about the user or their library.
"""

import csv
import io
import json
import re
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

CACHE = Path(__file__).resolve().parent / "cache" / "genres.json"
MAX_AGE = 30 * 24 * 3600
ENDPOINT = "https://query.wikidata.org/sparql"
UA = "Chobi/2.0 (local media front end; genre lookup)"
# Genre name -> Wikidata item for the film genre (direct subgenres are included).
GENRES = {
    "Thriller": "Q2484376",
    "Action": "Q188473",
    "Comedy": "Q157443",
    "Romance": "Q1054574",
}
QUERY = ('SELECT DISTINCT ?l ?y WHERE {{ ?f wdt:P31 wd:Q11424; wdt:P136/wdt:P279? wd:{qid}; wdt:P577 ?d. '
         '?f rdfs:label ?l. FILTER(LANG(?l)="en") BIND(YEAR(?d) AS ?y) FILTER(?y >= 1940) }}')


def norm(s):
    """Must match DFX norm() in static/js/core.js."""
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower().replace("&", " and ")
    s = re.sub(r"['’`]", "", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


class Genres:
    def __init__(self):
        self.data = None
        self.building = False
        self.error = ""
        self.lock = threading.Lock()
        self.matched = (None, None)  # (cache key, result)
        try:
            self.data = json.loads(CACHE.read_text())
        except (OSError, ValueError):
            self.data = None

    def ensure_fresh(self):
        if not self.data or time.time() - self.data.get("built", 0) / 1000 > MAX_AGE:
            self.start()

    def start(self):
        with self.lock:
            if self.building:
                return
            self.building = True
        threading.Thread(target=self._build, daemon=True).start()

    def _fetch(self, qid):
        url = ENDPOINT + "?" + urllib.parse.urlencode({"query": QUERY.format(qid=qid)})
        req = urllib.request.Request(url, headers={"Accept": "text/csv", "User-Agent": UA,
                                                   "Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=150) as r:
            body = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                import gzip
                body = gzip.decompress(body)
        rows = set()
        for row in csv.DictReader(io.StringIO(body.decode("utf-8", "replace"))):
            try:
                rows.add((norm(row["l"]), int(row["y"])))
            except (KeyError, ValueError):
                continue
        return sorted(rows)

    def _build(self):
        try:
            old = (self.data or {}).get("genres", {})
            out = {}
            for name, qid in GENRES.items():
                try:
                    out[name] = self._fetch(qid)
                except Exception as e:  # noqa: BLE001 - keep older data for this genre
                    self.error = f"{name}: {e.__class__.__name__}"
                    if name in old:
                        out[name] = old[name]
            if out:
                self.data = {"built": int(time.time() * 1000), "genres": out}
                CACHE.parent.mkdir(exist_ok=True)
                tmp = CACHE.with_suffix(".tmp")
                tmp.write_text(json.dumps(self.data, separators=(",", ":")))
                tmp.replace(CACHE)
                self.matched = (None, None)
        finally:
            self.building = False

    def for_library(self, movies):
        """{genre: ["normtitle|year", ...]} limited to movies in the library (client group keys)."""
        if not self.data or not movies:
            return None
        key = (self.data["built"], movies.get("built"))
        if self.matched[0] == key:
            return self.matched[1]
        lib = {}
        for m in movies["movies"]:
            lib.setdefault(norm(m["t"]), set()).add(m.get("y") or 0)
        result = {}
        for name, rows in self.data["genres"].items():
            hits = set()
            for n, y in rows:
                ys = lib.get(n)
                if not ys:
                    continue
                for yy in (y, y - 1, y + 1):
                    if yy in ys:
                        hits.add(f"{n}|{yy}")
                        break
            result[name] = sorted(hits)
        out = {"built": self.data["built"], "genres": result}
        self.matched = (key, out)
        return out
