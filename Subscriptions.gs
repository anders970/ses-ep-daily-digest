// ==========================================================================
// SUBSCRIPTIONS — opt-in PM roster + the sign-up web page
//
// No digest or alert email goes to a PM until they have subscribed
// themselves. The roster lives in the "PmRoster" tab of the ledger
// spreadsheet (SES PM Name | Email | Subscribed | Last Changed): the admin
// fills in names + emails, PMs flip Subscribed on the sign-up page. The page
// identifies the PM by the Google account they're signed in with, so it
// only works for accounts in the same Workspace as the script owner (i.e.
// after the move to SES's Workspace).
// ==========================================================================


// ====== ROSTER ======

var ROSTER_SHEET_NAME = 'PmRoster';
var ROSTER_HEADER = ['SES PM Name', 'Email', 'Subscribed', 'Last Changed'];
var rosterCache_ = null; // read once per execution

// Creates the PmRoster tab on first use, pre-filled from INITIAL_SUBSCRIBERS
// (Config.gs) so an existing deployment keeps emailing whoever it emailed
// before the roster existed.
function getRosterSheet_() {
  var spreadsheet = getLedgerSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(ROSTER_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(ROSTER_SHEET_NAME);
    sheet.getRange(1, 1, 1, ROSTER_HEADER.length).setValues([ROSTER_HEADER]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    var now = new Date().toISOString();
    var rows = Object.keys(INITIAL_SUBSCRIBERS).map(function(name) { return [name, INITIAL_SUBSCRIBERS[name], true, now]; });
    if (rows.length > 0) sheet.getRange(2, 1, rows.length, ROSTER_HEADER.length).setValues(rows);
    Logger.log('Created ' + ROSTER_SHEET_NAME + ' tab with ' + rows.length + ' initial subscriber(s).');
  }
  return sheet;
}

function isTruthyCell_(value) {
  return value === true || String(value).trim().toUpperCase() === 'TRUE';
}

// { byName: { pmName: entry }, byEmail: { email: entry } } where entry is
// { pmName, email, subscribed, row } (row = 1-based sheet row).
function getPmRoster_() {
  if (rosterCache_) return rosterCache_;
  var data = getRosterSheet_().getDataRange().getValues();
  var roster = { byName: {}, byEmail: {} };
  for (var i = 1; i < data.length; i++) {
    var pmName = String(data[i][0] || '').trim();
    if (!pmName) continue;
    var email = String(data[i][1] || '').trim().toLowerCase();
    var entry = { pmName: pmName, email: email, subscribed: isTruthyCell_(data[i][2]), row: i + 1 };
    roster.byName[pmName] = entry;
    if (email) roster.byEmail[email] = entry;
  }
  rosterCache_ = roster;
  return roster;
}

// The address to send this PM's digests to — ONLY if they've subscribed.
function getPmEmail_(pmName) {
  var entry = getPmRoster_().byName[pmName];
  return entry && entry.subscribed && entry.email ? entry.email : null;
}

// Admin helper: adds a row (blank email, not subscribed) for every "SES PM"
// name in Birdview that isn't in the roster yet. Then fill in the emails.
function populatePmRoster() {
  var roster = getPmRoster_();
  var lookup = getSesPmLookup_();
  var added = [];
  Object.keys(lookup).forEach(function(id) {
    var name = String(lookup[id]).trim();
    if (name && !roster.byName[name]) added.push([name, '', false, '']);
  });
  if (added.length > 0) {
    var sheet = getRosterSheet_();
    sheet.getRange(sheet.getLastRow() + 1, 1, added.length, ROSTER_HEADER.length).setValues(added);
  }
  rosterCache_ = null;
  Logger.log('Added ' + added.length + ' PM(s) to ' + ROSTER_SHEET_NAME + ': ' +
    added.map(function(r) { return r[0]; }).join(', ') + '. Fill in their emails; they subscribe themselves.');
}

// The sign-up page URL, for the link in every email. SUBSCRIBE_PAGE_URL
// Script Property wins (set it to the web app's /exec URL after deploying);
// otherwise ask Apps Script. Returns null if the web app isn't deployed.
function getSubscribePageUrl_() {
  var url = PropertiesService.getScriptProperties().getProperty('SUBSCRIBE_PAGE_URL');
  if (url) return url;
  try {
    return ScriptApp.getService().getUrl() || null;
  } catch (e) {
    return null;
  }
}


// ====== SIGN-UP WEB PAGE ======
//
// Deploy: Deploy → New deployment → Web app, "Execute as: Me" and "Who has
// access: Anyone within <the Workspace domain>" (also set in appsscript.json).
// Running as the owner lets the page update the roster; the visitor's
// identity comes from Session.getActiveUser(), which Google only reveals for
// accounts in the owner's Workspace domain.

function doGet() {
  return HtmlService.createHtmlOutput(buildSubscribePageHtml_())
    .setTitle('Birdview Digest — subscription')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// The visitor's own status. Called by the page; never takes an email from the
// client, so nobody can change someone else's subscription.
function getMySubscription() {
  var email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!email) {
    return { ok: false, message: 'We couldn\'t identify your Google account. Open this page while signed in to your SES Google account.' };
  }
  var entry = getPmRoster_().byEmail[email];
  if (!entry) {
    return { ok: false, message: email + ' isn\'t on the PM list yet. Ask the PMO (' + ADMIN_EMAIL + ') to add you.' };
  }
  return { ok: true, email: email, pmName: entry.pmName, subscribed: entry.subscribed };
}

// Called by the page's Subscribe / Unsubscribe button.
function setMySubscription(subscribe) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    rosterCache_ = null;
    var status = getMySubscription();
    if (!status.ok) return status;
    subscribe = subscribe === true;
    if (status.subscribed !== subscribe) {
      var entry = getPmRoster_().byName[status.pmName];
      getRosterSheet_().getRange(entry.row, 3, 1, 2).setValues([[subscribe, new Date().toISOString()]]);
      rosterCache_ = null;
      if (subscribe) {
        // Start them clean: what's already over threshold counts as notified,
        // so their first urgent email only has genuinely new items.
        seedNotifiedTrackingForPm_(status.pmName);
      }
      notifyAdmin_('[Birdview Digest] ' + status.pmName + (subscribe ? ' subscribed' : ' unsubscribed'),
        status.pmName + ' (' + status.email + ') ' + (subscribe ? 'subscribed to' : 'unsubscribed from') + ' the Birdview digest emails.');
    }
    return getMySubscription();
  } finally {
    lock.releaseLock();
  }
}

