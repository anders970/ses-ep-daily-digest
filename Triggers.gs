// ==========================================================================
// TRIGGERS — the staged nightly/weekly pipeline
//
// Each stage hands off to the next via today's Drive snapshot, so no single
// execution both builds data and sends email:
//   ~2am      runNightlyDigest  — ledger update + dataset build, saves snapshots
//   ~4am      runNightlyAlerts  — reads snapshots, sends daily urgent emails
//   ~6am Mon  runWeeklyDigest   — reads snapshot, sends weekly digests
// ==========================================================================


// ====== PIPELINE STAGES ======

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
  saveTodaysSnapshot_(PHASE_SNAPSHOT_PREFIX, data.phaseRows);
  saveTodaysSnapshot_(TASK_SNAPSHOT_PREFIX, data.taskRows); // saved last — its presence means the whole build finished
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

// Stage 3 (Mondays): reads the snapshot runNightlyDigest saved earlier this morning —
// no ledger update or dataset rebuild here.
function runWeeklyDigest() {
  runWithErrorAlert_('runWeeklyDigest', sendWeeklyDigestFromSnapshot_);
}

function isWeekend_() {
  var day = new Date().getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}


// ====== FAILURE ALERTS ======

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

function notifyAdmin_(subject, body) {
  try {
    GmailApp.sendEmail(ADMIN_EMAIL, subject, body);
    Logger.log('Admin alert sent: ' + subject);
  } catch (mailError) {
    Logger.log('Could not send admin alert "' + subject + '": ' + mailError);
  }
}


// ====== TRIGGER SETUP ======

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
