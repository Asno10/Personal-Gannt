// Google sign-in (Google Identity Services token flow) and the Sheets API calls.
// The access token lives in memory only; nothing from the sheet is stored.

import { CONFIG } from '../config.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

let token = null;
let tokenExpiry = 0;
let tokenClient = null;
let pending = null;

export class AuthError extends Error {}

export const configured = () => Boolean(CONFIG.clientId && CONFIG.spreadsheetId);
export const hasToken = () => Boolean(token) && Date.now() < tokenExpiry;

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
      scope: SCOPE,
      callback: (resp) => {
        const p = pending;
        pending = null;
        if (!p) return;
        if (resp.error) return p.reject(new AuthError(resp.error_description || resp.error));
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
  const { gantt, dailyPlan } = CONFIG.sheets;
  // A bare sheet name returns that sheet's whole used range.
  const ranges = [q(gantt), q(dailyPlan)];
  const qs = (render) => ranges.map((r) => 'ranges=' + encodeURIComponent(r)).join('&') + `&valueRenderOption=${render}&majorDimension=ROWS`;
  const [meta, shown, formulas] = await Promise.all([
    call('?fields=properties.title,sheets.properties(sheetId,title)'),
    call('/values:batchGet?' + qs('FORMATTED_VALUE')),
    call('/values:batchGet?' + qs('FORMULA')),
  ]);
  const ids = Object.fromEntries(meta.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
  return {
    title: meta.properties.title,
    sheetIds: ids,
    gantt: shown.valueRanges[0].values || [],
    ganttFormulas: formulas.valueRanges[0].values || [],
    daily: shown.valueRanges[1].values || [],
    dailyFormulas: formulas.valueRanges[1].values || [],
  };
}

// updates: [{ range: "'Gantt'!J5", value: 2.5 }]
export function writeCells(updates) {
  return call('/values:batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: updates.map((u) => ({ range: u.range, values: [[u.value]] })),
    }),
  });
}

// Inserts an empty row below `afterRow` (1-based) that inherits its formatting.
export function insertRowBelow(sheetId, afterRow) {
  return call(':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          insertDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: afterRow, endIndex: afterRow + 1 },
            inheritFromBefore: true,
          },
        },
      ],
    }),
  });
}
