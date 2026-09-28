// ==========================================================================
// SETUP CHECKLIST — required before this script will run:
//
// Script Properties (Project Settings → Script Properties):
//   BIRDVIEW_CLIENT_ID, BIRDVIEW_CLIENT_SECRET, GEMINI_API_KEY
//
// Sheet tabs (in the spreadsheet linked below):
//   TimeLogDetail          — TimeEntryId | ProjectId | Cost | LastModificationDate
//   LockedTotals           — ProjectId | LockedLaborCost | LockedThroughDate
//   HoursExceededNotified  — TaskId | NotifiedDate
//   PhaseThresholdNotified — TaskId | NotifiedDate   (used by PhaseTrial.gs)
//
// One-time manual runs needed on a fresh setup:
//   authorize()                     — approve Birdview access
//   backfillProfitabilityLedger()   — seed the profitability ledger
//   setupTriggers()                 — schedule the nightly/weekly runs
//                                     (re-run after any trigger schedule change)
//
// Trigger pipeline (staged so no single execution does too much):
//   ~2am  runNightlyDigest  — ledger update + dataset build, saves today's snapshots
//   ~4am  runNightlyAlerts  — reads today's snapshots, sends daily urgent emails
//   ~6am Mon runWeeklyDigest — reads today's snapshot, sends weekly digests
// ==========================================================================


// ====== CONFIG / CONSTANTS ======
const LOCK_BUFFER_DAYS = 45;
const BIRDVIEW_BASE = 'https://ses.go.easyprojects.net';
const PROJECT_STATUS_OPEN = 4;
const BILLING_TYPE_FIXED_FEE = 5; // Birdview's internal name: "ProjectFixedCost"
const CUSTOM_FIELD_SES_PM = 'ProjectInt2';
const COMPLETED_TASK_STATUS_IDS = [1]; // Closed
const PROFIT_DROP_THRESHOLD = 2; // percentage points
const PROJECT_URL_BASE = 'https://ses.go.easyprojects.net/1/activities/project/';
const TASK_URL_BASE = 'https://ses.go.easyprojects.net/1/activities/activity/';
const DIGEST_SNAPSHOT_FOLDER_NAME = 'Birdview Digest Snapshots';
const SNAPSHOT_RETENTION_DAYS = 14;
const MIN_ESTIMATED_HOURS_FOR_ALERT = 5; // daily urgent "over estimate" alert only fires for tasks with more than this many estimated hours
const TASK_SNAPSHOT_PREFIX = 'digest-snapshot-';
const PHASE_SNAPSHOT_PREFIX = 'phase-snapshot-'; // phase rows for PhaseTrial.gs, saved alongside the task snapshot
const ADMIN_EMAIL = 'anders@theworks.pro'; // receives pipeline failure / missing-snapshot alerts

const PM_EMAIL_MAP = {
  'Anders': 'anders@theworks.pro' // add more PMs here as the trial expands to the full team
};


// ====== BIRDVIEW OAUTH ======
function getBirdviewService() {
  var props = PropertiesService.getScriptProperties();
  return OAuth2.createService('Birdview')
    .setAuthorizationBaseUrl('https://ses.go.easyprojects.net/OAuth2/Authorize')
    .setTokenUrl('https://ses.go.easyprojects.net/OAuth2/Token')
    .setClientId(props.getProperty('BIRDVIEW_CLIENT_ID'))
    .setClientSecret(props.getProperty('BIRDVIEW_CLIENT_SECRET'))
    .setCallbackFunction('authCallback')
    .setPropertyStore(props);
}

function authorize() {
  var service = getBirdviewService();
  if (service.hasAccess()) {
    Logger.log('Already authorized — no action needed.');
  } else {
    Logger.log('Open this URL in your browser to approve access: ' + service.getAuthorizationUrl());
  }
}

function authCallback(request) {
  var isApproved = getBirdviewService().handleCallback(request);
  return HtmlService.createHtmlOutput(isApproved ? 'Success! You can close this tab and go back to Apps Script.' : 'Access denied. Something went wrong — let\'s troubleshoot.');
}

function resetBirdviewAuth() {
  getBirdviewService().reset();
  Logger.log('Reset complete. Now run authorize() again.');
}


// ====== SHEET CONNECTIONS ======
var ledgerSpreadsheetCache_ = null; // opened once per execution

function getLedgerSpreadsheet_() {
  var SHEET_URL = 'https://docs.google.com/spreadsheets/d/1_zIy-0HMHkAh2v01IzbZizEqVqoA9VSbWrUYEMxjdsA/edit?usp=sharing';
  if (!ledgerSpreadsheetCache_) ledgerSpreadsheetCache_ = SpreadsheetApp.openByUrl(SHEET_URL);
  return ledgerSpreadsheetCache_;
}
function getTimeLogDetailSheet_() { return getLedgerSpreadsheet_().getSheetByName('TimeLogDetail'); }
function getLockedTotalsSheet_() { return getLedgerSpreadsheet_().getSheetByName('LockedTotals'); }
function getHoursExceededNotifiedSheet_() { return getLedgerSpreadsheet_().getSheetByName('HoursExceededNotified'); }

// Wipes old rows below the header and writes fresh ones.
function writeRows_(sheet, rows) {
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
}


