// ==========================================================================
// DATASET + SNAPSHOTS — the nightly build and its Drive hand-off files
// ==========================================================================


// ====== DATASET BUILD (one row per open leaf task) ======

// Single pass over all projects producing both the task rows and PhaseAlerts.gs's
// phase rows, so each project's tasks/time logs are only fetched once per night.
function buildNightlyData_() {
  var projects = getOpenFlatFeeProjects_();
  var pmLookup = getSesPmLookup_();
  var userRateMap = getAllUserRates_();
  var ledgerCosts = readLedgerCosts_();
  var rows = [];
  var phaseRows = [];

  projects.forEach(function(project) {
    var projectId = project.ProjectId;
    var pmId = project.CustomFields ? project.CustomFields[CUSTOM_FIELD_SES_PM] : null;
    var pmName = pmLookup[pmId] || 'Unassigned';

    var allTasks = getAllTasksForProject_(projectId);
    var taskLookup = buildTaskLookup_(allTasks);
    var tasks = getOpenLeafTasksFromAll_(allTasks);

    var hoursMap = getActualHoursByTaskForProject_(projectId);
    var profitData = calculateExpectedProfitPercent_(projectId, project, tasks, userRateMap, ledgerCosts);

    tasks.forEach(function(task) {
      var actualHours = hoursMap[task.TaskId] || 0;

      rows.push({
        ProjectId: projectId,
        ProjectName: project.Name,
        SES_PM: pmName,
        ExpectedProfitPercent: profitData.expectedProfitPercent,
        TaskId: task.TaskId,
        TaskName: task.Name,
        ParentBreadcrumb: buildParentBreadcrumb_(task.TaskId, taskLookup),
        TaskUrl: buildTaskUrl_(task.TaskId),
        EndDate: task.EndDate,
        HoursLeft: task.HoursLeft,
        ActualHours: actualHours,
        EstimatedHours: task.EstimatedHours || 0,
        TotalHours: actualHours + (task.HoursLeft || 0),
        Flags: buildTaskFlags_(task, actualHours).join(', ')
      });
    });

    phaseRows = phaseRows.concat(buildPhaseRowsForProject_(project, pmName, allTasks, hoursMap)); // PhaseAlerts.gs
  });

  Logger.log('Built ' + rows.length + ' task rows and ' + phaseRows.length + ' phase rows across ' + projects.length + ' projects.');
  return { taskRows: rows, phaseRows: phaseRows };
}

function buildTaskFlags_(task, actualHoursForThisTask) {
  var flags = [];
  var totalHours = actualHoursForThisTask + (task.HoursLeft || 0);

  if (totalHours > 0) {
    if (task.HoursLeft <= 0) {
      flags.push('RED_NO_HOURS_LEFT');
    } else if ((task.HoursLeft / totalHours) * 100 < 20) {
      flags.push('YELLOW_LOW_HOURS');
    }
  }

  if (task.EndDate) {
    var daysUntilDue = (new Date(task.EndDate) - new Date()) / (1000 * 60 * 60 * 24);
    if (daysUntilDue < 0) {
      flags.push('PAST_DUE');
    } else if (daysUntilDue <= 5) {
      flags.push('DUE_SOON');
    }
  }

  if (task.EstimatedHours && task.EstimatedHours > 0 && actualHoursForThisTask > task.EstimatedHours) {
    flags.push('OVER_ESTIMATE');
  }

  return flags;
}


// ====== SNAPSHOT FILES ======

