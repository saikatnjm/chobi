/* Movies: discovery page (search + filters + poster grid) and the movie detail sheet. */
(() => {
  'use strict';
  const D = window.CHOBI;
  const { $, esc, icon, store } = D;
  const CHUNK = 48;
  const QRANK = { '4K': 4, '1080p': 3, '720p': 2, SD: 1, '': 0 };
  const QUALS = ['4K', '1080p', '720p', 'SD'];

  const M = (D.movies = {
    groups: [], byKey: new Map(), meta: null, loading: false, error: null,
    f: { q: '', genre: '', year: '', lang: '', cat: '', qual: '', dual: false },
    sort: store.get('msort', 'recent'),
    posters: store.get('posters', true),
    results: [], shown: 0, el: null, scrollY: 0,
  });

  /* ------------------------------------------------------------ data */
  // The server sends compact rows: [title, year, quality, langIx, catIx, relPath, days, tagBits, rank, collection, isFile, size]
  function expand(data) {
    const out = new Array(data.rows.length);
    for (let i = 0; i < data.rows.length; i++) {
      const a = data.rows[i];
      const cat = data.cats[a[4]] || { href: '' };
      const g = [];
      if (a[7]) data.tags.forEach((t, b) => { if (a[7] & (1 << b)) g.push(t); });
      out[i] = { t: a[0], y: a[1] || null, q: a[2] || '', l: data.langs[a[3] || 0] || '', c: a[4] || 0,
        h: a[5] && a[5][0] === '/' ? a[5] : cat.href + (a[5] || ''), m: (a[6] || 0) * 864e5, g, r: a[8] || 0, k: a[9] || '', f: a[10] || 0, s: a[11] || null };
    }
    return out;
  }

  function build(data) {
    const cats = data.cats;
    const map = new Map();
    const rows = data.rows ? expand(data) : data.movies;
    for (const r of rows) {
      const n = D.norm(r.t);
      const key = n + '|' + (r.y || '');
      let g = map.get(key);
      if (!g) {
        g = { key, t: r.t, y: r.y || null, n, versions: [], q: new Set(), langs: new Set(), cats: new Set(), tags: new Set(), m: 0, rank: null, coll: r.k || '' };
        map.set(key, g);
      }
      const c = cats[r.c] || {};
      g.versions.push({ host: c.host, href: r.h, q: r.q || '', lang: r.l || '', cat: c.short || c.name || '', catName: c.name || '', source: c.source || '', tags: r.g || [], file: !!r.f, size: r.s, m: r.m || 0 });
      if (r.q) g.q.add(r.q);
      if (r.l) g.langs.add(r.l);
      if (c.short) g.cats.add(c.short);
      (r.g || []).forEach((t) => g.tags.add(t));
      if ((r.m || 0) > g.m) g.m = r.m;
      if (r.r) g.rank = r.r;
      if (r.k && !g.coll) g.coll = r.k;
      if (r.t.length > g.t.length && D.norm(r.t) === n) g.t = r.t;
    }
    const groups = [...map.values()];
    for (const g of groups) {
      g.versions.sort((a, b) => QRANK[b.q] - QRANK[a.q] || (a.file - b.file));
      g.nc = g.n.replace(/ /g, '');
      g.w = g.n.split(' ');
      g.sec = D.norm([...g.langs, ...g.cats, g.coll, ...g.tags].join(' '));
      g.best = g.versions[0].q;
      g.dual = g.tags.has('Dual Audio') || g.tags.has('Multi Audio');
      g.poster = g.versions.find((v) => !v.file) || null;
      g.hue = hash(g.n) % 360;
    }
    M.groups = groups;
    M.byKey = map;
    M.meta = { built: data.built, count: groups.length, files: rows.length, servers: new Set(cats.map((c) => c.source || c.host)).size };
  }
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

  async function load() {
    if (M.loading) return;
    M.loading = true; M.error = null;
    try {
      for (;;) {
        const data = await D.api('movies');
        if (!data._pending) { build(data); break; }
        renderBuilding(data);
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (e) {
      M.error = e.message;
    }
    M.loading = false;
    if (M.el) { renderFilters(); update(); }
    document.dispatchEvent(new CustomEvent('chobi:movies'));
  }
  M.reload = () => { M.groups = []; M.rowsHtml = null; load(); };

  /* ---------------------------------------------------------- search */
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  function scoreGroup(g, toks, qn, fuzzy) {
    let s = 0;
    for (const t of toks) {
      let ts = 0;
      if (g.w.includes(t)) ts = 3;
      else if (g.w.some((w) => w.startsWith(t))) ts = 2;
      else if (g.n.includes(t)) ts = 1.2;
      else if (t.length > 2 && g.nc.includes(t)) ts = 1;
      else if (/^(19|20)\d\d$/.test(t) && String(g.y) === t) ts = 1.5;
      else if (/^(2160p|4k|1080p|720p|480p)$/.test(t) && g.q.has(t === '2160p' ? '4K' : t === '4k' ? '4K' : t)) ts = 1;
      else if (g.sec.includes(t)) ts = 0.5;
      else if (fuzzy && t.length >= 4) {
        const max = t.length >= 8 ? 2 : 1;
        if (g.w.some((w) => w.length >= 3 && lev(t, w, max) <= max)) ts = 0.8;
      }
      if (!ts) return 0;
      s += ts;
    }
    const bare = g.n.replace(/^(the|a|an) /, '');
    const qb = qn.replace(/^(the|a|an) /, '');
    if (g.n === qn || bare === qb) s += 10;
    else if (g.n.startsWith(qn) || bare.startsWith(qb)) s += 5;
    else if (g.n.includes(qn)) s += 2;
    return s + 3 * Math.min(1, qn.length / g.n.length); // closer-length titles first
  }
  function yearMatch(g, v) {
    if (!v) return true;
    const y = g.y;
    if (!y) return false;
    if (v === 'old') return y < 1950;
    if (v.startsWith('d')) { const d = +v.slice(1); return y >= d && y < d + 10; }
    return y === +v;
  }
  function compute() {
    const f = M.f;
    const qn = D.norm(f.q);
    const toks = qn ? qn.split(' ') : [];
    let scored = [];
    const run = (fuzzy) => {
      scored = [];
      for (const g of M.groups) {
        const s = toks.length ? scoreGroup(g, toks, qn, fuzzy) : 1;
        if (s) scored.push([g, s]);
      }
    };
    run(false);
    M.fuzzy = false;
    if (toks.length && !scored.length) { run(true); M.fuzzy = scored.length > 0; }

    // Facet counts: each facet counts matches of every *other* active filter.
    const facets = { year: new Map(), lang: new Map(), cat: new Map(), qual: new Map(), genre: new Map(), dual: 0 };
    const out = [];
    const G = D.genres || {};
    const gset = f.genre && G[f.genre];
    for (const [g, s] of scored) {
      const okG = !f.genre || (gset ? gset.has(g.key) : true);
      const okY = yearMatch(g, f.year) && okG, okL = !f.lang || g.langs.has(f.lang), okC = !f.cat || g.cats.has(f.cat);
      const okQ = !f.qual || g.q.has(f.qual), okD = !f.dual || g.dual;
      if (yearMatch(g, f.year) && okL && okC && okQ && okD) for (const k in G) if (G[k].has(g.key)) facets.genre.set(k, (facets.genre.get(k) || 0) + 1);
      if (okG && okL && okC && okQ && okD && g.y) {
        facets.year.set(g.y, (facets.year.get(g.y) || 0) + 1);
      }
      if (okY && okC && okQ && okD) g.langs.forEach((l) => facets.lang.set(l, (facets.lang.get(l) || 0) + 1));
      if (okY && okL && okQ && okD) g.cats.forEach((c) => facets.cat.set(c, (facets.cat.get(c) || 0) + 1));
      if (okY && okL && okC && okD) g.q.forEach((q) => facets.qual.set(q, (facets.qual.get(q) || 0) + 1));
      if (okY && okL && okC && okQ && g.dual) facets.dual++;
      if (okY && okL && okC && okQ && okD) out.push([g, s]);
    }
    const sort = toks.length && M.sort === 'recent' ? 'relevance' : M.sort;
    const by = {
      relevance: (a, b) => b[1] - a[1] || (b[0].y || 0) - (a[0].y || 0),
      recent: (a, b) => b[0].m - a[0].m,
      newest: (a, b) => (b[0].y || 0) - (a[0].y || 0) || b[0].m - a[0].m,
      oldest: (a, b) => (a[0].y || 9999) - (b[0].y || 9999),
      title: (a, b) => a[0].n.localeCompare(b[0].n),
      rank: (a, b) => (a[0].rank || 999) - (b[0].rank || 999),
    }[sort] || ((a, b) => b[1] - a[1]);
    out.sort(by);
    M.results = out.map((x) => x[0]);
    M.facets = facets;
    M.effectiveSort = sort;
  }

  /* ---------------------------------------------------------- render */
  function pageHtml() {
    return `<section class="discover">
      <div class="hero wrap">
        <h1>Find something to watch</h1>
        <p class="hero-sub" id="msub">Loading the movie library…</p>
      </div>
      <div class="searchbar">
        <div class="wrap">
          <label class="bigsearch">
            ${icon('search')}
            <input id="mq" type="search" placeholder="Search by title, e.g. interstellar or dark knight 2008" autocomplete="off" spellcheck="false" aria-label="Search movies">
            <kbd aria-hidden="true">/</kbd>
          </label>
          <div class="filters" id="mf"></div>
        </div>
      </div>
      <div id="mcont" class="rows"></div>
      <div id="mrows" class="rows"></div>
      <div class="wrap">
        <div class="results-head">
          <span id="mcount" class="count"></span>
          <div class="bar">
            <select id="msort" class="pill" aria-label="Sort"></select>
            <button type="button" id="mposters" class="pill pill-btn" aria-pressed="${M.posters}" title="Posters download small images from the servers. Turn off to save data.">${icon(M.posters ? 'image' : 'image-off')}<span>Posters</span></button>
          </div>
        </div>
        <div id="mgrid" class="posters" aria-live="polite"></div>
        <div id="msentinel" class="sentinel"></div>
      </div>
    </section>`;
  }

  function renderBuilding(st) {
    if (!M.el) return;
    $('#msub', M.el).innerHTML = `<span class="spinner"></span> Building the movie index for the first time… ${st.done || 0} folders scanned`;
    $('#mgrid', M.el).innerHTML = `<div class="skel-posters">${'<div class="skel"></div>'.repeat(12)}</div>`;
  }

  function opt(v, label, cur, n) {
    return `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label)}${n != null ? ` (${n.toLocaleString()})` : ''}</option>`;
  }
  function renderFilters() {
    if (!M.el || !M.groups.length) return;
    compute();
    const f = M.f, F = M.facets;
    const years = [...F.year.keys()].sort((a, b) => b - a);
    const maxY = years[0] || new Date().getFullYear();
    let yOpts = opt('', 'Any year', f.year);
    for (let y = maxY; y >= 2000; y--) if (F.year.get(y)) yOpts += opt(y, y, f.year, F.year.get(y));
    for (let d = 1990; d >= 1950; d -= 10) {
      let n = 0; for (const [y, c] of F.year) if (y >= d && y < d + 10) n += c;
      if (n || f.year === 'd' + d) yOpts += opt('d' + d, d + 's', f.year, n);
    }
    let old = 0; for (const [y, c] of F.year) if (y < 1950) old += c;
    if (old) yOpts += opt('old', 'Before 1950', f.year, old);
    const langs = [...F.lang.entries()].sort((a, b) => b[1] - a[1]);
    if (f.lang && !F.lang.has(f.lang)) langs.push([f.lang, 0]);
    const cats = [...F.cat.entries()].sort((a, b) => b[1] - a[1]);
    if (f.cat && !F.cat.has(f.cat)) cats.push([f.cat, 0]);
    const any = f.genre || f.year || f.lang || f.cat || f.qual || f.dual;
    const genreSel = D.genres ? `<select class="pill${f.genre ? ' on' : ''}" data-f="genre" aria-label="Genre">${opt('', 'Any genre', f.genre)}${Object.keys(D.genres).map((k) => opt(k, k, f.genre, F.genre.get(k) || 0)).join('')}</select>` : '';
    $('#mf', M.el).innerHTML = `${genreSel}
      <select class="pill${f.year ? ' on' : ''}" data-f="year" aria-label="Year">${yOpts}</select>
      <select class="pill${f.lang ? ' on' : ''}" data-f="lang" aria-label="Language">${opt('', 'Any language', f.lang)}${langs.map(([l, n]) => opt(l, l, f.lang, n)).join('')}</select>
      <select class="pill${f.cat ? ' on' : ''}" data-f="cat" aria-label="Category">${opt('', 'All categories', f.cat)}${cats.map(([c, n]) => opt(c, c, f.cat, n)).join('')}</select>
      <select class="pill${f.qual ? ' on' : ''}" data-f="qual" aria-label="Quality">${opt('', 'Any quality', f.qual)}${QUALS.filter((q) => F.qual.get(q) || f.qual === q).map((q) => opt(q, q, f.qual, F.qual.get(q) || 0)).join('')}</select>
      <button type="button" class="pill pill-btn${f.dual ? ' on' : ''}" data-f="dual" aria-pressed="${f.dual}">Dual audio${F.dual ? ` <span class="n">${F.dual.toLocaleString()}</span>` : ''}</button>
      ${any ? `<button type="button" class="linkish" data-f="clear">Clear filters</button>` : ''}`;
    const hasQ = !!D.norm(f.q);
    const sorts = [...(hasQ ? [['relevance', 'Best match']] : []), ['recent', 'Recently added'], ['newest', 'Newest release'], ['oldest', 'Oldest release'], ['title', 'Title A–Z'], ...(f.cat === 'IMDb Top 250' ? [['rank', 'IMDb rank']] : [])];
    const cur = M.effectiveSort;
    $('#msort', M.el).innerHTML = sorts.map(([v, l]) => opt(v, l, cur)).join('');
  }

  function cardHtml(g) {
    const meta = [g.y, [...g.langs][0]].filter(Boolean).join(' · ');
    const q = g.best && g.best !== 'SD' ? `<span class="pq">${esc(g.best)}</span>` : '';
    const rank = g.rank ? `<span class="prank">#${g.rank}</span>` : '';
    const img = M.posters && g.poster
      ? `<img decoding="async" alt="" data-src="/api/poster?${new URLSearchParams({ host: g.poster.host, href: g.poster.href, v: 2 })}">` : '';
    return `<a class="pcard" href="#/movie/${encodeURIComponent(g.key)}" title="${esc(g.t)}${g.y ? ` (${g.y})` : ''}">
      <div class="poster" style="--h:${g.hue}">
        <div class="ptype"><span class="pt-title">${esc(g.t)}</span>${g.y ? `<span class="pt-year">${g.y}</span>` : ''}</div>
        ${img}${q}${rank}
        <span class="pplay">${icon('play')}</span>
      </div>
      <div class="pmeta"><div class="pt">${esc(g.t)}</div><div class="ps">${esc(meta)}${g.versions.length > 1 ? ` · ${g.versions.length} copies` : ''}</div></div>
    </a>`;
  }

  /* Netflix-style rows shown above the grid when nothing is searched or filtered. */
  function rowsDef() {
    const gs = M.groups;
    const byRecent = (list) => list.slice().sort((a, b) => b.m - a.m);
    const maxY = Math.max(...gs.map((g) => g.y || 0));
    const latest = byRecent(gs).slice(0, 24);
    const inLatest = new Set(latest);
    const rows = [
      { title: 'Latest added', sub: 'New on the servers', list: latest },
      { title: 'More new releases', sub: `${maxY - 1}–${maxY}`, list: byRecent(gs.filter((g) => g.y >= maxY - 1 && !inLatest.has(g))), see: { sort: 'newest' } },
      { title: 'IMDb Top 250', list: gs.filter((g) => g.rank).sort((a, b) => a.rank - b.rank), see: { cat: 'IMDb Top 250', sort: 'rank' } },
    ];
    const latestIn = (title, test, see) => rows.push({ title, list: byRecent(gs.filter(test)), see });
    latestIn('Latest Hindi', (g) => g.langs.has('Hindi'), { lang: 'Hindi' });
    latestIn('Latest Bangla', (g) => g.langs.has('Bangla'), { lang: 'Bangla' });
    latestIn('Latest South Indian', (g) => g.cats.has('South Indian') || g.cats.has('South Hindi Dubbed'), { cat: 'South Indian' });
    latestIn('Latest Korean', (g) => g.langs.has('Korean'), { lang: 'Korean' });
    latestIn('Latest Animation', (g) => g.cats.has('Animation') || g.cats.has('Animation 1080p'), { cat: 'Animation' });
    return rows.filter((r) => r.list.length >= 6).map((r) => ({ ...r, list: r.list.slice(0, 24) }));
  }
  function renderRows() {
    const box = $('#mrows', M.el);
    if (!M.groups.length) { box.innerHTML = ''; return; }
    if (!M.rowsHtml) {
      M.rowsDefs = rowsDef();
      M.rowsHtml = M.rowsDefs.map((r, i) => `<section class="rowsec">
        <div class="wrap rowhead"><h2>${esc(r.title)}${r.sub ? ` <span>${esc(r.sub)}</span>` : ''}</h2>
          ${r.see ? `<button type="button" class="linkish" data-see="${i}">See all</button>` : ''}</div>
        <div class="railwrap">
          <button type="button" class="rail-arrow l" data-rail="-1" aria-label="Scroll left">${icon('back')}</button>
          <div class="rail">${r.list.map(cardHtml).join('')}</div>
          <button type="button" class="rail-arrow r" data-rail="1" aria-label="Scroll right">${icon('chev')}</button>
        </div></section>`).join('');
      box.innerHTML = M.rowsHtml;
      watchImgs(box);
    }
  }

  // Load a poster only when its card is about to be seen (native lazy-loading fetches far too early).
  const imgIO = new IntersectionObserver((ents) => {
    for (const e of ents) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      img.src = img.dataset.src;
      img.removeAttribute('data-src');
      imgIO.unobserve(img);
    }
  }, { rootMargin: '250px 120px' });
  const watchImgs = (root) => root.querySelectorAll('img[data-src]').forEach((i) => imgIO.observe(i));

  function renderContinue(show) {
    const box = M.el && $('#mcont', M.el);
    if (!box) return;
    box.hidden = !show;
    box.innerHTML = show && D.foryou ? D.foryou.continueRowHtml() : '';
  }
  document.addEventListener('chobi:history', () => { if (M.el && M.el.isConnected) renderContinue(!$('#mrows', M.el).hidden); });
  document.addEventListener('chobi:genres', () => { if (M.el && M.groups.length) renderFilters(); });

  function update() {
    if (!M.el) return;
    const grid = $('#mgrid', M.el);
    if (M.error) {
      grid.innerHTML = `<div class="error"><b>Could not load the movie library</b>${esc(M.error)}<br><button type="button" class="chip-btn" data-mreload>Try again</button></div>`;
      return;
    }
    if (!M.groups.length) return;
    compute();
    const m = M.meta;
    $('#msub', M.el).textContent = `${m.count.toLocaleString()} movies from ${m.servers} server${m.servers === 1 ? '' : 's'}, updated ${D.fmtDate(m.built).toLowerCase()}.`;
    const n = M.results.length;
    const hasQ = !!D.norm(M.f.q);
    $('#mcount', M.el).innerHTML = hasQ || n !== M.groups.length
      ? `<b>${n.toLocaleString()}</b> ${n === 1 ? 'movie' : 'movies'}${M.fuzzy ? ' <span class="muted">· close matches</span>' : ''}`
      : `<b>Recently added</b>`;
    const browsing = !hasQ && !M.f.genre && !M.f.year && !M.f.lang && !M.f.cat && !M.f.qual && !M.f.dual;
    renderRows();
    $('#mrows', M.el).hidden = !browsing;
    renderContinue(browsing);
    if (browsing) $('#mcount', M.el).innerHTML = `<b>All movies</b> <span class="muted">· ${n.toLocaleString()}</span>`;
    M.shown = 0;
    grid.innerHTML = '';
    if (!n) {
      grid.innerHTML = `<div class="empty"><b>No movies found</b>Try a shorter title, check the spelling, or clear the filters.${M.f.genre || M.f.year || M.f.lang || M.f.cat || M.f.qual || M.f.dual ? '<br><button type="button" class="chip-btn" data-f="clear">Clear filters</button>' : ''}</div>`;
      return;
    }
    more();
  }
  function more() {
    const grid = $('#mgrid', M.el);
    if (M.shown >= M.results.length) return;
    const next = M.results.slice(M.shown, M.shown + CHUNK);
    grid.insertAdjacentHTML('beforeend', next.map(cardHtml).join(''));
    M.shown += next.length;
    watchImgs(grid);
  }

  /* ------------------------------------------------------------ page */
  function ensureEl() {
    if (M.el) return M.el;
    const el = document.createElement('div');
    el.innerHTML = pageHtml();
    M.el = el;
    const q = $('#mq', el);
    let tm;
    q.addEventListener('input', () => {
      clearTimeout(tm);
      tm = setTimeout(() => { M.f.q = q.value; renderFilters(); update(); }, 90);
    });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { q.value = ''; M.f.q = ''; renderFilters(); update(); }
      if (e.key === 'Enter') { const first = $('#mgrid .pcard', el); if (first && M.results.length === 1) first.click(); }
    });
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.f) { M.f[t.dataset.f] = t.value; renderFilters(); update(); }
      if (t.id === 'msort') { M.sort = t.value; if (t.value !== 'relevance') store.set('msort', t.value); renderFilters(); update(); }
    });
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-f],#mposters,[data-mreload],[data-rail],[data-see]');
      if (!t) return;
      if (t.dataset.rail) {
        const rail = t.parentElement.querySelector('.rail');
        rail.scrollBy({ left: +t.dataset.rail * rail.clientWidth * 0.85, behavior: 'smooth' });
        return;
      }
      if (t.dataset.see) {
        const r = M.rowsDefs[+t.dataset.see];
        Object.assign(M.f, { genre: '', year: '', lang: '', cat: '', qual: '', dual: false });
        if (r.see.lang) M.f.lang = r.see.lang;
        if (r.see.cat) M.f.cat = r.see.cat;
        if (r.see.sort) M.sort = r.see.sort;
        renderFilters(); update();
        $('.results-head', M.el).scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (t.dataset.f === 'dual') { M.f.dual = !M.f.dual; renderFilters(); update(); }
      else if (t.dataset.f === 'clear') { Object.assign(M.f, { genre: '', year: '', lang: '', cat: '', qual: '', dual: false }); renderFilters(); update(); }
      else if (t.id === 'mposters') {
        M.posters = !M.posters; store.set('posters', M.posters); M.rowsHtml = null;
        t.setAttribute('aria-pressed', M.posters); t.innerHTML = `${icon(M.posters ? 'image' : 'image-off')}<span>Posters</span>`;
        update();
      } else if ('mreload' in t.dataset) load();
    });
    const io = new IntersectionObserver((ents) => { if (ents.some((x) => x.isIntersecting)) more(); }, { rootMargin: '900px' });
    io.observe($('#msentinel', el));
    return el;
  }

  M.mount = (app) => {
    const el = ensureEl();
    app.replaceChildren(el);
    document.title = 'Chobi · Movies';
    if (!M.groups.length && !M.loading) load();
    else if (M.groups.length && !$('#mgrid', el).children.length) { renderFilters(); update(); }
    else if (M.groups.length) renderContinue(!$('#mrows', el).hidden);
    requestAnimationFrame(() => window.scrollTo(0, M.scrollY || 0));
    if (!M.scrollY && matchMedia('(min-width: 760px)').matches) setTimeout(() => $('#mq', el).focus({ preventScroll: true }), 50);
  };
  M.unmount = () => { M.scrollY = window.scrollY; };
  M.cardHtml = cardHtml;
  M.load = load;
  M.watchImg = (img) => imgIO.observe(img);
  M.showGenre = (genre) => {
    Object.assign(M.f, { q: '', genre, year: '', lang: '', cat: '', qual: '', dual: false });
    M.scrollY = 0;
    if (M.el) $('#mq', M.el).value = '';
    location.hash = '#/';
    setTimeout(() => { renderFilters(); update(); const h = M.el && $('.results-head', M.el); if (h) h.scrollIntoView({ block: 'start' }); }, 60);
  };
  M.focusSearch = () => { const q = M.el && $('#mq', M.el); if (q) { q.focus(); q.select(); } };

  /* ------------------------------------------------------ playback order */
  const canHEVC = (() => {
    try { const v = document.createElement('video'); return !!(v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') || v.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"')); } catch (e) { return false; }
  })();
  D.canHEVC = canHEVC;
  M.playOrder = (versions) => {
    const pref = store.get('qpref', '720p');
    const prefRank = QRANK[pref] || 2;
    return versions.slice().sort((a, b) => {
      const up = (v) => (D.status[v.host] && D.status[v.host].up === false ? 1 : 0);
      const hevc = (v) => (!canHEVC && /x265|hevc|10bit/i.test(v.href) ? 1 : 0);
      return up(a) - up(b) || hevc(a) - hevc(b) || Math.abs(QRANK[a.q] - prefRank) - Math.abs(QRANK[b.q] - prefRank) || QRANK[b.q] - QRANK[a.q];
    });
  };

  /* ---------------------------------------------------------- detail */
  const sheet = $('#sheet');
  M.openDetail = async (key) => {
    if (!M.groups.length) { await load(); }
    const g = M.byKey.get(key);
    if (!g) { sheet.hidden = false; sheet.innerHTML = `<div class="sheet-backdrop" data-close></div><div class="sheet-card"><button class="icon-btn sheet-x" data-close aria-label="Close">${icon('x')}</button><div class="sheet-body"><h2>Movie not found</h2><p class="muted">It may have been moved on the server. Try searching again.</p></div></div>`; return; }
    document.title = `${g.t}${g.y ? ` (${g.y})` : ''} · Chobi`;
    const order = M.playOrder(g.versions);
    const langs = [...g.langs].join(', ');
    const posterImg = g.poster ? `<img alt="" src="/api/poster?${new URLSearchParams({ host: g.poster.host, href: g.poster.href, v: 2 })}">` : '';
    sheet.innerHTML = `<div class="sheet-backdrop" data-close></div>
      <div class="sheet-card" role="dialog" aria-modal="true" aria-label="${esc(g.t)}">
        <button type="button" class="icon-btn sheet-x" data-close aria-label="Close">${icon('x')}</button>
        <div class="sheet-poster"><div class="poster big" style="--h:${g.hue}"><div class="ptype"><span class="pt-title">${esc(g.t)}</span>${g.y ? `<span class="pt-year">${g.y}</span>` : ''}</div>${posterImg}</div></div>
        <div class="sheet-body">
          <h2>${esc(g.t)}</h2>
          <div class="sheet-meta">${[g.y, langs, g.rank ? `IMDb Top 250 #${g.rank}` : '', g.coll].filter(Boolean).map(esc).join('<span class="sep">·</span>')}</div>
          <div class="badges">${[...g.q].sort((a, b) => QRANK[b] - QRANK[a]).map((q) => `<span class="badge q">${esc(q)}</span>`).join('')}${[...g.tags].map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</div>
          <div class="sheet-actions">
            <a class="btn primary" href="${esc(D.watchHash(g.t + (g.y ? ` (${g.y})` : ''), order, g.key))}">${icon('play')}Play</a>
            <button type="button" class="btn" data-dl disabled>${icon('download')}Download</button>
            <button type="button" class="btn ghost" data-vlc disabled title="Opens a small playlist file in VLC or another player">${icon('vlc')}Open in VLC</button>
          </div>
          <p class="hint">Play uses the first copy that responds and moves on to the next if a server is down or the format won't play in the browser.</p>
          <h3>${g.versions.length} ${g.versions.length === 1 ? 'copy' : 'copies'} on the servers</h3>
          <ul class="versions">${order.map((v, i) => versionHtml(v, i)).join('')}</ul>
        </div>
      </div>`;
    sheet.hidden = false;
    document.body.classList.add('noscroll');
    $('.sheet-x', sheet).focus({ preventScroll: true });
    // Fill in file names and sizes.
    const filled = await Promise.all(order.map(async (v, i) => {
      const li = sheet.querySelector(`[data-vi="${i}"]`);
      try {
        let file = v.href, size = v.size, subs = 0;
        if (!v.file) {
          const L = await D.api('list', { host: v.host, href: v.href });
          const vids = L.items.filter((it) => D.typeOf(it.href) === 'video').sort((a, b) => (b.size || 0) - (a.size || 0));
          subs = L.items.filter((it) => D.typeOf(it.href) === 'sub').length;
          if (!vids.length) throw new Error('No video file in this folder');
          file = vids[0].href; size = vids[0].size;
        }
        if (li) fillVersion(li, v, file, size, subs, g);
        return { v, file };
      } catch (e) {
        if (li) li.querySelector('.v-file').innerHTML = `<span class="muted">${esc(e.message)}</span>`;
        return null;
      }
    }));
    const firstOk = filled.find(Boolean);
    if (firstOk && sheet.querySelector('[data-dl]')) {
      const url = D.origUrl(firstOk.v.host, firstOk.file);
      const dl = sheet.querySelector('[data-dl]'); dl.disabled = false; dl.dataset.url = url;
      const vlc = sheet.querySelector('[data-vlc]'); vlc.disabled = false; vlc.dataset.url = D.m3uUrl(firstOk.v.host, firstOk.file, g.t);
    }
  };
  function versionHtml(v, i) {
    return `<li class="version" data-vi="${i}">
      <div class="v-head"><span class="badge q">${esc(v.q || 'Unknown')}</span><span class="v-cat">${esc(v.catName || v.cat)}</span><span class="v-src">${esc(v.source)} · ${esc(D.hostLabel(v.host))}${D.status[v.host] && D.status[v.host].up === false ? ' · <span class="down-t">offline</span>' : ''}</span></div>
      <div class="v-file"><span class="spinner"></span></div>
    </li>`;
  }
  function fillVersion(li, v, file, size, subs, g) {
    const url = D.origUrl(v.host, file);
    const folder = v.file ? file.replace(/[^/]+$/, '') : v.href;
    li.querySelector('.v-file').innerHTML = `<div class="v-name" title="${esc(D.baseName(file))}">${esc(D.baseName(file))}</div>
      <div class="v-info">${esc(D.fmtSize(size))}${subs ? ` · ${subs} subtitle${subs === 1 ? '' : 's'}` : ''}</div>
      <div class="v-acts">
        <a class="act" href="${esc(D.watchHash(g.t + (g.y ? ` (${g.y})` : ''), [{ host: v.host, href: v.file ? file : v.href }], g.key))}" title="Play this copy" aria-label="Play this copy">${icon('play')}</a>
        <a class="act" href="${esc(D.m3uUrl(v.host, file, g.t))}" title="Open in VLC" aria-label="Open in VLC">${icon('vlc')}</a>
        <a class="act" href="${esc(url)}" title="Download" aria-label="Download" download>${icon('download')}</a>
        <button type="button" class="act" data-copy="${esc(url)}" title="Copy link" aria-label="Copy link">${icon('link')}</button>
        <a class="act" href="#/b/${esc(v.host)}${esc(folder)}" title="Open folder" aria-label="Open folder">${icon('folder')}</a>
      </div>`;
  }
  M.closeDetail = () => { sheet.hidden = true; sheet.innerHTML = ''; document.body.classList.remove('noscroll'); };
  sheet.addEventListener('click', (e) => {
    const t = e.target.closest('[data-close],[data-copy],[data-dl],[data-vlc]');
    if (!t) return;
    if ('close' in t.dataset) D.goBack('#/');
    else if (t.dataset.copy) D.copy(t.dataset.copy);
    else if ('dl' in t.dataset && t.dataset.url) window.open(t.dataset.url, '_blank', 'noopener');
    else if ('vlc' in t.dataset && t.dataset.url) location.href = t.dataset.url;
  });
})();
