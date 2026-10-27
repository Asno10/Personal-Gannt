// Google Calendar: keeps a "Personal Gantt" calendar in step with the timed
// items in the sheet, and reads the person's other calendars for display.
//
// Every event the app creates carries the item's id in a private extended
// property (pgId), so an event can always be traced back to its row, a second
// device never creates a duplicate, and an event whose row was deleted is
// removed on the next sync.

// The ?v= must match the one app.js uses, or the browser loads a second copy
// of sheets.js that has no sign-in token.
import { accessToken, hasCalendarScope } from './sheets.js?v=15';
import { addDays } from './parse.js?v=15';

const API = 'https://www.googleapis.com/calendar/v3';

export class CalendarOff extends Error {}

async function call(path, { method = 'GET', body, ok404 = false } = {}) {
  const token = accessToken();
  if (!token) throw new CalendarOff('Not signed in.');
  if (!hasCalendarScope()) throw new CalendarOff('Calendar access was not granted at sign-in.');
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 404 || res.status === 410) && ok404) return null;
  if (res.status === 204) return {};
  if (!res.ok) {
    let msg = `Google Calendar returned ${res.status}.`;
    try {
      const b = await res.json();
      if (b?.error?.message) msg = b.error.message;
    } catch {}
    if (res.status === 403 && /has not been used|disabled|not enabled/i.test(msg)) {
      throw new CalendarOff('The Google Calendar API is not enabled for this app yet.');
    }
    throw new Error(msg);
  }
  return res.json();
}

const enc = encodeURIComponent;

export async function listCalendars() {
  const out = [];
  let page = '';
  do {
    const r = await call(`/users/me/calendarList?maxResults=250${page ? '&pageToken=' + enc(page) : ''}`);
    out.push(...(r.items || []));
    page = r.nextPageToken || '';
  } while (page);
  return out.map((c) => ({ id: c.id, name: c.summaryOverride || (c.primary ? 'Main calendar' : c.summary), color: c.backgroundColor, primary: Boolean(c.primary), role: c.accessRole }));
}

// The calendar the app writes to: the one saved in Settings, else one with the
// configured name that this account owns, else a new one.
export async function ensureCalendar(savedId, name, timeZone, calendars) {
  if (savedId) {
    const c = await call(`/calendars/${enc(savedId)}`, { ok404: true });
    if (c) return { id: c.id, created: false };
  }
  const owned = (calendars || []).find((c) => c.name === name && c.role === 'owner');
  if (owned) return { id: owned.id, created: false };
  const c = await call('/calendars', { method: 'POST', body: { summary: name, timeZone, description: 'Timed items from the Personal Gantt app. Edit them in the app; changes here are overwritten.' } });
  return { id: c.id, created: true };
}

export async function listEvents(calId, fromKey, toKey, { privateProp } = {}) {
  const out = [];
  let page = '';
  const base = `/calendars/${enc(calId)}/events?singleEvents=true&maxResults=2500&showDeleted=false`
    + (fromKey ? `&timeMin=${enc(fromKey + 'T00:00:00Z')}` : '')
    + (toKey ? `&timeMax=${enc(addDays(toKey, 1) + 'T23:59:59Z')}` : '')
    + (privateProp ? `&privateExtendedProperty=${enc(privateProp)}` : '');
  do {
    const r = await call(base + (page ? '&pageToken=' + enc(page) : ''));
    out.push(...(r.items || []));
    page = r.nextPageToken || '';
  } while (page);
  return out;
}

export const insertEvent = (calId, body) => call(`/calendars/${enc(calId)}/events`, { method: 'POST', body });
export const patchEvent = (calId, id, body) => call(`/calendars/${enc(calId)}/events/${enc(id)}`, { method: 'PATCH', body, ok404: true });
export const deleteEvent = (calId, id) => call(`/calendars/${enc(calId)}/events/${enc(id)}`, { method: 'DELETE', ok404: true });

// ---------- Items to events ----------

const DEFAULT_MIN = { task: 15, exam: 120 };

// Whether an item belongs in the calendar: anything with a time, plus every
// exam and event (as an all-day entry when it has no time). "off" opts out.
export function wantsEvent(item) {
  if (item.calendar === 'off' || !item.start || !item.id) return false;
  if (['study', 'log', 'exercise', 'note'].includes(item.type)) return Boolean(item.time) && item.calendar === 'on';
  return Boolean(item.time) || item.type === 'exam' || item.type === 'event' || item.calendar === 'on';
}

function plusMinutes(dateKey, time, minutes) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm) + minutes * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00`;
}

export function eventBody(item, timeZone) {
  const lines = [];
  const where = [item.area, item.subject].filter((x) => x && !/^(exam|task|event)$/i.test(x)).join(', ');
  if (where) lines.push(where);
  if (item.notes) lines.push(item.notes);
  lines.push('From Personal Gantt. Edit it in the app; changes made here are overwritten.');
  const body = {
    summary: item.title || item.subject || 'Untitled',
    description: lines.join('\n'),
    extendedProperties: { private: { pgId: item.id } },
  };
  if (item.time) {
    const mins = item.minutes > 0 ? item.minutes : DEFAULT_MIN[item.type] || 60;
    body.start = { dateTime: `${item.start}T${item.time}:00`, timeZone };
    body.end = { dateTime: plusMinutes(item.end && item.end > item.start ? item.end : item.start, item.time, mins), timeZone };
  } else {
    body.start = { date: item.start };
    body.end = { date: addDays(item.end || item.start, 1) };
  }
  if (item.type === 'exam') body.colorId = '11';
  return body;
}

// A short fingerprint of what the event should look like, stored in the row,
// so the app only touches events whose item has changed.
export function signature(body) {
  const s = JSON.stringify([body.summary, body.description, body.start, body.end, body.colorId || '']);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'v1:' + (h >>> 0).toString(36);
}

// Events from other calendars, flattened per day for the views.
export function toDayEvents(ev, cal) {
  if (ev.status === 'cancelled') return [];
  const allDay = Boolean(ev.start?.date);
  const startKey = allDay ? ev.start.date : (ev.start?.dateTime || '').slice(0, 10);
  if (!startKey) return [];
  const endKey = allDay ? addDays(ev.end?.date || addDays(startKey, 1), -1) : (ev.end?.dateTime || '').slice(0, 10) || startKey;
  const time = allDay ? '' : localTime(ev.start.dateTime);
  const endTime = allDay ? '' : localTime(ev.end?.dateTime);
  const out = [];
  for (let k = startKey, n = 0; k <= endKey && n < 31; k = addDays(k, 1), n++) {
    out.push({ key: k, id: ev.id, calId: cal.id, calName: cal.name, color: cal.color, title: ev.summary || '(No title)', time: k === startKey ? time : '', endTime: k === endKey ? endTime : '', allDay, location: ev.location || '' });
  }
  return out;
}

// "2026-11-03T13:15:00+03:00" shown as the device's local time.
function localTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
