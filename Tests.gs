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
