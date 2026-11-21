/* Full-screen video player with YouTube-style controls and automatic server fallback.
   Video bytes come straight from the original server; only subtitles go through /api/subtitle. */
(() => {
  'use strict';
  const D = window.CHOBI;
  const { $, esc, icon, store } = D;
  const root = $('#player');
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const P = (D.player = { open, close, isOpen: () => !root.hidden });

  let v, st = null, hideTm, stallTm, saveTm, audioTm;

  function buildDom() {
    root.innerHTML = `
      <div class="pl-stage">
        <video playsinline preload="metadata"></video>
        <div class="pl-center" aria-hidden="true"><span class="pl-bigbtn">${icon('play')}</span></div>
        <div class="pl-flash" aria-hidden="true"></div>
        <div class="pl-msg" hidden></div>
        <div class="pl-top">
          <button type="button" class="pl-btn" data-a="close" title="Back (Esc)" aria-label="Back">${icon('back')}</button>
          <div class="pl-title"><div class="pl-name"></div><div class="pl-src"></div></div>
        </div>
        <div class="pl-bottom">
          <div class="pl-seek" role="slider" aria-label="Seek" tabindex="0">
            <div class="pl-rail"><div class="pl-buf"></div><div class="pl-played"></div><div class="pl-hover"></div></div>
            <div class="pl-knob"></div><div class="pl-tip"></div>
          </div>
          <div class="pl-row">
            <button type="button" class="pl-btn" data-a="toggle" aria-label="Play (k)" title="Play (k)">${icon('play')}</button>
            <button type="button" class="pl-btn" data-a="rew" aria-label="Back 10 seconds (j)" title="Back 10 s (j)">${icon('rew')}</button>
            <button type="button" class="pl-btn" data-a="fwd" aria-label="Forward 10 seconds (l)" title="Forward 10 s (l)">${icon('fwd')}</button>
            <div class="pl-vol">
              <button type="button" class="pl-btn" data-a="mute" aria-label="Mute (m)" title="Mute (m)">${icon('vol')}</button>
              <input type="range" class="pl-volr" min="0" max="1" step="0.05" aria-label="Volume">
            </div>
            <div class="pl-time"><span class="pl-cur">0:00</span> / <span class="pl-dur">0:00</span></div>
            <div class="pl-spacer"></div>
            <button type="button" class="pl-btn" data-a="cc" aria-label="Subtitles (c)" title="Subtitles (c)">${icon('cc')}</button>
            <button type="button" class="pl-btn" data-a="menu" aria-label="Settings" title="Speed, source and subtitles">${icon('gear')}</button>
            <button type="button" class="pl-btn" data-a="pip" aria-label="Picture in picture" title="Picture in picture">${icon('pip')}</button>
            <button type="button" class="pl-btn" data-a="full" aria-label="Full screen (f)" title="Full screen (f)">${icon('full')}</button>
          </div>
        </div>
        <div class="pl-menu" hidden></div>
        <div class="pl-subs" hidden role="dialog" aria-label="Subtitles"></div>
        <input type="file" class="pl-subfile" accept=".srt,.vtt,text/vtt" hidden>
      </div>`;
    v = $('video', root);
    v.volume = store.get('vol', 1);
    v.muted = store.get('muted', false);
    $('.pl-volr', root).value = v.muted ? 0 : v.volume;

    v.addEventListener('play', syncPlay);
    v.addEventListener('pause', syncPlay);
    v.addEventListener('timeupdate', syncTime);
    v.addEventListener('progress', syncBuf);
    v.addEventListener('durationchange', syncTime);
    v.addEventListener('volumechange', syncVol);
    v.addEventListener('waiting', () => root.classList.add('buffering'));
    v.addEventListener('playing', () => { root.classList.remove('buffering'); clearTimeout(stallTm); checkAudio(); });
    v.addEventListener('canplay', () => root.classList.remove('buffering'));
    v.addEventListener('loadeddata', onLoaded);
    v.addEventListener('error', onError);
    v.addEventListener('ended', () => { showUi(true); upNext(); });
    v.addEventListener('pause', () => saveProgress());
    v.addEventListener('click', () => toggle());
    v.addEventListener('dblclick', () => fullscreen());

    root.addEventListener('click', onClick);
    root.addEventListener('mousemove', showUi);
    root.addEventListener('touchstart', showUi, { passive: true });
    $('.pl-volr', root).addEventListener('input', (e) => { v.volume = +e.target.value; v.muted = v.volume === 0; });
    setupSeek();
    root.addEventListener('submit', (e) => {
      if (!e.target.matches('[data-subsform]')) return;
      e.preventDefault();
      const f = e.target;
      st.subs.title = f.q.value.trim();
      if (f.y) st.subs.year = f.y.value.trim();
      if (f.se) { const m = /S?(\d+)\D*E?(\d+)/i.exec(f.se.value); if (m) { st.subs.season = +m[1]; st.subs.episode = +m[2]; } }
      searchSubs();
    });
    $('.pl-subfile', root).addEventListener('change', (e) => { if (e.target.files[0]) addSubFile(e.target.files[0]); e.target.value = ''; });
    const stage = $('.pl-stage', root);
    stage.addEventListener('dragover', (e) => { e.preventDefault(); });
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f && /\.(srt|vtt)$/i.test(f.name)) addSubFile(f); else if (f) D.toast('Drop a .srt or .vtt subtitle file');
    });
    document.addEventListener('fullscreenchange', () => {
      $('[data-a="full"]', root).innerHTML = icon(document.fullscreenElement ? 'unfull' : 'full');
    });
  }

  /* ------------------------------------------------------------- open */
  async function open(title, cands, key) {
    if (!v) buildDom();
    if (st) saveProgress();
    root.hidden = false;
    document.body.classList.add('noscroll');
    const epi = D.episodeInfo(cands[0].href);
    if (epi && /\.[a-z0-9]{2,4}$/i.test(title)) title = `${epi.show} · ${epi.ep}`;
    st = { title, key, cands: [], i: -1, failed: [], subOn: store.get('subs', false), resumed: false };
    $('.pl-name', root).textContent = title;
    $('.pl-src', root).textContent = 'Finding a server that responds…';
    message(`<span class="spinner lg"></span><div>Finding a working copy…</div>`);
    root.classList.add('buffering');
    showUi();
    const p = new URLSearchParams();
    cands.forEach((c) => p.append('v', `${c.host}|${c.href}`));
    try {
      const r = await D.api('resolve', p);
      if (!st) return;
      st.cands = r.candidates.filter((c) => c.url);
      st.failed = r.candidates.filter((c) => !c.url);
      let start = st.cands.findIndex((c) => c.ok);
      if (start < 0) {
        // Nothing answered the quick check; still try them in order.
        start = 0;
      }
      if (!st.cands.length) return failAll('None of the servers holding this movie answered.');
      st.cands.slice(0, start).forEach((c) => { c.skip = c.error || 'did not answer'; });
      tryIndex(start);
    } catch (e) {
      failAll(e.message);
    }
  }

  function tryIndex(i) {
    clearTimeout(stallTm); clearTimeout(audioTm);
    if (!st) return;
    while (i < st.cands.length && st.cands[i].skip) i++;
    if (i >= st.cands.length) return failAll();
    st.i = i;
    const c = st.cands[i];
    message('');
    root.classList.add('buffering');
    $('.pl-src', root).textContent = srcLabel(c) + (i > 0 ? ` · copy ${i + 1} of ${st.cands.length}` : '');
    // Reset tracks (your own subtitle files are kept)
    v.querySelectorAll('track').forEach((t) => { if (!t.src.startsWith('blob:')) t.remove(); });
    (c.subs || []).forEach((href, k) => {
      const t = document.createElement('track');
      t.kind = 'subtitles';
      t.label = D.baseName(href).replace(/\.(srt|vtt)$/i, '');
      t.srclang = /bangla|bengali|\bbn\b/i.test(href) ? 'bn' : 'en';
      t.src = `/api/subtitle?${new URLSearchParams({ host: c.host, href })}`;
      if (k === 0 && st.subOn) t.default = true;
      v.appendChild(t);
    });
    v.src = c.url;
    v.load();
    v.play().catch(() => { /* autoplay may be blocked; user can press play */ });
    syncCc();
    // A server that accepts the connection but sends nothing: move on.
    stallTm = setTimeout(() => { if (v.readyState < 2) next('stopped responding'); }, 20000);
  }

  function srcLabel(c) {
    const q = (/\b(2160p|1080p|720p|480p)\b/i.exec(D.dec(c.file || '')) || [])[1];
    return [q, c.source, D.hostLabel(c.host), D.fmtSize(c.size)].filter(Boolean).join(' · ');
  }

  function onLoaded() {
    clearTimeout(stallTm);
    root.classList.remove('buffering');
    if (v.videoWidth === 0 && v.videoHeight === 0 && v.duration > 60) {
      // Audio played but the browser can't decode the picture (often HEVC/x265).
      return next("the browser can't decode this video format");
    }
    const h = D.history.find((x) => x.url === v.currentSrc);
    const saved = (h && h.pos) || store.get('pos:' + v.currentSrc, 0);
    if (!st.resumed && saved > 60 && v.duration && saved < v.duration - 90) {
      v.currentTime = saved;
      st.resumed = true;
      D.toast(`Resumed at ${D.fmtTime(saved)}. Press 0 to start over.`, 3500);
    }
    clearInterval(saveTm);
    saveTm = setInterval(() => { if (!v.paused && v.currentTime > 30) saveProgress(); }, 15000);
  }

  /* Continue watching: remember the file, position and (for episodes) the show. */
  function saveProgress(extra) {
    if (!st || st.i < 0 || !v.currentSrc || !isFinite(v.duration) || v.currentTime < 20) return;
    const c = st.cands[st.i];
    const ep = D.episodeInfo(c.file || '');
    store.set('pos:' + v.currentSrc, Math.floor(v.currentTime));
    D.saveHistory({
      id: c.url, url: c.url, host: c.host, file: c.file, key: st.key || '',
      title: ep ? ep.show : st.title, show: ep ? ep.show : '', ep: ep ? ep.ep : '',
      poster: { host: c.host, href: D.posterFolder(c.file) },
      pos: Math.floor(v.currentTime), dur: Math.floor(v.duration), ...(extra || {}),
    });
  }

  /* When an episode ends, offer the next file in the same folder. */
  async function upNext() {
    const c = st && st.cands[st.i];
    if (!c || !D.episodeInfo(c.file)) return saveProgress();
    let nxt = null;
    try {
      const folder = c.file.replace(/[^/]+$/, '');
      const L = await D.api('list', { host: c.host, href: folder });
      const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      const vids = L.items.filter((it) => D.typeOf(it.href) === 'video').sort((a, b) => coll.compare(a.href, b.href));
      const i = vids.findIndex((x) => x.href === c.file);
      if (i >= 0 && vids[i + 1]) nxt = vids[i + 1].href;
    } catch (e) { /* ignore */ }
    const info = nxt && D.episodeInfo(nxt);
    saveProgress(nxt ? { next: { host: c.host, file: nxt, ep: info ? info.ep : D.baseName(nxt) } } : {});
    if (!nxt || !st) return;
    message(`<div class="pl-note">Up next: <b>${esc(info ? info.ep : D.baseName(nxt))}</b>
      <a class="btn sm" href="${esc(D.watchHash(info ? info.show : st.title, [{ host: c.host, href: nxt }]))}" data-replace>${icon('play')}Play next episode</a>
      <button type="button" class="btn sm ghost" data-a="dismiss">Close</button></div>`, true);
  }

  function onError() {
    if (!st || !v.getAttribute('src')) return;
    const code = v.error ? v.error.code : 0;
    const why = code === 4 || code === 3 ? "the browser can't play this file's format" : code === 2 ? 'the connection failed' : 'it could not be played';
    next(why);
  }

  function next(why) {
    if (!st) return;
    const c = st.cands[st.i];
    if (c) c.skip = why;
    // Next untried copy after this one, wrapping around to earlier copies.
    const n = st.cands.length;
    let j = -1;
    for (let k = 1; k < n; k++) { const x = (st.i + k) % n; if (!st.cands[x].skip) { j = x; break; } }
    if (j < 0) return failAll();
    D.toast(`Copy ${st.i + 1}: ${why}. Trying copy ${j + 1}…`, 3000);
    tryIndex(j);
  }

  function failAll(msg) {
    clearTimeout(stallTm);
    if (v) v.pause();
    root.classList.remove('buffering');
    if (!st) return;
    const any = st.cands[0];
    const reasons = st.cands.map((c, i) => `<li>Copy ${i + 1} (${esc(D.hostLabel(c.host))}): ${esc(c.skip || 'not tried')}</li>`).join('')
      + st.failed.map((c) => `<li>${esc(D.hostLabel(c.host))}: ${esc(c.error || 'unavailable')}</li>`).join('');
    const formatIssue = st.cands.some((c) => /format|decode/.test(c.skip || ''));
    message(`<div class="pl-fail">
      <h3>${formatIssue ? 'This file needs a different player' : 'Could not play this movie'}</h3>
      <p>${esc(msg || (formatIssue ? 'Browsers can’t play some formats used on these servers (usually HEVC/x265 video or AC3/DTS audio). VLC plays all of them.' : 'Every copy failed. The servers may be busy or offline right now.'))}</p>
      ${any ? `<div class="pl-fail-acts">
        <a class="btn primary" href="${esc(D.m3uUrl(any.host, any.file, st.title))}">${icon('vlc')}Open in VLC</a>
        <a class="btn" href="${esc(any.url)}" download>${icon('download')}Download</a>
        <button type="button" class="btn ghost" data-copy="${esc(any.url)}">${icon('link')}Copy link</button>
      </div>` : ''}
      ${reasons ? `<details><summary>What happened</summary><ul>${reasons}</ul></details>` : ''}
    </div>`);
    showUi(true);
  }

  // Chrome exposes decoded audio bytes; zero after a few seconds means silent playback (AC3/DTS/EAC3).
  function checkAudio() {
    clearTimeout(audioTm);
    audioTm = setTimeout(() => {
      if (!st || v.paused || v.muted) return;
      if (typeof v.webkitAudioDecodedByteCount === 'number' && v.webkitAudioDecodedByteCount === 0 && v.currentTime > 3) {
        const c = st.cands[st.i];
        message(`<div class="pl-note">No sound? This file's audio format (often AC3/DTS) doesn't play in browsers.
          <a class="btn sm" href="${esc(D.m3uUrl(c.host, c.file, st.title))}">${icon('vlc')}Open in VLC</a>
          ${st.cands.slice(st.i + 1).some((x) => !x.skip) ? '<button type="button" class="btn sm ghost" data-a="nextcopy">Try another copy</button>' : ''}
          <button type="button" class="btn sm ghost" data-a="dismiss">Dismiss</button></div>`, true);
      }
    }, 4000);
  }

  function message(html, corner) {
    const m = $('.pl-msg', root);
    m.hidden = !html;
    m.className = 'pl-msg' + (corner ? ' corner' : '');
    m.innerHTML = html || '';
  }

  /* ------------------------------------------------------------ close */
  function close() {
    if (!v) return;
    if (!v.ended) saveProgress();
    clearTimeout(stallTm); clearTimeout(audioTm); clearInterval(saveTm); clearTimeout(hideTm);
    st = null;
    v.pause();
    v.removeAttribute('src');
    v.querySelectorAll('track').forEach((t) => { if (t.src.startsWith('blob:')) URL.revokeObjectURL(t.src); t.remove(); });
    v.load(); // stops the download
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    root.hidden = true;
    $('.pl-menu', root).hidden = true;
    $('.pl-subs', root).hidden = true;
    document.body.classList.remove('noscroll');
  }

  /* --------------------------------------------------------- controls */
  function toggle() { if (!v.getAttribute('src')) return; if (v.paused) v.play().catch(() => {}); else v.pause(); flash(v.paused ? 'pause' : 'play'); }
  function seekBy(s) { if (!isFinite(v.duration)) return; v.currentTime = Math.max(0, Math.min(v.duration - 0.5, v.currentTime + s)); flashText((s > 0 ? '+' : '−') + Math.abs(s) + ' s'); showUi(); }
  function fullscreen() {
    const el = $('.pl-stage', root);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else (el.requestFullscreen ? el.requestFullscreen() : Promise.reject()).catch(() => D.toast('Full screen is not available here'));
  }
  async function pip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch (e) { D.toast('Picture in picture is not available'); }
  }
  function setSubs(idx) {
    const tracks = Array.from(v.textTracks);
    tracks.forEach((t, i) => (t.mode = i === idx ? 'showing' : 'disabled'));
    st.subOn = idx >= 0; store.set('subs', st.subOn);
    syncCc();
  }
  function toggleCc() {
    const tracks = Array.from(v.textTracks);
    if (!tracks.length) return openSubs();
    const on = tracks.findIndex((t) => t.mode === 'showing');
    setSubs(on >= 0 ? -1 : 0);
    D.toast(on >= 0 ? 'Subtitles off' : `Subtitles: ${tracks[0].label}`);
  }
  function syncCc() {
    const b = $('[data-a="cc"]', root);
    const has = v.querySelectorAll('track').length > 0;
    b.classList.toggle('dim', !has && !v.textTracks.length);
    b.classList.toggle('on', has && st && st.subOn);
  }
  function flash(name) {
    const f = $('.pl-flash', root);
    f.innerHTML = icon(name); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  }
  function flashText(t) {
    const f = $('.pl-flash', root);
    f.innerHTML = `<b>${esc(t)}</b>`; f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  }

  function showUi(sticky) {
    root.classList.add('ui');
    clearTimeout(hideTm);
    if (sticky === true) return;
    hideTm = setTimeout(() => { if (v && !v.paused && $('.pl-menu', root).hidden && $('.pl-subs', root).hidden) root.classList.remove('ui'); }, 2600);
  }

  function syncPlay() {
    const paused = v.paused;
    $('[data-a="toggle"]', root).innerHTML = icon(paused ? 'play' : 'pause');
    root.classList.toggle('paused', paused);
    if (paused) showUi(true); else showUi();
  }
  function syncTime() {
    const d = v.duration || 0;
    $('.pl-cur', root).textContent = D.fmtTime(v.currentTime);
    $('.pl-dur', root).textContent = D.fmtTime(d);
    const pct = d ? (v.currentTime / d) * 100 : 0;
    $('.pl-played', root).style.width = pct + '%';
    $('.pl-knob', root).style.left = pct + '%';
    $('.pl-seek', root).setAttribute('aria-valuenow', Math.floor(v.currentTime));
  }
  function syncBuf() {
    const d = v.duration;
    if (!d || !v.buffered.length) return;
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 1) end = Math.max(end, v.buffered.end(i));
    $('.pl-buf', root).style.width = (end / d) * 100 + '%';
  }
  function syncVol() {
    $('[data-a="mute"]', root).innerHTML = icon(v.muted || v.volume === 0 ? 'mute' : 'vol');
    $('.pl-volr', root).value = v.muted ? 0 : v.volume;
    store.set('vol', v.volume); store.set('muted', v.muted);
  }

  function setupSeek() {
    const bar = $('.pl-seek', root);
    const tip = $('.pl-tip', root);
    const pos = (e) => {
      const r = bar.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      return Math.max(0, Math.min(1, x / r.width));
    };
    let drag = false;
    const move = (e) => {
      const p = pos(e);
      $('.pl-hover', root).style.width = p * 100 + '%';
      tip.textContent = D.fmtTime(p * (v.duration || 0));
      tip.style.left = p * 100 + '%';
      if (drag && isFinite(v.duration)) { v.currentTime = p * v.duration; syncTime(); }
    };
    bar.addEventListener('mousemove', move);
    bar.addEventListener('mousedown', (e) => { drag = true; move(e); });
    bar.addEventListener('touchstart', (e) => { drag = true; move(e); }, { passive: true });
    window.addEventListener('mousemove', (e) => { if (drag) move(e); });
    window.addEventListener('touchmove', (e) => { if (drag) move(e); }, { passive: true });
    window.addEventListener('mouseup', () => (drag = false));
    window.addEventListener('touchend', () => (drag = false));
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { seekBy(5); e.preventDefault(); e.stopPropagation(); }
      if (e.key === 'ArrowLeft') { seekBy(-5); e.preventDefault(); e.stopPropagation(); }
    });
  }

  /* Your own subtitle file (.srt/.vtt) from this computer. Nothing is uploaded anywhere. */
  async function addSubFile(file) {
    const buf = await file.arrayBuffer();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { text = new TextDecoder('windows-1252').decode(buf); }
    addTrackText(text, file.name.replace(/\.(srt|vtt)$/i, ''), 'en');
  }

  function addTrackText(text, label, lang) {
    text = text.replace(/\r\n?/g, '\n').replace(/^\ufeff/, '');
    if (!text.startsWith('WEBVTT')) text = 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    const t = document.createElement('track');
    t.kind = 'subtitles';
    t.label = label;
    t.srclang = lang;
    t.src = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
    v.appendChild(t);
    const idx = v.textTracks.length - 1;
    t.addEventListener('load', () => { setSubs(idx); renderSubs(); }, { once: true });
    setSubs(idx);
    D.toast(`Subtitles: ${label}`);
    renderSubs();
    return idx;
  }

  /* ---------------- Subtitle panel: loaded tracks, online search (English + Bangla), timing ---------------- */
  const LANG_SHORT = { eng: 'EN', ben: 'BN' };
  const LANG_NAME = { eng: 'English', ben: 'Bangla' };
  function subsQuery() {
    const c = st.cands[st.i] || {};
    const ep = D.episodeInfo(c.file || '');
    if (ep) return { title: ep.show, year: '', season: +ep.ep.slice(1, 3), episode: +ep.ep.slice(4) };
    const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(st.title || '');
    return m ? { title: m[1], year: m[2] } : { title: (st.title || '').replace(/\.[a-z0-9]{2,4}$/i, ''), year: '' };
  }
  function openSubs() {
    if (!st || st.i < 0) return;
    const p = $('.pl-subs', root);
    $('.pl-menu', root).hidden = true;
    p.hidden = !p.hidden;
    if (p.hidden) return;
    showUi(true);
    if (!st.subs) {
      st.subs = { ...subsQuery(), tab: store.get('subLang', 'all'), results: null, loading: false, error: '', applied: {} };
      searchSubs();
    }
    renderSubs();
  }
  async function searchSubs() {
    const S = st.subs;
    const c = st.cands[st.i];
    S.loading = true; S.error = ''; renderSubs();
    const params = { title: S.title, host: c.host, file: c.file };
    if (S.year) params.year = S.year;
    if (S.season) { params.season = S.season; params.episode = S.episode; }
    try {
      const r = await D.api('subs/search', params);
      if (st && st.subs === S) { S.results = r.results; S.hashed = r.hashed; }
    } catch (e) { S.error = e.message; S.results = []; }
    S.loading = false;
    renderSubs();
  }
  async function applySub(i) {
    const S = st.subs;
    const r = S.results[i];
    if (S.applied[r.id] != null) { setSubs(S.applied[r.id]); renderSubs(); return; }
    S.busy = r.id; renderSubs();
    try {
      const res = await fetch(`/api/subs/get?${new URLSearchParams({ link: r.link, enc: r.enc || '' })}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Download failed');
      const text = await res.text();
      const label = `${LANG_NAME[r.lang] || r.lang} · ${r.name.replace(/\.(srt|sub|vtt)$/i, '').slice(0, 40)}`;
      S.applied[r.id] = addTrackText(text, label, r.lang === 'ben' ? 'bn' : 'en');
      store.set('subLang', r.lang);
    } catch (e) { D.toast(e.message, 3500); }
    S.busy = null;
    renderSubs();
  }
  function shiftSubs(delta) {
    const t = Array.from(v.textTracks).find((x) => x.mode === 'showing');
    if (!t || !t.cues) return;
    Array.from(t.cues).forEach((c) => { c.startTime = Math.max(0, c.startTime + delta); c.endTime = Math.max(0.1, c.endTime + delta); });
    t._shift = Math.round(((t._shift || 0) + delta) * 10) / 10;
    renderSubs();
  }
  function renderSubs() {
    const p = $('.pl-subs', root);
    if (!p || p.hidden || !st) return;
    const S = st.subs || { results: null };
    const tracks = Array.from(v.textTracks);
    const on = tracks.findIndex((t) => t.mode === 'showing');
    const res = S.results || [];
    const count = (l) => res.filter((r) => r.lang === l).length;
    const shown = res.map((r, i) => [r, i]).filter(([r]) => S.tab === 'all' || r.lang === S.tab);
    const ft = (n) => n.toLocaleString();
    p.innerHTML = `
      <div class="ps-head"><h3>Subtitles</h3><button type="button" class="pl-btn" data-a="subsclose" aria-label="Close">${icon('x')}</button></div>
      <div class="ps-sec">
        <button type="button" class="ps-track${on < 0 ? ' on' : ''}" data-sub="-1"><span class="ps-radio"></span>Off</button>
        ${tracks.map((t, i) => `<button type="button" class="ps-track${on === i ? ' on' : ''}" data-sub="${i}"><span class="ps-radio"></span><span class="ps-tl">${esc(t.label || 'Track ' + (i + 1))}</span></button>`).join('')}
        ${on >= 0 ? `<div class="ps-timing"><span>Timing</span><button type="button" class="pm-chip" data-shift="-0.5">− 0.5 s</button><b>${(tracks[on]._shift || 0) > 0 ? '+' : ''}${(tracks[on]._shift || 0).toFixed(1)} s</b><button type="button" class="pm-chip" data-shift="0.5">+ 0.5 s</button></div>` : ''}
      </div>
      <form class="ps-search" data-subsform>
        <input name="q" value="${esc(S.title || '')}" placeholder="Movie or show title" aria-label="Title" spellcheck="false">
        ${S.season ? `<input name="se" value="S${String(S.season).padStart(2, '0')}E${String(S.episode).padStart(2, '0')}" class="ps-small" aria-label="Episode">` : `<input name="y" value="${esc(S.year || '')}" placeholder="Year" inputmode="numeric" class="ps-small" aria-label="Year">`}
        <button type="submit" class="btn sm primary">${icon('search')}</button>
      </form>
      <div class="ps-tabs" role="tablist">
        ${[['all', 'All', res.length], ['eng', 'English', count('eng')], ['ben', 'Bangla', count('ben')]].map(([k, l, n]) =>
          `<button type="button" role="tab" class="pm-chip${S.tab === k ? ' on' : ''}" data-subtab="${k}">${l}${S.results ? ` ${n}` : ''}</button>`).join('')}
      </div>
      <div class="ps-results">
        ${S.loading ? '<div class="ps-empty"><span class="spinner"></span> Searching OpenSubtitles for English and Bangla…</div>'
          : S.error ? `<div class="ps-empty">${esc(S.error)}</div>`
          : !S.results ? ''
          : !shown.length ? `<div class="ps-empty">No ${S.tab === 'all' ? '' : LANG_NAME[S.tab] + ' '}subtitles found. Try a shorter title${S.season ? '' : ' or remove the year'}.</div>`
          : shown.map(([r, i]) => {
            const applied = S.applied[r.id] != null;
            const active = applied && S.applied[r.id] === on;
            return `<button type="button" class="ps-row${active ? ' on' : ''}" data-sr="${i}">
              <span class="ps-lang ${r.lang}">${LANG_SHORT[r.lang] || r.lang}</span>
              <span class="ps-main"><span class="ps-name">${esc(r.name)}</span>
                <span class="ps-meta">${r.exact ? '<b class="ps-sync">Made for this file</b>' : r.sync ? '<b class="ps-sync">Perfect sync</b>' : ''}${r.hi ? '<i>HI</i>' : ''}${r.cds > 1 ? `<i>${r.cds} CDs</i>` : ''}<span>${icon('download')}${ft(r.downloads)}</span></span></span>
              <span class="ps-act">${S.busy === r.id ? '<span class="spinner"></span>' : active ? 'On' : applied ? 'Use' : 'Add'}</span>
            </button>`;
          }).join('')}
      </div>
      <div class="ps-foot">
        <button type="button" class="linkish" data-a="addsub">${icon('plus')} Add file from computer</button>
        <span>Search: OpenSubtitles.org${S.hashed ? ' · matched by file' : ''}</span>
      </div>`;
  }

  // Only some browsers (Safari) expose audio tracks; others always play the file's default track.
  function audioHtml() {
    const at = v.audioTracks;
    const c = st.cands[st.i];
    if (at && at.length > 1) {
      return `<div class="pm-sec"><div class="pm-h">Audio</div>${Array.from(at).map((a, i) =>
        `<button type="button" class="pm-item${a.enabled ? ' on' : ''}" data-audio="${i}">${esc(a.label || a.language || 'Track ' + (i + 1))}</button>`).join('')}</div>`;
    }
    if (/dual|multi|hindi|eng/i.test(D.dec(c.file || ''))) {
      return `<div class="pm-sec"><div class="pm-h">Audio</div><div class="pm-empty">This file has more than one audio track, but this browser plays only the default one. VLC lets you choose (Audio → Audio Track).</div>
        <a class="pm-item" href="${esc(D.m3uUrl(c.host, c.file, st.title))}">${icon('vlc')} Open in VLC to pick audio</a></div>`;
    }
    return '';
  }

  function menuHtml() {
    const tracks = Array.from(v.textTracks);
    const on = tracks.findIndex((t) => t.mode === 'showing');
    const pref = store.get('qpref', '720p');
    return `
      <div class="pm-sec"><div class="pm-h">Speed</div><div class="pm-chips">${SPEEDS.map((s) => `<button type="button" class="pm-chip${v.playbackRate === s ? ' on' : ''}" data-speed="${s}">${s === 1 ? 'Normal' : s + '×'}</button>`).join('')}</div></div>
      <div class="pm-sec"><div class="pm-h">Subtitles</div>
        <button type="button" class="pm-item" data-a="cc">${icon('cc')} ${on >= 0 ? esc(tracks[on].label) : 'Off'} · find English / Bangla…</button>
      </div>
      ${audioHtml()}
      <div class="pm-sec"><div class="pm-h">Copies (server &amp; quality)</div>
        ${st.cands.map((c, i) => `<button type="button" class="pm-item${i === st.i ? ' on' : ''}" data-copyi="${i}">${esc(srcLabel(c))}${c.skip && i !== st.i ? ` <span class="pm-bad">· ${esc(c.skip)}</span>` : ''}</button>`).join('')}
      </div>
      <div class="pm-sec"><div class="pm-h">Prefer for next time</div><div class="pm-chips">${['720p', '1080p'].map((q) => `<button type="button" class="pm-chip${pref === q ? ' on' : ''}" data-qpref="${q}">${q}</button>`).join('')}</div></div>
      <div class="pm-sec pm-ext">
        <a class="pm-item" href="${esc(D.m3uUrl(st.cands[st.i].host, st.cands[st.i].file, st.title))}">${icon('vlc')} Open in VLC</a>
        <a class="pm-item" href="${esc(st.cands[st.i].url)}" download>${icon('download')} Download this file</a>
      </div>`;
  }

  function onClick(e) {
    const rep = e.target.closest('a[data-replace]');
    if (rep) { e.preventDefault(); location.replace(rep.getAttribute('href')); return; }
    const t = e.target.closest('[data-a],[data-speed],[data-sub],[data-copyi],[data-qpref],[data-copy],[data-audio],[data-sr],[data-subtab],[data-shift]');
    const menu = $('.pl-menu', root);
    if (!t) { if (!menu.hidden && !e.target.closest('.pl-menu')) menu.hidden = true; return; }
    if (t.dataset.sr != null) return applySub(+t.dataset.sr);
    if (t.dataset.subtab) { st.subs.tab = t.dataset.subtab; return renderSubs(); }
    if (t.dataset.shift) return shiftSubs(+t.dataset.shift);
    const a = t.dataset.a;
    if (a === 'close') return D.goBack('#/');
    if (a === 'toggle') toggle();
    else if (a === 'rew') seekBy(-10);
    else if (a === 'fwd') seekBy(10);
    else if (a === 'mute') v.muted = !v.muted;
    else if (a === 'full') fullscreen();
    else if (a === 'pip') pip();
    else if (a === 'cc') openSubs();
    else if (a === 'subsclose') $('.pl-subs', root).hidden = true;
    else if (a === 'dismiss') message('');
    else if (a === 'addsub') $('.pl-subfile', root).click();
    else if (a === 'nextcopy') next('no sound in the browser');
    else if (a === 'menu') {
      if (!st || st.i < 0) return;
      menu.hidden = !menu.hidden;
      if (!menu.hidden) { menu.innerHTML = menuHtml(); showUi(true); }
    } else if (t.dataset.speed) { v.playbackRate = +t.dataset.speed; menu.innerHTML = menuHtml(); D.toast(`Speed ${v.playbackRate}×`); }
    else if (t.dataset.sub != null) { setSubs(+t.dataset.sub); if (!menu.hidden) menu.innerHTML = menuHtml(); renderSubs(); }
    else if (t.dataset.audio != null) { Array.from(v.audioTracks).forEach((a, i) => (a.enabled = i === +t.dataset.audio)); menu.innerHTML = menuHtml(); }
    else if (t.dataset.copyi != null) {
      const i = +t.dataset.copyi;
      const pos = v.currentTime;
      st.cands[i].skip = null;
      menu.hidden = true;
      tryIndex(i);
      if (pos > 5) v.addEventListener('loadedmetadata', () => { v.currentTime = pos; }, { once: true });
    } else if (t.dataset.qpref) { store.set('qpref', t.dataset.qpref); menu.innerHTML = menuHtml(); }
    else if (t.dataset.copy) D.copy(t.dataset.copy);
  }

  document.addEventListener('keydown', (e) => {
    if (root.hidden || !v) return;
    if (/input|select|textarea/i.test(e.target.tagName) && e.target.type !== 'range') return;
    const k = e.key;
    const map = {
      ' ': toggle, k: toggle, K: toggle,
      j: () => seekBy(-10), l: () => seekBy(10), J: () => seekBy(-10), L: () => seekBy(10),
      ArrowLeft: () => seekBy(-5), ArrowRight: () => seekBy(5),
      ArrowUp: () => { v.muted = false; v.volume = Math.min(1, v.volume + 0.05); flashText(Math.round(v.volume * 100) + '%'); },
      ArrowDown: () => { v.volume = Math.max(0, v.volume - 0.05); flashText(Math.round(v.volume * 100) + '%'); },
      m: () => { v.muted = !v.muted; flash(v.muted ? 'mute' : 'vol'); }, M: () => { v.muted = !v.muted; },
      f: fullscreen, F: fullscreen, c: toggleCc, C: toggleCc, i: pip,
      '>': () => { const i = SPEEDS.indexOf(v.playbackRate); v.playbackRate = SPEEDS[Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + 1)]; flashText(v.playbackRate + '×'); },
      '<': () => { const i = SPEEDS.indexOf(v.playbackRate); v.playbackRate = SPEEDS[Math.max(0, (i < 0 ? 2 : i) - 1)]; flashText(v.playbackRate + '×'); },
      Escape: () => { const m = $('.pl-menu', root), sp = $('.pl-subs', root); if (!sp.hidden) sp.hidden = true; else if (!m.hidden) m.hidden = true; else if (!document.fullscreenElement) D.goBack('#/'); },
    };
    if (/^[0-9]$/.test(k) && isFinite(v.duration)) { v.currentTime = (v.duration * +k) / 10; showUi(); e.preventDefault(); return; }
    if (map[k]) { map[k](); showUi(); e.preventDefault(); }
  });
})();
