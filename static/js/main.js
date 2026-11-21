/* Router, theme and global shortcuts.
   Routes:  #/                 movies (discovery)
            #/movie/<key>      movie detail sheet (over the movies page)
            #/watch?t=&v=h|p   player (over the current page)
            #/browse           all categories
            #/b/<host><path>   a folder on a server
            #/servers          add / manage servers
            #/foryou           continue watching + suggestions */
(() => {
  'use strict';
  const D = window.CHOBI;
  const { $, $$, icon, store } = D;
  const app = $('#app');
  let page = null; // {name, mod, key}
  const stack = [location.hash || '#/'];

  D.goBack = (fallback) => {
    if (stack.length > 1) history.back();
    else location.hash = fallback || '#/';
  };

  function parse() {
    const h = location.hash || '#/';
    if (h.startsWith('#/watch?')) return { overlay: 'watch', params: new URLSearchParams(h.slice(8)) };
    let m = /^#\/movie\/(.+)$/.exec(h);
    if (m) return { overlay: 'movie', key: D.dec(m[1]) };
    if (h === '#/browse') return { page: 'browse', route: null };
    m = /^#\/b\/([a-z0-9-]+)(\/.*)?$/i.exec(h);
    if (m) { let href = m[2] || '/'; if (!href.endsWith('/')) href += '/'; return { page: 'browse', route: { host: m[1], href } }; }
    // Old-style folder links from version 1 (#/7/DHAKA-FLIX-7/...)
    m = /^#\/(\d{1,3})(\/.*)$/.exec(h);
    if (m) { location.replace(`#/b/${m[1]}${m[2]}`); return null; }
    if (h === '#/servers') return { page: 'servers' };
    if (h === '#/foryou') return { page: 'foryou' };
    return { page: 'movies' };
  }

  function showPage(name, route) {
    const mod = { movies: D.movies, browse: D.browse, servers: D.servers, foryou: D.foryou }[name];
    const key = name + (route ? `|${route.host}|${route.href}` : '');
    if (page && page.key === key) return;
    if (page && page.mod.unmount) page.mod.unmount();
    page = { name, mod, key };
    $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === name));
    mod.mount(app, route);
  }

  function onRoute() {
    const r = parse();
    if (!r) return;
    if (r.overlay === 'watch') {
      D.movies.closeDetail();
      if (!page) showPage('movies');
      const cands = r.params.getAll('v').map((v) => { const i = v.indexOf('|'); return { host: v.slice(0, i), href: v.slice(i + 1) }; }).filter((c) => c.host && c.href);
      if (!cands.length) { location.replace('#/'); return; }
      D.player.open(r.params.get('t') || 'Video', cands, r.params.get('k') || '');
      document.title = `${r.params.get('t') || 'Video'} · Chobi`;
      return;
    }
    if (D.player.isOpen()) D.player.close();
    if (r.overlay === 'movie') {
      if (!page || page.name !== 'movies') showPage('movies');
      D.movies.openDetail(r.key);
      return;
    }
    D.movies.closeDetail();
    showPage(r.page, r.route);
  }

  window.addEventListener('hashchange', () => {
    const h = location.hash || '#/';
    if (stack.length > 1 && stack[stack.length - 2] === h) stack.pop(); else stack.push(h);
    onRoute();
  });

  /* Theme: system → light → dark */
  function syncTheme() {
    const th = document.documentElement.dataset.theme || 'auto';
    const b = $('#themeBtn');
    b.innerHTML = icon(th === 'light' ? 'sun' : th === 'dark' ? 'moon' : 'auto');
    b.title = `Theme: ${th === 'auto' ? 'follow system' : th}`;
  }
  $('#themeBtn').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const cur = document.documentElement.dataset.theme || 'auto';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    if (next === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
    store.set('theme', next === 'auto' ? null : next);
    syncTheme();
    D.toast(`Theme: ${next === 'auto' ? 'follow system' : next}`);
  });
  syncTheme();

  document.addEventListener('keydown', (e) => {
    if (D.player.isOpen()) return;
    if (e.key === 'Escape' && !$('#sheet').hidden) { D.goBack('#/'); return; }
    if (e.key === '/' && !/input|select|textarea/i.test(document.activeElement.tagName)) {
      e.preventDefault();
      if (page && page.mod.focusSearch) page.mod.focusSearch();
    }
  });

  D.loadPortal().then(() => D.loadStatus());
  D.loadHistory();
  D.loadGenres();
  onRoute();
})();
