// ==========================================================================
// DAILY URGENT ALERTS — detection + the "[Current]" email
//
// Sent by runDailyUrgentComparison (PhaseTrial.gs) during the phase trial.
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
    if (change < -PROFIT_DROP_THRESHOLD) {
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

// Shared by the [Current] and [Trial: +Phases] emails. Each returns '' when empty.
function buildHoursExceededSectionHtml_(hoursExceededRows) {
  if (hoursExceededRows.length === 0) return '';
  var html = '<h3>&#9200; Tasks that have exceeded their estimated hours</h3><ul>';
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
  return html + '</ul>';
}

function buildProfitDropsSectionHtml_(profitDrops) {
  if (profitDrops.length === 0) return '';
  var html = '<h3>&#128201; Projects with a drop in expected profit</h3><ul>';
  profitDrops.forEach(function(drop) {
    html += '<li><a href="' + buildProjectUrl_(drop.projectId) + '">' + drop.projectName + '</a> (' +
      drop.yesterdayPercent.toFixed(1) + '% &rarr; ' + drop.todayPercent.toFixed(1) + '%)</li>';
  });
  return html + '</ul>';
}

function buildDailyUrgentEmailHtml_(pmName, hoursExceededRows, profitDrops) {
  var html = '<p>Hi ' + pmName + ',</p><p>Here are today\'s urgent project alerts:</p>';

  html += buildHoursExceededSectionHtml_(hoursExceededRows);
  html += buildProfitDropsSectionHtml_(profitDrops);
  html += '<p style="color:#888;font-size:12px;">Automated alert from the Birdview Daily Digest trial.</p>';
  return html;
}
