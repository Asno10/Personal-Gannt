# Personal Gantt

A small web app over the "Personal Gantt" Google Sheet: a day view with study hours, readings, tasks, calendar events and the next exam countdown, a scrollable timeline, exam cards and a task list. Changes are written straight back to the sheet, and timed items are kept in step with a "Personal Gantt" Google calendar.

The site holds code only. The sheet and calendars are read in the browser after Google sign-in, so the data stays private even though the site is public.

## Setup

1. In Google Cloud, enable the **Google Sheets API** and the **Google Calendar API**, and create an OAuth client ID of type Web application, with `https://<github-user>.github.io` as an authorized JavaScript origin.
2. Put the client ID in `config.js`.
3. Publish with GitHub Pages from the `main` branch, root folder.

## The database

The **Items** tab is the single source of truth: one row per item, with columns found by their header names.

| Column | Meaning |
|---|---|
| id | Unique and never reused: a type letter and 6 characters, such as `t-4k9x2a` |
| type | `study`, `log`, `reading`, `task`, `exam`, `event`, `exercise` or `note`. Any other type still shows, under Other |
| area, subject, title | What the item is and where it belongs |
| date, end | `YYYY-MM-DD`; `end` only for multi-day items |
| time, minutes | `HH:MM` in Istanbul time, and duration |
| hours | Planned hours of a reading |
| days | Per-day values: planned hours (study), studied hours (log), sessions (exercise) or X marks (scattered task days), as `2026-10-27=2.5; 2026-10-28=1` |
| status, done_on, priority | `open` or `done`, the finish date, `P1` to `P3` |
| notes | Free text |
| calendar | `auto` (default) or `off` |
| event_id, synced, updated | Managed by the app |

The **Settings** tab holds the plan dates and the id of the Personal Gantt calendar. The **Gantt** tab is a formula view of Items, for reading in Google Sheets.

Writes are addressed by id: before each save the app reads the id column and finds each item's current row, so rows added or removed elsewhere (by hand, by Claude, or on another device) never receive another item's change.

## Calendar sync

Every item with a time, and every exam and event, has an event in the Personal Gantt calendar unless its `calendar` column says `off`. On each load the app creates, moves or deletes events to match the table, and removes events whose row is gone. Each event carries its item id as a private extended property, so two devices never create duplicates. Events in your other calendars (holiday calendars excluded) show read-only on the Day view and the Timeline; the Account sheet picks which.

## Publishing an update

Raise the number in `version.json`, `BUILD` in `js/app.js` and the `?v=` values in `index.html` and the imports at the top of `js/app.js` and `js/calendar.js` together. Open copies of the app see the new number and reload themselves.
