/* Shared helpers. Everything hangs off window.CHOBI; no build step, no dependencies. */
(() => {
  'use strict';
  const D = (window.CHOBI = {});

  D.$ = (s, el = document) => el.querySelector(s);
  D.$$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  D.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  D.dec = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  D.icon = (id, cls) => `<svg${cls ? ` class="${cls}"` : ''} aria-hidden="true"><use href="#i-${id}"/></svg>`;
  D.isDir = (href) => href.endsWith('/');
  D.baseName = (href) => D.dec(href.replace(/\/$/, '').split('/').pop() || '/');

  /* Browser storage is a convenience only; every read/write may fail. */
  D.store = {
    get(k, d) { try { const v = localStorage.getItem('chobi.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { if (v == null) localStorage.removeItem('chobi.' + k); else localStorage.setItem('chobi.' + k, JSON.stringify(v)); } catch (e) {} },
  };

  D.toast = (msg, ms = 2000) => {
    const t = D.$('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(D.toast.tm); D.toast.tm = setTimeout(() => t.classList.remove('show'), ms);
  };

  D.api = async (path, params, opts = {}) => {
    const qs = params instanceof URLSearchParams ? params.toString() : new URLSearchParams(params || {}).toString();
    const init = { method: opts.method || 'GET', signal: opts.signal };
    if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers = { 'Content-Type': 'application/json' }; }
    if (init.method !== 'GET' && !init.headers) init.headers = { 'Content-Type': 'application/json' };
    const r = await fetch(`/api/${path}${qs ? '?' + qs : ''}`, init);
    let data = null;
    try { data = await r.json(); } catch (e) { /* not JSON */ }
    if (!r.ok && r.status !== 202) throw new Error((data && data.error) || `Request failed (${r.status})`);
    if (r.status === 202) data = { ...(data || {}), _pending: true };
    return data;
  };

  /* ---- file types ---- */
  const TYPES = {
    video: 'mkv mp4 avi m4v mov wmv flv webm mpg mpeg ts m2ts vob 3gp divx rmvb',
    audio: 'mp3 flac aac m4a wav ogg opus wma mka',
    image: 'jpg jpeg png gif webp bmp svg ico',
    sub: 'srt ass ssa sub vtt idx sup',
    archive: 'zip rar 7z tar gz bz2 xz tgz r00 r01',
    disc: 'iso img bin cue mdf mds nrg',
    app: 'exe msi apk xapk apks obb dmg deb rpm appimage bat sh jar',
    doc: 'pdf epub mobi azw3 doc docx txt nfo md rtf chm xls xlsx ppt pptx',
  };
  const EXT2TYPE = {};
  for (const [t, list] of Object.entries(TYPES)) list.split(' ').forEach((e) => (EXT2TYPE[e] = t));
  D.extOf = (name) => { const m = /\.([a-z0-9]{1,8})$/i.exec(name); return m ? m[1].toLowerCase() : ''; };
  D.typeOf = (href) => (D.isDir(href) ? 'folder' : EXT2TYPE[D.extOf(D.baseName(href))] || 'file');

  D.fmtSize = (b) => {
    if (b == null) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let n = b;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)) + ' ' + u[i];
  };
  const dfmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  D.fmtDate = (t) => {
    if (!t) return '';
    const days = (Date.now() - t) / 864e5;
    if (days < 1 && days > -1) return 'Today';
    if (days < 2 && days > 0) return 'Yesterday';
    if (days < 7 && days > 0) return Math.floor(days) + ' days ago';
    return dfmt.format(t);
  };
  D.fmtTime = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };

  /* Search normalisation: case, accents, dots, underscores, punctuation. */
  D.norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

  /* ---- servers ---- */
  D.portal = null; // {sections: {name: [{section,name,host,href,url,source}]}, hosts: {id: {base, source, kind}}}
  D.status = {};
  D.origUrl = (host, href) => {
    const h = D.portal && D.portal.hosts[host];
    return (h ? h.base : `http://172.16.50.${host}`) + href;
  };
  D.hostLabel = (host) => {
    const h = D.portal && D.portal.hosts[host];
    if (!h) return host;
    return h.base.replace(/^https?:\/\//, '');
  };
  D.loadPortal = async () => {
    try { D.portal = await D.api('portal'); } catch (e) { D.portal = { sections: {}, hosts: {}, errors: [e.message] }; }
    document.dispatchEvent(new CustomEvent('chobi:portal'));
    return D.portal;
  };
  D.loadStatus = async () => {
    try { D.status = await D.api('status'); } catch (e) { /* ignore */ }
    document.dispatchEvent(new CustomEvent('chobi:status'));
  };

  D.copy = async (text) => {
    try { await navigator.clipboard.writeText(text); D.toast('Link copied'); }
    catch (e) { prompt('Copy this link:', text); }
  };

  /* Genres (from Wikidata via the server): {Thriller: Set(groupKey), ...} */
  D.genres = null;
  D.loadGenres = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await D.api('genres');
        if (!r._pending) {
          D.genres = {};
          for (const [g, keys] of Object.entries(r.genres)) D.genres[g] = new Set(keys);
          document.dispatchEvent(new CustomEvent('chobi:genres'));
          return D.genres;
        }
      } catch (e) { return null; }
      await new Promise((res) => setTimeout(res, 5000));
    }
    return null;
  };
  D.genresOf = (key) => (D.genres ? Object.keys(D.genres).filter((g) => D.genres[g].has(key)) : []);

  /* Watch history ("Continue watching"), stored by the local server. */
  D.history = [];
  D.loadHistory = async () => {
    try { D.history = (await D.api('history')).items || []; } catch (e) { /* ignore */ }
    document.dispatchEvent(new CustomEvent('chobi:history'));
    return D.history;
  };
  D.saveHistory = (item) => {
    const i = D.history.findIndex((h) => h.id === item.id);
    if (i >= 0) D.history.splice(i, 1);
    D.history.unshift({ ...item, at: Date.now() });
    D.api('history', null, { method: 'POST', body: item }).catch(() => {});
  };
  D.deleteHistory = (id) => {
    D.history = D.history.filter((h) => h.id !== id);
    D.api('history', { id }, { method: 'DELETE' }).catch(() => {});
    document.dispatchEvent(new CustomEvent('chobi:history'));
  };
  /* "Show/Season 1/Show.S01E05.mkv" -> {show, ep: 'S01E05'} */
  D.episodeInfo = (href) => {
    const name = D.baseName(href);
    const m = /\bS(\d{1,2})[ ._-]?E(\d{1,3})\b/i.exec(name) || /\b(\d{1,2})x(\d{2,3})\b/.exec(name);
    if (!m) return null;
    const parts = D.dec(href).split('/').filter(Boolean);
    parts.pop();
    let folder = parts.pop() || '';
    if (/^season|^s\d+$/i.test(folder.trim())) folder = parts.pop() || folder;
    const show = folder.replace(/\s*[([].*$/, '').replace(/-(?=[A-Z])/g, ': ').trim() || name;
    return { show, ep: `S${String(+m[1]).padStart(2, '0')}E${String(+m[2]).padStart(2, '0')}` };
  };
  /* Folder that holds the poster for a file: its own folder, or the show folder above "Season N". */
  D.posterFolder = (href) => {
    const parts = href.split('/');
    parts.pop();
    const folder = D.dec(parts[parts.length - 1] || '');
    if (/^season|^s\d+$/i.test(folder.trim())) parts.pop();
    return parts.join('/') + '/';
  };

  /* Posters fade in when loaded; a missing poster leaves the typographic card. */
  document.addEventListener('load', (e) => { if (e.target.tagName === 'IMG' && e.target.closest('.poster')) e.target.classList.add('ok'); }, true);
  document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG' && e.target.closest('.poster')) e.target.remove(); }, true);

  /* Playback URL helpers */
  D.m3uUrl = (host, href, title) => `/api/play.m3u?${new URLSearchParams({ host, href, title: title || D.baseName(href) })}`;
  D.watchHash = (title, cands, key) => {
    const p = new URLSearchParams();
    p.set('t', title);
    if (key) p.set('k', key);
    cands.forEach((c) => p.append('v', `${c.host}|${c.href}`));
    return '#/watch?' + p.toString();
  };
})();
