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
  SpreadsheetApp.getUi().createMenu('Personal Gantt').addItem('Sync calendar now', 'syncNowFromMenu').addToUi();
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
