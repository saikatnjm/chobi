/* Browse: every category on every server (TV series, games, software…) as folders and files. */
(() => {
  'use strict';
  const D = window.CHOBI;
  const { $, esc, dec, icon, store, isDir, baseName } = D;
  const PAGE = 400;
  const SECTION_ICON = { movies: 'film', 'tv series': 'tv', games: 'game', software: 'app' };

  const B = (D.browse = {
    view: store.get('view', 'grid'),
    sort: store.get('sort', { key: 'name', dir: 1 }),
    route: null, listing: null, search: null, filter: '', shown: PAGE, reqId: 0, app: null,
  });
  const routeHash = (host, href) => `#/b/${host}${href}`;

  function categories() {
    const out = [];
    if (!D.portal) return out;
    for (const [section, list] of Object.entries(D.portal.sections)) for (const c of list) out.push({ ...c, section });
    return out;
  }
  function categoryFor(host, href) {
    let best = null;
    for (const c of categories()) if (c.host === host && href.startsWith(c.href) && (!best || c.href.length > best.href.length)) best = c;
    return best;
  }
  function addRecent(host, href) {
    if (href.split('/').length < 4) return;
    const list = store.get('recent', []).filter((r) => !(r.host === host && r.href === href));
    list.unshift({ host, href, name: baseName(href) });
    store.set('recent', list.slice(0, 8));
  }

  /* --------------------------------------------------------- badges */
  function badgesFor(name, type) {
    const out = [];
    const yr = /\((19[2-9]\d|20[0-4]\d)\)/.exec(name) || /[.\s](19[3-9]\d|20[0-4]\d)[.\s]/.exec(name);
    if (yr && name.replace(yr[0], '').replace(/[&\s]|before|after/gi, '').length > 2) out.push(['', yr[1]]);
    const q = /\b(2160p|4k|1080p|720p|480p)\b/i.exec(name);
    if (q) out.push(['q', q[1].toLowerCase() === '4k' ? '4K' : q[1].toLowerCase()]);
    if (/dual[\s.-]?audio/i.test(name)) out.push(['', 'Dual Audio']);
    if (/\b(x265|hevc)\b/i.test(name)) out.push(['', 'HEVC']);
    if (type === 'folder') {
      const s = /\bS(\d{1,2})\b|season\s*(\d+)/i.exec(name);
      if (s) out.push(['', 'Season ' + Number(s[1] || s[2])]);
    } else { const e = D.extOf(name); if (e) out.push(['ext', e]); }
    return out;
  }
  const badgeHtml = (b) => (b.length ? `<div class="badges">${b.map(([c, t]) => `<span class="badge ${c}">${esc(t)}</span>`).join('')}</div>` : '');

  /* --------------------------------------------------------- items */
  function decorate(host, items) { return items.map((it) => ({ ...it, host: it.host || host, name: baseName(it.href), type: D.typeOf(it.href) })); }
  function sortItems(items) {
    const { key, dir } = B.sort;
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return items.slice().sort((a, b) => {
      const da = isDir(a.href), db = isDir(b.href);
      if (da !== db) return da ? -1 : 1;
      let r = 0;
      if (key === 'time') r = (a.time || 0) - (b.time || 0);
      else if (key === 'size') r = (a.size || 0) - (b.size || 0);
      if (r === 0) r = coll.compare(a.name, b.name);
      return r * dir;
    });
  }
  function filterItems(items, f) {
    const toks = D.norm(f).split(' ').filter(Boolean);
    if (!toks.length) return items;
    return items.filter((it) => { const n = D.norm(it.name); return toks.every((t) => n.includes(t)); });
  }
  function itemLink(it) {
    if (it.type === 'folder') return `href="${esc(routeHash(it.host, it.href))}"`;
    if (it.type === 'video') return `href="${esc(D.watchHash(it.name, [{ host: it.host, href: it.href }]))}"`;
    return `href="${esc(D.origUrl(it.host, it.href))}" target="_blank" rel="noopener"`;
  }
  function actions(it) {
    const url = D.origUrl(it.host, it.href);
    if (it.type === 'folder') return `<a class="act" href="${esc(url)}" target="_blank" rel="noopener" title="Open on the original server" aria-label="Open original">${icon('external')}</a>`;
    return `${it.type === 'video' ? `<a class="act" href="${esc(D.m3uUrl(it.host, it.href, it.name))}" title="Open in VLC" aria-label="Open in VLC">${icon('vlc')}</a>` : ''}
      <button type="button" class="act" data-copy="${esc(url)}" title="Copy link" aria-label="Copy link">${icon('link')}</button>
      <a class="act" href="${esc(url)}" title="Download" aria-label="Download" download>${icon('download')}</a>`;
  }
  function relPath(it, base) {
    const parent = it.href.replace(/[^/]+\/?$/, '');
    const rel = parent.startsWith(base) ? parent.slice(base.length) : parent;
    return dec(rel).replace(/\/$/, '').split('/').filter(Boolean).join(' › ');
  }
  function cardHtml(it, base) {
    const meta = it.type === 'folder' ? D.fmtDate(it.time) : D.fmtSize(it.size);
    const sub = base != null ? relPath(it, base) : '';
    return `<div class="card t-${it.type}">
      <a class="card-main" ${itemLink(it)} title="${esc(it.name)}">
        <div class="ico">${icon(it.type)}${it.type === 'video' ? `<span class="ico-play">${icon('play')}</span>` : ''}</div>
        <div class="card-body">
          <div class="card-name">${esc(it.name)}</div>
          ${sub ? `<div class="path">${esc(sub)}</div>` : ''}
          ${badgeHtml(badgesFor(it.name, it.type))}
          <div class="card-meta"><span>${esc(meta)}</span>${it.type !== 'folder' ? `<span>${esc(D.fmtDate(it.time))}</span>` : ''}</div>
        </div>
      </a>
      <div class="card-acts">${actions(it)}</div>
    </div>`;
  }
  function rowHtml(it, base) {
    const b = badgesFor(it.name, it.type).filter((x) => x[0] !== 'ext');
    const sub = base != null ? relPath(it, base) : '';
    return `<div class="row t-${it.type}">
      <a class="ico" ${itemLink(it)} tabindex="-1" aria-hidden="true">${icon(it.type)}</a>
      <a class="row-name" ${itemLink(it)} title="${esc(it.name)}">
        <span class="n">${esc(it.name)}</span>
        ${sub ? `<span class="path">${esc(sub)}</span>` : ''}
        ${b.length || it.size != null ? `<div class="badges">${b.map(([c, t]) => `<span class="badge ${c}">${esc(t)}</span>`).join('')}<span class="badge m-only">${esc(D.fmtSize(it.size))}</span></div>` : ''}
      </a>
      <span class="d">${esc(D.fmtDate(it.time))}</span>
      <span class="s">${esc(D.fmtSize(it.size))}</span>
      <div class="row-acts">${actions(it)}</div>
    </div>`;
  }
  function sortHead(key, label) {
    const on = B.sort.key === key;
    return `<button type="button" data-sort="${key}">${label}${on ? `<span class="sort-ind">${B.sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</button>`;
  }
  function itemsHtml(items, base) {
    if (B.view === 'list') {
      return `<div class="list">
        <div class="row head"><span></span>${sortHead('name', 'Name')}<span class="h-d">${sortHead('time', 'Modified')}</span><span class="s">${sortHead('size', 'Size')}</span><span class="h-a"></span></div>
        ${items.map((it) => rowHtml(it, base)).join('')}</div>`;
    }
    return `<div class="grid">${items.map((it) => cardHtml(it, base)).join('')}</div>`;
  }
  function crumbsHtml(host, href) {
    const segs = href.split('/').filter(Boolean);
    let acc = '/';
    let html = `<nav class="crumbs" aria-label="Breadcrumb"><a href="#/browse">Browse</a>${icon('chev')}<a href="${esc(routeHash(host, '/'))}">${esc(D.hostLabel(host))}</a>`;
    segs.forEach((s, i) => {
      acc += s + '/';
      html += icon('chev') + (i === segs.length - 1 ? `<span class="here">${esc(dec(s))}</span>` : `<a href="${esc(routeHash(host, acc))}">${esc(dec(s))}</a>`);
    });
    return html + '</nav>';
  }
  const SORTS = [['name:1', 'Name A–Z'], ['name:-1', 'Name Z–A'], ['time:-1', 'Newest first'], ['time:1', 'Oldest first'], ['size:-1', 'Largest first'], ['size:1', 'Smallest first']];
  function toolsHtml(count, total, placeholder, searchLabel) {
    const cur = `${B.sort.key}:${B.sort.dir}`;
    return `<div class="btools">
      <form class="search" data-bsearch autocomplete="off">
        ${icon('search', 'search-ico')}
        <input id="bq" type="search" placeholder="${esc(placeholder)}" value="${esc(B.search ? B.search.q : B.filter)}" aria-label="Filter or search" spellcheck="false">
        <button type="submit" class="search-go" title="Search every subfolder on the server">${esc(searchLabel)}</button>
      </form>
      <div class="bar">
        ${total != null ? `<span class="count">${count === total ? `${total} item${total === 1 ? '' : 's'}` : `${count} of ${total}`}</span>` : ''}
        <select class="pill" id="bsort" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <div class="seg" role="group" aria-label="Layout">
          <button type="button" class="icon-btn" data-view="grid" aria-pressed="${B.view === 'grid'}" title="Grid view" aria-label="Grid view">${icon('grid')}</button>
          <button type="button" class="icon-btn" data-view="list" aria-pressed="${B.view === 'list'}" title="List view" aria-label="List view">${icon('list')}</button>
        </div>
      </div>
    </div>`;
  }
  const moreHtml = (n) => (n > B.shown ? `<div class="more-wrap"><button type="button" class="chip-btn" data-more>Show ${Math.min(PAGE, n - B.shown)} more (${n - B.shown} left)</button></div>` : '');

  /* --------------------------------------------------------- pages */
  function renderHome() {
    const st = D.status;
    const hosts = D.portal ? Object.keys(D.portal.hosts) : [];
    const recent = store.get('recent', []);
    const f = D.norm(B.filter);
    let html = `<div class="wrap page"><div class="page-head"><div><h1 class="page-title">Browse</h1>
      <p class="page-sub">Every folder on every server: TV series, games, software and more. Press Enter in the box to search inside all of them.</p></div></div>
      ${B.search ? '' : toolsHtml(0, null, 'Filter categories, or press Enter to search all servers…', 'Search')}
      <div class="status-row">${hosts.length ? hosts.map((h) => {
        const s = st[h];
        return `<span class="status" title="${s ? (s.up ? `Responded in ${s.ms} ms` : 'Not responding') : 'Checking…'}"><span class="dot ${s ? (s.up ? 'up' : 'down') : ''}"></span>${esc(D.portal.hosts[h].source)} · ${esc(D.hostLabel(h))}${s && !s.up ? ' · offline' : ''}</span>`;
      }).join('') : '<span class="status"><span class="spinner"></span>Checking servers…</span>'}</div>`;
    if (B.search) { B.app.innerHTML = html + globalHtml() + '</div>'; return; }
    if (recent.length && !f) {
      html += `<section class="section"><h2>${icon('clock')}Recently opened</h2><div class="recents">
        ${recent.map((r) => `<a class="recent" href="${esc(routeHash(r.host, r.href))}" title="${esc(dec(r.href))}">${icon('folder')}<span>${esc(r.name)}</span></a>`).join('')}</div></section>`;
    }
    if (!D.portal) html += `<div class="skel-grid">${'<div class="skel" style="height:72px"></div>'.repeat(8)}</div>`;
    else {
      const by = {};
      categories().filter((c) => !f || D.norm(c.name + ' ' + c.section + ' ' + c.source).includes(f)).forEach((c) => (by[c.section] = by[c.section] || []).push(c));
      if (!Object.keys(by).length) html += `<div class="empty">No category matches “${esc(B.filter)}”. Press Enter to search inside every server.</div>`;
      for (const [s, list] of Object.entries(by)) {
        const ic = SECTION_ICON[s.toLowerCase()] || 'more';
        html += `<section class="section"><h2>${icon(ic)}${esc(s)}</h2><div class="cats">${list.map((c) => {
          const hs = st[c.host], off = hs && !hs.up;
          return `<a class="cat${off ? ' offline' : ''}" href="${esc(routeHash(c.host, c.href))}"><span class="cat-ico">${icon(ic)}</span>
            <span><div class="cat-name">${esc(c.name)}</div><div class="cat-meta"><span class="dot ${hs ? (hs.up ? 'up' : 'down') : ''}"></span>${esc(c.source)} · ${esc(D.hostLabel(c.host))}${off ? ' · offline' : ''}</div></span></a>`;
        }).join('')}</div></section>`;
      }
      (D.portal.errors || []).forEach((e) => (html += `<p class="page-sub">${esc(e)}</p>`));
    }
    B.app.innerHTML = html + '</div>';
  }

  function globalHtml() {
    const S = B.search;
    let html = `<div class="banner"><span>${S.pending ? `<span class="spinner"></span> Searching ${S.pending} server${S.pending === 1 ? '' : 's'}…` : `${S.total} result${S.total === 1 ? '' : 's'} for <b>“${esc(S.q)}”</b> across all servers`}${S.errors.length ? ` · ${S.errors.length} could not be searched` : ''}</span>
      <button type="button" class="chip-btn" data-clear-search>${icon('x')}Clear search</button></div>`;
    if (!S.pending && !S.results.length) html += `<div class="empty">Nothing found for “${esc(S.q)}”.</div>`;
    const groups = new Map();
    for (const it of S.results) {
      const c = categoryFor(it.host, it.href);
      const key = c ? `${c.name} · ${c.source}` : D.hostLabel(it.host);
      if (!groups.has(key)) groups.set(key, { c, list: [] });
      groups.get(key).list.push(it);
    }
    for (const [name, g] of groups) {
      const sorted = sortItems(g.list);
      html += `<h3 class="group-title">${esc(name)} <span class="badge">${g.list.length}</span></h3>` + itemsHtml(sorted.slice(0, 60), g.c ? g.c.href : '/');
      if (sorted.length > 60 && g.c) html += `<div class="more-wrap"><a class="chip-btn" href="${esc(routeHash(g.c.host, g.c.href))}">Open ${esc(g.c.name)}</a></div>`;
    }
    return html;
  }

  function renderFolder() {
    const { host, href } = B.route;
    const L = B.listing;
    const cat = categoryFor(host, href);
    const title = href === '/' ? D.hostLabel(host) : baseName(href);
    const parent = href === '/' ? null : href.replace(/[^/]+\/$/, '');
    let html = `<div class="wrap page"><div class="page-head"><div style="min-width:0">${crumbsHtml(host, href)}<h1 class="page-title">${esc(title)}</h1>
      ${cat && cat.href !== href ? `<div class="page-sub">in ${esc(cat.name)}</div>` : ''}</div>
      ${parent ? `<div class="bar"><a class="chip-btn" href="${esc(routeHash(host, parent))}">${icon('up')}Up</a><a class="chip-btn" href="${esc(D.origUrl(host, href))}" target="_blank" rel="noopener">${icon('external')}Original</a></div>` : ''}</div>`;
    const kind = D.portal && D.portal.hosts[host] ? D.portal.hosts[host].kind : 'h5ai';
    const searchLabel = kind === 'h5ai' ? 'Search all' : 'Filter';
    if (B.search) {
      const S = B.search;
      const items = sortItems(S.results);
      html += toolsHtml(items.length, items.length, 'Filter this folder…', searchLabel);
      html += `<div class="banner"><span>${S.pending ? '<span class="spinner"></span> Searching' : `${S.total} result${S.total === 1 ? '' : 's'}`} for <b>“${esc(S.q)}”</b> in every subfolder</span>
        <button type="button" class="chip-btn" data-clear-search>${icon('x')}Clear search</button></div>`;
      if (S.error) html += `<div class="error"><b>Search failed</b>${esc(S.error)}</div>`;
      else if (!S.pending && !items.length) html += `<div class="empty">Nothing named like “${esc(S.q)}” below this folder.</div>`;
      else html += itemsHtml(items.slice(0, B.shown), href) + moreHtml(items.length);
      B.app.innerHTML = html + '</div>';
      return;
    }
    if (!L || L.loading || L.error) {
      html += toolsHtml(0, null, 'Filter this folder…', searchLabel);
      html += L && L.error
        ? `<div class="error"><b>Could not open this folder</b>${esc(L.error)}<br><button type="button" class="chip-btn" data-retry>Try again</button> <a class="chip-btn" href="${esc(D.origUrl(host, href))}" target="_blank" rel="noopener">${icon('external')}Open original</a></div>`
        : `<div class="skel-grid">${'<div class="skel"></div>'.repeat(12)}</div>`;
      B.app.innerHTML = html + '</div>';
      return;
    }
    const all = sortItems(L.items);
    const items = filterItems(all, B.filter);
    html += toolsHtml(items.length, all.length, 'Filter this folder…', searchLabel);
    if (!all.length) html += `<div class="empty">${L.exists === false ? 'This folder does not exist on the server.' : 'This folder is empty.'}</div>`;
    else if (!items.length) html += `<div class="empty">Nothing in this folder matches “${esc(B.filter)}”.${kind === 'h5ai' ? `<br><button type="button" class="chip-btn" data-deep>${icon('search')}Search all subfolders</button>` : ''}</div>`;
    else html += itemsHtml(items.slice(0, B.shown), null) + moreHtml(items.length);
    B.app.innerHTML = html + '</div>';
  }

  function render() {
    if (!B.app) return;
    const focused = document.activeElement && document.activeElement.id === 'bq';
    const caret = focused ? document.activeElement.selectionStart : null;
    if (!B.route) renderHome(); else renderFolder();
    if (focused) { const q = $('#bq'); if (q) { q.focus(); try { q.setSelectionRange(caret, caret); } catch (e) {} } }
  }

  /* --------------------------------------------------------- data */
  async function loadListing() {
    const { host, href } = B.route;
    const id = ++B.reqId;
    B.listing = { loading: true };
    render();
    try {
      const data = await D.api('list', { host, href });
      if (id !== B.reqId) return;
      B.listing = { ...data, items: decorate(host, data.items) };
      addRecent(host, href);
    } catch (e) {
      if (id !== B.reqId) return;
      B.listing = { error: e.message };
    }
    render();
  }

  async function runSearch(q) {
    q = q.trim();
    if (q.length < 2) return D.toast('Type at least 2 characters to search');
    const id = ++B.reqId;
    B.shown = PAGE;
    if (B.route) {
      const { host, href } = B.route;
      const kind = D.portal && D.portal.hosts[host] ? D.portal.hosts[host].kind : 'h5ai';
      if (kind !== 'h5ai') { B.filter = q; return render(); }
      B.search = { q, pending: 1, results: [], total: 0, errors: [] };
      render();
      try {
        const d = await D.api('search', { host, href, q });
        if (id !== B.reqId) return;
        B.search = { q, pending: 0, results: decorate(host, d.items), total: d.total, errors: [] };
      } catch (e) {
        if (id !== B.reqId) return;
        B.search = { q, pending: 0, results: [], total: 0, errors: [], error: e.message };
      }
      return render();
    }
    if (q.length < 3) return D.toast('Type at least 3 characters to search every server');
    // One recursive search per server root (h5ai servers only).
    const roots = {};
    for (const c of categories()) {
      const h = D.portal.hosts[c.host];
      if (!h || h.kind !== 'h5ai' || (D.status[c.host] && D.status[c.host].up === false)) continue;
      const seg = c.href.split('/')[1];
      if (seg && !roots[c.host]) roots[c.host] = `/${seg}/`;
    }
    const list = Object.entries(roots);
    B.search = { q, pending: list.length, results: [], total: 0, errors: [] };
    render();
    await Promise.all(list.map(async ([host, href]) => {
      try {
        const d = await D.api('search', { host, href, q });
        if (id !== B.reqId) return;
        B.search.results.push(...decorate(host, d.items)); B.search.total += d.total;
      } catch (e) { if (id === B.reqId) B.search.errors.push(host); }
      if (id === B.reqId) { B.search.pending--; render(); }
    }));
  }

  /* --------------------------------------------------------- mount */
  B.mount = (app, route) => {
    B.app = app;
    const same = route && B.route && route.host === B.route.host && route.href === B.route.href;
    if (!same || !route) { B.search = null; B.filter = ''; B.shown = PAGE; }
    B.route = route;
    document.title = route ? `${baseName(route.href)} · Chobi` : 'Chobi · Browse';
    if (route) { if (!same || !B.listing || B.listing.error) loadListing(); else render(); }
    else { render(); if (!Object.keys(D.status).length) D.loadStatus(); }
    window.scrollTo(0, 0);
  };
  B.unmount = () => { B.app = null; B.reqId++; };
  B.focusSearch = () => { const q = $('#bq'); if (q) { q.focus(); q.select(); } };
  document.addEventListener('chobi:portal', () => B.app && render());
  document.addEventListener('chobi:status', () => B.app && !B.route && render());

  let ft;
  document.addEventListener('input', (e) => {
    if (!B.app || e.target.id !== 'bq') return;
    clearTimeout(ft);
    ft = setTimeout(() => {
      B.filter = e.target.value.trim(); B.shown = PAGE;
      if (B.search && !e.target.value) B.search = null;
      if (!B.search) render();
    }, 70);
  });
  document.addEventListener('keydown', (e) => {
    if (!B.app || e.target.id !== 'bq' || e.key !== 'Escape') return;
    e.target.value = ''; B.filter = ''; B.search = null; render();
  });
  document.addEventListener('submit', (e) => {
    if (!B.app || !e.target.matches('[data-bsearch]')) return;
    e.preventDefault(); runSearch($('#bq').value);
  });
  document.addEventListener('change', (e) => {
    if (!B.app || e.target.id !== 'bsort') return;
    const [key, dir] = e.target.value.split(':');
    B.sort = { key, dir: Number(dir) }; store.set('sort', B.sort); render();
  });
  document.addEventListener('click', (e) => {
    if (!B.app) return;
    const t = e.target.closest('#app [data-copy],#app [data-sort],#app [data-more],#app [data-retry],#app [data-clear-search],#app [data-deep],#app [data-view]');
    if (!t) return;
    if (t.dataset.copy) { e.preventDefault(); D.copy(t.dataset.copy); }
    else if (t.dataset.view) { B.view = t.dataset.view; store.set('view', B.view); render(); }
    else if (t.dataset.sort) {
      const k = t.dataset.sort;
      B.sort = { key: k, dir: B.sort.key === k ? -B.sort.dir : k === 'name' ? 1 : -1 }; store.set('sort', B.sort); render();
    } else if ('more' in t.dataset) { B.shown += PAGE; render(); }
    else if ('retry' in t.dataset) loadListing();
    else if ('clearSearch' in t.dataset) { B.search = null; B.reqId++; B.filter = ''; render(); }
    else if ('deep' in t.dataset) runSearch($('#bq').value);
  });
})();
