// TV view: a read-only, large-screen display of the plan in the style of
// iOS StandBy. A big clock on black, a Today widget (study and tasks) and a
// rotating stack (next exam, the week ahead, the agenda). It never writes to
// the sheet or the calendar; the app and the sheet's Apps Script do that.
//
// Signing in: like the app, it stays signed in through the sheet's Apps
// Script web app. A TV gets the web app address and key either from one
// normal Google sign-in (then read from the Settings tab), or from the
// pairing link the app makes under Account > TV view (tv.html#pair=...),
// which avoids signing in with a remote. The link is removed from the
// address bar as soon as it is read.
//
// Remote: Left and Right turn the stack, Up and Down switch night mode
// (auto, on, off), OK goes fullscreen and reloads the plan.

import { CONFIG } from '../config.js';
// The ?v= must match the one calendar.js uses, or the browser loads a second
// copy of sheets.js that has no sign-in token.
import * as api from './sheets.js?v=39';
import * as cal from './calendar.js?v=39';
import { parseItems, keyOfDate, dateOfKey, addDays, toNumber } from './parse.js?v=39';

const BUILD = '39';
const REFRESH_MS = 2 * 60 * 1000;
const CAL_MS = 5 * 60 * 1000;
const STACK_MS = 14 * 1000;
const EXAM_MIN = 120; // an exam counts as over two hours after it starts
const NIGHT_FROM = 23 * 60; // auto night mode, minutes after midnight
const NIGHT_TO = 7 * 60;
const CAL_HIDE = /#holiday@|classroom/;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtH = (n) => (Math.round(n * 10) / 10).toString();
const todayKey = () => keyOfDate(new Date());
const daysBetween = (a, b) => Math.round((dateOfKey(b) - dateOfKey(a)) / 86400000);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (k) => { const d = dateOfKey(k); return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${d.getDate()} ${MON[d.getMonth()]}`; };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const pad = (n) => String(n).padStart(2, '0');
const minOf = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
const hhmm = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const root = $('#tv');
const state = {
  plan: null,
  loadedAt: 0,
  error: '',
  cal: { calendars: [], byDay: {}, at: 0 },
  stack: 0,
  night: store.get('pg.tvNight') || 'auto', // auto | on | off
  minute: '',
};

// ---------- Sign-in ----------

// tv.html#pair=<base64url of {"u": web app address, "k": key}>
function pairFromHash() {
  const m = /[#&]pair=([\w-]+)/.exec(location.hash);
  if (!m) return;
  try {
    const json = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    const { u, k } = JSON.parse(json);
    api.rememberStaySignedIn(u, k);
  } catch {}
  history.replaceState(null, '', location.pathname + location.search);
}

function gate(message = '') {
  root.innerHTML = `
    <main class="gate">
      <div class="gate-card">
        <img class="gate-icon" src="icon-192.png" alt="">
        <h1>Personal Gantt</h1>
        <p>This screen shows your plan once it is connected. In the app on your phone, open <b>Account</b>, then <b>TV view</b>, copy the TV link and open it in this browser. Or sign in with Google here.</p>
        ${message ? `<p class="gate-error" role="alert">${esc(message)}</p>` : ''}
        <button class="gate-btn" id="sign-in" autofocus>Sign in with Google</button>
      </div>
    </main>`;
  const b = $('#sign-in');
  b.addEventListener('click', async () => {
    try {
      await api.signIn({ silent: false });
      start();
    } catch (e) {
      gate(e.message);
    }
  });
  setTimeout(() => b.focus(), 50);
}

function loading(text) {
  root.innerHTML = `<main class="gate"><p class="gate-loading">${esc(text)}</p></main>`;
}

// ---------- Data ----------

let started = false;

async function start() {
  loading('Loading the plan');
  await refresh();
  if (started) return;
  started = true;
  setInterval(tick, 1000);
  setInterval(() => refresh(), REFRESH_MS);
  setInterval(() => loadCalendar(), CAL_MS);
  setInterval(() => turnStack(1), STACK_MS);
  setInterval(checkForUpdate, 30 * 60 * 1000);
  keepAwake();
}

async function refresh() {
  try {
    const raw = await api.loadAll();
    const get = (k) => (raw.settings || []).find((r) => String(r?.[0] || '').trim() === k)?.[1];
    api.rememberStaySignedIn(get('app_token_url'), get('app_token_key'));
    state.plan = parseItems(raw.items, raw.settings, todayKey());
    state.loadedAt = Date.now();
    state.error = '';
    render();
    loadCalendar();
  } catch (e) {
    if (e instanceof api.AuthError) { started = false; return gate('The session ended. Connect this screen again.'); }
    state.error = e.message || 'Could not load the plan.';
    if (state.plan) render();
    else gate(state.error);
  }
}

// Events from the person's other calendars for today and the week ahead.
// The Personal Gantt calendar is left out: its contents come from the sheet.
async function loadCalendar() {
  const c = state.cal;
  if (!state.plan || !api.hasCalendarScope()) return;
  try {
    if (!c.calendars.length) c.calendars = await cal.listCalendars();
    const pgId = state.plan.settings.calendar_id?.value || '';
    const list = c.calendars.filter((x) => x.id !== pgId && x.name !== CONFIG.calendarName && !CAL_HIDE.test(x.id) && !/irec/i.test(x.name || ''));
    const from = todayKey();
    const to = addDays(from, 7);
    const byDay = {};
    await Promise.all(list.map(async (cl) => {
      const evs = await cal.listEvents(cl.id, from, to);
      for (const ev of evs) for (const d of cal.toDayEvents(ev, cl)) (byDay[d.key] ||= []).push(d);
    }));
    c.byDay = byDay;
    c.at = Date.now();
    render();
  } catch {}
}

// ---------- Queries (the same rules as the app) ----------

const P = () => state.plan;
const ofType = (t) => P().byType(t);
const subjectIndex = (name) => P().study.map((s) => s.subject).indexOf(name);
const colorOf = (name) => { const i = subjectIndex(name); return i >= 0 ? `var(--s${i % 8})` : 'var(--accent)'; };
const plannedDays = (t) => Object.entries(t.cells).filter(([, v]) => /x/i.test(v)).map(([d]) => d).sort();
const taskDue = (t) => plannedDays(t)[0] || t.start || null;
const tasksOn = (k) => ofType('task').filter((t) => (plannedDays(t).length ? plannedDays(t).includes(k) : t.start === k));
const readingsOn = (k) => ofType('reading').filter((r) => r.start === k);
const isOpen = (t) => t.status.status === 'open';
const coversDay = (item, k) => (item.cells[k] ? true : item.start && item.end ? item.start <= k && k <= item.end : item.start === k);
const logRow = (subject) => (P().logs || []).find((l) => l.subject === subject);
const loggedOn = (subject, k) => toNumber(logRow(subject)?.cells[k]);
const studyOn = (k) => P().study.map((s) => ({ item: s, hours: toNumber(s.cells[k]) })).filter((x) => x.hours > 0);
const studyHoursOn = (k) => P().study.reduce((n, s) => n + toNumber(s.cells[k]), 0);

function examEndsAt(e) {
  const d = dateOfKey(e.start);
  if (!e.time) { d.setDate(d.getDate() + 1); return d.getTime(); }
  const [h, m] = e.time.split(':').map(Number);
  d.setHours(h, m + EXAM_MIN, 0, 0);
  return d.getTime();
}
const nextExams = () => P().exams.filter((e) => e.start && Date.now() < examEndsAt(e)).sort((a, b) => (a.start + a.time).localeCompare(b.start + b.time));

// Everything on a day that has a time or fills the day: events, exams, timed
// tasks and readings, and the other calendars.
function agenda(k) {
  const out = [];
  const add = (time, minutes, end, title, sub, color, kind) => {
    const s = minOf(time);
    const e = end ? minOf(end) : s != null && minutes ? s + minutes : null;
    out.push({ start: s, end: e, title, sub, color, kind });
  };
  for (const e of ofType('event')) if (coversDay(e, k)) add(e.start === k ? e.time : '', e.minutes, '', e.title, e.subject || 'Event', e.subject ? colorOf(e.subject) : 'var(--accent)', 'event');
  for (const x of P().exams) if (x.start === k) add(x.time, EXAM_MIN, '', x.title || `${x.subject} exam`, x.title && x.subject ? `Exam, ${x.subject}` : 'Exam', colorOf(x.subject), 'exam');
  for (const t of tasksOn(k)) if (t.time && isOpen(t)) add(t.time, t.minutes, '', t.title, 'Task', 'var(--ink-2)', 'task');
  for (const r of readingsOn(k)) if (r.time && isOpen(r)) add(r.time, r.minutes, '', r.title, 'Reading', colorOf(r.subject), 'reading');
  for (const c of state.cal.byDay[k] || []) add(c.time, 0, c.endTime, c.title, c.calName, c.color || 'var(--ink-3)', 'cal');
  return out.sort((a, b) => (a.start ?? -1) - (b.start ?? -1));
}

// The item happening now, or the next one later today, or tomorrow's first.
function upNext() {
  const now = nowMin();
  const today = agenda(todayKey()).filter((a) => a.start != null);
  const current = today.find((a) => a.start <= now && now < (a.end ?? a.start + 30));
  if (current) return { ...current, when: 'Now', detail: current.end ? `until ${hhmm(current.end)}` : '' };
  const later = today.find((a) => a.start > now);
  if (later) {
    const n = later.start - now;
    return { ...later, when: hhmm(later.start), detail: n < 60 ? `in ${plural(n, 'minute')}` : n < 180 ? `in ${Math.floor(n / 60)} h ${n % 60 ? `${n % 60} min` : ''}`.trim() : '' };
  }
  const tomorrow = agenda(addDays(todayKey(), 1)).find((a) => a.start != null);
  if (tomorrow) return { ...tomorrow, when: `Tomorrow ${hhmm(tomorrow.start)}`, detail: '' };
  return null;
}

// ---------- Rendering ----------

function isNight() {
  if (state.night === 'on') return true;
  if (state.night === 'off') return false;
  const m = nowMin();
  return m >= NIGHT_FROM || m < NIGHT_TO;
}

function render() {
  if (!state.plan) return;
  document.documentElement.classList.toggle('is-night', isNight());
  if (!$('#sb')) {
    root.innerHTML = `
      <main class="sb" id="sb">
        <section class="col-clock" id="w-clock"></section>
        <section class="widget w-today" id="w-today"></section>
        <section class="widget w-stack" id="w-stack">
          <div class="stack-pages" id="stack-pages"></div>
          <div class="stack-dots" id="stack-dots" aria-hidden="true"></div>
        </section>
      </main>`;
  }
  state.minute = new Date().toISOString().slice(0, 16);
  put('#w-clock', renderClock());
  put('#w-today', renderToday(), fitToday);
  renderStack();
  shiftForBurnIn();
}

// Replaces a widget's contents only when they changed, so nothing flickers.
function put(sel, html, after) {
  const el = $(sel);
  if (!el || el._html === html) return;
  el.innerHTML = html;
  el._html = html;
  if (after) after(el);
}

function renderClock() {
  const d = new Date();
  const next = upNext();
  const k = todayKey();
  const ex = ofType('exercise').filter((e) => e.cells[k]).map((e) => String(e.cells[k]));
  const EX = { A: 'Workout A', B: 'Workout B', L: 'Light workout', W: 'Weigh-in' };
  const status = state.error
    ? `<span class="is-alert">Offline</span>, showing the plan from ${hhmm(new Date(state.loadedAt).getHours() * 60 + new Date(state.loadedAt).getMinutes())}`
    : '';
  return `
    <p class="clk-date"><span class="clk-dow">${esc(d.toLocaleDateString('en-GB', { weekday: 'long' }))}</span> ${d.getDate()} ${esc(d.toLocaleDateString('en-GB', { month: 'long' }))}</p>
    <p class="clk-time" aria-label="${hhmm(nowMin())}">${pad(d.getHours())}<span class="clk-colon">:</span>${pad(d.getMinutes())}</p>
    ${next ? `
      <div class="next" style="--c:${esc(next.color)}">
        <span class="next-bar"></span>
        <div class="next-body">
          <p class="next-when">${esc(next.when)}${next.detail ? `<span>${esc(next.detail)}</span>` : ''}</p>
          <p class="next-title">${esc(next.title)}</p>
        </div>
      </div>` : `<div class="next is-empty"><p class="next-title">Nothing else on the calendar today</p></div>`}
    ${ex.length ? `<p class="clk-chips">${ex.map((v) => `<span class="chip">${esc(EX[v.toUpperCase()] || v)}</span>`).join('')}</p>` : ''}
    ${status ? `<p class="clk-status">${status}</p>` : ''}`;
}

function ring(frac, label) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, frac));
  return `
    <div class="ring ${f >= 1 ? 'is-full' : ''}">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="ring-track" cx="50" cy="50" r="${r}"/>
        <circle class="ring-fill" cx="50" cy="50" r="${r}" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 50 50)"/>
      </svg>
      <span class="ring-label">${label}</span>
    </div>`;
}

function renderToday() {
  const k = todayKey();
  const planned = studyOn(k);
  const extra = P().study.filter((s) => !planned.some((x) => x.item === s) && loggedOn(s.subject, k) > 0).map((item) => ({ item, hours: 0 }));
  const study = [...planned, ...extra];
  const total = planned.reduce((n, s) => n + s.hours, 0);
  const logged = study.reduce((n, s) => n + loggedOn(s.item.subject, k), 0);

  const tasks = [...tasksOn(k), ...readingsOn(k)];
  const open = tasks.filter(isOpen);
  const done = tasks.filter((t) => !isOpen(t));
  const overdue = [...ofType('task'), ...ofType('reading')].filter((t) => isOpen(t) && taskDue(t) && taskDue(t) < k && !tasks.includes(t));
  const taskLine = (t, cls, meta) => `
    <li class="task ${cls}">
      <span class="tick" aria-hidden="true"></span>
      <span class="task-title">${esc(t.title)}</span>
      ${meta ? `<span class="task-meta">${esc(meta)}</span>` : ''}
    </li>`;
  const metaOf = (t) => [t.time, t.type === 'reading' ? 'Reading' : '', t.priority === 'P1' ? 'P1' : ''].filter(Boolean).join(', ');

  return `
    <header class="w-head">
      <div>
        <p class="w-label">Today</p>
        <p class="w-title is-big">${total ? `${fmtH(total)}<small> h</small>` : logged ? `${fmtH(logged)}<small> h</small>` : 'Free'}</p>
        <p class="w-sub">${total ? `planned<br>${fmtH(logged)} h studied` : logged ? 'studied' : open.length ? 'No study planned' : 'Rest well'}</p>
      </div>
      ${total ? ring(logged / total, logged >= total ? '<b>Done</b>' : `<b>${Math.round((logged / total) * 100)}</b><small>%</small>`) : ''}
    </header>
    ${study.length ? `
      <ul class="study">
        ${study.map(({ item, hours }) => {
          const l = loggedOn(item.subject, k);
          const pct = hours ? Math.min(100, (l / hours) * 100) : 100;
          return `
            <li style="--c:${colorOf(item.subject)}">
              <div class="study-top"><span class="dot"></span><span class="study-name">${esc(item.subject)}</span><span class="study-h">${l ? `${fmtH(l)}<small> / </small>` : ''}${fmtH(hours || l)}<small> h</small></span></div>
              <div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div>
            </li>`;
        }).join('')}
      </ul>` : ''}
    <div class="tasks-wrap">
      <p class="w-section">Tasks<span>${tasks.length ? `${done.length} of ${tasks.length} done` : 'None planned'}</span></p>
      <ul class="tasks" id="task-list">
        ${open.map((t) => taskLine(t, '', metaOf(t))).join('')}
        ${overdue.map((t) => taskLine(t, 'is-late', `Overdue, ${shortDate(taskDue(t))}`)).join('')}
        ${done.map((t) => taskLine(t, 'is-done', '')).join('')}
        ${!tasks.length && !overdue.length ? '<li class="task is-empty"><span class="task-title">Nothing on the list for today</span></li>' : ''}
      </ul>
      <p class="more" id="task-more" hidden></p>
    </div>`;
}

// Hides task rows that do not fit, last first, and says how many are left out.
function fitToday(el) {
  const list = $('#task-list', el);
  const more = $('#task-more', el);
  const wrap = $('.tasks-wrap', el);
  if (!list || !wrap) return;
  const rows = $$('.task', list);
  let hidden = 0;
  const over = () => el.scrollHeight > el.clientHeight + 1;
  for (let i = rows.length - 1; i > 0 && over(); i--) {
    rows[i].hidden = true;
    hidden++;
    more.hidden = false;
    more.textContent = `and ${hidden} more`;
  }
}

function stackPages() {
  const pages = [];
  const exams = nextExams();
  if (exams.length) pages.push(['exam', renderExamPage(exams)]);
  pages.push(['week', renderWeekPage()]);
  pages.push(['agenda', renderAgendaPage()]);
  return pages;
}

function renderStack() {
  const pages = stackPages();
  const box = $('#stack-pages');
  const sig = pages.map(([, h]) => h).join('');
  if (box._html !== sig) {
    box.innerHTML = pages.map(([key, html], i) => `<div class="page page-${key}" data-i="${i}">${html}</div>`).join('');
    box._html = sig;
    $('#stack-dots').innerHTML = pages.map((_, i) => `<i data-i="${i}"></i>`).join('');
  }
  state.stack = ((state.stack % pages.length) + pages.length) % pages.length;
  $$('.page', box).forEach((p) => p.classList.toggle('is-on', +p.dataset.i === state.stack));
  $$('#stack-dots i').forEach((d) => d.classList.toggle('is-on', +d.dataset.i === state.stack));
}

function turnStack(dir) {
  if (!$('#stack-pages')) return;
  state.stack += dir;
  renderStack();
}

function renderExamPage(exams) {
  const k = todayKey();
  const lead = exams[0];
  const n = daysBetween(k, lead.start);
  const studyRow = P().study.find((s) => s.subject === lead.subject);
  const plannedPrep = studyRow ? Object.entries(studyRow.cells).filter(([d]) => d <= lead.start).reduce((s, [, v]) => s + toNumber(v), 0) : 0;
  const loggedPrep = Object.entries(logRow(lead.subject)?.cells || {}).filter(([d]) => d <= lead.start).reduce((s, [, v]) => s + toNumber(v), 0);
  const left = (e) => { const d = daysBetween(k, e.start); return d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `${d} days`; };
  const later = exams.slice(1, 4);
  return `
    <p class="w-label is-signal">${n === 0 ? 'Exam today' : 'Next exam'}</p>
    <div class="exam-lead" style="--c:${colorOf(lead.subject)}">
      <p class="exam-subject">${esc(lead.subject || lead.title)}</p>
      <p class="exam-when">${esc([n === 0 ? 'Today' : shortDate(lead.start), lead.time].filter(Boolean).join(', '))}</p>
    </div>
    <p class="countdown">${n === 0 ? `<b class="is-word">${lead.time ? esc(lead.time) : 'Today'}</b>` : `<b>${n}</b><small>${n === 1 ? 'day' : 'days'}</small>`}</p>
    ${plannedPrep ? `
      <div class="prep">
        <p><span>Preparation</span><b>${fmtH(loggedPrep)} of ${fmtH(plannedPrep)} h</b></p>
        <div class="bar" style="--c:${colorOf(lead.subject)}"><span style="width:${Math.min(100, (loggedPrep / plannedPrep) * 100).toFixed(1)}%"></span></div>
      </div>` : ''}
    ${later.length ? `
      <ul class="later">
        ${later.map((e) => `<li style="--c:${colorOf(e.subject)}"><span class="dot"></span><span class="later-name">${esc(e.subject || e.title)}</span><span class="later-in">${esc(left(e))}</span></li>`).join('')}
      </ul>` : ''}`;
}

function renderWeekPage() {
  const k = todayKey();
  const days = Array.from({ length: 7 }, (_, i) => addDays(k, i));
  const totals = days.map(studyHoursOn);
  const max = Math.max(1, ...totals);
  const sum = totals.reduce((a, b) => a + b, 0);
  const examDays = new Map(P().exams.map((e) => [e.start, e]));
  const openTasks = days.reduce((n, d) => n + tasksOn(d).filter(isOpen).length, 0);
  const examsAhead = days.filter((d) => examDays.has(d)).length;
  return `
    <p class="w-label">The week ahead</p>
    <p class="w-title">${sum ? `${fmtH(sum)} h of study` : 'No study planned'}</p>
    <p class="w-sub">${[plural(openTasks, 'open task'), examsAhead ? plural(examsAhead, 'exam') : ''].filter(Boolean).join(', ')}</p>
    <div class="week">
      ${days.map((d, i) => {
        const segs = studyOn(d);
        const ex = examDays.get(d);
        const dt = dateOfKey(d);
        return `
          <div class="wk-day ${i === 0 ? 'is-today' : ''} ${dt.getDay() % 6 === 0 ? 'is-weekend' : ''}">
            <span class="wk-h">${totals[i] ? fmtH(totals[i]) : ''}</span>
            <div class="wk-col">
              <div class="wk-stack" style="height:${((totals[i] / max) * 100).toFixed(1)}%">
                ${segs.map((s) => `<span style="--c:${colorOf(s.item.subject)};flex:${s.hours}"></span>`).join('')}
              </div>
            </div>
            <span class="wk-exam">${ex ? `<i style="--c:${colorOf(ex.subject)}"></i>` : ''}</span>
            <span class="wk-dow">${esc(dt.toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 2))}</span>
            <span class="wk-num">${dt.getDate()}</span>
          </div>`;
      }).join('')}
    </div>`;
}

function renderAgendaPage() {
  const k = todayKey();
  const now = nowMin();
  const today = agenda(k).filter((a) => a.start == null || (a.end ?? a.start + 30) > now);
  const tomorrow = agenda(addDays(k, 1));
  const row = (a) => `
    <li style="--c:${esc(a.color)}">
      <span class="ag-time">${a.start == null ? 'All day' : hhmm(a.start)}</span>
      <span class="ag-bar"></span>
      <span class="ag-body"><span class="ag-title">${esc(a.title)}</span>${a.sub ? `<span class="ag-sub">${esc(a.sub)}</span>` : ''}</span>
    </li>`;
  const block = (label, list, limit) => `
    <p class="w-section">${label}<span>${list.length ? plural(list.length, 'item') : ''}</span></p>
    ${list.length ? `<ul class="agenda">${list.slice(0, limit).map(row).join('')}</ul>${list.length > limit ? `<p class="more">and ${list.length - limit} more</p>` : ''}` : '<p class="ag-empty">Nothing scheduled</p>'}`;
  return `
    <p class="w-label">Agenda</p>
    ${block('Rest of today', today, 4)}
    ${block('Tomorrow', tomorrow, 3)}`;
}

// ---------- Screen care ----------

// Moves everything by a few pixels each minute so a TV left on all day does
// not keep the same pixels lit (as StandBy does).
const SHIFTS = [[0, 0], [3, 2], [6, 0], [3, -2], [0, -3], [-3, -2], [-6, 0], [-3, 2]];
function shiftForBurnIn() {
  const sb = $('#sb');
  if (!sb) return;
  const [x, y] = SHIFTS[Math.floor(Date.now() / 60000) % SHIFTS.length];
  sb.style.transform = `translate(${x}px, ${y}px)`;
}

// Asks the TV not to start its screensaver while this page is showing.
let wakeLock = null;
async function keepAwake() {
  try {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener?.('release', () => { wakeLock = null; });
  } catch {}
}

// ---------- Clock, keys and updates ----------

function tick() {
  if (!state.plan) return;
  const m = new Date().toISOString().slice(0, 16);
  if (m !== state.minute) render();
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#tv-toast');
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), 2200);
}

function setNight(mode) {
  state.night = mode;
  store.set('pg.tvNight', mode);
  render();
  toast(mode === 'auto' ? 'Night mode: automatic, 23:00 to 07:00' : mode === 'on' ? 'Night mode: on' : 'Night mode: off');
}

document.addEventListener('keydown', (ev) => {
  if (!state.plan || !$('#sb')) return;
  const modes = ['auto', 'on', 'off'];
  switch (ev.key) {
    case 'ArrowLeft': ev.preventDefault(); return turnStack(-1);
    case 'ArrowRight': ev.preventDefault(); return turnStack(1);
    case 'ArrowUp': ev.preventDefault(); return setNight(modes[(modes.indexOf(state.night) + 1) % 3]);
    case 'ArrowDown': ev.preventDefault(); return setNight(modes[(modes.indexOf(state.night) + 2) % 3]);
    case 'Enter':
    case ' ':
      ev.preventDefault();
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
      toast('Reloading the plan');
      return refresh();
  }
});

// A tap or click on a touch screen turns the stack, like a swipe on StandBy.
document.addEventListener('click', (ev) => {
  if (ev.target.closest('#w-stack')) turnStack(1);
});

// The pointer hides itself after a few still seconds.
let pointerTimer = 0;
document.addEventListener('mousemove', () => {
  document.documentElement.classList.remove('hide-pointer');
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => document.documentElement.classList.add('hide-pointer'), 3000);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.plan) return;
  keepAwake();
  checkForUpdate();
  if (Date.now() - state.loadedAt > 60000) refresh();
});

async function checkForUpdate() {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { v } = await res.json();
    if (!v || v === BUILD) { sessionStorage.removeItem('pg.tvUpdating'); return; }
    if (sessionStorage.getItem('pg.tvUpdating') === v) return;
    sessionStorage.setItem('pg.tvUpdating', v);
    location.replace(`tv.html?v=${encodeURIComponent(v)}`);
  } catch {}
}

// ---------- Boot ----------

async function boot() {
  const night = new URLSearchParams(location.search).get('night');
  if (['auto', 'on', 'off'].includes(night)) { state.night = night; store.set('pg.tvNight', night); }
  document.documentElement.classList.toggle('is-night', isNight());
  pairFromHash();
  checkForUpdate();
  if (!api.configured()) return gate('This copy of the app has no Google client ID yet.');
  if (api.hasToken() || api.canStaySignedIn()) {
    loading('Connecting');
    if (await api.ensureToken()) return start();
  }
  gate();
}

boot();
