// Turns the raw "Gantt" and "Daily Plan" sheet values into a structured plan.
// The parser reads the layout by its labels (Phase, Subject, Task, Start, End,
// Hours and the date header), so adding rows, sections or days in the sheet
// does not require code changes.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export const pad = (n) => String(n).padStart(2, '0');
export const dateKey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
export const keyOfDate = (dt) => dateKey(dt.getFullYear(), dt.getMonth(), dt.getDate());
export const dateOfKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};

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

export function parseDayMonth(s) {
  const m = str(s).match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?(?:\s+(\d{4}))?/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2].toLowerCase());
  if (mi < 0) return null;
  return { d: +m[1], m: mi, y: m[3] ? +m[3] : null };
}

export function toNumber(v) {
  const s = str(v).replace(',', '.');
  if (s === '') return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function classify(title) {
  const t = title.toLowerCase();
  if (/\blog\b|actual hours/.test(t)) return 'log';
  if (/exercise|workout|training|gym/.test(t)) return 'exercise';
  if (/todoist|to-?do|tasks?\b/.test(t)) return 'tasks';
  if (/calendar|events?\b|deadline|holiday/.test(t)) return 'events';
  if (/commitment|fixed/.test(t)) return 'commitments';
  if (/^exams?\b/.test(t)) return 'exams';
  return 'other';
}

// Splits a task cell such as "Do X (P1, open, scheduled Sat 24 Oct)" into its
// parts: title "Do X", priority "P1", status "open" and note "scheduled Sat 24 Oct".
// The status group is the last parenthesis holding "open" or "done"; failing that,
// a trailing parenthesis is read as the note.
export function splitTask(text) {
  const t = str(text);
  const groups = [...t.matchAll(/\(([^()]*)\)/g)];
  let g = [...groups].reverse().find((m) => /(^|[,;]\s*)(open|done)\b/i.test(m[1].trim()));
  if (!g) {
    const last = groups[groups.length - 1];
    if (last && last.index + last[0].length >= t.length) g = last;
  }
  if (!g) return { title: t, status: 'open', prio: '', statusPart: '', note: '', doneOn: '', raw: t };
  const title = (t.slice(0, g.index) + t.slice(g.index + g[0].length)).replace(/\s+/g, ' ').trim();
  let prio = '';
  let statusPart = '';
  const rest = [];
  for (const p of g[1].split(/\s*[,;]\s*/).map((x) => x.trim()).filter(Boolean)) {
    if (!prio && /^P\d$/i.test(p)) prio = p.toUpperCase();
    else if (!statusPart && /^(open|done)\b/i.test(p)) statusPart = p;
    else rest.push(p);
  }
  const status = /^done/i.test(statusPart) ? 'done' : 'open';
  const doneOn = status === 'done' ? (statusPart.match(/(\d{1,2}\s+[A-Za-z]{3})/) || [])[1] || '' : '';
  return { title, status, prio, statusPart, note: rest.join('; '), doneOn, raw: t };
}

// Rebuilds the task cell from its parts, in the same convention.
export function composeTask({ title, prio, statusPart, note }) {
  const parts = [prio, statusPart || 'open', note].map((x) => str(x)).filter(Boolean);
  return `${str(title)} (${parts.join(', ')})`;
}

export function parseGantt(rows, formulas = []) {
  rows = rows || [];
  const title = str((rows[0] || [])[0]);
  const subtitle = str((rows[1] || [])[0]);
  const yearMatch = (title + ' ' + subtitle).match(/\b(20\d\d)\b/);
  let year = yearMatch ? +yearMatch[1] : new Date().getFullYear();

  const h = rows.findIndex((r) => str((r || [])[0]).toLowerCase() === 'phase');
  if (h < 0) throw new Error('The Gantt sheet has no header row starting with "Phase".');
  const header = rows[h].map(str);
  const dowRow = (rows[h + 1] || []).map(str);
  const col = (name) => header.findIndex((c) => c.toLowerCase() === name);
  const C = {
    phase: Math.max(col('phase'), 0),
    subject: col('subject'),
    task: col('task'),
    start: col('start'),
    end: col('end'),
    hours: col('hours'),
  };

  const days = [];
  const firstDay = header.findIndex((c, i) => i > C.task && parseDayMonth(c));
  let prevM = null;
  for (let c = firstDay; c >= 0 && c < header.length; c++) {
    const p = parseDayMonth(header[c]);
    if (!p) break;
    if (prevM !== null && p.m < prevM) year++;
    prevM = p.m;
    days.push({ col: c, key: dateKey(year, p.m, p.d), label: header[c], dow: dowRow[c] || '' });
  }
  const dayByKey = Object.fromEntries(days.map((d) => [d.key, d]));
  const firstYear = days.length ? +days[0].key.slice(0, 4) : year;
  const firstMonth = days.length ? +days[0].key.slice(5, 7) - 1 : 0;

  const resolveDate = (s) => {
    const p = parseDayMonth(s);
    if (!p) return null;
    if (p.y) return dateKey(p.y, p.m, p.d);
    const y = p.m < firstMonth - 2 ? firstYear + 1 : firstYear;
    return dateKey(y, p.m, p.d);
  };

  const isFormula = (r, c) => str(((formulas[r] || [])[c])).startsWith('=');

  const sections = [];
  let section = { title: 'Study plan', type: 'study', items: [], notes: [], headerRow: null };
  sections.push(section);
  const summary = [];
  let inSummary = false;
  let totalsRow = null;

  for (let r = h + 2; r < rows.length; r++) {
    const row = (rows[r] || []).map(str);
    const filled = row.filter((c) => c !== '');
    if (!filled.length) continue;
    const a = row[C.phase] || '';

    if (inSummary) {
      if (row[C.subject] && row[C.task]) summary.push({ subject: row[C.subject], when: row[C.task], planned: row[C.start] });
      continue;
    }
    if (a && filled.length === 1) {
      if (/^note\b/i.test(a)) {
        section.notes.push(a.replace(/^note:\s*/i, ''));
        continue;
      }
      section = { title: a, type: classify(a), items: [], notes: [], headerRow: r + 1 };
      sections.push(section);
      continue;
    }
    if (!a && /^subject$/i.test(row[C.subject] || '')) {
      inSummary = true;
      continue;
    }
    if (!a && /total/i.test(row[C.task] || '')) {
      totalsRow = r + 1;
      continue;
    }

    const cells = {};
    for (const d of days) {
      const v = row[d.col];
      if (v) cells[d.key] = v;
    }
    const item = {
      row: r + 1,
      section: section.type,
      sectionTitle: section.title,
      phase: a,
      subject: row[C.subject] || '',
      task: row[C.task] || '',
      start: resolveDate(row[C.start]),
      end: resolveDate(row[C.end]),
      hours: C.hours >= 0 ? toNumber(row[C.hours]) : 0,
      cells,
      lockedDates: isFormula(r, C.start) || isFormula(r, C.end),
    };
    if (section.type === 'tasks') Object.assign(item, { status: splitTask(item.task) });
    section.items.push(item);
  }

  const itemsOf = (type) => sections.filter((s) => s.type === type).flatMap((s) => s.items);
  const study = itemsOf('study').filter((i) => Object.keys(i.cells).length || i.hours);
  const exams = itemsOf('exams').map((e) => {
    const s = summary.find((x) => x.subject === e.subject);
    const time = s ? (s.when.match(/\b(\d{1,2}:\d{2})\b/) || [])[1] || '' : '';
    return { ...e, time };
  });

  // Study log: one row per subject holding the hours actually studied each day.
  const logs = itemsOf('log').filter((i) => i.subject);

  return { title, subtitle, header: C, days, dayByKey, sections, study, exams, logs, summary, totalsRow, resolveDate };
}

export function parseDailyPlan(rows, formulas = []) {
  rows = rows || [];
  const header = (rows[0] || []).map(str);
  const col = (re) => header.findIndex((c) => re.test(c));
  const C = {
    date: col(/^date$/i),
    commitments: col(/commit/i),
    studyNote: col(/study/i),
    planned: col(/planned/i),
    exercise: col(/exercise/i),
  };
  const byKey = {};
  for (let r = 1; r < rows.length; r++) {
    const row = (rows[r] || []).map(str);
    const p = parseDayMonth(row[C.date]);
    if (!p || !p.y) continue;
    const k = dateKey(p.y, p.m, p.d);
    const field = (name) => ({
      value: C[name] >= 0 ? row[C[name]] || '' : '',
      col: C[name],
      locked: C[name] < 0 || str(((formulas[r] || [])[C[name]])).startsWith('='),
    });
    byKey[k] = {
      row: r + 1,
      commitments: field('commitments'),
      studyNote: field('studyNote'),
      exercise: field('exercise'),
      planned: toNumber(row[C.planned]),
    };
  }
  return { header: C, byKey };
}
