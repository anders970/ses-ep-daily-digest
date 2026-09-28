// ==========================================================================
// WEEKLY DIGEST (Mondays) — open tasks with 0 hours left / overdue, plus
// each project's Expected Profit % and week-over-week change
// ==========================================================================


// ====== ORCHESTRATION ======

function sendWeeklyDigestFromSnapshot_() {
  var todayRows = requireTodaysSnapshot_(TASK_SNAPSHOT_PREFIX, 'runWeeklyDigest');
  if (!todayRows) return;

  var weekAgoRows = getSnapshotFromApproxDaysAgo_(7, 2) || [];

  var pmNames = {};
  todayRows.forEach(function(row) { pmNames[row.SES_PM] = true; });

  Object.keys(pmNames).forEach(function(pmName) {
    if (!getPmEmail_(pmName)) {
      Logger.log('No email mapped for PM "' + pmName + '" — skipping.');
      return;
    }
    var pmRows = todayRows.filter(function(r) { return r.SES_PM === pmName; });

    // Most over-budget first / most overdue first, so the tasks shown before
    // "(X more tasks)" are the ones that most need attention.
    var noHoursLeft = pmRows.filter(function(r) { return hasFlag_(r, 'RED_NO_HOURS_LEFT'); })
      .sort(function(a, b) { return (b.ActualHours - b.EstimatedHours) - (a.ActualHours - a.EstimatedHours); });
    var overdue = pmRows.filter(function(r) { return hasFlag_(r, 'PAST_DUE'); })
      .sort(function(a, b) { return new Date(a.EndDate) - new Date(b.EndDate); });
    var profitSummary = buildWeeklyProfitabilitySummary_(pmName, todayRows, weekAgoRows);

    if (noHoursLeft.length === 0 && overdue.length === 0 && profitSummary.length === 0) return;

    var emailBody = buildWeeklyDigestEmailHtml_(pmName, noHoursLeft, overdue, profitSummary);
    sendDigestEmail_(pmName, 'Weekly Project Digest - Week of ' + formatDateForFilename_(new Date()), emailBody);
  });
}


// ====== CONTENT ======

// Flags is stored as a comma-separated string, e.g. "RED_NO_HOURS_LEFT, PAST_DUE".
function hasFlag_(row, flag) {
  return (row.Flags || '').split(', ').indexOf(flag) !== -1;
}

function buildWeeklyProfitabilitySummary_(pmName, todayRows, weekAgoRows) {
  var todaySnap = getProjectProfitSnapshot_(todayRows);
  var weekAgoSnap = getProjectProfitSnapshot_(weekAgoRows || []);

  var summary = [];
  Object.keys(todaySnap).forEach(function(projectId) {
    var proj = todaySnap[projectId];
    if (proj.pm !== pmName) return;
    var weekAgo = weekAgoSnap[projectId];
    var hasBoth = weekAgo && weekAgo.expectedProfitPercent != null && proj.expectedProfitPercent != null;
    summary.push({
      projectId: Number(projectId),
      projectName: proj.projectName,
      todayPercent: proj.expectedProfitPercent,
      change: hasBoth ? (proj.expectedProfitPercent - weekAgo.expectedProfitPercent) : null
    });
  });
  return summary;
}

// One task-list section:
//   Project Name (link)
//   └ Task Name (link)
//   └ (X more tasks)
// Projects are listed alphabetically; tasks keep the order they were passed in.
function buildWeeklyTaskSectionHtml_(title, rows) {
  var html = '<h3>' + title + '</h3>';
  if (rows.length === 0) return html + '<p style="color:#888;">None.</p>';

  var byProject = groupRowsByProject_(rows);
  Object.keys(byProject)
    .sort(function(a, b) { return byProject[a].projectName.localeCompare(byProject[b].projectName); })
    .forEach(function(projectId) {
      var group = byProject[projectId];
      html += '<div style="margin-top:8px;"><a href="' + buildProjectUrl_(projectId) + '"><strong>' +
        escapeHtml_(group.projectName) + '</strong></a></div>';
      group.tasks.slice(0, WEEKLY_MAX_TASKS_PER_PROJECT).forEach(function(row) {
        html += '<div style="margin-left:12px;">&#9492; <a href="' + row.TaskUrl + '">' + escapeHtml_(row.TaskName) + '</a></div>';
      });
      var hidden = group.tasks.length - WEEKLY_MAX_TASKS_PER_PROJECT;
      if (hidden > 0) {
        html += '<div style="margin-left:12px;color:#666;">&#9492; (' + hidden + ' more task' + (hidden === 1 ? '' : 's') + ')</div>';
      }
    });
  return html;
}

function buildWeeklyDigestEmailHtml_(pmName, noHoursLeftRows, overdueRows, profitSummary) {
  var html = '<p>Hi ' + pmName + ',</p><p>Here\'s your weekly project status digest:</p>';

  html += buildWeeklyTaskSectionHtml_('&#128308; Open tasks with 0 hours left', noHoursLeftRows);
  html += buildWeeklyTaskSectionHtml_('&#128197; Open tasks with an overdue end date', overdueRows);

  if (profitSummary.length > 0) {
    html += '<h3>&#128200; Expected profitability standing</h3><ul>';
    profitSummary.forEach(function(p) {
      var changeText;
      if (p.change != null) {
        var arrow = p.change > 0 ? '&#9650;' : (p.change < 0 ? '&#9660;' : '&#8212;');
        var color = p.change < -PROFIT_DROP_THRESHOLD ? 'color:#c00;' : (p.change > 0 ? 'color:#080;' : '');
        changeText = ' <span style="' + color + '">' + arrow + ' ' + (p.change > 0 ? '+' : '') + p.change.toFixed(1) + 'pp vs last week</span>';
      } else {
        changeText = ' (no data from last week to compare)';
      }
      html += '<li><a href="' + buildProjectUrl_(p.projectId) + '"><strong>' + escapeHtml_(p.projectName) + '</strong></a>: ' +
        (p.todayPercent != null ? p.todayPercent.toFixed(1) + '%' : 'n/a') + changeText + '</li>';
    });
    html += '</ul>';
  }

  html += '<p style="color:#888;font-size:12px;">Automated weekly digest from the Birdview Daily Digest trial.</p>';
  return html;
}
