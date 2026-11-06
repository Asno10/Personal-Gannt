// TV view: a read-only, large-screen display of the plan for a TV or any
// spare screen. A clock with a plain-language summary of the day, the next
// exam's countdown, three columns (study, tasks, the week), and across the
// bottom the day drawn as a trajectory from morning to midnight, with the
// day's events plotted on it and a marker where the day stands now. It never
// writes to the sheet or the calendar; the app and the sheet's Apps Script
// do that.
//
// Signing in: like the app, it stays signed in through the sheet's Apps
// Script web app. A TV gets the web app address and key either from one
// normal Google sign-in (then read from the Settings tab), or from the
// pairing link the app makes under Account > Show the plan on a TV
// (tv.html#pair=...), which avoids signing in with a remote. The link is
// removed from the address bar as soon as it is read.
//
// Remote: Up and Down switch night mode (auto, on, off), OK goes fullscreen
// and reloads the plan.

import { CONFIG } from '../config.js';
// The ?v= must match the one calendar.js uses, or the browser loads a second
// copy of sheets.js that has no sign-in token.
import * as api from './sheets.js?v=42';
import * as cal from './calendar.js?v=42';
import { parseItems, keyOfDate, dateOfKey, addDays, toNumber } from './parse.js?v=42';

const BUILD = '42';
const REFRESH_MS = 2 * 60 * 1000;
const CAL_MS = 5 * 60 * 1000;
const EXAM_MIN = 120; // an exam counts as over two hours after it starts
const NIGHT_FROM = 23 * 60; // auto night mode, minutes after midnight
const NIGHT_TO = 7 * 60;
const DAY_FROM = 6 * 60; // the trajectory starts at 06:00 unless something is earlier
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
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

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
  night: store.get('pg.tvNight') || 'auto', // auto | on | off
  minute: '',
};

// ---------- Sign-in ----------

// tv.html#pair=<base64url of {"u": web app address, "k": key}>
// Reads the pairing part of a TV link (the whole link, or just its #pair=...
// part) and saves the address and key. Returns 'none' when there is no
// pairing part, 'ok' when it was saved, or 'bad' when it could not be read.
function pairFrom(text) {
  const m = /[#&]?pair=([\w-]+)/.exec(String(text || ''));
  if (!m) return 'none';
  try {
    const json = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    const { u, k } = JSON.parse(json);
    api.rememberStaySignedIn(u, k);
    return api.canStaySignedIn() ? 'ok' : 'bad';
  } catch {
    return 'bad';
  }
}

function pairFromHash() {
  const result = pairFrom(location.hash);
  if (result !== 'none') history.replaceState(null, '', location.pathname + location.search);
  return result;
}

// Connects with the saved address and key. On failure, says why.
async function connect() {
  loading('Connecting');
  if (await api.ensureToken()) return start();
  if (api.canStaySignedIn()) return gate('Could not reach Google to connect. Check that the TV is online, then try again.', { retry: true });
  gate('That TV link no longer works, probably because app access was reset in the sheet. Copy a new one in the app and paste it here.');
}

// The connect screen. The TV link is pasted into the field (with the Google
// TV app's keyboard on a phone); Google's own sign-in is offered second,
// since TV and kiosk browsers block the pop-up window it needs.
function gate(message = '', { retry = false } = {}) {
  root.innerHTML = `
    ${sky()}
    <main class="gate">
      <h1>Connect this screen</h1>
      <p>In the app on your phone, open <b>Account</b>, choose <b>Show the plan on a TV</b> and tap <b>Copy TV link</b>. Then paste the link here.</p>
      <form class="gate-form" id="pair-form" autocomplete="off">
        <input class="gate-input" id="pair-link" type="text" inputmode="url" spellcheck="false" placeholder="Paste the TV link" aria-label="TV link">
        <button class="gate-btn" type="submit">Connect</button>
      </form>
      ${message ? `<p class="gate-error" role="alert">${esc(message)}</p>` : ''}
      ${retry ? '<button class="gate-btn gate-retry" id="retry" type="button">Try again</button>' : ''}
      <button class="gate-alt" id="sign-in" type="button">Sign in with Google instead</button>
    </main>`;
  const input = $('#pair-link');
  $('#pair-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const result = pairFrom(input.value);
    if (result === 'ok') return connect();
    gate(result === 'none'
      ? 'That is not a TV link. Copy it with Copy TV link in the app; it contains "#pair=".'
      : 'That TV link is incomplete. Copy it again in the app and paste the whole link.');
  });
  $('#sign-in').addEventListener('click', async () => {
    try {
      await api.signIn({ silent: false });
      start();
    } catch (e) {
      const msg = String(e?.message || '');
      gate(/popup|pop-up|closed|did not load/i.test(msg) || !msg
        ? 'Google sign-in needs a pop-up window, which this browser blocks. Paste the TV link above instead.'
        : msg);
    }
  });
  $('#retry')?.addEventListener('click', connect);
  setTimeout(() => ($('#retry') || input).focus(), 50);
}

