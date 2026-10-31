// Google Calendar API calls: the Personal Gantt calendar the sync writes to
// (what goes in it is decided in gantt-export.js), and the person's other
// calendars, read for display.

// The ?v= must match the one app.js uses, or the browser loads a second copy
// of sheets.js that has no sign-in token.
import { accessToken, hasCalendarScope } from './sheets.js?v=23';
import { addDays } from './parse.js?v=23';

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
