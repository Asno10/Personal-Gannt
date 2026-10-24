import { CONFIG } from '../config.js';
import * as api from './sheets.js';
import { parseGantt, parseDailyPlan, colLetter, keyOfDate, dateOfKey, withStatus, toNumber } from './parse.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtH = (n) => (Math.round(n * 10) / 10).toString();
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortLabel = (k) => { const d = dateOfKey(k); return `${d.getDate()} ${MON[d.getMonth()]}`; };
const longLabel = (k) => dateOfKey(k).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const dowLabel = (k) => dateOfKey(k).toLocaleDateString('en-GB', { weekday: 'short' });
const daysBetween = (a, b) => Math.round((dateOfKey(b) - dateOfKey(a)) / 86400000);
const todayKey = () => keyOfDate(new Date());

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
  saving: 0,
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
    await refresh(true);
  } catch (e) {
    renderSignIn(e.message);
  }
}

function signOut() {
  api.signOut();
  store.del('pg.signedIn');
  state.raw = null;
  renderSignIn();
}

// ---------- Data ----------

async function refresh(first = false) {
  if (first) app.innerHTML = `<main class="gate"><p class="loading">Loading the plan</p></main>`;
  try {
    const raw = await api.loadAll();
    state.raw = raw;
    state.plan = parseGantt(raw.gantt, raw.ganttFormulas);
    state.daily = parseDailyPlan(raw.daily, raw.dailyFormulas);
    state.loadedAt = Date.now();
    if (first) state.day = clampDay(todayKey());
    render();
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

async function save(updates, { message, undo } = {}) {
  state.saving++;
  renderStatus();
  try {
    await api.writeCells(updates);
    if (message) toast(message, undo);
  } catch (e) {
    if (e instanceof api.AuthError) return renderSignIn('Your session ended before the change was saved. Sign in and try again.');
    toast(`Not saved. ${e.message}`);
  } finally {
    state.saving--;
    await refresh();
  }
}

const gantt = (cell) => api.a1(CONFIG.sheets.gantt, cell);
const dailyCell = (cell) => api.a1(CONFIG.sheets.dailyPlan, cell);
const cellRef = (item, dayKey) => gantt(colLetter(state.plan.dayByKey[dayKey].col) + item.row);

// ---------- Subject colours ----------

function subjectIndex(name) {
  const study = state.plan.study.map((s) => s.subject);
  const i = study.indexOf(name);
  return i >= 0 ? i % 8 : -1;
}
const subjectVar = (name) => { const i = subjectIndex(name); return i >= 0 ? `var(--s${i})` : 'var(--ink-2)'; };

// ---------- Shell ----------

const VIEWS = [
  ['today', 'Day'],
  ['timeline', 'Timeline'],
  ['exams', 'Exams'],
  ['tasks', 'Tasks'],
];

function render() {
  const view = VIEWS.some(([v]) => v === state.view) ? state.view : 'today';
  app.innerHTML = `
    <header class="bar">
      <div class="bar-title">Personal Gantt</div>
      <nav class="tabs" aria-label="Views">
        ${VIEWS.map(([v, label]) => `<button class="tab" data-action="view" data-view="${v}" aria-current="${v === view ? 'page' : 'false'}">${label}</button>`).join('')}
      </nav>
      <div class="bar-side">
        <span class="status" id="status"></span>
        <button class="icon-btn" data-action="refresh" aria-label="Reload from the sheet" title="Reload from the sheet">${ICON.refresh}</button>
        <button class="icon-btn" data-action="menu" aria-label="Account" title="Account">${ICON.user}</button>
      </div>
    </header>
    <main class="view view-${view}" id="view">${VIEW_RENDER[view]()}</main>`;
  renderStatus();
  if (view === 'timeline') scrollTimelineToToday();
}

function renderStatus() {
  const el = $('#status');
  if (!el) return;
  if (state.saving) el.textContent = 'Saving';
  else if (state.loadedAt) el.textContent = 'Updated ' + new Date(state.loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  el.classList.toggle('is-saving', state.saving > 0);
}

// ---------- Day view ----------

function studyOn(k) {
  return state.plan.study
    .map((s) => ({ item: s, hours: toNumber(s.cells[k]) }))
    .filter((x) => x.hours > 0);
}

function tasksOn(k) {
  return state.plan.sections
    .filter((s) => s.type === 'tasks')
    .flatMap((s) => s.items)
    .filter((t) => /x/i.test(t.cells[k] || '') || (!Object.keys(t.cells).length && t.start === k));
}

function coversDay(item, k) {
  if (item.cells[k]) return true;
  return item.start && item.end ? item.start <= k && k <= item.end : item.start === k;
}

function nextExams(fromKey) {
  return state.plan.exams.filter((e) => e.start && e.start >= fromKey).sort((a, b) => (a.start + a.time).localeCompare(b.start + b.time));
}

function renderToday() {
  const k = state.day;
  const days = state.plan.days;
  const idx = days.findIndex((d) => d.key === k);
  const isToday = k === todayKey();
  const study = studyOn(k);
  const total = study.reduce((n, s) => n + s.hours, 0);
  const daily = state.daily.byKey[k];
  const tasks = tasksOn(k);
  const carried = isToday
    ? state.plan.sections.filter((s) => s.type === 'tasks').flatMap((s) => s.items)
        .filter((t) => t.status.status === 'open' && t.start && t.start < k && !tasks.includes(t))
    : [];
  const events = state.plan.sections.filter((s) => s.type === 'events').flatMap((s) => s.items).filter((e) => coversDay(e, k));
  const exams = nextExams(k);
  const examToday = exams.filter((e) => e.start === k);
  const exercise = state.plan.sections.filter((s) => s.type === 'exercise').flatMap((s) => s.items)
    .filter((e) => !/weigh/i.test(e.subject) && coversDay(e, k));
  const others = state.plan.study.filter((s) => !study.some((x) => x.item === s));

  const head = exams[0];
  const countdown = head ? daysBetween(k, head.start) : null;
  const later = exams.slice(examToday.length || 1, (examToday.length || 1) + 3);

  return `
    <section class="day-head">
      <button class="icon-btn" data-action="day" data-step="-1" ${idx <= 0 ? 'disabled' : ''} aria-label="Previous day">${ICON.left}</button>
      <div class="day-title">
        <h1>${esc(longLabel(k))}</h1>
        ${isToday ? '<span class="pill pill-today">Today</span>' : `<button class="link" data-action="go-today">Back to today</button>`}
      </div>
      <button class="icon-btn" data-action="day" data-step="1" ${idx >= days.length - 1 ? 'disabled' : ''} aria-label="Next day">${ICON.right}</button>
    </section>

    ${head ? `
    <section class="tminus" style="--c:${subjectVar(head.subject)}">
      <div class="tminus-count">${examToday.length ? 'T&#8239;0' : `T&#8722;${countdown}`}</div>
      <div class="tminus-body">
        <div class="tminus-label">${examToday.length ? 'Exam day' : 'Next exam'}</div>
        ${(examToday.length ? examToday : [head]).map((e) => `
          <div class="tminus-exam"><strong>${esc(e.subject)}</strong><br>${esc(dowLabel(e.start))} ${esc(shortLabel(e.start))}${e.time ? ', ' + esc(e.time) : ''}</div>`).join('')}
      </div>
      ${later.length ? `<div class="tminus-later">${later.map((e) => `<span><b>T&#8722;${daysBetween(k, e.start)}</b>${esc(e.subject)}</span>`).join('')}</div>` : ''}
    </section>` : ''}

    <section class="block">
      <div class="block-head">
        <h2>Study</h2>
        <span class="block-meta">${total ? fmtH(total) + ' h planned' : 'Nothing planned'}</span>
      </div>
      <ul class="study-list">
        ${study.map(({ item, hours }) => studyRow(item, hours, k)).join('')}
      </ul>
      ${daily?.studyNote.value && !/^none$/i.test(daily.studyNote.value) ? `<p class="note">${esc(daily.studyNote.value)}</p>` : ''}
      ${others.length ? `
        <details class="add-subject">
          <summary>Add study time</summary>
          <div class="chips">${others.map((s) => `<button class="chip" style="--c:${subjectVar(s.subject)}" data-action="hours" data-row="${s.row}" data-day="${k}" data-delta="1">${esc(s.subject)}</button>`).join('')}</div>
        </details>` : ''}
    </section>

    <section class="block">
      <div class="block-head"><h2>Tasks</h2><span class="block-meta">${tasks.length ? `${tasks.filter((t) => t.status.status === 'done').length} of ${tasks.length} done` : 'None scheduled'}</span></div>
      <ul class="task-list">${tasks.map(taskRow).join('')}</ul>
      ${carried.length ? `<h3 class="sub">Carried over</h3><ul class="task-list">${carried.map(taskRow).join('')}</ul>` : ''}
      <button class="btn btn-quiet" data-action="add-task" data-day="${k}">+ Add task</button>
    </section>

    ${daily || events.length ? `
    <section class="block">
      <div class="block-head"><h2>Commitments</h2></div>
      ${daily ? editableLine(daily.commitments, daily.row, 'Fixed commitments', 'No fixed commitments') : ''}
      ${events.map((e) => `<div class="event"><span class="event-mark">${e.cells[k] === '!' || /deadline/i.test(e.subject) ? '!' : ''}</span><span>${esc(e.task)}</span></div>`).join('')}
    </section>` : ''}

    ${daily || exercise.length ? `
    <section class="block">
      <div class="block-head"><h2>Exercise</h2></div>
      ${daily ? editableLine(daily.exercise, daily.row, 'Exercise', 'Rest day') : ''}
      ${exercise.map((e) => `<p class="note">${esc(e.subject)}: ${esc(e.task)}</p>`).join('')}
    </section>` : ''}
  `;
}

function studyRow(item, hours, k) {
  return `
    <li class="study" style="--c:${subjectVar(item.subject)}">
      <span class="study-swatch" aria-hidden="true"></span>
      <span class="study-name">${esc(item.subject)}</span>
      <span class="stepper">
        <button class="step" data-action="hours" data-row="${item.row}" data-day="${k}" data-delta="-0.5" aria-label="Half an hour less ${esc(item.subject)}">&#8722;</button>
        <span class="study-hours">${fmtH(hours)}<small>h</small></span>
        <button class="step" data-action="hours" data-row="${item.row}" data-day="${k}" data-delta="0.5" aria-label="Half an hour more ${esc(item.subject)}">+</button>
      </span>
    </li>`;
}

function taskRow(t) {
  const done = t.status.status === 'done';
  return `
    <li class="task ${done ? 'is-done' : ''}">
      <button class="check" data-action="toggle-task" data-row="${t.row}" role="checkbox" aria-checked="${done}" aria-label="${done ? 'Mark open' : 'Mark done'}: ${esc(t.status.title)}">${done ? ICON.check : ''}</button>
      <button class="task-body" data-action="edit-task" data-row="${t.row}">
        <span class="task-title">${esc(t.status.title)}</span>
        <span class="task-meta">${esc([t.phase, t.subject].filter(Boolean).join(', '))}${t.start ? ` <span class="date-chip">${esc(shortLabel(t.start))}</span>` : ''}</span>
      </button>
    </li>`;
}

function editableLine(field, row, label, empty) {
  if (field.col < 0) return '';
  const locked = field.locked;
  return `<button class="line ${field.value ? '' : 'is-empty'}" ${locked ? 'disabled' : ''} data-action="edit-text" data-range="${esc(dailyCell(colLetter(field.col) + row))}" data-label="${esc(label)}" data-value="${esc(field.value)}">${esc(field.value || empty)}</button>`;
}

// ---------- Timeline ----------

function renderTimeline() {
  const { days, sections } = state.plan;
  const tk = todayKey();
  const maxH = Math.max(1, ...state.plan.study.flatMap((s) => Object.values(s.cells).map(toNumber)));
  const head = `
    <tr class="tl-head">
      <th class="tl-name" scope="col"><span class="sr-only">Item</span></th>
      ${days.map((d, i) => {
        const dt = dateOfKey(d.key);
        const first = i === 0 || dt.getDate() === 1;
        return `<th scope="col" class="tl-day ${dt.getDay() % 6 === 0 ? 'is-weekend' : ''} ${d.key === tk ? 'is-today' : ''} ${first ? 'is-month' : ''}" data-key="${d.key}">
          ${first ? `<span class="tl-month">${MON[dt.getMonth()]}</span>` : ''}<span class="tl-dow">${esc(d.dow.slice(0, 2))}</span><span class="tl-num">${dt.getDate()}</span></th>`;
      }).join('')}
    </tr>`;

  const rows = sections.filter((s) => s.items.length).map((s) => `
    <tr class="tl-section"><th class="tl-name" scope="rowgroup">${esc(sectionName(s))}</th><td colspan="${days.length}"></td></tr>
    ${s.items.map((item) => timelineRow(item, s, days, tk, maxH)).join('')}
  `).join('');

  const totals = days.map((d) => state.plan.study.reduce((n, s) => n + toNumber(s.cells[d.key]), 0));
  const foot = `
    <tr class="tl-total"><th class="tl-name" scope="row">Study hours</th>
      ${days.map((d, i) => `<td class="${d.key === tk ? 'is-today' : ''}">${totals[i] ? fmtH(totals[i]) : ''}</td>`).join('')}
    </tr>`;

  return `
    <div class="tl-intro">
      <p>${esc(state.plan.subtitle)}</p>
      <p class="hint">Tap a study cell to change its hours, a task cell to plan it on that day, or a name to edit it.</p>
    </div>
    <div class="tl-scroll" id="tl-scroll">
      <table class="tl">
        <thead>${head}</thead>
        <tbody>${rows}${foot}</tbody>
      </table>
    </div>`;
}

function sectionName(s) {
  return s.title.replace(/\s*\(.*\)\s*$/, '').replace(/^Todoist:\s*/i, '') || s.title;
}

function timelineRow(item, s, days, tk, maxH) {
  const hasCells = Object.keys(item.cells).length > 0;
  const name = s.type === 'study' || s.type === 'exams' ? item.subject : s.type === 'tasks' ? item.status.title : item.task || item.subject;
  const sub = s.type === 'study' ? `${fmtH(Object.values(item.cells).reduce((n, v) => n + toNumber(v), 0))} h`
    : s.type === 'exams' ? [item.start && shortLabel(item.start), item.time].filter(Boolean).join(', ')
    : item.subject;
  const done = s.type === 'tasks' && item.status.status === 'done';
  const color = subjectVar(s.type === 'exams' || s.type === 'study' ? item.subject : '');
  const nameAction = s.type === 'tasks' ? `data-action="edit-task" data-row="${item.row}"` : `data-action="edit-text" data-range="${esc(gantt('C' + item.row))}" data-label="Task" data-value="${esc(item.task)}"`;

  const cells = days.map((d) => {
    const v = item.cells[d.key] || '';
    const inRange = !hasCells && item.start && (item.end ? item.start <= d.key && d.key <= item.end : item.start === d.key);
    const cls = [d.key === tk ? 'is-today' : '', dateOfKey(d.key).getDay() % 6 === 0 ? 'is-weekend' : ''];
    let inner = '';
    let action = '';
    if (s.type === 'study') {
      const h = toNumber(v);
      if (h) inner = `<span class="tl-h" style="--a:${Math.round(25 + 75 * (h / maxH))}%">${fmtH(h)}</span>`;
      action = `data-action="edit-hours" data-row="${item.row}" data-day="${d.key}"`;
    } else if (s.type === 'tasks') {
      if (/x/i.test(v) || inRange) inner = `<span class="tl-dot ${done ? 'is-done' : ''}"></span>`;
      action = `data-action="plan-task" data-row="${item.row}" data-day="${d.key}"`;
    } else if (s.type === 'exams') {
      if (v || inRange) inner = `<span class="tl-exam"></span>`;
    } else {
      if (v) inner = `<span class="tl-mark ${v === '!' ? 'is-alert' : ''}">${esc(v)}</span>`;
      else if (inRange) inner = `<span class="tl-bar ${s.type === 'events' && /deadline/i.test(item.subject) ? 'is-alert' : ''}"></span>`;
      action = `data-action="edit-cell" data-row="${item.row}" data-day="${d.key}"`;
    }
    return `<td class="${cls.join(' ')}" ${action}>${inner}</td>`;
  }).join('');

  return `
    <tr class="tl-row tl-${s.type} ${done ? 'is-done' : ''}" style="--c:${color}">
      <th class="tl-name" scope="row"><button ${nameAction} title="${esc(item.task || item.subject)}"><span class="tl-label">${esc(name)}</span><span class="tl-sub">${esc(sub)}</span></button></th>
      ${cells}
    </tr>`;
}

function scrollTimelineToToday() {
  const sc = $('#tl-scroll');
  const th = sc && sc.querySelector('.tl-day.is-today');
  if (!sc || !th) return;
  const nameW = sc.querySelector('.tl-name')?.offsetWidth || 0;
  sc.scrollLeft = Math.max(0, th.offsetLeft - nameW - th.offsetWidth * 2);
}

// ---------- Exams ----------

function renderExams() {
  const tk = todayKey();
  const exams = [...state.plan.exams].sort((a, b) => (a.start + a.time).localeCompare(b.start + b.time));
  const upcoming = exams.filter((e) => e.start >= tk);
  const past = exams.filter((e) => e.start < tk);
  return `
    <h1 class="page-title">Exams</h1>
    <div class="exam-grid">${upcoming.map((e) => examCard(e, tk)).join('') || '<p class="empty">No upcoming exams in the sheet.</p>'}</div>
    ${past.length ? `<h2 class="sub">Behind you</h2><div class="exam-grid is-past">${past.map((e) => examCard(e, tk)).join('')}</div>` : ''}`;
}

function examCard(e, tk) {
  const study = state.plan.study.find((s) => s.subject === e.subject);
  const entries = study ? state.plan.days.filter((d) => d.key <= e.start).map((d) => ({ k: d.key, h: toNumber(study.cells[d.key]) })) : [];
  const active = entries.filter((x) => x.h > 0);
  const total = active.reduce((n, x) => n + x.h, 0);
  const behind = active.filter((x) => x.k < tk).reduce((n, x) => n + x.h, 0);
  const left = total - behind;
  const firstK = active[0]?.k;
  const span = firstK ? state.plan.days.filter((d) => d.key >= firstK && d.key <= e.start) : [];
  const max = Math.max(1, ...active.map((x) => x.h));
  const n = daysBetween(tk, e.start);
  const rooms = (e.task.match(/rooms?\s+([\d,\s]+)/i) || [])[1];
  return `
    <article class="exam" style="--c:${subjectVar(e.subject)}">
      <div class="exam-count">${n < 0 ? 'Done' : n === 0 ? 'Today' : `T&#8722;${n}`}</div>
      <h2 class="exam-subject">${esc(e.subject)}</h2>
      <p class="exam-when">${esc(longLabel(e.start))}${e.time ? ', ' + esc(e.time) : ''}${rooms ? `<br>Rooms ${esc(rooms.trim())}` : ''}</p>
      ${!rooms && e.task !== e.subject ? `<p class="exam-when">${esc(e.task)}</p>` : ''}
      ${study ? `
        <div class="exam-hours">
          <div><strong>${fmtH(total)}</strong> h planned</div>
          <div><strong>${fmtH(behind)}</strong> h behind you</div>
          <div><strong>${fmtH(left)}</strong> h to go</div>
        </div>
        <div class="spark" role="img" aria-label="Planned daily hours for ${esc(e.subject)}">
          ${span.map((d) => { const h = toNumber(study.cells[d.key]); return `<span class="spark-bar ${d.key < tk ? 'is-past' : ''} ${d.key === tk ? 'is-today' : ''}" style="height:${h ? Math.max(8, (h / max) * 100) : 2}%" title="${esc(shortLabel(d.key))}: ${fmtH(h)} h"></span>`; }).join('')}
        </div>` : ''}
    </article>`;
}

// ---------- Tasks ----------

function allTasks() {
  return state.plan.sections.filter((s) => s.type === 'tasks').flatMap((s) => s.items);
}

function renderTasks() {
  const f = state.taskFilter;
  const tasks = allTasks().filter((t) => f === 'all' || t.status.status === f)
    .sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999'));
  const groups = new Map();
  for (const t of tasks) {
    const g = [t.phase, t.subject].filter(Boolean).join(', ') || 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  const count = (s) => allTasks().filter((t) => s === 'all' || t.status.status === s).length;
  return `
    <div class="page-head">
      <h1 class="page-title">Tasks</h1>
      <button class="btn btn-primary" data-action="add-task" data-day="${clampDay(todayKey())}">Add task</button>
    </div>
    <div class="segmented" role="tablist">
      ${[['open', 'Open'], ['done', 'Done'], ['all', 'All']].map(([v, l]) => `<button role="tab" aria-selected="${f === v}" data-action="task-filter" data-filter="${v}">${l} <span>${count(v)}</span></button>`).join('')}
    </div>
    ${[...groups].map(([g, list]) => `<section class="block"><h2 class="group">${esc(g)}</h2><ul class="task-list">${list.map(taskRow).join('')}</ul></section>`).join('') || '<p class="empty">Nothing here.</p>'}
    <p class="hint">Changes are written to the sheet only; Todoist is not updated.</p>`;
}

// ---------- Actions ----------

const findItem = (row) => state.plan.sections.flatMap((s) => s.items).find((i) => i.row === +row);

function setHours(item, k, value) {
  const v = Math.max(0, Math.round(value * 2) / 2);
  const prev = toNumber(item.cells[k]);
  if (v === prev) return;
  item.cells[k] = v ? String(v) : '';
  render();
  save([{ range: cellRef(item, k), value: v || '' }]);
}

function toggleTask(item) {
  const next = item.status.status === 'done' ? 'open' : 'done';
  const text = withStatus(item.status.raw, next, shortLabel(todayKey()));
  const prevText = item.status.raw;
  item.status.status = next;
  render();
  save([{ range: gantt('C' + item.row), value: text }], {
    message: next === 'done' ? 'Marked done' : 'Marked open',
    undo: () => save([{ range: gantt('C' + item.row), value: prevText }]),
  });
}

function planTask(item, k) {
  const has = /x/i.test(item.cells[k] || '');
  const updates = [{ range: cellRef(item, k), value: has ? '' : 'X' }];
  // Keep Start and End in step with the planned days.
  const marked = Object.entries(item.cells).filter(([, v]) => /x/i.test(v)).map(([d]) => d).filter((d) => d !== k);
  if (!has) marked.push(k);
  marked.sort();
  if (marked.length && !item.lockedDates) {
    updates.push({ range: gantt(colLetter(state.plan.header.start) + item.row), value: marked[0] });
    updates.push({ range: gantt(colLetter(state.plan.header.end) + item.row), value: marked[marked.length - 1] });
  }
  if (has) delete item.cells[k]; else item.cells[k] = 'X';
  render();
  save(updates);
}

// ---------- Dialogs ----------

function openDialog(html, onSubmit) {
  const dlg = $('#dialog');
  dlg.innerHTML = `<form method="dialog" class="dlg">${html}</form>`;
  const form = dlg.querySelector('form');
  form.addEventListener('submit', (ev) => {
    const btn = ev.submitter;
    if (btn?.value === 'cancel') return;
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    dlg.close();
    onSubmit(data, btn?.value);
  });
  dlg.showModal();
  const first = form.querySelector('input, textarea, select');
  if (first) first.focus();
}

const dlgActions = (primary = 'Save', extra = '') => `
  <div class="dlg-actions">${extra}<span class="spacer"></span>
    <button class="btn btn-quiet" value="cancel" formnovalidate>Cancel</button>
    <button class="btn btn-primary" value="save">${primary}</button>
  </div>`;

function editHours(item, k) {
  const v = toNumber(item.cells[k]);
  openDialog(`
    <h2>${esc(item.subject)}</h2>
    <p class="dlg-sub">${esc(longLabel(k))}</p>
    <label class="field"><span>Hours</span><input name="hours" type="number" inputmode="decimal" min="0" max="16" step="0.5" value="${v || ''}" placeholder="0"></label>
    ${dlgActions()}`, (d) => setHours(item, k, toNumber(d.hours)));
}

function editText(range, label, value) {
  openDialog(`
    <h2>${esc(label)}</h2>
    <label class="field"><span>Text</span><textarea name="text" rows="4">${esc(value)}</textarea></label>
    ${dlgActions()}`, (d) => save([{ range, value: d.text.trim() }], { message: 'Saved' }));
}

function editCell(item, k) {
  const v = item.cells[k] || '';
  openDialog(`
    <h2>${esc(item.task || item.subject)}</h2>
    <p class="dlg-sub">${esc(longLabel(k))}</p>
    <label class="field"><span>Cell value</span><input name="v" value="${esc(v)}" maxlength="40"></label>
    ${dlgActions()}`, (d) => save([{ range: cellRef(item, k), value: d.v.trim() }]));
}

function editTask(item) {
  const st = item.status;
  openDialog(`
    <h2>Edit task</h2>
    <label class="field"><span>Task</span><textarea name="text" rows="3" required>${esc(st.raw)}</textarea></label>
    <label class="field"><span>Date</span><input name="date" type="date" value="${item.start || ''}" ${item.lockedDates ? 'disabled' : ''}></label>
    ${dlgActions('Save', `<button class="btn btn-quiet" value="toggle">${st.status === 'done' ? 'Mark open' : 'Mark done'}</button>`)}`,
  (d, which) => {
    if (which === 'toggle') return toggleTask(item);
    const updates = [];
    if (d.text.trim() !== st.raw) updates.push({ range: gantt('C' + item.row), value: d.text.trim() });
    if (d.date && d.date !== item.start && !item.lockedDates) updates.push(...rescheduleUpdates(item, d.date));
    if (updates.length) save(updates, { message: 'Saved' });
  });
}

function rescheduleUpdates(item, k) {
  const H = state.plan.header;
  const ups = [
    { range: gantt(colLetter(H.start) + item.row), value: k },
    { range: gantt(colLetter(H.end) + item.row), value: k },
  ];
  for (const [d, v] of Object.entries(item.cells)) if (/x/i.test(v) && d !== k) ups.push({ range: cellRef(item, d), value: '' });
  if (state.plan.dayByKey[k]) ups.push({ range: cellRef(item, k), value: 'X' });
  return ups;
}

function addTask(k) {
  const tasks = allTasks();
  const phases = [...new Set(tasks.map((t) => t.phase).filter(Boolean))];
  const subjects = [...new Set(tasks.map((t) => t.subject).filter(Boolean))];
  openDialog(`
    <h2>Add task</h2>
    <label class="field"><span>Task</span><input name="task" required autocomplete="off"></label>
    <div class="field-row">
      <label class="field"><span>Area</span><input name="phase" list="dl-phase" value="${esc(phases[0] || '')}" autocomplete="off"></label>
      <label class="field"><span>Topic</span><input name="subject" list="dl-subject" autocomplete="off"></label>
    </div>
    <datalist id="dl-phase">${phases.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
    <datalist id="dl-subject">${subjects.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
    <label class="field"><span>Date</span><input name="date" type="date" value="${k}" required></label>
    ${dlgActions('Add task')}`, async (d) => {
    const last = tasks[tasks.length - 1];
    if (!last) return toast('The sheet has no task section to add to.');
    const row = last.row + 1;
    const H = state.plan.header;
    state.saving++;
    renderStatus();
    try {
      await api.insertRowBelow(state.raw.sheetIds[CONFIG.sheets.gantt], last.row);
      const ups = [
        { range: gantt(colLetter(H.phase) + row), value: d.phase.trim() },
        { range: gantt(colLetter(H.subject) + row), value: d.subject.trim() },
        { range: gantt(colLetter(H.task) + row), value: `${d.task.trim()} (open)` },
        { range: gantt(colLetter(H.start) + row), value: d.date },
        { range: gantt(colLetter(H.end) + row), value: d.date },
      ];
      // The inserted row copies formatting only, so just mark the planned day.
      if (state.plan.dayByKey[d.date]) ups.push({ range: gantt(colLetter(state.plan.dayByKey[d.date].col) + row), value: 'X' });
      await api.writeCells(ups);
      toast('Task added');
    } catch (e) {
      toast(`Not added. ${e.message}`);
    } finally {
      state.saving--;
      await refresh();
    }
  });
}

function accountMenu() {
  openDialog(`
    <h2>Account</h2>
    <p class="dlg-sub">Signed in to Google for this session. The sheet is read and written directly; nothing is stored by this site.</p>
    <p><a href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(CONFIG.spreadsheetId)}/edit" target="_blank" rel="noopener">Open the sheet in Google Sheets</a></p>
    <div class="dlg-actions"><button class="btn btn-quiet" value="signout">Sign out</button><span class="spacer"></span><button class="btn btn-primary" value="cancel">Close</button></div>`,
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
  toastTimer = setTimeout(() => t.classList.remove('is-on'), undo ? 6000 : 3500);
}

// ---------- Events ----------

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  const item = el.dataset.row ? findItem(el.dataset.row) : null;
  switch (a) {
    case 'sign-in': return signIn(store.get('pg.signedIn') === '1');
    case 'refresh': return refresh();
    case 'menu': return accountMenu();
    case 'view': state.view = el.dataset.view; store.set('pg.view', state.view); return render();
    case 'day': {
      const days = state.plan.days;
      const i = days.findIndex((d) => d.key === state.day) + Number(el.dataset.step);
      if (days[i]) { state.day = days[i].key; render(); }
      return;
    }
    case 'go-today': state.day = clampDay(todayKey()); return render();
    case 'hours': return item && setHours(item, el.dataset.day, toNumber(item.cells[el.dataset.day]) + Number(el.dataset.delta));
    case 'edit-hours': return item && editHours(item, el.dataset.day);
    case 'toggle-task': return item && toggleTask(item);
    case 'edit-task': return item && editTask(item);
    case 'plan-task': return item && planTask(item, el.dataset.day);
    case 'edit-cell': return item && editCell(item, el.dataset.day);
    case 'edit-text': return editText(el.dataset.range, el.dataset.label, el.dataset.value);
    case 'add-task': return addTask(el.dataset.day);
    case 'task-filter': state.taskFilter = el.dataset.filter; return render();
    case 'undo': {
      const t = $('#toast');
      t.classList.remove('is-on');
      if (t._undo) t._undo();
      return;
    }
  }
});

document.addEventListener('keydown', (ev) => {
  if (state.view !== 'today' || !state.plan || $('#dialog').open) return;
  if (ev.target.closest('input, textarea')) return;
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    const btn = document.querySelector(`[data-action="day"][data-step="${ev.key === 'ArrowLeft' ? -1 : 1}"]`);
    if (btn) btn.click();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.plan) return;
  if (!api.hasToken()) return renderSignIn('Your session ended. Sign in again to continue.');
  if (Date.now() - state.loadedAt > 120000 && !state.saving) refresh();
});

// ---------- Icons ----------

const svg = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  left: svg('<path d="M15 5l-7 7 7 7"/>'),
  right: svg('<path d="M9 5l7 7-7 7"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>'),
  user: svg('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.6 4-5 7-5s5.8 1.4 7 5"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
};

const VIEW_RENDER = { today: renderToday, timeline: renderTimeline, exams: renderExams, tasks: renderTasks };

boot();