function loading(text) {
  root.innerHTML = `${sky()}<main class="gate"><p class="gate-loading">${esc(text)}</p></main>`;
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
const colorOf = (name) => { const i = subjectIndex(name); return i >= 0 ? `var(--s${i % 8})` : 'var(--haze)'; };
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
  const add = (time, minutes, end, title, color, kind) => {
    const s = minOf(time);
    const e = end ? minOf(end) : s != null && minutes ? s + minutes : null;
    out.push({ start: s, end: e, title, color, kind });
  };
  for (const e of ofType('event')) if (coversDay(e, k)) add(e.start === k ? e.time : '', e.minutes, '', e.title, 'var(--starlight)', 'event');
  for (const x of P().exams) if (x.start === k) add(x.time, EXAM_MIN, '', x.title || `${x.subject} exam`, colorOf(x.subject), 'exam');
  for (const t of tasksOn(k)) if (t.time && isOpen(t)) add(t.time, t.minutes, '', t.title, 'var(--haze)', 'task');
  for (const r of readingsOn(k)) if (r.time && isOpen(r)) add(r.time, r.minutes, '', r.title, colorOf(r.subject), 'reading');
  for (const c of state.cal.byDay[k] || []) add(c.time, 0, c.endTime, c.title, c.color || 'var(--haze)', 'cal');
  return out.sort((a, b) => (a.start ?? -1) - (b.start ?? -1));
}

// The item happening now, or the next one later today, or tomorrow's first.
function upNext() {
  const now = nowMin();
  const today = agenda(todayKey()).filter((a) => a.start != null);
  const current = today.find((a) => a.start <= now && now < (a.end ?? a.start + 30));
  if (current) return `Now, ${current.end ? `until ${hhmm(current.end)}` : `since ${hhmm(current.start)}`}: ${current.title}.`;
  const later = today.find((a) => a.start > now);
  if (later) {
    const n = later.start - now;
    const soon = n < 60 ? `, in ${plural(n, 'minute')}` : '';
    return `Next at ${hhmm(later.start)}${soon}: ${later.title}.`;
  }
  const tomorrow = agenda(addDays(todayKey(), 1)).find((a) => a.start != null);
  if (tomorrow) return `Nothing else today. Tomorrow at ${hhmm(tomorrow.start)}: ${tomorrow.title}.`;
  return 'Nothing else on the calendar today.';
}

// ---------- Rendering ----------

function isNight() {
  if (state.night === 'on') return true;
  if (state.night === 'off') return false;
  const m = nowMin();
  return m >= NIGHT_FROM || m < NIGHT_TO;
}

