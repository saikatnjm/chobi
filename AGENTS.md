# AGENTS.md — working on Chobi

This is the single source of truth for AI coding agents (Claude Code, Codex, Gemini CLI, Copilot, Cursor, Aider, …) and for humans. `CLAUDE.md`, `GEMINI.md` and `.github/copilot-instructions.md` only point here, so keep everything in this file.

## What Chobi is

Chobi (ছবি, "picture/movie" in Bangla) is a small local web app for the free BDIX FTP/media servers in Bangladesh. It puts the movies from many servers into one fast, searchable library with posters, plays them in a YouTube-style browser player, and falls back to another copy when a server is down or a format won't play.

- Runs locally: `python3 server.py`, then open http://127.0.0.1:8090/. Use `--bind 0.0.0.0` so phones and TVs on the same Wi-Fi can use it.
- It **cannot** be a static site (GitHub Pages and similar): it needs `server.py`, and browsers block HTTP/private-network media from HTTPS pages. Don't try to make the UI work without the local server.
- The owner is on a slow connection (about 7.7 Mbps down, with upload bufferbloat). **Keep it lightweight and fast.** That is the main product requirement.
- The owner does **not** control the media servers. Never change or write to them; the app only reads public listings.
- The owner asked for **simple, no extra features**. Don't add features nobody asked for.

## Hard rules

1. **No dependencies.** Python 3.8+ standard library only, plus vanilla JS/CSS with no npm, no build tools and no frameworks. Pillow and ffmpeg are optional (used for poster thumbnails if present) and must stay optional.
2. **Never proxy video.** Video and download links point straight at the original server URL. The local server only forwards small JSON listings, poster thumbnails and subtitles.
3. **Stay light.** The app shell is currently ~40 KB gzipped in 3 requests (HTML, `app.js`, `app.min.css`). Check sizes after changes (see Verify). No web fonts, no CDNs, no images in the UI (icons are an inline SVG sprite).
4. **Be gentle with the servers.** Cache listings (`list_cache`), crawl with a small worker pool (`movies.WORKERS = 4`), and rebuild the index at most once a day.
5. **Local only.** The server binds to 127.0.0.1 by default. Mutating endpoints (POST/DELETE) require `Content-Type: application/json` and a same-origin `Origin`, so other websites can't drive them. Keep that.
6. **Privacy.** Watch history stays in `cache/history.json` on this machine. The only internet requests are the anonymous Wikidata genre query (`genres.py`) and, when the user opens the subtitle panel, an OpenSubtitles.org search with the title/year/episode and the file's OpenSubtitles hash (`subs.py`). Don't add analytics or other third-party calls.
7. **Paths:** h5ai expects rawurlencode-style paths. Always pass paths through `norm_path()` (server) and keep hrefs encoded end to end; decode only for display (`D.dec`).

## Layout

```
server.py        HTTP server + API, server registry (sources.json), adapters, posters, playback resolve
movies.py        Movie index crawler + title/year/quality/language parser (cache/movies.json)
genres.py        Genre lookup from Wikidata, matched to the index (cache/genres.json)
subs.py          Online subtitles (English + Bangla) from OpenSubtitles.org: search, hash match, download, ad cleanup
sources.json     Servers to use (edited by the Servers page or by hand)
static/
  index.html     Shell + inline SVG icon sprite
  app.css        All styles (served minified as /app.min.css)
  js/            Modules, served concatenated + minified as /app.js, in JS_ORDER (server.py)
    core.js      Shared helpers on window.CHOBI: api(), store, norm(), history, genres, episodeInfo()
    movies.js    Movies page: search, filters, Netflix-style rows, poster grid, detail sheet
    foryou.js    For you: Continue watching + genre-weighted suggestions
    player.js    Video player: controls, subtitles (server + your own file), audio, fallback, resume, next episode
    browse.js    Browse any folder on any server (TV series, games, software)
    servers.js   Add/remove servers, rebuild index
    main.js      Hash router, theme, global shortcuts (loaded last)
cache/           Generated: movies.json, genres.json, history.json, thumbs/, subs/ (safe to delete)
tests/           python3 -m unittest discover -s tests
```

