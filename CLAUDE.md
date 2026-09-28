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
web editor; it's now being managed here so it can be edited with Claude Code.
**There is no Apps Script CLI (clasp) wired up yet** — see "Syncing with
Apps Script" below for how changes currently need to be copy-pasted back in.

## File layout

- `Code.gs` — the live, "current design." OAuth, Birdview API access, the
  profitability ledger, the daily dataset builder, snapshotting, the daily
  urgent alert (profit drops + hours-exceeded-estimate), the weekly digest
  (Gemini-assisted), triggers, and test/debug helpers.
- `PhaseTrial.gs` — an A/B test living alongside `Code.gs` without touching
  it. Adds a "phase-level" alert (rolls hours up to a project's top-level
  parent tasks) and sends it as a second, separately-labeled email so the
  two designs can be compared side by side. `runNightlyDigest()` in
  `Code.gs` calls `runDailyUrgentComparison()` from this file (NOT
  `runDailyUrgentCheck()` directly), so both emails go out every night
  during the trial.
- `appsscript.json` — manifest. Declares the `OAuth2` library dependency
  (Apps Script "OAuth2 for Apps Script" library) used for the Birdview
  Authorization Code Grant flow.

## Setup checklist (fresh environment)

**Script Properties** (Project Settings → Script Properties in the Apps
Script editor — never commit these anywhere):
- `BIRDVIEW_CLIENT_ID`, `BIRDVIEW_CLIENT_SECRET` — from Birdview's OAuth
  app registration (Automatic Consent Grant: on; Client Credentials Grant:
  off).
- `GEMINI_API_KEY`

**Google Sheet** (the "ledger" spreadsheet, URL hardcoded in
`getLedgerSpreadsheet_()`), with these tabs:
- `TimeLogDetail` — TimeEntryId | ProjectId | Cost | LastModificationDate
- `LockedTotals` — ProjectId | LockedLaborCost | LockedThroughDate
- `HoursExceededNotified` — TaskId | NotifiedDate
- `PhaseThresholdNotified` — TaskId | NotifiedDate

