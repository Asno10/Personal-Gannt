import { CONFIG } from '../config.js';
import * as api from './sheets.js?v=14';
import * as cal from './calendar.js?v=14';
import { parseItems, colLetter, keyOfDate, dateOfKey, toNumber, serializeDays, newId, FIELDS } from './parse.js?v=14';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtH = (n) => (Math.round(n * 10) / 10).toString();
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortLabel = (k) => { const d = dateOfKey(k); return `${d.getDate()} ${MON[d.getMonth()]}`; };
const longLabel = (k) => dateOfKey(k).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const dowLabel = (k) => dateOfKey(k).toLocaleDateString('en-GB', { weekday: 'short' });
const daysBetween = (a, b) => Math.round((dateOfKey(b) - dateOfKey(a)) / 86400000);
const addDays = (k, n) => { const d = dateOfKey(k); d.setDate(d.getDate() + n); return keyOfDate(d); };
const todayKey = () => keyOfDate(new Date());
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// "Today", "Tomorrow", "Yesterday", or "Mon 26 Oct".
function relDay(k) {
  const n = daysBetween(todayKey(), k);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return `${dowLabel(k)} ${shortLabel(k)}`;
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const state = {
  raw: null,
  plan: null,
  // Google Calendar: status is idle | ok | off | error.
  cal: { status: 'idle', message: '', calendars: [], byDay: {}, calId: '', lastSync: 0, syncing: false, loadedRange: '' },
  view: store.get('pg.view') || 'today',
  day: todayKey(),
  taskFilter: 'open',
  loadedAt: 0,
  sync: 'idle', // idle | saving | saved | error
  collapsed: new Set(JSON.parse(store.get('pg.tlCollapsed') || '["calendar","other"]')),
  tlShowDone: false,
  showDone: false,
  dirty: false,
};

const app = $('#app');

// ---------- Boot and auth ----------

// ---------- Updates ----------
// GitHub Pages lets phones keep a copy of the page for up to ten minutes. On
// opening, and whenever the app comes back to the screen, it asks for the
// published version without any cache; if a newer one is out, it reloads at a
// fresh address so every file is fetched new.
const BUILD = '14';

async function checkForUpdate() {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { v } = await res.json();
    if (!v || v === BUILD) { sessionStorage.removeItem('pg.updating'); return; }
    if (writes.size || inflight) return; // finish saving first; checked again later
    if (sessionStorage.getItem('pg.updating') === v) return; // already tried once
    sessionStorage.setItem('pg.updating', v);
    location.replace(`./?v=${encodeURIComponent(v)}`);
  } catch {}
}

function boot() {
  checkForUpdate();
  if (!api.configured()) return renderSetup();
  renderSignIn();
}

function renderSetup() {
  app.innerHTML = `
    <main class="gate">
      <h1 class="gate-title">Personal Gantt</h1>
      <p>This copy of the app has no Google client ID yet. Add it to <code>config.js</code> and publish again.</p>
    </main>`;
}

function renderSignIn(message = '') {
  const returning = store.get('pg.signedIn') === '1';
  app.innerHTML = `
    <main class="gate">
      <h1 class="gate-title">Personal Gantt</h1>
      <p>Your study plan, tasks and deadlines, read live from Google Sheets and kept in step with Google Calendar. Sign in with the Google account that owns the sheet.</p>
      ${message ? `<p class="gate-error" role="alert">${esc(message)}</p>` : ''}
      <button class="btn btn-primary" data-action="sign-in">${returning ? 'Continue with Google' : 'Sign in with Google'}</button>
    </main>`;
}

async function signIn(silent) {
  try {
    await api.signIn({ silent });
    store.set('pg.signedIn', '1');
    await refresh({ first: true });
  } catch (e) {
    renderSignIn(e.message);
  }
}

function signOut() {
  api.signOut();
  store.del('pg.signedIn');
  state.raw = null;
  state.plan = null;
  renderSignIn();
}

// ---------- Data ----------

let lastRawJson = '';

async function refresh({ first = false } = {}) {
  if (first) app.innerHTML = `<main class="gate"><p class="loading">Loading the plan</p></main>`;
  try {
    const raw = await api.loadAll();
    if (writes.size || inflight || pendingOps) return; // newer local edits are waiting; their own refresh follows
    const json = JSON.stringify([raw.items, raw.settings]);
    const changed = json !== lastRawJson;
    lastRawJson = json;
    state.raw = raw;
    state.loadedAt = Date.now();
    if (changed || first) state.plan = parseItems(raw.items, raw.settings, todayKey());
    if (first) {
      state.day = clampDay(todayKey());
      render();
    } else if (changed) {
      render();
    } else {
      renderStatus();
    }
    afterLoad({ changed: changed || first });
  } catch (e) {
    if (e instanceof api.AuthError) return renderSignIn('Your session ended. Sign in again to continue.');
    if (first || !state.plan) return renderSignIn(e.message);
    toast(e.message);
  }
}

// After every load: keep the Personal Gantt calendar in step with the items,
// and fetch the other calendars' events for the days on screen.
function afterLoad({ changed }) {
  syncCalendar({ force: changed }).catch(() => {});
  loadCalendarEvents().catch(() => {});
}

function clampDay(k) {
  const d = state.plan?.days;
  if (!d?.length) return k;
  if (k < d[0].key) return d[0].key;
  if (k > d[d.length - 1].key) return d[d.length - 1].key;
  return k;
}

// ---------- Write queue ----------
// Edits update the screen at once and are sent to the sheet shortly after, in
// one batch. Several quick taps on a stepper become a single write.

// Every change is a field of one item, keyed by the item's id, never by a
// remembered row number: just before writing, the app reads the id column and
// finds each item's current row, so rows added or removed in the meantime (by
// Claude, another device, or by hand) cannot send a change to the wrong item.

const writes = new Map(); // "id|field" -> { id, field, value }
let flushTimer = null;
let inflight = null;
let savedTimer = null;
let pendingOps = 0; // row inserts and deletes in progress

