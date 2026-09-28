// ==========================================================================
// PROFITABILITY LEDGER — sheet storage + Expected Profit %
//
// LockedTotals holds aggregated cost of old/locked time entries; TimeLogDetail
// holds the rolling window of recent, still-editable entries (see CLAUDE.md).
// ==========================================================================


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
