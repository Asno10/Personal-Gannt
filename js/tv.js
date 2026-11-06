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
// Pages: Left and Right switch between the day and the plan for the next two
// weeks (a Gantt chart); it returns to the day after 5 idle minutes.
// Night mode is automatic (22:30 to 07:00). Up turns it on or off until the
// next automatic switch, Down goes back to automatic. OK goes fullscreen and
// reloads the plan.

import { CONFIG } from '../config.js';
// The ?v= must match the one calendar.js uses, or the browser loads a second
// copy of sheets.js that has no sign-in token.
import * as api from './sheets.js?v=47';
import * as cal from './calendar.js?v=47';
import { parseItems, keyOfDate, dateOfKey, addDays, toNumber } from './parse.js?v=47';
import { initSky, setPlace, weatherLine, placeName } from './sky.js?v=47';

const BUILD = '47';
const REFRESH_MS = 2 * 60 * 1000;
const CAL_MS = 5 * 60 * 1000;
const EXAM_MIN = 120; // an exam counts as over two hours after it starts
const NIGHT_FROM = 22 * 60 + 30; // automatic night mode, minutes after midnight
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
  night: null, // a manual override { on, until }, or null for automatic
  page: 0,
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
  if (api.canStaySignedIn()) {
    const detail = await diagnose();
    if (detail === 'ok' && (await api.ensureToken())) return start();
    return gate('The TV could not get access from your sheet\'s Apps Script.', { retry: true, detail: detail === 'ok' ? '' : detail });
  }
  gate('That TV link no longer works, probably because app access was reset in the sheet. Copy a new one in the app and paste it here.');
}

// Repeats the access request to say why it failed, in words that point at
// the cause. Returns 'ok' if it worked this time.
async function diagnose() {
  const link = api.stayLink();
  if (!link) return '';
  try {
    const res = await fetch(`${link.url}?key=${encodeURIComponent(link.key)}&t=${Date.now()}`, { cache: 'no-store', redirect: 'follow' });
    const text = await res.text();
    if (/^\s*</.test(text)) return `Details: the web app answered with a web page (HTTP ${res.status}) instead of a token. It is probably not set to Who has access: Anyone.`;
    if (!res.ok) return `Details: the web app answered HTTP ${res.status}.`;
    try {
      const body = JSON.parse(text);
      if (body.token) return 'ok';
      if (body.error) return `Details: the web app answered "${body.error}".`;
    } catch {}
    return `Details: unexpected answer from the web app: ${text.slice(0, 80)}`;
  } catch (e) {
    return `Details: the request was blocked before any answer arrived (${e?.message || e?.name || 'no reason given'}). This happens when the web app asks for a Google sign-in first, or when the network or browser blocks script.google.com.`;
  }
}

