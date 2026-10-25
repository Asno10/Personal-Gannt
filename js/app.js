import { CONFIG } from '../config.js';
import * as api from './sheets.js?v=11';
import { parseGantt, parseDailyPlan, colLetter, keyOfDate, dateOfKey, splitTask, composeTask, toNumber } from './parse.js?v=11';

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
  daily: null,
  view: store.get('pg.view') || 'today',
  day: todayKey(),
  taskFilter: 'open',
  loadedAt: 0,
  sync: 'idle', // idle | saving | saved | error
  collapsed: new Set(JSON.parse(store.get('pg.tlCollapsed') || '["commitments"]')),
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
const BUILD = '11';

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
      <p>Your study plan, tasks and deadlines, read live from Google Sheets. Sign in with the Google account that owns the sheet.</p>
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
    if (writes.size || inflight) return; // newer local edits are waiting; their own refresh follows
    const json = JSON.stringify([raw.gantt, raw.daily]);
    const changed = json !== lastRawJson;
    lastRawJson = json;
    state.raw = raw;
    state.loadedAt = Date.now();
    if (changed || first) {
      state.plan = parseGantt(raw.gantt, raw.ganttFormulas);
      state.daily = parseDailyPlan(raw.daily, raw.dailyFormulas);
    }
    if (first) {
      state.day = clampDay(todayKey());
      render();
    } else if (changed) {
      render();
    } else {
      renderStatus();
    }
  } catch (e) {
    if (e instanceof api.AuthError) return renderSignIn('Your session ended. Sign in again to continue.');
    if (first || !state.plan) return renderSignIn(e.message);
    toast(e.message);
  }
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

const writes = new Map();
let flushTimer = null;
let inflight = null;
let savedTimer = null;

function queue(updates, { delay = 600 } = {}) {
  for (const u of updates) writes.set(u.range, u.value);
  setSync('saving');
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, delay);
}

