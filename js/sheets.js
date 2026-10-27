// Google sign-in (Google Identity Services token flow) and the Sheets API calls.
// The access token lives in memory only; nothing from the sheet is stored.

import { CONFIG } from '../config.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar';

let token = null;
let tokenExpiry = 0;
let tokenClient = null;
let pending = null;
let calendarGranted = false;

export class AuthError extends Error {}

export const configured = () => Boolean(CONFIG.clientId && CONFIG.spreadsheetId);
export const hasToken = () => Boolean(token) && Date.now() < tokenExpiry;
export const accessToken = () => (hasToken() ? token : null);
export const hasCalendarScope = () => calendarGranted;

function waitForGis() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - started > 10000) return reject(new Error('Google sign-in did not load. Check the connection and reload.'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

export async function signIn({ silent = false } = {}) {
  await waitForGis();
  if (!tokenClient) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.clientId,
      scope: `${SHEETS_SCOPE} ${CAL_SCOPE}`,
      include_granted_scopes: true,
      callback: (resp) => {
        const p = pending;
        pending = null;
        if (!p) return;
        if (resp.error) return p.reject(new AuthError(resp.error_description || resp.error));
        const oa = window.google.accounts.oauth2;
        if (!oa.hasGrantedAllScopes(resp, SHEETS_SCOPE)) return p.reject(new AuthError('Access to Google Sheets was not granted. Sign in again and allow it.'));
        calendarGranted = oa.hasGrantedAllScopes(resp, CAL_SCOPE);
        token = resp.access_token;
        tokenExpiry = Date.now() + (Number(resp.expires_in) - 60) * 1000;
        p.resolve();
      },
      error_callback: (err) => {
        const p = pending;
        pending = null;
        if (p) p.reject(new AuthError(err?.message || err?.type || 'Sign-in was closed.'));
      },
    });
  }
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: silent ? '' : 'select_account' });
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token, () => {});
  token = null;
  tokenExpiry = 0;
  calendarGranted = false;
}

async function call(path, options = {}) {
  if (!hasToken()) throw new AuthError('Session expired.');
  const res = await fetch(API + encodeURIComponent(CONFIG.spreadsheetId) + path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 401) {
    token = null;
    throw new AuthError('Session expired.');
  }
  if (!res.ok) {
    let msg = `Google Sheets returned ${res.status}.`;
    try {
      const body = await res.json();
      if (body?.error?.message) msg = body.error.message;
    } catch {}
    if (res.status === 403) msg += ' Make sure you signed in with the account that owns the sheet.';
    throw new Error(msg);
  }
  return res.json();
}

const q = (name) => `'${name.replace(/'/g, "''")}'`;
export const a1 = (sheet, cell) => `${q(sheet)}!${cell}`;

export async function loadAll() {
  const { items, settings } = CONFIG.sheets;
  const ranges = [q(items), q(settings)];
  const qs = ranges.map((r) => 'ranges=' + encodeURIComponent(r)).join('&') + '&valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS';
  const [meta, shown] = await Promise.all([
    call('?fields=properties.title,sheets.properties(sheetId,title)'),
    call('/values:batchGet?' + qs),
  ]);
  const ids = Object.fromEntries(meta.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
  if (ids[items] === undefined) throw new Error(`The sheet has no "${items}" tab.`);
  return {
    title: meta.properties.title,
    sheetIds: ids,
    items: shown.valueRanges[0].values || [],
    settings: shown.valueRanges[1].values || [],
  };
}

// The id column as it is now, so writes land on the right rows even if rows
// were added or removed since the last load (by Claude, another device, or by hand).
export async function readIdColumn(col) {
  const r = await call('/values/' + encodeURIComponent(a1(CONFIG.sheets.items, `${col}:${col}`)) + '?majorDimension=COLUMNS');
  const list = (r.values && r.values[0]) || [];
  const map = new Map();
  list.forEach((v, i) => { if (i > 0 && v) map.set(String(v).trim(), i + 1); });
  return { map, length: list.length };
}

// updates: [{ range: "'Items'!J5", value: 2.5 }]
export function writeCells(updates) {
  return call('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: updates.map((u) => ({ range: u.range, values: [[u.value]] })),
    }),
  });
}

// Writes whole rows below the last used row of the Items tab.
export function appendRows(rows) {
  return call('/values/' + encodeURIComponent(a1(CONFIG.sheets.items, 'A1')) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
    method: 'POST',
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  });
}

// Deletes one row (1-based).
export function deleteRow(sheetId, row) {
  return call(':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }],
    }),
  });
}