const nowStamp = () => {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${keyOfDate(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`;
};

// Changes item fields on screen at once and queues them for the sheet.
// fields: { title: 'x', date: '2026-10-28', days: {...cells} } and so on.
function setFields(item, fields, { delay = 600, quiet = false } = {}) {
  for (const [f, v] of Object.entries(fields)) {
    const value = f === 'days' && typeof v === 'object' ? serializeDays(v) : v == null ? '' : String(v);
    writes.set(`${item.id}|${f}`, { id: item.id, field: f, value });
  }
  if (!quiet) writes.set(`${item.id}|updated`, { id: item.id, field: 'updated', value: nowStamp() });
  setSync('saving');
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, delay);
}

const queueQuiet = (item, fields) => setFields(item, fields, { delay: 1500, quiet: true });

const colOf = (field) => state.plan.header[field];

async function flush() {
  clearTimeout(flushTimer);
  if (inflight) await inflight.catch(() => {});
  if (!writes.size) return;
  const batch = [...writes.values()];
  writes.clear();
  inflight = (async () => {
    const { map } = await api.readIdColumn(colLetter(colOf('id')));
    const ups = [];
    const missing = new Set();
    for (const w of batch) {
      const row = map.get(w.id);
      const c = colOf(w.field);
      if (!row) { missing.add(w.id); continue; }
      if (c == null || c < 0) continue;
      ups.push({ range: api.a1(CONFIG.sheets.items, colLetter(c) + row), value: w.value });
    }
    if (ups.length) await api.writeCells(ups);
    return missing;
  })();
  try {
    const missing = await inflight;
    inflight = null;
    if (missing.size) toast('An item was removed from the sheet elsewhere, so that change was not saved.');
    if (!writes.size) {
      setSync('saved');
      await refresh();
    }
  } catch (e) {
    inflight = null;
    if (e instanceof api.AuthError) return renderSignIn('Your session ended before the last change was saved. Sign in and make it again.');
    setSync('error');
    toast(`Not saved. ${e.message}`);
    await refresh();
  }
}

// Adds new rows to the Items table.
async function addItems(partials, { message } = {}) {
  await flush();
  pendingOps++;
  setSync('saving');
  const rows = partials.map((p) => {
    const it = { id: newId(p.type), calendar: 'auto', updated: nowStamp(), ...p };
    if (it.days && typeof it.days === 'object') it.days = serializeDays(it.days);
    const header = state.raw.items[0].map((h) => String(h).trim().toLowerCase());
    return { it, row: header.map((h) => (it[h] == null ? '' : String(it[h]))) };
  });
  try {
    await api.appendRows(rows.map((r) => r.row));
    pendingOps--;
    setSync('saved');
    if (message) toast(message);
  } catch (e) {
    pendingOps--;
    if (e instanceof api.AuthError) { renderSignIn('Your session ended before the item was added. Sign in and add it again.'); return null; }
    setSync('error');
    toast(`Not added. ${e.message}`);
    await refresh();
    return null;
  }
  await refresh();
  return rows.map((r) => findItem(r.it.id)).filter(Boolean);
}

// Deletes an item's row, and its calendar event if it has one.
async function removeItem(item, { message } = {}) {
  await flush();
  pendingOps++;
  setSync('saving');
  try {
    if (item.eventId && state.cal.calId && state.cal.status === 'ok') await cal.deleteEvent(state.cal.calId, item.eventId).catch(() => {});
    const { map } = await api.readIdColumn(colLetter(colOf('id')));
    const row = map.get(item.id);
    if (row) await api.deleteRow(state.raw.sheetIds[CONFIG.sheets.items], row);
    pendingOps--;
    setSync('saved');
    if (message) toast(message);
  } catch (e) {
    pendingOps--;
    if (e instanceof api.AuthError) return renderSignIn('Your session ended before the item was deleted. Sign in and try again.');
    setSync('error');
    toast(`Not deleted. ${e.message}`);
  }
  await refresh();
}

function setSync(s) {
  state.sync = s;
  clearTimeout(savedTimer);
  if (s === 'saved') savedTimer = setTimeout(() => setSync('idle'), 2500);
  renderStatus();
}

// ---------- Google Calendar ----------

const CAL_HIDE = /#holiday@|classroom/; // holidays stay off the plan; class feeds are noise
const shownCalendars = () => {
  const saved = store.get('pg.calShown');
  if (saved) { try { return new Set(JSON.parse(saved)); } catch {} }
  return null; // default: see defaultShown
};
const defaultShown = (c) => !CAL_HIDE.test(c.id) && c.id !== state.cal.calId && !/irec/i.test(c.name || '');
const isShown = (c) => { const s = shownCalendars(); return c.id !== state.cal.calId && (s ? s.has(c.id) : defaultShown(c)); };

function calFailed(e) {
  if (e instanceof cal.CalendarOff) {
    if (state.cal.status !== 'off') { state.cal.status = 'off'; state.cal.message = e.message; render(); }
    return;
  }
  if (e instanceof api.AuthError) return;
  state.cal.status = 'error';
  state.cal.message = e.message;
  renderStatus();
}

// Brings the Personal Gantt calendar in line with the items: creates, moves or
// removes events as items change, and deletes events whose item is gone.
async function syncCalendar({ force = false } = {}) {
  const c = state.cal;
  if (c.syncing || !state.plan || !api.hasToken()) return;
  if (!force && Date.now() - c.lastSync < 60000) return;
  c.syncing = true;
  try {
    if (!c.calendars.length) c.calendars = await cal.listCalendars();
    const saved = state.plan.settings.calendar_id?.value || '';
    const { id } = await cal.ensureCalendar(saved || c.calId, CONFIG.calendarName, CONFIG.timeZone, c.calendars);
    c.calId = id;
    if (id !== saved) await saveSetting('calendar_id', id);
    c.status = 'ok';
    c.message = '';

    const tz = state.plan.settings.timezone?.value || CONFIG.timeZone;
    let changes = 0;
    const done = [];
    const setFields = (item, fields) => done.push([item, fields]);
    for (const item of state.plan.items) {
      if (writes.size || inflight || pendingOps) break; // the person is editing; finish next time
      if (cal.wantsEvent(item)) {
        const body = cal.eventBody(item, tz);
        const sig = cal.signature(body);
        if (item.eventId && item.synced === sig) continue;
        let ev = null;
        if (item.eventId) ev = await cal.patchEvent(id, item.eventId, body);
        if (!ev) {
          // Another device may have created it a moment ago.
          const found = await cal.listEvents(id, null, null, { privateProp: `pgId=${item.id}` });
          ev = found[0] ? await cal.patchEvent(id, found[0].id, body) : null;
          if (!ev) ev = await cal.insertEvent(id, body);
          for (const extra of found.slice(1)) await cal.deleteEvent(id, extra.id);
        }
        item.eventId = ev.id;
        item.synced = sig;
        setFields(item, { event_id: ev.id, synced: sig }, { delay: 1500, quiet: true });
        changes++;
      } else if (item.eventId) {
        await cal.deleteEvent(id, item.eventId);
        item.eventId = '';
        item.synced = '';
        setFields(item, { event_id: '', synced: '' }, { delay: 1500, quiet: true });
        changes++;
      }
    }
    // Events whose item no longer exists in the sheet.
    if (state.plan.items.length) {
      const ids = new Set(state.plan.items.map((i) => i.id));
      const mine = await cal.listEvents(id, addDays(todayKey(), -120), null);
      for (const ev of mine) {
        const pg = ev.extendedProperties?.private?.pgId;
        if (pg && !ids.has(pg)) { await cal.deleteEvent(id, ev.id); changes++; }
      }
    }
    // Event ids go back to the sheet in one batch, without touching "updated".
    for (const [item, fields] of done) queueQuiet(item, fields);
    c.lastSync = Date.now();
    if (changes) loadCalendarEvents({ force: true }).catch(() => {});
  } catch (e) {
    calFailed(e);
  } finally {
    c.syncing = false;
    renderStatus();
  }
}

async function saveSetting(key, value) {
  const s = state.plan.settings[key];
  const range = s ? api.a1(CONFIG.sheets.settings, `B${s.row}`) : null;
  if (range) return api.writeCells([{ range, value }]);
  const rows = state.raw.settings.length;
  return api.writeCells([{ range: api.a1(CONFIG.sheets.settings, `A${rows + 1}`), value: key }, { range: api.a1(CONFIG.sheets.settings, `B${rows + 1}`), value }]);
}

// Events from the other calendars, for the days the plan covers.
async function loadCalendarEvents({ force = false } = {}) {
  const c = state.cal;
  if (!state.plan || !api.hasToken() || c.status === 'off') return;
  const days = state.plan.days;
  if (!days.length) return;
  const range = `${days[0].key}|${days.at(-1).key}|${[...(shownCalendars() || [])].join(',')}`;
  if (!force && c.loadedRange === range && Date.now() - (c.eventsAt || 0) < 5 * 60000) return;
  try {
    if (!c.calendars.length) c.calendars = await cal.listCalendars();
    const list = c.calendars.filter(isShown);
    const byDay = {};
    await Promise.all(list.map(async (cl) => {
      const evs = await cal.listEvents(cl.id, days[0].key, days.at(-1).key);
      for (const ev of evs) for (const d of cal.toDayEvents(ev, cl)) (byDay[d.key] ||= []).push(d);
    }));
    for (const k of Object.keys(byDay)) byDay[k].sort((a, b) => (a.allDay === b.allDay ? (a.time || '').localeCompare(b.time || '') : a.allDay ? -1 : 1));
    c.byDay = byDay;
    c.loadedRange = range;
    c.eventsAt = Date.now();
    if (c.status !== 'ok') c.status = 'ok';
    render();
  } catch (e) {
    calFailed(e);
  }
}

const calEventsOn = (k) => state.cal.byDay[k] || [];

// ---------- Subject colours ----------

function subjectIndex(name) {
  const i = state.plan.study.map((s) => s.subject).indexOf(name);
  return i >= 0 ? i % 8 : -1;
}
const subjectVar = (name) => { const i = subjectIndex(name); return i >= 0 ? `var(--s${i})` : 'var(--ink-3)'; };

// ---------- Shell ----------

const VIEWS = [
  ['today', 'Day', 'day'],
  ['timeline', 'Timeline', 'grid'],
  ['exams', 'Exams', 'flag'],
  ['tasks', 'Tasks', 'list'],
];

// The app is a fixed top bar over a pager: one page per tab, side by side.
// Each page scrolls (and bounces) on its own, so the bar never moves, and a
// sideways swipe snaps to the next tab. The shell is built once; renders only
// replace page contents, so scroll positions and the day strip are kept.
function ensureShell() {
  if ($('#pager')) return false;
  app.innerHTML = `
    <header class="bar" id="bar">
      <div class="bar-left"><span class="status" id="status" aria-live="polite"></span></div>
      <div class="bar-title">Personal Gantt</div>
      <div class="bar-side">
        <button class="icon-btn" data-action="refresh" aria-label="Reload from the sheet" title="Reload from the sheet">${ICON.refresh}</button>
        <button class="icon-btn" data-action="menu" aria-label="Account" title="Account">${ICON.user}</button>
      </div>
    </header>
      <nav class="tabs" id="tabs" aria-label="Views">
        <span class="tab-glow" aria-hidden="true"></span>
        ${VIEWS.map(([v, label, icon]) => `<button class="tab" data-action="view" data-view="${v}" aria-current="false">${ICON[icon]}<span>${label}</span></button>`).join('')}
      </nav>
    <div class="pager" id="pager">
      ${VIEWS.map(([v]) => `<section class="page" id="page-${v}" data-view="${v}"><main class="view view-${v}" id="view-${v}"></main></section>`).join('')}
    </div>`;
  bindPager($('#pager'));
  bindTabDrag($('#tabs'));
  // The bar is clear over the top of a page and turns to glass once content
  // scrolls under it, as iOS navigation bars do.
  $$('.page').forEach((pg) => pg.addEventListener('scroll', () => { if (pg.dataset.view === state.view) updateBarGlass(); }, { passive: true }));
  return true;
}

// Only the page on screen is drawn straight away. The others are marked and
// drawn a moment later, one at a time and never while a page is being swiped,
// so a change on the Day page does not also rebuild the large Timeline table.
const dirty = new Set();
let idleTimer = 0;
let pagerMovedAt = 0;

function renderPage(v) {
  dirty.delete(v);
  if (v === 'today') return renderDayPage();
  if (v === 'timeline') return renderTimelinePage();
  if (v === 'exams') $('#view-exams').innerHTML = renderExams();
  if (v === 'tasks') $('#view-tasks').innerHTML = renderTasks();
}

// The Timeline is replaced only when its contents actually change.
function renderTimelinePage() {
  const view = $('#view-timeline');
  const html = renderTimeline();
  if (view._html === html) return;
  const tlLeft = $('#tl-scroll')?.scrollLeft;
  view.innerHTML = html;
  view._html = html;
  const sc = $('#tl-scroll');
  if (!sc) return;
  bindTimelineScroll(sc);
  if (tlLeft != null) sc.scrollLeft = tlLeft;
  else scrollTimelineToToday(false);
  syncTimelineHead();
}

function renderLater() {
  clearTimeout(idleTimer);
  const next = () => {
    const v = VIEWS.map(([x]) => x).find((x) => dirty.has(x));
    if (!v) return;
    if (Date.now() - pagerMovedAt < 250 || $('#dialog')?.open) { idleTimer = setTimeout(next, 250); return; }
    renderPage(v);
    idleTimer = setTimeout(next, 40);
  };
  idleTimer = setTimeout(next, 300);
}

function render() {
  if (!state.plan) return;
  if ($('#dialog')?.open) { state.dirty = true; return; }
  if (!VIEWS.some(([v]) => v === state.view)) state.view = 'today';
  const fresh = ensureShell();
  const bar = $('.bar');
  document.documentElement.style.setProperty('--bar-h', bar.offsetHeight + 'px');

  for (const [v] of VIEWS) dirty.add(v);
  renderPage(state.view);
  renderStatus();
  updateTabs();
  if (fresh) goToPage(state.view, false);
  renderLater();
}

// ---------- Pager ----------

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const pageIndex = (v) => Math.max(0, VIEWS.findIndex(([x]) => x === v));
let pagerTarget = null;

function updateBarGlass() {
  const pg = $(`#page-${state.view}`);
  $('#bar')?.classList.toggle('is-scrolled', Boolean(pg && pg.scrollTop > 4));
}

function updateTabs() {
  updateBarGlass();
  $$('.tab').forEach((t) => t.setAttribute('aria-current', t.dataset.view === state.view ? 'page' : 'false'));
}

function setView(v) {
  if (state.view === v) return;
  state.view = v;
  store.set('pg.view', v);
  if (dirty.has(v)) renderPage(v);
  updateTabs();
}

function goToPage(v, smooth) {
  const p = $('#pager');
  if (!p) return;
  setView(v);
  const tabs = $('#tabs');
  if (tabs) {
    // The highlight springs to the tab on its own, ahead of the sliding page.
    if (smooth && !reducedMotion()) {
      tabs.classList.add('is-springing');
      clearTimeout(tabs._spring);
      tabs._spring = setTimeout(() => tabs.classList.remove('is-springing'), 560);
    }
    tabs.style.setProperty('--ti', pageIndex(v));
  }
  pagerTarget = smooth && !reducedMotion() ? pageIndex(v) : null;
  p.scrollTo({ left: pageIndex(v) * p.clientWidth, behavior: pagerTarget == null ? 'auto' : 'smooth' });
}

function bindPager(p) {
  p.addEventListener('touchstart', () => { pagerTarget = null; }, { passive: true });
  p.addEventListener('scroll', () => {
    pagerMovedAt = Date.now();
    const w = p.clientWidth || 1;
    if (pagerTarget != null) {
      // A tab tap slides past the pages in between; keep the tapped tab lit.
      if (Math.abs(p.scrollLeft - pagerTarget * w) < 2) pagerTarget = null;
      return;
    }
    const v = VIEWS[Math.round(p.scrollLeft / w)]?.[0];
    if (v) setView(v);
  }, { passive: true });
  // The glass highlight in the tab bar follows the pages as they are swiped.
  p.addEventListener('scroll', () => {
    if (pagerTarget != null) return;
    $('#tabs')?.style.setProperty('--ti', (p.scrollLeft / (p.clientWidth || 1)).toFixed(3));
  }, { passive: true });
}

// Touching the tab bar lifts the glass highlight under the finger; dragging
// slides it across the tabs, and letting go opens the tab it rests on.
let tabTouchAt = 0;
function bindTabDrag(nav) {
  let active = false, x0 = 0, moved = false;
  const wide = () => window.matchMedia('(min-width: 760px)').matches;
  const tiAt = (x) => {
    const r = nav.getBoundingClientRect();
    const slot = (r.width - 10) / VIEWS.length;
    return Math.min(VIEWS.length - 1, Math.max(0, (x - r.left - 5) / slot - 0.5));
  };
  const mark = (i) => $$('.tab', nav).forEach((t, j) => t.classList.toggle('is-under', j === i));
  nav.addEventListener('touchstart', (ev) => {
    if (wide() || ev.touches.length !== 1) return;
    active = true; moved = false; x0 = ev.touches[0].clientX;
    tabTouchAt = Date.now();
    pagerTarget = 'drag';
    const ti = Math.round(tiAt(x0));
    nav.classList.add('is-pressing', 'is-springing');
    nav.style.setProperty('--ti', ti);
    mark(ti);
  }, { passive: true });
  nav.addEventListener('touchmove', (ev) => {
    if (!active) return;
    const x = ev.touches[0].clientX;
    if (!moved && Math.abs(x - x0) < 6) return;
    if (!moved) { moved = true; nav.classList.remove('is-springing'); nav.classList.add('is-dragging'); }
    const ti = tiAt(x);
    nav.style.setProperty('--ti', ti.toFixed(3));
    mark(Math.round(ti));
  }, { passive: true });
  const end = (cancel) => {
    if (!active) return;
    active = false;
    tabTouchAt = Date.now();
    nav.classList.remove('is-pressing', 'is-dragging');
    mark(-1);
    const i = cancel ? pageIndex(state.view) : Math.round(parseFloat(nav.style.getPropertyValue('--ti')) || 0);
    pagerTarget = null;
    goToPage(VIEWS[i][0], true);
  };
  nav.addEventListener('touchend', () => end(false), { passive: true });
  nav.addEventListener('touchcancel', () => end(true), { passive: true });
}

window.addEventListener('resize', () => {
  const p = $('#pager');
  if (p) p.scrollLeft = pageIndex(state.view) * p.clientWidth;
  const bar = $('.bar');
  if (bar) document.documentElement.style.setProperty('--bar-h', bar.offsetHeight + 'px');
});

function renderStatus() {
  const el = $('#status');
  if (!el) return;
  const s = state.sync;
  el.className = `status is-${s}`;
  if (s === 'saving') el.textContent = 'Saving';
  else if (s === 'saved') el.innerHTML = `${ICON.check}Saved`;
  else if (s === 'error') el.textContent = 'Not saved';
  else el.textContent = state.loadedAt ? 'Updated ' + new Date(state.loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
}

// ---------- Shared queries ----------

const ofType = (type) => state.plan.byType(type);
const allTasks = () => ofType('task');
const findItem = (id) => state.plan?.items.find((i) => i.id === id);
const readings = () => ofType('reading');
const readingsOn = (k) => readings().filter((r) => r.start === k);
const notesOn = (k) => ofType('note').filter((n) => coversDay(n, k));
const exerciseOn = (k) => ofType('exercise').filter((e) => e.cells[k]);
const EX_MARK = { A: 'Day A: upper body and scapular', B: 'Day B: lower body, core and back', L: 'Light posture block', W: 'Weigh-in' };
const exLabel = (v) => EX_MARK[String(v).toUpperCase()] || v;

const studyHoursOn = (k) => state.plan.study.reduce((n, s) => n + toNumber(s.cells[k]), 0);
const studyOn = (k) => state.plan.study.map((s) => ({ item: s, hours: toNumber(s.cells[k]) })).filter((x) => x.hours > 0);
const plannedDays = (t) => Object.entries(t.cells).filter(([, v]) => /x/i.test(v)).map(([d]) => d).sort();
const taskDue = (t) => plannedDays(t)[0] || t.start || null;
const tasksOn = (k) => allTasks().filter((t) => (plannedDays(t).length ? plannedDays(t).includes(k) : t.start === k));
const isOverdue = (t) => t.status.status === 'open' && taskDue(t) && taskDue(t) < todayKey();

// The days a task is on: its X cells, or else its Start to End dates.
function currentDays(t) {
  const xs = plannedDays(t);
  if (xs.length) return xs;
  if (!t.start) return [];
  const out = [];
  for (let k = t.start, n = 0; k <= (t.end || t.start) && n < 62; k = addDays(k, 1), n++) out.push(k);
  return out;
}

// Study log: hours actually studied, one sheet row per subject.
const logRowFor = (subject) => (state.plan.logs || []).find((l) => l.subject === subject);
const loggedOn = (subject, k) => toNumber(logRowFor(subject)?.cells[k]);
const loggedOnDay = (k) => (state.plan.logs || []).reduce((n, l) => n + toNumber(l.cells[k]), 0);
const loggedUpTo = (subject, last) => Object.entries(logRowFor(subject)?.cells || {}).filter(([d]) => d <= last).reduce((n, [, v]) => n + toNumber(v), 0);

function coversDay(item, k) {
  if (item.cells[k]) return true;
  return item.start && item.end ? item.start <= k && k <= item.end : item.start === k;
}

function nextExams(fromKey) {
  return state.plan.exams.filter((e) => e.start && e.start >= fromKey).sort((a, b) => (a.start + a.time).localeCompare(b.start + b.time));
}

// ---------- Day view ----------

function renderDayPage() {
  const view = $('#view-today');
  if (!$('#day-head', view)) view.innerHTML = `
    <div class="day-head" id="day-head">
      <div class="day-nav-top">
        <span class="month" id="day-month"></span>
        <span class="spacer"></span>
        <button class="chip-btn" id="day-today" data-action="go-today">Today</button>
        <label class="icon-btn pick-date" title="Pick a date" aria-label="Pick a date">${ICON.calendar}
          <input type="date" id="day-pick" data-input="pick-day">
        </label>
      </div>
      <div id="strip-wrap"></div>
    </div>
    <div class="day-body" id="day-body"></div>`;
  // The strip is rebuilt only when its contents change, never on a day change,
  // and keeps its scroll position, so the days do not jump.
  const wrap = $('#strip-wrap');
  const html = renderStrip();
  const firstStrip = !$('#strip');
  if (wrap.dataset.sig !== html) {
    const left = $('#strip')?.scrollLeft;
    wrap.innerHTML = html;
    wrap.dataset.sig = html;
    const strip = $('#strip');
    bindStrip(strip);
    if (left != null) strip.scrollLeft = left;
  }
  updateDayHead();
  $('#day-body').innerHTML = renderToday();
  if (firstStrip) centerStrip(true);
}

function updateDayHead() {
  const k = state.day;
  $('#day-month').textContent = dateOfKey(k).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  $('#day-today').classList.toggle('is-hidden', k === todayKey());
  const pick = $('#day-pick');
  pick.value = k;
  pick.min = state.plan.days[0]?.key || '';
  pick.max = state.plan.days.at(-1)?.key || '';
  markStripDay(k);
}

function markStripDay(k) {
  $$('#strip .strip-day').forEach((b) => {
    const on = b.dataset.day === k;
    b.classList.toggle('is-selected', on);
    b.setAttribute('aria-selected', String(on));
  });
}

// Choosing a day: from a tap, the date picker, Today, or the strip settling.
function selectDay(k, { fromStrip = false, smooth = true } = {}) {
  k = clampDay(k);
  if (!state.plan.dayByKey[k]) return;
  const changed = k !== state.day;
  const dir = k > state.day ? 'next' : 'prev';
  state.day = k;
  updateDayHead();
  if (changed) {
    const body = $('#day-body');
    body.innerHTML = renderToday();
    body.classList.remove('turn-next', 'turn-prev');
    void body.offsetWidth;
    body.classList.add('turn-' + dir);
  }
  if (!fromStrip) centerStrip(!smooth);
}

let stripAuto = false;

function centerStrip(instant) {
  const strip = $('#strip');
  const sel = strip?.querySelector(`[data-day="${state.day}"]`);
  if (!strip || !sel) return;
  const left = sel.offsetLeft - (strip.clientWidth - sel.offsetWidth) / 2;
  if (Math.abs(strip.scrollLeft - left) < 1) return;
  stripAuto = !instant && !reducedMotion();
  strip.scrollTo({ left, behavior: stripAuto ? 'smooth' : 'auto' });
}

function centeredDay(strip) {
  const mid = strip.scrollLeft + strip.clientWidth / 2;
  let best = null, dist = Infinity;
  for (const b of strip.children) {
    const d = Math.abs(b.offsetLeft + b.offsetWidth / 2 - mid);
    if (d < dist) { dist = d; best = b; }
  }
  return best?.dataset.day;
}

// Swiping the strip moves the selection: the day that snaps to the middle
// becomes the selected day once the strip comes to rest.
function bindStrip(strip) {
  let timer = 0, touching = false;
  const settle = () => {
    if (touching) return;
    if (stripAuto) { stripAuto = false; return; }
    const k = centeredDay(strip);
    if (k && k !== state.day) selectDay(k, { fromStrip: true });
  };
  strip.addEventListener('touchstart', () => { touching = true; stripAuto = false; }, { passive: true });
  strip.addEventListener('touchend', () => { touching = false; clearTimeout(timer); timer = setTimeout(settle, 160); }, { passive: true });
  strip.addEventListener('scroll', () => {
    if (!stripAuto) markStripDay(centeredDay(strip));
    clearTimeout(timer);
    timer = setTimeout(settle, 160);
  }, { passive: true });
}

function renderToday() {
  const k = state.day;
  const isToday = k === todayKey();
  const canLog = k <= todayKey();
  const planned = studyOn(k);
  const total = planned.reduce((n, s) => n + s.hours, 0);
  // On past days and today, subjects studied without a plan show up too.
  const study = [...planned, ...(canLog ? state.plan.study.filter((s) => !planned.some((x) => x.item === s) && loggedOn(s.subject, k) > 0).map((item) => ({ item, hours: 0 })) : [])];
  const logged = canLog ? loggedOnDay(k) : 0;
  const tasks = tasksOn(k);
  const open = tasks.filter((t) => t.status.status === 'open');
  const done = tasks.filter((t) => t.status.status === 'done');
  const overdue = isToday ? allTasks().filter((t) => isOverdue(t) && !tasks.includes(t)) : [];
  const reads = readingsOn(k);
  const readsDone = reads.filter((r) => r.status.status === 'done').length;
  const readsLate = isToday ? readings().filter((r) => r.status.status === 'open' && r.start && r.start < k) : [];
  const events = ofType('event').filter((e) => coversDay(e, k)).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  const calEvents = calEventsOn(k);
  const exercise = exerciseOn(k);
  const phase = ofType('exercise').find((e) => !/weigh/i.test(e.subject) && e.start && e.start <= k && k <= (e.end || e.start));
  const notes = notesOn(k);
  const other = state.plan.other.filter((o) => coversDay(o, k));
  const others = state.plan.study.filter((s) => !study.some((x) => x.item === s));

  return `
    <h1 class="day-title">${esc(longLabel(k))}</h1>

    ${renderCountdown(k)}

    <section class="block">
      <div class="block-head">
        <h2>Study</h2>
        <span class="block-meta">${total ? fmtH(total) + ' h planned' : 'Nothing planned'}${canLog && (total || logged) ? `, <b class="${logged >= total && logged ? 'is-good' : ''}">${fmtH(logged)} h studied</b>` : ''}</span>
      </div>
      <ul class="study-list">${study.map(({ item, hours }) => studyRow(item, hours, k)).join('')}</ul>
      ${others.length ? `
        <div class="add-row">
          <span class="add-label">${canLog ? 'Log time for another subject' : 'Add a subject'}</span>
          <div class="chips">${others.map((s) => canLog
            ? `<button class="chip" style="--c:${subjectVar(s.subject)}" data-action="log-hours" data-subject="${esc(s.subject)}" data-day="${k}" aria-label="Log time for ${esc(s.subject)}">${esc(s.subject)}</button>`
            : `<button class="chip" style="--c:${subjectVar(s.subject)}" data-action="hours" data-id="${s.id}" data-day="${k}" data-delta="1" aria-label="Add 1 hour of ${esc(s.subject)}">${esc(s.subject)}</button>`).join('')}</div>
        </div>` : ''}
    </section>

    ${reads.length || readsLate.length ? `
    <section class="block">
      <div class="block-head">
        <h2>Reading</h2>
        <span class="block-meta">${reads.length ? `${readsDone} of ${reads.length} done, ${fmtH(reads.reduce((n, r) => n + r.hours, 0))} h` : ''}</span>
      </div>
      <ul class="task-list">${reads.map((r) => taskRow(r, { hideDate: true, reading: true })).join('')}</ul>
      ${readsLate.length ? `<h3 class="sub is-alert">Not read yet</h3><ul class="task-list">${readsLate.map((r) => taskRow(r, { reading: true })).join('')}</ul>` : ''}
    </section>` : ''}

    <section class="block">
      <div class="block-head">
        <h2>Tasks</h2>
        <span class="block-meta">${tasks.length ? `${done.length} of ${tasks.length} done` : 'None planned'}</span>
      </div>
      <ul class="task-list">${open.map((t) => taskRow(t, { hideDate: true })).join('')}</ul>
      ${done.length ? `
        <button class="fold" data-action="toggle-done" aria-expanded="${state.showDone}">${ICON[state.showDone ? 'down' : 'right']}${plural(done.length, 'done task')}</button>
        ${state.showDone ? `<ul class="task-list">${done.map((t) => taskRow(t, { hideDate: true })).join('')}</ul>` : ''}` : ''}
      ${overdue.length ? `<h3 class="sub is-alert">Overdue</h3><ul class="task-list">${overdue.map((t) => taskRow(t)).join('')}</ul>` : ''}
      <button class="add-btn" data-action="add-task" data-day="${k}">${ICON.plus}Add a task for ${esc(relDay(k).toLowerCase().startsWith('to') || relDay(k) === 'Yesterday' ? relDay(k).toLowerCase() : 'this day')}</button>
    </section>

    <section class="block">
      <div class="block-head"><h2>Calendar</h2><span class="block-meta">${calMeta()}</span></div>
      ${events.map((e) => eventLine(e, k)).join('')}
      ${calEvents.map((e) => `<div class="event is-cal" style="--c:${esc(e.color || 'var(--ink-3)')}"><span class="event-kind">${e.allDay ? 'All day' : esc(e.time + (e.endTime ? ' to ' + e.endTime : ''))}</span><span>${esc(e.title)}<small class="event-cal">${esc(e.calName)}</small></span></div>`).join('')}
      ${!events.length && !calEvents.length ? `<p class="note is-quiet">${state.cal.status === 'ok' ? 'Nothing in your calendars.' : state.cal.status === 'off' ? 'Calendar not connected. See Account.' : 'Loading calendars.'}</p>` : ''}
    </section>

    <section class="block">
      <div class="block-head"><h2>Notes</h2></div>
      ${notes.map((n) => `<button class="line" data-action="edit-note" data-id="${n.id}" data-day="${k}">${esc(n.title)}<span class="line-edit">${ICON.pen}</span></button>`).join('')}
      <button class="line is-empty" data-action="edit-note" data-day="${k}">${notes.length ? 'Add another note' : 'Nothing noted for this day. Tap to add.'}<span class="line-edit">${ICON.pen}</span></button>
    </section>

    ${exercise.length || phase ? `
    <section class="block">
      <div class="block-head"><h2>Exercise</h2>${phase ? `<span class="block-meta">${esc(phase.subject)}</span>` : ''}</div>
      ${exercise.map((e) => `<button class="line" data-action="edit-cell" data-id="${e.id}" data-day="${k}"><strong>${esc(exLabel(e.cells[k]))}</strong><span class="line-edit">${ICON.pen}</span></button>`).join('')}
      ${!exercise.some((e) => !/weigh/i.test(e.subject)) && phase ? `<button class="line is-empty" data-action="edit-cell" data-id="${phase.id}" data-day="${k}">Rest day. Tap to plan a session.<span class="line-edit">${ICON.pen}</span></button>` : ''}
      ${phase ? `<p class="note">${esc(phase.title)}</p>` : ''}
    </section>` : ''}

    ${other.length ? `
    <section class="block">
      <div class="block-head"><h2>Other</h2></div>
      <ul class="task-list">${other.map((o) => taskRow(o, { hideDate: true })).join('')}</ul>
    </section>` : ''}
  `;
}

function calMeta() {
  const c = state.cal;
  if (c.status === 'off') return 'Not connected';
  if (c.status === 'error') return 'Could not load';
  return '';
}

function eventLine(e, k) {
  const alert = /deadline/i.test(e.subject);
  return `<button class="event ${alert ? 'is-alert' : ''}" data-action="edit-task" data-id="${e.id}"><span class="event-kind">${esc(e.time || e.subject || 'Event')}</span><span>${esc(e.title)}${e.time && e.subject ? `<small class="event-cal">${esc(e.subject)}</small>` : ''}</span></button>`;
}

function renderStrip() {
  const days = state.plan.days;
  const max = Math.max(1, ...days.map((d) => studyHoursOn(d.key)));
  const examDays = new Set(state.plan.exams.map((e) => e.start));
  const tk = todayKey();
  return `
    <div class="strip" id="strip" role="listbox" aria-label="Choose a day">
      ${days.map((d) => {
        const h = studyHoursOn(d.key);
        const dt = dateOfKey(d.key);
        const openTasks = tasksOn(d.key).some((t) => t.status.status === 'open');
        return `<button class="strip-day ${d.key === tk ? 'is-today' : ''} ${dt.getDay() % 6 === 0 ? 'is-weekend' : ''}" role="option" aria-selected="false" data-action="pick-day" data-day="${d.key}" aria-label="${esc(longLabel(d.key))}${h ? `, ${fmtH(h)} hours` : ''}${examDays.has(d.key) ? ', exam' : ''}">
          <span class="sd-dow">${esc(dowLabel(d.key).slice(0, 2))}</span>
          <span class="sd-num">${dt.getDate()}</span>
          <span class="sd-load"><span style="width:${Math.round((h / max) * 100)}%"></span></span>
          <span class="sd-marks">${examDays.has(d.key) ? '<i class="m-exam"></i>' : ''}${openTasks ? '<i class="m-task"></i>' : ''}</span>
        </button>`;
      }).join('')}
    </div>`;
}

// Widget-style card: a small label, the next exam on the left with its
// countdown on the right, then the following exams as a short list.
function renderCountdown(k) {
  const exams = nextExams(k);
  if (!exams.length) return '';
  const todays = exams.filter((e) => e.start === k);
  const lead = todays.length ? todays : [exams[0]];
  const n = daysBetween(k, lead[0].start);
  const later = exams.filter((e) => !lead.includes(e)).slice(0, 3);
  const whenOf = (e) => [e.start === k ? 'Today' : `${dowLabel(e.start)} ${shortLabel(e.start)}`, e.time].filter(Boolean).join(', ');
  const left = (e) => { const d = daysBetween(k, e.start); return d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `${d} days`; };
  return `
    <section class="countdown">
      <p class="cd-label">${todays.length ? (todays.length > 1 ? 'Exams today' : 'Exam today') : 'Next exam'}</p>
      <div class="cd-main">
        <div class="cd-lead">
          ${lead.map((e) => `
            <div class="cd-exam" style="--c:${subjectVar(e.subject)}">
              <strong>${esc(e.subject)}</strong>
              <span>${esc(whenOf(e))}</span>
            </div>`).join('')}
        </div>
        <div class="cd-num" aria-label="${n === 0 ? 'Today' : plural(n, 'day') + ' left'}">${n === 0 ? '<b class="is-word">Today</b>' : `<b>${n}</b><small>${n === 1 ? 'day' : 'days'}</small>`}</div>
      </div>
      ${later.length ? `
        <ul class="cd-later">
          ${later.map((e) => `<li style="--c:${subjectVar(e.subject)}"><span class="cd-sub">${esc(e.subject)}</span><span class="cd-in">${esc(left(e))}</span></li>`).join('')}
        </ul>` : ''}
    </section>`;
}

function studyRow(item, hours, k) {
  return `
    <li class="study" style="--c:${subjectVar(item.subject)}">
      <span class="study-swatch" aria-hidden="true"></span>
      <div class="study-main">
        <button class="study-name" data-action="edit-hours" data-id="${item.id}" data-day="${k}">${esc(item.subject)}</button>
        ${k <= todayKey() ? (() => {
          const l = loggedOn(item.subject, k);
          return `<button class="log-btn ${l ? 'is-logged' : ''} ${l && l >= hours ? 'is-good' : ''}" data-action="log-hours" data-subject="${esc(item.subject)}" data-day="${k}">${l ? `${ICON.check}Studied ${fmtH(l)} h` : `${ICON.plus}Log studied time`}</button>`;
        })() : ''}
      </div>
      <span class="stepper">
        <button class="step" data-action="hours" data-id="${item.id}" data-day="${k}" data-delta="-0.5" aria-label="Half an hour less ${esc(item.subject)}">${ICON.minus}</button>
        <button class="study-hours" data-action="edit-hours" data-id="${item.id}" data-day="${k}" aria-label="${fmtH(hours)} hours planned, tap to change">${fmtH(hours)}<small>h</small></button>
        <button class="step" data-action="hours" data-id="${item.id}" data-day="${k}" data-delta="0.5" aria-label="Half an hour more ${esc(item.subject)}">${ICON.plus}</button>
      </span>
    </li>`;
}

function taskRow(t, { hideDate = false, reading = false } = {}) {
  const st = t.status;
  const done = st.status === 'done';
  const due = taskDue(t);
  const overdue = isOverdue(t);
  const lateBy = overdue ? daysBetween(due, todayKey()) : 0;
  const isRead = reading || t.type === 'reading';
  const where = isRead
    ? [t.subject, t.hours ? fmtH(t.hours) + ' h' : ''].filter(Boolean).join(', ')
    : [t.time, t.phase, t.subject].filter(Boolean).join(', ');
  return `
    <li class="task ${done ? 'is-done' : ''} ${isRead ? 'is-reading' : ''} ${state.justToggled === t.id ? 'is-popping' : ''}" ${isRead ? `style="--c:${subjectVar(t.subject)}"` : ''}>
      <button class="check" data-action="toggle-task" data-id="${t.id}" role="checkbox" aria-checked="${done}" aria-label="${done ? 'Mark as not done' : 'Mark as done'}: ${esc(st.title)}">${ICON.check}</button>
      <button class="task-body" data-action="edit-task" data-id="${t.id}">
        <span class="task-title">${st.prio ? `<span class="prio prio-${esc(st.prio.slice(1))}">${esc(st.prio)}</span>` : ''}${esc(st.title)}</span>
        ${st.note ? `<span class="task-note">${esc(st.note)}</span>` : ''}
        <span class="task-meta">${esc(where)}</span>
      </button>
      ${done
        ? `<span class="due is-done">${st.doneOn ? 'Done ' + esc(st.doneOn) : 'Done'}</span>`
        : hideDate && !overdue ? '' : `<button class="due ${overdue ? 'is-late' : ''}" data-action="move-task" data-id="${t.id}" aria-label="Change date">${due ? (overdue ? `${plural(lateBy, 'day')} late` : esc(relDay(due))) : 'No date'}</button>`}
    </li>`;
}

// ---------- Timeline ----------
// The full plan as a table: one row per subject, task or event, one column per
// day. The names stay pinned on the left and the dates on top while it scrolls.
// Exams sit on their subject's row, and empty days are left blank.


// The Timeline is drawn without a table. The names sit in their own column,
// which never scrolls sideways, and the grid beside it scrolls on its own.
// Day lines, weekends and today are a few full-height stripes behind the rows,
// and each row holds only the days that have something on them, placed by
// position. A tap anywhere on a row is turned into the day under the finger.
// This keeps the page to a few hundred elements instead of several thousand,
// so it scrolls smoothly on an iPad.
function renderTimeline() {
  const days = state.plan.days;
  const n = days.length;
  const tk = todayKey();
  const idx = Object.fromEntries(days.map((d, i) => [d.key, i]));
  const maxH = Math.max(1, ...state.plan.study.flatMap((s) => Object.values(s.cells).map(toNumber)));
  const at = (k, inner, cls = '', w = 1) => (idx[k] == null || !inner ? '' : `<span class="gc ${cls}" style="--i:${idx[k]}${w > 1 ? `;--w:${w}` : ''}">${inner}</span>`);

  // Dates along the top.
  const dates = days.map((d, i) => {
    const dt = dateOfKey(d.key);
    const h = studyHoursOn(d.key);
    const month = i === 0 || dt.getDate() === 1;
    return `<button class="tl-day ${d.key === tk ? 'is-today' : ''} ${dt.getDay() === 0 ? 'is-sunday' : ''}" data-action="open-day" data-day="${d.key}" aria-label="Open ${esc(longLabel(d.key))}">
      <span class="tl-month">${month ? MON[dt.getMonth()] : ''}</span>
      <span class="tl-dow">${esc(dowLabel(d.key).slice(0, 2))}</span>
      <span class="tl-num">${dt.getDate()}</span>
      <span class="tl-sum">${h ? fmtH(h) + 'h' : ''}</span>
    </button>`;
  }).join('');

  // Stripes behind the grid: weekends, the end of each week, and today.
  const stripes = days.map((d, i) => {
    const wd = dateOfKey(d.key).getDay();
    let out = '';
    if (wd === 6 || (wd === 0 && i === 0)) out += `<i class="tlx-col is-weekend" style="--i:${i};--w:${wd === 6 && i < n - 1 ? 2 : 1}"></i>`;
    if (d.key === tk) out += `<i class="tlx-col is-today" style="--i:${i}"></i>`;
    return out;
  }).join('');

  const names = [];
  const rows = [];
  // kind: row (48px), tall (60px, two-line names), sec (44px) or more (40px), the same in both columns.
  const add = ({ kind = 'row', cls = '', color = '', name, cell = '' }) => {
    const st = color ? ` style="--c:${color}"` : '';
    names.push(`<div class="tn tk-${kind} ${cls}"${st}>${name}</div>`);
    rows.push(`<div class="gr tk-${kind} ${cls}"${st}${cell}</div>`);
  };
  const nameHtml = ({ name, sub = '', action = '' }) => `${action ? `<button ${action}>` : '<div class="tl-name-in">'}<span class="tl-label">${esc(name)}</span>${sub ? `<span class="tl-sub">${esc(sub)}</span>` : ''}${action ? '</button>' : '</div>'}`;
  // cell: what a tap on an empty day does, then the filled days.
  const grid = (action, id, inner) => `${action ? ` data-action="grid-cell" data-cell="${action}"${id ? ` data-id="${id}"` : ''}` : ''}>${inner}`;

  const section = (id, title, meta, list, preview) => {
    if (!list.length) return;
    const shut = state.collapsed.has(id);
    const entering = state.justOpened === id ? 'is-entering' : '';
    add({
      kind: 'sec', cls: `tl-section ${shut ? 'is-shut' : ''}`,
      name: `<button data-action="toggle-section" data-key="${id}" aria-expanded="${!shut}">${ICON[shut ? 'right' : 'down']}<span>${esc(title)}</span><span class="tl-count">${esc(meta)}</span></button>`,
      cell: grid(shut ? 'open-day' : '', '', shut && preview ? days.map((d) => at(d.key, preview(d.key))).join('') : ''),
    });
    if (!shut) for (const r of list) add({ ...r, cls: `${r.cls || ''} ${entering}` });
  };

  // Study: one row per subject, with its exam at the end of the row.
  const study = state.plan.study.map((s) => {
    const exam = state.plan.exams.find((e) => e.subject === s.subject);
    const keys = Object.keys(s.cells).filter((k) => toNumber(s.cells[k]) > 0).sort();
    const runEnd = [exam?.start, keys.at(-1)].filter(Boolean).sort().at(-1);
    const total = keys.reduce((m, k) => m + toNumber(s.cells[k]), 0);
    let inner = '';
    const shown = new Set([...keys, ...(exam?.start ? [exam.start] : []), ...Object.keys(logRowFor(s.subject)?.cells || {})]);
    // A thin line through the empty days between the first study day and the exam.
    if (keys[0] && runEnd && idx[keys[0]] != null && idx[runEnd] != null) {
      for (let i = idx[keys[0]] + 1, j; i < idx[runEnd]; i = j) {
        j = i + 1;
        if (shown.has(days[i].key)) continue;
        while (j < idx[runEnd] && !shown.has(days[j].key)) j++;
        inner += `<i class="gc-run" style="--i:${i};--w:${j - i}"></i>`;
      }
    }
    for (const k of shown) {
      const h = toNumber(s.cells[k]);
      const lg = k <= tk ? loggedOn(s.subject, k) : 0;
      const isExam = exam?.start === k;
      const badge = lg ? `<span class="tl-log ${lg >= h ? 'is-good' : ''}">${fmtH(lg)}</span>` : '';
      const body = isExam
        ? `<span class="tl-exam-pill">Exam${exam.time ? `<small>${esc(exam.time)}</small>` : ''}</span>`
        : h ? `<span class="tl-h" style="--a:${Math.round(18 + 40 * (h / maxH))}%">${fmtH(h)}</span>` : '';
      inner += at(k, body + badge, 'is-solid');
    }
    return { cls: 'tl-study', color: subjectVar(s.subject), name: nameHtml({ name: s.subject, sub: `${fmtH(total)} h${exam ? `, exam ${shortLabel(exam.start)}` : ''}` }), cell: grid('edit-hours', s.id, inner) };
  });
  const lonelyExams = state.plan.exams.filter((e) => !state.plan.study.some((s) => s.subject === e.subject)).map((e) => ({
    cls: 'tl-study', color: subjectVar(e.subject), name: nameHtml({ name: e.subject, sub: `Exam ${shortLabel(e.start)}`, action: `data-action="edit-task" data-id="${e.id}"` }),
    cell: grid('open-day', '', at(e.start, '<span class="tl-exam-pill">Exam</span>', 'is-solid')),
  }));

  // A task or reading: a dot on each planned day, a tick once done.
  const dots = (t, dotCls = '') => {
    const isDone = t.status.status === 'done';
    const pd = plannedDays(t);
    return (pd.length ? pd : t.start ? [t.start] : []).map((k) => at(k, isDone ? `<span class="tl-done">${ICON.check}</span>` : `<span class="tl-dot ${dotCls}"></span>`)).join('');
  };

  // Tasks: open ones first by date; done ones only when asked for.
  const all = allTasks();
  const open = all.filter((t) => t.status.status === 'open').sort((a, b) => (taskDue(a) || '9').localeCompare(taskDue(b) || '9'));
  const done = all.filter((t) => t.status.status === 'done');
  const taskRow = (t) => {
    const isDone = t.status.status === 'done';
    const late = isOverdue(t);
    return {
      kind: 'tall', cls: `tl-tasks ${isDone ? 'is-done' : ''} ${late ? 'is-late' : ''}`,
      name: nameHtml({ name: t.status.title, sub: isDone ? 'Done' : late ? `${plural(daysBetween(taskDue(t), tk), 'day')} late` : [t.time, t.phase, t.subject].filter(Boolean).join(', '), action: `data-action="edit-task" data-id="${t.id}"` }),
      cell: grid('task-day', t.id, dots(t)),
    };
  };
  const taskRows = open.map(taskRow);
  if (done.length) {
    taskRows.push({ kind: 'more', cls: 'tl-more', name: `<button data-action="toggle-done-tl">${state.tlShowDone ? 'Hide' : 'Show'} done (${done.length})</button>`, cell: grid('', '', '') });
    if (state.tlShowDone) taskRows.push(...done.map(taskRow));
  }

  // Reading plans: one row per reading, by subject and date.
  const readRows = readings().slice().sort((x, y) => (x.subject + (x.start || '9')).localeCompare(y.subject + (y.start || '9'))).map((r) => {
    const isDone = r.status.status === 'done';
    const late = isOverdue(r);
    return {
      kind: 'tall', cls: `tl-tasks tl-reading ${isDone ? 'is-done' : ''} ${late ? 'is-late' : ''}`, color: subjectVar(r.subject),
      name: nameHtml({ name: r.title, sub: [r.subject, r.hours ? fmtH(r.hours) + ' h' : '', isDone ? 'done' : late ? 'not read yet' : ''].filter(Boolean).join(', '), action: `data-action="edit-task" data-id="${r.id}"` }),
      cell: grid('task-day', r.id, dots(r, 'tl-dot-sub')),
    };
  });

  // Deadlines and events kept in the sheet: a bar over the days they cover.
  const eventRows = ofType('event').map((e) => {
    const alert = /deadline/i.test(e.subject);
    const s0 = e.start;
    const s1 = e.end || e.start;
    const span = s0 && idx[s0] != null ? Math.max(1, (idx[s1] ?? idx[s0]) - idx[s0] + 1) : 1;
    const marks = Object.keys(e.cells).map((k) => at(k, `<span class="tl-bar ${alert ? 'is-alert' : ''}"></span>`)).join('');
    return {
      cls: `tl-events ${alert ? 'is-alert' : ''}`,
      name: nameHtml({ name: e.title, sub: [e.subject, e.time].filter(Boolean).join(', '), action: `data-action="edit-task" data-id="${e.id}"` }),
      cell: grid('open-day', '', (s0 ? at(s0, `<span class="tl-bar ${alert ? 'is-alert' : ''}"></span>`, 'is-bar', span) : '') + marks),
    };
  });

  // The other Google calendars: one row each, with that day's event count.
  const calRows = state.cal.status !== 'ok' ? [] : state.cal.calendars.filter(isShown).map((cl) => ({
    cls: 'tl-cal', color: cl.color, name: nameHtml({ name: cl.name, sub: 'Google Calendar' }),
    cell: grid('open-day', '', days.map((d) => {
      const evs = calEventsOn(d.key).filter((e) => e.calId === cl.id);
      return evs.length ? at(d.key, `<span class="tl-mark tl-calmark">${evs.length > 1 ? evs.length : esc(evs[0].time || 'All')}</span>`) : '';
    }).join('')),
  }));

  // Exercise: one row per programme phase and the weigh-ins.
  const exerciseRows = ofType('exercise').map((x) => {
    const phase = x.start && idx[x.start] != null && !/weigh/i.test(x.subject)
      ? `<i class="gc-phase" style="--i:${idx[x.start]};--w:${(idx[x.end || x.start] ?? n - 1) - idx[x.start] + 1}"></i>` : '';
    return {
      cls: 'tl-exercise', name: nameHtml({ name: x.subject || x.title, sub: x.start ? `${shortLabel(x.start)} to ${shortLabel(x.end || x.start)}` : '', action: `data-action="edit-task" data-id="${x.id}"` }),
      cell: grid('edit-cell', x.id, phase + Object.entries(x.cells).map(([k, v]) => at(k, `<span class="tl-ex">${esc(v)}</span>`)).join('')),
    };
  });

  // Anything of a type the app does not know yet, so nothing in the sheet is hidden.
  const otherRows = [...state.plan.other, ...ofType('note')].map((o) => ({
    cls: 'tl-tasks', name: nameHtml({ name: o.title || o.subject || o.id, sub: o.type, action: `data-action="edit-task" data-id="${o.id}"` }),
    cell: grid('open-day', '', days.filter((d) => coversDay(o, d.key)).map((d) => at(d.key, '<span class="tl-dot"></span>')).join('')),
  }));

  const studyTotal = state.plan.study.reduce((m, s) => m + Object.values(s.cells).reduce((x, v) => x + toNumber(v), 0), 0);
  const readOpen = readings().filter((r) => r.status.status === 'open').length;
  // What a closed section still shows on each day.
  const preview = {
    study(k) {
      const h = studyHoursOn(k);
      return state.plan.exams.some((e) => e.start === k) ? '<span class="tl-exam-pill tl-mini">Exam</span>' : h ? `<span class="tl-pv-h">${fmtH(h)}</span>` : '';
    },
    tasks(k) {
      const on = tasksOn(k);
      const o = on.filter((t) => t.status.status === 'open').length;
      return o ? `<span class="tl-dot ${o > 1 ? 'is-many' : ''}">${o > 1 ? o : ''}</span>` : on.length ? `<span class="tl-done is-faint">${ICON.check}</span>` : '';
    },
    reading(k) {
      const on = readingsOn(k);
      const o = on.filter((t) => t.status.status === 'open').length;
      return o ? `<span class="tl-dot tl-dot-sub ${o > 1 ? 'is-many' : ''}">${o > 1 ? o : ''}</span>` : on.length ? `<span class="tl-done is-faint">${ICON.check}</span>` : '';
    },
    events(k) {
      const ev = ofType('event').filter((e) => coversDay(e, k));
      return ev.length ? `<span class="tl-bar ${ev.some((e) => /deadline/i.test(e.subject)) ? 'is-alert' : ''}"></span>` : '';
    },
    calendar(k) {
      const c = calEventsOn(k).length;
      return c ? `<span class="tl-mark tl-calmark">${c}</span>` : '';
    },
    exercise(k) {
      const marks = exerciseOn(k).map((e) => e.cells[k]);
      return marks.length ? `<span class="tl-ex">${esc(marks.join(' '))}</span>` : '';
    },
    other(k) {
      return [...state.plan.other, ...ofType('note')].some((o) => coversDay(o, k)) ? '<span class="tl-dot"></span>' : '';
    },
  };

  section('study', 'Study', `${fmtH(studyTotal)} h`, [...study, ...lonelyExams], preview.study);
  section('reading', 'Reading', `${readOpen}`, readRows, preview.reading);
  section('tasks', 'Tasks', `${open.length} open`, taskRows, preview.tasks);
  section('events', 'Deadlines and events', plural(eventRows.length, 'item'), eventRows, preview.events);
  section('calendar', 'Google Calendar', '', calRows, preview.calendar);
  section('exercise', 'Exercise', '', exerciseRows, preview.exercise);
  section('other', 'Other', plural(otherRows.length, 'item'), otherRows, preview.other);

  return `
    <h1 class="page-title tl-title">Timeline</h1>
    <div class="tl-legend" aria-label="Legend">
      <span><i class="lg-h"></i>Planned hours</span>
      <span><i class="tl-log is-good lg-log">2</i>Studied</span>
      <span><i class="lg-exam">Exam</i>Exam day</span>
      <span><i class="tl-dot"></i>Task planned</span>
      <span><i class="lg-bar"></i>Event</span>
      <span><i class="tl-mark tl-calmark lg-cal">2</i>Calendar</span>
    </div>
    <div class="tlx" style="--n:${n}">
      <div class="tlx-head">
        <div class="tlx-corner"><button class="tl-today-btn" data-action="tl-today">${ICON.target}Today</button></div>
        <div class="tlx-dates" id="tl-head"><div class="tlx-in">${dates}</div></div>
      </div>
      <div class="tlx-body">
        <div class="tlx-names">${names.join('')}</div>
        <div class="tlx-grid" id="tl-scroll"><div class="tlx-in">${stripes}${rows.join('')}</div></div>
      </div>
    </div>
    <p class="tl-tip">Tap a study day to log what you studied or change the plan, a task day to plan, move or finish it, or a date to open that day. The number under each date is that day's planned study total.</p>`;
}

// The timeline is two parts: the date row, pinned under the top bar, and the
// grid, which scrolls sideways only. Up and down moves the whole page, so a
// swipe moves along one axis at a time and the dates never drift from the grid.
// Where the browser supports scroll-driven animations (Safari 26 and later),
// the date row is moved by the grid's own scrolling, in the same frame, so it
// can never trail behind. Older browsers fall back to copying the position on
// each scroll event.
const NATIVE_FOLLOW = Boolean(window.CSS?.supports?.('animation-timeline: --a') && CSS.supports('timeline-scope: --a'));
if (NATIVE_FOLLOW) document.documentElement.classList.add('tl-follow');

function syncTimelineHead() {
  if (NATIVE_FOLLOW) return;
  const sc = $('#tl-scroll');
  const hd = $('#tl-head');
  if (sc && hd && hd.scrollLeft !== sc.scrollLeft) hd.scrollLeft = sc.scrollLeft;
}

function bindTimelineScroll(sc) {
  sc.addEventListener('scroll', syncTimelineHead, { passive: true });
  // A long press on the chart should do nothing, not select text or open a menu.
  for (const el of [sc, $('#tl-head')]) el?.addEventListener('contextmenu', (ev) => ev.preventDefault());
  // A sideways swipe on the date row moves the grid too.
  const hd = $('#tl-head');
  if (!hd) return;
  let x0 = null, y0 = 0, left0 = 0, axis = '';
  hd.addEventListener('touchstart', (ev) => {
    if (ev.touches.length !== 1) { x0 = null; return; }
    x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; left0 = sc.scrollLeft; axis = '';
  }, { passive: true });
  hd.addEventListener('touchmove', (ev) => {
    if (x0 == null) return;
    const dx = ev.touches[0].clientX - x0, dy = ev.touches[0].clientY - y0;
    if (!axis && Math.hypot(dx, dy) > 8) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (axis === 'x') sc.scrollLeft = left0 - dx;
  }, { passive: true });
  let v = 0, lastX = 0, lastT = 0, raf = 0;
  hd.addEventListener('touchstart', (ev) => { cancelAnimationFrame(raf); v = 0; lastX = ev.touches[0]?.clientX || 0; lastT = performance.now(); }, { passive: true });
  hd.addEventListener('touchmove', (ev) => {
    const x = ev.touches[0].clientX, t = performance.now();
    if (t > lastT) v = 0.8 * ((lastX - x) / (t - lastT)) + 0.2 * v;
    lastX = x; lastT = t;
  }, { passive: true });
  hd.addEventListener('touchend', () => {
    const glide = axis === 'x';
    x0 = null;
    if (!glide || Math.abs(v) < 0.05) return;
    // Let the grid coast after a sideways flick on the date row.
    let prev = performance.now();
    const step = (t) => {
      const dt = t - prev; prev = t;
      sc.scrollLeft += v * dt;
      v *= Math.pow(0.995, dt);
      if (Math.abs(v) > 0.02) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }, { passive: true });
  hd.addEventListener('wheel', (ev) => {
    const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.shiftKey ? ev.deltaY : 0;
    if (d) { sc.scrollLeft += d; ev.preventDefault(); }
  }, { passive: false });
}

function scrollTimelineToToday(smooth) {
  const sc = $('#tl-scroll');
  const i = state.plan.days.findIndex((d) => d.key === todayKey());
  if (!sc || i < 0) return;
  const w = sc.scrollWidth / state.plan.days.length;
  sc.scrollTo({ left: Math.max(0, (i - 1) * w), behavior: smooth ? 'smooth' : 'auto' });
}

// ---------- Exams ----------

function renderExams() {
  const tk = todayKey();
  const exams = [...state.plan.exams].filter((e) => e.start).sort((a, b) => (a.start + a.time).localeCompare(b.start + b.time));
  const upcoming = exams.filter((e) => e.start >= tk);
  const past = exams.filter((e) => e.start < tk);
  return `
    <h1 class="page-title">Exams</h1>
    <div class="exam-grid">${upcoming.map((e) => examCard(e, tk)).join('') || '<p class="empty">No upcoming exams in the sheet.</p>'}</div>
    ${past.length ? `<h2 class="sub">Finished</h2><div class="exam-grid is-past">${past.map((e) => examCard(e, tk)).join('')}</div>` : ''}`;
}

// One clean card per exam: subject, when, and the countdown; one progress bar;
// one line with hours, pace and a Log button. Tapping the card opens its
// day-by-day chart.
function examCard(e, tk) {
  const study = state.plan.study.find((s) => s.subject === e.subject);
  const active = study ? state.plan.days.filter((d) => d.key <= e.start).map((d) => ({ k: d.key, h: toNumber(study.cells[d.key]) })).filter((x) => x.h > 0) : [];
  const total = active.reduce((n, x) => n + x.h, 0);
  // Planned up to yesterday, against what was actually logged (up to the exam).
  const dueSoFar = active.filter((x) => x.k < tk).reduce((n, x) => n + x.h, 0);
  const studied = loggedUpTo(e.subject, e.start);
  const logCells = Object.entries(logRowFor(e.subject)?.cells || {}).filter(([d, v]) => d <= e.start && toNumber(v) > 0).map(([d]) => d);
  const firstK = [active[0]?.k, ...logCells].filter(Boolean).sort()[0];
  const span = firstK ? state.plan.days.filter((d) => d.key >= firstK && d.key <= e.start) : [];
  const max = Math.max(1, ...span.map((d) => Math.max(toNumber(study?.cells[d.key]), loggedOn(e.subject, d.key))));
  const n = daysBetween(tk, e.start);
  const rooms = (((e.notes + ' ' + e.task).match(/rooms?\s+([\d,\s]+)/i) || [])[1] || '').trim().replace(/,$/, '');
  // Leave out "Midterm" (they all are); keep names such as "YDS/2 (ÖSYM)".
  const base = e.task.replace(/,?\s*rooms?\s+[\d,\s]+$/i, '').trim();
  const rest = base.startsWith(e.subject + ' ') ? base.slice(e.subject.length).trim() : base;
  const kind = /^midterm$/i.test(rest) || rest === e.subject ? '' : rest;
  const when = [kind, `${dowLabel(e.start)} ${shortLabel(e.start)}`, e.time, rooms ? `Rooms ${rooms}` : ''].filter(Boolean);
  const pct = total ? Math.min(100, Math.round((studied / total) * 100)) : 0;
  const gap = dueSoFar - studied;
  const pace = !study || n < 0 ? '' : gap > 0.25 ? `<span class="pace-t is-behind">${fmtH(gap)} h behind</span>` : studied >= total && total ? '<span class="pace-t is-good">Plan covered</span>' : dueSoFar > 0 || studied > 0 ? `<span class="pace-t is-good">${gap < -0.25 ? `${fmtH(-gap)} h ahead` : 'On plan'}</span>` : '';
  const open = state.examOpen?.has(e.subject);
  const reads = readings().filter((r) => r.subject === e.subject && (!r.start || r.start <= e.start));
  const readsDone = reads.filter((r) => r.status.status === 'done').length;
  const readsLate = reads.filter((r) => isOverdue(r)).length;
  const count = n < 0 ? '<b class="is-word">Done</b>' : n === 0 ? '<b class="is-word">Today</b>' : `<b>${n}</b><small>${n === 1 ? 'day' : 'days'}</small>`;
  return `
    <article class="exam ${open ? 'is-open' : ''}" style="--c:${subjectVar(e.subject)}" ${study ? `data-action="toggle-exam" data-subject="${esc(e.subject)}" aria-expanded="${Boolean(open)}"` : ''}>
      <header class="exam-top">
        <div class="exam-id">
          <h2 class="exam-subject">${esc(e.subject)}</h2>
          <p class="exam-when">${when.map(esc).join(' · ')}</p>
        </div>
        <div class="exam-count ${n <= 3 && n >= 0 ? 'is-near' : ''}" aria-label="${n < 0 ? 'Finished' : n === 0 ? 'Today' : plural(n, 'day') + ' left'}">${count}</div>
      </header>
      ${study ? `
        <div class="progress-bar" role="img" aria-label="${fmtH(studied)} of ${fmtH(total)} planned hours studied"><span style="width:${pct}%"></span></div>
        <div class="exam-line">
          <span class="exam-hours"><b>${fmtH(studied)}</b> of ${fmtH(total)} h${pace ? ' · ' + pace : ''}</span>
          ${n >= 0 ? `<button class="log-btn" data-action="log-hours" data-subject="${esc(e.subject)}" data-day="${tk}">${ICON.plus}Log</button>` : ''}
        </div>
        ${reads.length ? `<p class="exam-read">Reading <b>${readsDone}</b> of ${reads.length} done${readsLate ? ` · <span class="pace-t is-behind">${readsLate} behind</span>` : ''}</p>` : ''}
        ${open && span.length ? `
          <div class="exam-chart">
            <div class="spark" aria-hidden="true">
              ${span.map((d) => {
                const h = toNumber(study.cells[d.key]);
                const l = d.key <= tk ? loggedOn(e.subject, d.key) : 0;
                const pctH = (x) => (x ? Math.max(10, (x / max) * 100) : 0);
                return `<span class="spark-day ${d.key === tk ? 'is-today' : ''}"><i class="spark-plan" style="height:${h ? pctH(h) : 0}%"></i>${l ? `<i class="spark-done" style="height:${pctH(l)}%"></i>` : ''}</span>`;
              }).join('')}
            </div>
            <div class="spark-axis"><span>${esc(shortLabel(firstK))}</span><span class="spark-key"><i class="k-plan"></i>Planned<i class="k-done"></i>Studied</span><span>Exam</span></div>
          </div>` : ''}` : ''}
    </article>`;
}

// ---------- Tasks ----------

function renderTasks() {
  const f = state.taskFilter;
  const tk = todayKey();
  const tasks = allTasks();
  const count = (s) => tasks.filter((t) => s === 'all' || t.status.status === s).length;
  const shown = tasks.filter((t) => f === 'all' || t.status.status === f);

  const groups = [
    ['Overdue', (t) => isOverdue(t)],
    ['Today', (t) => taskDue(t) === tk],
    ['Tomorrow', (t) => taskDue(t) === addDays(tk, 1)],
    ['Next 7 days', (t) => taskDue(t) > addDays(tk, 1) && taskDue(t) <= addDays(tk, 7)],
    ['Later', (t) => taskDue(t) > addDays(tk, 7)],
    ['No date', (t) => !taskDue(t)],
    ['Earlier', () => true],
  ];
  const placed = new Set();
  const sections = [];
  const pool = f === 'done' ? [] : shown.filter((t) => t.status.status === 'open');
  for (const [label, test] of groups) {
    const list = pool.filter((t) => !placed.has(t) && test(t)).sort((a, b) => (taskDue(a) || '').localeCompare(taskDue(b) || ''));
    list.forEach((t) => placed.add(t));
    if (list.length) sections.push([label, list]);
  }
  const doneList = shown.filter((t) => t.status.status === 'done');
  if (doneList.length) sections.push(['Done', doneList]);

  return `
    <h1 class="page-title">Tasks</h1>
    <form class="quick-add" data-form="quick-add">
      <input name="task" placeholder="Add a task" autocomplete="off" aria-label="New task" required>
      <div class="qa-dates" role="radiogroup" aria-label="When">
        ${[['today', 'Today', tk], ['tomorrow', 'Tomorrow', addDays(tk, 1)]].map(([v, l, k], i) => `<label class="pick"><input type="radio" name="when" value="${k}" ${i === 0 ? 'checked' : ''}><span>${l}</span></label>`).join('')}
        <label class="pick"><input type="radio" name="when" value="pick"><span>${ICON.calendar}Date</span></label>
        <input type="date" name="date" class="qa-date" value="${addDays(tk, 2)}" aria-label="Pick a date">
      </div>
      <button class="btn btn-primary" type="submit">Add</button>
    </form>
    <div class="segmented" role="tablist">
      ${[['open', 'To do'], ['done', 'Done'], ['all', 'All']].map(([v, l]) => `<button role="tab" aria-selected="${f === v}" data-action="task-filter" data-filter="${v}">${l} <span>${count(v)}</span></button>`).join('')}
    </div>
    ${sections.map(([label, list]) => `
      <section class="block">
        <h2 class="group ${label === 'Overdue' ? 'is-alert' : ''}">${label}<span>${list.length}</span></h2>
        <ul class="task-list">${list.map((t) => taskRow(t)).join('')}</ul>
      </section>`).join('') || `<p class="empty">${f === 'done' ? 'Nothing marked done yet.' : 'Nothing to do. Add a task above.'}</p>`}
    <p class="hint">Tasks live in the Items table of your sheet. Tasks with a time also appear in your Personal Gantt calendar.</p>`;
}

// ---------- Actions ----------

function setHours(item, k, value) {
  const v = Math.min(16, Math.max(0, Math.round(value * 2) / 2));
  if (v === toNumber(item.cells[k])) return;
  if (v) item.cells[k] = String(v); else delete item.cells[k];
  render();
  setFields(item, { days: item.cells });
}

async function setLogged(subject, k, value) {
  const v = Math.min(16, Math.max(0, Math.round(value * 4) / 4));
  let row = logRowFor(subject);
  if (!row) {
    if (!v) return;
    [row] = (await addItems([{ type: 'log', area: 'Log', subject, title: 'Actual hours', calendar: 'off' }])) || [];
    if (!row) return;
  }
  if (v === toNumber(row.cells[k])) return;
  if (v) row.cells[k] = String(v); else delete row.cells[k];
  render();
  setFields(row, { days: row.cells }, { delay: 300 });
  toast(v ? `${subject}: ${fmtH(v)} h studied ${relDay(k) === 'Today' ? 'today' : 'on ' + relDay(k)}` : `Cleared ${subject} for ${relDay(k)}`);
}

function setTaskStatus(item, next, { announce = true } = {}) {
  const st = item.status;
  if (st.status === next) return;
  const prev = { status: st.status, doneOn: item.doneOn };
  const doneOn = next === 'done' ? todayKey() : '';
  item.doneOn = doneOn;
  item.status = { ...st, status: next, doneOn: doneOn ? shortLabel(doneOn) : '' };
  state.justToggled = next === 'done' ? item.id : null;
  render();
  state.justToggled = null;
  setFields(item, { status: next, done_on: doneOn }, { delay: 300 });
  if (announce) {
    toast(next === 'done' ? `Done: ${st.title}` : `Back to do: ${st.title}`, () => {
      item.doneOn = prev.doneOn;
      item.status = { ...item.status, status: prev.status, doneOn: prev.doneOn ? shortLabel(prev.doneOn) : '' };
      render();
      setFields(item, { status: prev.status, done_on: prev.doneOn }, { delay: 0 });
    });
  }
}

const toggleTask = (item) => setTaskStatus(item, item.status.status === 'done' ? 'open' : 'done');

// Puts an item on exactly these days. One day, or a run of days, is stored as
// date and end; scattered days are listed in the days column with X marks.
function setTaskDays(item, days, message) {
  days = [...new Set(days)].filter(Boolean).sort();
  const before = currentDays(item);
  const run = days.length > 1 && days.every((d, i) => i === 0 || d === addDays(days[i - 1], 1));
  const s0 = days[0] || '';
  const s1 = days.length > 1 ? days.at(-1) : '';
  const cells = {};
  // Keep any non-X values (such as hours); drop the old X marks.
  for (const [k, v] of Object.entries(item.cells)) if (!/^x$/i.test(v)) cells[k] = v;
  if (days.length > 1 && !run) for (const d of days) cells[d] = 'X';
  item.cells = cells;
  item.start = s0 || null;
  item.end = s1 || null;
  render();
  setFields(item, { date: s0, end: s1, days: cells }, { delay: 200 });
  if (message) toast(message, () => setTaskDays(item, before));
}

const moveTask = (item, k) => setTaskDays(item, k ? [k] : [], k ? `Moved to ${relDay(k)}` : 'Date removed');
const addTaskDay = (item, k) => setTaskDays(item, [...currentDays(item), k], `Also planned for ${relDay(k)}`);
const removeTaskDay = (item, k) => setTaskDays(item, currentDays(item).filter((d) => d !== k), `Removed from ${relDay(k)}`);

const deleteTask = (item) => removeItem(item, { message: `Deleted: ${item.title}` });

async function addTask({ title, date, time = '', minutes = '', phase = '', subject = '', prio = '', note = '', type = 'task' }) {
  await addItems([{
    type, area: phase, subject, title, date: date || '', time, minutes: time ? toNumber(minutes) || 15 : '',
    status: 'open', priority: prio, notes: note, calendar: type === 'reading' ? 'off' : 'auto',
  }], { message: `Added for ${date ? relDay(date) : 'no date'}${time ? ' at ' + time : ''}` });
}

// ---------- Sheets (dialogs) ----------

// Sheets slide up from the bottom on an iOS sheet curve and slide back down
// when dismissed. They can be pulled down to dismiss; a short pull springs
// back. Whatever the sheet changes is applied as it leaves, so the update is
// seen on the page underneath.
let sheetClosing = false;
const sheetAfter = [];

function closeSheet(after) {
  const dlg = $('#dialog');
  if (after) sheetAfter.push(after);
  if (!dlg.open) { sheetAfter.splice(0).forEach((f) => f()); return; }
  if (sheetClosing) return;
  sheetClosing = true;
  let timer = 0;
  const finish = () => {
    clearTimeout(timer);
    dlg.removeEventListener('animationend', onEnd);
    dlg.classList.remove('is-closing', 'is-dragging', 'is-settling');
    dlg.style.transform = '';
    dlg.style.removeProperty('--drag-y');
    dlg.close();
    sheetClosing = false;
    sheetAfter.splice(0).forEach((f) => f());
  };
  const onEnd = (ev) => { if (ev.target === dlg) finish(); };
  if (reducedMotion()) return finish();
  dlg.addEventListener('animationend', onEnd);
  timer = setTimeout(finish, 480);
  dlg.classList.add('is-closing');
}

function openSheet(html, onSubmit, { onOpen } = {}) {
  const dlg = $('#dialog');
  // The hidden first button makes Enter in a field mean Save, not Close.
  dlg.innerHTML = `<form method="dialog" class="dlg"><button class="sr-only" value="save" tabindex="-1" aria-hidden="true"></button><div class="grab" aria-hidden="true"></div>${html}</form>`;
  const form = dlg.querySelector('form');
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const btn = ev.submitter;
    if (btn?.value === 'cancel') return closeSheet();
    const data = Object.fromEntries(new FormData(form));
    const which = btn?.value || btn?.dataset.value;
    closeSheet(() => onSubmit(data, which));
  });
  dlg.classList.remove('is-closing', 'is-dragging', 'is-settling');
  dlg.style.transform = '';
  dlg.showModal();
  dlg.scrollTop = 0;
  if (onOpen) onOpen(form);
}

function bindSheetDrag(dlg) {
  let y0 = 0, x0 = 0, t0 = 0, dy = 0, v = 0, lastY = 0, lastT = 0, allowed = false, dragging = false;
  dlg.addEventListener('touchstart', (ev) => {
    if (ev.touches.length !== 1 || sheetClosing) { allowed = false; return; }
    const t = ev.touches[0];
    y0 = lastY = t.clientY; x0 = t.clientX; t0 = lastT = performance.now(); dy = 0; v = 0; dragging = false;
    allowed = dlg.scrollTop <= 0 && !ev.target.closest('input, textarea, select');
  }, { passive: true });
  dlg.addEventListener('touchmove', (ev) => {
    if (!allowed) return;
    const t = ev.touches[0], now = performance.now();
    const d = t.clientY - y0;
    if (!dragging) {
      if (Math.abs(t.clientX - x0) > Math.abs(d) || d < 6) { if (d < -4) allowed = false; return; }
      dragging = true;
      dlg.classList.add('is-dragging');
    }
    ev.preventDefault();
    if (now > lastT) v = 0.75 * ((t.clientY - lastY) / (now - lastT)) + 0.25 * v;
    lastY = t.clientY; lastT = now;
    dy = Math.max(0, d);
    dlg.style.transform = `translateY(${dy}px)`;
  }, { passive: false });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    dlg.classList.remove('is-dragging');
    if (dy > Math.min(140, dlg.offsetHeight * 0.3) || v > 0.55) {
      dlg.style.setProperty('--drag-y', dy + 'px');
      dlg.style.transform = '';
      closeSheet();
    } else {
      dlg.classList.add('is-settling');
      dlg.style.transform = '';
      setTimeout(() => dlg.classList.remove('is-settling'), 520);
    }
  };
  dlg.addEventListener('touchend', end, { passive: true });
  dlg.addEventListener('touchcancel', end, { passive: true });
}

const sheetHead = (title, sub) => `
  <div class="dlg-head">
    <div><h2>${esc(title)}</h2>${sub ? `<p class="dlg-sub">${esc(sub)}</p>` : ''}</div>
    <button class="icon-btn" value="cancel" formnovalidate aria-label="Close">${ICON.close}</button>
  </div>`;

const sheetActions = (primary = 'Save', extra = '') => `
  <div class="dlg-actions">${extra}<span class="spacer"></span>
    <button class="btn btn-primary" value="save">${primary}</button>
  </div>`;

function dateChoices(name, current, { none = false } = {}) {
  const tk = todayKey();
  const nextMon = addDays(tk, ((8 - dateOfKey(tk).getDay()) % 7) || 7);
  const opts = [['Today', tk], ['Tomorrow', addDays(tk, 1)], ['Next Monday', nextMon], ...(none ? [['No date', '']] : [])];
  return `
    <div class="choice-row">
      ${opts.map(([l, k]) => `<button type="button" class="choice ${(current || '') === k ? 'is-on' : ''}" data-set="${name}" data-value="${k}">${l}</button>`).join('')}
      <input type="date" name="${name}" value="${current || ''}" aria-label="Date">
    </div>`;
}

function wireChoices(form) {
  form.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-set]');
    if (!b) return;
    const input = form.querySelector(`[name="${b.dataset.set}"]`);
    input.value = b.dataset.value;
    form.querySelectorAll(`[data-set="${b.dataset.set}"]`).forEach((x) => x.classList.toggle('is-on', x === b));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  form.addEventListener('input', (ev) => {
    const name = ev.target.name;
    if (!name) return;
    form.querySelectorAll(`[data-set="${name}"]`).forEach((x) => x.classList.toggle('is-on', x.dataset.value === ev.target.value));
  });
}

