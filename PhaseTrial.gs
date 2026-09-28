// ==========================================================================
// PHASE-LEVEL ALERT TRIAL (A/B test)
//
// Rolls hours up to each project's top-level "phase" tasks and sends a second,
// separately-labeled "[Trial: +Phases]" email next to the "[Current]" one so
// the two designs can be compared. Phase rows are built during the nightly
// build (buildNightlyData_ calls buildPhaseRowsForProject_). Once the trial is
// decided, fold the winner into DailyAlerts.gs and delete this file.
// ==========================================================================


// ====== THRESHOLDS ======

const PHASE_THRESHOLD_PERCENT = 66;

const MIN_PHASE_ESTIMATED_HOURS = 20;


// ====== PHASE AGGREGATION ======

// Phases = top-level tasks that have children. Each open leaf task's hours roll
// up to its top-level ancestor. (Aggregation logic taken verbatim from the live
// Apps Script version.)
function buildPhaseAggregates_(allTasks, hoursMap) {
  var taskById = {};
  allTasks.forEach(function(t) { taskById[t.TaskId] = t; });

  function getTopLevelAncestorId_(taskId) {
    var current = taskById[taskId];
    while (current && current.ParentId) {
      var parent = taskById[current.ParentId];
      if (!parent) break;
      current = parent;
    }
    return current ? current.TaskId : null;
  }

  var phases = {};
  allTasks.forEach(function(t) {
    if (!t.ParentId && t.HasChild) {
      phases[t.TaskId] = { taskId: t.TaskId, name: t.Name, estimatedHours: 0, actualHours: 0 };
    }
  });

  getOpenLeafTasksFromAll_(allTasks).forEach(function(task) {
    var topId = getTopLevelAncestorId_(task.TaskId);
    if (topId != null && phases[topId]) {
      phases[topId].estimatedHours += (task.EstimatedHours || 0);
      phases[topId].actualHours += (hoursMap[task.TaskId] || 0);
    }
  });

  return Object.keys(phases).map(function(id) { return phases[id]; });
}

// One row per phase for a single project. Called from buildNightlyData_ (Dataset.gs)
// with the tasks + hours it already fetched, so there's no second Birdview pass.
function buildPhaseRowsForProject_(project, pmName, allTasks, hoursMap) {
  return buildPhaseAggregates_(allTasks, hoursMap).map(function(phase) {
    return {
      ProjectId: project.ProjectId,
      ProjectName: project.Name,
      SES_PM: pmName,
      PhaseTaskId: phase.taskId,
      PhaseName: phase.name,
      PhaseUrl: buildTaskUrl_(phase.taskId),
      EstimatedHours: phase.estimatedHours,
      ActualHours: phase.actualHours
    };
  });
}


// ====== "FIRE ONCE, EVER" TRACKING (same pattern as HoursExceededNotified) ======

function getPhaseThresholdNotifiedSheet_() {
  return getLedgerSpreadsheet_().getSheetByName('PhaseThresholdNotified');
}

function getAlreadyNotifiedPhaseIds_() {
  var data = getPhaseThresholdNotifiedSheet_().getDataRange().getValues();
  var set = {};
  for (var i = 1; i < data.length; i++) set[data[i][0]] = true;
  return set;
}

function markPhasesAsNotified_(phaseTaskIds) {
  if (phaseTaskIds.length === 0) return;
  var sheet = getPhaseThresholdNotifiedSheet_();
  var today = new Date().toISOString();
  sheet.getRange(sheet.getLastRow() + 1, 1, phaseTaskIds.length, 2)
    .setValues(phaseTaskIds.map(function(id) { return [id, today]; }));
}

function findPhasesOverThreshold_(phaseRows) {
  var alreadyNotified = getAlreadyNotifiedPhaseIds_();
  return phaseRows.filter(function(phase) {
    if (!phase.EstimatedHours || phase.EstimatedHours < MIN_PHASE_ESTIMATED_HOURS) return false;
    var percentUsed = (phase.ActualHours / phase.EstimatedHours) * 100;
    if (percentUsed < PHASE_THRESHOLD_PERCENT) return false;
    return !alreadyNotified[phase.PhaseTaskId];
  });
}