// The connect screen. The TV link is pasted into the field (with the Google
// TV app's keyboard on a phone); Google's own sign-in is offered second,
// since TV and kiosk browsers block the pop-up window it needs.
function gate(message = '', { retry = false, detail = '' } = {}) {
  root.innerHTML = `
    <main class="gate">
      <h1>Connect this screen</h1>
      <p>In the app on your phone, open <b>Account</b>, choose <b>Show the plan on a TV</b> and tap <b>Copy TV link</b>. Then paste the link here.</p>
      <form class="gate-form" id="pair-form" autocomplete="off">
        <input class="gate-input" id="pair-link" type="text" inputmode="url" spellcheck="false" placeholder="Paste the TV link" aria-label="TV link">
        <button class="gate-btn" type="submit">Connect</button>
      </form>
      ${message ? `<p class="gate-error" role="alert">${esc(message)}</p>` : ''}
      ${detail ? `<p class="gate-detail">${esc(detail)}</p>` : ''}
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
  setInterval(checkForUpdate, 30 * 60 * 1000);
  keepAwake();
}

async function refresh() {
  try {
    const raw = await api.loadAll();
    const get = (k) => (raw.settings || []).find((r) => String(r?.[0] || '').trim() === k)?.[1];
    api.rememberStaySignedIn(get('app_token_url'), get('app_token_key'));
    state.plan = parseItems(raw.items, raw.settings, todayKey());
    setPlace(urlPlace || state.plan.settings.tv_location?.value || '');
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

// An event's colour: its subject's, when it has one or is a study block
// named after a subject ("Study: YDS, reading"); otherwise white.
function eventColor(e) {
  const named = /^study:\s*(.+)$/i.exec(e.title || '')?.[1] || '';
  const subject = P().study.map((x) => x.subject).find((n) => n === e.subject || (named && named.startsWith(n)));
  return subject ? colorOf(subject) : 'var(--starlight)';
}

// Everything on a day that has a time or fills the day: events, exams, timed
// tasks and readings, and the other calendars.
function agenda(k) {
  const out = [];
  const add = (time, minutes, end, title, color, kind) => {
    const s = minOf(time);
    const e = end ? minOf(end) : s != null && minutes ? s + minutes : null;
    out.push({ start: s, end: e, title, color, kind });
  };
  for (const e of ofType('event')) if (coversDay(e, k)) add(e.start === k ? e.time : '', e.minutes, '', e.title, eventColor(e), 'event');
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

const autoNight = (d = new Date()) => { const m = d.getHours() * 60 + d.getMinutes(); return m >= NIGHT_FROM || m < NIGHT_TO; };

// The next time automatic night mode switches on or off.
function nextSwitch() {
  const now = new Date();
  const at = (days, min) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(Math.floor(min / 60), min % 60, 0, 0); return d.getTime(); };
  return [at(0, NIGHT_TO), at(0, NIGHT_FROM), at(1, NIGHT_TO)].find((t) => t > now.getTime());
}

function isNight() {
  if (state.night && Date.now() < state.night.until) return state.night.on;
  state.night = null;
  return autoNight();
}

function render() {
  if (!state.plan) return;
  document.documentElement.classList.toggle('is-night', isNight());
  if (!$('#board')) {
    root.innerHTML = `
      <div class="pages" id="pages">
        <main class="page board" id="board">
        <section class="hero" id="hero"></section>
        <section class="col col-exam" id="exam"></section>
        <section class="col col-study" id="study"></section>
        <section class="col col-tasks" id="tasks"></section>
        <section class="col col-week" id="week"></section>
        <section class="day" id="day"></section>
        </main>
        <main class="page plan" id="plan"></main>
      </div>
      <p class="page-dots" id="page-dots" aria-hidden="true"><i></i><i></i></p>`;
    showPage(state.page, false);
  }
  state.minute = new Date().toISOString().slice(0, 16);
  put('#hero', renderHero());
  put('#exam', renderExam());
  put('#study', renderStudy(), fitList);
  put('#tasks', renderTasks(), fitList);
  put('#week', renderWeek());
  put('#day', renderDay());
  put('#plan', renderPlan());
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
  const w = weatherLine();
  const weather = w ? `${w.replace(/^(-?\d+°), /, '$1 and ')}${placeName() ? ` in ${placeName()}` : ''}.` : '';
  const status = state.error ? `<p class="status">Offline. Showing the plan from ${new Date(state.loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.</p>` : '';
  return `
    <div class="hero-time">
      <p class="date">${esc(d.toLocaleDateString('en-GB', { weekday: 'long' }))}, ${d.getDate()} ${esc(d.toLocaleDateString('en-GB', { month: 'long' }))}</p>
      <p class="clock">${pad(d.getHours())}<span class="colon">:</span>${pad(d.getMinutes())}</p>
    </div>
    <div class="hero-text">
      <p class="summary">${esc(greeting())}.${weather ? ` ${esc(weather)}` : ''}</p>
      <p class="summary is-sub">${esc(day)}</p>
      <p class="summary is-sub">${esc(upNext())}</p>
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
  // The legend: each subject planned this week, in the sheet's order, and the
  // exam marker when an exam falls in the week.
  const subjects = P().study.filter((s) => days.some((d) => toNumber(s.cells[d]) > 0));
  const hasExam = days.some((d) => examDays.has(d));
  return `
    ${colHead('This week', sum ? `${fmtH(sum)} h` : '')}
    <div class="week">
      ${days.map((d, i) => {
        const dt = dateOfKey(d);
        return `
          <div class="wk ${i === 0 ? 'is-today' : ''}">
            <span class="wk-h">${totals[i] ? fmtH(totals[i]) : ''}${examDays.has(d) ? '<i class="wk-ex" title="Exam"></i>' : ''}</span>
            <div class="wk-track">
              <div class="wk-bar" style="height:${((totals[i] / max) * 100).toFixed(1)}%">
                ${studyOn(d).map((s) => `<span style="--c:${colorOf(s.item.subject)};flex:${s.hours}"></span>`).join('')}
              </div>
            </div>
            <span class="wk-day">${esc(dt.toLocaleDateString('en-GB', { weekday: 'narrow' }))}</span>
          </div>`;
      }).join('')}
    </div>
    ${subjects.length || hasExam ? `
      <ul class="legend">
        ${subjects.map((x) => `<li style="--c:${colorOf(x.subject)}"><i></i>${esc(x.subject)}</li>`).join('')}
        ${hasExam ? '<li class="is-exam"><i></i>Exam</li>' : ''}
      </ul>` : ''}`;
}

// ---------- The plan page: a Gantt chart of the next two weeks ----------

const PLAN_DAYS = 14;
const LABEL_REM = 21;
const EX_NAMES = { A: 'A', B: 'B', L: 'Light', W: 'Weigh-in' };
let measureCtx = null;
function textWidth(text, weight, sizePx) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  const family = getComputedStyle(document.documentElement).getPropertyValue('--sans') || 'sans-serif';
  measureCtx.font = `${weight} ${sizePx}px ${family}`;
  return measureCtx.measureText(text).width;
}

function renderPlan() {
  const R = remPx();
  const k = todayKey();
  const days = Array.from({ length: PLAN_DAYS }, (_, i) => addDays(k, i));
  const last = days[PLAN_DAYS - 1];
  const idx = (d) => (d < k ? 0 : d > last ? PLAN_DAYS - 1 : days.indexOf(d));
  const pct = (n) => `${((n / PLAN_DAYS) * 100).toFixed(3)}%`;
  const d0 = dateOfKey(k);
  const d1 = dateOfKey(last);
  const monthLong = (d) => d.toLocaleDateString('en-GB', { month: 'long' });
  const range = d0.getMonth() === d1.getMonth()
    ? `${d0.getDate()} to ${d1.getDate()} ${monthLong(d1)}`
    : `${d0.getDate()} ${monthLong(d0)} to ${d1.getDate()} ${monthLong(d1)}`;
  const trackW = window.innerWidth - 2 * 4.6 * R - LABEL_REM * R;
  const dayW = trackW / PLAN_DAYS;

  const head = days.map((d, i) => {
    const dt = dateOfKey(d);
    return `<span class="g-day ${i === 0 ? 'is-today' : ''} ${dt.getDay() % 6 === 0 ? 'is-weekend' : ''}"><b>${esc(dt.toLocaleDateString('en-GB', { weekday: 'narrow' }))}</b><span>${dt.getDate()}</span></span>`;
  }).join('');
  const cols = days.map((d, i) => `<i class="${i === 0 ? 'is-today' : ''} ${dateOfKey(d).getDay() % 6 === 0 ? 'is-weekend' : ''}"></i>`).join('');
  const row = (label, track, cls = '') => `<div class="g-row ${cls}"><div class="g-label">${label}</div><div class="g-track">${track}</div></div>`;
  const group = (title) => `<p class="g-group">${esc(title)}</p>`;
  const out = [];

  // Study: planned hours per subject per day.
  const subjects = P().study.filter((x) => days.some((d) => toNumber(x.cells[d]) > 0));
  const maxH = Math.max(1, ...subjects.flatMap((x) => days.map((d) => toNumber(x.cells[d]))));
  if (subjects.length) {
    out.push(group('Study'));
    for (const x of subjects.slice(0, 5)) {
      const total = days.reduce((n, d) => n + toNumber(x.cells[d]), 0);
      const cells = days.map((d, i) => {
        const h = toNumber(x.cells[d]);
        return h ? `<span class="g-cell" style="left:${pct(i)};width:${pct(1)}"><b style="--a:${(0.4 + 0.6 * (h / maxH)).toFixed(2)}">${fmtH(h)}</b></span>` : '';
      }).join('');
      out.push(row(`<i class="g-dot"></i><span class="g-name">${esc(x.subject)}</span><span class="g-total">${fmtH(total)} h</span>`, cells, '').replace('class="g-row ', `style="--c:${colorOf(x.subject)}" class="g-row `));
    }
  }

  // Milestones: exams and dated events (study blocks are covered above),
  // packed into lanes so no two labels touch.
  const inRange = (a, b) => a <= last && (b || a) >= k;
  const items = [
    ...P().exams.filter((e) => e.start && inRange(e.start)).map((e) => ({ start: idx(e.start), len: 1, title: e.subject ? `${e.subject} exam` : e.title, kind: 'exam', color: colorOf(e.subject) })),
    ...ofType('event').filter((e) => e.start && !/^study:/i.test(e.title) && e.area !== 'Study' && inRange(e.start, e.end)).map((e) => {
      const s0 = idx(e.start);
      const s1 = e.end ? Math.min(PLAN_DAYS - 1, idx(e.end)) : s0;
      return { start: s0, len: s1 - s0 + 1, title: e.title, kind: s1 > s0 ? 'bar' : 'dot', color: eventColor(e) };
    }),
  ].sort((a, b) => a.start - b.start || b.len - a.len);
  const TT = 1.4 * R;
  const lanes = [];
  let hidden = 0;
  for (const it of items) {
    const tw = textWidth(it.title, 400, TT);
    it.x = it.kind === 'bar' ? it.start * dayW : (it.start + 0.5) * dayW - 0.55 * R;
    it.want = it.kind === 'bar' ? Math.max(it.len * dayW, tw + 2.2 * R) : tw + 2.2 * R;
    it.min = it.kind === 'bar' ? it.len * dayW : Math.min(it.want, 7 * R);
    // A lane where the whole label fits, else a new lane, else the lane where
    // a shortened label still fits.
    let lane = lanes.findIndex((l) => l.end + 0.8 * R <= it.x);
    if (lane < 0 && lanes.length < 3) lane = lanes.push({ end: -Infinity, minEnd: -Infinity, items: [] }) - 1;
    if (lane < 0) lane = lanes.findIndex((l) => l.minEnd + 0.8 * R <= it.x);
    if (lane < 0) { hidden++; continue; }
    lanes[lane].items.push(it);
    lanes[lane].end = it.x + it.want;
    lanes[lane].minEnd = it.x + it.min;
  }
  if (lanes.length) {
    out.push(group('Milestones'));
    lanes.forEach((l, li) => {
      const html = l.items.map((it, n) => {
        const next = l.items[n + 1];
        const room = Math.max(it.min, Math.min(it.want, (next ? next.x : trackW) - it.x - 0.8 * R));
        if (it.kind === 'bar') {
          return `<span class="g-bar" style="--c:${esc(it.color)};left:${(it.x / trackW * 100).toFixed(3)}%;width:${(it.len * dayW / trackW * 100).toFixed(3)}%"><em style="max-width:${Math.max(room, it.len * dayW).toFixed(0)}px">${esc(it.title)}</em></span>`;
        }
        return `<span class="g-mark ${it.kind === 'exam' ? 'is-exam' : ''}" style="--c:${esc(it.color)};left:${(it.x / trackW * 100).toFixed(3)}%;max-width:${room.toFixed(0)}px"><i></i><em>${esc(it.title)}</em></span>`;
      }).join('');
      out.push(row(li === lanes.length - 1 && hidden ? `<span class="g-more">and ${hidden} more</span>` : '', html));
    });
  }

  // Tasks: open tasks per area per day, with overdue ones counted on today.
  const tasks = [...ofType('task'), ...ofType('reading')].filter(isOpen);
  const overdue = tasks.filter((t) => taskDue(t) && taskDue(t) < k);
  const byArea = new Map();
  for (const t of tasks) {
    const ds = (plannedDays(t).length ? plannedDays(t) : [t.start]).filter((d) => d && d >= k && d <= last);
    if (!ds.length) continue;
    const area = t.area || 'Other';
    if (!byArea.has(area)) byArea.set(area, { n: 0, days: {} });
    const a = byArea.get(area);
    a.n++;
    for (const d of ds) (a.days[d] ||= []).push(t);
  }
  const areas = [...byArea.entries()].sort((a, b) => b[1].n - a[1].n);
  if (areas.length || overdue.length) {
    out.push(group('Tasks'));
    if (overdue.length) out.push(row('<span class="g-name is-late">Overdue</span>', `<span class="g-cell" style="left:0;width:${pct(1)}"><b class="g-count is-late">${overdue.length}</b></span>`));
    for (const [area, a] of areas.slice(0, overdue.length ? 2 : 3)) {
      const cells = days.map((d, i) => {
        const list = a.days[d];
        if (!list) return '';
        const p1 = list.some((t) => t.priority === 'P1');
        return `<span class="g-cell" style="left:${pct(i)};width:${pct(1)}"><b class="g-count ${p1 ? 'is-p1' : ''}">${list.length}</b></span>`;
      }).join('');
      out.push(row(`<span class="g-name">${esc(area)}</span><span class="g-total">${a.n}</span>`, cells));
    }
  }

  // Exercise sessions.
  const ex = ofType('exercise');
  const exCells = days.map((d, i) => {
    const v = ex.map((e) => String(e.cells[d] || '').toUpperCase()).find(Boolean);
    return v ? `<span class="g-cell" style="left:${pct(i)};width:${pct(1)}"><b class="g-chip">${esc(EX_NAMES[v] || v)}</b></span>` : '';
  }).join('');
  if (/g-cell/.test(exCells)) {
    out.push(group('Exercise'));
    out.push(row('<span class="g-name">Sessions</span>', exCells));
  }

  const d = new Date();
  const w = weatherLine();
  return `
    <header class="plan-head">
      <div>
        <h1 class="plan-title">The next two weeks</h1>
        <p class="plan-range">${esc(range)}</p>
      </div>
      <div class="plan-now">
        <p class="plan-clock">${pad(d.getHours())}<span class="colon">:</span>${pad(d.getMinutes())}</p>
        ${w ? `<p class="plan-wx">${esc(w)}</p>` : ''}
      </div>
    </header>
    <div class="gantt" style="--lw:${LABEL_REM}rem">
      <div class="g-row g-head"><div class="g-label"></div><div class="g-track g-days">${head}</div></div>
      <div class="g-body">
        <div class="g-cols">${cols}</div>
        ${out.join('')}
      </div>
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
  const amp = base - 6.2 * R; // leaves room above the top for two rows of labels
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

  // Labels sit in two rows above the arch, each joined to its dot by a thin
  // line, reading rightwards from the dot or ending at it. The layout is
  // chosen by a small search that shows as much of every title as it can,
  // with two rules that keep it tidy: a label always touches its own line, and
  // no line runs through another label (a lower-row label never covers
  // another event's dot).
  const family = getComputedStyle(document.documentElement).getPropertyValue('--sans') || 'sans-serif';
  const mctx = (renderDay.canvas ||= document.createElement('canvas')).getContext('2d');
  const measure = (text, weight, size) => { mctx.font = `${weight} ${size}px ${family}`; return mctx.measureText(text).width; };
  const TS = 1.35 * R;
  const TT = 1.5 * R;
  const GAP = 0.55 * R;
  const SEP = 2.2 * R;
  const ROW_Y = [1.6 * R, 4.1 * R];
  const right = W - padX;
  let allDayHtml = '';
  let row0Right = right;
  if (allDay.length) {
    let text = `All day: ${allDay.map((a) => a.title).join(', ')}`;
    const maxW = W * 0.34;
    while (text.length > 12 && measure(text, 300, 1.4 * R) > maxW) text = text.slice(0, -2).trimEnd() + '\u2026';
    text = text.replace(/\u2026+$/, '\u2026');
    row0Right = right - measure(text, 300, 1.4 * R) - SEP;
    allDayHtml = `<text class="all-day" x="${right.toFixed(1)}" y="${ROW_Y[0].toFixed(1)}" text-anchor="end">${esc(text)}</text>`;
  }
  const labels = timed.map((a) => {
    const time = hhmm(a.start);
    const title = a.title.replace(/^study:\s*/i, '');
    const tw = measure(time, 500, TS);
    return { a, x: xOf(a.start), y: yOf(a.start), time, title, tw, full: tw + GAP + measure(title, 400, TT) };
  });
  const HALF = 0.3 * R;
  const options = (l, n, st) => {
    const prevX = n ? labels[n - 1].x : -Infinity;
    const nextX = n + 1 < labels.length ? labels[n + 1].x : Infinity;
    const out = [];
    const add = (row, side, w) => {
      w = Math.min(l.full, w);
      if (w >= l.tw) out.push({ row, side, w, lx: side === 'right' ? l.x - HALF : l.x + HALF - w });
    };
    if (st.end[1] + SEP <= l.x - HALF) add(1, 'right', Math.min(nextX, right) - l.x - SEP * 0.5);
    add(1, 'left', l.x - Math.max(prevX + SEP * 0.5, st.end[1] + SEP));
    if (st.end[0] + SEP <= l.x - HALF) {
      add(0, 'right', row0Right - l.x);
      if (nextX < row0Right) add(0, 'right', nextX - l.x - SEP);
    }
    add(0, 'left', l.x - st.end[0] - SEP);
    out.push({ hidden: true });
    return out;
  };
  let beam = [{ end: [padX - SEP, padX - SEP], score: 0, picks: [] }];
  labels.forEach((l, n) => {
    const next = [];
    for (const st of beam) {
      for (const o of options(l, n, st)) {
        const end = [...st.end];
        let score = st.score;
        if (o.hidden) score -= 300;
        else {
          end[o.row] = o.lx + o.w;
          score += 20 + 100 * Math.sqrt(Math.max(0, o.w - l.tw) / Math.max(1, l.full - l.tw)) + (o.row === 1 ? 3 : 0);
        }
        next.push({ end, score, picks: [...st.picks, o] });
      }
    }
    next.sort((p, q) => q.score - p.score);
    const seen = new Set();
    beam = next.filter((st) => {
      const key = st.end.map((v) => Math.round(v / 8)).join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 60);
  });
  beam[0].picks.forEach((o, n) => {
    const l = labels[n];
    l.show = !o.hidden;
    if (!l.show) return;
    l.row = o.row;
    let t = l.title;
    const roomTitle = o.w - l.tw - GAP;
    if (measure(t, 400, TT) > roomTitle) {
      while (t.length > 1 && measure(t + '\u2026', 400, TT) > roomTitle) t = t.slice(0, -1);
      t = t.trimEnd().replace(/[,;:(]$/, '') + '\u2026';
    }
    l.text = t === l.title || roomTitle >= measure('Abc\u2026', 400, TT) ? t : '';
    const w = l.tw + (l.text ? GAP + measure(l.text, 400, TT) : 0);
    l.side = o.side;
    l.lx = o.side === 'right' ? l.x - HALF : l.x + HALF - w;
  });
  const marks = labels.map((l) => {
    const { a, x, y } = l;
    const past = (a.end ?? a.start + 30) <= nowMin();
    const ly = ROW_Y[l.row];
    return `
      <g class="mark ${past ? 'is-past' : ''}" style="--c:${esc(a.color)}">
        ${a.end ? `<path class="span" d="${path(a.start, Math.min(a.end, to))}"/>` : ''}
        ${l.show ? `<line class="leader" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${(ly + 0.6 * R).toFixed(1)}" y2="${(y - 0.7 * R).toFixed(1)}"/>` : ''}
        <circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.42 * R).toFixed(1)}"/>
        ${!l.show ? '' : l.side === 'left'
          ? `<text x="${l.lx.toFixed(1)}" y="${ly.toFixed(1)}">${l.text ? `<tspan class="mark-title">${esc(l.text)}</tspan>` : ''}<tspan class="mark-time"${l.text ? ` dx="${GAP.toFixed(1)}"` : ''}>${l.time}</tspan></text>`
          : `<text x="${l.lx.toFixed(1)}" y="${ly.toFixed(1)}"><tspan class="mark-time">${l.time}</tspan>${l.text ? `<tspan class="mark-title" dx="${GAP.toFixed(1)}">${esc(l.text)}</tspan>` : ''}</text>`}
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
      ${allDayHtml}
      <circle class="now-glow" cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${(2.4 * R).toFixed(1)}" fill="url(#glow)" style="transform-origin:${nx.toFixed(1)}px ${ny.toFixed(1)}px"/>
      <circle class="ripple" cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${(0.55 * R).toFixed(1)}" style="transform-origin:${nx.toFixed(1)}px ${ny.toFixed(1)}px"/>
      <circle class="ripple is-late" cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${(0.55 * R).toFixed(1)}" style="transform-origin:${nx.toFixed(1)}px ${ny.toFixed(1)}px"/>
      <circle class="now" cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${(0.55 * R).toFixed(1)}"/>
    </svg>
    ${!timed.length ? '<p class="day-empty">No events on the calendar today</p>' : ''}`;
}

// ---------- Screen care ----------

// Moves everything by a few pixels each minute so a TV left on all day does
// not keep the same pixels lit.
const SHIFTS = [[0, 0], [3, 2], [6, 0], [3, -2], [0, -3], [-3, -2], [-6, 0], [-3, 2]];
function shiftForBurnIn() {
  const b = $('#pages');
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

const NIGHT_WINDOW = `${hhmm(NIGHT_FROM)} to ${hhmm(NIGHT_TO)}`;

// Up: the opposite of now, until the next automatic switch. Down: automatic.
function toggleNight() {
  const on = !isNight();
  const until = nextSwitch();
  state.night = { on, until };
  store.set('pg.tvNightOverride', JSON.stringify(state.night));
  render();
  toast(`Night mode ${on ? 'on' : 'off'} until ${hhmm(new Date(until).getHours() * 60 + new Date(until).getMinutes())}`);
}

function autoNightMode() {
  state.night = null;
  store.set('pg.tvNightOverride', '');
  render();
  toast(`Night mode: automatic, ${NIGHT_WINDOW}`);
}

// Pages slide sideways; the plan page goes back to the day after 5 idle minutes.
let pageTimer = 0;
function showPage(n, animate = true) {
  state.page = Math.max(0, Math.min(1, n));
  const pages = $('#pages');
  if (!pages) return;
  pages.classList.toggle('no-anim', !animate);
  pages.dataset.page = String(state.page);
  $$('#page-dots i').forEach((d, i) => d.classList.toggle('is-on', i === state.page));
  clearTimeout(pageTimer);
  if (state.page) pageTimer = setTimeout(() => showPage(0), 5 * 60 * 1000);
}

document.addEventListener('keydown', (ev) => {
  if (!state.plan || !$('#board')) return;
  switch (ev.key) {
    case 'ArrowLeft': ev.preventDefault(); return showPage(state.page - 1);
    case 'ArrowRight': ev.preventDefault(); return showPage(state.page + 1);
    case 'ArrowUp': ev.preventDefault(); return toggleNight();
    case 'ArrowDown': ev.preventDefault(); return autoNightMode();
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

const urlPlace = new URLSearchParams(location.search).get('place') || '';

async function boot() {
  initSky($('#sky'), () => render());
  if (urlPlace) setPlace(urlPlace);
  try { localStorage.removeItem('pg.tvNight'); } catch {}
  try { const o = JSON.parse(store.get('pg.tvNightOverride') || 'null'); if (o && o.until > Date.now()) state.night = o; } catch {}
  const night = new URLSearchParams(location.search).get('night');
  if (night === 'on' || night === 'off') state.night = { on: night === 'on', until: Infinity };
  if (night === 'auto') state.night = null;
  document.documentElement.classList.toggle('is-night', isNight());
  const paired = pairFromHash();
  checkForUpdate();
  if (!api.configured()) return gate('This copy of the app has no Google client ID yet.');
  if (paired === 'bad') return gate('That TV link is incomplete. Copy it again in the app and paste the whole link.');
  if (api.hasToken() || api.canStaySignedIn()) return connect();
  gate();
}

boot();