async function flush() {
  clearTimeout(flushTimer);
  if (inflight) await inflight.catch(() => {});
  if (!writes.size) return;
  const batch = [...writes].map(([range, value]) => ({ range, value }));
  writes.clear();
  inflight = api.writeCells(batch);
  try {
    await inflight;
    inflight = null;
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

function setSync(s) {
  state.sync = s;
  clearTimeout(savedTimer);
  if (s === 'saved') savedTimer = setTimeout(() => setSync('idle'), 2500);
  renderStatus();
}

const gantt = (cell) => api.a1(CONFIG.sheets.gantt, cell);
const dailyCell = (cell) => api.a1(CONFIG.sheets.dailyPlan, cell);
const cellRef = (item, dayKey) => gantt(colLetter(state.plan.dayByKey[dayKey].col) + item.row);
const colRef = (name, row) => gantt(colLetter(state.plan.header[name]) + row);

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

function render() {
  if (!state.plan) return;
  if ($('#dialog')?.open) { state.dirty = true; return; }
  if (!VIEWS.some(([v]) => v === state.view)) state.view = 'today';
  const fresh = ensureShell();
  const bar = $('.bar');
  document.documentElement.style.setProperty('--bar-h', bar.offsetHeight + 'px');

  const tlLeft = $('#tl-scroll')?.scrollLeft;
  renderDayPage();
  $('#view-timeline').innerHTML = renderTimeline();
  $('#view-exams').innerHTML = renderExams();
  $('#view-tasks').innerHTML = renderTasks();
  renderStatus();
  updateTabs();

  const sc = $('#tl-scroll');
  if (sc) {
    bindTimelineScroll(sc);
    if (tlLeft != null) sc.scrollLeft = tlLeft;
    else scrollTimelineToToday(false);
    syncTimelineHead();
  }
  if (fresh) {
    goToPage(state.view, false);
    centerStrip(true);
  }
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

const allTasks = () => state.plan.sections.filter((s) => s.type === 'tasks').flatMap((s) => s.items);
const ofType = (type) => state.plan.sections.filter((s) => s.type === type).flatMap((s) => s.items);
const findItem = (row) => state.plan.sections.flatMap((s) => s.items).find((i) => i.row === +row);

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
  const daily = state.daily.byKey[k];
  const tasks = tasksOn(k);
  const open = tasks.filter((t) => t.status.status === 'open');
  const done = tasks.filter((t) => t.status.status === 'done');
  const overdue = isToday ? allTasks().filter((t) => isOverdue(t) && !tasks.includes(t)) : [];
  const events = ofType('events').filter((e) => coversDay(e, k));
  const exercise = ofType('exercise').filter((e) => !/weigh/i.test(e.subject) && coversDay(e, k));
  const others = state.plan.study.filter((s) => !study.some((x) => x.item === s));
  const dt = dateOfKey(k);

  return `
    <h1 class="day-title">${esc(longLabel(k))}</h1>

    ${renderCountdown(k)}

    <section class="block">
      <div class="block-head">
        <h2>Study</h2>
        <span class="block-meta">${total ? fmtH(total) + ' h planned' : 'Nothing planned'}${canLog && (total || logged) ? `, <b class="${logged >= total && logged ? 'is-good' : ''}">${fmtH(logged)} h studied</b>` : ''}</span>
      </div>
      <ul class="study-list">${study.map(({ item, hours }) => studyRow(item, hours, k)).join('')}</ul>
      ${daily?.studyNote.value && !/^none/i.test(daily.studyNote.value) ? `<p class="note">${esc(daily.studyNote.value)}</p>` : ''}
      ${others.length ? `
        <div class="add-row">
          <span class="add-label">${canLog ? 'Log time for another subject' : 'Add a subject'}</span>
          <div class="chips">${others.map((s) => canLog
            ? `<button class="chip" style="--c:${subjectVar(s.subject)}" data-action="log-hours" data-subject="${esc(s.subject)}" data-day="${k}" aria-label="Log time for ${esc(s.subject)}">${esc(s.subject)}</button>`
            : `<button class="chip" style="--c:${subjectVar(s.subject)}" data-action="hours" data-row="${s.row}" data-day="${k}" data-delta="1" aria-label="Add 1 hour of ${esc(s.subject)}">${esc(s.subject)}</button>`).join('')}</div>
        </div>` : ''}
    </section>

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

    ${daily || events.length ? `
    <section class="block">
      <div class="block-head"><h2>Commitments</h2></div>
      ${daily ? editableLine(daily.commitments, daily.row, 'Fixed commitments', k, 'No fixed commitments. Tap to add.') : ''}
      ${events.map((e) => `<div class="event ${/deadline/i.test(e.subject) || e.cells[k] === '!' ? 'is-alert' : ''}"><span class="event-kind">${esc(e.subject || e.phase)}</span><span>${esc(e.task)}</span></div>`).join('')}
    </section>` : ''}

    ${daily || exercise.length ? `
    <section class="block">
      <div class="block-head"><h2>Exercise</h2></div>
      ${daily ? editableLine(daily.exercise, daily.row, 'Exercise', k, 'Rest day. Tap to add a session.') : ''}
      ${exercise.map((e) => `<p class="note"><strong>${esc(e.subject)}.</strong> ${esc(e.task)}</p>`).join('')}
    </section>` : ''}
  `;
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
        <button class="study-name" data-action="edit-hours" data-row="${item.row}" data-day="${k}">${esc(item.subject)}</button>
        ${k <= todayKey() ? (() => {
          const l = loggedOn(item.subject, k);
          return `<button class="log-btn ${l ? 'is-logged' : ''} ${l && l >= hours ? 'is-good' : ''}" data-action="log-hours" data-subject="${esc(item.subject)}" data-day="${k}">${l ? `${ICON.check}Studied ${fmtH(l)} h` : `${ICON.plus}Log studied time`}</button>`;
        })() : ''}
      </div>
      <span class="stepper">
        <button class="step" data-action="hours" data-row="${item.row}" data-day="${k}" data-delta="-0.5" aria-label="Half an hour less ${esc(item.subject)}">${ICON.minus}</button>
        <button class="study-hours" data-action="edit-hours" data-row="${item.row}" data-day="${k}" aria-label="${fmtH(hours)} hours planned, tap to change">${fmtH(hours)}<small>h</small></button>
        <button class="step" data-action="hours" data-row="${item.row}" data-day="${k}" data-delta="0.5" aria-label="Half an hour more ${esc(item.subject)}">${ICON.plus}</button>
      </span>
    </li>`;
}

function taskRow(t, { hideDate = false } = {}) {
  const st = t.status;
  const done = st.status === 'done';
  const due = taskDue(t);
  const overdue = isOverdue(t);
  const lateBy = overdue ? daysBetween(due, todayKey()) : 0;
  const where = [t.phase, t.subject].filter(Boolean).join(', ');
  return `
    <li class="task ${done ? 'is-done' : ''} ${state.justToggled === t.row ? 'is-popping' : ''}">
      <button class="check" data-action="toggle-task" data-row="${t.row}" role="checkbox" aria-checked="${done}" aria-label="${done ? 'Mark as not done' : 'Mark as done'}: ${esc(st.title)}">${ICON.check}</button>
      <button class="task-body" data-action="edit-task" data-row="${t.row}">
        <span class="task-title">${st.prio ? `<span class="prio prio-${esc(st.prio.slice(1))}">${esc(st.prio)}</span>` : ''}${esc(st.title)}</span>
        ${st.note ? `<span class="task-note">${esc(st.note)}</span>` : ''}
        <span class="task-meta">${esc(where)}</span>
      </button>
      ${done
        ? `<span class="due is-done">${st.doneOn ? 'Done ' + esc(st.doneOn) : 'Done'}</span>`
        : hideDate && !overdue ? '' : `<button class="due ${overdue ? 'is-late' : ''}" data-action="move-task" data-row="${t.row}" aria-label="Change date">${due ? (overdue ? `${plural(lateBy, 'day')} late` : esc(relDay(due))) : 'No date'}</button>`}
    </li>`;
}

function editableLine(field, row, label, k, empty) {
  if (field.col < 0) return '';
  return `<button class="line ${field.value ? '' : 'is-empty'}" ${field.locked ? 'disabled' : ''} data-action="edit-text" data-range="${esc(dailyCell(colLetter(field.col) + row))}" data-label="${esc(label)}" data-sub="${esc(longLabel(k))}" data-value="${esc(field.value)}">${field.value ? esc(field.value) : esc(empty)}${field.locked ? '' : `<span class="line-edit">${ICON.pen}</span>`}</button>`;
}

// ---------- Timeline ----------
// The full plan as a table: one row per subject, task or event, one column per
// day. The names stay pinned on the left and the dates on top while it scrolls.
// Exams sit on their subject's row, and empty days are left blank.


function exerciseAbbr(text) {
  const t = String(text || '');
  if (!t) return '';
  const parts = [];
  const day = t.match(/day\s*([ab])\b/i);
  if (day) parts.push(day[1].toUpperCase());
  if (/light/i.test(t)) parts.push('Light');
  if (/weigh/i.test(t)) parts.push('W');
  return parts.join(' ') || t.slice(0, 5);
}

function renderTimeline() {
  const days = state.plan.days;
  const tk = todayKey();
  const colCls = (k) => {
    const dt = dateOfKey(k);
    return [k === tk ? 'is-today' : '', dt.getDay() % 6 === 0 ? 'is-weekend' : '', dt.getDay() === 1 ? 'is-monday' : ''].join(' ');
  };
  const maxH = Math.max(1, ...state.plan.study.flatMap((s) => Object.values(s.cells).map(toNumber)));

  const head = `
    <tr class="tl-head">
      <th class="tl-name" scope="col"><button class="tl-today-btn" data-action="tl-today">${ICON.target}Today</button></th>
      ${days.map((d, i) => {
        const dt = dateOfKey(d.key);
        const h = studyHoursOn(d.key);
        const month = i === 0 || dt.getDate() === 1;
        return `<th scope="col" class="tl-day ${colCls(d.key)} ${month ? 'is-month' : ''}">
          <button data-action="open-day" data-day="${d.key}" aria-label="Open ${esc(longLabel(d.key))}">
            <span class="tl-month">${month ? MON[dt.getMonth()] : ''}</span>
            <span class="tl-dow">${esc(dowLabel(d.key).slice(0, 2))}</span>
            <span class="tl-num">${dt.getDate()}</span>
            <span class="tl-sum">${h ? fmtH(h) + 'h' : ''}</span>
          </button></th>`;
      }).join('')}
    </tr>`;

  // Section title rows keep one cell per day, so today and weekend shading runs
  // unbroken down the chart. A closed section shows a summary in those cells.
  const section = (id, name, meta, rows, preview) => {
    if (!rows.length) return '';
    const shut = state.collapsed.has(id);
    return `
      <tr class="tl-section ${shut ? 'is-shut' : ''}">
        <th class="tl-name" scope="rowgroup">
          <button data-action="toggle-section" data-key="${id}" aria-expanded="${!shut}">${ICON[shut ? 'right' : 'down']}<span>${esc(name)}</span><span class="tl-count">${esc(meta)}</span></button>
        </th>
        ${days.map((d) => `<td class="${colCls(d.key)}">${shut && preview ? preview(d.key) : ''}</td>`).join('')}
      </tr>
      ${shut ? '' : (state.justOpened === id ? rows.map((r) => r.replace('<tr class="', '<tr class="is-entering ')) : rows).join('')}`;
  };
  const blankCells = () => days.map((d) => `<td class="${colCls(d.key)}"></td>`).join('');

  const line = ({ cls = '', color = '', name, sub = '', action = '', cells }) => `
    <tr class="tl-row ${cls}" ${color ? `style="--c:${color}"` : ''}>
      <th class="tl-name" scope="row">${action ? `<button ${action}>` : '<div class="tl-name-in">'}<span class="tl-label">${esc(name)}</span>${sub ? `<span class="tl-sub">${esc(sub)}</span>` : ''}${action ? '</button>' : '</div>'}</th>
      ${cells}
    </tr>`;

  // Study: one row per subject, with its exam at the end of the row.
  const study = state.plan.study.map((s) => {
    const exam = state.plan.exams.find((e) => e.subject === s.subject);
    const keys = Object.keys(s.cells).filter((k) => toNumber(s.cells[k]) > 0).sort();
    const runEnd = [exam?.start, keys.at(-1)].filter(Boolean).sort().at(-1);
    const total = keys.reduce((n, k) => n + toNumber(s.cells[k]), 0);
    const cells = days.map((d) => {
      const k = d.key;
      const h = toNumber(s.cells[k]);
      const isExam = exam?.start === k;
      const run = keys[0] && k > keys[0] && k < runEnd;
      const lg = k <= tk ? loggedOn(s.subject, k) : 0;
      const badge = lg ? `<span class="tl-log ${lg >= h ? 'is-good' : ''}">${fmtH(lg)}</span>` : '';
      const inner = isExam
        ? `<span class="tl-exam-pill">Exam${exam.time ? `<small>${esc(exam.time)}</small>` : ''}</span>`
        : h ? `<span class="tl-h" style="--a:${Math.round(18 + 40 * (h / maxH))}%">${fmtH(h)}</span>` : '';
      return `<td class="${colCls(k)} ${run && !h && !isExam ? 'is-run' : ''}"><button class="tl-cell" data-action="edit-hours" data-row="${s.row}" data-day="${k}" aria-label="${esc(s.subject)}, ${esc(longLabel(k))}: ${isExam ? 'exam, ' : ''}${h ? fmtH(h) + ' hours planned' : 'no study planned'}${lg ? `, ${fmtH(lg)} studied` : ''}">${inner}${badge}</button></td>`;
    }).join('');
    return line({ cls: 'tl-study', color: subjectVar(s.subject), name: s.subject, sub: `${fmtH(total)} h${exam ? `, exam ${shortLabel(exam.start)}` : ''}`, cells });
  });
  const lonelyExams = state.plan.exams.filter((e) => !state.plan.study.some((s) => s.subject === e.subject)).map((e) => line({
    cls: 'tl-study', color: subjectVar(e.subject), name: e.subject, sub: `Exam ${shortLabel(e.start)}`,
    cells: days.map((d) => `<td class="${colCls(d.key)}">${e.start === d.key ? '<span class="tl-exam-pill">Exam</span>' : ''}</td>`).join(''),
  }));

  // Tasks: open ones first by date; done ones only when asked for.
  const all = allTasks();
  const open = all.filter((t) => t.status.status === 'open').sort((a, b) => (taskDue(a) || '9').localeCompare(taskDue(b) || '9'));
  const done = all.filter((t) => t.status.status === 'done');
  const taskLine = (t) => {
    const isDone = t.status.status === 'done';
    const pd = plannedDays(t);
    const cells = days.map((d) => {
      const on = pd.length ? pd.includes(d.key) : t.start === d.key;
      const inner = on ? (isDone ? `<span class="tl-done">${ICON.check}</span>` : '<span class="tl-dot"></span>') : '';
      return `<td class="${colCls(d.key)}"><button class="tl-cell" data-action="task-day" data-row="${t.row}" data-day="${d.key}" aria-label="${esc(t.status.title)}, ${esc(longLabel(d.key))}: ${on ? 'planned' : 'not planned'}">${inner}</button></td>`;
    }).join('');
    const late = isOverdue(t);
    return line({
      cls: `tl-tasks ${isDone ? 'is-done' : ''} ${late ? 'is-late' : ''}`,
      name: t.status.title,
      sub: isDone ? 'Done' : late ? `${plural(daysBetween(taskDue(t), tk), 'day')} late` : [t.phase, t.subject].filter(Boolean).join(', '),
      action: `data-action="edit-task" data-row="${t.row}"`, cells,
    });
  };
  const taskRows = open.map(taskLine);
  if (done.length) {
    taskRows.push(`
      <tr class="tl-more"><th class="tl-name" scope="row"><button data-action="toggle-done-tl">${state.tlShowDone ? 'Hide' : 'Show'} done (${done.length})</button></th>${blankCells()}</tr>`);
    if (state.tlShowDone) taskRows.push(...done.map(taskLine));
  }

  // Calendar: holidays, milestones and deadlines as bars.
  const eventRows = ofType('events').map((e) => {
    const alert = /deadline/i.test(e.subject);
    return line({
      cls: `tl-events ${alert ? 'is-alert' : ''}`, name: e.task.replace(/\s*\(.*\)\s*$/, ''), sub: e.subject,
      cells: days.map((d) => `<td class="${colCls(d.key)}">${coversDay(e, d.key) ? `<span class="tl-bar ${alert || e.cells[d.key] === '!' ? 'is-alert' : ''}"></span>` : ''}</td>`).join(''),
    });
  });

  // Exercise: one row from the Daily Plan, tinted by training phase.
  const phases = ofType('exercise').filter((e) => !/weigh/i.test(e.subject));
  const exerciseRows = Object.keys(state.daily.byKey).length || phases.length ? [line({
    cls: 'tl-exercise', name: 'Exercise', sub: phases.map((p) => p.subject.replace(/^Phase \d+\s*/i, '')).join(', ') || 'From the Daily Plan',
    cells: days.map((d) => {
      const dp = state.daily.byKey[d.key];
      const ab = exerciseAbbr(dp?.exercise.value);
      const inPhase = phases.some((p) => p.start <= d.key && d.key <= p.end);
      const inner = ab ? `<span class="tl-ex">${esc(ab)}</span>` : '';
      const cls = `${colCls(d.key)} ${inPhase ? 'is-phase' : ''}`;
      return dp && !dp.exercise.locked && dp.exercise.col >= 0
        ? `<td class="${cls}"><button class="tl-cell" data-action="edit-text" data-range="${esc(dailyCell(colLetter(dp.exercise.col) + dp.row))}" data-label="Exercise" data-sub="${esc(longLabel(d.key))}" data-value="${esc(dp.exercise.value)}" aria-label="Exercise, ${esc(longLabel(d.key))}: ${esc(dp.exercise.value || 'none')}">${inner}</button></td>`
        : `<td class="${cls}">${inner}</td>`;
    }).join(''),
  })] : [];

  // Fixed commitments: classes and marked days.
  const commitRows = ofType('commitments').map((c) => line({
    cls: 'tl-commit', name: c.subject || c.task, sub: c.task,
    cells: days.map((d) => {
      const v = c.cells[d.key] || '';
      const inner = v ? `<span class="tl-mark ${v === '!' ? 'is-alert' : ''}">${/^c$/i.test(v) ? 'Class' : esc(v)}</span>` : '';
      return `<td class="${colCls(d.key)}"><button class="tl-cell" data-action="edit-cell" data-row="${c.row}" data-day="${d.key}" aria-label="${esc(c.subject)}, ${esc(longLabel(d.key))}: ${esc(v || 'nothing')}">${inner}</button></td>`;
    }).join(''),
  }));

  // Both tables share these column widths, so the dates line up with the cells below.
  const cols = `<colgroup><col class="tl-col-name">${days.map(() => '<col class="tl-col-day">').join('')}</colgroup>`;

  const studyTotal = state.plan.study.reduce((n, s) => n + Object.values(s.cells).reduce((m, v) => m + toNumber(v), 0), 0);
  // What a closed section still shows on each day.
  const preview = {
    study(k) {
      const h = studyHoursOn(k);
      const ex = state.plan.exams.some((e) => e.start === k);
      return ex ? '<span class="tl-exam-pill tl-mini">Exam</span>' : h ? `<span class="tl-pv-h">${fmtH(h)}</span>` : '';
    },
    tasks(k) {
      const on = tasksOn(k);
      const o = on.filter((t) => t.status.status === 'open').length;
      if (o) return `<button class="tl-cell" data-action="open-day" data-day="${k}" aria-label="${plural(o, 'open task')} on ${esc(longLabel(k))}"><span class="tl-dot ${o > 1 ? 'is-many' : ''}">${o > 1 ? o : ''}</span></button>`;
      return on.length ? `<span class="tl-done is-faint">${ICON.check}</span>` : '';
    },
    events(k) {
      const ev = ofType('events').filter((e) => coversDay(e, k));
      return ev.length ? `<span class="tl-bar ${ev.some((e) => /deadline/i.test(e.subject) || e.cells[k] === '!') ? 'is-alert' : ''}"></span>` : '';
    },
    exercise(k) {
      const ab = exerciseAbbr(state.daily.byKey[k]?.exercise.value);
      return ab ? `<span class="tl-ex">${esc(ab)}</span>` : '';
    },
    commitments(k) {
      const vs = ofType('commitments').map((c) => c.cells[k]).filter(Boolean);
      if (!vs.length) return '';
      return `<span class="tl-mark ${vs.includes('!') ? 'is-alert' : ''}">${vs.includes('!') ? '!' : vs.some((v) => /^c$/i.test(v)) ? 'Class' : esc(vs[0])}</span>`;
    },
  };

  const body = [
    section('study', 'Study', `${fmtH(studyTotal)} h`, [...study, ...lonelyExams], preview.study),
    section('tasks', 'Tasks', `${open.length} open`, taskRows, preview.tasks),
    section('events', 'Calendar', plural(eventRows.length, 'event'), eventRows, preview.events),
    section('exercise', 'Exercise', '', exerciseRows, preview.exercise),
    section('commitments', 'Fixed commitments', '', commitRows, preview.commitments),
  ].join('');

  return `
    <h1 class="page-title tl-title">Timeline</h1>
    <div class="tl-legend" aria-label="Legend">
      <span><i class="lg-h"></i>Planned hours</span>
      <span><i class="tl-log is-good lg-log">2</i>Studied</span>
      <span><i class="lg-exam">Exam</i>Exam day</span>
      <span><i class="tl-dot"></i>Task planned</span>
      <span><i class="lg-bar"></i>Event</span>
    </div>
    <div class="tl-head-wrap" id="tl-head" aria-hidden="false">
      <table class="tl" style="--n:${days.length}">${cols}<thead>${head}</thead></table>
    </div>
    <div class="tl-scroll" id="tl-scroll">
      <table class="tl" style="--n:${days.length}">${cols}<tbody>${body}</tbody></table>
    </div>
    <p class="tl-tip">Tap a study cell to log what you studied or change the plan, a task cell to plan, move or finish it, or a date to open that day. The number under each date is that day's planned study total.</p>`;
}

// The timeline is two parts: the date row, pinned under the top bar, and the
// grid, which scrolls sideways only. Up and down moves the whole page, so a
// swipe moves along one axis at a time and the dates never drift from the grid.
function syncTimelineHead() {
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
  const th = $('#tl-head .tl-day.is-today');
  if (!sc || !th) return;
  const nameW = $('#tl-head .tl-name')?.offsetWidth || 0;
  sc.scrollTo({ left: Math.max(0, th.offsetLeft - nameW - th.offsetWidth), behavior: smooth ? 'smooth' : 'auto' });
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
  const rooms = ((e.task.match(/rooms?\s+([\d,\s]+)/i) || [])[1] || '').trim();
  // Leave out "Midterm" (they all are); keep names such as "YDS/2 (ÖSYM)".
  const base = e.task.replace(/,?\s*rooms?\s+[\d,\s]+$/i, '').trim();
  const rest = base.startsWith(e.subject + ' ') ? base.slice(e.subject.length).trim() : base;
  const kind = /^midterm$/i.test(rest) || rest === e.subject ? '' : rest;
  const when = [kind, `${dowLabel(e.start)} ${shortLabel(e.start)}`, e.time, rooms ? `Rooms ${rooms}` : ''].filter(Boolean);
  const pct = total ? Math.min(100, Math.round((studied / total) * 100)) : 0;
  const gap = dueSoFar - studied;
  const pace = !study || n < 0 ? '' : gap > 0.25 ? `<span class="pace-t is-behind">${fmtH(gap)} h behind</span>` : studied >= total && total ? '<span class="pace-t is-good">Plan covered</span>' : dueSoFar > 0 || studied > 0 ? `<span class="pace-t is-good">${gap < -0.25 ? `${fmtH(-gap)} h ahead` : 'On plan'}</span>` : '';
  const open = state.examOpen?.has(e.subject);
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
    <p class="hint">Tasks are saved to the sheet. Todoist is not changed.</p>`;
}

// ---------- Actions ----------

function setHours(item, k, value) {
  const v = Math.min(16, Math.max(0, Math.round(value * 2) / 2));
  if (v === toNumber(item.cells[k])) return;
  if (v) item.cells[k] = String(v); else delete item.cells[k];
  render();
  queue([{ range: cellRef(item, k), value: v || '' }]);
}

async function setLogged(subject, k, value) {
  const v = Math.min(16, Math.max(0, Math.round(value * 4) / 4));
  let row = logRowFor(subject);
  if (!row) {
    if (!v) return;
    row = await addLogRow(subject);
    if (!row) return;
  }
  if (v === toNumber(row.cells[k])) return;
  if (v) row.cells[k] = String(v); else delete row.cells[k];
  render();
  queue([{ range: cellRef(row, k), value: v || '' }], { delay: 300 });
  toast(v ? `${subject}: ${fmtH(v)} h studied ${relDay(k) === 'Today' ? 'today' : 'on ' + relDay(k)}` : `Cleared ${subject} for ${relDay(k)}`);
}

// Adds a log row for a subject that has none yet, below the last one.
async function addLogRow(subject) {
  const logs = state.plan.logs || [];
  if (!logs.length) { toast('The sheet has no Study log section yet.'); return null; }
  const last = logs[logs.length - 1];
  const row = last.row + 1;
  await flush();
  setSync('saving');
  try {
    await api.insertRowBelow(state.raw.sheetIds[CONFIG.sheets.gantt], last.row);
    const days = state.plan.days;
    const ups = [
      { range: colRef('phase', row), value: last.phase || 'Log' },
      { range: colRef('subject', row), value: subject },
      { range: colRef('task', row), value: last.task || 'Actual hours' },
    ];
    if (state.plan.header.hours >= 0 && days.length) ups.push({ range: colRef('hours', row), value: `=SUM(${colLetter(days[0].col)}${row}:${colLetter(days.at(-1).col)}${row})` });
    await api.writeCells(ups);
    setSync('saved');
  } catch (e) {
    if (e instanceof api.AuthError) { renderSignIn('Your session ended. Sign in and log the time again.'); return null; }
    setSync('error');
    toast(`Not saved. ${e.message}`);
    return null;
  }
  await refresh();
  return logRowFor(subject);
}

function setTaskStatus(item, next, { announce = true } = {}) {
  const st = item.status;
  if (st.status === next) return;
  const prev = { ...st };
  const statusPart = next === 'done' ? `done ${shortLabel(todayKey())}` : 'open';
  const text = composeTask({ ...st, statusPart });
  item.status = splitTask(text);
  item.task = text;
  state.justToggled = next === 'done' ? item.row : null;
  render();
  state.justToggled = null;
  queue([{ range: colRef('task', item.row), value: text }], { delay: 300 });
  if (announce) {
    toast(next === 'done' ? `Done: ${st.title}` : `Back to do: ${st.title}`, () => {
      item.status = prev;
      item.task = prev.raw;
      render();
      queue([{ range: colRef('task', item.row), value: prev.raw }], { delay: 0 });
    });
  }
}

const toggleTask = (item) => setTaskStatus(item, item.status.status === 'done' ? 'open' : 'done');

// Puts a task on exactly these days: X cells for the days in the chart, and
// Start and End set to the first and last day (both cleared for no days), so a
// removed day can never come back from a stale Start date.
function setTaskDays(item, days, message) {
  if (item.lockedDates) return toast('This row takes its dates from formulas in the sheet.');
  days = [...new Set(days)].sort();
  const before = currentDays(item);
  const ups = [];
  const marked = new Set(plannedDays(item));
  for (const d of marked) if (!days.includes(d)) { ups.push({ range: cellRef(item, d), value: '' }); delete item.cells[d]; }
  for (const d of days) if (!marked.has(d) && state.plan.dayByKey[d]) { ups.push({ range: cellRef(item, d), value: 'X' }); item.cells[d] = 'X'; }
  const s0 = days[0] || '', s1 = days.at(-1) || '';
  ups.push({ range: colRef('start', item.row), value: s0 }, { range: colRef('end', item.row), value: s1 });
  item.start = s0 || null;
  item.end = s1 || null;
  render();
  queue(ups, { delay: 200 });
  if (message) toast(message, () => setTaskDays(item, before));
}

const moveTask = (item, k) => setTaskDays(item, k ? [k] : [], k ? `Moved to ${relDay(k)}` : 'Date removed');
const addTaskDay = (item, k) => setTaskDays(item, [...currentDays(item), k], `Also planned for ${relDay(k)}`);
const removeTaskDay = (item, k) => setTaskDays(item, currentDays(item).filter((d) => d !== k), `Removed from ${relDay(k)}`);

async function deleteTask(item) {
  const title = item.status.title;
  await flush();
  setSync('saving');
  try {
    await api.deleteRow(state.raw.sheetIds[CONFIG.sheets.gantt], item.row);
    setSync('saved');
    toast(`Deleted: ${title}`);
  } catch (e) {
    if (e instanceof api.AuthError) return renderSignIn('Your session ended before the task was deleted. Sign in and try again.');
    setSync('error');
    toast(`Not deleted. ${e.message}`);
  }
  await refresh();
}

async function addTask({ title, date, phase = '', subject = '', prio = '', note = '' }) {
  const tasks = allTasks();
  const last = tasks[tasks.length - 1];
  if (!last) return toast('The sheet has no task section to add to.');
  const row = last.row + 1;
  await flush();
  setSync('saving');
  try {
    await api.insertRowBelow(state.raw.sheetIds[CONFIG.sheets.gantt], last.row);
    const ups = [
      { range: colRef('phase', row), value: phase },
      { range: colRef('subject', row), value: subject },
      { range: colRef('task', row), value: composeTask({ title, prio, statusPart: 'open', note }) },
    ];
    if (date) ups.push({ range: colRef('start', row), value: date }, { range: colRef('end', row), value: date });
    if (date && state.plan.dayByKey[date]) ups.push({ range: gantt(colLetter(state.plan.dayByKey[date].col) + row), value: 'X' });
    await api.writeCells(ups);
    setSync('saved');
    toast(`Added for ${date ? relDay(date) : 'no date'}`);
  } catch (e) {
    if (e instanceof api.AuthError) return renderSignIn('Your session ended before the task was added. Sign in and add it again.');
    setSync('error');
    toast(`Not added. ${e.message}`);
  }
  await refresh();
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

function editText(range, label, sub, value) {
  openSheet(`
    ${sheetHead(label, sub)}
    <label class="field"><textarea name="text" rows="3" aria-label="${esc(label)}">${esc(value)}</textarea></label>
    ${sheetActions('Save', value ? '<button class="btn btn-quiet" value="clear" formnovalidate>Clear</button>' : '')}`,
  (d, which) => {
    const v = which === 'clear' ? '' : d.text.trim();
    if (v === value) return;
    queue([{ range, value: v }], { delay: 0 });
    patchLocal(range, v);
  }, { onOpen: (f) => f.querySelector('textarea').focus() });
}

// Reflects a text edit on screen before the sheet confirms it.
function patchLocal(range, v) {
  const m = range.match(/!([A-Z]+)(\d+)$/);
  if (!m) return;
  const row = +m[2];
  if (range.includes(CONFIG.sheets.dailyPlan)) {
    for (const day of Object.values(state.daily.byKey)) {
      if (day.row !== row) continue;
      for (const f of ['commitments', 'studyNote', 'exercise']) if (colLetter(day[f].col) === m[1]) day[f].value = v;
    }
  } else {
    const item = findItem(row);
    if (item && colLetter(state.plan.header.task) === m[1]) item.task = v;
  }
  render();
}

function editCell(item, k) {
  const v = item.cells[k] || '';
  const used = [...new Set(Object.values(item.cells).concat(['!']))].filter((x) => x && x !== v).slice(0, 4);
  openSheet(`
    ${sheetHead(item.task || item.subject, longLabel(k))}
    <p class="dlg-label">Mark this day</p>
    <div class="choice-row">
      <button type="button" class="choice ${!v ? 'is-on' : ''}" data-set="v" data-value="">Nothing</button>
      ${v ? `<button type="button" class="choice is-on" data-set="v" data-value="${esc(v)}">${esc(v)}</button>` : ''}
      ${used.map((x) => `<button type="button" class="choice" data-set="v" data-value="${esc(x)}">${x === '!' ? '! Deadline' : esc(x)}</button>`).join('')}
    </div>
    <label class="field field-inline"><span>Or type</span><input name="v" value="${esc(v)}" maxlength="40"></label>
    ${sheetActions()}`,
  (d) => {
    const nv = d.v.trim();
    if (nv === v) return;
    if (nv) item.cells[k] = nv; else delete item.cells[k];
    render();
    queue([{ range: cellRef(item, k), value: nv }], { delay: 0 });
  }, { onOpen: wireChoices });
}

function taskForm(t, date) {
  const tasks = allTasks();
  const phases = [...new Set(tasks.map((x) => x.phase).filter(Boolean))];
  const subjects = [...new Set(tasks.map((x) => x.subject).filter(Boolean))];
  const st = t?.status || { title: '', prio: '', note: '' };
  const days = t ? currentDays(t) : [];
  return `
    <label class="field"><span>Task</span><input name="title" value="${esc(st.title)}" required autocomplete="off"></label>
    <p class="dlg-label">When</p>
    ${days.length > 1 ? `<p class="dlg-sub">Planned on ${days.map((d) => esc(shortLabel(d))).join(', ')}. Picking a day moves it to that day only.</p>` : ''}
    ${dateChoices('date', date, { none: Boolean(t) })}
    <p class="dlg-label">Priority</p>
    <div class="choice-row">
      ${['', 'P1', 'P2', 'P3'].map((p) => `<button type="button" class="choice ${st.prio === p ? 'is-on' : ''}" data-set="prio" data-value="${p}">${p || 'None'}</button>`).join('')}
      <input type="hidden" name="prio" value="${esc(st.prio)}">
    </div>
    <label class="field"><span>Note</span><input name="note" value="${esc(st.note)}" autocomplete="off" placeholder="Optional"></label>
    <details class="more">
      <summary>Area and topic</summary>
      <div class="field-row">
        <label class="field"><span>Area</span><input name="phase" list="dl-phase" value="${esc(t ? t.phase : phases[0] || '')}" autocomplete="off"></label>
        <label class="field"><span>Topic</span><input name="subject" list="dl-subject" value="${esc(t?.subject || '')}" autocomplete="off"></label>
      </div>
      <datalist id="dl-phase">${phases.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <datalist id="dl-subject">${subjects.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
    </details>`;
}

function editTask(item) {
  const st = item.status;
  const done = st.status === 'done';
  const due = taskDue(item) || '';
  openSheet(`
    ${sheetHead('Edit task', [item.phase, item.subject].filter(Boolean).join(', '))}
    <button type="button" class="done-toggle ${done ? 'is-done' : ''}" data-toggle-done aria-pressed="${done}">
      <span class="check" aria-hidden="true">${ICON.check}</span>
      <span><b>${done ? 'Done' : 'Not done yet'}</b><small>${done ? (st.doneOn ? `Finished ${esc(st.doneOn)}. Tap to reopen.` : 'Tap to reopen.') : 'Tap to mark as done.'}</small></span>
    </button>
    ${taskForm(item, due)}
    ${sheetActions('Save', '<button class="btn btn-quiet btn-danger" value="delete" formnovalidate data-confirm>Delete</button>')}`,
  (d, which) => {
    if (which === 'delete') return deleteTask(item);
    const ups = [];
    const changed = d.title.trim() !== st.title || d.prio !== st.prio || (d.note ?? st.note).trim() !== st.note;
    if (changed) {
      const text = composeTask({ title: d.title.trim(), prio: d.prio, statusPart: item.status.statusPart, note: (d.note ?? st.note).trim() });
      ups.push({ range: colRef('task', item.row), value: text });
      item.status = splitTask(text);
      item.task = text;
    }
    if (d.phase !== undefined && d.phase.trim() !== item.phase) { ups.push({ range: colRef('phase', item.row), value: d.phase.trim() }); item.phase = d.phase.trim(); }
    if (d.subject !== undefined && d.subject.trim() !== item.subject) { ups.push({ range: colRef('subject', item.row), value: d.subject.trim() }); item.subject = d.subject.trim(); }
    if (ups.length) { render(); queue(ups, { delay: 0 }); }
    if ((d.date || '') !== due) moveTask(item, d.date || '');
  }, {
    onOpen(form) {
      wireChoices(form);
      // Done toggles straight away; the rest waits for Save.
      form.querySelector('[data-toggle-done]').addEventListener('click', () => closeSheet(() => toggleTask(item)));
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
  (d) => addTask({ title: d.title.trim(), date: d.date, prio: d.prio, note: (d.note || '').trim(), phase: (d.phase || '').trim(), subject: (d.subject || '').trim() }),
  { onOpen(form) { wireChoices(form); form.querySelector('[name=title]').focus(); } });
}

function accountMenu() {
  openSheet(`
    ${sheetHead('Account')}
    <p class="dlg-sub">Signed in to Google for this session. The app reads and writes the sheet directly and stores none of its data.</p>
    <p><a href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(CONFIG.spreadsheetId)}/edit" target="_blank" rel="noopener">Open the sheet in Google Sheets</a></p>
    <div class="dlg-actions"><button class="btn btn-quiet" value="signout">Sign out</button></div>`,
  (d, which) => { if (which === 'signout') signOut(); });
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
  const item = el.dataset.row ? findItem(el.dataset.row) : null;
  switch (a) {
    case 'sign-in': return signIn(store.get('pg.signedIn') === '1');
    case 'refresh': return flush().then(() => { checkForUpdate(); return refresh(); });
    case 'menu': return accountMenu();
    case 'view':
      if (Date.now() - tabTouchAt < 700) return; // handled by the touch on the tab bar
      return goToPage(el.dataset.view, true);
    case 'pick-day': return goDay(el.dataset.day);
    case 'open-day': selectDay(el.dataset.day, { smooth: false }); return goToPage('today', true);
    case 'go-today': return goDay(clampDay(todayKey()));
    case 'hours': return item && setHours(item, el.dataset.day, toNumber(item.cells[el.dataset.day]) + Number(el.dataset.delta));
    case 'edit-hours': return item && editHours(item, el.dataset.day);
    case 'toggle-task': return item && toggleTask(item);
    case 'edit-task': return item && editTask(item);
    case 'move-task': return item && moveTaskSheet(item);
    case 'task-day': return item && taskDaySheet(item, el.dataset.day);
    case 'log-hours': return logHours(el.dataset.subject, el.dataset.day);
    case 'edit-cell': return item && editCell(item, el.dataset.day);
    case 'edit-text': return editText(el.dataset.range, el.dataset.label, el.dataset.sub, el.dataset.value);
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
  const phase = [...new Set(allTasks().map((t) => t.phase).filter(Boolean))][0] || '';
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
