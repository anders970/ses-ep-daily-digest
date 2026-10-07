// ==========================================================================
// PROFITABILITY LEDGER — sheet storage + Expected Profit %
//
// LockedTotals holds aggregated cost of old/locked time entries; TimeLogDetail
// holds the rolling window of recent, still-editable entries (see CLAUDE.md).
// ==========================================================================


// ====== SHEET CONNECTIONS ======

var ledgerSpreadsheetCache_ = null; // opened once per execution

// The trial deployment's original sheet. Used only when the
// LEDGER_SPREADSHEET_ID Script Property isn't set (setupLedgerSpreadsheet sets it).
var LEGACY_LEDGER_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1_zIy-0HMHkAh2v01IzbZizEqVqoA9VSbWrUYEMxjdsA/edit?usp=sharing';

function getLedgerSpreadsheet_() {
  if (!ledgerSpreadsheetCache_) {
    var id = PropertiesService.getScriptProperties().getProperty('LEDGER_SPREADSHEET_ID');
    ledgerSpreadsheetCache_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.openByUrl(LEGACY_LEDGER_SHEET_URL);
  }
  return ledgerSpreadsheetCache_;
}

// One-time, on a fresh deployment (e.g. the SES Workspace migration): creates
// the ledger spreadsheet with all four tabs and headers in the running
// account's Drive, and points the script at it via the LEDGER_SPREADSHEET_ID
// Script Property. Refuses to run if that property is already set, so it
// can't silently replace a live ledger. Follow with backfillProfitabilityLedger().
function setupLedgerSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('LEDGER_SPREADSHEET_ID')) {
    throw new Error('LEDGER_SPREADSHEET_ID is already set — delete that Script Property first if you really want a new ledger.');
  }
  var tabs = {
    TimeLogDetail: ['TimeEntryId', 'ProjectId', 'Cost', 'LastModificationDate'],
    LockedTotals: ['ProjectId', 'LockedLaborCost', 'LockedThroughDate'],
    HoursExceededNotified: ['TaskId', 'NotifiedDate'],
    PhaseThresholdNotified: ['TaskId', 'NotifiedDate']
  };
  var spreadsheet = SpreadsheetApp.create('Birdview Digest Ledger');
  var first = true;
  Object.keys(tabs).forEach(function(name) {
    var sheet = first ? spreadsheet.getSheets()[0].setName(name) : spreadsheet.insertSheet(name);
    first = false;
    sheet.getRange(1, 1, 1, tabs[name].length).setValues([tabs[name]]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  });
  props.setProperty('LEDGER_SPREADSHEET_ID', spreadsheet.getId());
  Logger.log('Created ledger spreadsheet: ' + spreadsheet.getUrl() + ' — now run backfillProfitabilityLedger().');
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


// ====== LEDGER READ / WRITE ======

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

// ====== LOCK DATES (always compared as 'yyyy-MM-dd' day strings) ======
//
// LockedThroughDate means "every billable entry dated BEFORE this day is
// already summed into LockedLaborCost". Entries are compared by their day
// string, never as timestamps, so a time-zone mismatch between this script
// and Birdview's EntryDateFrom filter can't drop an entry at the boundary.

// Today minus LOCK_BUFFER_DAYS, in the script's time zone.
function getLockCutoffDay_() {
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOCK_BUFFER_DAYS);
  return formatDateForFilename_(cutoff);
}

// Normalizes whatever the sheet (or Birdview) holds into 'yyyy-MM-dd':
// Sheets turns written day strings into Date objects, and older rows hold
// full ISO timestamps (e.g. 2026-08-14T07:00:00.000Z = local midnight).
function toLockDay_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') return formatDateForFilename_(value);
  var text = String(value || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) return formatDateForFilename_(new Date(text)); // has a zone: convert to local day
  return text.slice(0, 10); // Birdview-style "2026-08-14T00:00:00": take the day as written
}

// Splits one project's billable time logs at cutoffDay: cost of entries dated
// before it is returned as lockedCost; the rest become TimeLogDetail rows.
function splitTimeLogsAtDay_(projectId, timeLogs, cutoffDay) {
  var lockedCost = 0;
  var detailRows = [];
  timeLogs.forEach(function(log) {
    var calculatedCost = (log.Duration || 0) * (log.InternalRate || 0);
    if (toLockDay_(log.EntryDate) < cutoffDay) {
      lockedCost += calculatedCost;
    } else {
      detailRows.push([log.TimeEntryId, projectId, calculatedCost, log.LastModificationDate]);
    }
  });
  return { lockedCost: lockedCost, detailRows: detailRows };
}

