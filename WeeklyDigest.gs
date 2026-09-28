// ==========================================================================
// WEEKLY DIGEST (Mondays) — Gemini-assisted summary of all flagged tasks
// ==========================================================================


// ====== ORCHESTRATION ======

function sendWeeklyDigestFromSnapshot_() {
  var todayRows = requireTodaysSnapshot_(TASK_SNAPSHOT_PREFIX, 'runWeeklyDigest');
  if (!todayRows) return;

  var weekAgoRows = getSnapshotFromApproxDaysAgo_(7, 2) || [];
  var flaggedToday = todayRows.filter(function(r) { return r.Flags && r.Flags.length > 0; });

  var pmNames = {};
  todayRows.forEach(function(row) { pmNames[row.SES_PM] = true; });

  Object.keys(pmNames).forEach(function(pmName) {
    if (!getPmEmail_(pmName)) {
      Logger.log('No email mapped for PM "' + pmName + '" — skipping (no Gemini call).');
      return;
    }
    var pmFlaggedRows = flaggedToday.filter(function(r) { return r.SES_PM === pmName; });
    var groups = buildWeeklyTaskGroups_(pmFlaggedRows);
    var profitSummary = buildWeeklyProfitabilitySummary_(pmName, todayRows, weekAgoRows);

    if (groups.individualTasks.length === 0 && groups.summarizedProjects.length === 0 && profitSummary.length === 0) return;

    var explanations = callGeminiForWeeklyTasks_(pmName, groups.individualTasks);
    var explanationMap = {};
    explanations.forEach(function(e) { explanationMap[e.taskId] = e.explanation; });

    var emailBody = buildWeeklyDigestEmailHtml_(pmName, groups.individualTasks, explanationMap, groups.summarizedProjects, profitSummary);
    sendDigestEmail_(pmName, 'Weekly Project Digest - Week of ' + formatDateForFilename_(new Date()), emailBody);
  });
}


// ====== CONTENT ======

function buildWeeklyTaskGroups_(flaggedRowsForPm) {
  var byProject = groupRowsByProject_(flaggedRowsForPm);
  var individualTasks = [];
  var summarizedProjects = [];

  Object.keys(byProject).forEach(function(projectId) {
    var group = byProject[projectId];
    if (group.tasks.length > 2) {
      summarizedProjects.push({
        projectId: Number(projectId),
        projectName: group.projectName,
        count: group.tasks.length,
        exampleTaskName: group.tasks[0].TaskName
      });
    } else {
      group.tasks.forEach(function(row) { individualTasks.push(row); });
    }
  });

  return { individualTasks: individualTasks, summarizedProjects: summarizedProjects };
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

function callGeminiForWeeklyTasks_(pmName, individualTaskRows) {
  if (individualTaskRows.length === 0) return [];

  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=' + apiKey;

  var itemsForPrompt = individualTaskRows.map(function(row) {
    return { taskId: row.TaskId, projectName: row.ProjectName, taskName: row.TaskName, parentBreadcrumb: row.ParentBreadcrumb, endDate: row.EndDate, hoursLeft: row.HoursLeft, totalHours: row.TotalHours, estimatedHours: row.EstimatedHours, actualHours: row.ActualHours, flags: row.Flags };
  });

  var responseSchema = {
    type: 'ARRAY',
    items: { type: 'OBJECT', properties: { taskId: { type: 'INTEGER' }, explanation: { type: 'STRING' } }, required: ['taskId', 'explanation'] }
  };

  var promptText = 'You are helping write a weekly project status digest for a project manager named ' + pmName + '. ' +
    'Below is a JSON array of tasks currently flagged for attention. Flags mean: RED_NO_HOURS_LEFT (zero hours left), YELLOW_LOW_HOURS (under 20% of hours remain), ' +
    'PAST_DUE (end date has passed), DUE_SOON (end date within 5 days), OVER_ESTIMATE (actual hours logged have exceeded the originally estimated hours). ' +
    'A task can have more than one flag. For each task, write ONE short, factual, plain-English sentence explaining why it matters, using the specific numbers given. ' +
    'Do not invent information not present in the data. Return exactly one entry per task, in the same order as the input.\n\n' +
    JSON.stringify(itemsForPrompt);

  var payload = { contents: [{ parts: [{ text: promptText }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: responseSchema } };
  var response = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    throw new Error('Gemini request failed (' + response.getResponseCode() + '): ' + response.getContentText());
  }
  return JSON.parse(JSON.parse(response.getContentText()).candidates[0].content.parts[0].text);
}

function buildWeeklyDigestEmailHtml_(pmName, individualTasks, taskExplanationMap, summarizedProjects, profitSummary) {
  var html = '<p>Hi ' + pmName + ',</p><p>Here\'s your weekly project status digest:</p>';

  if (individualTasks.length > 0 || summarizedProjects.length > 0) {
    html += '<h3>&#128203; Tasks needing attention</h3><ul>';
    individualTasks.forEach(function(row) {
      var explanation = taskExplanationMap[row.TaskId] || (row.TaskName + ' is flagged: ' + row.Flags);
      html += '<li><a href="' + row.TaskUrl + '"><strong>' + row.ProjectName + '</strong> — ' + row.ParentBreadcrumb + ' / ' + row.TaskName + '</a><br>' + explanation + '</li>';
    });
    summarizedProjects.forEach(function(proj) {
      html += '<li><a href="' + buildProjectUrl_(proj.projectId) + '"><strong>' + proj.projectName + '</strong></a> has ' + proj.count +
        ' flagged tasks needing attention, including "' + proj.exampleTaskName + '".</li>';
    });
    html += '</ul>';
  } else {
    html += '<p>No flagged tasks this week.</p>';
  }

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
      html += '<li><a href="' + buildProjectUrl_(p.projectId) + '"><strong>' + p.projectName + '</strong></a>: ' +
        (p.todayPercent != null ? p.todayPercent.toFixed(1) + '%' : 'n/a') + changeText + '</li>';
    });
    html += '</ul>';
  }

  html += '<p style="color:#888;font-size:12px;">Automated weekly digest from the Birdview Daily Digest trial.</p>';
  return html;
}
