# Migrating the Birdview Daily Digest to SES's Google Workspace

The trial runs in Anders's personal Workspace (anders@theworks.pro). This is
the step-by-step move into SES's Workspace, ending with all PMs receiving
their own digests. Do it in order; nothing in the old deployment changes
until step 9.

## 0. Decide first

- **Which SES Google account owns the script.** The owner's account runs
  the triggers, sends every email ("From"), and owns the snapshot folder and
  the ledger spreadsheet in its Drive. If that person leaves and the account
  is suspended, everything stops — so prefer a dedicated account (e.g. a
  licensed `pm-digest@…` user) over a personal one. Shared drives / groups
  can't own triggers.
- **Which Birdview user the nightly read uses.** `authorize()` stores ONE
  Birdview token for the nightly build; that Birdview user must be able to
  see every open Flat Fee project and all time logs/rates. (The planned
  "update my tasks" page will use each PM's own token separately — see
  CLAUDE.md item 7.)
- **`ADMIN_EMAIL`** (Config.gs) — who gets failure, watchdog and coverage
  emails.
- **PM email addresses** for `PM_EMAIL_MAP` (Config.gs). Keys must match the
  Birdview "SES PM" names exactly (run `printSesPmLookup()` to see them).

## 1. SES Workspace admin prerequisites

- Apps Script allowed for the owner account (Admin console → Apps → Google
  Workspace → Apps Script).
- If the admin restricts external connections, allow `ses.go.easyprojects.net`
  for Apps Script `UrlFetchApp`.
- For `clasp`: the owner (or whoever deploys) turns on the Apps Script API at
  https://script.google.com/home/usersettings. If clasp keeps failing with
  `invalid_rapt`, that's the Workspace re-authentication policy (Security →
  Access and data control → Google Cloud session control).

## 2. Create the new Apps Script project

1. Signed in as the owner account, create a new standalone project at
   https://script.google.com ("Birdview Daily Digest"). Copy its Script ID
   (Project Settings → IDs).
2. Point the repo at it: set `scriptId` in `.clasp.json` to the new ID and
   commit. (The old ID is in git history if you ever need the trial project.)
3. Log clasp in as the owner without losing your own login:
   `clasp login --user ses`, then deploy with `clasp push --user ses`.
4. Project Settings → set the time zone to America/Vancouver if it isn't
   already (the manifest sets it too).

## 3. Birdview OAuth client

The OAuth callback URL contains the Script ID, so the new project needs it
registered in Birdview (`/integrations/oauthclients`):

    https://script.google.com/macros/d/<NEW_SCRIPT_ID>/usercallback

Either add it to the existing OAuth client's redirect URIs or create a new
client. Then in the new project's Project Settings → Script Properties set
`BIRDVIEW_CLIENT_ID` and `BIRDVIEW_CLIENT_SECRET`. (Not `GEMINI_API_KEY` —
it's no longer used.)

## 4. Config.gs

Set `ADMIN_EMAIL`. Leave `PM_EMAIL_MAP` with only the admin for now — the
other PMs are added in step 8, after seeding. Commit and `clasp push --user ses`.

## 5. Authorize and build the data

Run in the new project's editor, in this order:

1. `authorize()` — open the logged URL in a browser signed in to the OWNER's
   Google account; log in to Birdview as the user chosen in step 0.
2. `setupLedgerSpreadsheet()` — creates "Birdview Digest Ledger" with all
   four tabs in the owner's Drive and saves its ID in Script Properties.
3. `backfillProfitabilityLedger()` — seeds the ledger from Birdview.
4. `testLedgerRolloverAndIntegrity()` — expect "0 mismatches".
5. `testNightlyBuild()` — builds today's snapshots (~3–4 min).

## 6. Seed the "fire once" tracking — before anyone gets email

Run `seedNotifiedTracking()`. It marks every task/phase currently over its
threshold (for ALL PMs) as already notified, without sending anything.
Without this, each PM's first urgent email lists every task that has ever
gone over estimate.

## 7. Test with the admin only

- `testDailyUrgentAlerts()` — usually sends nothing right after seeding
  (that's correct).
- `testWeeklyDigest()` — admin gets a weekly digest, plus a "Coverage
  report" listing every other PM (expected — they're not mapped yet).
- `setupTriggers()`, then `listTriggers()` → three triggers.

## 8. Roll out to the PMs

1. Add all PMs to `PM_EMAIL_MAP`, commit, `clasp push --user ses`.
2. Run `testNightlyBuild()` then `seedNotifiedTracking()` again (catches
   anything that went over threshold since step 6).
3. Optionally warn the PMs before Monday's first weekly digest.

## 9. Turn off the trial deployment

In the OLD project (anders@theworks.pro) run `removeTriggers()`, then
`listTriggers()` → nothing. Otherwise the admin gets duplicate emails. Keep
the old project and its ledger sheet for a few weeks as a fallback, then
archive.

## 10. First week

Check Executions each morning. The watchdog (`checkPipelineHealth_`, run at
the start of each weekday build) emails the admin if a trigger disappears or
a stage stops completing; failures and missing snapshots email the admin too.