// Run once on a fresh setup.
function backfillProfitabilityLedger() {
  var cutoffDay = getLockCutoffDay_();
  var projects = getOpenFlatFeeProjects_();
  Logger.log('Backfilling ' + projects.length + ' open Flat Fee projects...');

  var lockedRows = [];
  var timeLogDetailRows = [];

  projects.forEach(function(project) {
    var projectId = project.ProjectId;
    var timeLogs = birdviewGetAllPages_('/api/v2/timelogs', { ProjectIds: projectId, Billable: true });
    var split = splitTimeLogsAtDay_(projectId, timeLogs, cutoffDay);
    lockedRows.push([projectId, split.lockedCost, cutoffDay]);
    timeLogDetailRows = timeLogDetailRows.concat(split.detailRows);
  });

  writeRows_(getLockedTotalsSheet_(), lockedRows);
  writeRows_(getTimeLogDetailSheet_(), timeLogDetailRows);
  Logger.log('Done. ' + lockedRows.length + ' projects locked through ' + cutoffDay + '. ' + timeLogDetailRows.length + ' recent time logs staged.');
}

// Run every night (via runNightlyDigest). Re-fetches each project's billable
// time logs from its LockedThroughDate onward, and ROLLS OVER: entries now
// older than LOCK_BUFFER_DAYS are added to LockedLaborCost and the lock date
// advances to the new cutoff, so the fetch window and TimeLogDetail stay at
// roughly LOCK_BUFFER_DAYS instead of growing forever. Locked + detail cost
// per project is unchanged by a rollover — the same entries, split differently.
function dailyUpdateProfitabilityLedger() {
  var projects = getOpenFlatFeeProjects_();
  var lockedMap = readLockedTotalsMap_();
  var cutoffDay = getLockCutoffDay_();

  var timeLogDetailRows = [];
  var newLockedRows = [];
  var rolledOverEntries = 0;

  projects.forEach(function(project) {
    var projectId = project.ProjectId;
    var existing = lockedMap[projectId];
    var lockedLaborCost = existing ? (Number(existing.lockedLaborCost) || 0) : 0;
    var lockedThroughDay = toLockDay_(existing ? existing.lockedThroughDate : project.CreationDate);

    var timeLogs = birdviewGetAllPages_('/api/v2/timelogs', { ProjectIds: projectId, Billable: true, EntryDateFrom: lockedThroughDay });

    // Never move the lock date backwards (e.g. a project newer than the cutoff).
    var newLockedThroughDay = cutoffDay > lockedThroughDay ? cutoffDay : lockedThroughDay;
    var split = splitTimeLogsAtDay_(projectId, timeLogs, newLockedThroughDay);
    rolledOverEntries += timeLogs.length - split.detailRows.length;

    newLockedRows.push([projectId, lockedLaborCost + split.lockedCost, newLockedThroughDay]);
    timeLogDetailRows = timeLogDetailRows.concat(split.detailRows);
  });

  writeRows_(getTimeLogDetailSheet_(), timeLogDetailRows);
  writeRows_(getLockedTotalsSheet_(), newLockedRows);
  Logger.log('Daily update complete. ' + projects.length + ' projects checked. ' + rolledOverEntries +
    ' time logs rolled into LockedTotals (locked through ' + cutoffDay + '). ' + timeLogDetailRows.length + ' time logs in the active window.');
}

// Integrity check (manual, via Tests.gs): for each project, compares the
// ledger's actual labour cost (LockedLaborCost + TimeLogDetail) with a full
// re-sum of every billable time log in Birdview. Returns the mismatches.
function checkLedgerIntegrity_(maxProjects) {
  var ledger = readLedgerCosts_();
  var projects = getOpenFlatFeeProjects_().slice(0, maxProjects || Infinity);
  var mismatches = [];
  projects.forEach(function(project) {
    var projectId = project.ProjectId;
    var fullCost = birdviewGetAllPages_('/api/v2/timelogs', { ProjectIds: projectId, Billable: true })
      .reduce(function(sum, log) { return sum + (log.Duration || 0) * (log.InternalRate || 0); }, 0);
    var locked = ledger.lockedMap[projectId];
    var ledgerCost = (locked ? Number(locked.lockedLaborCost) || 0 : 0) + (ledger.recentCostByProject[projectId] || 0);
    if (Math.abs(fullCost - ledgerCost) > 0.01) {
      mismatches.push({ projectId: projectId, name: project.Name, birdview: fullCost, ledger: ledgerCost, diff: ledgerCost - fullCost });
    }
  });
  Logger.log('Ledger integrity: ' + projects.length + ' projects checked, ' + mismatches.length + ' mismatches.');
  mismatches.forEach(function(m) {
    Logger.log('  MISMATCH ' + m.projectId + ' ' + m.name + ': ledger $' + m.ledger.toFixed(2) + ' vs Birdview $' + m.birdview.toFixed(2) + ' (diff $' + m.diff.toFixed(2) + ')');
  });
  return mismatches;
}


// ====== EXPECTED PROFIT % ======

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
