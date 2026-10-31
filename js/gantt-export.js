// Personal Gantt calendar export: the single definition of what the "Personal
// Gantt" Google calendar should contain, given the Items and Settings tabs.
//
// This file is plain JavaScript with no imports, so the same code runs in two
// places: the web app (loaded as a classic script, read as window.PGExport)
// and the Google Apps Script attached to the sheet (apps-script/Code.gs holds
// a verbatim copy, checked by tools/check-apps-script.mjs). Because both build
// the same events from the same rows, they never fight over the calendar.
//
// The sync is stateless: every event carries the id of what it mirrors (pgId)
// and a fingerprint of its content (pgSig) as private extended properties.
// A run lists the calendar's events, then inserts what is missing, patches
// what changed, and deletes what no longer has a source. Nothing is written
// back to the sheet.

(function (root) {
  'use strict';

  var FOOTER = 'From Personal Gantt. Edit it in the app; changes made here are overwritten.';
  var FIELDS = ['id', 'type', 'area', 'subject', 'title', 'date', 'end', 'time', 'minutes', 'hours', 'days', 'status', 'done_on', 'priority', 'notes', 'calendar'];
  var DEFAULT_MIN = { task: 15, exam: 120 };
  var WORKOUT = { A: 'Workout A', B: 'Workout B', L: 'Light workout', W: 'Weigh-in' };

  function str(v) { return (v === undefined || v === null ? '' : String(v)).trim(); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // Date keys (YYYY-MM-DD) handled in UTC so the result never depends on the
  // time zone of the machine running this.
  function keyOf(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function addDays(k, n) {
    var p = k.split('-');
    return keyOf(new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)));
  }

  function normDate(v) {
    var s = str(v);
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
    if (m) return m[3] + '-' + pad(+m[2]) + '-' + pad(+m[1]);
    return '';
  }
  function normTime(v) {
    var m = str(v).match(/^(\d{1,2})[:.](\d{2})/);
    return m ? pad(+m[1]) + ':' + m[2] : '';
  }
  function num(v) {
    var n = parseFloat(str(v).replace(',', '.'));
    return isFinite(n) ? n : 0;
  }
  function parseDays(s) {
    var out = {};
    str(s).split(/[;\n]+/).forEach(function (part) {
      var m = part.trim().match(/^(\d{4}-\d{1,2}-\d{1,2})\s*[=:]\s*(.+)$/);
      if (m) out[normDate(m[1])] = m[2].trim();
    });
    return out;
  }
  function fmtHours(h) { return String(Math.round(h * 100) / 100); }

  // Rows of the Items tab (header row first, values as displayed) to items.
  function parseRows(rows) {
    rows = rows || [];
    var header = (rows[0] || []).map(function (c) { return str(c).toLowerCase(); });
    var col = {};
    FIELDS.forEach(function (f) { col[f] = header.indexOf(f); });
    if (col.id < 0 || col.type < 0) throw new Error('The Items tab has no header row with "id" and "type".');
    var items = [];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var get = function (f) { return col[f] >= 0 ? str(row[col[f]]) : ''; };
      var id = get('id');
      if (!id) continue; // a row without an id cannot be traced back, so it is not exported
      var start = normDate(get('date'));
      var end = normDate(get('end'));
      items.push({
        id: id,
        type: get('type').toLowerCase() || 'other',
        area: get('area'),
        subject: get('subject'),
        title: get('title'),
        start: start,
        end: end && start && end > start ? end : '',
        time: normTime(get('time')),
        minutes: num(get('minutes')),
        cells: parseDays(get('days')),
        notes: get('notes'),
        done: /^done/i.test(get('status')),
        calendar: (get('calendar') || 'auto').toLowerCase(),
      });
    }
    return items;
  }

  // Rows of the Settings tab (key, value) to { key: value }.
  function parseSettings(rows) {
    var out = {};
    (rows || []).forEach(function (r) {
      var k = str(r && r[0]);
      if (k && k !== 'key' && /^[a-z_]+$/.test(k)) out[k] = str(r[1]);
    });
    return out;
  }

  // The first day the sync manages. Events before it are left alone, so rows
  // archived out of Items keep their past events. At most 120 days back.
  function windowStart(settings, today) {
    var a = addDays(today, -120);
    var b = normDate(settings.plan_start);
    return b && b > a ? b : a;
  }

  function plusMinutes(day, time, minutes) {
    var p = day.split('-'), t = time.split(':');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], +t[0], +t[1]) + minutes * 60000);
    return keyOf(d) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':00';
  }

  function where(item) {
    return [item.area, item.subject].filter(function (x) { return x && !/^(exam|task|event|study|log|exercise)$/i.test(x); }).join(', ');
  }

  function allDay(body, first, last, quiet) {
    body.start = { date: first };
    body.end = { date: addDays(last || first, 1) };
    if (quiet) {
      // Planning entries: shown as free time, with no notification.
      body.transparency = 'transparent';
      body.reminders = { useDefault: false };
    }
    return body;
  }

  function titleOf(item) {
    var t = item.title || item.subject || 'Untitled';
    if (item.type === 'reading' && item.subject && t.toLowerCase().indexOf(item.subject.toLowerCase()) < 0) t = item.subject + ': ' + t;
    if (item.done && (item.type === 'task' || item.type === 'reading')) t = 'Done: ' + t;
    return t;
  }

  // One dated item (task, reading, exam, event, note, other) to an event body.
  function itemBody(item, day, timeZone) {
    var lines = [];
    var w = where(item);
    if (w) lines.push(w);
    if (item.notes) lines.push(item.notes);
    lines.push(FOOTER);
    var body = { summary: titleOf(item), description: lines.join('\n') };
    if (item.type === 'exam') body.colorId = '11';
    if (item.time) {
      var mins = item.minutes > 0 ? item.minutes : DEFAULT_MIN[item.type] || 60;
      var last = item.end && day === item.start ? item.end : day;
      body.start = { dateTime: day + 'T' + item.time + ':00', timeZone: timeZone };
      body.end = { dateTime: plusMinutes(last, item.time, mins), timeZone: timeZone };
      return body;
    }
    var planning = item.type !== 'exam' && item.type !== 'event';
    return allDay(body, day, day === item.start ? item.end : '', planning);
  }

  // A short fingerprint of an event's content.
  function signature(body) {
    var s = JSON.stringify(body);
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'v2:' + (h >>> 0).toString(36);
  }

  function tag(pgId, body) {
    var sig = signature(body);
    body.extendedProperties = { private: { pgId: pgId, pgSig: sig } };
    return { pgId: pgId, sig: sig, body: body };
  }

  // Everything the calendar should hold from `from` on, as [{ pgId, sig, body }].
  //   study     one all-day entry per day with the total and the subjects
  //   exercise  one all-day entry per session
  //   log       never (actual hours stay in the app)
  //   anything else with a date: a timed event when it has a time, otherwise
  //             an all-day entry; tasks planned on scattered days (X marks in
  //             "days") get one entry per day.
  // calendar = off in a row keeps it out.
  function desiredEvents(items, opts) {
    var tz = opts.timeZone, from = opts.from;
    var out = [];
    var studyByDay = {};

    items.forEach(function (item) {
      if (item.calendar === 'off' || item.type === 'log') return;
      var days = Object.keys(item.cells).sort();

      if (item.type === 'study') {
        days.forEach(function (k) {
          var h = num(item.cells[k]);
          if (k < from || !(h > 0)) return;
          (studyByDay[k] = studyByDay[k] || []).push([item.subject || item.title || 'Study', h]);
        });
        return;
      }

      if (item.type === 'exercise') {
        days.forEach(function (k) {
          var code = str(item.cells[k]).toUpperCase();
          if (k < from || !code) return;
          var lines = [item.subject, item.title].filter(Boolean);
          lines.push(FOOTER);
          var body = allDay({ summary: WORKOUT[code] || 'Exercise ' + code, description: lines.join('\n'), colorId: '2' }, k, '', true);
          out.push(tag(item.id + '@' + k, body));
        });
        return;
      }

      if (item.start) {
        if ((item.end || item.start) < from) return;
        out.push(tag(item.id, itemBody(item, item.start, tz)));
        return;
      }
      // No date: one entry per marked day.
      days.forEach(function (k) {
        if (k < from || !str(item.cells[k])) return;
        out.push(tag(item.id + '@' + k, itemBody(item, k, tz)));
      });
    });

    Object.keys(studyByDay).sort().forEach(function (k) {
      var list = studyByDay[k];
      var total = list.reduce(function (s, x) { return s + x[1]; }, 0);
      var summary = 'Study ' + fmtHours(total) + ' h: ' + list.map(function (x) { return x[0] + ' ' + fmtHours(x[1]); }).join(', ');
      var lines = list.map(function (x) { return x[0] + ': ' + fmtHours(x[1]) + ' h'; });
      lines.push(FOOTER);
      out.push(tag('study@' + k, allDay({ summary: summary, description: lines.join('\n'), colorId: '9' }, k, '', true)));
    });
    return out;
  }

  // What to change, given the desired events and the calendar's current events
  // (as returned by the Calendar API from `from` on).
  //   insert: [body]   patch: [[eventId, body]]   remove: [eventId]
  function diff(desired, existing, from) {
    var want = {};
    desired.forEach(function (d) { want[d.pgId] = d; });
    var seen = {};
    var plan = { insert: [], patch: [], remove: [] };
    (existing || []).forEach(function (ev) {
      if (!ev || ev.status === 'cancelled') return;
      var p = ev.extendedProperties && ev.extendedProperties.private || {};
      if (!p.pgId) return; // not made by the sync: never touched
      var d = want[p.pgId];
      var startKey = String((ev.start && (ev.start.date || ev.start.dateTime)) || '').slice(0, 10);
      if (!d || seen[p.pgId]) {
        if (startKey >= from || seen[p.pgId]) plan.remove.push(ev.id);
        return;
      }
      seen[p.pgId] = true;
      if (p.pgSig !== d.sig) plan.patch.push([ev.id, d.body]);
    });
    desired.forEach(function (d) { if (!seen[d.pgId]) plan.insert.push(d.body); });
    return plan;
  }

  var api = {
    parseRows: parseRows,
    parseSettings: parseSettings,
    windowStart: windowStart,
    desiredEvents: desiredEvents,
    diff: diff,
    addDays: addDays,
    FOOTER: FOOTER,
  };
  root.PGExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
