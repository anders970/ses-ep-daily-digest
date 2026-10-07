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
  checkPipelineHealth_();
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
// sends the daily urgent email (DailyAlerts.gs).
function runNightlyAlerts() {
  if (isWeekend_()) {
    Logger.log('Weekend — skipping.');
    return;
  }
  runWithErrorAlert_('runNightlyAlerts', sendDailyUrgentAlertsFromSnapshot_);
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
// Also records the time of each successful run for checkPipelineHealth_.
function runWithErrorAlert_(name, fn) {
  try {
    fn();
    PropertiesService.getScriptProperties().setProperty(LAST_SUCCESS_PROPERTY_PREFIX + name, new Date().toISOString());
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


// ====== WATCHDOG ======

// Runs at the start of every weekday build (runNightlyDigest). Catches the
// failures nothing else reports: a trigger that was deleted/disabled, or a
// later stage that stopped running entirely (its own error alerts can't fire
// if it never starts). The build stage itself is covered by the
// missing-snapshot alerts in stages 2/3. Never throws — it must not block
// the build.
function checkPipelineHealth_() {
  try {
    var problems = [];

    var handlers = ScriptApp.getProjectTriggers().map(function(t) { return t.getHandlerFunction(); });
    PIPELINE_TRIGGERS.forEach(function(name) {
      if (handlers.indexOf(name) === -1) problems.push('No trigger exists for ' + name + ' — run setupTriggers().');
    });

    var props = PropertiesService.getScriptProperties();
    var now = new Date();
    Object.keys(PIPELINE_MAX_DAYS_SINCE_SUCCESS).forEach(function(name) {
      var last = props.getProperty(LAST_SUCCESS_PROPERTY_PREFIX + name);
      if (!last) {
        // First run after this check was deployed — start the clock instead of alerting.
        props.setProperty(LAST_SUCCESS_PROPERTY_PREFIX + name, now.toISOString());
        return;
      }
      var daysSince = (now - new Date(last)) / (1000 * 60 * 60 * 24);
      if (daysSince > PIPELINE_MAX_DAYS_SINCE_SUCCESS[name]) {
        problems.push(name + ' has not completed successfully since ' + last.slice(0, 10) +
          ' (' + daysSince.toFixed(1) + ' days). Check the Executions panel.');
      }
    });

    if (problems.length > 0) {
      notifyAdmin_('[Birdview Digest] Pipeline health check: ' + problems.length + ' problem(s)',
        problems.map(function(p) { return '- ' + p; }).join('\n'));
    }
  } catch (e) {
    Logger.log('Pipeline health check itself failed: ' + e);
  }
}


// ====== TRIGGER SETUP ======

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (PIPELINE_TRIGGERS.indexOf(trigger.getHandlerFunction()) !== -1) {
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

// Deletes this project's pipeline triggers. Run in the OLD project after the
// migrated one is live, so PMs don't get every email twice.
function removeTriggers() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (PIPELINE_TRIGGERS.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  Logger.log('Removed ' + removed + ' pipeline trigger(s).');
}

function listTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    Logger.log(trigger.getHandlerFunction() + ' — ' + trigger.getEventType() + ' trigger');
  });
}