// A faint field of stars, the same every time (seeded), drawn once.
let skyHtml = '';
function sky() {
  if (skyHtml) return skyHtml;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const stars = Array.from({ length: 140 }, () => {
    const r = rnd() < 0.85 ? 0.6 + rnd() * 0.6 : 1.2 + rnd() * 0.8;
    return `<circle cx="${(rnd() * 1600).toFixed(1)}" cy="${(rnd() * 900).toFixed(1)}" r="${r.toFixed(2)}" opacity="${(0.15 + rnd() * 0.45).toFixed(2)}"/>`;
  }).join('');
  skyHtml = `<div class="sky" aria-hidden="true"><svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">${stars}</svg></div>`;
  return skyHtml;
}

function render() {
  if (!state.plan) return;
  document.documentElement.classList.toggle('is-night', isNight());
  if (!$('#board')) {
    root.innerHTML = `
      ${sky()}
      <main class="board" id="board">
        <section class="hero" id="hero"></section>
        <section class="col col-exam" id="exam"></section>
        <section class="col col-study" id="study"></section>
        <section class="col col-tasks" id="tasks"></section>
        <section class="col col-week" id="week"></section>
        <section class="day" id="day"></section>
      </main>`;
  }
  state.minute = new Date().toISOString().slice(0, 16);
  put('#hero', renderHero());
  put('#exam', renderExam());
  put('#study', renderStudy(), fitList);
  put('#tasks', renderTasks(), fitList);
  put('#week', renderWeek());
  put('#day', renderDay());
  shiftForBurnIn();
}

// Replaces a section's contents only when they changed, so nothing flickers.
function put(sel, html, after) {
  const el = $(sel);
  if (!el || el._html === html) return;
  el.innerHTML = html;
  el._html = html;
  if (after) after(el);
}