// ====== EMAIL ======

function buildDailyUrgentEmailHtmlWithPhases_(pmName, hoursExceededRows, phasesOverThreshold, profitDrops) {
  var html = '<p>Hi ' + pmName + ',</p><p>Here are today\'s urgent project alerts (TRIAL — includes phase-level alerts):</p>';

  html += buildHoursExceededSectionHtml_(hoursExceededRows);
  if (phasesOverThreshold.length > 0) {
    html += '<h3>&#128202; Project phases nearing/over ' + PHASE_THRESHOLD_PERCENT + '% of estimated hours</h3><ul>';
    phasesOverThreshold.forEach(function(phase) {
      var percent = (phase.ActualHours / phase.EstimatedHours) * 100;
      html += '<li><a href="' + phase.PhaseUrl + '">' + phase.ProjectName + ' — ' + phase.PhaseName + '</a> - ' +
        percent.toFixed(0) + '% (' + phase.ActualHours.toFixed(1) + ' / ' + phase.EstimatedHours.toFixed(1) + ') of hours used.</li>';
    });
    html += '</ul>';
  }

  html += buildProfitDropsSectionHtml_(profitDrops);
  html += '<p style="color:#888;font-size:12px;">Automated TRIAL alert — comparing against the current live design.</p>';
  return html;
}


// ====== ORCHESTRATION (stage 2 — sends BOTH emails) ======

// Stage 2 (runNightlyAlerts): reads the snapshots runNightlyDigest saved earlier
// tonight — no Birdview fetching here.
function runDailyUrgentComparison() {
  var todayRows = requireTodaysSnapshot_(TASK_SNAPSHOT_PREFIX, 'runNightlyAlerts');
  if (!todayRows) return;
  var phaseRows = requireTodaysSnapshot_(PHASE_SNAPSHOT_PREFIX, 'runNightlyAlerts');
  if (!phaseRows) return;

  var previousRows = getMostRecentPastSnapshot_() || [];
  var hoursExceeded = findHoursExceededTasks_(todayRows);
  var profitDrops = findProfitabilityDrops_(todayRows, previousRows);

  var phasesOverThreshold = findPhasesOverThreshold_(phaseRows);

  var pmSet = {};
  hoursExceeded.forEach(function(row) { pmSet[row.SES_PM] = true; });
  profitDrops.forEach(function(drop) { pmSet[drop.pm] = true; });
  phasesOverThreshold.forEach(function(phase) { pmSet[phase.SES_PM] = true; });

  var notifiedTaskIds = [];
  var notifiedPhaseIds = [];

  Object.keys(pmSet).forEach(function(pmName) {
    if (!getPmEmail_(pmName)) return; // not in the trial yet — don't mark their tasks/phases as notified
    var pmHoursExceeded = hoursExceeded.filter(function(row) { return row.SES_PM === pmName; });
    var pmProfitDrops = profitDrops.filter(function(d) { return d.pm === pmName; });
    var pmPhases = phasesOverThreshold.filter(function(p) { return p.SES_PM === pmName; });

    if (pmHoursExceeded.length > 0 || pmProfitDrops.length > 0) {
      var emailV1 = buildDailyUrgentEmailHtml_(pmName, pmHoursExceeded, pmProfitDrops);
      sendDigestEmail_(pmName, '[Current] Urgent: Project Alerts - ' + formatDateForFilename_(new Date()), emailV1);
    }

    if (pmHoursExceeded.length > 0 || pmProfitDrops.length > 0 || pmPhases.length > 0) {
      var emailV2 = buildDailyUrgentEmailHtmlWithPhases_(pmName, pmHoursExceeded, pmPhases, pmProfitDrops);
      sendDigestEmail_(pmName, '[Trial: +Phases] Urgent: Project Alerts - ' + formatDateForFilename_(new Date()), emailV2);
    }

    pmHoursExceeded.forEach(function(row) { notifiedTaskIds.push(row.TaskId); });
    pmPhases.forEach(function(phase) { notifiedPhaseIds.push(phase.PhaseTaskId); });
  });

  markTasksAsNotified_(notifiedTaskIds);
  markPhasesAsNotified_(notifiedPhaseIds);
}
