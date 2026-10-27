// Turns the "Items" table into the plan the views draw from.
//
// The Items tab is the database: one row per item, with fixed columns named in
// its header row (id, type, area, subject, title, date, end, time, minutes,
// hours, days, status, done_on, priority, notes, calendar, event_id, synced,
// updated). Columns are found by name, so adding or reordering columns in the
// sheet does not break the app. Every row is kept; a type the app does not
// know still shows, under "Other".

export const pad = (n) => String(n).padStart(2, '0');
export const dateKey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
export const keyOfDate = (dt) => dateKey(dt.getFullYear(), dt.getMonth(), dt.getDate());
export const dateOfKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (k, n) => { const d = dateOfKey(k); d.setDate(d.getDate() + n); return keyOfDate(d); };

export function colLetter(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();

export function toNumber(v) {
  const s = str(v).replace(',', '.');
  if (s === '') return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

export const FIELDS = ['id', 'type', 'area', 'subject', 'title', 'date', 'end', 'time', 'minutes', 'hours', 'days', 'status', 'done_on', 'priority', 'notes', 'calendar', 'event_id', 'synced', 'updated'];
export const KNOWN_TYPES = ['study', 'log', 'reading', 'task', 'exam', 'event', 'exercise', 'note'];

// Accepts 2026-10-27, 2026-10-27T..., or 27.10.2026; anything else is no date.
export function normDate(v) {
  const s = str(v);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return dateKey(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (m) return dateKey(+m[3], +m[2] - 1, +m[1]);
  return '';
}

export function normTime(v) {
  const m = str(v).match(/^(\d{1,2})[:.](\d{2})/);
  return m ? `${pad(+m[1])}:${m[2]}` : '';
}

// "2026-10-27=2.5; 2026-10-28=X" <-> { '2026-10-27': '2.5', '2026-10-28': 'X' }
export function parseDays(s) {
  const out = {};
  for (const part of str(s).split(/[;\n]+/)) {
    const m = part.trim().match(/^(\d{4}-\d{1,2}-\d{1,2})\s*[=:]\s*(.+)$/);
    if (m) out[normDate(m[1])] = m[2].trim();
  }
  return out;
}
export const serializeDays = (cells) => Object.keys(cells).filter((k) => str(cells[k]) !== '').sort().map((k) => `${k}=${cells[k]}`).join('; ');

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortLabel = (k) => { const d = dateOfKey(k); return `${d.getDate()} ${MON[d.getMonth()]}`; };

export function newId(type) {
  const c = (type || 'i')[0].toLowerCase();
  const p = { exam: 'x', event: 'v', exercise: 'w' }[type] || (/[a-z]/.test(c) ? c : 'i');
  const r = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6);
  return `${p}-${r}`;
}

function parseSettings(rows) {
  const out = {};
  for (const r of rows || []) {
    const k = str(r[0]);
    if (k && k !== 'key' && /^[a-z_]+$/.test(k)) out[k] = { value: str(r[1]), row: (rows.indexOf(r)) + 1 };
  }
  return out;
}

export function parseItems(rows, settingsRows, today) {
  rows = rows || [];
  const header = (rows[0] || []).map((c) => str(c).toLowerCase());
  const C = Object.fromEntries(FIELDS.map((f) => [f, header.indexOf(f)]));
  if (C.id < 0 || C.type < 0) throw new Error('The Items tab has no header row with "id" and "type".');
  const settings = parseSettings(settingsRows);

  const items = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const get = (f) => (C[f] >= 0 ? str(row[C[f]]) : '');
    const id = get('id');
    const type = get('type').toLowerCase();
    if (!id && !type && !get('title')) continue;
    const title = get('title');
    const start = normDate(get('date')) || null;
    const end = normDate(get('end')) || null;
    const status = /^done/i.test(get('status')) ? 'done' : 'open';
    const doneOn = normDate(get('done_on'));
    const item = {
      id, row: r + 1, type: type || 'other',
      area: get('area'), subject: get('subject'), title,
      start, end: end && start && end < start ? start : end,
      time: normTime(get('time')),
      minutes: toNumber(get('minutes')),
      hours: toNumber(get('hours')),
      cells: parseDays(get('days')),
      notes: get('notes'),
      calendar: (get('calendar') || 'auto').toLowerCase(),
      eventId: get('event_id'),
      synced: get('synced'),
      updated: get('updated'),
      priority: get('priority').toUpperCase(),
      doneOn,
    };
    // Names the views have always used.
    item.phase = item.area;
    item.task = title;
    item.status = { status, title, prio: /^P\d$/.test(item.priority) ? item.priority : '', note: item.notes, doneOn: doneOn ? shortLabel(doneOn) : '' };
    items.push(item);
  }

  // The day range: the plan dates from Settings, stretched to cover every item
  // and at least two weeks past today.
  const keys = [];
  for (const i of items) {
    if (i.start) keys.push(i.start);
    if (i.end) keys.push(i.end);
    keys.push(...Object.keys(i.cells));
  }
  keys.sort();
  const s0 = normDate(settings.plan_start?.value);
  const s1 = normDate(settings.plan_end?.value);
  const first = s0 || keys[0] || today;
  let last = [s1, keys.at(-1), addDays(today, 14)].filter(Boolean).sort().at(-1);
  const days = [];
  for (let k = first, n = 0; k <= last && n < 400; k = addDays(k, 1), n++) days.push({ key: k, label: shortLabel(k) });
  const dayByKey = Object.fromEntries(days.map((d) => [d.key, d]));

  const byType = (t) => items.filter((i) => i.type === t);
  return {
    header: C, settings, items, days, dayByKey, byType,
    study: byType('study'),
    logs: byType('log').filter((i) => i.subject),
    exams: byType('exam').filter((e) => e.start),
    other: items.filter((i) => !KNOWN_TYPES.includes(i.type)),
  };
}
