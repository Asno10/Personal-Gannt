// ---------------------------------------------------------------------------
// Apps Script side: keeps the "Personal Gantt" calendar in step with the
// sheet every 10 minutes, whether or not the app is open.
//
// Install (once): in the sheet, Extensions > Apps Script, replace the code
// with this whole file and save. In the left bar, Services (+), choose
// "Google Calendar API" and Add (it must be named Calendar). Then choose
// "setup" in the function menu, Run, and allow access. After that it runs on
// its own. "Personal Gantt > Sync calendar now" in the sheet runs it on demand.
// ---------------------------------------------------------------------------

var PG_ITEMS = 'Items';
var PG_SETTINGS = 'Settings';
var PG_CAL_NAME = 'Personal Gantt';

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncPersonalGantt') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncPersonalGantt').timeBased().everyMinutes(10).create();
  var r = syncPersonalGantt();
  Logger.log('Installed. First sync: ' + JSON.stringify(r));
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Personal Gantt')
    .addItem('Sync calendar now', 'syncNowFromMenu')
    .addSeparator()
    .addItem('Connect the app', 'connectApp')
    .addItem('Reset app access', 'resetAppAccess')
    .addToUi();
}

function syncNowFromMenu() {
  var r = syncPersonalGantt();
  SpreadsheetApp.getActive().toast(r ? 'Added ' + r.inserted + ', updated ' + r.patched + ', removed ' + r.removed + '.' : 'A sync is already running.', 'Personal Gantt calendar');
}

function syncPersonalGantt() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return null;
  try {
    var ss = SpreadsheetApp.getActive();
    var settingsSheet = ss.getSheetByName(PG_SETTINGS);
    var settingsRows = settingsSheet.getDataRange().getDisplayValues();
    var settings = PGExport.parseSettings(settingsRows);
    var tz = settings.timezone || 'Europe/Istanbul';
    var calId = pgCalendarId_(settings, settingsSheet, settingsRows, tz);

    var items = PGExport.parseRows(ss.getSheetByName(PG_ITEMS).getDataRange().getDisplayValues());
    var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var from = PGExport.windowStart(settings, today);
    var desired = PGExport.desiredEvents(items, { timeZone: tz, from: from });
    var existing = pgListEvents_(calId, from);
    var plan = PGExport.diff(desired, existing, from);

    plan.remove.forEach(function (id) { pgCall_(function () { Calendar.Events.remove(calId, id); }, true); });
    plan.patch.forEach(function (p) { pgCall_(function () { Calendar.Events.patch(p[1], calId, p[0]); }); });
    plan.insert.forEach(function (b) { pgCall_(function () { Calendar.Events.insert(b, calId); }); });
    return { inserted: plan.insert.length, patched: plan.patch.length, removed: plan.remove.length };
  } finally {
    lock.releaseLock();
  }
}

// The calendar id from Settings, or a calendar named "Personal Gantt" that
// this account owns, or a new one; saved back to Settings when it changes.
function pgCalendarId_(settings, sheet, rows, tz) {
  var id = settings.calendar_id;
  var cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    cal = CalendarApp.getOwnedCalendarsByName(PG_CAL_NAME)[0] || CalendarApp.createCalendar(PG_CAL_NAME, { timeZone: tz });
    id = cal.getId();
    var row = -1;
    for (var i = 0; i < rows.length; i++) if (String(rows[i][0]).trim() === 'calendar_id') row = i + 1;
    if (row > 0) sheet.getRange(row, 2).setValue(id);
    else sheet.appendRow(['calendar_id', id, 'Filled in automatically; do not edit']);
  }
  return id;
}

function pgListEvents_(calId, from) {
  var out = [];
  var page = '';
  do {
    var opts = { singleEvents: true, showDeleted: false, maxResults: 2500, timeMin: from + 'T00:00:00Z' };
    if (page) opts.pageToken = page;
    var r = pgCall_(function () { return Calendar.Events.list(calId, opts); });
    out = out.concat(r.items || []);
    page = r.nextPageToken || '';
  } while (page);
  return out;
}