**One-time manual runs** (via the Apps Script editor's Run dropdown):
1. `authorize()` — logs an authorization URL; open it in the SAME Chrome
   window/Google account signed into the Apps Script editor (Birdview's own
   login can be a different account — only the Google/callback session
   matters).
2. `backfillProfitabilityLedger()` — seeds `LockedTotals`/`TimeLogDetail`
   for all currently-open Flat Fee projects.
3. `setupTriggers()` — installs the nightly + weekly time-based triggers.

**Ongoing**: `runNightlyDigest` fires daily (skips Sat/Sun); `runWeeklyDigest`
fires Monday mornings.

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
  breadcrumb display and phase aggregation (PhaseTrial.gs walks up to the
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

**Daily "urgent" email** (`runDailyUrgentCheck` in Code.gs / the "[Current]"
half of `runDailyUrgentComparison` in PhaseTrial.gs) — fires only for
BRAND-NEW occurrences, no Gemini call, compact one-line formatting:
1. A task's actual hours have newly exceeded its ORIGINAL `EstimatedHours`
   (fires once ever per task, via the `HoursExceededNotified` tracking
   sheet — never re-fires), and only for tasks with
   `EstimatedHours > MIN_ESTIMATED_HOURS_FOR_ALERT` (5) — small tasks are
   excluded from this alert only (the weekly `OVER_ESTIMATE` flag still
   fires for tasks of any size).
2. A project's Expected Profit % has dropped by more than
   `PROFIT_DROP_THRESHOLD` (2) percentage points since the most recent
   snapshot.

**Weekly digest** (`runWeeklyDigest`, Monday mornings) — covers ALL
currently-flagged tasks (RED_NO_HOURS_LEFT, YELLOW_LOW_HOURS, PAST_DUE,
DUE_SOON, OVER_ESTIMATE), Gemini-assisted per-task explanations. A project
with more than 2 flagged tasks (combined across all flag types) is
collapsed into one summarized line instead of listing each task
individually. Also shows each project's current Expected Profit % and its
week-over-week change (via a snapshot from ~7 days ago, ±2 day tolerance).

**Phase-level trial** (`PhaseTrial.gs`, A/B test) — separate, additive
design being trialed alongside the daily urgent email without replacing it.
Aggregates hours up to each project's level-1 "phase" tasks (only phases
with ≥`MIN_PHASE_ESTIMATED_HOURS` (20) estimated hours, alert threshold
≥`PHASE_THRESHOLD_PERCENT` (66)% of estimated hours used, excluding Closed
leaf tasks from the aggregate). Fires once ever per phase via
`PhaseThresholdNotified`. Sent as a second, clearly labeled
"[Trial: +Phases]" email so Anders can compare it against the "[Current]"
email side by side.

## Notification / snapshot patterns (why they're built this way)

- **"Fire once, ever"** uses a dedicated tracking sheet
  (`HoursExceededNotified`, `PhaseThresholdNotified`) rather than
  day-over-day diffing — this guarantees exactly-once alerts even if the
  script is re-run multiple times on the same day (diffing against
  yesterday's snapshot could double-fire).
- **Drive JSON snapshots** (`digest-snapshot-YYYY-MM-DD.json`, 14-day
  retention) are what day-over-day (profit drops) and week-over-week
  (weekly digest) comparisons are based on.

## Open issues / next steps

1. **[UNRESOLVED] Weekly digest email never arrived**, despite
   `listTriggers()` confirming the trigger exists and fires. Leading
   hypothesis: Apps Script's per-execution runtime limit (~6 minutes, even
   for Workspace accounts) is being exceeded. Logged execution times
   observed during testing: dataset build ~3 min, ledger update ~1.5 min —
   and `runWeeklyDigest()` does a full dataset rebuild AFTER also calling
   `dailyUpdateProfitabilityLedger()`, so these could combine to blow the
   limit. A silent execution-time-limit failure does NOT throw a catchable
   error in the way a normal exception would, so nothing currently surfaces
   this failure — it just silently doesn't finish.
   - **Proposed fix approach**: split the work across staged triggers,
     handing off state via a Drive snapshot file instead of one function
     doing everything: (a) a first trigger builds the dataset + updates the
     ledger and saves a snapshot; (b) a second trigger (a few minutes later)
     reads that snapshot and does the flagging + Gemini calls + email send,
     without rebuilding anything. This also naturally solves problem #2
     below (a watchdog can check "did today's snapshot get saved").
   - Next action: confirm the actual quota via Apps Script's quotas docs,
     then implement the staged-trigger split if confirmed.
2. **No watchdog for silent trigger failures.** If a trigger execution times
   out or throws in a way that isn't caught, nothing currently notices or
   alerts Anders. Add a simple check (e.g., a separate daily trigger that
   verifies today's snapshot file exists in Drive by a certain time, and
   emails Anders if not).
3. **Ledger "rollover" was never built.** `dailyUpdateProfitabilityLedger()`
   currently only ever grows `TimeLogDetail` — it never folds aged-out rows
   into `LockedTotals` and advances `LockedThroughDate`. Over time the
   detail sheet and the per-run query window will keep growing. Needs a
   periodic (e.g. weekly) rollover step.
4. Old `callGeminiForDailyUrgent_`-style Gemini calls for the daily urgent
   email were removed in favor of deterministic compact formatting (no
   Gemini needed for profit-drop or hours-exceeded lines) — confirm nothing
   still references a function like that if it turns up during further
   cleanup. Also double check the Gemini model string used in
   `callGeminiForWeeklyTasks_` (`gemini-3.5-flash`) is still correct/current
   before the next round of changes.
5. **Rollout plan**: extend `PM_EMAIL_MAP` from just Anders to all 13 PMs
   (ID↔name table above) once the trial is validated and the missing-email
   bug is fixed, then move the whole thing from Anders's personal Workspace
   to SES's own Google Workspace.
6. `clearNotifiedTrackingForTesting_()` / `testClearNotifiedTracking()` in
   Code.gs are TESTING ONLY — wipe both "notified" tracking sheets so a test
   run re-flags everything. Never call from a trigger or in production.

## Syncing with Apps Script (no clasp yet)

Changes made here need to be manually copy-pasted into the Apps Script web
editor's `Code.gs` / `PhaseTrial.gs` files (and `appsscript.json` via
"Show manifest file" in Project Settings) until `clasp` is set up. Setting
up `clasp push`/`clasp pull` is a reasonable next step once this repo is
the source of truth.

## Secrets — hard rule

`BIRDVIEW_CLIENT_ID`, `BIRDVIEW_CLIENT_SECRET`, and `GEMINI_API_KEY` live
ONLY in Apps Script Script Properties. Never hardcode them into any `.gs`
file, and never commit them to this repository in any form.