// ====== BIRDVIEW REQUEST HELPERS ======
function birdviewGet_(path, params) {
  var service = getBirdviewService();
  var queryParts = [];
  Object.keys(params || {}).forEach(function(key) {
    var value = params[key];
    if (Array.isArray(value)) {
      value.forEach(function(v) { queryParts.push(encodeURIComponent(key) + '=' + encodeURIComponent(v)); });
    } else {
      queryParts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    }
  });
  var url = BIRDVIEW_BASE + path + (queryParts.length ? '?' + queryParts.join('&') : '');

  var response = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + service.getAccessToken() },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Birdview request failed (' + response.getResponseCode() + '): ' + url + ' — ' + response.getContentText());
  }
  return JSON.parse(response.getContentText());
}

// Loops through pages automatically so we always get the FULL result set.
function birdviewGetAllPages_(path, params) {
  var allItems = [];
  var take = 200;
  var skip = 0;
  while (true) {
    var pageParams = Object.assign({}, params, { Skip: skip, Take: take });
    var page = birdviewGet_(path, pageParams);
    var items = page.Items || [];
    allItems = allItems.concat(items);
    if (items.length < take) break;
    skip += take;
  }
  return allItems;
}

// Splits an array into chunks — Birdview's query engine caps list-filter size
// (empirically confirmed safe at 15; fails somewhere between 15 and 18).
function chunkArray_(array, size) {
  var chunks = [];
  for (var i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function getAssigneesForTasks_(taskIds) {
  var allAssignees = [];
  chunkArray_(taskIds, 15).forEach(function(chunk) {
    allAssignees = allAssignees.concat(birdviewGetAllPages_('/api/v2/tasks/assignees', { TaskIds: chunk }));
  });
  return allAssignees;
}


// ====== LOOKUPS ======
function getOpenFlatFeeProjects_() {
  var allProjects = birdviewGetAllPages_('/api/v2/projects', { StatusIds: PROJECT_STATUS_OPEN });
  return allProjects.filter(function(p) { return p.BillingType === BILLING_TYPE_FIXED_FEE; });
}

function getSesPmLookup_() {
  var result = birdviewGet_('/api/v2/customfields', { Entities: 'Project' });
  var pmField = result.Items.find(function(f) { return f.FieldName === CUSTOM_FIELD_SES_PM; });
  var lookup = {};
  (pmField.Values || []).forEach(function(v) { lookup[v.FieldValueId] = v.Value; });
  return lookup;
}

function getAllUserRates_() {
  var users = birdviewGetAllPages_('/api/v2/users', { IsEnabled: true });
  var rateMap = {};
  users.forEach(function(u) { rateMap[u.UserId] = u.HourlyRateInternal || 0; });
  return rateMap;
}

function getPmEmail_(pmName) {
  return PM_EMAIL_MAP[pmName] || null;
}


// ====== TASK HELPERS (open/leaf filtering, breadcrumb, hours, flags) ======
function getAllTasksForProject_(projectId) {
  return birdviewGetAllPages_('/api/v2/tasks', { ProjectIds: projectId });
}

function getOpenLeafTasksFromAll_(allTasks) {
  return allTasks.filter(function(task) {
    var isNotCompleted = COMPLETED_TASK_STATUS_IDS.indexOf(task.TaskStatusId) === -1;
    var isLeafTask = !task.HasChild;
    return isNotCompleted && isLeafTask;
  });
}

// Convenience wrapper for one-off/manual checks (used by verifyExpectedProfitPercent).
function getOpenTasksForProject_(projectId) {
  return getOpenLeafTasksFromAll_(getAllTasksForProject_(projectId));
}

function buildTaskLookup_(allTasks) {
  var map = {};
  allTasks.forEach(function(t) { map[t.TaskId] = { name: t.Name, parentId: t.ParentId }; });
  return map;
}

// Returns just the chain of PARENT names, top-down — not including the task itself.
function buildParentBreadcrumb_(taskId, taskLookup) {
  var parts = [];
  var current = taskLookup[taskId];
  var parentId = current ? current.parentId : null;
  while (parentId) {
    var parent = taskLookup[parentId];
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return parts.join(' / ');
}

// One call per project — groups all logged hours by task.
function getActualHoursByTaskForProject_(projectId) {
  var logs = birdviewGetAllPages_('/api/v2/timelogs', { ProjectIds: projectId });
  var map = {};
  logs.forEach(function(log) { map[log.TaskId] = (map[log.TaskId] || 0) + (log.Duration || 0); });
  return map;
}

function buildTaskFlags_(task, actualHoursForThisTask) {
  var flags = [];
  var totalHours = actualHoursForThisTask + (task.HoursLeft || 0);

  if (totalHours > 0) {
    if (task.HoursLeft <= 0) {
      flags.push('RED_NO_HOURS_LEFT');
    } else if ((task.HoursLeft / totalHours) * 100 < 20) {
      flags.push('YELLOW_LOW_HOURS');
    }
  }

  if (task.EndDate) {
    var daysUntilDue = (new Date(task.EndDate) - new Date()) / (1000 * 60 * 60 * 24);
    if (daysUntilDue < 0) {
      flags.push('PAST_DUE');
    } else if (daysUntilDue <= 5) {
      flags.push('DUE_SOON');
    }
  }

  if (task.EstimatedHours && task.EstimatedHours > 0 && actualHoursForThisTask > task.EstimatedHours) {
    flags.push('OVER_ESTIMATE');
  }

  return flags;
}

function buildTaskUrl_(taskId) { return TASK_URL_BASE + taskId; }
function buildProjectUrl_(projectId) { return PROJECT_URL_BASE + projectId; }


// ====== PROFITABILITY LEDGER (locked totals + recent detail) ======
function readLockedTotalsMap_() {
  var data = getLockedTotalsSheet_().getDataRange().getValues();
  var map = {};
  for (var i = 1; i < data.length; i++) {
    map[data[i][0]] = { lockedLaborCost: data[i][1], lockedThroughDate: data[i][2] };
  }
  return map;
}

// Sums TimeLogDetail.Cost per project in a single sheet read.
function readRecentLaborCostByProject_() {
  var data = getTimeLogDetailSheet_().getDataRange().getValues();
  var map = {};
  for (var i = 1; i < data.length; i++) {
    map[data[i][1]] = (map[data[i][1]] || 0) + (Number(data[i][2]) || 0);
  }
  return map;
}

// Both ledger sheets, read once — pass the result into calculateExpectedProfitPercent_
// instead of re-reading the sheets for every project.
function readLedgerCosts_() {
  return { lockedMap: readLockedTotalsMap_(), recentCostByProject: readRecentLaborCostByProject_() };
}

// Run once on a fresh setup.
function backfillProfitabilityLedger() {
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOCK_BUFFER_DAYS);
  cutoff.setHours(0, 0, 0, 0);

  var projects = getOpenFlatFeeProjects_();
  Logger.log('Backfilling ' + projects.length + ' open Flat Fee projects...');

  var lockedRows = [];
  var timeLogDetailRows = [];

  projects.forEach(function(project) {
    var projectId = project.ProjectId;
    var timeLogs = birdviewGetAllPages_('/api/v2/timelogs', { ProjectIds: projectId, Billable: true });

    var lockedLaborCost = 0;
    timeLogs.forEach(function(log) {
      var calculatedCost = (log.Duration || 0) * (log.InternalRate || 0);
      if (new Date(log.EntryDate) < cutoff) {
        lockedLaborCost += calculatedCost;
      } else {
        timeLogDetailRows.push([log.TimeEntryId, projectId, calculatedCost, log.LastModificationDate]);
      }
    });

    lockedRows.push([projectId, lockedLaborCost, cutoff.toISOString()]);
  });

  writeRows_(getLockedTotalsSheet_(), lockedRows);
  writeRows_(getTimeLogDetailSheet_(), timeLogDetailRows);
  Logger.log('Done. ' + lockedRows.length + ' projects locked. ' + timeLogDetailRows.length + ' recent time logs staged.');
}

// Run every night (via runNightlyDigest) — refreshes the recent-detail window per project.
// NOTE: does not roll old detail rows into LockedTotals (no rollover mechanism yet — see CLAUDE.md).
function dailyUpdateProfitabilityLedger() {
  var projects = getOpenFlatFeeProjects_();
  var lockedMap = readLockedTotalsMap_();

  var timeLogDetailRows = [];
  var newLockedRows = [];

  projects.forEach(function(project) {
    var projectId = project.ProjectId;
    var existing = lockedMap[projectId];
    var lockedLaborCost = existing ? existing.lockedLaborCost : 0;
    var sinceDate = existing ? existing.lockedThroughDate : project.CreationDate;
    // Sheets may hand back a Date object here; send Birdview an ISO string, not Date.toString().
    if (sinceDate instanceof Date) sinceDate = sinceDate.toISOString();

    var timeLogs = birdviewGetAllPages_('/api/v2/timelogs', { ProjectIds: projectId, Billable: true, EntryDateFrom: sinceDate });
    timeLogs.forEach(function(log) {
      var calculatedCost = (log.Duration || 0) * (log.InternalRate || 0);
      timeLogDetailRows.push([log.TimeEntryId, projectId, calculatedCost, log.LastModificationDate]);
    });

    newLockedRows.push([projectId, lockedLaborCost, sinceDate]);
  });

  writeRows_(getTimeLogDetailSheet_(), timeLogDetailRows);
  writeRows_(getLockedTotalsSheet_(), newLockedRows);
  Logger.log('Daily update complete. ' + projects.length + ' projects checked. ' + timeLogDetailRows.length + ' time logs in the active window.');
}

// Expected Profit % (Flat Fee only), reconstructed per Birdview's published formula:
//   EAC billable = BillingAmount + planned billable expenses
//   EAC cost     = actual labor cost + ETC labor cost + ALL planned expenses
//   Expected Profit % = (EAC billable - EAC cost) / EAC billable * 100
// Verified against Birdview's own displayed value on project 3656 (0.92% both sides).
// ledgerCosts (from readLedgerCosts_) is optional — read fresh if omitted.
function calculateExpectedProfitPercent_(projectId, project, tasks, userRateMap, ledgerCosts) {
  ledgerCosts = ledgerCosts || readLedgerCosts_();
  var lockedRow = ledgerCosts.lockedMap[projectId];
  var lockedLaborCost = lockedRow ? lockedRow.lockedLaborCost : 0;
  var recentLaborCost = ledgerCosts.recentCostByProject[projectId] || 0;
  var actualLaborCost = lockedLaborCost + recentLaborCost;

  var taskIds = tasks.map(function(t) { return t.TaskId; });
  var etcLaborCost = 0;
  if (taskIds.length > 0) {
    getAssigneesForTasks_(taskIds).forEach(function(a) {
      if (!a.UserId) return;
      etcLaborCost += (a.PersonalHoursLeft || 0) * (userRateMap[a.UserId] || 0);
    });
  }

  var plannedExpenses = birdviewGetAllPages_('/api/v2/expenses', { ProjectId: projectId, IsPlanned: true });
  var plannedTotal = plannedExpenses.reduce(function(sum, e) { return sum + (e.Amount || 0); }, 0);
  var plannedBillableTotal = plannedExpenses.reduce(function(sum, e) { return sum + (e.Billable ? (e.Amount || 0) : 0); }, 0);

  var eacBillable = (project.BillingAmount || 0) + plannedBillableTotal;
  var eacCost = actualLaborCost + etcLaborCost + plannedTotal;
  var expectedProfitPercent = eacBillable > 0 ? ((eacBillable - eacCost) / eacBillable) * 100 : null;

  return { eacBillable: eacBillable, eacCost: eacCost, expectedProfitPercent: expectedProfitPercent };
}


// ====== DAILY DATASET ASSEMBLY (the core output — one row per open task) ======
// Single pass over all projects producing both the task rows and PhaseTrial.gs's
// phase rows, so each project's tasks/time logs are only fetched once per night.
function buildNightlyData_() {
  var projects = getOpenFlatFeeProjects_();
  var pmLookup = getSesPmLookup_();
  var userRateMap = getAllUserRates_();
  var ledgerCosts = readLedgerCosts_();
  var rows = [];
  var phaseRows = [];

  projects.forEach(function(project) {
    var projectId = project.ProjectId;
    var pmId = project.CustomFields ? project.CustomFields[CUSTOM_FIELD_SES_PM] : null;
    var pmName = pmLookup[pmId] || 'Unassigned';

    var allTasks = getAllTasksForProject_(projectId);
    var taskLookup = buildTaskLookup_(allTasks);
    var tasks = getOpenLeafTasksFromAll_(allTasks);

    var hoursMap = getActualHoursByTaskForProject_(projectId);
    var profitData = calculateExpectedProfitPercent_(projectId, project, tasks, userRateMap, ledgerCosts);

    tasks.forEach(function(task) {
      var actualHours = hoursMap[task.TaskId] || 0;

      rows.push({
        ProjectId: projectId,
        ProjectName: project.Name,
        SES_PM: pmName,
        ExpectedProfitPercent: profitData.expectedProfitPercent,
        TaskId: task.TaskId,
        TaskName: task.Name,
        ParentBreadcrumb: buildParentBreadcrumb_(task.TaskId, taskLookup),
        TaskUrl: buildTaskUrl_(task.TaskId),
        EndDate: task.EndDate,
        HoursLeft: task.HoursLeft,
        ActualHours: actualHours,
        EstimatedHours: task.EstimatedHours || 0,
        TotalHours: actualHours + (task.HoursLeft || 0),
        Flags: buildTaskFlags_(task, actualHours).join(', ')
      });
    });

    phaseRows = phaseRows.concat(buildPhaseRowsForProject_(project, pmName, allTasks, hoursMap)); // PhaseTrial.gs
  });

  Logger.log('Built ' + rows.length + ' task rows and ' + phaseRows.length + ' phase rows across ' + projects.length + ' projects.');
  return { taskRows: rows, phaseRows: phaseRows };
}

function buildDailyDigestDataset() {
  return buildNightlyData_().taskRows;
}


// ====== SNAPSHOTS (Drive storage for day-over-day / week-over-week comparison) ======
function getSnapshotFolder_() {
  var folders = DriveApp.getFoldersByName(DIGEST_SNAPSHOT_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(DIGEST_SNAPSHOT_FOLDER_NAME);
}

function formatDateForFilename_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function todaysSnapshotFilename_(prefix) {
  return prefix + formatDateForFilename_(new Date()) + '.json';
}

function saveTodaysSnapshotFile_(prefix, data) {
  var folder = getSnapshotFolder_();
  var filename = todaysSnapshotFilename_(prefix);

  var existing = folder.getFilesByName(filename);
  if (existing.hasNext()) existing.next().setTrashed(true);

  folder.createFile(filename, JSON.stringify(data), MimeType.PLAIN_TEXT);
  Logger.log('Saved snapshot: ' + filename);
}

function saveTodaysSnapshot_(rows) {
  saveTodaysSnapshotFile_(TASK_SNAPSHOT_PREFIX, rows);
}

// Returns today's parsed snapshot, or null if it hasn't been saved (yet).
function loadTodaysSnapshotFile_(prefix) {
  var files = getSnapshotFolder_().getFilesByName(todaysSnapshotFilename_(prefix));
  return files.hasNext() ? JSON.parse(files.next().getBlob().getDataAsString()) : null;
}

// Stage 2/3 guard: today's snapshot is the hand-off from runNightlyDigest. If it's
// missing, the build stage failed or timed out — tell the admin instead of silently
// sending nothing.
function requireTodaysSnapshot_(prefix, callerName) {
  var data = loadTodaysSnapshotFile_(prefix);
  if (!data) {
    notifyAdmin_('[Birdview Digest] ' + callerName + ' skipped — no snapshot for today',
      callerName + ' could not find ' + todaysSnapshotFilename_(prefix) + ' in the "' + DIGEST_SNAPSHOT_FOLDER_NAME + '" Drive folder.\n\n' +
      'That means today\'s runNightlyDigest (ledger update + dataset build) did not finish — check the Apps Script Executions panel. ' +
      'No emails were sent by ' + callerName + '. To recover manually, run testNightlyBuild() and then re-run ' + callerName + '().');
  }
  return data;
}

function getMostRecentPastSnapshot_() {
  var folder = getSnapshotFolder_();
  var files = folder.getFiles();
  var todayFilename = 'digest-snapshot-' + formatDateForFilename_(new Date()) + '.json';

  var candidates = [];
  while (files.hasNext()) {
    var file = files.next();
    if (file.getName() !== todayFilename && file.getName().indexOf('digest-snapshot-') === 0) {
      candidates.push(file);
    }
  }

  if (candidates.length === 0) {
    Logger.log('No previous snapshot found — this must be the first run.');
    return null;
  }

  candidates.sort(function(a, b) { return b.getName().localeCompare(a.getName()); });
  Logger.log('Using previous snapshot: ' + candidates[0].getName());
  return JSON.parse(candidates[0].getBlob().getDataAsString());
}

// Used by the weekly digest for week-over-week profitability comparison.
function getSnapshotFromApproxDaysAgo_(daysAgo, toleranceDays) {
  var folder = getSnapshotFolder_();
  var files = folder.getFiles();
  var target = new Date();
  target.setDate(target.getDate() - daysAgo);

  var best = null;
  var bestDiff = Infinity;

  while (files.hasNext()) {
    var file = files.next();
    var match = file.getName().match(/^digest-snapshot-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!match) continue;
    var fileDate = new Date(match[1] + 'T00:00:00');
    var diff = Math.abs(fileDate - target);
    if (diff < bestDiff) { bestDiff = diff; best = file; }
  }

  if (!best || bestDiff > toleranceDays * 24 * 60 * 60 * 1000) return null;
  return JSON.parse(best.getBlob().getDataAsString());
}

function cleanUpOldSnapshots_() {
  var folder = getSnapshotFolder_();
  var files = folder.getFiles();
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SNAPSHOT_RETENTION_DAYS);

  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    var isSnapshot = name.indexOf(TASK_SNAPSHOT_PREFIX) === 0 || name.indexOf(PHASE_SNAPSHOT_PREFIX) === 0;
    if (isSnapshot && file.getDateCreated() < cutoff) {
      file.setTrashed(true);
      Logger.log('Deleted old snapshot: ' + file.getName());
    }
  }
}


// ====== PROFITABILITY DROP DETECTION ======
function getProjectProfitSnapshot_(rows) {
  var map = {};
  rows.forEach(function(row) {
    if (!(row.ProjectId in map)) {
      map[row.ProjectId] = { projectName: row.ProjectName, pm: row.SES_PM, expectedProfitPercent: row.ExpectedProfitPercent };
    }
  });
  return map;
}

function findProfitabilityDrops_(todayRows, previousRows) {
  var todayProjects = getProjectProfitSnapshot_(todayRows);
  var previousProjects = getProjectProfitSnapshot_(previousRows);

  var drops = [];
  Object.keys(todayProjects).forEach(function(projectId) {
    var today = todayProjects[projectId];
    var previous = previousProjects[projectId];
    if (!previous || today.expectedProfitPercent == null || previous.expectedProfitPercent == null) return;

    var change = today.expectedProfitPercent - previous.expectedProfitPercent;
    if (change < -PROFIT_DROP_THRESHOLD) {
      drops.push({
        projectId: Number(projectId),
        projectName: today.projectName,
        pm: today.pm,
        yesterdayPercent: previous.expectedProfitPercent,
        todayPercent: today.expectedProfitPercent,
        change: change
      });
    }
  });
  return drops;
}


// ====== HOURS-EXCEEDED-ESTIMATE DETECTION (fires once per task, ever) ======
function getAlreadyNotifiedTaskIds_() {
  var data = getHoursExceededNotifiedSheet_().getDataRange().getValues();
  var set = {};
  for (var i = 1; i < data.length; i++) set[data[i][0]] = true;
  return set;
}

function markTasksAsNotified_(taskIds) {
  if (taskIds.length === 0) return;
  var sheet = getHoursExceededNotifiedSheet_();
  var today = new Date().toISOString();
  sheet.getRange(sheet.getLastRow() + 1, 1, taskIds.length, 2)
    .setValues(taskIds.map(function(id) { return [id, today]; }));
}

function findHoursExceededTasks_(todayRows) {
  var alreadyNotified = getAlreadyNotifiedTaskIds_();
  return todayRows.filter(function(row) {
    if (!row.EstimatedHours || row.EstimatedHours <= MIN_ESTIMATED_HOURS_FOR_ALERT) return false;
    if (row.ActualHours <= row.EstimatedHours) return false;
    return !alreadyNotified[row.TaskId];
  });
}


// ====== EMAIL HELPERS ======
function notifyAdmin_(subject, body) {
  try {
    GmailApp.sendEmail(ADMIN_EMAIL, subject, body);
    Logger.log('Admin alert sent: ' + subject);
  } catch (mailError) {
    Logger.log('Could not send admin alert "' + subject + '": ' + mailError);
  }
}

// Wraps a trigger entry point so any thrown error is emailed to the admin, then
// re-thrown so the Executions panel still shows it as Failed. (A hard execution
// timeout can't be caught here — requireTodaysSnapshot_ covers that case.)
function runWithErrorAlert_(name, fn) {
  try {
    fn();
  } catch (e) {
    notifyAdmin_('[Birdview Digest] ' + name + ' failed', name + ' threw an error:\n\n' + (e && e.stack ? e.stack : e));
    throw e;
  }
}

function groupRowsByProject_(rows) {
  var map = {};
  rows.forEach(function(row) {
    if (!map[row.ProjectId]) map[row.ProjectId] = { projectName: row.ProjectName, tasks: [] };
    map[row.ProjectId].tasks.push(row);
  });
  return map;
}

function sendDigestEmail_(pmName, subject, htmlBody) {
  var email = getPmEmail_(pmName);
  if (!email) {
    Logger.log('No email mapped for PM "' + pmName + '" — skipping send.');
    return;
  }
  GmailApp.sendEmail(email, subject, '', { htmlBody: htmlBody });
  Logger.log('Sent email to ' + pmName + ' (' + email + '): ' + subject);
}


// ====== EMAIL: DAILY URGENT ALERT (current/live design) ======
function buildDailyUrgentEmailHtml_(pmName, hoursExceededRows, profitDrops) {
  var html = '<p>Hi ' + pmName + ',</p><p>Here are today\'s urgent project alerts:</p>';

  if (hoursExceededRows.length > 0) {
    html += '<h3>&#9200; Tasks that have exceeded their estimated hours</h3><ul>';
    var byProject = groupRowsByProject_(hoursExceededRows);
    Object.keys(byProject).forEach(function(projectId) {
      var group = byProject[projectId];
      html += '<li><strong>' + group.projectName + '</strong><ul>';
      group.tasks.forEach(function(row) {
        html += '<li><a href="' + row.TaskUrl + '">' + row.ParentBreadcrumb + ' / ' + row.TaskName + '</a> (A: ' +
          row.ActualHours.toFixed(1) + ' h / E: ' + row.EstimatedHours.toFixed(1) + ' h)</li>';
      });
      html += '</ul></li>';
    });
    html += '</ul>';
  }

  if (profitDrops.length > 0) {
    html += '<h3>&#128201; Projects with a drop in expected profit</h3><ul>';
    profitDrops.forEach(function(drop) {
      html += '<li><a href="' + buildProjectUrl_(drop.projectId) + '">' + drop.projectName + '</a> (' +
        drop.yesterdayPercent.toFixed(1) + '% &rarr; ' + drop.todayPercent.toFixed(1) + '%)</li>';
    });
    html += '</ul>';
  }

  html += '<p style="color:#888;font-size:12px;">Automated alert from the Birdview Daily Digest trial.</p>';
  return html;
}

// ====== ORCHESTRATION: DAILY URGENT (current/live design, no Gemini call) ======
function runDailyUrgentCheck() {
  var todayRows = buildDailyDigestDataset();
  saveTodaysSnapshot_(todayRows);

  var previousRows = getMostRecentPastSnapshot_() || [];
  var hoursExceeded = findHoursExceededTasks_(todayRows);
  var profitDrops = findProfitabilityDrops_(todayRows, previousRows);

  var pmSet = {};
  hoursExceeded.forEach(function(row) { pmSet[row.SES_PM] = true; });
  profitDrops.forEach(function(drop) { pmSet[drop.pm] = true; });

  var notifiedTaskIds = [];

  Object.keys(pmSet).forEach(function(pmName) {
    if (!getPmEmail_(pmName)) return; // not in the trial yet — don't mark their tasks as notified
    var pmHoursExceeded = hoursExceeded.filter(function(row) { return row.SES_PM === pmName; });
    var pmProfitDrops = profitDrops.filter(function(d) { return d.pm === pmName; });
    if (pmHoursExceeded.length === 0 && pmProfitDrops.length === 0) return;

    var emailBody = buildDailyUrgentEmailHtml_(pmName, pmHoursExceeded, pmProfitDrops);
    sendDigestEmail_(pmName, 'Urgent: Project Alerts - ' + formatDateForFilename_(new Date()), emailBody);

    pmHoursExceeded.forEach(function(row) { notifiedTaskIds.push(row.TaskId); });
  });

  markTasksAsNotified_(notifiedTaskIds);
  cleanUpOldSnapshots_();
}


// ====== WEEKLY DIGEST (Mondays) ======
function buildWeeklyTaskGroups_(flaggedRowsForPm) {
  var byProject = groupRowsByProject_(flaggedRowsForPm);
  var individualTasks = [];
  var summarizedProjects = [];

  Object.keys(byProject).forEach(function(projectId) {
    var group = byProject[projectId];
    if (group.tasks.length > 2) {
      summarizedProjects.push({
        projectId: Number(projectId),
        projectName: group.projectName,
        count: group.tasks.length,
        exampleTaskName: group.tasks[0].TaskName
      });
    } else {
      group.tasks.forEach(function(row) { individualTasks.push(row); });
    }
  });

  return { individualTasks: individualTasks, summarizedProjects: summarizedProjects };
}

function buildWeeklyProfitabilitySummary_(pmName, todayRows, weekAgoRows) {
  var todaySnap = getProjectProfitSnapshot_(todayRows);
  var weekAgoSnap = getProjectProfitSnapshot_(weekAgoRows || []);

  var summary = [];
  Object.keys(todaySnap).forEach(function(projectId) {
    var proj = todaySnap[projectId];
    if (proj.pm !== pmName) return;
    var weekAgo = weekAgoSnap[projectId];
    var hasBoth = weekAgo && weekAgo.expectedProfitPercent != null && proj.expectedProfitPercent != null;
    summary.push({
      projectId: Number(projectId),
      projectName: proj.projectName,
      todayPercent: proj.expectedProfitPercent,
      change: hasBoth ? (proj.expectedProfitPercent - weekAgo.expectedProfitPercent) : null
    });
  });
  return summary;
}

function callGeminiForWeeklyTasks_(pmName, individualTaskRows) {
  if (individualTaskRows.length === 0) return [];

  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=' + apiKey;

  var itemsForPrompt = individualTaskRows.map(function(row) {
    return { taskId: row.TaskId, projectName: row.ProjectName, taskName: row.TaskName, parentBreadcrumb: row.ParentBreadcrumb, endDate: row.EndDate, hoursLeft: row.HoursLeft, totalHours: row.TotalHours, estimatedHours: row.EstimatedHours, actualHours: row.ActualHours, flags: row.Flags };
  });

  var responseSchema = {
    type: 'ARRAY',
    items: { type: 'OBJECT', properties: { taskId: { type: 'INTEGER' }, explanation: { type: 'STRING' } }, required: ['taskId', 'explanation'] }
  };

  var promptText = 'You are helping write a weekly project status digest for a project manager named ' + pmName + '. ' +
    'Below is a JSON array of tasks currently flagged for attention. Flags mean: RED_NO_HOURS_LEFT (zero hours left), YELLOW_LOW_HOURS (under 20% of hours remain), ' +
    'PAST_DUE (end date has passed), DUE_SOON (end date within 5 days), OVER_ESTIMATE (actual hours logged have exceeded the originally estimated hours). ' +
    'A task can have more than one flag. For each task, write ONE short, factual, plain-English sentence explaining why it matters, using the specific numbers given. ' +
    'Do not invent information not present in the data. Return exactly one entry per task, in the same order as the input.\n\n' +
    JSON.stringify(itemsForPrompt);

  var payload = { contents: [{ parts: [{ text: promptText }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: responseSchema } };
  var response = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    throw new Error('Gemini request failed (' + response.getResponseCode() + '): ' + response.getContentText());
  }
  return JSON.parse(JSON.parse(response.getContentText()).candidates[0].content.parts[0].text);
}

function buildWeeklyDigestEmailHtml_(pmName, individualTasks, taskExplanationMap, summarizedProjects, profitSummary) {
  var html = '<p>Hi ' + pmName + ',</p><p>Here\'s your weekly project status digest:</p>';

  if (individualTasks.length > 0 || summarizedProjects.length > 0) {
    html += '<h3>&#128203; Tasks needing attention</h3><ul>';
    individualTasks.forEach(function(row) {
      var explanation = taskExplanationMap[row.TaskId] || (row.TaskName + ' is flagged: ' + row.Flags);
      html += '<li><a href="' + row.TaskUrl + '"><strong>' + row.ProjectName + '</strong> — ' + row.ParentBreadcrumb + ' / ' + row.TaskName + '</a><br>' + explanation + '</li>';
    });
    summarizedProjects.forEach(function(proj) {
      html += '<li><a href="' + buildProjectUrl_(proj.projectId) + '"><strong>' + proj.projectName + '</strong></a> has ' + proj.count +
        ' flagged tasks needing attention, including "' + proj.exampleTaskName + '".</li>';
    });
    html += '</ul>';
  } else {
    html += '<p>No flagged tasks this week.</p>';
  }

  if (profitSummary.length > 0) {
    html += '<h3>&#128200; Expected profitability standing</h3><ul>';
    profitSummary.forEach(function(p) {
      var changeText;
      if (p.change != null) {
        var arrow = p.change > 0 ? '&#9650;' : (p.change < 0 ? '&#9660;' : '&#8212;');
        var color = p.change < -PROFIT_DROP_THRESHOLD ? 'color:#c00;' : (p.change > 0 ? 'color:#080;' : '');
        changeText = ' <span style="' + color + '">' + arrow + ' ' + (p.change > 0 ? '+' : '') + p.change.toFixed(1) + 'pp vs last week</span>';
      } else {
        changeText = ' (no data from last week to compare)';
      }
      html += '<li><a href="' + buildProjectUrl_(p.projectId) + '"><strong>' + p.projectName + '</strong></a>: ' +
        (p.todayPercent != null ? p.todayPercent.toFixed(1) + '%' : 'n/a') + changeText + '</li>';
    });
    html += '</ul>';
  }

  html += '<p style="color:#888;font-size:12px;">Automated weekly digest from the Birdview Daily Digest trial.</p>';
  return html;
}

// Stage 3 (Mondays): reads the snapshot runNightlyDigest saved earlier this morning —
// no ledger update or dataset rebuild here.
function runWeeklyDigest() {
  runWithErrorAlert_('runWeeklyDigest', sendWeeklyDigestFromSnapshot_);
}

function sendWeeklyDigestFromSnapshot_() {
  var todayRows = requireTodaysSnapshot_(TASK_SNAPSHOT_PREFIX, 'runWeeklyDigest');
  if (!todayRows) return;

  var weekAgoRows = getSnapshotFromApproxDaysAgo_(7, 2) || [];
  var flaggedToday = todayRows.filter(function(r) { return r.Flags && r.Flags.length > 0; });

  var pmNames = {};
  todayRows.forEach(function(row) { pmNames[row.SES_PM] = true; });

  Object.keys(pmNames).forEach(function(pmName) {
    if (!getPmEmail_(pmName)) {
      Logger.log('No email mapped for PM "' + pmName + '" — skipping (no Gemini call).');
      return;
    }
    var pmFlaggedRows = flaggedToday.filter(function(r) { return r.SES_PM === pmName; });
    var groups = buildWeeklyTaskGroups_(pmFlaggedRows);
    var profitSummary = buildWeeklyProfitabilitySummary_(pmName, todayRows, weekAgoRows);

    if (groups.individualTasks.length === 0 && groups.summarizedProjects.length === 0 && profitSummary.length === 0) return;

    var explanations = callGeminiForWeeklyTasks_(pmName, groups.individualTasks);
    var explanationMap = {};
    explanations.forEach(function(e) { explanationMap[e.taskId] = e.explanation; });

    var emailBody = buildWeeklyDigestEmailHtml_(pmName, groups.individualTasks, explanationMap, groups.summarizedProjects, profitSummary);
    sendDigestEmail_(pmName, 'Weekly Project Digest - Week of ' + formatDateForFilename_(new Date()), emailBody);
  });
}


// ====== TRIGGERS ======
function isWeekend_() {
  var day = new Date().getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

// Stage 1 — fires nightly (~2am). Builds everything and saves today's snapshots;
// sends no email. Skips Sat/Sun — Monday's run naturally covers the gap since
// the ledger watermark and snapshot comparisons just look at "since last time".
function runNightlyDigest() {
  if (isWeekend_()) {
    Logger.log('Weekend — skipping. Monday\'s run will automatically cover everything since Friday.');
    return;
  }
  runWithErrorAlert_('runNightlyDigest', runNightlyBuild_);
}

function runNightlyBuild_() {
  dailyUpdateProfitabilityLedger();
  var data = buildNightlyData_();
  saveTodaysSnapshotFile_(PHASE_SNAPSHOT_PREFIX, data.phaseRows);
  saveTodaysSnapshot_(data.taskRows); // saved last — its presence means the whole build finished
  cleanUpOldSnapshots_();
}

// Stage 2 — fires nightly (~4am), after the build. Reads today's snapshots and
// sends the [Current] + [Trial: +Phases] urgent emails (PhaseTrial.gs).
function runNightlyAlerts() {
  if (isWeekend_()) {
    Logger.log('Weekend — skipping.');
    return;
  }
  runWithErrorAlert_('runNightlyAlerts', runDailyUrgentComparison);
}

function setupTriggers() {
  var handlers = ['runNightlyDigest', 'runNightlyAlerts', 'runWeeklyDigest'];
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (handlers.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('runNightlyDigest')
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .create();

  // atHour fires somewhere within that hour, so leave a full hour after the build.
  ScriptApp.newTrigger('runNightlyAlerts')
    .timeBased()
    .everyDays(1)
    .atHour(4)
    .create();

  ScriptApp.newTrigger('runWeeklyDigest')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(6)
    .create();

  Logger.log('Triggers created.');
}

function listTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    Logger.log(trigger.getHandlerFunction() + ' — ' + trigger.getEventType() + ' trigger');
  });
}


// ====== TEST / VERIFICATION TOOLS ======
// Stage 1 by hand (ignores the weekend skip). Run this first, then
// testDailyUrgentComparison() / testWeeklyDigest(), which read its snapshots.
function testNightlyBuild() {
  runNightlyBuild_();
}

function testDailyUrgentCheck() {
  runDailyUrgentCheck();
}

function testWeeklyDigest() {
  sendWeeklyDigestFromSnapshot_();
}

function testBuildDatasetSmall() {
  var rows = buildDailyDigestDataset();
  Logger.log(JSON.stringify(rows.slice(0, 5), null, 2));
}

function verifyExpectedProfitPercent(projectId) {
  var project = birdviewGet_('/api/v2/projects/' + projectId, {});
  var tasks = getOpenTasksForProject_(projectId);
  var userRateMap = getAllUserRates_();
  var result = calculateExpectedProfitPercent_(projectId, project, tasks, userRateMap);
  Logger.log('EAC billable: ' + result.eacBillable.toFixed(2));
  Logger.log('EAC cost: ' + result.eacCost.toFixed(2));
  Logger.log('Expected Profit %: ' + result.expectedProfitPercent.toFixed(2) + '%');
}

function runVerify3656() {
  verifyExpectedProfitPercent(3656);
}

function printSesPmLookup() {
  var lookup = getSesPmLookup_();
  Object.keys(lookup).forEach(function(id) {
    Logger.log(id + '  -->  ' + lookup[id]);
  });
}

// TESTING ONLY — never call this from a trigger or scheduled function.
// Wipes both "already notified" tracking sheets, so the next test run
// re-flags everything currently over threshold, as if for the first time.
function clearNotifiedTrackingForTesting_() {
  writeRows_(getHoursExceededNotifiedSheet_(), []);
  writeRows_(getPhaseThresholdNotifiedSheet_(), []); // lives in PhaseTrial.gs
  Logger.log('Cleared HoursExceededNotified and PhaseThresholdNotified — next run will re-flag everything currently over threshold.');
}

function testClearNotifiedTracking() {
  clearNotifiedTrackingForTesting_();
}
