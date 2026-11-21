# Chobi

**ছবি**: one fast, simple library for the free BDIX movie servers. Search every server at once, browse with real posters, and play in the browser. If a server is down or a file won't play, Chobi tries the next copy.

```bash
git clone https://github.com/<you>/chobi.git
cd chobi
python3 server.py
```

Then open **http://127.0.0.1:8090/**. You need Python 3.8 or newer and nothing else (on Windows, use `python server.py`). The first start builds the movie index, which takes about 10 seconds.

## Run with Docker

```bash
docker compose up -d
```

Then open **http://localhost:8090/**; phones and TVs on the same Wi-Fi use `http://<this PC's IP>:8090/`. It starts automatically with Docker (`restart: unless-stopped`), so it stays on as long as the PC is on.

- Your server list, movie index, posters, subtitles and watch history live in the `chobi-data` volume, so they survive updates and restarts.
- To update after a `git pull`: `docker compose up -d --build`.
- Logs: `docker compose logs -f`. To stop: `docker compose down` (add `-v` to also delete your data).
- Without Compose: `docker build -t chobi . && docker run -d --name chobi -p 8090:8090 -v chobi-data:/data --restart unless-stopped chobi`.

The container still needs to reach the BDIX servers, so run it on a machine on your BDIX-connected network.

## Watching on your phone, TV or another computer

Chobi has to run on a device inside a network that can reach the BDIX servers (for example, your home Wi-Fi on a BDIX-connected ISP). Other devices then open it in a browser:

```bash
python3 server.py --bind 0.0.0.0
```

It prints an address such as `http://192.168.1.107:8090/`; open that on your phone or smart TV browser. To keep it always on, run it on something that stays powered: an old laptop, a Raspberry Pi, or an Android phone with [Termux](https://termux.dev) (`pkg install python git`, then the same commands).

`--bind 0.0.0.0` has no password, so only use it on your own home network.

### Why not GitHub Pages?

GitHub Pages can host this repository's code, but it can't run Chobi for watching:

1. **No server.** Pages only serves fixed files. Chobi needs `server.py` to read the media servers, build the movie index, make poster thumbnails, find subtitles and remember what you watched.
2. **Browsers block it.** A github.io page is HTTPS, while the BDIX servers are plain HTTP on private addresses (such as 172.16.x.x). Browsers refuse to load HTTP video, posters or listings into an HTTPS page, and block public websites from reaching private-network addresses.
3. **BDIX is local.** The servers are only reachable inside BD ISP networks, so a public page couldn't stream from them anyway.

So the setup is: **code on GitHub, Chobi running on a device at home, and every phone or TV in the house watching through it.**

## What you get

- **Movies:** one search box across every server. It ignores dots, underscores and typos ("dark.knight", "interstelar"). Filter by genre, year, language, category and quality. Rows for latest movies, IMDb Top 250 and more.
- **For you:** *Continue watching* remembers the show, the episode and the minute you stopped at. Suggestions follow the genres you like (default: mostly thriller and action, sometimes comedy and romance; click a genre chip to change it).
- **Subtitles:** press **CC** to search OpenSubtitles for English and Bangla subtitles and apply one with a click. Subtitles made for your exact file are listed first, ad lines are removed, and you can nudge the timing ±0.5 s. You can also add your own `.srt`/`.vtt` file.
- **Player:** seek bar, volume, speed, audio tracks where the browser allows, picture-in-picture, full screen, keyboard shortcuts (space/K, J/L, arrows, F, M, C, 0–9), resume and next episode. Files the browser can't play (HEVC/x265, AC3/DTS audio) open in VLC with one click.
- **Browse:** every folder on every server, including TV series, games and software.
- **Servers:** add any server by domain or IP (h5ai indexes or ordinary Apache/nginx folder listings). Its movies join the same library, and the same movie on two servers becomes two copies of one card.

## Light by design

- The app shell is about 40 KB gzipped (one HTML page, one JS file, one CSS file). It uses no frameworks and no web fonts.
- Posters become ~20 KB thumbnails and load only when they scroll into view. Turn them off with the **Posters** button.
- The movie index (~33,000 files) is about 675 KB gzipped. Repeat visits only revalidate it (~300 bytes).
- Video streams straight from the original server; nothing goes through this app.

## For developers and AI agents

Read **[AGENTS.md](AGENTS.md)**: architecture, rules, API and how to verify changes. Run the tests with `python3 -m unittest discover -s tests`.

## License

[MIT](LICENSE). Free to use, change and share; keep the copyright notice.

*Unofficial. Chobi only reads what the public servers already list.*