function hourGrid(kind, cur, quick) {
  return `<div class="hour-grid">${quick.map((h) => `<button class="hour ${h === cur ? 'is-on' : ''}" value="q" data-kind="${kind}" data-value="${h}">${h === 0 ? 'None' : fmtH(h)}</button>`).join('')}</div>`;
}

// One sheet for a subject on a day. From today backwards it opens on what was
// actually studied, with the plan one tap away; future days show the plan only.
function editHours(item, k, { pane } = {}) {
  const canLog = k <= todayKey();
  const v = toNumber(item.cells[k]);
  const lv = loggedOn(item.subject, k);
  const show = canLog ? pane || 'log' : 'plan';
  const qPlan = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4];
  const qLog = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4];
  const other = (kind, cur, quick) => `<label class="field field-inline"><span>Other amount</span><input name="${kind}" type="number" inputmode="decimal" min="0" max="16" step="${kind === 'log' ? 0.25 : 0.5}" value="${quick.includes(cur) ? '' : cur}" placeholder="${kind === 'log' ? 'e.g. 1.75' : 'e.g. 5'}"></label>`;
  const exam = state.plan.exams.some((e) => e.subject === item.subject && e.start === k);
  openSheet(`
    ${sheetHead(item.subject, longLabel(k) + (exam ? ', exam day' : ''))}
    ${canLog ? `
      <div class="segmented seg-sheet" role="tablist">
        <button type="button" role="tab" data-pane-btn="log" aria-selected="${show === 'log'}">Studied <span>${fmtH(lv)} h</span></button>
        <button type="button" role="tab" data-pane-btn="plan" aria-selected="${show === 'plan'}">Planned <span>${fmtH(v)} h</span></button>
      </div>
      <div class="pane" data-pane="log" ${show === 'log' ? '' : 'hidden'}>
        <p class="dlg-label">How long did you actually study?</p>
        ${v && v !== lv ? `<button class="btn btn-wide" value="q" data-kind="log" data-value="${v}">${ICON.check}As planned, ${fmtH(v)} h</button>` : ''}
        ${hourGrid('log', lv, qLog)}
        ${other('log', lv, qLog)}
      </div>` : '<p class="dlg-label">Planned study hours</p>'}
    <div class="pane" data-pane="plan" ${show === 'plan' ? '' : 'hidden'}>
      ${canLog ? '<p class="dlg-label">Planned for this day</p>' : ''}
      ${hourGrid('plan', v, qPlan)}
      ${other('plan', v, qPlan)}
    </div>
    ${sheetActions('Save')}`,
  (d, which) => {
    if (which === 'q') return;
    if (d.log !== undefined && d.log !== '') setLogged(item.subject, k, toNumber(d.log));
    if (d.plan !== undefined && d.plan !== '') setHours(item, k, toNumber(d.plan));
  }, {
    onOpen(form) {
      form.querySelectorAll('[data-pane-btn]').forEach((b) => b.addEventListener('click', () => {
        form.querySelectorAll('[data-pane-btn]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
        form.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.paneBtn; });
      }));
      form.querySelectorAll('.pane [data-value]').forEach((b) => b.addEventListener('click', (ev) => {
        ev.preventDefault();
        const n = Number(b.dataset.value);
        closeSheet(() => { if (b.dataset.kind === 'log') setLogged(item.subject, k, n); else setHours(item, k, n); });
      }));
    },
  });
}

