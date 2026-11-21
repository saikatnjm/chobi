/* Servers: see connected servers, add a new free FTP/HTTP media server, rebuild the movie index. */
(() => {
  'use strict';
  const D = window.CHOBI;
  const { $, esc, icon } = D;
  const S = (D.servers = { app: null, detect: null, busy: false, pollTm: null });
  const SECTIONS = ['Movies', 'TV Series', 'Games', 'Software', 'Other'];
  const KIND = { h5ai: 'h5ai file index', autoindex: 'plain directory listing', dhakaflix: 'DhakaFlix portal + h5ai', portal: 'portal page' };

  async function render() {
    if (!S.app) return;
    let sources = [], errors = [], idx = null;
    try { ({ sources, errors } = await D.api('sources')); } catch (e) { errors = [e.message]; }
    try { idx = await D.api('movies/status'); } catch (e) { /* ignore */ }
    if (!S.app) return;
    const catsBySource = {};
    if (D.portal) for (const list of Object.values(D.portal.sections)) for (const c of list) (catsBySource[c.source] = catsBySource[c.source] || []).push(c);
    const hostsBySource = {};
    if (D.portal) for (const [id, h] of Object.entries(D.portal.hosts)) (hostsBySource[h.source] = hostsBySource[h.source] || []).push(id);

    S.app.innerHTML = `<div class="wrap page narrow">
      <div class="page-head"><div><h1 class="page-title">Servers</h1>
        <p class="page-sub">Connect any free BDIX media server. Movies from every server appear together on the Movies page, and Play moves to the next server if one is down.</p></div></div>

      <section class="panel">
        <h2>Add a server</h2>
        <p class="muted">Paste the address of a page that lists folders, for example <code>http://10.16.100.244/</code> or a folder like <code>http://server/Movies/</code>. h5ai indexes and ordinary Apache/nginx directory listings both work.</p>
        <form class="addform" id="detectForm" autocomplete="off">
          <input id="srvUrl" type="text" inputmode="url" placeholder="http://…" aria-label="Server address" spellcheck="false" value="${esc(S.lastUrl || '')}">
          <button type="submit" class="btn primary" ${S.busy ? 'disabled' : ''}>${S.busy ? '<span class="spinner"></span>Checking…' : `${icon('search')}Check`}</button>
        </form>
        <div id="detectOut">${detectHtml()}</div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>Movie index</h2>
          <button type="button" class="btn sm" data-reindex ${idx && idx.building ? 'disabled' : ''}>${icon('refresh')}${idx && idx.building ? 'Indexing…' : 'Rebuild now'}</button></div>
        <p class="muted">${idx ? (idx.building ? `<span class="spinner"></span> Scanning folders… ${idx.done} of ${idx.queued} done.` : idx.ready ? `${idx.count.toLocaleString()} movie files indexed, last updated ${esc(D.fmtDate(idx.built).toLowerCase())}. It updates itself once a day.` : 'Not built yet.') : ''}
        ${idx && idx.errors && idx.errors.length ? `<br>${idx.errors.length} folder${idx.errors.length === 1 ? '' : 's'} could not be read last time.` : ''}</p>
      </section>

      <section class="panel">
        <h2>Connected servers</h2>
        ${errors.map((e) => `<p class="warn">${esc(e)}</p>`).join('')}
        <ul class="srv-list">${sources.map((s) => {
          const on = s.enabled !== false;
          const cats = catsBySource[s.name] || [];
          const hosts = hostsBySource[s.name] || [];
          const up = hosts.filter((h) => D.status[h] && D.status[h].up).length;
          return `<li class="srv${on ? '' : ' off'}">
            <div class="srv-main">
              <div class="srv-name">${icon('server')}${esc(s.name)}</div>
              <div class="srv-meta">${esc(KIND[s.type] || s.type)}${on ? ` · ${cats.length} categor${cats.length === 1 ? 'y' : 'ies'} · ${hosts.length ? `${up} of ${hosts.length} host${hosts.length === 1 ? '' : 's'} online` : 'no hosts'}` : ' · disabled in sources.json'}</div>
              ${on && hosts.length ? `<div class="srv-hosts">${hosts.map((h) => `<span class="status"><span class="dot ${D.status[h] ? (D.status[h].up ? 'up' : 'down') : ''}"></span>${esc(D.hostLabel(h))}</span>`).join('')}</div>` : ''}
            </div>
            ${s.id && s.type !== 'dhakaflix' ? `<button type="button" class="icon-btn" data-remove="${esc(s.id)}" data-name="${esc(s.name)}" title="Remove" aria-label="Remove ${esc(s.name)}">${icon('trash')}</button>` : ''}
          </li>`;
        }).join('')}</ul>
        <p class="muted small">Servers are saved in <code>sources.json</code> next to <code>server.py</code>. You can also edit that file by hand.</p>
      </section>
    </div>`;
    if (idx && idx.building) poll();
  }

  function detectHtml() {
    const d = S.detect;
    if (!d) return '';
    if (d.error) return `<p class="warn">${esc(d.error)}</p>`;
    if (d.kind === 'portal') {
      return `<div class="detect"><p>This page links to other listings rather than showing folders itself. Pick one to check:</p>
        <ul class="linklist">${d.links.slice(0, 40).map((l) => `<li><button type="button" class="linkish" data-try="${esc(l)}">${esc(D.dec(l))}</button></li>`).join('')}</ul></div>`;
    }
    const host = d.base.replace(/^https?:\/\//, '');
    // A folder full of "Title (Year)" folders is itself a movie category.
    const movieLike = d.folders.length && d.folders.filter((f) => /\((19|20)\d\d\)/.test(f.name)).length > d.folders.length / 2;
    return `<form class="detect" id="addForm">
      <p class="ok-t">${icon('server')} Found a <b>${esc(KIND[d.kind] || d.kind)}</b> at ${esc(host)}${esc(D.dec(d.href))}.</p>
      <label class="field"><span>Name</span><input id="srvName" type="text" value="${esc(host)}" maxlength="60"></label>
      <div class="folders">
        <label class="frow fthis"><input type="checkbox" data-self ${!d.folders.length || movieLike ? 'checked' : ''}><span class="fname">This folder itself (${esc(D.dec(d.href))})</span>
          <select data-self-sec>${SECTIONS.map((s) => `<option${s === 'Movies' ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
        ${d.folders.map((f, i) => `<label class="frow"><input type="checkbox" data-fi="${i}" ${!movieLike && f.section !== 'Other' ? 'checked' : ''}><span class="fname">${esc(f.name)}</span>
          <select data-fs="${i}">${SECTIONS.map((s) => `<option${s === f.section ? ' selected' : ''}>${s}</option>`).join('')}</select></label>`).join('')}
      </div>
      <p class="muted small">Folders marked <b>Movies</b> are scanned into the movie index (year folders, language folders and collections inside them are understood).</p>
      <button type="submit" class="btn primary">${icon('plus')}Add server</button>
    </form>`;
  }

  async function detect(url) {
    S.lastUrl = url; S.busy = true; S.detect = null;
    renderDetectOnly();
    try { S.detect = await D.api('detect', { url }); }
    catch (e) { S.detect = { error: e.message }; }
    S.busy = false;
    renderDetectOnly();
  }
  function renderDetectOnly() {
    const btn = $('#detectForm button');
    if (btn) { btn.disabled = S.busy; btn.innerHTML = S.busy ? '<span class="spinner"></span>Checking…' : `${icon('search')}Check`; }
    const out = $('#detectOut'); if (out) out.innerHTML = detectHtml();
  }

  async function add() {
    const d = S.detect;
    const cats = [];
    if ($('[data-self]').checked) cats.push({ name: D.baseName(d.href) || $('#srvName').value, href: d.href, section: $('[data-self-sec]').value });
    d.folders.forEach((f, i) => {
      if ($(`[data-fi="${i}"]`).checked) cats.push({ name: f.name, href: f.href, section: $(`[data-fs="${i}"]`).value });
    });
    if (!cats.length) return D.toast('Tick at least one folder');
    try {
      await D.api('sources', null, { method: 'POST', body: { name: $('#srvName').value, kind: d.kind, base: d.base, categories: cats } });
      D.toast('Server added. Rebuilding the movie index…', 3000);
      S.detect = null; S.lastUrl = '';
      await D.loadPortal(); D.loadStatus();
      render();
    } catch (e) { D.toast(e.message, 4000); }
  }

  function poll() {
    clearTimeout(S.pollTm);
    S.pollTm = setTimeout(async () => {
      let st;
      try { st = await D.api('movies/status'); } catch (e) { return; }
      if (st.building) { if (S.app) render(); else poll(); }
      else { D.movies.reload(); if (S.app) render(); D.toast(`Movie index ready: ${st.count.toLocaleString()} files`); }
    }, 2000);
  }

  S.mount = (app) => {
    S.app = app;
    document.title = 'Chobi · Servers';
    app.innerHTML = `<div class="wrap page narrow"><div class="skel" style="height:240px;margin-top:24px"></div></div>`;
    render();
    D.loadStatus().then(() => S.app && render());
  };
  S.unmount = () => { S.app = null; };

  document.addEventListener('submit', (e) => {
    if (!S.app) return;
    if (e.target.id === 'detectForm') { e.preventDefault(); const u = $('#srvUrl').value.trim(); if (u) detect(u); }
    if (e.target.id === 'addForm') { e.preventDefault(); add(); }
  });
  document.addEventListener('click', async (e) => {
    if (!S.app) return;
    const t = e.target.closest('[data-try],[data-remove],[data-reindex]');
    if (!t) return;
    if (t.dataset.try) { $('#srvUrl').value = t.dataset.try; detect(t.dataset.try); }
    else if (t.dataset.remove) {
      if (!confirm(`Remove ${t.dataset.name}? Its movies leave the index after the next rebuild.`)) return;
      try { await D.api('sources', { id: t.dataset.remove }, { method: 'DELETE' }); await D.loadPortal(); render(); poll(); }
      catch (err) { D.toast(err.message); }
    } else if ('reindex' in t.dataset) {
      try { await D.api('movies/reindex', null, { method: 'POST', body: {} }); render(); poll(); } catch (err) { D.toast(err.message); }
    }
  });
})();