function getSnapshotFolder_() {
  var folders = DriveApp.getFoldersByName(DIGEST_SNAPSHOT_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(DIGEST_SNAPSHOT_FOLDER_NAME);
}

function formatDateForFilename_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function todaysSnapshotFilename_(prefix) {
  return prefix + formatDateForFilename_(new Date()) + '.json';
}

function saveTodaysSnapshot_(prefix, data) {
  var folder = getSnapshotFolder_();
  var filename = todaysSnapshotFilename_(prefix);

  var existing = folder.getFilesByName(filename);
  if (existing.hasNext()) existing.next().setTrashed(true);

  folder.createFile(filename, JSON.stringify(data), MimeType.PLAIN_TEXT);
  Logger.log('Saved snapshot: ' + filename);
}

// Returns today's parsed snapshot, or null if it hasn't been saved (yet).
function loadTodaysSnapshot_(prefix) {
  var files = getSnapshotFolder_().getFilesByName(todaysSnapshotFilename_(prefix));
  return files.hasNext() ? JSON.parse(files.next().getBlob().getDataAsString()) : null;
}

// Stage 2/3 guard: today's snapshot is the hand-off from runNightlyDigest. If it's
// missing, the build stage failed or timed out — tell the admin instead of silently
// sending nothing.
function requireTodaysSnapshot_(prefix, callerName) {
  var data = loadTodaysSnapshot_(prefix);
  if (!data) {
    notifyAdmin_('[Birdview Digest] ' + callerName + ' skipped — no snapshot for today',
      callerName + ' could not find ' + todaysSnapshotFilename_(prefix) + ' in the "' + DIGEST_SNAPSHOT_FOLDER_NAME + '" Drive folder.\n\n' +
      'That means today\'s runNightlyDigest (ledger update + dataset build) did not finish — check the Apps Script Executions panel. ' +
      'No emails were sent by ' + callerName + '. To recover manually, run testNightlyBuild() and then re-run ' + callerName + '().');
  }
  return data;
}

function getMostRecentPastSnapshot_() {
  var folder = getSnapshotFolder_();
  var files = folder.getFiles();
  var todayFilename = todaysSnapshotFilename_(TASK_SNAPSHOT_PREFIX);

  var candidates = [];
  while (files.hasNext()) {
    var file = files.next();
    if (file.getName() !== todayFilename && file.getName().indexOf(TASK_SNAPSHOT_PREFIX) === 0) {
      candidates.push(file);
    }
  }

  if (candidates.length === 0) {
    Logger.log('No previous snapshot found — this must be the first run.');
    return null;
  }

  candidates.sort(function(a, b) { return b.getName().localeCompare(a.getName()); });
  Logger.log('Using previous snapshot: ' + candidates[0].getName());
  return JSON.parse(candidates[0].getBlob().getDataAsString());
}

// Used by the weekly digest for week-over-week profitability comparison.
function getSnapshotFromApproxDaysAgo_(daysAgo, toleranceDays) {
  var folder = getSnapshotFolder_();
  var files = folder.getFiles();
  var target = new Date();
  target.setDate(target.getDate() - daysAgo);

  var best = null;
  var bestDiff = Infinity;

  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    if (name.indexOf(TASK_SNAPSHOT_PREFIX) !== 0) continue;
    var fileDate = new Date(name.slice(TASK_SNAPSHOT_PREFIX.length, -'.json'.length) + 'T00:00:00');
    if (isNaN(fileDate)) continue;
    var diff = Math.abs(fileDate - target);
    if (diff < bestDiff) { bestDiff = diff; best = file; }
  }

  if (!best || bestDiff > toleranceDays * 24 * 60 * 60 * 1000) return null;
  return JSON.parse(best.getBlob().getDataAsString());
}

function cleanUpOldSnapshots_() {
  var folder = getSnapshotFolder_();
  var files = folder.getFiles();
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SNAPSHOT_RETENTION_DAYS);

  while (files.hasNext()) {
    var file = files.next();
    var name = file.getName();
    var isSnapshot = name.indexOf(TASK_SNAPSHOT_PREFIX) === 0 || name.indexOf(PHASE_SNAPSHOT_PREFIX) === 0;
    if (isSnapshot && file.getDateCreated() < cutoff) {
      file.setTrashed(true);
      Logger.log('Deleted old snapshot: ' + file.getName());
    }
  }
}