// Logging from the day view or an exam card, for any subject.
function logHours(subject, k) {
  const item = state.plan.study.find((s) => s.subject === subject);
  if (item) return editHours(item, k, { pane: 'log' });
  setLogged(subject, k, 1);
}

// A note for a day: one Items row of type "note". Saving empty text deletes it.
function editNote(item, k) {
  const value = item?.title || '';
  openSheet(`
    ${sheetHead(item ? 'Note' : 'New note', longLabel(k))}
    <label class="field"><textarea name="text" rows="3" aria-label="Note">${esc(value)}</textarea></label>
    ${sheetActions('Save', item ? '<button class="btn btn-quiet btn-danger" value="clear" formnovalidate>Delete</button>' : '')}`,
  (d, which) => {
    const v = which === 'clear' ? '' : (d.text || '').trim();
    if (v === value) return;
    if (!item) return v && addItems([{ type: 'note', area: 'Note', title: v, date: k, calendar: 'off' }], { message: 'Note added' });
    if (!v) return removeItem(item, { message: 'Note deleted' });
    item.title = v; item.task = v; item.status.title = v;
    render();
    setFields(item, { title: v }, { delay: 0 });
  }, { onOpen: (f) => f.querySelector('textarea').focus() });
}

function editCell(item, k) {
  const v = item.cells[k] || '';
  const ex = item.type === 'exercise';
  const opts = ex ? (/weigh/i.test(item.subject) ? ['W'] : ['A', 'B', 'L']) : [...new Set(Object.values(item.cells).concat(['!']))].filter((x) => x && x !== v).slice(0, 4);
  openSheet(`
    ${sheetHead(item.subject || item.title, longLabel(k))}
    <p class="dlg-label">${ex ? 'Session' : 'Mark this day'}</p>
    <div class="choice-row">
      <button type="button" class="choice ${!v ? 'is-on' : ''}" data-set="v" data-value="">${ex ? 'Rest' : 'Nothing'}</button>
      ${opts.map((x) => `<button type="button" class="choice ${x === v ? 'is-on' : ''}" data-set="v" data-value="${esc(x)}">${ex ? esc(exLabel(x)) : x === '!' ? '! Deadline' : esc(x)}</button>`).join('')}
    </div>
    <label class="field field-inline"><span>Or type</span><input name="v" value="${esc(v)}" maxlength="40"></label>
    ${sheetActions()}`,
  (d) => {
    const nv = d.v.trim();
    if (nv === v) return;
    if (nv) item.cells[k] = nv; else delete item.cells[k];
    render();
    setFields(item, { days: item.cells }, { delay: 0 });
  }, { onOpen: wireChoices });
}

