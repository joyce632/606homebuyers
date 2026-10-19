/* 606 Home Buyers — front end. Public pages (home, deal, buyers list) and the team dashboard (/team). */
(() => {
  'use strict';

  const STATUSES = [
    { key: 'active', label: 'Active' },
    { key: 'pending', label: 'Pending' },
    { key: 'sold', label: 'Sold' },
    { key: 'closed', label: 'Closed' },
  ];
  const STATUS_LABEL = Object.fromEntries(STATUSES.map(s => [s.key, s.label]));
  STATUS_LABEL.draft = 'Draft';
  // Team views include drafts; the public site never sees them.
  const TEAM_STATUSES = [{ key: 'draft', label: 'Draft' }, ...STATUSES];
  const STRATEGY = { flip: 'Fix & flip', rental: 'Buy & hold', wholesale: 'Wholesale' };
  const TYPES = ['Single family', '2-flat', '3-flat', '4-unit', '5+ units', 'Condo', 'Townhome', 'Mixed use', 'Vacant land'];
  const OCC = ['Vacant', 'Tenant occupied', 'Owner occupied', 'Partially occupied'];
  const CONDITIONS = ['Turnkey', 'Light rehab', 'Moderate rehab', 'Full rehab', 'Teardown / land value'];
  const BUYBOX_TYPES = ['Single family', '2-4 units', '5+ units', 'Condo / townhome', 'Mixed use', 'Vacant land'];
  const ROLES = { admin: 'Admin', editor: 'Editor' };

  const S = {
    deals: [], loaded: false, loadError: false,
    settings: { phone: '', email: '', buyersListUrl: '', advisorName: '', dealsClosed: '', yearsInBusiness: '' },
    user: null, csrf: null,
    filter: 'active', q: '', sort: 'new',
    tab: 'deals', dashQ: '', dashFilter: 'all', newInquiries: 0,
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
    const d = Math.floor(s / 86400);
    if (d < 14) return d + (d === 1 ? ' day ago' : ' days ago');
    if (d < 60) return Math.floor(d / 7) + ' weeks ago';
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
  const placeName = d => d.area ? `${d.area}, ${d.city || 'Chicago'}` : (d.city || 'Chicago');
  // Discount to ARV and equity: the two numbers investors scan for first.
  const below = d => isNum(d.arv) && isNum(d.price) && d.arv > 0 && d.arv > d.price ? Math.round((d.arv - d.price) / d.arv * 100) : null;
  const equity = d => isNum(d.arv) && isNum(d.price) ? d.arv - d.price - (Number(d.repairs) || 0) : null;
  const equityLabel = d => isNum(d.repairs) ? 'est. equity after repairs' : 'spread to ARV';
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

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
  const telHref = p => 'tel:' + p.replace(/[^\d+]/g, '');

  /* ---------- data ---------- */
  async function loadDeals() {
    try {
      const d = await api('GET', '/api/deals');
      S.deals = d.deals; S.loaded = true; S.loadError = false;
    } catch { S.loaded = true; S.loadError = true; }
  }
  async function loadSettings() {
    try { S.settings = Object.assign(S.settings, (await api('GET', '/api/settings')).settings); } catch {}
  }
  async function loadMe() {
    try { const d = await api('GET', '/api/me'); S.user = d.user; S.csrf = d.csrf || null; } catch {}
  }
  const findDeal = id => S.deals.find(d => d.id === id);
  const activeDeals = () => S.deals.filter(d => d.status === 'active');
  const publicDeals = () => S.deals.filter(d => d.status !== 'draft');

  /* ---------- routing ---------- */
  function go(url, opts = {}) {
    if (url !== location.pathname + location.hash) history.pushState({}, '', url);
    route(opts);
  }
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-link]');
    if (a && !(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) { e.preventDefault(); go(a.getAttribute('href')); return; }
    if (e.target.closest('[data-contact]')) openContact(null);
  });
  window.addEventListener('popstate', () => route({ keepScroll: true }));

  function route(opts = {}) {
    const path = location.pathname;
    const m = path.match(/^\/deal\/([A-Za-z0-9]+)$/);
    if (path === '/buyers') { history.replaceState({}, '', '/#join'); return route(opts); }
    const view = m ? 'deal' : path === '/team' ? 'team' : 'home';
    for (const v of ['home', 'deal', 'team']) $('view-' + v).hidden = view !== v;
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
    const s = S.settings;
    const hasContact = !!(s.phone || s.email);
    $('btn-dashboard').hidden = !S.user;
    const tp = $('top-phone');
    tp.hidden = !s.phone;
    if (s.phone) { tp.href = telHref(s.phone); tp.querySelector('span').textContent = s.phone; }
    const fc = $('foot-contact'); fc.replaceChildren();
    if (s.phone) fc.append(h('a', { href: telHref(s.phone) }, icon('phone'), s.phone));
    if (s.email) fc.append(h('a', { href: 'mailto:' + s.email }, icon('mail'), s.email));
    $('foot-connect').hidden = !hasContact;
    $('year').textContent = new Date().getFullYear();
  }

  /* ---------- contact ---------- */
  function openContact(deal) {
    const s = S.settings;
    const body = $('dc-body'); body.replaceChildren();
    if (!s.phone && !s.email) body.append(h('p', { class: 'muted', text: 'Contact details are coming soon. Join the buyers list and we will reach out.' }));
    if (deal) body.append(h('p', { class: 'muted', text: `About ${deal.address}. Mention the address when you reach out.` }));
    if (s.phone) body.append(h('div', { class: 'contact-row' }, icon('phone'),
      h('a', { href: telHref(s.phone), text: s.phone }),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(s.phone, () => toast('Phone number copied')) }, 'Copy')));
    if (s.email) {
      const subj = deal ? '?subject=' + encodeURIComponent('Interested in ' + deal.address) : '';
      body.append(h('div', { class: 'contact-row' }, icon('mail'),
        h('a', { href: 'mailto:' + s.email + subj, text: s.email }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(s.email, () => toast('Email copied')) }, 'Copy')));
    }
    body.append(h('a', { class: 'btn btn-primary', href: '/buyers', 'data-link': true, onclick: () => $('dlg-contact').close() }, 'Join the buyers list'));
    $('dlg-contact').showModal();
  }
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  for (const id of ['dlg-contact', 'dlg-photos']) $(id).addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  /* ---------- home ---------- */
  S.filter = store.get('606.filter2') || 'active';
  S.sort = store.get('606.sort') || 'new';
  $('sort').value = S.sort;
  $('q').addEventListener('input', e => { S.q = e.target.value; renderGrid(); });
  $('sort').addEventListener('change', e => { S.sort = e.target.value; store.set('606.sort', S.sort); renderGrid(); });

  function counts(list) {
    const c = { all: list.length };
    for (const s of STATUSES) c[s.key] = list.filter(d => d.status === s.key).length;
    return c;
  }
  function sortDeals(list, sort) {
    const p = d => (isNum(d.price) ? Number(d.price) : null);
    if (sort === 'low') list.sort((a, b) => (p(a) ?? 1e15) - (p(b) ?? 1e15));
    else if (sort === 'high') list.sort((a, b) => (p(b) ?? -1) - (p(a) ?? -1));
    else if (sort === 'discount') list.sort((a, b) => (below(b) ?? -1) - (below(a) ?? -1));
    else list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return list;
  }
  function matches(d, q) {
    q = q.trim().toLowerCase();
    return !q || [d.address, d.city, d.zip, d.area, d.county, d.type].filter(Boolean).join(' ').toLowerCase().includes(q);
  }

  function dealCard(d) {
    const photos = d.photos || [];
    const pct = below(d), eq = equity(d);
    const facts = [];
    if (isNum(d.beds)) facts.push(h('li', {}, icon('bed'), h('b', { text: numf(d.beds) }), ' bd'));
    if (isNum(d.baths)) facts.push(h('li', {}, icon('bath'), h('b', { text: numf(d.baths) }), ' ba'));
    if (isNum(d.sqft)) facts.push(h('li', {}, icon('ruler'), h('b', { text: numf(d.sqft) }), ' sq ft'));
    return h('a', { class: 'card', href: '/deal/' + d.id, 'data-link': true },
      h('div', { class: 'media' },
        photos.length ? h('img', { src: photoUrl(photos[0], true), alt: '', loading: 'lazy' }) : h('div', { class: 'noimg' }, icon('house')),
        h('div', { class: 'media-tags' },
          pct != null && d.status === 'active' ? h('span', { class: 'disc', text: pct + '% below ARV' }) : h('span'),
          pill(d.status)),
        photos.length > 1 ? h('span', { class: 'pcount' }, icon('cam'), String(photos.length)) : null),
      h('div', { class: 'card-body' },
        h('div', { class: 'price-row' },
          h('span', { class: 'price', text: money(d.price) }),
          null),
        isNum(d.arv) ? h('div', { class: 'arv', text: 'ARV ' + money(d.arv) }) : null,
        h('div', { class: 'loc' }, icon('pin'), h('span', { text: [d.address, locLine(d)].filter(Boolean).join(', ') })),
        eq != null && eq > 0 ? h('div', { class: 'equity' }, h('b', { text: money(eq) }), ' ' + equityLabel(d)) : null,
        facts.length ? h('ul', { class: 'facts' }, facts) : null,
        h('div', { class: 'card-foot' },
          h('span', { class: 'tag', text: d.type || '' }),
          h('span', { text: ago(d.createdAt) }))));
  }

  function renderHome() {
    const act = activeDeals();
    const c = counts(publicDeals());

    // Hero: the newest active deal's cover photo behind the headline.
    const cover = act.find(d => (d.photos || []).length);
    $('hero-bg').style.backgroundImage = cover ? `url("${photoUrl(cover.photos[0])}")` : '';
    $('hero').classList.toggle('has-photo', !!cover);
    const discounts = act.map(below).filter(x => x != null);
    if (S.loaded && act.length) {
      $('live-chip').hidden = false;
      $('live-text').textContent = `${act.length} ${act.length === 1 ? 'deal' : 'deals'} available now` +
        (discounts.length ? ` · up to ${Math.max(...discounts)}% below ARV` : '');
    } else $('live-chip').hidden = true;

    renderGrid();
    if (!$('join-slot').firstChild) $('join-slot').append(buyersSection());
  }

  function renderGrid() {
    const all = publicDeals();
    const c = counts(all);
    const seg = $('seg'); seg.replaceChildren();
    for (const o of [{ key: 'all', label: 'All' }, ...STATUSES]) {
      seg.append(h('button', {
        type: 'button', 'aria-pressed': String(S.filter === o.key),
        onclick: () => { S.filter = o.key; store.set('606.filter2', o.key); renderGrid(); },
      }, o.key !== 'all' ? h('span', { class: 'dot st-' + o.key }) : null, o.label, h('span', { class: 'count', text: c[o.key] })));
    }
    const grid = $('grid'), empty = $('empty-slot');
    grid.replaceChildren(); empty.replaceChildren();
    $('avail-count').textContent = '';
    if (!S.loaded) { for (let i = 0; i < 3; i++) grid.append(h('div', { class: 'card skeleton' }, h('div', { class: 'media' }))); return; }
    if (S.loadError) { empty.append(h('div', { class: 'notice' }, icon('info'), h('span', { text: 'Deals could not be loaded. Refresh the page to try again.' }))); return; }
    if (!all.length) {
      empty.append(h('div', { class: 'empty' }, h('div', { class: 'noimg' }, icon('house')),
        h('h2', { text: 'New deals are on the way' }),
        h('p', { text: 'There are no properties listed right now. Join the buyers list to hear about the next one first.' }),
        h('a', { class: 'btn btn-primary', href: '/#join', 'data-link': true }, 'Join the buyers list')));
      return;
    }
    const list = sortDeals(all.filter(d => (S.filter === 'all' || d.status === S.filter) && matches(d, S.q)), S.sort);
    $('avail-count').textContent = `${list.length} ${list.length === 1 ? 'property' : 'properties'}`;
    if (!list.length) {
      empty.append(h('div', { class: 'empty' }, h('p', { text: 'No deals match these filters.' }),
        h('button', { class: 'btn', type: 'button', onclick: () => { S.filter = 'all'; S.q = ''; $('q').value = ''; renderGrid(); } }, 'Clear filters')));
      return;
    }
    for (const d of list) grid.append(dealCard(d));
  }

  /* ---------- single deal ---------- */
  let lbPhotos = [], lbIdx = 0;
  function openPhotos(photos, i) {
    lbPhotos = photos; lbIdx = i;
    showPhoto();
    if (!$('dlg-photos').open) $('dlg-photos').showModal();
  }
  function showPhoto() {
    $('lb-img').src = photoUrl(lbPhotos[lbIdx]);
    $('lb-count').textContent = `${lbIdx + 1} / ${lbPhotos.length}`;
    $('lb-prev').hidden = $('lb-next').hidden = lbPhotos.length < 2;
  }
  const lbStep = n => { if (lbPhotos.length) { lbIdx = (lbIdx + n + lbPhotos.length) % lbPhotos.length; showPhoto(); } };
  $('lb-prev').addEventListener('click', () => lbStep(-1));
  $('lb-next').addEventListener('click', () => lbStep(1));
  $('dlg-photos').addEventListener('keydown', e => { if (e.key === 'ArrowLeft') lbStep(-1); if (e.key === 'ArrowRight') lbStep(1); });

  function gallery(d) {
    const photos = d.photos || [];
    if (!photos.length) return h('div', { class: 'mosaic mosaic-0' }, h('div', { class: 'noimg' }, icon('house')));
    const shown = photos.slice(0, 5);
    const g = h('div', { class: 'mosaic mosaic-' + Math.min(shown.length, 5) });
    shown.forEach((p, i) => {
      const more = i === 4 && photos.length > 5 ? h('span', { class: 'more', text: `+${photos.length - 5} more` }) : null;
      g.append(h('button', { class: 'tile', type: 'button', 'aria-label': `Open photo ${i + 1} of ${photos.length}`, onclick: () => openPhotos(photos, i) },
        h('img', { src: photoUrl(p, i > 0), alt: '' }), more));
    });
    if (photos.length > 1) g.append(h('button', { class: 'btn btn-sm all-photos', type: 'button', onclick: () => openPhotos(photos, 0) }, icon('grid'), `View all ${photos.length} photos`));
    return g;
  }

  function renderDealPage(id) {
    const root = $('view-deal');
    const d = findDeal(id);
    root.replaceChildren(h('nav', { class: 'crumb', 'aria-label': 'Breadcrumb' },
      h('a', { href: '/#available', 'data-link': true, text: 'Deals' }), h('span', { text: '/' }), h('span', { text: d ? placeName(d) : '' })));
    if (!S.loaded) return;
    if (!d) {
      root.append(h('div', { class: 'empty' }, h('h2', { text: 'This deal is no longer listed' }),
        h('p', { text: 'It may have been removed. See the current deals instead.' }),
        h('a', { class: 'btn btn-primary', href: '/#available', 'data-link': true }, 'See current deals')));
      return;
    }
    document.title = `${d.address || 'Untitled draft'} · ${placeName(d)} | 606 Home Buyers`;
    if (d.status === 'draft') root.append(h('div', { class: 'notice draft-banner' }, icon('lock'),
      h('span', { text: 'Draft. Only your team can see this page. Publish it from the editor when it is ready for buyers.' })));
    const pct = below(d), eq = equity(d);

    const facts = [];
    if (isNum(d.beds)) facts.push([icon('bed'), numf(d.beds), 'Beds']);
    if (isNum(d.baths)) facts.push([icon('bath'), numf(d.baths), 'Baths']);
    if (isNum(d.sqft)) facts.push([icon('ruler'), numf(d.sqft), 'Sq ft']);
    if (d.type) facts.push([icon('house'), d.type, 'Type']);
    if (d.year) facts.push([icon('cal'), String(d.year), 'Built']);

    const details = [
      ['Type', d.type], ['Year built', d.year], ['Lot size', d.lot], ['Sq ft', isNum(d.sqft) ? numf(d.sqft) : null],
      ['Units', d.units], ['Occupancy', d.occupancy], ['Parking', d.parking], ['Condition', d.condition], ['County', d.county],
    ].filter(([, v]) => v != null && v !== '');
    const hl = (d.highlights || '').split('\n').map(s => s.trim()).filter(Boolean);

    const main = h('div', { class: 'deal-main' },
      d.description || hl.length ? h('section', { class: 'box' },
        h('h2', { text: 'About this property' }),
        d.condition ? h('p', { class: 'cond' }, h('b', { text: 'Condition: ' }), d.condition) : null,
        d.description ? h('p', { class: 'desc', text: d.description }) : null,
        hl.length ? h('ul', { class: 'checks' }, hl.map(x => h('li', {}, icon('check'), h('span', { text: x })))) : null) : null,
      details.length ? h('section', { class: 'box' },
        h('h2', { text: 'Property details' }),
        h('dl', { class: 'kv' }, details.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: String(v) }))))) : null,
      analysisBox(d),
      compsBox(d));

    const side = h('aside', { class: 'side', id: 'deal-side' }, priceCard(d), S.user ? teamBox(d) : null);

    const head = h('div', { class: 'deal-head' },
      h('div', { class: 'tags' }, pill(d.status),
        pct != null && d.status === 'active' ? h('span', { class: 'disc', text: pct + '% below ARV' }) : null),
      h('h1', { text: d.address || 'Untitled draft' }),
      h('div', { class: 'loc' }, icon('pin'), h('span', { text: locLine(d) })),
      h('div', { class: 'head-row' },
        facts.length ? h('ul', { class: 'facts-lg' }, facts.map(([ic, v, l]) => h('li', {}, ic, h('div', {}, h('b', { text: v }), h('span', { text: l }))))) : h('span'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(location.origin + '/deal/' + d.id, () => toast('Link copied')) }, icon('link'), 'Share')));

    const others = activeDeals().filter(x => x.id !== d.id).slice(0, 3);
    root.append(gallery(d), head, h('div', { class: 'deal-layout' }, main, side));
    if (others.length) root.append(h('section', { class: 'more-deals' },
      h('div', { class: 'section-head' }, h('div', {}, h('div', { class: 'kicker', text: 'Keep browsing' }), h('h2', { text: 'More available deals' }))),
      h('div', { class: 'grid' }, others.map(dealCard))));

    // Phones: keep the price and an offer button in reach.
    if (d.status === 'active') root.append(h('div', { class: 'sticky-offer' },
      h('div', {}, h('b', { text: money(d.price) }), isNum(d.arv) ? h('span', { text: 'ARV ' + money(d.arv) }) : null),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => $('inquiry').scrollIntoView({ block: 'center' }) }, 'Make an offer')));
  }

  function analysisBox(d) {
    if (!isNum(d.price)) return null;
    const lines = [['Asking price', money(d.price)]];
    if (isNum(d.repairs)) lines.push(['Est. repairs', money(d.repairs)], ['All-in cost', money(d.price + d.repairs)]);
    if (isNum(d.arv)) lines.push(['ARV', money(d.arv)]);
    if (isNum(d.rent)) {
      lines.push(['Monthly rent', money(d.rent)]);
      const allIn = d.price + (Number(d.repairs) || 0);
      if (allIn > 0) lines.push(['Gross yield, all-in', (d.rent * 12 / allIn * 100).toFixed(1) + '%']);
    }
    if (isNum(d.emd)) lines.push(['Earnest money', money(d.emd)]);
    if (d.closeBy) lines.push(['Close by', fmtDate(d.closeBy)]);
    const eq = equity(d), pct = below(d);
    return h('section', { class: 'box' },
      h('h2', { text: 'Deal analysis' }),
      h('div', { class: 'numbers' },
        lines.map(([k, v]) => h('div', { class: 'line' }, h('span', { text: k }), h('span', { text: v }))),
        eq != null ? h('div', { class: 'line total' }, h('span', { text: isNum(d.repairs) ? 'Est. equity after repairs' : 'Spread to ARV' }),
          h('span', { class: eq > 0 ? 'pos' : null, text: money(eq) + (pct != null ? ` (${pct}% below ARV)` : '') })) : null),
      h('p', { class: 'hint', text: 'Estimates only. Verify repairs and value with your own walkthrough and comps.' }));
  }

  function compsBox(d) {
    const comps = d.comps || [];
    if (!comps.length) return null;
    const sold = comps.filter(c => c.status === 'sold');
    const ppsf = sold.filter(c => isNum(c.sqft) && c.sqft > 0).map(c => c.price / c.sqft);
    const sumItems = [];
    if (sold.length) sumItems.push(['Avg. sold price', money(avg(sold.map(c => c.price)))]);
    if (ppsf.length) sumItems.push(['Avg. $/sq ft', money(avg(ppsf))]);
    sumItems.push(['Comps', String(comps.length)]);
    if (isNum(d.arv)) sumItems.push(['ARV', money(d.arv)]);
    const row = (c, subject) => h('tr', { class: subject ? 'subject' : null },
      h('td', {}, subject ? h('span', { class: 'pill st-closed', text: 'This deal' }) : h('span', { class: 'cstat c-' + c.status, text: c.status })),
      h('td', {}, h('b', { text: c.address })),
      h('td', { class: 'r', text: subject ? '—' : (isNum(c.distance) ? c.distance + ' mi' : '—') }),
      h('td', { class: 'r', text: numf(c.beds) }), h('td', { class: 'r', text: numf(c.baths) }), h('td', { class: 'r', text: numf(c.sqft) }),
      h('td', { class: 'r', text: money(c.price) }),
      h('td', { class: 'r', text: isNum(c.sqft) && c.sqft > 0 && isNum(c.price) ? money(c.price / c.sqft) : '—' }));
    return h('section', { class: 'box' },
      h('h2', { text: 'Comparable sales' }),
      h('p', { class: 'muted', text: 'Nearby sold and active properties used to estimate the after-repair value.' }),
      h('div', { class: 'comp-sum' }, sumItems.map(([k, v]) => h('div', {}, h('span', { text: k }), h('b', { text: v })))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl tbl-comps' },
        h('thead', {}, h('tr', {}, ['', 'Address', 'Dist.', 'Beds', 'Baths', 'Sq ft', 'Price', '$/sq ft'].map((t, i) => h('th', { class: i > 1 ? 'r' : null, text: t })))),
        h('tbody', {}, row({ address: d.address, beds: d.beds, baths: d.baths, sqft: d.sqft, price: d.price }, true), comps.map(c => row(c, false))))));
  }

  function priceCard(d) {
    const pct = below(d), eq = equity(d), s = S.settings;
    const card = h('div', { class: 'box price-card', id: 'inquiry' },
      h('div', { class: 'pc-top' },
        h('div', {}, h('span', { class: 'hint', text: 'Asking price' }), h('div', { class: 'price', text: money(d.price) })),
        isNum(d.arv) ? h('div', { class: 'pc-arv' }, h('span', { class: 'hint', text: 'ARV' }), h('b', { text: money(d.arv) })) : null),
      pct != null || (eq != null && eq > 0) ? h('div', { class: 'pc-equity' },
        pct != null ? h('span', { class: 'disc', text: pct + '% below ARV' }) : null,
        eq != null && eq > 0 ? h('span', {}, h('b', { text: money(eq) }), ' ' + equityLabel(d)) : null) : null);
    const name = s.advisorName || '606 Dispositions';
    card.append(h('div', { class: 'advisor' },
      h('span', { class: 'avatar', text: name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() }),
      h('div', {}, h('b', { text: name }), h('span', { text: 'Dispositions' })),
      s.phone ? h('a', { class: 'btn btn-sm', href: telHref(s.phone) }, icon('phone'), s.phone) : null));
    if (d.status === 'draft') {
      card.append(h('div', { class: 'notice' }, icon('lock'), h('span', { text: 'Buyers will see the offer form here once this deal is published.' })));
      return card;
    }
    if (d.status !== 'active') {
      card.append(h('div', { class: 'notice' }, icon('info'), h('span', { text: `This property is ${STATUS_LABEL[d.status].toLowerCase()}. Join the buyers list to hear about the next one first.` })),
        h('a', { class: 'btn btn-primary btn-lg', href: '/buyers', 'data-link': true }, 'Join the buyers list'));
      return card;
    }
    card.append(inquiryForm(d));
    return card;
  }

  function inquiryForm(d) {
    let kind = 'offer';
    const err = h('div', { class: 'err', hidden: true });
    const name = h('input', { class: 'input', id: 'iq-name', autocomplete: 'name', required: true });
    const phone = h('input', { class: 'input', id: 'iq-phone', type: 'tel', autocomplete: 'tel' });
    const email = h('input', { class: 'input', id: 'iq-email', type: 'email', autocomplete: 'email' });
    const offer = h('input', { class: 'input num', id: 'iq-offer', type: 'number', min: '0', step: '500', placeholder: isNum(d.price) ? String(d.price) : '' });
    const msg = h('textarea', { class: 'textarea textarea-sm', id: 'iq-msg', placeholder: 'Questions, timeline, how you will fund the purchase…' });
    const hp = h('input', { class: 'hp', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    const offerField = h('div', { class: 'field' }, h('label', { for: 'iq-offer', text: 'Your offer' }), h('div', { class: 'money' }, offer));
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Send offer');
    const tabs = h('div', { class: 'seg-toggle', role: 'tablist' });
    const setKind = k => {
      kind = k; offerField.hidden = k !== 'offer'; btn.textContent = k === 'offer' ? 'Send offer' : 'Send question';
      tabs.replaceChildren(...[['offer', 'Make an offer'], ['inquiry', 'Ask a question']].map(([v, l]) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(kind === v), onclick: () => setKind(v) }, l)));
    };
    setKind('offer');
    const form = h('form', { class: 'iq-form', novalidate: true, onsubmit: async e => {
      e.preventDefault(); err.hidden = true; btn.disabled = true;
      try {
        await api('POST', '/api/inquiries', { dealId: d.id, kind, name: name.value, phone: phone.value, email: email.value,
          offer: kind === 'offer' ? offer.value : null, message: msg.value, website: hp.value });
        form.replaceChildren(h('div', { class: 'sent' }, icon('check'), h('b', { text: kind === 'offer' ? 'Offer sent' : 'Question sent' }),
          h('span', { text: `Thanks, ${name.value.split(' ')[0]}. Our dispositions team will reach out shortly about ${d.address}.` })));
      } catch (ex) { err.hidden = false; err.textContent = ex.message; btn.disabled = false; }
    } },
      tabs,
      h('div', { class: 'field' }, h('label', { for: 'iq-name', text: 'Name' }), name),
      h('div', { class: 'two' },
        h('div', { class: 'field' }, h('label', { for: 'iq-phone', text: 'Phone' }), phone),
        h('div', { class: 'field' }, h('label', { for: 'iq-email', text: 'Email' }), email)),
      offerField,
      h('div', { class: 'field' }, h('label', { for: 'iq-msg', text: 'Message' }), msg),
      hp, err, btn,
      h('p', { class: 'hint', text: 'An offer starts a conversation. Nothing is binding until you sign an assignment contract.' }));
    return form;
  }

  function teamBox(d) {
    const fee = isNum(d.price) && isNum(d.contractPrice) ? d.price - d.contractPrice : null;
    const lines = [];
    if (isNum(d.contractPrice)) lines.push(['Contract price', money(d.contractPrice)]);
    if (d.sellerName) lines.push(['Seller', d.sellerName]);
    if (d.sellerPhone) lines.push(['Seller phone', d.sellerPhone]);
    if (d.access) lines.push(['Access', d.access]);
    const sel = h('select', { class: 'select', 'aria-label': 'Change status' }, TEAM_STATUSES.map(s => h('option', { value: s.key, text: s.label })));
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

  function copyBlast(d) {
    const parts = [];
    const pct = below(d);
    parts.push(`${(STATUS_LABEL[d.status] || '').toUpperCase()} DEAL | ${d.type || 'Property'} | ${locLine(d)}`);
    parts.push(d.address || '');
    const n = [`Price: ${money(d.price)}`];
    if (isNum(d.arv)) n.push(`ARV: ${money(d.arv)}`);
    if (isNum(d.repairs)) n.push(`Est. repairs: ${money(d.repairs)}`);
    parts.push(n.join(' | '));
    if (pct != null) parts.push(`${pct}% below ARV`);
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
    parts.push('', 'Photos, comps and offers: ' + location.origin + '/deal/' + d.id);
    parts.push('Sold as-is. Contact 606 Home Buyers' + (S.settings.phone ? ' at ' + S.settings.phone : '') + '.');
    copyText(parts.join('\n'), () => toast('Copied. Paste it into your buyer text or email blast.'));
  }

  async function saveStatus(id, status) {
    try {
      const r = await api('PATCH', `/api/deals/${id}/status`, { status });
      upsertDeal(r.deal); toast(status === 'draft' ? 'Moved to drafts' : 'Status set to ' + STATUS_LABEL[status]); route({ keepScroll: true });
    } catch (e) { toast(e.message); route({ keepScroll: true }); }
  }
  function upsertDeal(d) {
    const i = S.deals.findIndex(x => x.id === d.id);
    if (i >= 0) S.deals[i] = d; else S.deals.unshift(d);
  }

  /* ---------- buyers list sign-up ---------- */
  function buyersSection() {
    const err = h('div', { class: 'err', hidden: true });
    const f = {
      name: h('input', { class: 'input', id: 'bl-name', autocomplete: 'name', required: true }),
      email: h('input', { class: 'input', id: 'bl-email', type: 'email', autocomplete: 'email' }),
      phone: h('input', { class: 'input', id: 'bl-phone', type: 'tel', autocomplete: 'tel' }),
      areas: h('input', { class: 'input', id: 'bl-areas', placeholder: 'e.g. Pilsen, Austin, south suburbs, all of Cook County' }),
      maxPrice: h('input', { class: 'input num', id: 'bl-max', type: 'number', min: '0', step: '5000' }),
      funding: h('select', { class: 'select', id: 'bl-funding' }, h('option', { value: '', text: 'Choose…' }),
        h('option', { value: 'cash', text: 'Cash' }), h('option', { value: 'hard money', text: 'Hard money / private lender' }), h('option', { value: 'conventional', text: 'Conventional loan' })),
      notes: h('textarea', { class: 'textarea textarea-sm', id: 'bl-notes', placeholder: 'Anything else about your buy box' }),
      website: h('input', { class: 'hp', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' }),
    };
    const checks = (name, items) => h('div', { class: 'checkgrid' }, items.map(([v, l]) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name, value: v }), h('span', { text: l }))));
    const types = checks('types', BUYBOX_TYPES.map(t => [t, t]));
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Join the buyers list');
    const picked = (box) => [...box.querySelectorAll('input:checked')].map(i => i.value);
    const form = h('form', { class: 'box buyer-form', novalidate: true, onsubmit: async e => {
      e.preventDefault(); err.hidden = true; btn.disabled = true;
      try {
        await api('POST', '/api/buyers', { name: f.name.value, email: f.email.value, phone: f.phone.value, areas: f.areas.value,
          maxPrice: f.maxPrice.value, funding: f.funding.value, notes: f.notes.value, website: f.website.value,
          types: picked(types) });
        form.replaceChildren(h('div', { class: 'sent' }, icon('check'), h('b', { text: "You're on the list" }),
          h('span', { text: "We'll send you matching deals as soon as they're under contract." }),
          h('a', { class: 'btn', href: '/#available', 'data-link': true }, 'Browse the deal board')));
      } catch (ex) { err.hidden = false; err.textContent = ex.message; btn.disabled = false; }
    } },
      h('h2', { text: 'Your buy box' }),
      h('div', { class: 'field' }, h('label', { for: 'bl-name', text: 'Name' }), f.name),
      h('div', { class: 'two' },
        h('div', { class: 'field' }, h('label', { for: 'bl-phone', text: 'Phone' }), f.phone),
        h('div', { class: 'field' }, h('label', { for: 'bl-email', text: 'Email' }), f.email)),
      h('div', { class: 'field' }, h('label', { for: 'bl-areas', text: 'Areas you buy in' }), f.areas),
      h('fieldset', { class: 'field plain' }, h('legend', { text: 'Property types' }), types),
      h('div', { class: 'two' },
        h('div', { class: 'field' }, h('label', { for: 'bl-max', text: 'Max purchase price' }), h('div', { class: 'money' }, f.maxPrice)),
        h('div', { class: 'field' }, h('label', { for: 'bl-funding', text: 'How you fund deals' }), f.funding)),
      h('div', { class: 'field' }, h('label', { for: 'bl-notes', text: 'Notes' }), f.notes),
      f.website, err, btn,
      h('p', { class: 'hint', text: 'We only use your details to send you deals. Ask us any time and we will remove you from the list.' }));
    return h('div', { class: 'buyers-layout' },
      h('div', { class: 'buyers-pitch' },
        h('div', { class: 'kicker', text: 'Buyers list' }),
        h('h2', { text: 'Get off-market deals before they hit the site' }),
        h('p', { class: 'lede', text: 'Tell us what you buy. When a property that fits goes under contract, you hear about it first.' }),
        h('ul', { class: 'checks' }, [
          'Deals matched to your areas, property types and price range',
          'Price, ARV, repair estimate and photos with every deal',
          'Direct line to our dispositions team',
          'No cost, no obligation',
        ].map(t => h('li', {}, icon('check'), h('span', { text: t }))))),
      form);
  }

  /* ---------- deal editor ---------- */
  const F = id => $('f-' + id);
  F('type').append(h('option', { value: '', text: 'Choose…' }), ...TYPES.map(t => h('option', { value: t, text: t })));
  F('occ').append(h('option', { value: '', text: 'Choose…' }), ...OCC.map(t => h('option', { value: t, text: t })));
  F('condition').append(h('option', { value: '', text: 'Choose…' }), ...CONDITIONS.map(t => h('option', { value: t, text: t })));
  F('status').append(...STATUSES.map(s => h('label', {},
    h('input', { type: 'radio', name: 'status', value: s.key, id: 'f-st-' + s.key }), h('span', { class: 'pill st-' + s.key, text: s.label }))));

  const NUMS = { beds: 'beds', baths: 'baths', sqft: 'sqft', year: 'year', units: 'units', price: 'price', arv: 'arv', repairs: 'repairs', rent: 'rent', emd: 'emd', contract: 'contractPrice' };
  const TEXTS = { address: 'address', city: 'city', zip: 'zip', area: 'area', county: 'county', lot: 'lot', type: 'type', occ: 'occupancy', close: 'closeBy', access: 'access', desc: 'description', hl: 'highlights', seller: 'sellerName', sellerphone: 'sellerPhone', notes: 'internalNotes', condition: 'condition', parking: 'parking' };
  const COMP_FIELDS = [['status', 'Status'], ['address', 'Address'], ['beds', 'Beds'], ['baths', 'Baths'], ['sqft', 'Sq ft'], ['price', 'Price'], ['distance', 'Miles']];
  let editOrig = null, photos = [], sessionUploads = new Set(), uploading = 0;

  function compRow(c = {}) {
    const row = h('div', { class: 'comp-row' });
    for (const [k, label] of COMP_FIELDS) {
      let input;
      if (k === 'status') {
        input = h('select', { class: 'select', 'data-k': k, 'aria-label': label }, ['sold', 'active', 'pending'].map(v => h('option', { value: v, text: v[0].toUpperCase() + v.slice(1) })));
        input.value = c.status || 'sold';
      } else {
        input = h('input', { class: 'input' + (k === 'address' ? '' : ' num'), 'data-k': k, 'aria-label': label, placeholder: label,
          type: k === 'address' ? 'text' : 'number', min: '0', step: k === 'baths' ? '0.5' : k === 'distance' ? '0.1' : '1' });
        input.value = c[k] ?? '';
      }
      row.append(input);
    }
    row.append(h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove comp', onclick: () => row.remove() }, icon('x')));
    return row;
  }
  $('add-comp').addEventListener('click', () => F('comps').append(compRow()));
  const readComps = () => [...F('comps').querySelectorAll('.comp-row')].map(r => {
    const c = {};
    r.querySelectorAll('[data-k]').forEach(i => { c[i.dataset.k] = i.value === '' ? null : (i.dataset.k === 'address' || i.dataset.k === 'status' ? i.value : Number(i.value)); });
    return c;
  }).filter(c => c.address && isNum(c.price));

  function openEdit(id) {
    const d = id ? findDeal(id) : null;
    editOrig = d;
    $('de-title').textContent = !d ? 'Add deal' : d.status === 'draft' ? 'Edit draft' : 'Edit deal';
    const published = d && d.status !== 'draft';
    $('de-save').textContent = published ? 'Save changes' : 'Publish deal';
    $('de-draft').hidden = published;
    $('de-sample').hidden = !!d;
    for (const [f, k] of Object.entries(TEXTS)) F(f).value = d?.[k] ?? (f === 'city' && !d ? 'Chicago' : f === 'county' && !d ? 'Cook' : '');
    for (const [f, k] of Object.entries(NUMS)) F(f).value = d?.[k] ?? '';
    $('f-st-' + (d && d.status !== 'draft' ? d.status : 'active')).checked = true;
    F('comps').replaceChildren(...(d?.comps || []).map(compRow));
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

  $('deal-form').addEventListener('submit', e => { e.preventDefault(); saveDeal(false); });
  $('de-draft').addEventListener('click', () => saveDeal(true));
  async function saveDeal(asDraft) {
    const err = $('de-err');
    if (!asDraft && !F('address').value.trim()) { err.hidden = false; err.textContent = 'Add a street address before publishing, or save it as a draft.'; F('address').focus(); return; }
    if (uploading) { err.hidden = false; err.textContent = 'Wait for photos to finish uploading.'; return; }
    err.hidden = true;
    const body = {};
    for (const [f, k] of Object.entries(TEXTS)) body[k] = F(f).value.trim() || null;
    for (const [f, k] of Object.entries(NUMS)) body[k] = F(f).value === '' ? null : Number(F(f).value);
    body.status = asDraft ? 'draft' : (document.querySelector('input[name="status"]:checked')?.value || 'active');
    body.photos = photos.slice();
    body.comps = readComps();
    const btns = [$('de-save'), $('de-draft')]; btns.forEach(b => { b.disabled = true; });
    const wasDraft = !editOrig || editOrig.status === 'draft';
    try {
      const r = editOrig ? await api('PUT', '/api/deals/' + editOrig.id, body) : await api('POST', '/api/deals', body);
      upsertDeal(r.deal);
      sessionUploads = new Set();
      $('dlg-edit').close();
      toast(asDraft ? 'Draft saved. Only your team can see it.' : wasDraft ? 'Deal published' : 'Deal saved');
      route({ keepScroll: true });
    } catch (ex) { err.hidden = false; err.textContent = ex.message; }
    btns.forEach(b => { b.disabled = false; });
  }

  // A clearly labeled practice listing, for trying the editor and drafts.
  $('de-sample').addEventListener('click', () => {
    const sample = {
      address: '1234 W Sample St', city: 'Chicago', zip: '60608', area: 'Pilsen', county: 'Cook', type: '2-flat',
      beds: 5, baths: 2, sqft: 2280, lot: '25 x 125', year: 1904, units: 2, occ: 'Vacant', parking: '2-car garage',
      price: 239000, arv: 465000, repairs: 118000, rent: 3100, emd: 5000, condition: 'Full rehab',
      desc: 'SAMPLE LISTING FOR TESTING. This is not a real property.\n\nBrick 2-flat with both units vacant and ready for a full rehab. Renovated 2-flats nearby trade around $450-480k.',
      hl: 'Both units vacant\nSeparate furnaces and meters\nNear the Pink Line',
      notes: 'Sample deal. Delete when done testing.',
    };
    for (const [k, v] of Object.entries(sample)) F(k).value = v;
    const close = new Date(Date.now() + 30 * 86400000);
    F('close').value = close.toISOString().slice(0, 10);
    F('comps').replaceChildren(
      compRow({ status: 'sold', address: '2300 W Sample Ave', beds: 5, baths: 2, sqft: 2300, price: 472000, distance: 0.3 }),
      compRow({ status: 'sold', address: '2150 W Example St', beds: 4, baths: 2, sqft: 2100, price: 455000, distance: 0.5 }),
      compRow({ status: 'active', address: '1900 S Demo Ave', beds: 6, baths: 3, sqft: 2500, price: 489000, distance: 0.7 }));
    toast('Sample deal filled in. Save it as a draft to test.');
  });

  /* ---------- team area ---------- */
  function renderTeam() {
    const root = $('view-team'); root.replaceChildren();
    if (!S.user) return root.append(loginForm());
    if (S.user.mustChange) return root.append(passwordForm(true));
    const tabs = [['deals', 'Deals'], ['inquiries', 'Offers & questions'], ['buyers', 'Buyers list']];
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
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(S.tab === k), onclick: () => { S.tab = k; renderTeam(); } },
          label, k === 'inquiries' && S.newInquiries ? h('span', { class: 'tab-badge', text: S.newInquiries }) : null))),
    );
    const body = h('div', {});
    root.append(body);
    if (S.tab === 'deals') body.append(dashDeals());
    if (S.tab === 'inquiries') dashInquiries(body);
    if (S.tab === 'buyers') dashBuyersList(body);
    if (S.tab === 'users') dashUsers(body);
    if (S.tab === 'settings') body.append(dashSettings());
    if (S.tab === 'account') body.append(passwordForm(false));
  }
  async function refreshInquiryBadge() {
    if (!S.user || S.user.mustChange) return;
    try {
      const n = (await api('GET', '/api/inquiries')).inquiries.filter(i => i.status === 'new').length;
      if (n !== S.newInquiries) { S.newInquiries = n; if (!$('view-team').hidden) renderTeam(); }
    } catch {}
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
        await loadDeals(); route(); refreshInquiryBadge();
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
        S.user.mustChange = false; toast('Password updated'); renderTeam(); refreshInquiryBadge();
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
    S.user = null; S.csrf = null; S.newInquiries = 0;
    await loadDeals();
    go('/');
  }

  function dashDeals() {
    const wrap = h('div', {});
    const c = counts(S.deals);
    c.draft = S.deals.filter(d => d.status === 'draft').length;
    const seg = h('div', { class: 'seg' }, [{ key: 'all', label: 'All' }, ...TEAM_STATUSES].map(o =>
      h('button', { type: 'button', 'aria-pressed': String(S.dashFilter === o.key), onclick: () => { S.dashFilter = o.key; renderTeam(); } },
        o.key !== 'all' ? h('span', { class: 'dot st-' + o.key }) : null, o.label, h('span', { class: 'count', text: c[o.key] }))));
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Search deals', 'aria-label': 'Search deals', value: S.dashQ });
    const tbody = h('tbody', {});
    const fill = () => {
      tbody.replaceChildren();
      const list = sortDeals(S.deals.filter(d => (S.dashFilter === 'all' || d.status === S.dashFilter) && matches(d, S.dashQ)), 'new');
      if (!list.length) tbody.append(h('tr', {}, h('td', { colspan: '8', class: 'muted', text: S.deals.length ? 'No deals match.' : 'No deals yet. Click Add deal to post your first one.' })));
      for (const d of list) {
        const sel = h('select', { class: 'select', 'aria-label': 'Status for ' + (d.address || 'draft') }, TEAM_STATUSES.map(s => h('option', { value: s.key, text: s.label })));
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
          h('td', {}, h('div', { class: 'addr', text: d.address || 'Untitled draft' }), h('div', { class: 'loc', text: d.status === 'draft' ? 'Draft · not visible to buyers' : locLine(d) })),
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

  function contactCell(p) {
    return h('td', {},
      p.phone ? h('a', { class: 'cell-link', href: telHref(p.phone), text: p.phone }) : null,
      p.email ? h('a', { class: 'cell-link', href: 'mailto:' + p.email, text: p.email }) : null);
  }

  async function dashInquiries(body) {
    const tbody = h('tbody', {}, h('tr', {}, h('td', { colspan: '7', class: 'muted', text: 'Loading…' })));
    body.append(h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', { text: 'Offers & questions' }), h('span', { class: 'muted', text: 'Sent by buyers from deal pages' })),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Received', 'Deal', 'Type', 'From', 'Contact', 'Status', ''].map(t => h('th', { text: t })))), tbody))));
    let list;
    try { list = (await api('GET', '/api/inquiries')).inquiries; }
    catch (e) { tbody.replaceChildren(h('tr', {}, h('td', { colspan: '7', class: 'err', text: e.message }))); return; }
    S.newInquiries = list.filter(i => i.status === 'new').length;
    tbody.replaceChildren();
    if (!list.length) tbody.append(h('tr', {}, h('td', { colspan: '7', class: 'muted', text: 'No offers or questions yet. They appear here when buyers use the form on a deal page.' })));
    for (const q of list) {
      const d = findDeal(q.dealId);
      const sel = h('select', { class: 'select', 'aria-label': 'Status' }, [['new', 'New'], ['contacted', 'Contacted'], ['closed', 'Done']].map(([v, l]) => h('option', { value: v, text: l })));
      sel.value = q.status;
      sel.addEventListener('change', async () => {
        try { await api('PATCH', '/api/inquiries/' + q.id, { status: sel.value }); q.status = sel.value; S.newInquiries = list.filter(i => i.status === 'new').length; toast('Updated'); }
        catch (e) { toast(e.message); }
      });
      const tr = h('tr', { class: q.status === 'new' ? 'is-new' : null },
        h('td', { class: 'muted', text: ago(q.createdAt) }),
        h('td', {}, d ? h('a', { class: 'cell-link', href: '/deal/' + d.id, 'data-link': true, text: d.address }) : h('span', { class: 'muted', text: 'Deleted deal' })),
        h('td', {}, q.kind === 'offer' ? h('span', { class: 'badge on', text: 'Offer ' + money(q.offer) }) : h('span', { class: 'badge', text: 'Question' })),
        h('td', {}, h('b', { text: q.name }), q.message ? h('div', { class: 'msg', text: q.message }) : null),
        contactCell(q),
        h('td', {}, sel),
        h('td', {}, h('button', { class: 'btn btn-sm btn-ghost btn-danger', type: 'button', onclick: async () => {
          try { await api('DELETE', '/api/inquiries/' + q.id); tr.remove(); toast('Deleted'); } catch (e) { toast(e.message); }
        } }, 'Delete')));
      tbody.append(tr);
    }
  }

  async function dashBuyersList(body) {
    const tbody = h('tbody', {}, h('tr', {}, h('td', { colspan: '7', class: 'muted', text: 'Loading…' })));
    const count = h('span', { class: 'muted' });
    body.append(h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'ph-title' }, h('h2', { text: 'Buyers list' }), count),
        h('div', { class: 'hero-cta' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(location.origin + '/buyers', () => toast('Sign-up link copied')) }, icon('link'), 'Copy sign-up link'),
          h('a', { class: 'btn btn-sm', href: '/api/buyers.csv' }, icon('download'), 'Download CSV'))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Buyer', 'Contact', 'Areas', 'Buys', 'Max price', 'Joined', ''].map(t => h('th', { text: t })))), tbody))));
    let list;
    try { list = (await api('GET', '/api/buyers')).buyers; }
    catch (e) { tbody.replaceChildren(h('tr', {}, h('td', { colspan: '7', class: 'err', text: e.message }))); return; }
    count.textContent = `${list.length} ${list.length === 1 ? 'buyer' : 'buyers'}`;
    tbody.replaceChildren();
    if (!list.length) tbody.append(h('tr', {}, h('td', { colspan: '7', class: 'muted', text: 'No sign-ups yet. Share the sign-up link with your buyers.' })));
    for (const b of list) {
      const acts = h('div', { class: 'row-acts' });
      const resetActs = () => acts.replaceChildren(h('button', { class: 'btn btn-sm btn-ghost btn-danger', type: 'button', onclick: () => acts.replaceChildren(
        h('div', { class: 'confirm' }, h('span', { text: 'Remove?' }),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: resetActs }, 'Keep'),
          h('button', { class: 'btn btn-sm btn-danger-solid', type: 'button', onclick: async () => {
            try { await api('DELETE', '/api/buyers/' + b.id); tr.remove(); toast('Buyer removed'); } catch (e) { toast(e.message); } } }, 'Remove'))) }, 'Remove'));
      resetActs();
      const buys = (b.types || []).join(', ');
      const tr = h('tr', {},
        h('td', {}, h('b', { text: b.name }), b.funding ? h('div', { class: 'muted', text: 'Funds with ' + b.funding }) : null, b.notes ? h('div', { class: 'msg', text: b.notes }) : null),
        contactCell(b),
        h('td', { text: b.areas || '—' }),
        h('td', { text: buys || '—' }),
        h('td', { class: 'r', text: money(b.maxPrice) }),
        h('td', { class: 'muted', text: ago(b.createdAt) }),
        h('td', {}, acts));
      tbody.append(tr);
    }
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
    const inp = (id, key, type, ph) => h('input', { class: 'input', id, type, value: s[key] || '', placeholder: ph });
    const f = {
      phone: inp('st-phone', 'phone', 'tel', '(312) 555-0100'),
      email: inp('st-email', 'email', 'email', 'deals@606homebuyers.com'),
      advisorName: inp('st-adv', 'advisorName', 'text', 'e.g. Marcus Lee'),
    };
    return h('form', { class: 'panel narrow', onsubmit: async e => {
      e.preventDefault(); err.hidden = true;
      try {
        const payload = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
        S.settings = Object.assign(S.settings, (await api('PUT', '/api/settings', payload)).settings);
        renderChrome(); toast('Settings saved');
      } catch (ex) { err.hidden = false; err.textContent = ex.message; }
    } },
      h('div', { class: 'panel-head' }, h('h2', { text: 'Public site settings' })),
      h('div', { class: 'panel-body' },
        h('p', { class: 'muted', text: 'Buyers see these on the site. Leave a field empty to hide it.' }),
        h('div', { class: 'field' }, h('label', { for: 'st-phone', text: 'Phone' }), f.phone),
        h('div', { class: 'field' }, h('label', { for: 'st-email', text: 'Email' }), f.email),
        h('div', { class: 'field' }, h('label', { for: 'st-adv', text: 'Dispositions contact name' }), f.advisorName, h('span', { class: 'hint', text: 'Shown next to the offer form on each deal.' })),
        err, h('div', {}, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save settings'))));
  }

  /* ---------- boot ---------- */
  (async () => {
    route({ keepScroll: true });
    await Promise.all([loadMe(), loadSettings()]);
    await loadDeals();
    route({ keepScroll: !location.hash });
    refreshInquiryBadge();
  })();
})();