## How it works

**Servers (`sources.json`, `load_registry()`):** each source becomes categories `{section, name, host, href}`. A *host id* is a short string: the last octet for 172.16.50.x (e.g. `7`), otherwise `<source-id>-<n>`. Types:
- `dhakaflix`: parses the portal page (`portal` URL) for category links; the hosts behind it are h5ai.
- `h5ai`: listings via `POST /_h5ai/public/index.php` (`action=get&items[href]=…&items[what]=1`); server-side search via `search[pattern]`.
- `autoindex`: plain Apache/nginx/lighttpd/Python HTML listings, parsed by `parse_autoindex()`.

**Movie index (`movies.py`):** crawls only categories in section `Movies`. Folder rules (`_classify`): year groups like `(1995)`, `2001`, `(1995) & Before` recurse; collections (`(1962-2015)`, "Collection", "Filmography") recurse; plain names at the top of a category (e.g. "Japanese Language") recurse as language/sub groups; anything else is a movie. `parse_name()` turns `Ace Ventura-When Nature Calls (1995) 720p [Dual Audio]` into title/year/quality/tags/language. A full crawl of DhakaFlix is ~240 requests and ~10 s. If a folder fails twice, the previous index's entries for it are kept.

**Payload to the browser:** `/api/movies` sends compact rows (`MovieIndex.json_bytes()`, documented in `movies.js expand()`), gzipped, with an ETag, so a repeat visit is a ~300-byte 304.

**Grouping & search (client, `movies.js`):** rows group by `norm(title)|year` (the same movie in 720p and 1080p, or on two servers, becomes one card with several *copies*). Search tokens ignore case, accents, dots and underscores, also match year and quality tokens, and fall back to edit-distance-1 fuzzy matching when nothing matches. `D.norm()` (JS) and `genres.norm()` (Python) **must stay identical**.

**Playback:** `#/watch?t=<title>&v=<host>|<href>&v=…&k=<groupKey>`. The player calls `/api/resolve`, which lists each copy's folder, picks the largest video file and range-checks copies in order until one answers. On a decode/network error or a 20 s stall the player tries the next copy (wrapping around). Browsers can't play HEVC/x265 or AC3/DTS audio, so the player detects that and offers VLC (`/api/play.m3u`). Copy order (`movies.playOrder`): online hosts first, then x264 before HEVC when the browser lacks HEVC, then the preferred quality (default 720p).

**Subtitles:** the CC button opens the subtitle panel (`player.js renderSubs`). It holds:
- the loaded tracks, with a ±0.5 s timing nudge that shifts the active track's cues;
- online search, run automatically on open;
- "Add file from computer" (also drag-and-drop; converted in the browser, never uploaded).

`.srt`/`.vtt` files next to the video load via `/api/subtitle` (SRT→VTT on the server).

Online search (`subs.py`) uses the keyless legacy REST API `rest.opensubtitles.org/search/…` with `X-User-Agent: TemporaryUserAgent`. Path parameters must be in alphabetical order (`episode-`, `imdbid-`, `moviebytesize-`, `moviehash-`, `query-`, `season-`, `sublanguageid-`), and only one language per request (`eng`, `ben`). For each language it runs three steps:
1. A hash search: the OpenSubtitles hash needs only two 64 KB range reads from the BDIX server. These results are marked "Perfect sync".
2. A title search filtered by name and year (or season/episode).
3. A follow-up search by that movie's IMDb id.

