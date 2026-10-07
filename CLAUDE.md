# Birdview Daily Digest — Project Context

## What this is

A Google Apps Script automation for SES (Anders, TW Project Management Inc.,
anders@theworks.pro) that:

1. Pulls open, Flat Fee project & task data from SES's Birdview (EasyProjects
   v2 API) once a day.
2. Computes a reconstructed "Expected Profit %" per project (Birdview doesn't
   expose this via API).
3. Flags tasks/projects that need a PM's attention.
4. Emails each Project Manager (PM) a digest — a same-day "urgent" alert for
   brand-new issues, and a Monday "weekly digest" summarizing everything
   currently flagged.

**Status: mid-trial**, running on Anders's own personal/consulting Google
Workspace (not SES's), pulling live data from SES's Birdview via OAuth. Only
Anders is in `PM_EMAIL_MAP` right now — see "Next steps" below for the
rollout plan to all 13 PMs.

This project was originally built interactively directly in the Apps Script
web editor; it's now managed here and synced to Apps Script with `clasp`
(see "Syncing with Apps Script" below).

## File layout

Apps Script shares ONE global scope across all `.gs` files, so functions and
constants in any file are callable from any other — no imports. Keep all
top-level statements to plain literals (no cross-file references at load
time), since file load order isn't something to rely on.

| File | Contents |
|---|---|
| `Config.gs` | All shared constants (Birdview IDs, thresholds, snapshot names), `ADMIN_EMAIL`, `PM_EMAIL_MAP` + `getPmEmail_`. Setup checklist in the header. |
| `Triggers.gs` | The staged pipeline entry points (`runNightlyDigest`, `runNightlyAlerts`, `runWeeklyDigest`), `runWithErrorAlert_` / `notifyAdmin_`, the `checkPipelineHealth_` watchdog, `setupTriggers`, `removeTriggers`, `listTriggers`. |
| `Birdview.gs` | OAuth (`authorize`, `authCallback`, `resetBirdviewAuth`), request/paging helpers, project/PM/user-rate lookups, task/hours/assignee helpers, URL builders. |
| `Ledger.gs` | Ledger spreadsheet access (`LEDGER_SPREADSHEET_ID` Script Property, falling back to the trial sheet's URL), `setupLedgerSpreadsheet()`, ledger backfill/nightly update + rollover, integrity check, `calculateExpectedProfitPercent_`. |
| `Dataset.gs` | `buildNightlyData_()` (single pass → task rows + phase rows), `buildTaskFlags_`, all Drive snapshot helpers. |
| `DailyAlerts.gs` | Profit-drop + hours-exceeded detection, shared email helpers (`escapeHtml_`, `sendDigestEmail_`), the single daily urgent email (one section per candidate alert rule) and its stage-2 orchestrator `sendDailyUrgentAlertsFromSnapshot_()`, and `seedNotifiedTracking()` (rollout/migration). |
| `PhaseAlerts.gs` | Phase aggregation (built during the nightly build), `PhaseThresholdNotified` tracking, `findPhasesOverThreshold_` — feeds the phase section of the daily urgent email. |
| `WeeklyDigest.gs` | Monday digest: the three task lists (0 hours left + overdue / 0 hours left / overdue), profit summary, email; plus the admin "coverage report" (`sendCoverageReport_`). |
| `Tests.gs` | Manual-only helpers: `testNightlyBuild`, `testDailyUrgentAlerts`, `testWeeklyDigest`, `testLedgerRolloverAndIntegrity`, `verifyExpectedProfitPercent`, `printSesPmLookup`, the TESTING-ONLY tracking reset. |
| `docs/` | Reference only (not pushed to Apps Script): Birdview API v2 OpenAPI spec + notes, and the SES Workspace migration checklist. See "Reference docs" below. |
| `appsscript.json` | Manifest. Declares the `OAuth2` library dependency (Apps Script "OAuth2 for Apps Script") used for the Birdview Authorization Code Grant flow. Time zone `America/Vancouver`. |

## Setup checklist (fresh environment)

**Script Properties** (Project Settings → Script Properties in the Apps
Script editor — never commit these anywhere):
- `BIRDVIEW_CLIENT_ID`, `BIRDVIEW_CLIENT_SECRET` — from Birdview's OAuth
  app registration (Automatic Consent Grant: on; Client Credentials Grant:
  off).
- `GEMINI_API_KEY` — no longer used (the weekly digest stopped calling
  Gemini on 2026-09-28); safe to delete from Script Properties.
- `LEDGER_SPREADSHEET_ID` — set automatically by `setupLedgerSpreadsheet()`.
  If absent, the script falls back to the trial deployment's sheet URL
  (`LEGACY_LEDGER_SHEET_URL` in Ledger.gs).
- `LAST_SUCCESS_<stage>` — written automatically by `runWithErrorAlert_`
  (ISO timestamp per stage), read by the watchdog. Don't edit.

**Google Sheet** (the "ledger" spreadsheet — create it with
`setupLedgerSpreadsheet()` on a fresh deployment), with these tabs:
- `TimeLogDetail` — TimeEntryId | ProjectId | Cost | LastModificationDate
- `LockedTotals` — ProjectId | LockedLaborCost | LockedThroughDate
- `HoursExceededNotified` — TaskId | NotifiedDate
- `PhaseThresholdNotified` — TaskId | NotifiedDate

**One-time manual runs** (via the Apps Script editor's Run dropdown) — for a
full move to a new account/Workspace follow `docs/migration-checklist.md`:
0. `setupLedgerSpreadsheet()` — fresh deployment only.
1. `authorize()` — logs an authorization URL; open it in the SAME Chrome
   window/Google account signed into the Apps Script editor (Birdview's own
   login can be a different account — only the Google/callback session
   matters).
2. `backfillProfitabilityLedger()` — seeds `LockedTotals`/`TimeLogDetail`
   for all currently-open Flat Fee projects.
3. `setupTriggers()` — installs the three time-based triggers. Re-run it
   whenever the trigger schedule in code changes.
4. `seedNotifiedTracking()` — after `testNightlyBuild()`, before any PM is
   added to `PM_EMAIL_MAP` (see "Notification / snapshot patterns").

**Ongoing — staged pipeline** (each stage hands off via today's Drive
snapshot, so no execution both builds data and sends email):

| Trigger | When | Does |
|---|---|---|
| `runNightlyDigest` | ~2am, skips Sat/Sun | ledger update + `buildNightlyData_()` → saves `phase-snapshot-<date>.json` then `digest-snapshot-<date>.json` (task snapshot saved LAST = "build finished" marker). No email. |
| `runNightlyAlerts` | ~4am, skips Sat/Sun | reads today's snapshots → `sendDailyUrgentAlertsFromSnapshot_()` (one urgent email per PM, one section per alert rule). No Birdview calls. |
| `runWeeklyDigest` | ~6am Mondays | reads today's task snapshot → weekly emails. No Birdview or Gemini calls, no ledger update. |

Every trigger entry point runs inside `runWithErrorAlert_()`, which emails
`ADMIN_EMAIL` the error + stack trace and re-throws (so Executions still
shows Failed). Stages 2/3 use `requireTodaysSnapshot_()`, which emails
`ADMIN_EMAIL` if the build stage didn't finish (this also covers a hard
execution timeout, which can't be caught). The **watchdog**
(`checkPipelineHealth_`, called at the start of every weekday
`runNightlyDigest`) emails `ADMIN_EMAIL` if any of the three triggers is
missing or if `runNightlyAlerts` / `runWeeklyDigest` haven't completed
within `PIPELINE_MAX_DAYS_SINCE_SUCCESS` (4 / 8 days). It never throws. Not
covered: ALL triggers deleted at once (nothing runs to notice). On Mondays
the weekly stage also sends `ADMIN_EMAIL` a **coverage report** when any
open project is in no digest (no "SES PM" set, or a PM missing from
`PM_EMAIL_MAP`). Manual recovery: run
`testNightlyBuild()`, then `testDailyUrgentAlerts()` /
`testWeeklyDigest()`.

## Birdview / EasyProjects API facts (hard-won, don't re-derive)

- Base URL: `https://ses.go.easyprojects.net`. OAuth endpoints:
  `/OAuth2/Authorize`, `/OAuth2/Token`.
- Project status "Open" = `ProjectStatusId` 4 (field name is
  `ProjectStatusId`, not `Id`).
- Billing type "Flat Fee" is internally named `ProjectFixedCost` = ID 5.
  T&M projects are explicitly out of scope for now.
- Custom field "SES PM" = internal alias `ProjectInt2`. Its value list
  gives a `FieldValueId → Value` (ID → name) mapping — always resolved
  dynamically via `getSesPmLookup_()`, never hardcoded. Current PM
  ID↔name table (for reference, e.g. filling out `PM_EMAIL_MAP`):
  Anders=95, Brad=97, Nicole=102, Sean=105, Sheldon=107, Stephanie=109,
  Henry=173, Estella=209, Omar=219, Alireza=248, Joan=262, Hirad=268,
  Lauren=269.
- Closed task status = ID 1 (`COMPLETED_TASK_STATUS_IDS`).
- Tasks: `HasChild` = true means a parent/container task — hours are never
  logged directly on these, only on leaf tasks. `ParentId` is used both for
  breadcrumb display and phase aggregation (PhaseAlerts.gs walks up to the
  top-level ancestor).
- Time log `Cost` field is unreliable/empty via the API — always compute
  cost manually as `Duration * InternalRate` (verified accurate to $0.44
  out of $116,852.58 against Birdview's own reported number for a real
  project).
- "Planned" expenses already equal EAC billable + EAC non-billable expenses
  combined for the whole project — there is NO need to separately track
  historical "actual" expenses; `IsPlanned: true` is the only expense query
  needed for the Expected Profit % formula.
- List-filter params (e.g. `TaskIds`) have an undocumented query
  "node count" limit — empirically found to fail somewhere between 15 and
  18 IDs. `chunkArray_()` chunks at 15 to stay safe.
- Time entries lock (become uneditable) roughly 2 weeks after entry, once
  they've gone through a payroll cycle. `LOCK_BUFFER_DAYS = 45` gives extra
  margin. This is why the ledger splits into `LockedTotals` (permanent,
  aggregated cost for old/locked entries) + `TimeLogDetail` (a rolling
  window of recent, still-editable entries) rather than re-summing all
  history every day.

## Expected Profit % formula

Not exposed via the API — reconstructed from Birdview's own published
formula and verified to match the Birdview UI exactly (0.92% on both sides
for a real test project):

```
EAC billable = BillingAmount (the flat fee) + planned billable expenses
EAC cost     = actual labor cost + ETC labor cost + ALL planned expenses
Expected Profit % = (EAC billable − EAC cost) / EAC billable × 100
```

- Actual labor cost = `LockedTotals.LockedLaborCost` + sum of
  `TimeLogDetail.Cost` for that project.
- ETC (Estimate To Complete) labor cost = for each task assignee,
  `PersonalHoursLeft × HourlyRateInternal` (current rate, from
  `getAllUserRates_()`).
- Only applies to Flat Fee projects. T&M would use external rates for EAC
  billable instead — not implemented (out of scope).

## Alert design

**Daily "urgent" email** (`sendDailyUrgentAlertsFromSnapshot_` /
`buildDailyUrgentEmailHtml_` in DailyAlerts.gs) — ONE email per PM, subject
"Urgent: Project Alerts - <date>", fires only for BRAND-NEW occurrences, no
AI calls. It is being used to **evaluate candidate alert rules side by
side**: each rule is its own section with a grey one-line description of
exactly what triggers it, and an empty section shows "None today." (so a
too-quiet rule is visible). The email is only sent when at least one
section has items. Anders will pick which rules to keep; drop the rest.
1. **Tasks over estimate** — a task's actual hours have newly exceeded its
   ORIGINAL `EstimatedHours` (fires once ever per task, via the
   `HoursExceededNotified` tracking sheet — never re-fires), and only for
   tasks with `EstimatedHours > MIN_ESTIMATED_HOURS_FOR_ALERT` (5) — small
   tasks are excluded from this alert only (the weekly `OVER_ESTIMATE` flag
   still fires for tasks of any size).
2. **Phases over threshold** (PhaseAlerts.gs) — aggregates hours up to each
   project's level-1 "phase" tasks (only phases with
   ≥`MIN_PHASE_ESTIMATED_HOURS` (20) estimated hours, alert threshold
   ≥`PHASE_THRESHOLD_PERCENT` (66)% of estimated hours used, excluding
   Closed leaf tasks from the aggregate). Fires once ever per phase via
   `PhaseThresholdNotified`.
3. **Profit drops** — a project's Expected Profit % has dropped by
   `PROFIT_DROP_THRESHOLD` (5) percentage points or more since the most
   recent snapshot (raised from "more than 2" on 2026-09-29). The same
   threshold colours a week-over-week drop red in the weekly digest.

(Until 2026-09-29 this was two separate emails, "[Current]" and
"[Trial: +Phases]"; they were merged into the one sectioned email.)

**Weekly digest** (`runWeeklyDigest`, Monday mornings) — deterministic, no
AI calls. Three mutually exclusive task lists (a task appears in only one),
each grouped by project (projects alphabetical):
1. "Open tasks with 0 hours left AND an overdue end date" — both
   `RED_NO_HOURS_LEFT` and `PAST_DUE`, most overdue first.
2. "Open tasks with 0 hours left" — `RED_NO_HOURS_LEFT` only, most
   over-budget (actual − estimated hours) first.
3. "Open tasks with an overdue end date" — `PAST_DUE` only, most overdue
   first.

Format per project:
```
Project Name        (link to EP project)
└ Task Name (YYYY-MM-DD)   (link to EP task; end date shown in the two overdue lists only)
└ Task Name (YYYY-MM-DD)
└ (X more tasks)    (when a project has > WEEKLY_MAX_TASKS_PER_PROJECT (2))
```
The other flags (`YELLOW_LOW_HOURS`, `DUE_SOON`, `OVER_ESTIMATE`) are still
computed into the snapshot but not shown in the weekly email. Also shows each
project's current Expected Profit % and its week-over-week change (via a
snapshot from ~7 days ago, ±2 day tolerance). Birdview names are free text —
always pass them through `escapeHtml_()` when building email HTML.


## Notification / snapshot patterns (why they're built this way)

- **"Fire once, ever"** uses a dedicated tracking sheet
  (`HoursExceededNotified`, `PhaseThresholdNotified`) rather than
  day-over-day diffing — this guarantees exactly-once alerts even if the
  script is re-run multiple times on the same day (diffing against
  yesterday's snapshot could double-fire).
- **Drive JSON snapshots** (`digest-snapshot-YYYY-MM-DD.json` task rows +
  `phase-snapshot-YYYY-MM-DD.json` phase rows, 14-day retention) are both
  the hand-off between pipeline stages and what day-over-day (profit drops)
  and week-over-week (weekly digest) comparisons are based on.
- **PMs not in `PM_EMAIL_MAP` are skipped entirely** by the alert/digest
  senders, and their tasks/phases are NOT marked in the "notified" sheets.
  So adding a PM (or a fresh deployment's empty sheets) would make their
  first urgent email list EVERY task that has ever gone over estimate —
  **always run `seedNotifiedTracking()` first** (marks everything currently
  over threshold, for all PMs, without sending email).
- **Ledger sheets are read once per run** (`readLedgerCosts_()`, passed into
  `calculateExpectedProfitPercent_`) and the spreadsheet handle is cached
  per execution — don't reintroduce per-project sheet reads.

## Open issues / next steps

1. **[LIKELY FIXED — confirm on next scheduled runs] Nightly + weekly
   triggers failing.** The Executions panel (Sep 22–28, 2026) showed EVERY
   weekday `runNightlyDigest` and the Sep 28 `runWeeklyDigest` as **Failed
   after 8–52 s** — a thrown error early in the run, NOT the 6-minute
   timeout originally suspected. The error text was never captured.
   - Most likely cause (fixed): `LockedThroughDate` read back from Sheets as
     a `Date` object was sent to Birdview's `EntryDateFrom` as a
     `Date.toString()` string; now normalized to ISO. Evidence: the ledger
     update is the step that runs first, and a manual `testNightlyBuild()`
     on Sep 28 after the fix completed cleanly.
   - Also done: staged-trigger pipeline (above), error-alert emails,
     missing-snapshot alerts, single-pass build, one ledger read per run,
     Gemini only for PMs with an email.
   - **Measured `testNightlyBuild()` timings (Sep 28, 2026):** ledger update
     44 s (109 projects, 2,833 time logs in the active window); dataset build
     2 m 39 s (956 task rows + 234 phase rows); snapshots 6 s — **~3.5 min
     total**, vs. the 6-min per-execution limit. Rollover (#3) now caps the
     ledger window at ~45 days, so the ledger step should shrink, not grow.
   - If a "[Birdview Digest] … failed" email ever arrives, its error text is
     the next thing to fix.
2. *(Resolved 2026-10-07: watchdog built.)* `checkPipelineHealth_` (see
   "Ongoing — staged pipeline") covers missing triggers and stages that stop
   completing; missing snapshots were already covered. Only gap: every
   trigger deleted at once.
3. *(Resolved 2026-09-30: ledger rollover built.)* `dailyUpdateProfitabilityLedger()`
   now rolls over nightly: entries dated before today − `LOCK_BUFFER_DAYS`
   are added to `LockedLaborCost` and `LockedThroughDate` advances, so the
   fetch window and `TimeLogDetail` stay at ~45 days. Lock dates are
   compared as `yyyy-MM-dd` day strings (`toLockDay_`) — never timestamps —
   so time-zone handling of Birdview's `EntryDateFrom` can't drop boundary
   entries; Sheets turns written day strings into Dates, which `toLockDay_`
   normalizes on read (as it does the old ISO-timestamp values). Verify on
   live data with `testLedgerRolloverAndIntegrity()` (Tests.gs), which runs
   the update then compares locked + detail cost to a full Birdview re-sum
   for 30 projects. **Verified live 2026-09-30:** first run rolled 1,464
   time logs into LockedTotals (locked through 2026-08-15), active window
   dropped from 2,833 to 1,504 logs, ledger step 35 s (was 44 s), and the
   integrity check found 0 mismatches across 30 projects.
4. *(Resolved 2026-09-28: the weekly digest no longer calls Gemini.)*
5. **Rollout / migration — NEXT.** Anders is happy with both emails
   (2026-10-07). Follow `docs/migration-checklist.md`: move to SES's Google
   Workspace (new project + Script ID, Birdview OAuth redirect URI,
   `setupLedgerSpreadsheet` → backfill → `testNightlyBuild` →
   `seedNotifiedTracking`), then add all 13 PMs to `PM_EMAIL_MAP`, then
   `removeTriggers()` in the trial project. Open decision: whether
   non-billable time on Flat Fee projects should count as labour cost (the
   ledger only fetches `Billable: true` logs today; changing it needs a
   re-backfill).
6. `clearNotifiedTrackingForTesting_()` / `testClearNotifiedTracking()` in
   Tests.gs are TESTING ONLY — wipe both "notified" tracking sheets so a test
   run re-flags everything. Never call from a trigger or in production.
7. **[PLANNED, decided 2026-09-29] "Update my flagged tasks" page.** The
   digest email links to an Apps Script web page listing that PM's flagged
   tasks, where the PM manually enters a new end date and/or resets hours
   left; on Submit the script pushes the changes to Birdview. Decisions:
   - Structured form only — no AI parsing of free-text replies.
   - **Changes must be made AS THE PM**, not as Anders: each PM signs in to
     Birdview once (OAuth2 library with a per-user property store, i.e.
     `PropertiesService.getUserProperties()`), and every write uses that
     PM's own token so Birdview's history and permissions are theirs.
   - **Prerequisite: migrate to SES's Google Workspace** (rollout #5) so the
     web app can be restricted to signed-in SES accounts and the signed-in
     Google user can be trusted/matched to a Birdview user (by email).
   - API mechanics are in `docs/birdview-api-notes.md`: end date via
     read-modify-write `PUT /api/v2/tasks/{id}` (no PATCH for tasks);
     hours left per assignee via `PUT /api/v2/tasks/assignees/{id}`
     (`PersonalHoursLeft` — what the ETC cost uses); optional audit note via
     `POST /api/v2/tasks/{id}/messages`. Several behaviours are unverified —
     test on a single throwaway task before building the page.
   - Also planned: log every change to a sheet tab (who/what/old/new/when),
     only end date + hours left are editable, no deletes.

## Reference docs

- `docs/birdview-openapi-v2.json` — full Birdview API v2 OpenAPI spec
  (exported 2026-09-29). Check it before assuming an endpoint or field exists.
- `docs/birdview-api-notes.md` — summary of the endpoints this project reads
  today and the write endpoints for item 7, with what's still unverified.
- `docs/migration-checklist.md` — step-by-step move to SES's Google
  Workspace and PM rollout.

## Syncing with Apps Script (clasp)

`.clasp.json` (committed — the script ID is not a secret) points at the live
project; `.claspignore` whitelists only `*.gs` and
`appsscript.json`. `clasp push` REPLACES the whole Apps Script project with
those files, so this repo must be the source of truth — never edit in the
web editor without pulling the change back here.

One-time, on Anders's machine (Windows / PowerShell):
1. Enable the Apps Script API: https://script.google.com/home/usersettings
2. `npm install -g @google/clasp` then `clasp login` (sign in with the
   Google account that owns the script). Credentials land in
   `~/.clasprc.json` — never in this repo.

Deploy loop: `git pull` → `clasp push` → re-run `setupTriggers()` in the
editor if trigger schedules changed. To check for drift from the web editor:
`clasp pull` then `git diff`.

## Secrets — hard rule

`BIRDVIEW_CLIENT_ID`, `BIRDVIEW_CLIENT_SECRET`, and `GEMINI_API_KEY` live
ONLY in Apps Script Script Properties. Never hardcode them into any `.gs`
file, and never commit them to this repository in any form.
