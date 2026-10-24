import { CONFIG } from '../config.js';
import * as api from './sheets.js';
import { parseGantt, parseDailyPlan, colLetter, keyOfDate, dateOfKey, splitTask, composeTask, toNumber } from './parse.js';

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
  tlStart: null,
  tlClosed: new Set(JSON.parse(store.get('pg.tlClosed') || '["commitments"]')),
  showDone: false,
  dirty: false,
};

const app = $('#app');

// ---------- Boot and auth ----------

function boot() {
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
      render({ resetScroll: true });
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

function render({ resetScroll = false } = {}) {
  if (!state.plan) return;
  if ($('#dialog')?.open) { state.dirty = true; return; }
  const view = VIEWS.some(([v]) => v === state.view) ? state.view : 'today';

  // Keep every scroll position across re-renders, so an edit never moves the page.
  const keep = resetScroll ? null : { y: window.scrollY };

  app.innerHTML = `
    <header class="bar">
      <div class="bar-title">Personal Gantt</div>
      <nav class="tabs" aria-label="Views">
        ${VIEWS.map(([v, label, icon]) => `<button class="tab" data-action="view" data-view="${v}" aria-current="${v === view ? 'page' : 'false'}">${ICON[icon]}<span>${label}</span></button>`).join('')}
      </nav>
      <div class="bar-side">
        <span class="status" id="status" aria-live="polite"></span>
        <button class="icon-btn" data-action="refresh" aria-label="Reload from the sheet" title="Reload from the sheet">${ICON.refresh}</button>
        <button class="icon-btn" data-action="menu" aria-label="Account" title="Account">${ICON.user}</button>
      </div>
    </header>
    <main class="view view-${view}" id="view">${VIEW_RENDER[view]()}</main>`;
  renderStatus();

  window.scrollTo(0, keep ? keep.y : 0);
  const bar = $('.bar');
  if (bar) document.documentElement.style.setProperty('--bar-h', bar.offsetHeight + 'px');
  if (view === 'today') centerStrip(!keep);
}

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

function coversDay(item, k) {
  if (item.cells[k]) return true;
  return item.start && item.end ? item.start <= k && k <= item.end : item.start === k;
}

function nextExams(fromKey) {
  return state.plan.exams.filter((e) => e.start && e.start >= fromKey).sort((a, b) => (a.start + a.time).localeCompare(b.start + b.time));
}

// ---------- Day view ----------

function renderToday() {
  const k = state.day;
  const isToday = k === todayKey();
  const study = studyOn(k);
  const total = study.reduce((n, s) => n + s.hours, 0);
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
    <section class="day-nav">
      <div class="day-nav-top">
        <span class="month">${dt.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>
        <span class="spacer"></span>
        ${isToday ? '' : '<button class="chip-btn" data-action="go-today">Today</button>'}
        <label class="icon-btn pick-date" title="Pick a date" aria-label="Pick a date">${ICON.calendar}
          <input type="date" data-input="pick-day" value="${k}" min="${state.plan.days[0]?.key}" max="${state.plan.days.at(-1)?.key}">
        </label>
      </div>
      ${renderStrip(k)}
      <h1 class="day-title">${esc(longLabel(k))}</h1>
    </section>

    ${renderCountdown(k)}

    <section class="block">
      <div class="block-head">
        <h2>Study</h2>
        <span class="block-meta">${total ? fmtH(total) + ' h planned' : 'Nothing planned'}</span>
      </div>
      <ul class="study-list">${study.map(({ item, hours }) => studyRow(item, hours, k)).join('')}</ul>
      ${daily?.studyNote.value && !/^none/i.test(daily.studyNote.value) ? `<p class="note">${esc(daily.studyNote.value)}</p>` : ''}
      ${others.length ? `
        <div class="add-row">
          <span class="add-label">Add a subject</span>
          <div class="chips">${others.map((s) => `<button class="chip" style="--c:${subjectVar(s.subject)}" data-action="hours" data-row="${s.row}" data-day="${k}" data-delta="1" aria-label="Add 1 hour of ${esc(s.subject)}">${esc(s.subject)}</button>`).join('')}</div>
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

function renderStrip(selected) {
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
        return `<button class="strip-day ${d.key === selected ? 'is-selected' : ''} ${d.key === tk ? 'is-today' : ''} ${dt.getDay() % 6 === 0 ? 'is-weekend' : ''}" role="option" aria-selected="${d.key === selected}" data-action="pick-day" data-day="${d.key}" aria-label="${esc(longLabel(d.key))}${h ? `, ${fmtH(h)} hours` : ''}${examDays.has(d.key) ? ', exam' : ''}">
          <span class="sd-dow">${esc(dowLabel(d.key).slice(0, 2))}</span>
          <span class="sd-num">${dt.getDate()}</span>
          <span class="sd-load"><span style="width:${Math.round((h / max) * 100)}%"></span></span>
          <span class="sd-marks">${examDays.has(d.key) ? '<i class="m-exam"></i>' : ''}${openTasks ? '<i class="m-task"></i>' : ''}</span>
        </button>`;
      }).join('')}
    </div>`;
}

function centerStrip(instant) {
  const strip = $('#strip');
  const sel = strip?.querySelector('.is-selected');
  if (!strip || !sel) return;
  const left = sel.offsetLeft - strip.clientWidth / 2 + sel.offsetWidth / 2;
  strip.scrollTo({ left, behavior: instant ? 'auto' : 'smooth' });
}

function renderCountdown(k) {
  const exams = nextExams(k);
  if (!exams.length) return '';
  const todays = exams.filter((e) => e.start === k);
  const head = todays[0] || exams[0];
  const n = daysBetween(k, head.start);
  const later = exams.filter((e) => !todays.includes(e) && e !== head).slice(0, 3);
  const lead = (todays.length ? todays : [head]);
  return `
    <section class="countdown" style="--c:${subjectVar(head.subject)}">
      <div class="cd-num">${n === 0 ? 'Today' : `${n}<small>${n === 1 ? 'day' : 'days'}</small>`}</div>
      <div class="cd-body">
        <div class="cd-label">${n === 0 ? (todays.length > 1 ? 'Exams today' : 'Exam today') : 'until your next exam'}</div>
        ${lead.map((e) => `<div class="cd-exam"><strong>${esc(e.subject)}</strong> ${esc(relDay(e.start) === 'Today' ? '' : dowLabel(e.start) + ' ' + shortLabel(e.start))}${e.time ? ` at ${esc(e.time)}` : ''}</div>`).join('')}
      </div>
      ${later.length ? `<div class="cd-later">${later.map((e) => `<span><b>${daysBetween(k, e.start)} d</b> ${esc(e.subject)}</span>`).join('')}</div>` : ''}
    </section>`;
}

function studyRow(item, hours, k) {
  return `
    <li class="study" style="--c:${subjectVar(item.subject)}">
      <span class="study-swatch" aria-hidden="true"></span>
      <button class="study-name" data-action="edit-hours" data-row="${item.row}" data-day="${k}">${esc(item.subject)}</button>
      <span class="stepper">
        <button class="step" data-action="hours" data-row="${item.row}" data-day="${k}" data-delta="-0.5" aria-label="Half an hour less ${esc(item.subject)}">${ICON.minus}</button>
        <button class="study-hours" data-action="edit-hours" data-row="${item.row}" data-day="${k}" aria-label="${fmtH(hours)} hours, tap to change">${fmtH(hours)}<small>h</small></button>
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
    <li class="task ${done ? 'is-done' : ''}">
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
// A Gantt shown one week at a time (two on wide screens). Every row is a label
// with a track of day cells under it, so nothing scrolls sideways. A study
// subject carries its exam as a milestone on the same row.

const tlSpan = () => (window.innerWidth >= 900 ? 14 : 7);

// The window starts on a given day (today by default) and shows the days ahead.
function clampWeek(k) {
  const lo = state.plan.days[0].key;
  const hi = addDays(state.plan.days.at(-1).key, 1 - tlSpan());
  return k > hi ? (hi < lo ? lo : hi) : k < lo ? lo : k;
}

function tlDays() {
  state.tlStart = clampWeek(state.tlStart || todayKey());
  return Array.from({ length: tlSpan() }, (_, i) => addDays(state.tlStart, i));
}

function weekName(start) {
  const d = daysBetween(todayKey(), start);
  if (d === 0) return `Today and the next ${tlSpan() - 1} days`;
  if (Math.abs(d) < 7) return `Starting ${relDay(start)}`;
  const n = Math.round(d / 7);
  return n > 0 ? `In ${plural(n, 'week')}` : `${plural(-n, 'week')} ago`;
}

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
  const days = tlDays();
  const tk = todayKey();
  const n = days.length;
  const first = days[0];
  const last = days.at(-1);
  const inPlan = (k) => Boolean(state.plan.dayByKey[k]);
  const inWin = (a, b) => a && (b || a) >= first && a <= last;
  const cellCls = (k, extra = '') => `c ${extra} ${k === tk ? 'is-today' : ''} ${dateOfKey(k).getDay() % 6 === 0 ? 'is-weekend' : ''} ${inPlan(k) ? '' : 'is-out'}`;
  const atStart = state.tlStart <= state.plan.days[0].key;
  const atEnd = addDays(state.tlStart, n - 1) >= state.plan.days.at(-1).key;

  // Study subjects, each with its exam on the same row.
  const maxH = Math.max(1, ...state.plan.study.flatMap((s) => Object.values(s.cells).map(toNumber)));
  const studyRows = [];
  const notThisWeek = [];
  for (const s of state.plan.study) {
    const exam = state.plan.exams.find((e) => e.subject === s.subject);
    const keys = Object.keys(s.cells).filter((k) => toNumber(s.cells[k]) > 0).sort();
    const runStart = keys[0];
    const runEnd = [exam?.start, keys.at(-1)].filter(Boolean).sort().at(-1);
    if (!runStart || !inWin(runStart, runEnd)) { notThisWeek.push(s.subject); continue; }
    const week = days.reduce((h, k) => h + toNumber(s.cells[k]), 0);
    const meta = [week ? `${fmtH(week)} h` : '',
      exam && (exam.start > last ? `exam ${shortLabel(exam.start)}` : '')].filter(Boolean).join(', ');
    const cells = days.map((k) => {
      const h = toNumber(s.cells[k]);
      const isExam = exam && exam.start === k;
      const run = k >= runStart && k <= runEnd;
      const inner = isExam
        ? `<span class="c-exam">Exam${exam.time ? `<small>${esc(exam.time)}</small>` : ''}</span>`
        : h ? `<span class="c-h" style="--a:${Math.round(16 + 34 * (h / maxH))}%">${fmtH(h)}</span>` : '';
      const label = `${s.subject}, ${longLabel(k)}: ${isExam ? 'exam, ' : ''}${h ? fmtH(h) + ' hours' : 'no study'}`;
      return inPlan(k)
        ? `<button class="${cellCls(k, run ? 'in-run' : '')}" data-action="edit-hours" data-row="${s.row}" data-day="${k}" aria-label="${esc(label)}">${inner}</button>`
        : `<span class="${cellCls(k)}"></span>`;
    }).join('');
    studyRows.push(row({ cls: 'is-study', color: subjectVar(s.subject), name: s.subject, meta, cells }));
  }
  for (const e of state.plan.exams) {
    if (state.plan.study.some((s) => s.subject === e.subject) || !inWin(e.start)) continue;
    const cells = days.map((k) => `<span class="${cellCls(k)}">${e.start === k ? '<span class="c-exam">Exam</span>' : ''}</span>`).join('');
    studyRows.push(row({ cls: 'is-study', color: subjectVar(e.subject), name: e.subject, meta: 'Exam', cells }));
  }
  const weekTotal = days.reduce((h, k) => h + studyHoursOn(k), 0);

  // Tasks planned in this window.
  const tasks = allTasks().filter((t) => { const pd = plannedDays(t); return pd.length ? pd.some((k) => k >= first && k <= last) : inWin(t.start, t.end); });
  const taskRows = tasks.map((t) => {
    const done = t.status.status === 'done';
    const pd = plannedDays(t);
    const cells = days.map((k) => {
      const on = pd.length ? pd.includes(k) : t.start === k;
      const label = `${t.status.title}, ${longLabel(k)}: ${on ? 'planned, tap to remove' : 'tap to plan'}`;
      const inner = on ? (done ? `<span class="c-done">${ICON.check}</span>` : '<span class="c-task"></span>') : '';
      return inPlan(k)
        ? `<button class="${cellCls(k)}" data-action="plan-task" data-row="${t.row}" data-day="${k}" aria-label="${esc(label)}">${inner}</button>`
        : `<span class="${cellCls(k)}"></span>`;
    }).join('');
    return row({
      cls: done ? 'is-done' : '', name: t.status.title, meta: done ? 'Done' : [t.phase, t.subject].filter(Boolean).join(', '),
      action: `data-action="edit-task" data-row="${t.row}"`, cells, prio: t.status.prio,
    });
  });

  // Calendar events and deadlines.
  const events = ofType('events').filter((e) => inWin(e.start, e.end) || Object.keys(e.cells).some((k) => k >= first && k <= last));
  const eventRows = events.map((e) => {
    const alert = /deadline/i.test(e.subject);
    const cells = days.map((k) => {
      const on = coversDay(e, k);
      return `<span class="${cellCls(k)}">${on ? `<span class="c-bar ${alert || e.cells[k] === '!' ? 'is-alert' : ''}"></span>` : ''}</span>`;
    }).join('');
    return row({ name: e.task.replace(/\s*\(.*\)\s*$/, ''), meta: e.subject, cells, cls: alert ? 'is-alert' : '' });
  });

  // Exercise: one row, from the Daily Plan sheet, with the current phase.
  const phases = ofType('exercise').filter((e) => !/weigh/i.test(e.subject) && inWin(e.start, e.end));
  const exDays = days.filter((k) => state.daily.byKey[k]);
  let exerciseRows = [];
  if (exDays.length || phases.length) {
    const cells = days.map((k) => {
      const dp = state.daily.byKey[k];
      const inPhase = phases.some((p) => p.start <= k && k <= p.end);
      const ab = exerciseAbbr(dp?.exercise.value);
      const inner = ab ? `<span class="c-ex">${esc(ab)}</span>` : '';
      return dp && !dp.exercise.locked && dp.exercise.col >= 0
        ? `<button class="${cellCls(k, inPhase ? 'in-phase' : '')}" data-action="edit-text" data-range="${esc(dailyCell(colLetter(dp.exercise.col) + dp.row))}" data-label="Exercise" data-sub="${esc(longLabel(k))}" data-value="${esc(dp.exercise.value)}" aria-label="Exercise, ${esc(longLabel(k))}: ${esc(dp.exercise.value || 'none')}">${inner}</button>`
        : `<span class="${cellCls(k, inPhase ? 'in-phase' : '')}">${inner}</span>`;
    }).join('');
    exerciseRows = [row({ name: 'Exercise', meta: phases.map((p) => p.subject).join(', ') || 'No phase in these days', cells })];
  }

  // Fixed commitments (classes and marked days).
  const commitRows = ofType('commitments').filter((c) => Object.keys(c.cells).some((k) => k >= first && k <= last)).map((c) => row({
    name: c.subject || c.task, meta: c.task,
    cells: days.map((k) => {
      const v = c.cells[k] || '';
      const inner = v ? `<span class="c-mark ${v === '!' ? 'is-alert' : ''}">${v.toUpperCase() === 'C' ? 'Class' : esc(v)}</span>` : '';
      return inPlan(k) ? `<button class="${cellCls(k)}" data-action="edit-cell" data-row="${c.row}" data-day="${k}" aria-label="${esc(c.subject)}, ${esc(longLabel(k))}: ${esc(v || 'nothing')}">${inner}</button>` : `<span class="${cellCls(k)}">${inner}</span>`;
    }).join(''),
  }));

  const groups = [
    ['study', 'Study', weekTotal ? `${fmtH(weekTotal)} h` : '', studyRows, notThisWeek.length ? `Not in these days: ${notThisWeek.join(', ')}` : ''],
    ['tasks', 'Tasks', tasks.length ? `${tasks.filter((t) => t.status.status === 'done').length} of ${tasks.length} done` : '', taskRows, tasks.length ? '' : 'No tasks planned. Plan one from the Tasks tab.'],
    ['events', 'Calendar', events.length ? plural(events.length, 'event') : '', eventRows, ''],
    ['exercise', 'Exercise', '', exerciseRows, ''],
    ['commitments', 'Fixed commitments', '', commitRows, ''],
  ].filter(([, , , rows, empty]) => rows.length || empty);

  return `
    <div class="tg" style="--n:${n}">
      <div class="tg-nav">
        <button class="icon-btn" data-action="tl-week" data-step="-1" ${atStart ? 'disabled' : ''} aria-label="Earlier days">${ICON.left}</button>
        <div class="tg-title">
          <h1>${esc(shortLabel(first))} to ${esc(shortLabel(last))}</h1>
          ${todayKey() !== state.tlStart ? `<button class="link" data-action="tl-now">${esc(weekName(state.tlStart))}, back to today</button>` : ''}
        </div>
        <button class="icon-btn" data-action="tl-week" data-step="1" ${atEnd ? 'disabled' : ''} aria-label="Later days">${ICON.right}</button>
      </div>
      <div class="tg-head" id="tg-head">
        <div class="tg-head-label"></div>
        <div class="tg-days">
          ${days.map((k) => `<button class="tg-day ${k === tk ? 'is-today' : ''} ${dateOfKey(k).getDay() % 6 === 0 ? 'is-weekend' : ''}" data-action="open-day" data-day="${k}" ${inPlan(k) ? '' : 'disabled'} aria-label="Open ${esc(longLabel(k))}"><span>${esc(dowLabel(k).slice(0, 2))}</span><b>${dateOfKey(k).getDate()}</b><i>${studyHoursOn(k) ? fmtH(studyHoursOn(k)) + 'h' : ''}</i></button>`).join('')}
        </div>
      </div>
      ${groups.map(([id, name, meta, rows, empty]) => {
        const open = !state.tlClosed.has(id);
        return `
          <section class="tg-group">
            <button class="tg-group-head" data-action="tl-group" data-id="${id}" aria-expanded="${open}">${ICON[open ? 'down' : 'right']}<span>${name}</span><span class="tg-group-meta">${esc(meta)}</span></button>
            ${open ? `${rows.join('')}${empty ? `<p class="tg-empty">${esc(empty)}</p>` : ''}` : ''}
          </section>`;
      }).join('')}
      <p class="hint tg-hint">Tap a day to change it. Swipe for other weeks. The number under each date is that day's total study.</p>
    </div>`;
}

function row({ name, meta, cells, color = '', cls = '', action = '', prio = '' }) {
  const label = `<span class="tg-name">${prio ? `<span class="prio prio-${esc(prio.slice(1))}">${esc(prio)}</span>` : ''}${esc(name)}</span>${meta ? `<span class="tg-meta">${esc(meta)}</span>` : ''}`;
  return `
    <div class="tg-row ${cls}" ${color ? `style="--c:${color}"` : ''}>
      ${action ? `<button class="tg-label" ${action}>${color ? '<i class="tg-dot"></i>' : ''}${label}</button>` : `<div class="tg-label">${color ? '<i class="tg-dot"></i>' : ''}${label}</div>`}
      <div class="tg-track">${cells}</div>
    </div>`;
}

function stepWeek(dir) {
  const next = clampWeek(addDays(state.tlStart, dir * tlSpan()));
  if (next === state.tlStart) return;
  state.tlStart = next;
  render({ resetScroll: false });
  const v = $('#view .tg');
  if (v) v.classList.add('is-turning');
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

function examCard(e, tk) {
  const study = state.plan.study.find((s) => s.subject === e.subject);
  const active = study ? state.plan.days.filter((d) => d.key <= e.start).map((d) => ({ k: d.key, h: toNumber(study.cells[d.key]) })).filter((x) => x.h > 0) : [];
  const total = active.reduce((n, x) => n + x.h, 0);
  const behind = active.filter((x) => x.k < tk).reduce((n, x) => n + x.h, 0);
  const firstK = active[0]?.k;
  const span = firstK ? state.plan.days.filter((d) => d.key >= firstK && d.key <= e.start) : [];
  const max = Math.max(1, ...active.map((x) => x.h));
  const n = daysBetween(tk, e.start);
  const rooms = (e.task.match(/rooms?\s+([\d,\s]+)/i) || [])[1];
  const pct = total ? Math.round((behind / total) * 100) : 0;
  return `
    <article class="exam" style="--c:${subjectVar(e.subject)}">
      <div class="exam-count">${n < 0 ? 'Done' : n === 0 ? 'Today' : `${n}<small>${n === 1 ? 'day' : 'days'}</small>`}</div>
      <h2 class="exam-subject">${esc(e.subject)}</h2>
      <p class="exam-when">${esc(longLabel(e.start))}${e.time ? ' at ' + esc(e.time) : ''}${rooms ? `<br>Rooms ${esc(rooms.trim())}` : ''}</p>
      ${!rooms && e.task !== e.subject ? `<p class="exam-when">${esc(e.task)}</p>` : ''}
      ${study ? `
        <div class="progress" role="img" aria-label="${fmtH(behind)} of ${fmtH(total)} planned hours done">
          <div class="progress-bar"><span style="width:${pct}%"></span></div>
          <div class="progress-text"><strong>${fmtH(behind)}</strong> of ${fmtH(total)} h studied, <strong>${fmtH(total - behind)} h</strong> to go</div>
        </div>
        <div class="spark" aria-hidden="true">
          ${span.map((d) => { const h = toNumber(study.cells[d.key]); return `<span class="spark-bar ${d.key < tk ? 'is-past' : ''} ${d.key === tk ? 'is-today' : ''}" style="height:${h ? Math.max(8, (h / max) * 100) : 2}%" title="${esc(shortLabel(d.key))}: ${fmtH(h)} h"></span>`; }).join('')}
        </div>
        <div class="spark-axis"><span>${firstK ? esc(shortLabel(firstK)) : ''}</span><span>Exam</span></div>` : ''}
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

function setTaskStatus(item, next, { announce = true } = {}) {
  const st = item.status;
  if (st.status === next) return;
  const prev = { ...st };
  const statusPart = next === 'done' ? `done ${shortLabel(todayKey())}` : 'open';
  const text = composeTask({ ...st, statusPart });
  item.status = splitTask(text);
  item.task = text;
  render();
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

function datesUpdates(item, days) {
  if (item.lockedDates || !days.length) return [];
  return [
    { range: colRef('start', item.row), value: days[0] },
    { range: colRef('end', item.row), value: days[days.length - 1] },
  ];
}

function planTask(item, k) {
  const had = /x/i.test(item.cells[k] || '');
  const before = { ...item.cells };
  const ups = [{ range: cellRef(item, k), value: had ? '' : 'X' }];
  if (had) delete item.cells[k]; else item.cells[k] = 'X';
  const days = plannedDays(item);
  ups.push(...datesUpdates(item, days));
  if (days.length && !item.lockedDates) { item.start = days[0]; item.end = days.at(-1); }
  render();
  queue(ups, { delay: 300 });
  toast(had ? `Removed from ${relDay(k)}` : `Planned for ${relDay(k)}`, () => {
    item.cells = before;
    render();
    queue([{ range: cellRef(item, k), value: had ? 'X' : '' }, ...datesUpdates(item, plannedDays(item))], { delay: 0 });
  });
}

function moveTask(item, k) {
  if (item.lockedDates) return toast('This row takes its dates from formulas in the sheet.');
  const ups = [
    { range: colRef('start', item.row), value: k },
    { range: colRef('end', item.row), value: k },
  ];
  for (const d of plannedDays(item)) if (d !== k) { ups.push({ range: cellRef(item, d), value: '' }); delete item.cells[d]; }
  if (state.plan.dayByKey[k]) { ups.push({ range: cellRef(item, k), value: 'X' }); item.cells[k] = 'X'; }
  item.start = item.end = k;
  render();
  queue(ups, { delay: 200 });
  toast(`Moved to ${relDay(k)}`);
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

function openSheet(html, onSubmit, { onOpen } = {}) {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog" class="dlg"><div class="grab" aria-hidden="true"></div>${html}</form>`;
  const form = dlg.querySelector('form');
  form.addEventListener('submit', (ev) => {
    const btn = ev.submitter;
    if (btn?.value === 'cancel') return;
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    dlg.close();
    onSubmit(data, btn?.value || btn?.dataset.value);
  });
  dlg.showModal();
  if (onOpen) onOpen(form);
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

function dateChoices(name, current) {
  const tk = todayKey();
  const nextMon = addDays(tk, ((8 - dateOfKey(tk).getDay()) % 7) || 7);
  const opts = [['Today', tk], ['Tomorrow', addDays(tk, 1)], ['Next Monday', nextMon]];
  return `
    <div class="choice-row">
      ${opts.map(([l, k]) => `<button type="button" class="choice ${current === k ? 'is-on' : ''}" data-set="${name}" data-value="${k}">${l}</button>`).join('')}
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

function editHours(item, k) {
  const v = toNumber(item.cells[k]);
  const quick = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4];
  openSheet(`
    ${sheetHead(item.subject, longLabel(k) + (state.plan.exams.some((e) => e.subject === item.subject && e.start === k) ? ', exam day' : ''))}
    <p class="dlg-label">Study hours</p>
    <div class="hour-grid">
      ${quick.map((h) => `<button class="hour ${h === v ? 'is-on' : ''}" value="q" data-value="${h}" name="quick">${h === 0 ? 'None' : fmtH(h)}</button>`).join('')}
    </div>
    <label class="field field-inline"><span>Other amount</span><input name="hours" type="number" inputmode="decimal" min="0" max="16" step="0.5" value="${quick.includes(v) ? '' : v}" placeholder="e.g. 5"></label>
    ${sheetActions('Save')}`,
  (d, which) => {
    if (which === 'q') return;
    if (d.hours !== '') setHours(item, k, toNumber(d.hours));
  }, {
    onOpen(form) {
      form.querySelectorAll('.hour').forEach((b) => b.addEventListener('click', (ev) => {
        ev.preventDefault();
        $('#dialog').close();
        setHours(item, k, Number(b.dataset.value));
      }));
    },
  });
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
  return `
    <label class="field"><span>Task</span><input name="title" value="${esc(st.title)}" required autocomplete="off"></label>
    <p class="dlg-label">When</p>
    ${dateChoices('date', date)}
    <p class="dlg-label">Priority</p>
    <div class="choice-row">
      ${['', 'P1', 'P2', 'P3'].map((p) => `<button type="button" class="choice ${st.prio === p ? 'is-on' : ''}" data-set="prio" data-value="${p}">${p || 'None'}</button>`).join('')}
      <input type="hidden" name="prio" value="${esc(st.prio)}">
    </div>
    <details class="more">
      <summary>Note and area</summary>
      <label class="field"><span>Note</span><input name="note" value="${esc(st.note)}" autocomplete="off" placeholder="Optional"></label>
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
  openSheet(`
    ${sheetHead('Edit task', done ? (st.doneOn ? `Done ${st.doneOn}` : 'Done') : taskDue(item) ? `Planned for ${relDay(taskDue(item))}` : 'No date')}
    ${taskForm(item, taskDue(item))}
    ${sheetActions('Save', `<button class="btn btn-quiet" value="toggle" formnovalidate>${done ? 'Mark as not done' : 'Mark as done'}</button>`)}`,
  (d, which) => {
    if (which === 'toggle') return toggleTask(item);
    const ups = [];
    const changed = d.title.trim() !== st.title || d.prio !== st.prio || (d.note ?? st.note).trim() !== st.note;
    if (changed) {
      const text = composeTask({ title: d.title.trim(), prio: d.prio, statusPart: st.statusPart, note: (d.note ?? st.note).trim() });
      ups.push({ range: colRef('task', item.row), value: text });
      item.status = splitTask(text);
    }
    if (d.phase !== undefined && d.phase.trim() !== item.phase) { ups.push({ range: colRef('phase', item.row), value: d.phase.trim() }); item.phase = d.phase.trim(); }
    if (d.subject !== undefined && d.subject.trim() !== item.subject) { ups.push({ range: colRef('subject', item.row), value: d.subject.trim() }); item.subject = d.subject.trim(); }
    if (ups.length) { render(); queue(ups, { delay: 0 }); }
    if (d.date && d.date !== taskDue(item)) moveTask(item, d.date);
  }, { onOpen: wireChoices });
}

function moveTaskSheet(item) {
  openSheet(`
    ${sheetHead('Move task', item.status.title)}
    ${dateChoices('date', taskDue(item))}
    ${sheetActions('Move')}`,
  (d) => { if (d.date && d.date !== taskDue(item)) moveTask(item, d.date); },
  {
    onOpen(form) {
      wireChoices(form);
      form.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => {
        $('#dialog').close();
        if (b.dataset.value !== taskDue(item)) moveTask(item, b.dataset.value);
      }));
    },
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

function goDay(k, { fromSwipe = false } = {}) {
  if (!state.plan.dayByKey[k]) return;
  state.day = k;
  render();
  if (fromSwipe) $('#view')?.classList.add('is-turning');
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  const item = el.dataset.row ? findItem(el.dataset.row) : null;
  switch (a) {
    case 'sign-in': return signIn(store.get('pg.signedIn') === '1');
    case 'refresh': return flush().then(() => refresh());
    case 'menu': return accountMenu();
    case 'view':
      state.view = el.dataset.view;
      store.set('pg.view', state.view);
      if (state.view === 'timeline') state.tlStart = state.day;
      return render({ resetScroll: true });
    case 'pick-day': return goDay(el.dataset.day);
    case 'open-day': state.view = 'today'; store.set('pg.view', 'today'); state.day = el.dataset.day; return render({ resetScroll: true });
    case 'go-today': return goDay(clampDay(todayKey()));
    case 'hours': return item && setHours(item, el.dataset.day, toNumber(item.cells[el.dataset.day]) + Number(el.dataset.delta));
    case 'edit-hours': return item && editHours(item, el.dataset.day);
    case 'toggle-task': return item && toggleTask(item);
    case 'edit-task': return item && editTask(item);
    case 'move-task': return item && moveTaskSheet(item);
    case 'plan-task': return item && planTask(item, el.dataset.day);
    case 'edit-cell': return item && editCell(item, el.dataset.day);
    case 'edit-text': return editText(el.dataset.range, el.dataset.label, el.dataset.sub, el.dataset.value);
    case 'add-task': return addTaskSheet(el.dataset.day);
    case 'task-filter': state.taskFilter = el.dataset.filter; return render();
    case 'toggle-done': state.showDone = !state.showDone; return render();
    case 'tl-week': return stepWeek(Number(el.dataset.step));
    case 'tl-now': state.tlStart = todayKey(); return render();
    case 'tl-group': {
      const id = el.dataset.id;
      if (state.tlClosed.has(id)) state.tlClosed.delete(id); else state.tlClosed.add(id);
      store.set('pg.tlClosed', JSON.stringify([...state.tlClosed]));
      return render();
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
dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
dialog.addEventListener('close', () => { if (state.dirty) { state.dirty = false; render(); } });

// Swipe left or right on the day view to change day.
let touch = null;
document.addEventListener('touchstart', (ev) => {
  if (!['today', 'timeline'].includes(state.view) || !state.plan || ev.touches.length !== 1) return;
  if (ev.target.closest('.strip, input, textarea, dialog')) return;
  touch = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, t: Date.now() };
}, { passive: true });
document.addEventListener('touchend', (ev) => {
  if (!touch) return;
  const dx = ev.changedTouches[0].clientX - touch.x;
  const dy = ev.changedTouches[0].clientY - touch.y;
  const fast = Date.now() - touch.t < 600;
  touch = null;
  if (!fast || Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
  if (state.view === 'timeline') return stepWeek(dx < 0 ? 1 : -1);
  const days = state.plan.days;
  const i = days.findIndex((d) => d.key === state.day) + (dx < 0 ? 1 : -1);
  if (days[i]) goDay(days[i].key, { fromSwipe: true });
}, { passive: true });

document.addEventListener('keydown', (ev) => {
  if (!state.plan || dialog.open) return;
  if (ev.target.closest('input, textarea')) return;
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  if (state.view === 'timeline') return stepWeek(ev.key === 'ArrowLeft' ? -1 : 1);
  if (state.view !== 'today') return;
  const days = state.plan.days;
  const i = days.findIndex((d) => d.key === state.day) + (ev.key === 'ArrowLeft' ? -1 : 1);
  if (days[i]) goDay(days[i].key);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { flush(); return; }
  if (!state.plan) return;
  if (!api.hasToken()) return renderSignIn('Your session ended. Sign in again to continue.');
  if (Date.now() - state.loadedAt > 120000 && !writes.size && !inflight) refresh();
});

// Show one or two weeks depending on the screen width.
let lastSpan = tlSpan();
window.addEventListener('resize', () => {
  if (tlSpan() === lastSpan) return;
  lastSpan = tlSpan();
  if (state.view === 'timeline' && state.plan) render();
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
