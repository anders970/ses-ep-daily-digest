# Migrating the Birdview Daily Digest to SES's Google Workspace

The trial runs in Anders's personal Workspace (anders@theworks.pro). This is
the step-by-step move into SES's Workspace, ending with PMs receiving digests
**only after they have subscribed themselves**. Do it in order; nothing in
the old deployment changes until step 10.

## 0. Decisions

- **Owner account: `pmo@sesconsulting.com`** (decided 2026-10-14). The script
  runs as this account: it owns the triggers, sends every email ("From"),
  and owns the snapshot folder and ledger spreadsheet in its Drive. Keep the
  account licensed and active — if it's suspended, everything stops.
- **Which Birdview user the nightly read uses.** `authorize()` stores ONE
  Birdview token for the nightly build; that Birdview user must be able to
  see every open Flat Fee project and all time logs/rates. (The planned
  "update my tasks" page will use each PM's own token separately — see
  CLAUDE.md item 7.)
- **`ADMIN_EMAIL` = `pmo@sesconsulting.com`** (decided 2026-10-19) — gets
  failure, watchdog, coverage and subscribe/unsubscribe notices. Set in
  step 4; the trial keeps `anders@theworks.pro` until then.
- **Labour cost = ALL logged hours** (billable and non-billable) on Flat Fee
  projects (decided 2026-10-14). Already in the code; the fresh backfill in
  step 5 picks it up.

## 1. SES Workspace admin prerequisites

- Apps Script allowed for `pmo@` (Admin console → Apps → Google Workspace →
  Apps Script).
- If the admin restricts external connections, allow `ses.go.easyprojects.net`
  for Apps Script `UrlFetchApp`.
- For `clasp`: sign in as `pmo@` and turn on the Apps Script API at
  https://script.google.com/home/usersettings. If clasp keeps failing with
  `invalid_rapt`, that's the Workspace re-authentication policy (Security →
  Access and data control → Google Cloud session control).

## 2. Create the new Apps Script project

1. Signed in as `pmo@`, create a new standalone project at
   https://script.google.com ("Birdview Daily Digest"). Copy its Script ID
   (Project Settings → IDs).
2. Point the repo at it: set `scriptId` in `.clasp.json` to the new ID and
   commit. (The old ID is in git history.)
3. Log clasp in as `pmo@` without losing your own login:
   `clasp login --user pmo`, then deploy with `clasp push --user pmo`.

## 3. Birdview OAuth client

The OAuth callback URL contains the Script ID, so register it in Birdview
(`/integrations/oauthclients`), on the existing client or a new one:

    https://script.google.com/macros/d/<NEW_SCRIPT_ID>/usercallback

Then Project Settings → Script Properties: set `BIRDVIEW_CLIENT_ID` and
`BIRDVIEW_CLIENT_SECRET`. (Not `GEMINI_API_KEY` — no longer used.)

## 4. Config.gs

- Set `ADMIN_EMAIL = 'pmo@sesconsulting.com'`.
- Set `INITIAL_SUBSCRIBERS` to whoever should be subscribed from day one —
  e.g. just the admin's own SES PM name + address — or `{}` for nobody. It
  is only used once, when the PmRoster tab is first created.

Commit, then `clasp push --user pmo`.

## 5. Authorize and build the data

Run in the new project's editor, in this order:

1. `authorize()` — open the logged URL in a browser signed in as `pmo@`;
   log in to Birdview as the user chosen in step 0.
2. `setupLedgerSpreadsheet()` — creates "Birdview Digest Ledger" in `pmo@`'s
   Drive and saves its ID in Script Properties.
3. `backfillProfitabilityLedger()` — seeds the ledger (all logged hours).
4. `testLedgerRolloverAndIntegrity()` — expect "0 mismatches".
5. `testNightlyBuild()` — builds today's snapshots (~3–4 min).
6. `seedNotifiedTracking()` — marks everything currently over threshold as
   already notified (all PMs), without sending email.

## 6. Fill in the PM roster

1. Run `populatePmRoster()` — adds a row to the ledger spreadsheet's
   **PmRoster** tab for every "SES PM" name in Birdview (not subscribed).
2. Fill in each PM's SES email address in the **Email** column. Leave
   **Subscribed** as FALSE — PMs turn it on themselves.

## 7. Deploy the sign-up page

1. Editor → Deploy → New deployment → type **Web app**.
   - Execute as: **Me (pmo@sesconsulting.com)**
   - Who has access: **Anyone within SES Consulting**
   (Both are also set in `appsscript.json`.)
2. Copy the web app URL (ends in `/exec`) and save it as the Script
   Property `SUBSCRIBE_PAGE_URL`, so every email links to it.
3. Open the URL yourself (signed in to your SES account) to check it shows
   your roster status.

The page identifies each PM by the SES Google account they're signed in
with — it only works for accounts in the same Workspace as `pmo@`. When a PM
clicks Subscribe, the script marks their current backlog as already
notified (so their first urgent email has only new items) and emails
`ADMIN_EMAIL`. Unsubscribe works the same way, and every digest email
carries a "Manage your subscription" link.

## 8. Test with the admin only

- `testDailyUrgentAlerts()` — usually sends nothing right after seeding
  (that's correct).
- `testWeeklyDigest()` — subscribed people get a weekly digest; `ADMIN_EMAIL`
  gets a "Coverage report" listing every PM who hasn't subscribed yet
  (expected), with the sign-up link.
- `setupTriggers()`, then `listTriggers()` → three triggers.

## 9. Invite the PMs

Send the PMs the sign-up page URL (from step 7) with a short explanation.
Nobody gets a digest until they've subscribed; the Monday coverage report
shows who hasn't yet.

## 10. Turn off the trial deployment

In the OLD project (anders@theworks.pro) run `removeTriggers()`, then
`listTriggers()` → nothing. Otherwise the admin gets duplicate emails. Keep
the old project and its ledger sheet for a few weeks as a fallback, then
archive.

## 11. First week

Check Executions each morning. The watchdog (`checkPipelineHealth_`, at the
start of each weekday build) emails the admin if a trigger disappears or a
stage stops completing; failures and missing snapshots email the admin too.
