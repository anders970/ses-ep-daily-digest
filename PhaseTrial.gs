// ====== PHASE-LEVEL ALERT TRIAL ======
// Compares against the current live daily-urgent design (see runNightlyDigest in Code.gs).
// Sends a second, separately-labeled email so results can be compared side by side.

const PHASE_THRESHOLD_PERCENT = 66;
const MIN_PHASE_ESTIMATED_HOURS = 20;

function getAllLeafTasksFromAll_(allTasks) {
  return allTasks.filter(function(task) {
    var isNotCompleted = COMPLETED_TASK_STATUS_IDS.indexOf(task.TaskStatusId) === -1;
    return !task.HasChild && isNotCompleted;
  });
}

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

  getAllLeafTasksFromAll_(allTasks).forEach(function(task) {
    var topId = getTopLevelAncestorId_(task.TaskId);
    if (topId != null && phases[topId]) {
      phases[topId].estimatedHours += (task.EstimatedHours || 0);
      phases[topId].actualHours += (hoursMap[task.TaskId] || 0);
    }
  });

  return Object.keys(phases).map(function(id) { return phases[id]; });
}

function buildPhaseDataset_() {
  var projects = getOpenFlatFeeProjects_();
  var pmLookup = getSesPmLookup_();
  var rows = [];

  projects.forEach(function(project) {
    var projectId = project.ProjectId;
    var pmId = project.CustomFields ? project.CustomFields[CUSTOM_FIELD_SES_PM] : null;
    var pmName = pmLookup[pmId] || 'Unassigned';

    var allTasks = getAllTasksForProject_(projectId);
    var hoursMap = getActualHoursByTaskForProject_(projectId);

    buildPhaseAggregates_(allTasks, hoursMap).forEach(function(phase) {
      rows.push({
        ProjectId: projectId,
        ProjectName: project.Name,
        SES_PM: pmName,
        PhaseTaskId: phase.taskId,
        PhaseName: phase.name,
        PhaseUrl: buildTaskUrl_(phase.taskId),
        EstimatedHours: phase.estimatedHours,
        ActualHours: phase.actualHours
      });
    });
  });

  Logger.log('Built ' + rows.length + ' phase rows across ' + projects.length + ' projects.');
  return rows;
}

function getPhaseThresholdNotifiedSheet_() {
  return getLedgerSpreadsheet_().getSheetByName('PhaseThresholdNotified');
}

function getAlreadyNotifiedPhaseIds_() {
  var data = getPhaseThresholdNotifiedSheet_().getDataRange().getValues();
  var set = {};
  for (var i = 1; i < data.length; i++) set[data[i][0]] = true;
  return set;
}

function markPhasesAsNotified_(taskIds) {
  if (taskIds.length === 0) return;
  var sheet = getPhaseThresholdNotifiedSheet_();
  var today = new Date().toISOString();
  sheet.getRange(sheet.getLastRow() + 1, 1, taskIds.length, 2)
    .setValues(taskIds.map(function(id) { return [id, today]; }));
}

function findPhasesOverThreshold_(phaseRows) {
  var alreadyNotified = getAlreadyNotifiedPhaseIds_();
  return phaseRows.filter(function(phase) {
    if (phase.EstimatedHours < MIN_PHASE_ESTIMATED_HOURS) return false;
    var percent = (phase.ActualHours / phase.EstimatedHours) * 100;
    if (percent < PHASE_THRESHOLD_PERCENT) return false;
    return !alreadyNotified[phase.PhaseTaskId];
  });
}

function buildDailyUrgentEmailHtmlWithPhases_(pmName, hoursExceededRows, phasesOverThreshold, profitDrops) {
  var html = '<p>Hi ' + pmName + ',</p><p>Here are today\'s urgent project alerts (TRIAL — includes phase-level alerts):</p>';

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

  if (phasesOverThreshold.length > 0) {
    html += '<h3>&#128202; Project phases nearing/over ' + PHASE_THRESHOLD_PERCENT + '% of estimated hours</h3><ul>';
    phasesOverThreshold.forEach(function(phase) {
      var percent = (phase.ActualHours / phase.EstimatedHours) * 100;
      html += '<li><a href="' + phase.PhaseUrl + '">' + phase.ProjectName + ' \u2014 ' + phase.PhaseName + '</a> - ' +
        percent.toFixed(0) + '% (' + phase.ActualHours.toFixed(1) + ' / ' + phase.EstimatedHours.toFixed(1) + ') of hours used.</li>';
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

  html += '<p style="color:#888;font-size:12px;">Automated TRIAL alert — comparing against the current live design.</p>';
  return html;
}

function runDailyUrgentComparison() {
  var todayRows = buildDailyDigestDataset();
  saveTodaysSnapshot_(todayRows);

  var previousRows = getMostRecentPastSnapshot_() || [];
  var hoursExceeded = findHoursExceededTasks_(todayRows);
  var profitDrops = findProfitabilityDrops_(todayRows, previousRows);
  var phaseRows = buildPhaseDataset_();
  var phasesOverThreshold = findPhasesOverThreshold_(phaseRows);

  var pmSet = {};
  hoursExceeded.forEach(function(row) { pmSet[row.SES_PM] = true; });
  profitDrops.forEach(function(drop) { pmSet[drop.pm] = true; });
  phasesOverThreshold.forEach(function(phase) { pmSet[phase.SES_PM] = true; });

  var notifiedTaskIds = [];
  var notifiedPhaseIds = [];

  Object.keys(pmSet).forEach(function(pmName) {
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
  cleanUpOldSnapshots_();
}

function testDailyUrgentComparison() {
  runDailyUrgentComparison();
}
