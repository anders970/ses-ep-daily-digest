// ==========================================================================
// BIRDVIEW DAILY DIGEST — configuration
//
// Full project context (setup, API quirks, alert design): CLAUDE.md in the repo.
//
// SETUP CHECKLIST — required before this script will run:
//   Script Properties (Project Settings → Script Properties):
//     BIRDVIEW_CLIENT_ID, BIRDVIEW_CLIENT_SECRET
//   Sheet tabs (in the ledger spreadsheet, see Ledger.gs):
//     TimeLogDetail          — TimeEntryId | ProjectId | Cost | LastModificationDate
//     LockedTotals           — ProjectId | LockedLaborCost | LockedThroughDate
//     HoursExceededNotified  — TaskId | NotifiedDate
//     PhaseThresholdNotified — TaskId | NotifiedDate   (used by PhaseAlerts.gs)
//   One-time manual runs:
//     authorize()                   — approve Birdview access (Birdview.gs)
//     backfillProfitabilityLedger() — seed the profitability ledger (Ledger.gs)
//     setupTriggers()               — schedule the pipeline (Triggers.gs);
//                                     re-run after any trigger schedule change
// ==========================================================================


// ====== BIRDVIEW IDS ======

const BIRDVIEW_BASE = 'https://ses.go.easyprojects.net';
const PROJECT_STATUS_OPEN = 4;
const BILLING_TYPE_FIXED_FEE = 5; // Birdview's internal name: "ProjectFixedCost"
const CUSTOM_FIELD_SES_PM = 'ProjectInt2';
const COMPLETED_TASK_STATUS_IDS = [1]; // Closed
const PROJECT_URL_BASE = BIRDVIEW_BASE + '/1/activities/project/'; // same-file const, defined above
const TASK_URL_BASE = BIRDVIEW_BASE + '/1/activities/activity/';


// ====== THRESHOLDS ======

const LOCK_BUFFER_DAYS = 45;
const PROFIT_DROP_THRESHOLD = 5; // percentage points — a drop of this much or more alerts (and shows red in the weekly digest)
const MIN_ESTIMATED_HOURS_FOR_ALERT = 5; // daily urgent "over estimate" alert only fires for tasks with more than this many estimated hours
const WEEKLY_MAX_TASKS_PER_PROJECT = 2; // weekly digest lists this many tasks per project, then "(X more tasks)"


// ====== SNAPSHOTS ======

const DIGEST_SNAPSHOT_FOLDER_NAME = 'Birdview Digest Snapshots';
const SNAPSHOT_RETENTION_DAYS = 14;
const TASK_SNAPSHOT_PREFIX = 'digest-snapshot-';
const PHASE_SNAPSHOT_PREFIX = 'phase-snapshot-'; // phase rows for PhaseAlerts.gs, saved alongside the task snapshot


// ====== PEOPLE ======

const ADMIN_EMAIL = 'anders@theworks.pro'; // receives pipeline failure / missing-snapshot alerts
const PM_EMAIL_MAP = {
  'Anders': 'anders@theworks.pro' // add more PMs here as the trial expands to the full team
};

function getPmEmail_(pmName) {
  return PM_EMAIL_MAP[pmName] || null;
}