function taskForm(t, date) {
  const pool = state.plan.items.filter((x) => x.type === (t?.type || 'task'));
  const phases = [...new Set(pool.map((x) => x.phase).filter(Boolean))];
  const subjects = [...new Set(pool.map((x) => x.subject).filter(Boolean))];
  const st = t?.status || { title: '', prio: '', note: '' };
  const days = t ? currentDays(t) : [];
  const isRead = t?.type === 'reading';
  return `
    <label class="field"><span>${isRead ? 'Reading' : t?.type === 'event' ? 'Event' : 'Task'}</span><input name="title" value="${esc(st.title)}" required autocomplete="off"></label>
    <p class="dlg-label">When</p>
    ${days.length > 1 ? `<p class="dlg-sub">Planned on ${days.map((d) => esc(shortLabel(d))).join(', ')}. Picking a day moves it to that day only.</p>` : ''}
    ${dateChoices('date', date, { none: Boolean(t) })}
    <div class="field-row">
      <label class="field"><span>Time (optional)</span><input name="time" type="time" value="${esc(t?.time || '')}"></label>
      <label class="field"><span>${isRead ? 'Hours' : 'Minutes'}</span><input name="${isRead ? 'hours' : 'minutes'}" type="number" inputmode="decimal" min="0" step="${isRead ? 0.5 : 5}" value="${esc(isRead ? (t?.hours || '') : (t?.minutes || ''))}" placeholder="${isRead ? '1' : '15'}"></label>
    </div>
    <p class="dlg-hint">${t?.calendar === 'off' ? 'Not synced to the calendar.' : 'With a time, it also goes in your Personal Gantt calendar.'}</p>
    <p class="dlg-label">Priority</p>
    <div class="choice-row">
      ${['', 'P1', 'P2', 'P3'].map((p) => `<button type="button" class="choice ${st.prio === p ? 'is-on' : ''}" data-set="prio" data-value="${p}">${p || 'None'}</button>`).join('')}
      <input type="hidden" name="prio" value="${esc(st.prio)}">
    </div>
    <label class="field"><span>Note</span><input name="note" value="${esc(st.note)}" autocomplete="off" placeholder="Optional"></label>
    <details class="more">
      <summary>Area and topic</summary>
      <div class="field-row">
        <label class="field"><span>Area</span><input name="phase" list="dl-phase" value="${esc(t ? t.phase : '')}" autocomplete="off"></label>
        <label class="field"><span>Topic</span><input name="subject" list="dl-subject" value="${esc(t?.subject || '')}" autocomplete="off"></label>
      </div>
      <datalist id="dl-phase">${phases.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <datalist id="dl-subject">${subjects.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
    </details>`;
}

