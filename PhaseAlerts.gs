// ==========================================================================
// PHASE ALERTS — candidate alert rule shown as its own section of the daily
// "urgent" email (see DailyAlerts.gs)
//
// Rolls hours up to each project's top-level "phase" tasks. Phase rows are
// built during the nightly build (buildNightlyData_ calls
// buildPhaseRowsForProject_) and saved as their own snapshot file.
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