function buildSubscribePageHtml_() {
  return '<!DOCTYPE html><html><head><base target="_top"><style>' +
    'body{font-family:Arial,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#222;line-height:1.5}' +
    'h1{font-size:22px}.muted{color:#777;font-size:13px}' +
    'button{font-size:15px;padding:10px 18px;border:0;border-radius:6px;cursor:pointer;background:#1a73e8;color:#fff}' +
    'button.secondary{background:#eee;color:#222}button:disabled{opacity:.5;cursor:default}' +
    '</style></head><body>' +
    '<h1>Birdview Digest emails</h1>' +
    '<p>Daily urgent alerts (tasks over estimate, phases over threshold, profit drops) and a Monday weekly digest of ' +
    'your flagged Birdview tasks.</p>' +
    '<div id="status">Loading&hellip;</div>' +
    '<p class="muted">You can change this at any time from the link at the bottom of every digest email.</p>' +
    '<script>' +
    'function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}' +
    'function render(s){var el=document.getElementById("status");' +
    ' if(!s.ok){el.innerHTML="<p>"+esc(s.message)+"</p>";return;}' +
    ' el.innerHTML="<p>Signed in as <b>"+esc(s.email)+"</b> (SES PM: <b>"+esc(s.pmName)+"</b>).</p>"+' +
    '  (s.subscribed?"<p>&#9989; You are <b>subscribed</b>.</p><button class=secondary onclick=\\"save(false)\\">Unsubscribe</button>"' +
    '              :"<p>You are <b>not subscribed</b> &mdash; you won\'t receive any digest emails.</p><button onclick=\\"save(true)\\">Subscribe</button>");}' +
    'function save(on){var b=document.querySelector("button");if(b)b.disabled=true;' +
    ' google.script.run.withSuccessHandler(render).withFailureHandler(function(e){alert("Something went wrong: "+e.message);if(b)b.disabled=false;}).setMySubscription(on);}' +
    'google.script.run.withSuccessHandler(render).getMySubscription();' +
    '</script></body></html>';
}
