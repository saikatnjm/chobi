/* For you: Continue watching + suggestions from the genres you like. */
(() => {
  'use strict';
  const D = window.CHOBI;
  const { $, esc, icon, store } = D;
  // How much each genre counts: 0 off, 1 sometimes, 3 mostly. Defaults from the owner's taste.
  const DEFAULT_W = { Thriller: 3, Action: 3, Comedy: 1, Romance: 1 };
  const LEVEL = { 0: 'off', 1: 'sometimes', 3: 'mostly' };
  const F = (D.foryou = { app: null });
  const weights = () => ({ ...DEFAULT_W, ...store.get('genreW', {}) });

  /* ---- Continue watching (also shown on the Movies page) ---- */
  function cardFor(h) {
    const done = h.dur && h.pos >= h.dur - 90;
    const target = done && h.next ? { host: h.next.host, href: h.next.file } : { host: h.host, href: h.file };
    const title = h.show || h.title;
    const sub = done
      ? (h.next ? `Up next: ${h.next.ep}` : 'Finished')
      : `${h.ep ? h.ep + ' · ' : ''}${D.fmtTime(Math.max(0, h.dur - h.pos)).replace(/^0:/, '')} left`;
    const pct = h.dur ? Math.min(100, (h.pos / h.dur) * 100) : 0;
    const img = h.poster ? `<img decoding="async" alt="" src="/api/poster?${new URLSearchParams({ host: h.poster.host, href: h.poster.href, v: 2 })}">` : '';
    return `<div class="pcard ccard">
      <a href="${esc(D.watchHash(title, [target], h.key))}" class="ccard-link" title="${esc(title)}">
        <div class="poster" style="--h:${(title.length * 37) % 360}">
          <div class="ptype"><span class="pt-title">${esc(title)}</span>${h.ep ? `<span class="pt-year">${esc(h.ep)}</span>` : ''}</div>
          ${img}
          ${h.ep ? `<span class="pq">${esc(done && h.next ? h.next.ep : h.ep)}</span>` : ''}
          <span class="pplay">${icon('play')}</span>
          <span class="cprog"><i style="width:${done ? 100 : pct}%"></i></span>
        </div>
        <div class="pmeta"><div class="pt">${esc(title)}</div><div class="ps">${esc(sub)}</div></div>
      </a>
      <button type="button" class="cdel" data-hdel="${esc(h.id)}" title="Remove from Continue watching" aria-label="Remove">${icon('x')}</button>
    </div>`;
  }
  F.continueRowHtml = () => {
    if (!D.history.length) return '';
    return `<section class="rowsec">
      <div class="wrap rowhead"><h2>Continue watching</h2></div>
      <div class="railwrap">
        <button type="button" class="rail-arrow l" data-rail="-1" aria-label="Scroll left">${icon('back')}</button>
        <div class="rail">${D.history.slice(0, 20).map(cardFor).join('')}</div>
        <button type="button" class="rail-arrow r" data-rail="1" aria-label="Scroll right">${icon('chev')}</button>
      </div></section>`;
  };

  /* ---- Suggestions ---- */
  function seededRand(seed) { let x = seed % 2147483647; if (x <= 0) x += 2147483646; return () => (x = (x * 16807) % 2147483647) / 2147483647; }
  function suggestions() {
    const M = D.movies;
    if (!D.genres || !M.groups.length) return null;
    const w = weights();
    const watched = new Set(D.history.map((h) => h.key).filter(Boolean));
    const nowY = new Date().getFullYear();
    const day = Math.floor(Date.now() / 864e5);
    const rnd = seededRand(day * 7919);
    const scored = [];
    for (const g of M.groups) {
      if (watched.has(g.key)) continue;
      let s = 0;
      for (const [genre, set] of Object.entries(D.genres)) if (w[genre] && set.has(g.key)) s += w[genre];
      if (!s) continue;
      if (g.rank) s += 2;
      if (g.y >= nowY - 3) s += 1.5; else if (g.y >= 2010) s += 0.6;
      if (g.q.has('1080p')) s += 0.3;
      scored.push([g, s + rnd() * 2.5]); // changes a little every day
    }
    scored.sort((a, b) => b[1] - a[1]);
    const picked = scored.slice(0, 24).map((x) => x[0]);
    const rows = Object.entries(w).filter(([g, x]) => x > 0 && D.genres[g]).sort((a, b) => b[1] - a[1]).map(([genre]) => ({
      genre,
      list: M.groups.filter((g) => D.genres[genre].has(g.key) && !watched.has(g.key)).sort((a, b) => b.m - a.m).slice(0, 24),
    }));
    return { picked, rows };
  }

  function rail(title, list, see) {
    if (!list.length) return '';
    return `<section class="rowsec">
      <div class="wrap rowhead"><h2>${esc(title)}</h2>${see ? `<button type="button" class="linkish" data-genre-see="${esc(see)}">See all</button>` : ''}</div>
      <div class="railwrap">
        <button type="button" class="rail-arrow l" data-rail="-1" aria-label="Scroll left">${icon('back')}</button>
        <div class="rail">${list.map(D.movies.cardHtml).join('')}</div>
        <button type="button" class="rail-arrow r" data-rail="1" aria-label="Scroll right">${icon('chev')}</button>
      </div></section>`;
  }

  function render() {
    if (!F.app) return;
    const w = weights();
    const sug = suggestions();
    let html = `<div class="foryou">
      <div class="wrap hero"><h1>For you</h1><p class="hero-sub">Pick up where you left off, and movies chosen from the genres you like.</p>
        <div class="gchips" role="group" aria-label="Genres you like">${Object.keys(DEFAULT_W).map((g) =>
          `<button type="button" class="pill pill-btn${w[g] ? ' on' : ''}" data-gw="${esc(g)}" title="Click to change">${esc(g)} <span class="n">${LEVEL[w[g] || 0]}</span></button>`).join('')}</div>
      </div>
      <div class="rows">${F.continueRowHtml() || `<div class="wrap"><p class="muted cempty">${icon('clock')} Movies and episodes you start will appear here, with the episode and the minute you stopped at.</p></div>`}`;
    if (!D.movies.groups.length || !D.genres) {
      html += `<div class="wrap"><p class="muted"><span class="spinner"></span> ${D.genres ? 'Loading the movie library…' : 'Getting genre information (first time only, about 1 minute)…'}</p></div>`;
    } else if (sug) {
      html += rail('Picked for you', sug.picked);
      for (const r of sug.rows) html += rail(r.genre, r.list, r.genre);
    }
    html += '</div></div>';
    F.app.innerHTML = html;
    F.app.querySelectorAll('img[data-src]').forEach((i) => D.movies.watchImg(i));
  }

  F.mount = (app) => {
    F.app = app;
    document.title = 'Chobi · For you';
    render();
    window.scrollTo(0, 0);
    if (!D.movies.groups.length && !D.movies.loading) D.movies.load();
    D.loadHistory();
    if (!D.genres) D.loadGenres();
  };
  F.unmount = () => { F.app = null; };
  ['chobi:genres', 'chobi:history', 'chobi:movies'].forEach((ev) => document.addEventListener(ev, () => F.app && render()));

  // Shared click handling for Continue watching cards and rails (Movies page + For you).
  document.addEventListener('click', (e) => {
    const del = e.target.closest('[data-hdel]');
    if (del) { e.preventDefault(); D.deleteHistory(del.dataset.hdel); return; }
    if (!F.app) return;
    const t = e.target.closest('[data-gw],[data-rail],[data-genre-see]');
    if (!t) return;
    if (t.dataset.rail) {
      const r = t.parentElement.querySelector('.rail');
      r.scrollBy({ left: +t.dataset.rail * r.clientWidth * 0.85, behavior: 'smooth' });
    } else if (t.dataset.gw) {
      const cur = weights();
      const next = { 0: 1, 1: 3, 3: 0 }[cur[t.dataset.gw] || 0];
      store.set('genreW', { ...cur, [t.dataset.gw]: next });
      render();
    } else if (t.dataset.genreSee) {
      D.movies.showGenre(t.dataset.genreSee);
    }
  });
})();
