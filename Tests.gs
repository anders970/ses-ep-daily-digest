// ==========================================================================
// TEST / VERIFICATION TOOLS — run by hand from the editor, never from triggers
// ==========================================================================


// ====== PIPELINE STAGES BY HAND ======

// Stage 1 by hand (ignores the weekend skip). Run this first, then
// testDailyUrgentAlerts() / testWeeklyDigest(), which read its snapshots.
function testNightlyBuild() {
  runNightlyBuild_();
}

function testDailyUrgentAlerts() {
  sendDailyUrgentAlertsFromSnapshot_();
}

function testWeeklyDigest() {
  sendWeeklyDigestFromSnapshot_();
}

// Runs the nightly ledger update (including rollover) and then checks the
// ledger against a full re-sum of Birdview time logs for the first N projects.
// Both steps in one execution, so same-day time entries can't cause false
// mismatches. Full-history fetches are slow — keep N modest (~6-min limit).
function testLedgerRolloverAndIntegrity() {
  dailyUpdateProfitabilityLedger();
  checkLedgerIntegrity_(30);
}

function testBuildDatasetSmall() {
  var rows = buildNightlyData_().taskRows;
  Logger.log(JSON.stringify(rows.slice(0, 5), null, 2));
}


// ====== VERIFICATION ======

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

// Logs a task's billing type (by name), its project's billing type, and the
// hours logged on it with their T&M value (Duration × Rate) — i.e. what a
// task left on T&M inside a Flat Fee project adds to Birdview's EAC Billable.
function printTaskBillingInfo(taskId) {
  var task = birdviewGet_('/api/v2/tasks/' + taskId, {});
  var project = birdviewGet_('/api/v2/projects/' + task.ProjectId, {});
  var taskTypes = {};
  (birdviewGet_('/api/v2/lists/billingtypes/task', {}).Items || []).forEach(function(t) { taskTypes[t.Id] = t.Name; });
  var projectTypes = {};
  (birdviewGet_('/api/v2/lists/billingtypes/project', {}).Items || []).forEach(function(t) { projectTypes[t.Id] = t.Name; });

  var logs = birdviewGetAllPages_('/api/v2/timelogs', { TaskIds: taskId });
  var hours = 0, billableHours = 0, tmValue = 0;
  logs.forEach(function(log) {
    hours += log.Duration || 0;
    if (log.Billable) billableHours += log.Duration || 0;
    tmValue += (log.Duration || 0) * (log.Rate || 0);
  });

  Logger.log('Task ' + taskId + ': "' + task.Name + '"  (status ID ' + task.TaskStatusId + (COMPLETED_TASK_STATUS_IDS.indexOf(task.TaskStatusId) !== -1 ? ' = Closed' : '') + ')');
  Logger.log('  Task billing type:    ' + task.BillingType + ' = ' + (taskTypes[task.BillingType] || '?') +
    '   (BillingAmount ' + task.BillingAmount + ', Budget ' + task.Budget + ')');
  Logger.log('  Project ' + project.ProjectId + ' "' + project.Name + '" billing type: ' + project.BillingType + ' = ' + (projectTypes[project.BillingType] || '?'));
  Logger.log('  Time logged: ' + logs.length + ' entries, ' + hours.toFixed(2) + ' h (' + billableHours.toFixed(2) + ' h billable), value at billing rates (Duration × Rate): $' + tmValue.toFixed(2));
  Logger.log('  All task billing types: ' + JSON.stringify(taskTypes));
}

function runPrintTaskBillingInfo() {
  printTaskBillingInfo(89006);
}

function printSesPmLookup() {
  var lookup = getSesPmLookup_();
  Object.keys(lookup).forEach(function(id) {
    Logger.log(id + '  -->  ' + lookup[id]);
  });
}


// ====== RESET (TESTING ONLY) ======

// TESTING ONLY — never call this from a trigger or scheduled function.
// Wipes both "already notified" tracking sheets, so the next test run
// re-flags everything currently over threshold, as if for the first time.
function clearNotifiedTrackingForTesting_() {
  writeRows_(getHoursExceededNotifiedSheet_(), []);
  writeRows_(getPhaseThresholdNotifiedSheet_(), []); // lives in PhaseAlerts.gs
  Logger.log('Cleared HoursExceededNotified and PhaseThresholdNotified — next run will re-flag everything currently over threshold.');
}

function testClearNotifiedTracking() {
  clearNotifiedTrackingForTesting_();
}
