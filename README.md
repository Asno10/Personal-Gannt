# Personal Gantt

A small web app over the "Personal Gantt" Google Sheet: a day view with study hours, tasks and the next exam countdown, a scrollable timeline, exam cards and a task list. Changes are written straight back to the sheet.

The site holds code only. The sheet is read in the browser after Google sign-in, so the data stays private even though the site is public.

## Setup

1. In Google Cloud, enable the Google Sheets API and create an OAuth client ID of type Web application, with `https://<github-user>.github.io` as an authorized JavaScript origin.
2. Put the client ID in `config.js`.
3. Publish with GitHub Pages from the `main` branch, root folder.

## How the sheet is read

The parser finds columns by their header labels (Phase, Subject, Task, Start, End, Hours) and the day columns by their dates, and groups rows by the single-cell section titles (Exams, Todoist, Calendar events, Fixed commitments, Exercise plan). New rows, sections and days need no code changes. Cells holding formulas are never overwritten.

Marking a task done rewrites its status note, for example `(open, scheduled Sat 24 Oct)` becomes `(done 24 Oct)`. Todoist itself is not updated.