const KIND = { task: 'task', reading: 'reading', event: 'event', exam: 'exam', exercise: 'exercise block', note: 'note' };

function editTask(item) {
  const st = item.status;
  const done = st.status === 'done';
  const due = taskDue(item) || '';
  const kind = KIND[item.type] || 'item';
  const checkable = ['task', 'reading'].includes(item.type) || !KIND[item.type];
  openSheet(`
    ${sheetHead('Edit ' + kind, [item.phase, item.subject].filter(Boolean).join(', '))}
    ${checkable ? `
    <button type="button" class="done-toggle ${done ? 'is-done' : ''}" data-toggle-done aria-pressed="${done}">
      <span class="check" aria-hidden="true">${ICON.check}</span>
      <span><b>${done ? 'Done' : 'Not done yet'}</b><small>${done ? (st.doneOn ? `Finished ${esc(st.doneOn)}. Tap to reopen.` : 'Tap to reopen.') : 'Tap to mark as done.'}</small></span>
    </button>` : ''}
    ${taskForm(item, due)}
    ${sheetActions('Save', `<button class="btn btn-quiet btn-danger" value="delete" formnovalidate data-confirm>Delete</button>`)}`,
  (d, which) => {
    if (which === 'delete') return deleteTask(item);
    const f = {};
    const title = (d.title || '').trim();
    const note = (d.note ?? st.note).trim();
    if (title && title !== item.title) { f.title = title; item.title = title; item.task = title; }
    if (d.prio !== undefined && d.prio !== item.status.prio) { f.priority = d.prio; }
    if (note !== item.notes) { f.notes = note; item.notes = note; }
    if (d.time !== undefined && (d.time || '') !== item.time) { f.time = d.time || ''; item.time = d.time || ''; }
    if (d.minutes !== undefined && toNumber(d.minutes) !== item.minutes) { f.minutes = d.minutes ? toNumber(d.minutes) : ''; item.minutes = toNumber(d.minutes); }
    if (d.hours !== undefined && toNumber(d.hours) !== item.hours) { f.hours = d.hours ? toNumber(d.hours) : ''; item.hours = toNumber(d.hours); }
    if (d.phase !== undefined && d.phase.trim() !== item.phase) { f.area = d.phase.trim(); item.phase = item.area = f.area; }
    if (d.subject !== undefined && d.subject.trim() !== item.subject) { f.subject = d.subject.trim(); item.subject = f.subject; }
    item.status = { ...item.status, title: item.title, prio: d.prio ?? item.status.prio, note: item.notes };
    if (Object.keys(f).length) { render(); setFields(item, f, { delay: 0 }); }
    if ((d.date || '') !== due) moveTask(item, d.date || '');
  }, {
    onOpen(form) {
      wireChoices(form);
      // Done toggles straight away; the rest waits for Save.
      form.querySelector('[data-toggle-done]')?.addEventListener('click', () => closeSheet(() => toggleTask(item)));
      const del = form.querySelector('[data-confirm]');
      del.addEventListener('click', (ev) => {
        if (del.dataset.armed) return;
        ev.preventDefault();
        del.dataset.armed = '1';
        del.textContent = 'Tap again to delete';
      });
    },
  });
}

