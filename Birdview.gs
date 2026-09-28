// ==========================================================================
// BIRDVIEW — OAuth, API access, lookups and task helpers
// ==========================================================================


// ====== OAUTH ======

function getBirdviewService() {
  var props = PropertiesService.getScriptProperties();
  return OAuth2.createService('Birdview')
    .setAuthorizationBaseUrl(BIRDVIEW_BASE + '/OAuth2/Authorize')
    .setTokenUrl(BIRDVIEW_BASE + '/OAuth2/Token')
    .setClientId(props.getProperty('BIRDVIEW_CLIENT_ID'))
    .setClientSecret(props.getProperty('BIRDVIEW_CLIENT_SECRET'))
    .setCallbackFunction('authCallback')
    .setPropertyStore(props);
}

function authorize() {
  var service = getBirdviewService();
  if (service.hasAccess()) {
    Logger.log('Already authorized — no action needed.');
  } else {
    Logger.log('Open this URL in your browser to approve access: ' + service.getAuthorizationUrl());
  }
}

function authCallback(request) {
  var isApproved = getBirdviewService().handleCallback(request);
  return HtmlService.createHtmlOutput(isApproved ? 'Success! You can close this tab and go back to Apps Script.' : 'Access denied. Something went wrong — let\'s troubleshoot.');
}

function resetBirdviewAuth() {
  getBirdviewService().reset();
  Logger.log('Reset complete. Now run authorize() again.');
}


// ====== REQUEST HELPERS ======

function birdviewGet_(path, params) {
  var service = getBirdviewService();
  var queryParts = [];
  Object.keys(params || {}).forEach(function(key) {
    var value = params[key];
    if (Array.isArray(value)) {
      value.forEach(function(v) { queryParts.push(encodeURIComponent(key) + '=' + encodeURIComponent(v)); });
    } else {
      queryParts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    }
  });
  var url = BIRDVIEW_BASE + path + (queryParts.length ? '?' + queryParts.join('&') : '');

  var response = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + service.getAccessToken() },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Birdview request failed (' + response.getResponseCode() + '): ' + url + ' — ' + response.getContentText());
  }
  return JSON.parse(response.getContentText());
}

// Loops through pages automatically so we always get the FULL result set.
function birdviewGetAllPages_(path, params) {
  var allItems = [];
  var take = 200;
  var skip = 0;
  while (true) {
    var pageParams = Object.assign({}, params, { Skip: skip, Take: take });
    var page = birdviewGet_(path, pageParams);
    var items = page.Items || [];
    allItems = allItems.concat(items);
    if (items.length < take) break;
    skip += take;
  }
  return allItems;
}

// Splits an array into chunks — Birdview's query engine caps list-filter size
// (empirically confirmed safe at 15; fails somewhere between 15 and 18).
function chunkArray_(array, size) {
  var chunks = [];
  for (var i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}


// ====== LOOKUPS ======

function getOpenFlatFeeProjects_() {
  var allProjects = birdviewGetAllPages_('/api/v2/projects', { StatusIds: PROJECT_STATUS_OPEN });
  return allProjects.filter(function(p) { return p.BillingType === BILLING_TYPE_FIXED_FEE; });
}

function getSesPmLookup_() {
  var result = birdviewGet_('/api/v2/customfields', { Entities: 'Project' });
  var pmField = result.Items.find(function(f) { return f.FieldName === CUSTOM_FIELD_SES_PM; });
  var lookup = {};
  (pmField.Values || []).forEach(function(v) { lookup[v.FieldValueId] = v.Value; });
  return lookup;
}

function getAllUserRates_() {
  var users = birdviewGetAllPages_('/api/v2/users', { IsEnabled: true });
  var rateMap = {};
  users.forEach(function(u) { rateMap[u.UserId] = u.HourlyRateInternal || 0; });
  return rateMap;
}


// ====== TASKS, HOURS, ASSIGNEES ======

function getAllTasksForProject_(projectId) {
  return birdviewGetAllPages_('/api/v2/tasks', { ProjectIds: projectId });
}

function getOpenLeafTasksFromAll_(allTasks) {
  return allTasks.filter(function(task) {
    var isNotCompleted = COMPLETED_TASK_STATUS_IDS.indexOf(task.TaskStatusId) === -1;
    var isLeafTask = !task.HasChild;
    return isNotCompleted && isLeafTask;
  });
}

// Convenience wrapper for one-off/manual checks (used by verifyExpectedProfitPercent).
function getOpenTasksForProject_(projectId) {
  return getOpenLeafTasksFromAll_(getAllTasksForProject_(projectId));
}

function buildTaskLookup_(allTasks) {
  var map = {};
  allTasks.forEach(function(t) { map[t.TaskId] = { name: t.Name, parentId: t.ParentId }; });
  return map;
}

// Returns just the chain of PARENT names, top-down — not including the task itself.
function buildParentBreadcrumb_(taskId, taskLookup) {
  var parts = [];
  var current = taskLookup[taskId];
  var parentId = current ? current.parentId : null;
  while (parentId) {
    var parent = taskLookup[parentId];
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return parts.join(' / ');
}

// One call per project — groups all logged hours by task.
function getActualHoursByTaskForProject_(projectId) {
  var logs = birdviewGetAllPages_('/api/v2/timelogs', { ProjectIds: projectId });
  var map = {};
  logs.forEach(function(log) { map[log.TaskId] = (map[log.TaskId] || 0) + (log.Duration || 0); });
  return map;
}

function getAssigneesForTasks_(taskIds) {
  var allAssignees = [];
  chunkArray_(taskIds, 15).forEach(function(chunk) {
    allAssignees = allAssignees.concat(birdviewGetAllPages_('/api/v2/tasks/assignees', { TaskIds: chunk }));
  });
  return allAssignees;
}


// ====== URLS ======

function buildTaskUrl_(taskId) { return TASK_URL_BASE + taskId; }

function buildProjectUrl_(projectId) { return PROJECT_URL_BASE + projectId; }
