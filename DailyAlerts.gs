// ==========================================================================
// DAILY URGENT ALERTS — detection + the single daily "urgent" email
//
// The email has one section per candidate alert rule (tasks over estimate,
// phases over threshold, profit drops) so the rules can be compared side by
// side; drop the sections that don't earn their place once decided.
// ==========================================================================


// ====== PROFIT DROP DETECTION ======

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
    if (change <= -PROFIT_DROP_THRESHOLD) {
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


// ====== EMAIL ======

// Birdview project/task names are free text — escape before putting them in HTML.
function escapeHtml_(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

// One section per candidate alert rule: heading, a grey line stating exactly
// what triggers it, then the items — or "None today." so a quiet rule is
// visible too while the rules are being evaluated.
function buildAlertSectionHtml_(title, ruleDescription, itemsHtml) {
  return '<h3 style="margin-bottom:2px;">' + title + '</h3>' +
    '<div style="color:#888;font-size:12px;margin-bottom:6px;">' + ruleDescription + '</div>' +
    (itemsHtml || '<p style="color:#888;margin-top:0;">None today.</p>');
}

function buildHoursExceededItemsHtml_(hoursExceededRows) {
  if (hoursExceededRows.length === 0) return '';
  var html = '<ul>';
  var byProject = groupRowsByProject_(hoursExceededRows);
  Object.keys(byProject).forEach(function(projectId) {
    var group = byProject[projectId];
    html += '<li><strong>' + escapeHtml_(group.projectName) + '</strong><ul>';
    group.tasks.forEach(function(row) {
      html += '<li><a href="' + row.TaskUrl + '">' + escapeHtml_(row.ParentBreadcrumb + ' / ' + row.TaskName) + '</a> (A: ' +
        row.ActualHours.toFixed(1) + ' h / E: ' + row.EstimatedHours.toFixed(1) + ' h)</li>';
    });
    html += '</ul></li>';
  });
  return html + '</ul>';
}

function buildPhasesOverThresholdItemsHtml_(phases) {
  if (phases.length === 0) return '';
  var html = '<ul>';
  phases.forEach(function(phase) {
    var percent = (phase.ActualHours / phase.EstimatedHours) * 100;
    html += '<li><a href="' + phase.PhaseUrl + '">' + escapeHtml_(phase.ProjectName + ' — ' + phase.PhaseName) + '</a> - ' +
      percent.toFixed(0) + '% (' + phase.ActualHours.toFixed(1) + ' / ' + phase.EstimatedHours.toFixed(1) + ') of hours used.</li>';
  });
  return html + '</ul>';
}

function buildProfitDropsItemsHtml_(profitDrops) {
  if (profitDrops.length === 0) return '';
  var html = '<ul>';
  profitDrops.forEach(function(drop) {
    html += '<li><a href="' + buildProjectUrl_(drop.projectId) + '">' + escapeHtml_(drop.projectName) + '</a> (' +
      drop.yesterdayPercent.toFixed(1) + '% &rarr; ' + drop.todayPercent.toFixed(1) + '%)</li>';
  });
  return html + '</ul>';
}

function buildDailyUrgentEmailHtml_(pmName, hoursExceededRows, phasesOverThreshold, profitDrops) {
  var html = '<p>Hi ' + pmName + ',</p><p>Here are today\'s urgent project alerts:</p>';

  html += buildAlertSectionHtml_('&#9200; Tasks that have exceeded their estimated hours',
    'Fires once per task when logged hours first pass the task\'s original estimate (tasks estimated over ' +
      MIN_ESTIMATED_HOURS_FOR_ALERT + ' h only).',
    buildHoursExceededItemsHtml_(hoursExceededRows));
  html += buildAlertSectionHtml_('&#128202; Project phases at ' + PHASE_THRESHOLD_PERCENT + '%+ of estimated hours',
    'Fires once per phase (top-level task with ' + MIN_PHASE_ESTIMATED_HOURS + '+ estimated hours) when open tasks under it have used ' +
      PHASE_THRESHOLD_PERCENT + '% or more of their estimated hours.',
    buildPhasesOverThresholdItemsHtml_(phasesOverThreshold));
  html += buildAlertSectionHtml_('&#128201; Projects with a drop in expected profit',
    'Fires when a project\'s Expected Profit % falls by ' + PROFIT_DROP_THRESHOLD +
      ' percentage points or more since the previous nightly snapshot.',
    buildProfitDropsItemsHtml_(profitDrops));

  html += '<p style="color:#888;font-size:12px;">Automated alert from the Birdview Daily Digest trial. ' +
    'Each section is a candidate alert rule being evaluated.</p>';
  return html;
}


// ====== ROLLOUT / MIGRATION: SEED THE "FIRE ONCE" TRACKING ======

// One-time, WITHOUT sending email: marks every task and phase that is over
// its threshold right now (for ALL PMs) as already notified. Run it after
// testNightlyBuild() on a fresh deployment, and right before adding PMs to
// PM_EMAIL_MAP — otherwise each PM's first urgent email lists every task
// that has EVER gone over estimate (tasks of unmapped PMs are deliberately
// never marked, so they'd all fire at once). Afterwards only genuinely new
// occurrences alert. Profit drops need no seeding (they compare to the
// previous snapshot). Safe to re-run: only adds IDs not already marked.
function seedNotifiedTracking() {
  var todayRows = loadTodaysSnapshot_(TASK_SNAPSHOT_PREFIX);
  var phaseRows = loadTodaysSnapshot_(PHASE_SNAPSHOT_PREFIX);
  if (!todayRows || !phaseRows) {
    throw new Error('No snapshot for today — run testNightlyBuild() first.');
  }
  var taskIds = findHoursExceededTasks_(todayRows).map(function(row) { return row.TaskId; });
  var phaseIds = findPhasesOverThreshold_(phaseRows).map(function(phase) { return phase.PhaseTaskId; });
  markTasksAsNotified_(taskIds);
  markPhasesAsNotified_(phaseIds);
  Logger.log('Seeded tracking without sending email: ' + taskIds.length + ' tasks over estimate, ' +
    phaseIds.length + ' phases over threshold marked as already notified.');
}


// ====== ORCHESTRATION (stage 2 — runNightlyAlerts) ======

// Reads the snapshots runNightlyDigest saved earlier tonight — no Birdview
// fetching here. Sends one email per PM with every candidate alert rule as its
// own section, only when at least one section has something in it.
function sendDailyUrgentAlertsFromSnapshot_() {
  var todayRows = requireTodaysSnapshot_(TASK_SNAPSHOT_PREFIX, 'runNightlyAlerts');
  if (!todayRows) return;
  var phaseRows = requireTodaysSnapshot_(PHASE_SNAPSHOT_PREFIX, 'runNightlyAlerts');
  if (!phaseRows) return;

  var previousRows = getMostRecentPastSnapshot_() || [];
  var hoursExceeded = findHoursExceededTasks_(todayRows);
  var phasesOverThreshold = findPhasesOverThreshold_(phaseRows); // PhaseAlerts.gs
  var profitDrops = findProfitabilityDrops_(todayRows, previousRows);

  var pmSet = {};
  hoursExceeded.forEach(function(row) { pmSet[row.SES_PM] = true; });
  phasesOverThreshold.forEach(function(phase) { pmSet[phase.SES_PM] = true; });
  profitDrops.forEach(function(drop) { pmSet[drop.pm] = true; });

  var notifiedTaskIds = [];
  var notifiedPhaseIds = [];

  Object.keys(pmSet).forEach(function(pmName) {
    if (!getPmEmail_(pmName)) return; // not in the trial yet — don't mark their tasks/phases as notified
    var pmHoursExceeded = hoursExceeded.filter(function(row) { return row.SES_PM === pmName; });
    var pmPhases = phasesOverThreshold.filter(function(p) { return p.SES_PM === pmName; });
    var pmProfitDrops = profitDrops.filter(function(d) { return d.pm === pmName; });

    var emailBody = buildDailyUrgentEmailHtml_(pmName, pmHoursExceeded, pmPhases, pmProfitDrops);
    sendDigestEmail_(pmName, 'Urgent: Project Alerts - ' + formatDateForFilename_(new Date()), emailBody);

    pmHoursExceeded.forEach(function(row) { notifiedTaskIds.push(row.TaskId); });
    pmPhases.forEach(function(phase) { notifiedPhaseIds.push(phase.PhaseTaskId); });
  });

  markTasksAsNotified_(notifiedTaskIds);
  markPhasesAsNotified_(notifiedPhaseIds);
}
