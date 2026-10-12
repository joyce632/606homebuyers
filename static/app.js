/* 606 Home Buyers — front end. Public pages (home, deal) and the team dashboard (/team). */
(() => {
  'use strict';

  const STATUSES = [
    { key: 'active', label: 'Active' },
    { key: 'pending', label: 'Pending' },
    { key: 'sold', label: 'Sold' },
    { key: 'closed', label: 'Closed' },
  ];
  const STATUS_LABEL = Object.fromEntries(STATUSES.map(s => [s.key, s.label]));
  const TYPES = ['Single family', '2-flat', '3-flat', '4-unit', '5+ units', 'Condo', 'Townhome', 'Mixed use', 'Vacant land'];
  const OCC = ['Vacant', 'Tenant occupied', 'Owner occupied', 'Partially occupied'];
  const ROLES = { admin: 'Admin', editor: 'Editor' };

  const S = {
    deals: [], loaded: false, loadError: false,
    settings: { phone: '', email: '', buyersListUrl: '' },
    user: null, csrf: null,
    filter: 'all', q: '', sort: 'new',
    tab: 'deals', dashQ: '', dashFilter: 'all',
  };

  /* ---------- helpers ---------- */
  const $ = id => document.getElementById(id);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  }
  function icon(name, cls) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (cls) s.setAttribute('class', cls);
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', '#' + (name.startsWith('logo') ? name : 'i-' + name));
    s.append(u);
    return s;
  }
  const isNum = n => n !== null && n !== undefined && n !== '' && !isNaN(n);
  const money = n => isNum(n) ? '$' + Math.round(Number(n)).toLocaleString('en-US') : '—';
  const numf = n => isNum(n) ? Number(n).toLocaleString('en-US') : '—';
  const photoUrl = (id, thumb) => '/photos/' + id + (thumb ? '_t' : '') + '.jpg';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  function ago(t) {
    if (!t) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtDate(d) {
    if (!d) return '—';
    const [y, m, dd] = d.split('-').map(Number);
    if (!y) return d;
    return new Date(y, m - 1, dd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function locLine(d) {
    const cityzip = (d.city || 'Chicago') + ', IL' + (d.zip ? ' ' + d.zip : '');
    return [d.area, cityzip].filter(Boolean).join(' · ');
  }
  let toastT;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
  }
  const pill = status => h('span', { class: 'pill st-' + status, text: STATUS_LABEL[status] || status });

  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (S.csrf) opts.headers['X-CSRF-Token'] = S.csrf;
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(url, opts); }
    catch { throw new Error('Could not reach the server. Check your connection and try again.'); }
    let data = {};
    try { data = await r.json(); } catch {}
    if (!r.ok) {
      const e = new Error(data.error || 'Something went wrong. Try again.');
      e.status = r.status;
      if (r.status === 401 && S.user) { S.user = null; S.csrf = null; renderChrome(); }
      throw e;
    }
    return data;
  }

  function copyText(text, done) {
    const fallback = () => {
      const ta = h('textarea', { class: 'sprite' }); ta.value = text;
      document.body.append(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch {}
      ta.remove(); ok ? done() : toast('Copy is blocked in this browser. Select the text and copy it yourself.');
    };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch { fallback(); }
  }

  /* ---------- data ---------- */
  async function loadDeals() {
    try {
      const d = await api('GET', '/api/deals');
      S.deals = d.deals; S.loaded = true; S.loadError = false;
    } catch { S.loaded = true; S.loadError = true; }
  }
  async function loadSettings() {
    try { S.settings = (await api('GET', '/api/settings')).settings; } catch {}
  }
  async function loadMe() {
    try { const d = await api('GET', '/api/me'); S.user = d.user; S.csrf = d.csrf || null; } catch {}
  }
  const findDeal = id => S.deals.find(d => d.id === id);

  /* ---------- routing ---------- */
  function go(url, opts = {}) {
    if (url !== location.pathname + location.hash) history.pushState({}, '', url);
    route(opts);
  }
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(a.getAttribute('href'));
  });
  window.addEventListener('popstate', () => route({ keepScroll: true }));

  function route(opts = {}) {
    const path = location.pathname;
    const m = path.match(/^\/deal\/([A-Za-z0-9]+)$/);
    const view = m ? 'deal' : path === '/team' ? 'team' : 'home';
    $('view-home').hidden = view !== 'home';
    $('view-deal').hidden = view !== 'deal';
    $('view-team').hidden = view !== 'team';
    renderChrome();
    if (view === 'home') { renderHome(); document.title = '606 Home Buyers | Off-market deals in Chicagoland'; }
    if (view === 'deal') renderDealPage(m[1]);
    if (view === 'team') { renderTeam(); document.title = 'Team | 606 Home Buyers'; }
    if (location.hash && view === 'home') {
      const el = document.getElementById(location.hash.slice(1));
      if (el) requestAnimationFrame(() => el.scrollIntoView());
    } else if (!opts.keepScroll) window.scrollTo(0, 0);
  }

  function renderChrome() {
    const hasContact = !!(S.settings.phone || S.settings.email);
    $('btn-contact').hidden = !hasContact;
    $('btn-dashboard').hidden = !S.user;
    const b = $('hero-buyers');
    if (S.settings.buyersListUrl) { b.href = S.settings.buyersListUrl; b.hidden = false; $('hero-how').hidden = true; }
    else { b.hidden = true; $('hero-how').hidden = false; }
  }

  /* ---------- contact ---------- */
  function openContact(deal) {
    const body = $('dc-body'); body.replaceChildren();
    if (deal) body.append(h('p', { class: 'muted', text: `About ${deal.address}. Mention the address when you reach out.` }));
    if (S.settings.phone) body.append(h('div', { class: 'contact-row' }, icon('phone'),
      h('a', { href: 'tel:' + S.settings.phone.replace(/[^\d+]/g, ''), text: S.settings.phone }),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(S.settings.phone, () => toast('Phone number copied')) }, 'Copy')));
    if (S.settings.email) {
      const subj = deal ? '?subject=' + encodeURIComponent('Interested in ' + deal.address) : '';
      body.append(h('div', { class: 'contact-row' }, icon('mail'),
        h('a', { href: 'mailto:' + S.settings.email + subj, text: S.settings.email }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(S.settings.email, () => toast('Email copied')) }, 'Copy')));
    }
    if (S.settings.buyersListUrl) body.append(h('a', { class: 'btn btn-primary', href: S.settings.buyersListUrl, target: '_blank', rel: 'noopener' }, 'Join our buyers list'));
    $('dlg-contact').showModal();
  }
  $('btn-contact').addEventListener('click', () => openContact(null));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $('dlg-contact').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  /* ---------- home ---------- */
  S.filter = store.get('606.filter') || 'all';
  S.sort = store.get('606.sort') || 'new';
  $('sort').value = S.sort;
  $('q').addEventListener('input', e => { S.q = e.target.value; renderHome(); });
  $('sort').addEventListener('change', e => { S.sort = e.target.value; store.set('606.sort', S.sort); renderHome(); });

  function counts(list) {
    const c = { all: list.length };
    for (const s of STATUSES) c[s.key] = list.filter(d => d.status === s.key).length;
    return c;
  }

  function sortDeals(list, sort) {
    const p = d => (isNum(d.price) ? Number(d.price) : null);
    if (sort === 'low') list.sort((a, b) => (p(a) ?? 1e15) - (p(b) ?? 1e15));
    else if (sort === 'high') list.sort((a, b) => (p(b) ?? -1) - (p(a) ?? -1));
    else list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return list;
  }
  function matches(d, q) {
    q = q.trim().toLowerCase();
    return !q || [d.address, d.city, d.zip, d.area, d.county, d.type].filter(Boolean).join(' ').toLowerCase().includes(q);
  }

  function dealCard(d) {
    const photos = d.photos || [];
    const facts = [];
    if (isNum(d.beds)) facts.push(h('li', {}, h('b', { text: numf(d.beds) }), ' bd'));
    if (isNum(d.baths)) facts.push(h('li', {}, h('b', { text: numf(d.baths) }), ' ba'));
    if (isNum(d.sqft)) facts.push(h('li', {}, h('b', { text: numf(d.sqft) }), ' sq ft'));
    if (isNum(d.units) && d.units > 1) facts.push(h('li', {}, h('b', { text: numf(d.units) }), ' units'));
    return h('a', { class: 'card', href: '/deal/' + d.id, 'data-link': true },
      h('div', { class: 'media' },
        photos.length ? h('img', { src: photoUrl(photos[0], true), alt: '', loading: 'lazy' }) : h('div', { class: 'noimg' }, icon('house')),
        pill(d.status),
        photos.length > 1 ? h('span', { class: 'pcount' }, icon('cam'), String(photos.length)) : null),
      h('div', { class: 'card-body' },
        h('div', { class: 'price-row' },
          h('span', { class: 'price', text: money(d.price) }),
          isNum(d.arv) ? h('span', { class: 'arv', text: 'ARV ' + money(d.arv) }) : null),
        h('div', { class: 'addr', text: d.address || 'Untitled deal' }),
        h('div', { class: 'loc', text: locLine(d) }),
        facts.length ? h('ul', { class: 'facts' }, facts) : null,
        h('div', { class: 'card-foot' },
          h('span', { class: 'tag', text: d.type || '' }),
          h('span', { text: 'Updated ' + ago(d.updatedAt) }))));
  }

  function renderHome() {
    const c = counts(S.deals);
    if (S.loaded) for (const s of STATUSES) $('hs-' + s.key).textContent = c[s.key];

    const seg = $('seg'); seg.replaceChildren();
    for (const o of [{ key: 'all', label: 'All' }, ...STATUSES]) {
      seg.append(h('button', {
        type: 'button', 'aria-pressed': String(S.filter === o.key),
        onclick: () => { S.filter = o.key; store.set('606.filter', o.key); renderHome(); },
      }, o.key !== 'all' ? h('span', { class: 'dot st-' + o.key }) : null, o.label, h('span', { class: 'count', text: c[o.key] })));
    }

    const grid = $('grid'), empty = $('empty-slot');
    grid.replaceChildren(); empty.replaceChildren();
    if (!S.loaded) { for (let i = 0; i < 3; i++) grid.append(h('div', { class: 'card skeleton' }, h('div', { class: 'media' }))); return; }
    if (S.loadError) { empty.append(h('div', { class: 'notice' }, icon('info'), h('span', { text: 'Deals could not be loaded. Refresh the page to try again.' }))); return; }
    if (!S.deals.length) {
      empty.append(h('div', { class: 'empty' }, h('div', { class: 'noimg' }, icon('house')),
        h('h2', { text: 'New deals are on the way' }),
        h('p', { text: (S.settings.phone || S.settings.email) ? 'There are no properties listed right now. Contact us to hear about the next one first.' : 'There are no properties listed right now. Check back soon.' })));
      return;
    }
    const list = sortDeals(S.deals.filter(d => (S.filter === 'all' || d.status === S.filter) && matches(d, S.q)), S.sort);
    if (!list.length) { empty.append(h('div', { class: 'empty' }, h('p', { text: 'No deals match this filter.' }))); return; }
    for (const d of list) grid.append(dealCard(d));
  }

  /* ---------- single deal ---------- */
  let viewIdx = 0, viewId = null;
  function renderDealPage(id) {
    const root = $('view-deal');
    if (viewId !== id) { viewIdx = 0; viewId = id; }
    const d = findDeal(id);
    root.replaceChildren(h('a', { class: 'crumb', href: '/#available', 'data-link': true }, icon('left'), 'All deals'));
    if (!S.loaded) return;
    if (!d) {
      root.append(h('div', { class: 'empty' }, h('h2', { text: 'This deal is no longer listed' }), h('p', { text: 'It may have been removed. See the current deals instead.' })));
      return;
    }
    document.title = `${d.address} | 606 Home Buyers`;
    const photos = d.photos || [];
    if (viewIdx >= photos.length) viewIdx = 0;

    const stage = h('div', { class: 'stage' });
    if (photos.length) {
      stage.append(h('img', { src: photoUrl(photos[viewIdx]), alt: `Photo ${viewIdx + 1} of ${d.address}` }));
      if (photos.length > 1) stage.append(
        h('button', { class: 'nav-arrow prev', type: 'button', 'aria-label': 'Previous photo', onclick: () => step(-1) }, icon('left')),
        h('button', { class: 'nav-arrow next', type: 'button', 'aria-label': 'Next photo', onclick: () => step(1) }, icon('right')),
        h('span', { class: 'pcount num', text: `${viewIdx + 1} / ${photos.length}` }));
    } else stage.append(h('div', { class: 'noimg' }, icon('house')));
    const thumbs = photos.length > 1 ? h('div', { class: 'thumbs' }, photos.map((p, i) =>
      h('button', { type: 'button', 'aria-current': String(i === viewIdx), 'aria-label': 'Photo ' + (i + 1), onclick: () => { viewIdx = i; renderDealPage(id); } },
        h('img', { src: photoUrl(p, true), alt: '', loading: 'lazy' })))) : null;

    const kv = [
      ['Beds', numf(d.beds)], ['Baths', numf(d.baths)], ['Sq ft', numf(d.sqft)],
      ['Type', d.type || '—'], ['Units', numf(d.units)], ['Year built', d.year || '—'],
      ['Lot', d.lot || '—'], ['Occupancy', d.occupancy || '—'], ['County', d.county || '—'],
    ];
    const nums = [['Asking price', money(d.price)]];
    if (isNum(d.repairs)) nums.push(['Est. repairs', money(d.repairs)]);
    if (isNum(d.arv)) nums.push(['ARV', money(d.arv)]);
    if (isNum(d.rent)) nums.push(['Monthly rent', money(d.rent)]);
    if (isNum(d.emd)) nums.push(['Earnest money', money(d.emd)]);
    if (d.closeBy) nums.push(['Close by', fmtDate(d.closeBy)]);
    const spread = isNum(d.arv) && isNum(d.price) ? d.arv - d.price - (Number(d.repairs) || 0) : null;
    const hl = (d.highlights || '').split('\n').map(s => s.trim()).filter(Boolean);
    const hasContact = !!(S.settings.phone || S.settings.email);

    const side = h('aside', { class: 'side' },
      h('div', { class: 'box' },
        h('h2', { text: 'The numbers' }),
        h('div', { class: 'numbers' },
          nums.map(([k, v]) => h('div', { class: 'line' }, h('span', { text: k }), h('span', { text: v }))),
          spread != null ? h('div', { class: 'line total' }, h('span', { text: 'Spread after repairs' }), h('span', { text: money(spread) })) : null),
        h('div', { class: 'actions' },
          hasContact && d.status === 'active' ? h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => openContact(d) }, 'Contact us about this deal') : null,
          h('button', { class: 'btn', type: 'button', onclick: () => copyText(location.origin + '/deal/' + d.id, () => toast('Link copied')) }, icon('link'), 'Copy link'))),
      S.user ? teamBox(d) : null);

    root.append(
      h('div', { class: 'deal-head' },
        h('div', {}, pill(d.status), h('h1', { text: d.address }), h('div', { class: 'loc', text: locLine(d) })),
        h('div', {}, h('div', { class: 'price', text: money(d.price) }), isNum(d.arv) ? h('span', { class: 'arv', text: 'ARV ' + money(d.arv) }) : null)),
      h('div', { class: 'deal-layout' },
        h('div', {},
          h('div', { class: 'gallery' }, stage, thumbs),
          h('div', { class: 'prose' },
            h('dl', { class: 'kv' }, kv.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: String(v) })))),
            d.description ? h('div', {}, h('div', { class: 'section-label', text: 'About this property' }), h('p', { class: 'desc', text: d.description })) : null,
            hl.length ? h('div', {}, h('div', { class: 'section-label', text: 'Highlights' }), h('ul', { class: 'hl' }, hl.map(x => h('li', { text: x })))) : null)),
        side));
  }
  function teamBox(d) {
    const fee = isNum(d.price) && isNum(d.contractPrice) ? d.price - d.contractPrice : null;
    const lines = [];
    if (isNum(d.contractPrice)) lines.push(['Contract price', money(d.contractPrice)]);
    if (d.sellerName) lines.push(['Seller', d.sellerName]);
    if (d.sellerPhone) lines.push(['Seller phone', d.sellerPhone]);
    if (d.access) lines.push(['Access', d.access]);
    const sel = h('select', { class: 'select', 'aria-label': 'Change status' }, STATUSES.map(s => h('option', { value: s.key, text: s.label })));
    sel.value = d.status;
    sel.addEventListener('change', () => saveStatus(d.id, sel.value));
    return h('div', { class: 'box box-private' },
      h('h2', {}, icon('lock'), 'Team only'),
      lines.length || fee != null ? h('div', { class: 'numbers' },
        lines.map(([k, v]) => h('div', { class: 'line' }, h('span', { text: k }), h('span', { text: v }))),
        fee != null ? h('div', { class: 'line total' }, h('span', { text: 'Assignment fee' }), h('span', { text: money(fee) })) : null) : null,
      d.internalNotes ? h('p', { class: 'desc', text: d.internalNotes }) : null,
      h('label', { class: 'field' }, h('span', { class: 'hint', text: 'Status' }), sel),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openEdit(d.id) }, icon('edit'), 'Edit deal'),
        h('button', { class: 'btn', type: 'button', onclick: () => copyBlast(d) }, icon('copy'), 'Copy for buyer blast')));
  }
  function step(n) {
    const d = findDeal(viewId); if (!d || !(d.photos || []).length) return;
    viewIdx = (viewIdx + n + d.photos.length) % d.photos.length; renderDealPage(viewId);
  }
  document.addEventListener('keydown', e => {
    if ($('view-deal').hidden || document.querySelector('dialog[open]') || e.target.matches('input, select, textarea')) return;
    if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1);
  });

  function copyBlast(d) {
    const parts = [];
    parts.push(`${(STATUS_LABEL[d.status] || '').toUpperCase()} DEAL | ${d.type || 'Property'} | ${locLine(d)}`);
    parts.push(d.address || '');
    const n = [`Price: ${money(d.price)}`];
    if (isNum(d.arv)) n.push(`ARV: ${money(d.arv)}`);
    if (isNum(d.repairs)) n.push(`Est. repairs: ${money(d.repairs)}`);
    parts.push(n.join(' | '));
    const f = [];
    if (isNum(d.beds)) f.push(`${d.beds} bd`);
    if (isNum(d.baths)) f.push(`${d.baths} ba`);
    if (isNum(d.sqft)) f.push(`${numf(d.sqft)} sq ft`);
    if (isNum(d.units) && d.units > 1) f.push(`${d.units} units`);
    if (d.year) f.push(`Built ${d.year}`);
    if (f.length) parts.push(f.join(' / '));
    if (d.occupancy) parts.push(`Occupancy: ${d.occupancy}`);
    if (isNum(d.rent)) parts.push(`Rent: ${money(d.rent)}/mo`);
    if (d.closeBy) parts.push(`Close by: ${fmtDate(d.closeBy)}`);
    if (d.description) parts.push('', d.description);
    parts.push('', 'Photos and details: ' + location.origin + '/deal/' + d.id);
    parts.push('Sold as-is. Contact 606 Home Buyers' + (S.settings.phone ? ' at ' + S.settings.phone : '') + '.');
    copyText(parts.join('\n'), () => toast('Copied. Paste it into your buyer text or email blast.'));
  }

  async function saveStatus(id, status) {
    try {
      const r = await api('PATCH', `/api/deals/${id}/status`, { status });
      upsertDeal(r.deal); toast('Status set to ' + STATUS_LABEL[status]); route({ keepScroll: true });
    } catch (e) { toast(e.message); }
  }
  function upsertDeal(d) {
    const i = S.deals.findIndex(x => x.id === d.id);
    if (i >= 0) S.deals[i] = d; else S.deals.unshift(d);
  }

  /* ---------- deal editor ---------- */
  const F = id => $('f-' + id);
  F('type').append(h('option', { value: '', text: 'Choose…' }), ...TYPES.map(t => h('option', { value: t, text: t })));
  F('occ').append(h('option', { value: '', text: 'Choose…' }), ...OCC.map(t => h('option', { value: t, text: t })));
  F('status').append(...STATUSES.map(s => h('label', {},
    h('input', { type: 'radio', name: 'status', value: s.key, id: 'f-st-' + s.key }), h('span', { class: 'pill st-' + s.key, text: s.label }))));

  const NUMS = { beds: 'beds', baths: 'baths', sqft: 'sqft', year: 'year', units: 'units', price: 'price', arv: 'arv', repairs: 'repairs', rent: 'rent', emd: 'emd', contract: 'contractPrice' };
  const TEXTS = { address: 'address', city: 'city', zip: 'zip', area: 'area', county: 'county', lot: 'lot', type: 'type', occ: 'occupancy', close: 'closeBy', access: 'access', desc: 'description', hl: 'highlights', seller: 'sellerName', sellerphone: 'sellerPhone', notes: 'internalNotes' };
  let editOrig = null, photos = [], sessionUploads = new Set(), uploading = 0;

  function openEdit(id) {
    const d = id ? findDeal(id) : null;
    editOrig = d;
    $('de-title').textContent = d ? 'Edit deal' : 'Add deal';
    $('de-save').textContent = d ? 'Save changes' : 'Post deal';
    for (const [f, k] of Object.entries(TEXTS)) F(f).value = d?.[k] ?? (f === 'city' && !d ? 'Chicago' : f === 'county' && !d ? 'Cook' : '');
    for (const [f, k] of Object.entries(NUMS)) F(f).value = d?.[k] ?? '';
    $('f-st-' + (d?.status || 'active')).checked = true;
    photos = [...(d?.photos || [])];
    sessionUploads = new Set();
    $('de-err').hidden = true; $('ph-err').hidden = true;
    renderPhotos();
    $('dlg-edit').showModal();
    $('dlg-edit').querySelector('.dlg-body').scrollTop = 0;
  }
  function renderPhotos() {
    const box = F('photos'); box.replaceChildren();
    photos.forEach((p, i) => box.append(h('div', { class: 'ph' },
      h('img', { src: photoUrl(p, true), alt: 'Photo ' + (i + 1) }),
      i === 0 ? h('span', { class: 'cover', text: 'Cover' }) : null,
      h('div', { class: 'acts' },
        i > 0 ? h('button', { type: 'button', onclick: () => { photos.unshift(...photos.splice(i, 1)); renderPhotos(); } }, 'Make cover') : h('span'),
        h('button', { type: 'button', 'aria-label': 'Remove photo ' + (i + 1), onclick: () => { photos.splice(i, 1); renderPhotos(); } }, 'Remove')))));
    for (let i = 0; i < uploading; i++) box.append(h('div', { class: 'ph loading', text: 'Uploading…' }));
  }
  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 2.5e6) return file;
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.9));
    } catch { return file; }
  }
  async function addFiles(files) {
    const list = [...files];
    $('ph-err').hidden = true;
    uploading += list.length; renderPhotos();
    for (const f of list) {
      try {
        const fd = new FormData();
        fd.append('file', await shrink(f), f.name || 'photo.jpg');
        const r = await api('POST', '/api/photos', fd);
        photos.push(r.id); sessionUploads.add(r.id);
      } catch (e) { $('ph-err').hidden = false; $('ph-err').textContent = `${f.name}: ${e.message}`; }
      uploading--; renderPhotos();
    }
  }
  const drop = $('drop');
  drop.addEventListener('click', () => F('files').click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); F('files').click(); } });
  F('files').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });

  function closeEdit() {
    for (const id of sessionUploads) api('DELETE', '/api/photos/' + id).catch(() => {});
    sessionUploads = new Set();
    $('dlg-edit').close();
  }
  $('de-x').addEventListener('click', closeEdit);
  $('de-cancel').addEventListener('click', closeEdit);
  $('dlg-edit').addEventListener('cancel', e => { e.preventDefault(); closeEdit(); });

  $('deal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('de-err');
    if (!F('address').value.trim()) { err.hidden = false; err.textContent = 'Add a street address.'; F('address').focus(); return; }
    if (uploading) { err.hidden = false; err.textContent = 'Wait for photos to finish uploading.'; return; }
    err.hidden = true;
    const body = {};
    for (const [f, k] of Object.entries(TEXTS)) body[k] = F(f).value.trim() || null;
    for (const [f, k] of Object.entries(NUMS)) body[k] = F(f).value === '' ? null : Number(F(f).value);
    body.status = document.querySelector('input[name="status"]:checked')?.value || 'active';
    body.photos = photos.slice();
    const btn = $('de-save'); btn.disabled = true;
    try {
      const r = editOrig ? await api('PUT', '/api/deals/' + editOrig.id, body) : await api('POST', '/api/deals', body);
      upsertDeal(r.deal);
      sessionUploads = new Set();
      $('dlg-edit').close();
      toast(editOrig ? 'Deal saved' : 'Deal posted');
      route({ keepScroll: true });
    } catch (ex) { err.hidden = false; err.textContent = ex.message; }
    btn.disabled = false;
  });

  /* ---------- team area ---------- */
  function renderTeam() {
    const root = $('view-team'); root.replaceChildren();
    if (!S.user) return root.append(loginForm());
    if (S.user.mustChange) return root.append(passwordForm(true));
    const tabs = [['deals', 'Deals']];
    if (S.user.role === 'admin') tabs.push(['users', 'Users'], ['settings', 'Site settings']);
    tabs.push(['account', 'My account']);
    if (!tabs.some(t => t[0] === S.tab)) S.tab = 'deals';
    root.append(
      h('div', { class: 'dash-head' },
        h('div', {}, h('h1', { text: 'Dashboard' }), h('p', { text: `Signed in as ${S.user.name} (${ROLES[S.user.role]})` })),
        h('div', { class: 'hero-cta' },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openEdit(null) }, icon('plus'), 'Add deal'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: logout }, 'Sign out'))),
      h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, label]) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(S.tab === k), onclick: () => { S.tab = k; renderTeam(); } }, label))),
    );
    const body = h('div', {});
    root.append(body);
    if (S.tab === 'deals') body.append(dashDeals());
    if (S.tab === 'users') dashUsers(body);
    if (S.tab === 'settings') body.append(dashSettings());
    if (S.tab === 'account') body.append(passwordForm(false));
  }

  function loginForm() {
    const err = h('div', { class: 'err', hidden: true });
    const email = h('input', { class: 'input', id: 'lg-email', type: 'email', autocomplete: 'username', required: true });
    const pw = h('input', { class: 'input', id: 'lg-pw', type: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Sign in');
    return h('form', { class: 'auth', onsubmit: async e => {
      e.preventDefault(); err.hidden = true; btn.disabled = true;
      try {
        const r = await api('POST', '/api/login', { email: email.value, password: pw.value });
        S.user = r.user; S.csrf = r.csrf;
        await loadDeals(); route();
      } catch (ex) { err.hidden = false; err.textContent = ex.message; }
      btn.disabled = false;
    } },
      icon('logo-mark', 'brand-mark'),
      h('h1', { text: 'Team sign-in' }),
      h('p', { text: 'For the 606 Home Buyers team. Ask an admin if you need an account.' }),
      h('div', { class: 'field' }, h('label', { for: 'lg-email', text: 'Email' }), email),
      h('div', { class: 'field' }, h('label', { for: 'lg-pw', text: 'Password' }), pw),
      err, btn);
  }

  function passwordForm(forced) {
    const err = h('div', { class: 'err', hidden: true });
    const cur = h('input', { class: 'input', id: 'pw-cur', type: 'password', autocomplete: 'current-password', required: true });
    const nw = h('input', { class: 'input', id: 'pw-new', type: 'password', autocomplete: 'new-password', minlength: '10', required: true });
    const nw2 = h('input', { class: 'input', id: 'pw-new2', type: 'password', autocomplete: 'new-password', required: true });
    const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, forced ? 'Set password and continue' : 'Change password');
    const form = h('form', { class: forced ? 'auth' : 'panel narrow', onsubmit: async e => {
      e.preventDefault(); err.hidden = true;
      if (nw.value !== nw2.value) { err.hidden = false; err.textContent = "The new passwords don't match."; return; }
      if (nw.value.length < 10) { err.hidden = false; err.textContent = 'Use at least 10 characters.'; return; }
      btn.disabled = true;
      try {
        await api('POST', '/api/password', { current: cur.value, new: nw.value });
        S.user.mustChange = false; toast('Password updated'); renderTeam();
      } catch (ex) { err.hidden = false; err.textContent = ex.message; }
      btn.disabled = false;
    } });
    const fields = [
      h('div', { class: 'field' }, h('label', { for: 'pw-cur', text: forced ? 'Temporary password' : 'Current password' }), cur),
      h('div', { class: 'field' }, h('label', { for: 'pw-new', text: 'New password' }), nw, h('span', { class: 'hint', text: 'At least 10 characters.' })),
      h('div', { class: 'field' }, h('label', { for: 'pw-new2', text: 'Repeat new password' }), nw2),
      err, btn];
    if (forced) form.append(icon('logo-mark', 'brand-mark'), h('h1', { text: 'Set your password' }),
      h('p', { text: `Welcome, ${S.user.name}. Replace your temporary password before you continue.` }), ...fields);
    else form.append(h('div', { class: 'panel-head' }, h('h2', { text: 'Change password' })), h('div', { class: 'panel-body' }, ...fields));
    return form;
  }

  async function logout() {
    try { await api('POST', '/api/logout'); } catch {}
    S.user = null; S.csrf = null;
    await loadDeals();
    go('/');
  }

  function dashDeals() {
    const wrap = h('div', {});
    const c = counts(S.deals);
    const seg = h('div', { class: 'seg' }, [{ key: 'all', label: 'All' }, ...STATUSES].map(o =>
      h('button', { type: 'button', 'aria-pressed': String(S.dashFilter === o.key), onclick: () => { S.dashFilter = o.key; renderTeam(); } },
        o.key !== 'all' ? h('span', { class: 'dot st-' + o.key }) : null, o.label, h('span', { class: 'count', text: c[o.key] }))));
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Search deals', 'aria-label': 'Search deals', value: S.dashQ });
    const tbody = h('tbody', {});
    const fill = () => {
      tbody.replaceChildren();
      const list = sortDeals(S.deals.filter(d => (S.dashFilter === 'all' || d.status === S.dashFilter) && matches(d, S.dashQ)), 'new');
      if (!list.length) tbody.append(h('tr', {}, h('td', { colspan: '8', class: 'muted', text: S.deals.length ? 'No deals match.' : 'No deals yet. Click Add deal to post your first one.' })));
      for (const d of list) {
        const sel = h('select', { class: 'select', 'aria-label': 'Status for ' + d.address }, STATUSES.map(s => h('option', { value: s.key, text: s.label })));
        sel.value = d.status;
        sel.addEventListener('change', () => saveStatus(d.id, sel.value));
        const fee = isNum(d.price) && isNum(d.contractPrice) ? d.price - d.contractPrice : null;
        const acts = h('div', { class: 'row-acts' });
        const resetActs = () => acts.replaceChildren(
          h('a', { class: 'btn btn-sm', href: '/deal/' + d.id, 'data-link': true }, 'View'),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openEdit(d.id) }, 'Edit'),
          h('button', { class: 'btn btn-sm btn-ghost btn-danger', type: 'button', onclick: () => acts.replaceChildren(
            h('div', { class: 'confirm' }, h('span', { text: 'Delete deal and photos?' }),
              h('button', { class: 'btn btn-sm', type: 'button', onclick: resetActs }, 'Keep'),
              h('button', { class: 'btn btn-sm btn-danger-solid', type: 'button', onclick: () => delDeal(d) }, 'Delete'))) }, 'Delete'));
        resetActs();
        tbody.append(h('tr', {},
          h('td', {}, d.photos?.length ? h('img', { class: 'thumb', src: photoUrl(d.photos[0], true), alt: '' }) : h('div', { class: 'thumb noimg' }, icon('house'))),
          h('td', {}, h('div', { class: 'addr', text: d.address }), h('div', { class: 'loc', text: locLine(d) })),
          h('td', {}, sel),
          h('td', { class: 'r', text: money(d.price) }),
          h('td', { class: 'r', text: money(d.arv) }),
          h('td', { class: 'r', text: fee != null ? money(fee) : '—' }),
          h('td', { class: 'muted', text: ago(d.updatedAt) }),
          h('td', {}, acts)));
      }
    };
    q.addEventListener('input', () => { S.dashQ = q.value; fill(); });
    fill();
    wrap.append(h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, seg, h('div', { class: 'search' }, icon('search'), q)),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['', 'Property', 'Status', 'Price', 'ARV', 'Assignment fee', 'Updated', ''].map((t, i) => h('th', { class: [3, 4, 5].includes(i) ? 'r' : null, text: t })))),
        tbody))));
    return wrap;
  }
  async function delDeal(d) {
    try {
      await api('DELETE', '/api/deals/' + d.id);
      S.deals = S.deals.filter(x => x.id !== d.id);
      toast('Deal deleted'); renderTeam();
    } catch (e) { toast(e.message); }
  }

  async function dashUsers(body) {
    const secretSlot = h('div', {});
    const err = h('div', { class: 'err', hidden: true });
    const name = h('input', { class: 'input', id: 'nu-name', required: true, autocomplete: 'off' });
    const email = h('input', { class: 'input', id: 'nu-email', type: 'email', required: true, autocomplete: 'off' });
    const role = h('select', { class: 'select', id: 'nu-role' }, h('option', { value: 'editor', text: 'Editor: manages deals' }), h('option', { value: 'admin', text: 'Admin: deals, users and settings' }));
    const listBody = h('tbody', {}, h('tr', {}, h('td', { colspan: '5', class: 'muted', text: 'Loading…' })));

    const showSecret = (who, pw) => secretSlot.replaceChildren(h('div', { class: 'secret' },
      h('strong', { text: `Temporary password for ${who}:` }), h('code', { text: pw }),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(pw, () => toast('Password copied')) }, icon('copy'), 'Copy'),
      h('p', { text: `Send it to them privately with the sign-in link ${location.origin}/team. They'll set their own password when they first sign in. This password won't be shown again.` })));

    const add = h('form', { class: 'panel', onsubmit: async e => {
      e.preventDefault(); err.hidden = true;
      try {
        const r = await api('POST', '/api/users', { name: name.value, email: email.value, role: role.value });
        showSecret(r.user.name, r.tempPassword);
        name.value = ''; email.value = '';
        load();
      } catch (ex) { err.hidden = false; err.textContent = ex.message; }
    } },
      h('div', { class: 'panel-head' }, h('h2', { text: 'Add a user' })),
      h('div', { class: 'panel-body' },
        h('div', { class: 'grid-form' },
          h('div', { class: 'field' }, h('label', { for: 'nu-name', text: 'Name' }), name),
          h('div', { class: 'field' }, h('label', { for: 'nu-email', text: 'Email' }), email),
          h('div', { class: 'field' }, h('label', { for: 'nu-role', text: 'Role' }), role),
          h('button', { class: 'btn btn-primary', type: 'submit' }, icon('plus'), 'Create account')),
        err, secretSlot));

    body.append(add, h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', { text: 'Users' })),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Name', 'Role', 'Status', 'Last sign-in', ''].map(t => h('th', { text: t })))), listBody))));

    async function load() {
      let users;
      try { users = (await api('GET', '/api/users')).users; }
      catch (e) { listBody.replaceChildren(h('tr', {}, h('td', { colspan: '5', class: 'err', text: e.message }))); return; }
      listBody.replaceChildren();
      for (const u of users) {
        const me = u.id === S.user.id;
        const rsel = h('select', { class: 'select', 'aria-label': 'Role for ' + u.name, disabled: me }, Object.entries(ROLES).map(([k, v]) => h('option', { value: k, text: v })));
        rsel.value = u.role;
        rsel.addEventListener('change', () => patch(u, { role: rsel.value }));
        const acts = h('div', { class: 'row-acts' });
        const resetActs = () => acts.replaceChildren(
          h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
            try { const r = await api('POST', `/api/users/${u.id}/reset`); showSecret(u.name, r.tempPassword); window.scrollTo(0, 0); }
            catch (e) { toast(e.message); } } }, 'Reset password'),
          me ? null : h('button', { class: 'btn btn-sm', type: 'button', onclick: () => patch(u, { active: !u.active }) }, u.active ? 'Disable' : 'Enable'),
          me ? null : h('button', { class: 'btn btn-sm btn-ghost btn-danger', type: 'button', onclick: () => acts.replaceChildren(
            h('div', { class: 'confirm' }, h('span', { text: `Remove ${u.name}?` }),
              h('button', { class: 'btn btn-sm', type: 'button', onclick: resetActs }, 'Keep'),
              h('button', { class: 'btn btn-sm btn-danger-solid', type: 'button', onclick: async () => {
                try { await api('DELETE', '/api/users/' + u.id); toast(`${u.name} removed`); load(); } catch (e) { toast(e.message); } } }, 'Remove'))) }, 'Remove'));
        resetActs();
        listBody.append(h('tr', {},
          h('td', {}, h('div', { class: 'addr', text: u.name + (me ? ' (you)' : '') }), h('div', { class: 'loc', text: u.email })),
          h('td', {}, rsel),
          h('td', {}, h('span', { class: 'badge ' + (u.active ? (u.mustChange ? '' : 'on') : 'off'), text: !u.active ? 'Disabled' : u.mustChange ? 'Invited' : 'Active' })),
          h('td', { class: 'muted', text: u.lastLogin ? ago(u.lastLogin) : 'Never' }),
          h('td', {}, acts)));
      }
    }
    async function patch(u, change) {
      try { await api('PATCH', '/api/users/' + u.id, change); toast('User updated'); } catch (e) { toast(e.message); }
      load();
    }
    load();
  }

  function dashSettings() {
    const s = S.settings;
    const err = h('div', { class: 'err', hidden: true });
    const phone = h('input', { class: 'input', id: 'st-phone', type: 'tel', value: s.phone, placeholder: '(312) 555-0100' });
    const email = h('input', { class: 'input', id: 'st-email', type: 'email', value: s.email, placeholder: 'deals@606homebuyers.com' });
    const url = h('input', { class: 'input', id: 'st-url', type: 'url', value: s.buyersListUrl, placeholder: 'https://forms.gle/…' });
    return h('form', { class: 'panel narrow', onsubmit: async e => {
      e.preventDefault(); err.hidden = true;
      try {
        S.settings = (await api('PUT', '/api/settings', { phone: phone.value, email: email.value, buyersListUrl: url.value })).settings;
        renderChrome(); toast('Settings saved');
      } catch (ex) { err.hidden = false; err.textContent = ex.message; }
    } },
      h('div', { class: 'panel-head' }, h('h2', { text: 'Contact details on the public site' })),
      h('div', { class: 'panel-body' },
        h('p', { class: 'muted', text: 'Buyers see these on the Contact button and on each active deal. Leave a field empty to hide it.' }),
        h('div', { class: 'field' }, h('label', { for: 'st-phone', text: 'Phone' }), phone),
        h('div', { class: 'field' }, h('label', { for: 'st-email', text: 'Email' }), email),
        h('div', { class: 'field' }, h('label', { for: 'st-url', text: 'Buyers list sign-up link' }), url, h('span', { class: 'hint', text: 'Optional. A Google Form or similar. Adds a "Join our buyers list" button to the home page.' })),
        err, h('div', {}, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save settings'))));
  }

  /* ---------- boot ---------- */
  (async () => {
    route({ keepScroll: true });
    await Promise.all([loadMe(), loadSettings()]);
    await loadDeals();
    route({ keepScroll: !location.hash });
  })();
})();