Results whose name matches the video's release name are marked "Made for this file" and listed first. Downloads only come from `dl.opensubtitles.org` (gzipped SRT); ad cues and `<font>` tags are stripped, and files are cached in `cache/subs/`. `api.opensubtitles.com` is blocked by some BD ISPs (court-order page), and podnapisi.net was unreachable, so neither is used. **Audio tracks:** only browsers with `video.audioTracks` (Safari) can switch; elsewhere the menu explains this and offers VLC.

**Posters:** `/api/poster?host&href=<folder>` picks the smallest real image in the folder, makes a 300 px WebP/JPEG thumbnail (Pillow, else ffmpeg, else the original), and caches it in `cache/thumbs/`. The client loads posters only near the viewport (IntersectionObserver in `movies.js`). Bump the `v:` query param in the poster URLs if the thumbnail format changes.

**History & suggestions:** the player saves progress every 15 s, on pause and on close (`POST /api/history`). Episodes are detected from `S01E05`-style names (`D.episodeInfo`), and when one ends the player offers the next file in the folder. Suggestions score movies by the genre weights in the For you chips (default Thriller and Action "mostly", Comedy and Romance "sometimes"), plus small boosts for IMDb Top 250, recent years and 1080p, with a daily shuffle.

## API (all GET unless noted)

| Route | Purpose |
|---|---|
| `/api/portal` | Categories by section + host map |
| `/api/status` | Ping each host (cached 60 s) |
| `/api/list?host&href` | One folder (cached 3 min) |
| `/api/search?host&href&q` | h5ai recursive search |
| `/api/movies` · `/api/movies/status` · POST `/api/movies/reindex` | Movie index |
| `/api/genres` | `{genre: [groupKey…]}` for the library |
| `/api/poster?host&href` | Poster thumbnail for a folder |
| `/api/resolve?v=host\|href…` | Find and test playable files |
| `/api/subtitle?host&href` | Subtitle file from the media server as WebVTT |
| `/api/subs/search?title&year&season&episode&host&file` | Online subtitles, English + Bangla |
| `/api/subs/get?link&enc` | Download one online subtitle as WebVTT |
| `/api/play.m3u?host&href&title` | Playlist file for VLC |
| `/api/history` · POST · DELETE `?id=` | Continue watching |
| `/api/sources` · POST · DELETE `?id=` · `/api/detect?url=` | Manage servers |

## Adding a server

Easiest: open **Servers**, paste an address (domain or IP), press **Check**, tick folders and choose sections, then **Add**. By hand, append to `sources.json`:

```json
{ "id": "myserver", "name": "My Server", "type": "autoindex",
  "categories": [ { "section": "Movies", "name": "English Movies", "url": "http://10.0.0.10/Movies/English/" } ] }
```

Then **Rebuild now** on the Servers page (or `POST /api/movies/reindex`). A new server type needs an adapter branch in `list_dir()` (and `ping()`, `detect_server()`).

## Verify before you finish

```bash
python3 -m unittest discover -s tests
python3 server.py --port 8091   # in another terminal, then:
curl -s localhost:8091/app.js -o /tmp/chobi-app.js && node --check /tmp/chobi-app.js   # bundle must parse
curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}\n' localhost:8091/app.js   # keep app.js under ~32 KB gz
```

Then open the app and check: Movies search ("dark.knight", "interstelar"), a detail sheet, Play (Heat 1995 720p plays in Chrome), the CC panel (Heat 1995 has 40+ English and 1 Bangla result), For you, Browse, Servers. Check the browser console for errors. Use dark and light themes, and a phone-width window.

## Style

- JS: modern vanilla, IIFE per file, helpers from `window.CHOBI` (`const D = window.CHOBI`). Escape everything put into HTML with `D.esc`. Wrap storage access in `D.store`.
- CSS: tokens on `:root`, a dark theme via `prefers-color-scheme` and `[data-theme]`, one accent colour (`--accent`), generous spacing.
- Python: standard library only, small functions; upstream failures raise `UpstreamError` and become HTTP 502 JSON.
- Comments explain *why*, not what.