// Hides list rows that do not fit, last first, and says how many are left out.
function fitList(el) {
  const rows = $$('.fit > li', el);
  const more = $('.more', el);
  if (!rows.length || !more) return;
  let hidden = 0;
  for (let i = rows.length - 1; i > 0 && el.scrollHeight > el.clientHeight + 1; i--) {
    rows[i].hidden = true;
    hidden++;
    more.hidden = false;
    more.textContent = `and ${hidden} more`;
  }
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function renderHero() {
  const d = new Date();
  const k = todayKey();
  const total = studyOn(k).reduce((n, s) => n + s.hours, 0);
  const open = [...tasksOn(k), ...readingsOn(k)].filter(isOpen).length;
  const parts = [total ? `${plural(+fmtH(total), 'hour')} of study` : '', open ? plural(open, 'open task') : ''].filter(Boolean);
  const day = parts.length ? `${parts.join(' and ')} today.` : 'A free day.';
  const status = state.error ? `<p class="status">Offline. Showing the plan from ${new Date(state.loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.</p>` : '';
  return `
    <div class="hero-time">
      <p class="date">${esc(d.toLocaleDateString('en-GB', { weekday: 'long' }))}, ${d.getDate()} ${esc(d.toLocaleDateString('en-GB', { month: 'long' }))}</p>
      <p class="clock">${pad(d.getHours())}<span class="colon">:</span>${pad(d.getMinutes())}</p>
    </div>
    <div class="hero-text">
      <p class="summary">${esc(greeting())}. ${esc(day)}</p>
      <p class="summary is-next">${esc(upNext())}</p>
      ${status}
    </div>`;
}

function renderExam() {
  const exams = nextExams();
  if (!exams.length) return `${colHead('Next exam', '')}<p class="empty">No exams ahead.</p>`;
  const k = todayKey();
  const lead = exams[0];
  const n = daysBetween(k, lead.start);
  const studyRow = P().study.find((s) => s.subject === lead.subject);
  const planned = studyRow ? Object.entries(studyRow.cells).filter(([d]) => d <= lead.start).reduce((s, [, v]) => s + toNumber(v), 0) : 0;
  const done = Object.entries(logRow(lead.subject)?.cells || {}).filter(([d]) => d <= lead.start).reduce((s, [, v]) => s + toNumber(v), 0);
  const then = exams[1];
  const when = [n === 0 ? 'Today' : shortDate(lead.start), lead.time].filter(Boolean).join(', ');
  return `
    ${colHead('Next exam', '')}
    <div class="exam-body" style="--c:${colorOf(lead.subject)}">
      <p class="exam-name">${esc(lead.subject || lead.title)}</p>
      <p class="exam-when">${esc(when)}</p>
      <p class="exam-count">${n === 0 ? '<b class="is-word">Today</b>' : `<b>${n}</b><span>${n === 1 ? 'day' : 'days'}</span>`}</p>
      ${planned ? `
        <p class="exam-prep">${fmtH(done)} of ${fmtH(planned)} h prepared</p>
        <p class="sub-bar"><span style="width:${Math.min(100, (done / planned) * 100).toFixed(1)}%"></span></p>` : ''}
      ${then ? `<p class="exam-then">Then ${esc(then.subject || then.title)} in ${plural(daysBetween(k, then.start), 'day')}</p>` : ''}
    </div>`;
}

const colHead = (title, meta) => `<header class="col-head"><h2>${esc(title)}</h2><span>${esc(meta)}</span></header>`;

function renderStudy() {
  const k = todayKey();
  const planned = studyOn(k);
  const extra = P().study.filter((s) => !planned.some((x) => x.item === s) && loggedOn(s.subject, k) > 0).map((item) => ({ item, hours: 0 }));
  const rows = [...planned, ...extra];
  const total = planned.reduce((n, s) => n + s.hours, 0);
  const logged = rows.reduce((n, s) => n + loggedOn(s.item.subject, k), 0);
  return `
    ${colHead('Study', total ? `${fmtH(logged)} of ${fmtH(total)} h` : logged ? `${fmtH(logged)} h` : '')}
    ${rows.length ? `
      <ul class="fit subjects">
        ${rows.map(({ item, hours }) => {
          const l = loggedOn(item.subject, k);
          const pct = hours ? Math.min(100, (l / hours) * 100) : 100;
          return `
            <li style="--c:${colorOf(item.subject)}">
              <p class="sub-line"><span class="sub-name">${esc(item.subject)}</span><span class="sub-h">${l ? `${fmtH(l)} / ` : ''}${fmtH(hours || l)} h</span></p>
              <p class="sub-bar"><span style="width:${pct.toFixed(1)}%"></span></p>
            </li>`;
        }).join('')}
      </ul>` : '<p class="empty">No study planned today.</p>'}
    <p class="more" hidden></p>`;
}

function renderTasks() {
  const k = todayKey();
  const tasks = [...tasksOn(k), ...readingsOn(k)];
  const open = tasks.filter(isOpen);
  const done = tasks.filter((t) => !isOpen(t));
  const overdue = [...ofType('task'), ...ofType('reading')].filter((t) => isOpen(t) && taskDue(t) && taskDue(t) < k && !tasks.includes(t));
  const row = (t, cls, meta) => `
    <li class="${cls}">
      <span class="tick" aria-hidden="true"></span>
      <span class="task-body"><span class="task-title">${esc(t.title)}</span>${meta ? `<span class="task-meta">${meta}</span>` : ''}</span>
    </li>`;
  const metaOf = (t) => [t.time ? esc(t.time) : '', t.type === 'reading' ? 'Reading' : '', t.priority === 'P1' ? '<em>Priority 1</em>' : ''].filter(Boolean).join(', ');
  return `
    ${colHead('Tasks', tasks.length ? `${done.length} of ${tasks.length} done` : '')}
    ${tasks.length || overdue.length ? `
      <ul class="fit tasks">
        ${open.map((t) => row(t, '', metaOf(t))).join('')}
        ${overdue.map((t) => row(t, 'is-late', `Overdue since ${esc(shortDate(taskDue(t)))}`)).join('')}
        ${done.map((t) => row(t, 'is-done', '')).join('')}
      </ul>` : '<p class="empty">Nothing on the list today.</p>'}
    <p class="more" hidden></p>`;
}

function renderWeek() {
  const k = todayKey();
  const days = Array.from({ length: 7 }, (_, i) => addDays(k, i));
  const totals = days.map(studyHoursOn);
  const max = Math.max(1, ...totals);
  const sum = totals.reduce((a, b) => a + b, 0);
  const examDays = new Set(P().exams.map((e) => e.start));
  return `
    ${colHead('This week', sum ? `${fmtH(sum)} h` : '')}
    <div class="week">
      ${days.map((d, i) => {
        const dt = dateOfKey(d);
        return `
          <div class="wk ${i === 0 ? 'is-today' : ''}">
            <span class="wk-h">${totals[i] ? fmtH(totals[i]) : ''}</span>
            <div class="wk-track">
              <div class="wk-bar" style="height:${((totals[i] / max) * 100).toFixed(1)}%">
                ${studyOn(d).map((s) => `<span style="--c:${colorOf(s.item.subject)};flex:${s.hours}"></span>`).join('')}
              </div>
            </div>
            <span class="wk-exam">${examDays.has(d) ? '<i title="Exam"></i>' : ''}</span>
            <span class="wk-day">${esc(dt.toLocaleDateString('en-GB', { weekday: 'narrow' }))}</span>
            <span class="wk-num">${dt.getDate()}</span>
          </div>`;
      }).join('')}
    </div>`;
}

// The day as a trajectory: an arch from morning to midnight. The part already
// flown is drawn solid, the rest dashed; events sit on the arch with their
// time and title, and a glowing marker shows where the day is now.
function renderDay() {
  const el = $('#day');
  const R = remPx();
  const W = Math.max(400, Math.round(el?.clientWidth || 1600));
  const H = Math.max(120, Math.round(el?.clientHeight || 180));
  const k = todayKey();
  const items = agenda(k);
  const timed = items.filter((a) => a.start != null);
  const allDay = items.filter((a) => a.start == null);
  const from = Math.min(DAY_FROM, ...timed.map((a) => Math.floor(a.start / 60) * 60));
  const to = 24 * 60;
  const padX = 1.2 * R;
  const base = H - 2.6 * R; // where the arch meets the hour line
  const amp = base - 7.4 * R; // leaves room above the top for two rows of labels
  const xOf = (m) => padX + ((Math.min(Math.max(m, from), to) - from) / (to - from)) * (W - 2 * padX);
  const yOf = (m) => base - amp * Math.sin(Math.PI * ((Math.min(Math.max(m, from), to) - from) / (to - from)));
  const path = (a, b) => {
    const pts = [];
    for (let m = a; m <= b; m += 5) pts.push(`${xOf(m).toFixed(1)},${yOf(m).toFixed(1)}`);
    pts.push(`${xOf(b).toFixed(1)},${yOf(b).toFixed(1)}`);
    return 'M' + pts.join(' L');
  };
  const now = Math.min(Math.max(nowMin(), from), to);

  const ticks = [];
  for (let h = Math.ceil(from / 60); h <= 24; h++) {
    if (h % 3) continue;
    ticks.push(`<text class="tick-label" x="${xOf(h * 60).toFixed(1)}" y="${(base + 1.9 * R).toFixed(1)}" text-anchor="middle">${pad(h % 24 === 0 && h ? 24 : h)}:00</text>`);
    ticks.push(`<line class="tick" x1="${xOf(h * 60).toFixed(1)}" x2="${xOf(h * 60).toFixed(1)}" y1="${(base + 0.25 * R).toFixed(1)}" y2="${(base + 0.6 * R).toFixed(1)}"/>`);
  }

  // Each label takes the first of three lanes where it does not touch the
  // label before it: just above the arch, inside it, or higher above.
  const charW = 0.55 * 1.5 * R;
  const LANES = [['above', -2.6], ['below', 2.1], ['high', -5.6]];
  const laneEnd = LANES.map(() => -Infinity);
  const marks = timed.map((a) => {
    const x = xOf(a.start);
    const y = yOf(a.start);
    const title = clip(a.title, 26);
    const w = Math.max(5, title.length) * charW;
    const li = LANES.findIndex((_, i) => x - w / 2 > laneEnd[i] + R);
    const side = li < 0 ? 'none' : LANES[li][0];
    if (li >= 0) laneEnd[li] = x + w / 2;
    const past = (a.end ?? a.start + 30) <= nowMin();
    const ty = li < 0 ? 0 : y + LANES[li][1] * R;
    const anchor = x < W * 0.08 ? 'start' : x > W * 0.92 ? 'end' : 'middle';
    return `
      <g class="mark ${past ? 'is-past' : ''}" style="--c:${esc(a.color)}">
        ${a.end ? `<path class="span" d="${path(a.start, Math.min(a.end, to))}"/>` : ''}
        <circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.42 * R).toFixed(1)}"/>
        ${side === 'none' ? '' : `
          <text class="mark-time" x="${x.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}">${hhmm(a.start)}</text>
          <text class="mark-title" x="${x.toFixed(1)}" y="${(ty + 1.55 * R).toFixed(1)}" text-anchor="${anchor}">${esc(title)}</text>`}
      </g>`;
  }).join('');

  const nx = xOf(now);
  const ny = yOf(now);
  return `
    <svg class="arc" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-label="Today from ${hhmm(from)} to midnight">
      <defs>
        <linearGradient id="flown" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" style="stop-color:var(--ember);stop-opacity:0.1"/>
          <stop offset="1" style="stop-color:var(--ember);stop-opacity:0.95"/>
        </linearGradient>
        <radialGradient id="glow">
          <stop offset="0" style="stop-color:var(--ember);stop-opacity:0.5"/>
          <stop offset="1" style="stop-color:var(--ember);stop-opacity:0"/>
        </radialGradient>
      </defs>
      <line class="horizon" x1="${padX}" x2="${W - padX}" y1="${base}" y2="${base}"/>
      ${ticks.join('')}
      <path class="ahead" d="${path(now, to)}"/>
      ${now > from ? `<path class="flown" d="${path(from, now)}"/>` : ''}
      ${marks}
      <circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${(2.4 * R).toFixed(1)}" fill="url(#glow)"/>
      <circle class="now" cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${(0.55 * R).toFixed(1)}"/>
    </svg>
    ${allDay.length ? `<p class="all-day">All day: ${allDay.slice(0, 2).map((a) => esc(clip(a.title, 48))).join(', ')}${allDay.length > 2 ? `, and ${allDay.length - 2} more` : ''}</p>` : ''}
    ${!timed.length ? '<p class="day-empty">No events on the calendar today</p>' : ''}`;
}

// ---------- Screen care ----------

// Moves everything by a few pixels each minute so a TV left on all day does
// not keep the same pixels lit.
const SHIFTS = [[0, 0], [3, 2], [6, 0], [3, -2], [0, -3], [-3, -2], [-6, 0], [-3, 2]];
function shiftForBurnIn() {
  const b = $('#board');
  if (!b) return;
  const [x, y] = SHIFTS[Math.floor(Date.now() / 60000) % SHIFTS.length];
  b.style.transform = `translate(${x}px, ${y}px)`;
}

// Asks the TV not to start its screensaver while this page is showing.
async function keepAwake() {
  try {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    await navigator.wakeLock.request('screen');
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
  if (!state.plan || !$('#board')) return;
  const modes = ['auto', 'on', 'off'];
  switch (ev.key) {
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

// The trajectory is drawn to the screen's size, so it is redrawn on a resize.
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { const d = $('#day'); if (d) d._html = ''; render(); }, 200);
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
  const paired = pairFromHash();
  checkForUpdate();
  if (!api.configured()) return gate('This copy of the app has no Google client ID yet.');
  if (paired === 'bad') return gate('That TV link is incomplete. Copy it again in the app and paste the whole link.');
  if (api.hasToken() || api.canStaySignedIn()) return connect();
  gate();
}

boot();