// Runs one Calendar request; waits and retries only when Google asks to slow
// down. Any other error is reported as it is.
function pgCall_(fn, okIfGone) {
  if (typeof Calendar === 'undefined') {
    throw new Error('The Google Calendar service is not added. In the Apps Script editor: Services (+), Google Calendar API, Add. Then run setup again.');
  }
  for (var attempt = 0; ; attempt++) {
    try {
      return fn() || {};
    } catch (e) {
      var msg = String(e && e.message || e);
      if (okIfGone && /not ?found|deleted|404|410/i.test(msg)) return {};
      if (attempt < 4 && /rate ?limit|quota|backend|503|500|try again/i.test(msg)) { Utilities.sleep(1000 * Math.pow(2, attempt)); continue; }
      throw new Error('Google Calendar: ' + msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Keeping the app signed in.
//
// Deployed as a web app that runs as you, this script hands the app a fresh
// Google access token whenever it asks, so the app never shows the sign-in
// screen. Each request must carry the key kept in Script Properties. "Connect
// the app" writes the web app address and the key to the Settings tab; the app
// reads them after one normal sign-in on each device. "Reset app access"
// replaces the key, which signs every device out until it signs in again.
//
// Anyone holding the key can read and change your sheets and calendars, so do
// not share the Settings tab. The app also needs the Google Sheets API: in the
// Apps Script editor, Services (+), Google Sheets API, Add (keep the name Sheets).
// ---------------------------------------------------------------------------

var PG_TOKEN_URL = 'app_token_url';
var PG_TOKEN_KEY = 'app_token_key';

function doGet(e) {
  var key = PropertiesService.getScriptProperties().getProperty(PG_TOKEN_KEY);
  var given = String((e && e.parameter && e.parameter.key) || '');
  var out = key && pgSameKey_(given, key) ? { token: ScriptApp.getOAuthToken() } : { error: 'denied' };
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function connectApp() {
  var ui = SpreadsheetApp.getUi();
  if (typeof Sheets === 'undefined') {
    ui.alert('Add the Google Sheets API first: in the Apps Script editor, Services (+), Google Sheets API, Add (keep the name Sheets). Then run this again.');
    return;
  }
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (err) {}
  if (!/\/exec$/.test(url)) {
    var r = ui.prompt('Connect the app', 'Paste the Web app URL from Deploy > Manage deployments (it ends in /exec).', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    url = r.getResponseText().trim();
  }
  if (!/^https:\/\/script\.google\.com\/[\w\/.-]+\/exec$/.test(url)) {
    ui.alert('That is not a web app URL ending in /exec. Deploy the script first: Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.');
    return;
  }
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(PG_TOKEN_KEY) || pgNewKey_();
  props.setProperty(PG_TOKEN_KEY, key);
  pgSetSetting_(PG_TOKEN_URL, url, 'Web app that keeps the app signed in; set by Connect the app');
  pgSetSetting_(PG_TOKEN_KEY, key, 'Keeps the app signed in. Do not share; Reset app access replaces it');
  ui.alert('Connected. Open the app and sign in once on each device; after that it stays signed in.');
}

function resetAppAccess() {
  var key = pgNewKey_();
  PropertiesService.getScriptProperties().setProperty(PG_TOKEN_KEY, key);
  pgSetSetting_(PG_TOKEN_KEY, key, 'Keeps the app signed in. Do not share; Reset app access replaces it');
  SpreadsheetApp.getUi().alert('The key was replaced. Every device is signed out until it signs in once more.');
}

function pgNewKey_() {
  return 'pg' + (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

// Compares in constant time, so the key cannot be guessed from response times.
function pgSameKey_(a, b) {
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function pgSetSetting_(key, value, note) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(PG_SETTINGS);
  var rows = sheet.getDataRange().getDisplayValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2, 1, 2).setValues([[value, note]]);
      return;
    }
  }
  sheet.appendRow([key, value, note]);
}