function moveTaskSheet(item) {
  openSheet(`
    ${sheetHead('Move task', item.status.title)}
    ${dateChoices('date', taskDue(item), { none: true })}
    ${sheetActions('Move')}`,
  (d) => { if ((d.date || '') !== (taskDue(item) || '')) moveTask(item, d.date || ''); },
  {
    onOpen(form) {
      wireChoices(form);
      form.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => {
        closeSheet(() => { if (b.dataset.value !== (taskDue(item) || '')) moveTask(item, b.dataset.value); });
      }));
    },
  });
}

// Tapping a task's cell on the chart: clear choices for that day.
function taskDaySheet(item, k) {
  const days = currentDays(item);
  const on = days.includes(k);
  const done = item.status.status === 'done';
  const elsewhere = days.filter((d) => d !== k);
  const btn = (value, label, cls = '') => `<button class="act ${cls}" value="${value}">${label}</button>`;
  openSheet(`
    ${sheetHead(item.status.title, on ? `Planned for ${longLabel(k)}` : longLabel(k) + (days.length ? `. Now planned for ${days.map((d) => shortLabel(d)).join(', ')}` : '. No date yet'))}
    <div class="act-list">
      ${on ? `
        ${btn('done', done ? `${ICON.check}Mark as not done` : `${ICON.check}Mark as done`, done ? '' : 'is-primary')}
        ${btn('remove', `${ICON.close}Remove from ${esc(relDay(k))}`)}
      ` : `
        ${btn('move', `${ICON.right}${days.length ? 'Move' : 'Plan'} it to ${esc(relDay(k))}`, 'is-primary')}
        ${elsewhere.length ? btn('add', `${ICON.plus}Also plan it for ${esc(relDay(k))}`) : ''}
      `}
      ${btn('edit', `${ICON.pen}Edit task`)}
    </div>`,
  (d, which) => {
    if (which === 'done') return toggleTask(item);
    if (which === 'remove') return removeTaskDay(item, k);
    if (which === 'move') return moveTask(item, k);
    if (which === 'add') return addTaskDay(item, k);
    if (which === 'edit') return editTask(item);
  });
}

function addTaskSheet(k) {
  openSheet(`
    ${sheetHead('New task')}
    ${taskForm(null, k)}
    ${sheetActions('Add task')}`,
  (d) => addTask({ title: d.title.trim(), date: d.date, time: d.time || '', minutes: d.minutes, prio: d.prio, note: (d.note || '').trim(), phase: (d.phase || '').trim(), subject: (d.subject || '').trim() }),
  { onOpen(form) { wireChoices(form); form.querySelector('[name=title]').focus(); } });
}

function accountMenu() {
  const c = state.cal;
  const others = c.calendars.filter((x) => x.id !== c.calId);
  const status = c.status === 'ok'
    ? `Synced to the <b>${esc(CONFIG.calendarName)}</b> calendar${c.lastSync ? ` at ${new Date(c.lastSync).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}.`
    : c.status === 'off' ? `Calendar sync is off: ${esc(c.message)}${/not enabled/.test(c.message) ? ' Enable the Google Calendar API in the Google Cloud project that holds this app, then reload.' : /not granted/.test(c.message) ? ' Sign out and sign in again, and allow calendar access.' : ''}`
    : c.status === 'error' ? `Calendar sync failed: ${esc(c.message)}` : 'Connecting to Google Calendar.';
  openSheet(`
    ${sheetHead('Account')}
    <p class="dlg-sub">Signed in to Google for this session. The app reads and writes the Items table of your sheet directly and stores none of its data.</p>
    <p class="dlg-label">Google Calendar</p>
    <p class="dlg-sub">${status}</p>
    ${others.length ? `
      <p class="dlg-label">Show on the Day view and Timeline</p>
      <div class="cal-list">${others.map((x) => `
        <label class="cal-opt" style="--c:${esc(x.color || 'var(--ink-3)')}"><input type="checkbox" name="cal" value="${esc(x.id)}" ${isShown(x) ? 'checked' : ''}><span class="cal-dot"></span>${esc(x.name)}</label>`).join('')}
      </div>` : ''}
    <p><a href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(CONFIG.spreadsheetId)}/edit" target="_blank" rel="noopener">Open the sheet in Google Sheets</a></p>
    <div class="dlg-actions">
      <button class="btn btn-quiet" value="signout" formnovalidate>Sign out</button><span class="spacer"></span>
      <button class="btn btn-quiet" value="sync" formnovalidate>Sync now</button>
      <button class="btn btn-primary" value="save">Done</button>
    </div>`,
  (d, which) => {
    if (which === 'signout') return signOut();
    if (which === 'sync') { state.cal.status = state.cal.status === 'off' ? 'idle' : state.cal.status; syncCalendar({ force: true }).then(() => loadCalendarEvents({ force: true })); return; }
  }, {
    onOpen(form) {
      form.addEventListener('change', (ev) => {
        if (ev.target.name !== 'cal') return;
        const ids = [...form.querySelectorAll('input[name=cal]:checked')].map((x) => x.value);
        store.set('pg.calShown', JSON.stringify(ids));
        loadCalendarEvents({ force: true });
      });
    },
  });
}

// ---------- Toast ----------

let toastTimer;
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button class="link" data-action="undo">Undo</button>' : ''}`;
  t.classList.add('is-on');
  t._undo = undo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('is-on'); t._undo = null; }, undo ? 5000 : 3000);
}

// ---------- Events ----------

const goDay = (k) => selectDay(k);

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  const item = el.dataset.id ? findItem(el.dataset.id) : null;
  switch (a) {
    case 'sign-in': return signIn(store.get('pg.signedIn') === '1');
    case 'refresh': return flush().then(() => { checkForUpdate(); return refresh(); });
    case 'menu': return accountMenu();
    case 'view':
      if (Date.now() - tabTouchAt < 700) return; // handled by the touch on the tab bar
      return goToPage(el.dataset.view, true);
    case 'pick-day': return goDay(el.dataset.day);
    case 'open-day': selectDay(el.dataset.day, { smooth: false }); return goToPage('today', true);
    case 'grid-cell': {
      const days = state.plan.days;
      const r = el.getBoundingClientRect();
      const i = Math.max(0, Math.min(days.length - 1, Math.floor(((ev.clientX - r.left) / r.width) * days.length)));
      const k = days[i].key;
      const c = el.dataset.cell;
      if (c === 'edit-hours') return item && editHours(item, k);
      if (c === 'task-day') return item && taskDaySheet(item, k);
      if (c === 'edit-cell') return item && editCell(item, k);
      selectDay(k, { smooth: false });
      return goToPage('today', true);
    }
    case 'go-today': return goDay(clampDay(todayKey()));
    case 'hours': return item && setHours(item, el.dataset.day, toNumber(item.cells[el.dataset.day]) + Number(el.dataset.delta));
    case 'edit-hours': return item && editHours(item, el.dataset.day);
    case 'toggle-task': return item && toggleTask(item);
    case 'edit-task': return item && editTask(item);
    case 'move-task': return item && moveTaskSheet(item);
    case 'task-day': return item && taskDaySheet(item, el.dataset.day);
    case 'log-hours': return logHours(el.dataset.subject, el.dataset.day);
    case 'edit-cell': return item && editCell(item, el.dataset.day);
    case 'edit-note': return editNote(item, el.dataset.day);
    case 'add-task': return addTaskSheet(el.dataset.day);
    case 'task-filter': state.taskFilter = el.dataset.filter; return render();
    case 'toggle-done': state.showDone = !state.showDone; return render();
    case 'tl-today': return scrollTimelineToToday(true);
    case 'toggle-exam': {
      const sub = el.dataset.subject;
      state.examOpen ||= new Set();
      if (state.examOpen.has(sub)) state.examOpen.delete(sub); else state.examOpen.add(sub);
      return render();
    }
    case 'toggle-done-tl': state.tlShowDone = !state.tlShowDone; return render();
    case 'toggle-section': {
      const id = el.dataset.key;
      const opening = state.collapsed.has(id);
      if (opening) state.collapsed.delete(id); else state.collapsed.add(id);
      store.set('pg.tlCollapsed', JSON.stringify([...state.collapsed]));
      state.justOpened = opening ? id : null;
      render();
      state.justOpened = null;
      return;
    }
    case 'undo': {
      const t = $('#toast');
      t.classList.remove('is-on');
      const fn = t._undo;
      t._undo = null;
      if (fn) fn();
      return;
    }
  }
});

document.addEventListener('change', (ev) => {
  if (ev.target.matches('[data-input="pick-day"]') && ev.target.value) goDay(clampDay(ev.target.value));
});

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-form="quick-add"]');
  if (!form) return;
  ev.preventDefault();
  const d = Object.fromEntries(new FormData(form));
  const title = (d.task || '').trim();
  if (!title) return;
  const date = d.when === 'pick' ? d.date : d.when;
  const phase = '';
  addTask({ title, date, phase });
  form.reset();
});

// Dismiss a sheet by tapping outside it; catch up on any render held while it was open.
const dialog = $('#dialog');
dialog.addEventListener('click', (ev) => { if (ev.target === dialog) closeSheet(); });
dialog.addEventListener('cancel', (ev) => { ev.preventDefault(); closeSheet(); });
bindSheetDrag(dialog);
// Lets :active press states show on iOS.
document.addEventListener('touchstart', () => {}, { passive: true });
dialog.addEventListener('close', () => { if (state.dirty) { state.dirty = false; render(); } });

document.addEventListener('keydown', (ev) => {
  if (!state.plan || dialog.open) return;
  if (ev.target.closest('input, textarea')) return;
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  if (state.view !== 'today') return;
  const days = state.plan.days;
  const i = days.findIndex((d) => d.key === state.day) + (ev.key === 'ArrowLeft' ? -1 : 1);
  if (days[i]) goDay(days[i].key);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { flush(); return; }
  checkForUpdate();
  if (!state.plan) return;
  if (!api.hasToken()) return renderSignIn('Your session ended. Sign in again to continue.');
  if (Date.now() - state.loadedAt > 120000 && !writes.size && !inflight) refresh();
});

window.addEventListener('beforeunload', (ev) => {
  if (writes.size || inflight) { flush(); ev.preventDefault(); }
});

// ---------- Icons ----------

const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  left: svg('<path d="M15 5l-7 7 7 7"/>'),
  right: svg('<path d="M9 6l6 6-6 6"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>'),
  user: svg('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.6 4-5 7-5s5.8 1.4 7 5"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  pen: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  calendar: svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>'),
  target: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/>'),
  day: svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/><circle cx="12" cy="15" r="1.6" fill="currentColor" stroke="none"/>'),
  grid: svg('<path d="M4 6h9M4 12h14M4 18h7"/><path d="M15 6h5M20 18h-6" opacity=".45"/>'),
  flag: svg('<path d="M6 21V4"/><path d="M6 4h11l-2 4 2 4H6"/>'),
  list: svg('<path d="M9 7h11M9 12h11M9 17h11"/><path d="M4 7l1 1 2-2M4 12l1 1 2-2M4 17l1 1 2-2"/>'),
};

const VIEW_RENDER = { today: renderToday, timeline: renderTimeline, exams: renderExams, tasks: renderTasks };

boot();
