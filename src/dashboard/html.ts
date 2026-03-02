/**
 * Self-contained HTML dashboard with inline CSS/JS.
 * No external dependencies — charts are CSS-based, data fetched via fetch().
 *
 * Security note: All dynamic data is inserted via textContent or safe DOM methods.
 * The only innerHTML usage is for trusted static template strings built from
 * local database data — not user-supplied or external content. The renderMd()
 * function escapes ALL HTML entities before applying markdown transforms.
 */
export function getDashboardHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Open Accountant Dashboard</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#0f1117; color:#e1e4e8; }
  .header { padding:16px 24px; background:#161b22; border-bottom:1px solid #30363d; display:flex; justify-content:space-between; align-items:center; }
  .header h1 { font-size:18px; font-weight:600; }
  .header-controls { display:flex; gap:12px; align-items:center; }
  .header select { background:#21262d; color:#e1e4e8; border:1px solid #30363d; padding:6px 10px; border-radius:6px; }

  /* Tabs */
  .tab-bar { display:flex; gap:0; background:#161b22; border-bottom:1px solid #30363d; padding:0 24px; }
  .tab-btn { padding:10px 20px; background:none; border:none; color:#8b949e; cursor:pointer; font-size:14px; font-weight:500; border-bottom:2px solid transparent; transition:all 0.15s; }
  .tab-btn:hover { color:#e1e4e8; }
  .tab-btn.active { color:#e1e4e8; border-bottom-color:#22c55e; }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; }

  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; padding:16px 24px; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:16px; }
  .card h3 { font-size:13px; color:#8b949e; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:12px; }
  .full-width { grid-column: 1 / -1; }
  .pnl-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }
  .pnl-item { text-align:center; }
  .pnl-item .label { font-size:12px; color:#8b949e; }
  .pnl-item .value { font-size:24px; font-weight:700; margin-top:4px; }
  .income { color:#3fb950; }
  .expense { color:#f85149; }
  .budget-bar { margin-bottom:10px; }
  .budget-bar .bar-label { display:flex; justify-content:space-between; font-size:13px; margin-bottom:4px; }
  .budget-bar .bar-track { height:8px; background:#21262d; border-radius:4px; overflow:hidden; }
  .budget-bar .bar-fill { height:100%; border-radius:4px; transition:width 0.3s; }
  .bar-ok { background:#3fb950; }
  .bar-warn { background:#d29922; }
  .bar-over { background:#f85149; }
  .savings-row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #21262d; font-size:13px; }
  .savings-row:last-child { border-bottom:none; }
  .alert-item { padding:8px 12px; margin-bottom:8px; border-radius:6px; font-size:13px; }
  .alert-critical { background:rgba(248,81,73,0.15); border-left:3px solid #f85149; }
  .alert-warning { background:rgba(210,153,34,0.15); border-left:3px solid #d29922; }
  .alert-info { background:rgba(88,166,255,0.15); border-left:3px solid #58a6ff; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; padding:8px; color:#8b949e; border-bottom:1px solid #30363d; }
  td { padding:8px; border-bottom:1px solid #21262d; }
  .amt-pos { color:#3fb950; }
  .amt-neg { color:#f85149; }

  .txn-actions { display:flex; gap:4px; }
  .btn-sm { padding:4px 8px; border:1px solid #30363d; border-radius:4px; background:#21262d; color:#e1e4e8; cursor:pointer; font-size:11px; }
  .btn-sm:hover { background:#30363d; }
  .btn-danger { color:#f85149; border-color:#f8514966; }
  .btn-danger:hover { background:#f8514933; }
  .btn-save { color:#3fb950; border-color:#3fb95066; }
  .btn-save:hover { background:#3fb95033; }
  td input, td select { background:#21262d; color:#e1e4e8; border:1px solid #30363d; padding:4px 6px; border-radius:4px; font-size:12px; width:100%; }

  .chat-layout { display:flex; height:calc(100vh - 120px); }
  .chat-sidebar { width:260px; border-right:1px solid #30363d; overflow-y:auto; padding:12px; flex-shrink:0; }
  .chat-sidebar h4 { font-size:12px; color:#8b949e; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; }
  .session-item { padding:8px 10px; border-radius:6px; cursor:pointer; margin-bottom:4px; font-size:13px; }
  .session-item:hover { background:#21262d; }
  .session-item.active { background:#21262d; border-left:2px solid #22c55e; }
  .session-title { color:#e1e4e8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .session-date { font-size:11px; color:#8b949e; margin-top:2px; }
  .chat-main { flex:1; display:flex; flex-direction:column; padding:16px 24px; min-width:0; }
  .chat-messages { flex:1; overflow-y:auto; padding:12px; background:#161b22; border:1px solid #30363d; border-radius:6px; margin-bottom:12px; min-height:100px; }
  .chat-msg { margin-bottom:12px; max-width:80%; }
  .chat-msg.msg-user { margin-left:auto; text-align:right; }
  .chat-msg.msg-user .bubble { background:#1a3a2a; border:1px solid #22c55e44; border-radius:12px 12px 4px 12px; padding:8px 12px; text-align:right; }
  .chat-msg.msg-assistant .bubble { background:#21262d; border:1px solid #30363d; border-radius:12px 12px 12px 4px; padding:8px 12px; }
  .chat-msg .sender { font-size:11px; color:#8b949e; margin-bottom:2px; }
  .chat-msg .text { font-size:14px; line-height:1.6; }
  .chat-msg .text p { margin:0 0 8px 0; }
  .chat-msg .text p:last-child { margin-bottom:0; }
  .chat-msg .text h1,.chat-msg .text h2,.chat-msg .text h3 { margin:12px 0 6px 0; font-size:15px; font-weight:600; color:#e1e4e8; }
  .chat-msg .text ul,.chat-msg .text ol { margin:4px 0; padding-left:20px; }
  .chat-msg .text li { margin-bottom:2px; }
  .chat-msg .text code { background:#21262d; padding:2px 5px; border-radius:3px; font-size:12px; font-family:monospace; }
  .chat-msg .text pre { background:#161b22; border:1px solid #30363d; border-radius:6px; padding:10px; margin:8px 0; overflow-x:auto; }
  .chat-msg .text pre code { background:none; padding:0; font-size:12px; }
  .chat-msg .text strong { font-weight:600; color:#e1e4e8; }
  .chat-msg .text em { font-style:italic; }
  .chat-msg .text a { color:#58a6ff; text-decoration:none; }
  .chat-msg .text a:hover { text-decoration:underline; }
  .chat-msg .text table { border-collapse:collapse; margin:8px 0; font-size:13px; }
  .chat-msg .text table th,.chat-msg .text table td { border:1px solid #30363d; padding:4px 8px; }
  .chat-msg .text table th { background:#21262d; }
  .chat-input-row { display:flex; gap:8px; }
  .chat-input-row input { flex:1; background:#21262d; color:#e1e4e8; border:1px solid #30363d; padding:10px 14px; border-radius:6px; font-size:14px; }
  .chat-input-row input:focus { outline:none; border-color:#58a6ff; }
  .chat-input-row button { background:#238636; color:#fff; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600; }
  .chat-input-row button:hover { background:#2ea043; }
  .chat-input-row button:disabled { opacity:0.5; cursor:not-allowed; }

  .log-panel { padding:16px 24px; }
  .log-entry { padding:3px 0; border-bottom:1px solid #21262d; display:flex; gap:8px; font-family:monospace; font-size:12px; }
  .log-entry:last-child { border-bottom:none; }
  .log-ts { color:#8b949e; flex-shrink:0; }
  .log-level { font-weight:600; flex-shrink:0; width:44px; text-transform:uppercase; }
  .log-level-debug { color:#8b949e; }
  .log-level-info { color:#58a6ff; }
  .log-level-warn { color:#d29922; }
  .log-level-error { color:#f85149; }
  .log-msg { flex:1; }
  .log-container { max-height:500px; overflow-y:auto; background:#161b22; border:1px solid #30363d; border-radius:6px; padding:12px; }

  .traces-panel { padding:16px 24px; }
  .trace-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px; }
  .trace-stat { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:12px; text-align:center; }
  .trace-stat .stat-value { font-size:22px; font-weight:700; color:#e1e4e8; }
  .trace-stat .stat-label { font-size:11px; color:#8b949e; margin-top:4px; text-transform:uppercase; letter-spacing:0.5px; }
  .trace-table { width:100%; border-collapse:collapse; font-size:12px; font-family:monospace; }
  .trace-table th { text-align:left; padding:8px; color:#8b949e; border-bottom:1px solid #30363d; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; }
  .trace-table td { padding:6px 8px; border-bottom:1px solid #21262d; }
  .trace-status-ok { color:#3fb950; }
  .trace-status-error { color:#f85149; }
  .trace-model { color:#bc8cff; }
  .trace-provider { color:#8b949e; }
  .trace-duration { color:#d29922; }
  .trace-tokens { color:#58a6ff; }
  .trace-container { max-height:500px; overflow-y:auto; background:#161b22; border:1px solid #30363d; border-radius:6px; padding:0; }

  .spending-layout { display:flex; gap:24px; align-items:center; }
  .donut-chart { flex-shrink:0; width:160px; height:160px; }
  .spending-legend { flex:1; }
  .legend-item { display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:13px; }
  .legend-swatch { width:12px; height:12px; border-radius:2px; flex-shrink:0; }

  .auth-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; z-index:1000; }
  .auth-box { background:#161b22; border:1px solid #30363d; border-radius:12px; padding:32px; width:360px; }
  .auth-box h2 { font-size:20px; margin-bottom:16px; color:#e1e4e8; }
  .auth-box p { color:#8b949e; font-size:13px; margin-bottom:16px; }
  .auth-box label { display:block; font-size:13px; color:#8b949e; margin-bottom:4px; margin-top:12px; }
  .auth-box input { width:100%; background:#21262d; color:#e1e4e8; border:1px solid #30363d; padding:8px 12px; border-radius:6px; font-size:14px; }
  .auth-box input:focus { outline:none; border-color:#58a6ff; }
  .auth-box button { width:100%; margin-top:16px; background:#238636; color:#fff; border:none; padding:10px; border-radius:6px; cursor:pointer; font-weight:600; font-size:14px; }
  .auth-box button:hover { background:#2ea043; }
  .auth-error { color:#f85149; font-size:12px; margin-top:8px; }

  .nw-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:16px; }
  .nw-stat { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:16px; text-align:center; }
  .nw-stat .nw-value { font-size:24px; font-weight:700; }
  .nw-stat .nw-label { font-size:11px; color:#8b949e; margin-top:4px; text-transform:uppercase; letter-spacing:0.5px; }
  .nw-trend-bar { display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:12px; }
  .nw-trend-bar .nw-bar-track { flex:1; height:12px; background:#21262d; border-radius:4px; overflow:hidden; }
  .nw-trend-bar .nw-bar-fill { height:100%; border-radius:4px; }
  .acct-row { cursor:pointer; }
  .acct-row:hover { background:#21262d; }

  .loading { color:#8b949e; font-style:italic; }
  .empty { color:#8b949e; }
  .hidden { display:none !important; }
</style>
</head>
<body>

<div class="auth-overlay hidden" id="authOverlay">
  <div class="auth-box" id="authBox"></div>
</div>

<div id="appRoot">
<div class="header">
  <h1>Open Accountant Dashboard</h1>
  <div class="header-controls">
    <select id="profilePicker" class="hidden" title="Switch profile"></select>
    <select id="accountFilter" title="Filter by account">
      <option value="">All Accounts</option>
    </select>
    <select id="monthPicker"></select>
    <button id="authSettingsBtn" class="btn-sm hidden" title="Auth Settings">Settings</button>
    <span id="userBadge" class="hidden" style="font-size:12px;color:#8b949e;"></span>
    <button id="logoutBtn" class="btn-sm hidden">Logout</button>
  </div>
</div>

<div class="tab-bar" id="tabBar">
  <button class="tab-btn active" data-tab="overview">Overview</button>
  <button class="tab-btn" data-tab="transactions">Transactions</button>
  <button class="tab-btn" data-tab="accounts">Accounts</button>
  <button class="tab-btn" data-tab="chat">Chat</button>
  <button class="tab-btn" data-tab="traces">Traces</button>
  <button class="tab-btn" data-tab="logs">Logs</button>
</div>

<div class="tab-panel active" id="tab-overview">
  <div class="grid">
    <div class="card"><h3>Profit &amp; Loss</h3><div class="pnl-grid" id="pnlContent"><p class="loading">Loading...</p></div></div>
    <div class="card"><h3>Budgets</h3><div id="budgetContent"><p class="loading">Loading...</p></div></div>
    <div class="card"><h3>Spending by Category</h3><div id="spendingContent"><p class="loading">Loading...</p></div></div>
    <div class="card"><h3>Savings Rate Trend</h3><div id="savingsContent"><p class="loading">Loading...</p></div></div>
    <div class="card full-width"><h3>Alerts</h3><div id="alertContent"><p class="loading">Loading...</p></div></div>
  </div>
</div>

<div class="tab-panel" id="tab-transactions">
  <div style="padding:16px 24px;">
    <div class="card full-width">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">Transactions</h3>
        <div style="display:flex;gap:8px;">
          <select id="exportFormat" class="btn-sm" style="padding:4px 8px;"><option value="csv">CSV</option><option value="xlsx">XLSX</option></select>
          <button id="exportBtn" class="btn-sm" style="padding:4px 12px;">Export</button>
        </div>
      </div>
      <div id="txnContent"><p class="loading">Loading...</p></div>
    </div>
  </div>
</div>

<div class="tab-panel" id="tab-accounts">
  <div style="padding:16px 24px;">
    <div class="nw-stats" id="nwStats"><p class="loading">Loading...</p></div>
    <div class="card full-width" style="margin-bottom:16px;"><h3>Accounts</h3><div id="accountsTable"><p class="loading">Loading...</p></div></div>
    <div class="card full-width"><h3>Net Worth Trend</h3><div id="nwTrend"><p class="loading">Loading...</p></div></div>
  </div>
</div>

<div class="tab-panel" id="tab-chat">
  <div class="chat-layout">
    <div class="chat-sidebar">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <h4 style="margin:0;">Sessions</h4>
        <button id="newChatBtn" class="btn-sm" style="padding:4px 10px;font-size:11px;">+ New Chat</button>
      </div>
      <div id="sessionList"><p class="loading">Loading...</p></div>
    </div>
    <div class="chat-main">
      <div class="chat-messages" id="chatMessages"></div>
      <div class="chat-input-row">
        <input type="text" id="chatInput" placeholder="Ask Open Accountant anything..." />
        <button id="chatSend">Send</button>
      </div>
    </div>
  </div>
</div>

<div class="tab-panel" id="tab-traces">
  <div class="traces-panel">
    <div class="trace-stats" id="traceStats"></div>
    <div class="trace-container">
      <table class="trace-table">
        <thead><tr><th>Time</th><th>Model</th><th>Provider</th><th>Duration</th><th>In Tokens</th><th>Out Tokens</th><th>Prompt</th><th>Response</th><th>Status</th></tr></thead>
        <tbody id="traceTableBody"><tr><td colspan="9" class="loading">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<div class="tab-panel" id="tab-logs">
  <div class="log-panel"><div class="log-container" id="logContent"><p class="loading">Loading...</p></div></div>
</div>
</div>

<script>
(function() {
  'use strict';
  var BASE = 'http://localhost:${port}';
  var currentMonth = new Date().toISOString().slice(0,7);
  var currentAccountId = '';
  var authToken = localStorage.getItem('oa_token') || '';
  var currentUser = null;

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function fmt(n) {
    var abs = Math.abs(n).toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
    return n >= 0 ? '$' + abs : '-$' + abs;
  }
  function acctParam() { return currentAccountId ? '&accountId=' + currentAccountId : ''; }

  function authFetch(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (authToken) opts.headers['Authorization'] = 'Bearer ' + authToken;
    return fetch(url, opts);
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  var authOverlay = document.getElementById('authOverlay');
  var authBox = document.getElementById('authBox');

  function showLoginForm() {
    authOverlay.classList.remove('hidden');
    authBox.replaceChildren();
    authBox.appendChild(el('h2', null, 'Login'));
    var form = el('div');
    form.appendChild(el('label', null, 'Username'));
    var userIn = document.createElement('input'); userIn.type = 'text';
    form.appendChild(userIn);
    form.appendChild(el('label', null, 'Password'));
    var passIn = document.createElement('input'); passIn.type = 'password';
    form.appendChild(passIn);
    var btn = el('button', null, 'Login');
    var errDiv = el('div', 'auth-error');
    btn.addEventListener('click', async function() {
      errDiv.textContent = '';
      try {
        var res = await fetch(BASE+'/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:userIn.value,password:passIn.value}) });
        var data = await res.json();
        if (!res.ok) { errDiv.textContent = data.error||'Login failed'; return; }
        authToken = data.token; currentUser = data.user;
        localStorage.setItem('oa_token', authToken);
        authOverlay.classList.add('hidden'); onAuthReady();
      } catch(e) { errDiv.textContent = e.message; }
    });
    passIn.addEventListener('keydown', function(e) { if (e.key==='Enter') btn.click(); });
    form.appendChild(btn); form.appendChild(errDiv); authBox.appendChild(form);
  }

  function showSetupForm() {
    authOverlay.classList.remove('hidden');
    authBox.replaceChildren();
    authBox.appendChild(el('h2', null, 'Create Admin Account'));
    authBox.appendChild(el('p', null, 'Set up your first admin account to secure the dashboard.'));
    var form = el('div');
    form.appendChild(el('label', null, 'Username'));
    var userIn = document.createElement('input'); userIn.type = 'text';
    form.appendChild(userIn);
    form.appendChild(el('label', null, 'Password'));
    var passIn = document.createElement('input'); passIn.type = 'password';
    form.appendChild(passIn);
    var btn = el('button', null, 'Create Admin & Enable Auth');
    var errDiv = el('div', 'auth-error');
    btn.addEventListener('click', async function() {
      errDiv.textContent = '';
      try {
        var res = await fetch(BASE+'/api/auth/setup', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:userIn.value,password:passIn.value}) });
        var data = await res.json();
        if (!res.ok) { errDiv.textContent = data.error||'Setup failed'; return; }
        authToken = data.token; currentUser = data.user;
        localStorage.setItem('oa_token', authToken);
        authOverlay.classList.add('hidden'); onAuthReady();
      } catch(e) { errDiv.textContent = e.message; }
    });
    form.appendChild(btn);
    var skipBtn = el('button', null, 'Skip (No Auth)');
    skipBtn.style.background = '#21262d'; skipBtn.style.marginTop = '8px';
    skipBtn.addEventListener('click', function() { authOverlay.classList.add('hidden'); onAuthReady(); });
    form.appendChild(skipBtn); form.appendChild(errDiv); authBox.appendChild(form);
  }

  async function checkAuth() {
    try {
      var res = await authFetch(BASE+'/api/auth/status');
      var data = await res.json();
      if (data.authEnabled) {
        if (data.user) { currentUser = data.user; onAuthReady(); }
        else if (data.userCount === 0) showSetupForm();
        else showLoginForm();
      } else { currentUser = null; onAuthReady(); }
    } catch(e) { onAuthReady(); }
  }

  function onAuthReady() {
    var badge = document.getElementById('userBadge');
    var logoutBtn = document.getElementById('logoutBtn');
    var settingsBtn = document.getElementById('authSettingsBtn');
    if (currentUser) {
      badge.textContent = currentUser.username + ' (' + currentUser.role + ')';
      badge.classList.remove('hidden'); logoutBtn.classList.remove('hidden');
      if (currentUser.role === 'admin') settingsBtn.classList.remove('hidden');
    }
    loadProfiles(); loadAccountOptions(); initRouter();
  }

  document.getElementById('logoutBtn').addEventListener('click', async function() {
    await authFetch(BASE+'/api/auth/logout', {method:'POST'});
    authToken = ''; currentUser = null; localStorage.removeItem('oa_token'); location.reload();
  });

  // ── Profiles ────────────────────────────────────────────────────────────
  var profilePicker = document.getElementById('profilePicker');
  async function loadProfiles() {
    try {
      var data = await (await authFetch(BASE+'/api/profiles')).json();
      if (data.profiles && data.profiles.length > 1) {
        profilePicker.classList.remove('hidden');
        profilePicker.replaceChildren();
        data.profiles.forEach(function(p) {
          var opt = document.createElement('option'); opt.value = p; opt.textContent = p;
          if (p === data.active) opt.selected = true;
          profilePicker.appendChild(opt);
        });
      }
    } catch(e) {}
  }
  profilePicker.addEventListener('change', async function() {
    await authFetch(BASE+'/api/profiles/switch', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:profilePicker.value}) });
    loadAll();
  });

  // ── Account filter ──────────────────────────────────────────────────────
  var accountFilter = document.getElementById('accountFilter');
  async function loadAccountOptions() {
    try {
      var data = await (await authFetch(BASE+'/api/accounts')).json();
      while (accountFilter.options.length > 1) accountFilter.remove(1);
      if (data && data.length) data.forEach(function(a) {
        var opt = document.createElement('option'); opt.value = a.id;
        opt.textContent = a.name + (a.institution ? ' (' + a.institution + ')' : '');
        accountFilter.appendChild(opt);
      });
    } catch(e) {}
  }
  accountFilter.addEventListener('change', function() {
    currentAccountId = accountFilter.value; loadOverview(); loadTransactions();
  });

  // ── Hash routing ────────────────────────────────────────────────────────
  var TABS = ['overview','transactions','accounts','chat','traces','logs'];
  var tabBtns = document.querySelectorAll('.tab-btn');

  function activateTab(tabName) {
    var params = {};
    if (tabName.indexOf('?') !== -1) {
      var parts = tabName.split('?'); tabName = parts[0];
      parts[1].split('&').forEach(function(kv) { var p = kv.split('='); params[p[0]] = p[1]; });
    }
    if (TABS.indexOf(tabName) === -1) tabName = 'overview';
    tabBtns.forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
    tabBtns.forEach(function(b) { if (b.dataset.tab === tabName) b.classList.add('active'); });
    var panel = document.getElementById('tab-' + tabName);
    if (panel) panel.classList.add('active');
    if (params.accountId) { currentAccountId = params.accountId; accountFilter.value = params.accountId; }
    if (tabName === 'overview') loadOverview();
    if (tabName === 'transactions') loadTransactions();
    if (tabName === 'accounts') loadAccountsTab();
    if (tabName === 'traces') loadTraces();
    if (tabName === 'logs') loadLogs();
  }
  function navigateTo(tab) { location.hash = '#/' + tab; }
  function initRouter() {
    tabBtns.forEach(function(btn) { btn.addEventListener('click', function() { navigateTo(btn.dataset.tab); }); });
    window.addEventListener('hashchange', function() { activateTab(location.hash.replace('#/','') || 'overview'); });
    activateTab(location.hash.replace('#/','') || 'overview');
  }

  // ── Month picker ────────────────────────────────────────────────────────
  var picker = document.getElementById('monthPicker');
  for (var i = 0; i < 12; i++) {
    var d = new Date(); d.setMonth(d.getMonth() - i);
    var opt = document.createElement('option'); opt.value = d.toISOString().slice(0,7);
    opt.textContent = d.toLocaleString('en-US', {month:'long',year:'numeric'});
    picker.appendChild(opt);
  }
  picker.addEventListener('change', function() { currentMonth = picker.value; loadOverview(); });

  // ── Overview ────────────────────────────────────────────────────────────
  async function loadPnl() {
    var data = await (await authFetch(BASE+'/api/pnl?month='+currentMonth+acctParam())).json();
    var c = document.getElementById('pnlContent'); c.replaceChildren();
    [{label:'Income',value:data.totalIncome,cls:'income'},{label:'Expenses',value:data.totalExpenses,cls:'expense'},{label:'Net',value:data.netProfitLoss,cls:data.netProfitLoss>=0?'income':'expense'}].forEach(function(it) {
      var div = el('div','pnl-item'); div.appendChild(el('div','label',it.label)); div.appendChild(el('div','value '+it.cls,fmt(it.value))); c.appendChild(div);
    });
  }
  async function loadBudgets() {
    var data = await (await authFetch(BASE+'/api/budgets?month='+currentMonth+acctParam())).json();
    var c = document.getElementById('budgetContent'); c.replaceChildren();
    if (!data.length) { c.appendChild(el('p','empty','No budgets set.')); return; }
    data.forEach(function(b) {
      var bar = el('div','budget-bar'), lr = el('div','bar-label');
      lr.appendChild(el('span',null,b.category)); lr.appendChild(el('span',null,b.percent_used+'%'+(b.over?' OVER':''))); bar.appendChild(lr);
      var track = el('div','bar-track'), cls = b.over?'bar-over':b.percent_used>=80?'bar-warn':'bar-ok';
      var fill = el('div','bar-fill '+cls); fill.style.width = Math.min(b.percent_used,100)+'%'; track.appendChild(fill); bar.appendChild(track); c.appendChild(bar);
    });
  }
  var COLORS = ['#3fb950','#58a6ff','#d29922','#f85149','#bc8cff','#79c0ff','#f0883e','#56d364','#db61a2','#8b949e'];
  async function loadSpending() {
    var data = await (await authFetch(BASE+'/api/summary?month='+currentMonth+acctParam())).json();
    var c = document.getElementById('spendingContent'); c.replaceChildren();
    if (!data.length) { c.appendChild(el('p','empty','No spending data.')); return; }
    var total = data.reduce(function(s,r){return s+Math.abs(r.total);},0);
    var layout = el('div','spending-layout');
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS,'svg'); svg.setAttribute('viewBox','0 0 200 200'); svg.setAttribute('class','donut-chart');
    var R=70, CX=100, CY=100, CIRC=2*Math.PI*R, cum=0;
    data.forEach(function(r,i) {
      var pct = total>0?Math.abs(r.total)/total:0; if(pct<=0) return;
      var circ = document.createElementNS(NS,'circle'); circ.setAttribute('cx',CX); circ.setAttribute('cy',CY); circ.setAttribute('r',R);
      circ.setAttribute('fill','none'); circ.setAttribute('stroke',COLORS[i%COLORS.length]); circ.setAttribute('stroke-width','30');
      circ.setAttribute('stroke-dasharray',CIRC); circ.setAttribute('stroke-dashoffset',CIRC*(1-pct));
      circ.setAttribute('transform','rotate('+(cum*360-90)+' '+CX+' '+CY+')'); svg.appendChild(circ); cum+=pct;
    });
    var tt = document.createElementNS(NS,'text'); tt.setAttribute('x',CX); tt.setAttribute('y',CY-4); tt.setAttribute('text-anchor','middle');
    tt.setAttribute('fill','#e1e4e8'); tt.setAttribute('font-size','16'); tt.setAttribute('font-weight','700'); tt.textContent = fmt(total*-1); svg.appendChild(tt);
    var lb = document.createElementNS(NS,'text'); lb.setAttribute('x',CX); lb.setAttribute('y',CY+14); lb.setAttribute('text-anchor','middle');
    lb.setAttribute('fill','#8b949e'); lb.setAttribute('font-size','11'); lb.textContent = 'Total'; svg.appendChild(lb); layout.appendChild(svg);
    var legend = el('div','spending-legend');
    data.forEach(function(r,i) {
      var pct = total>0?(Math.abs(r.total)/total*100).toFixed(0):0;
      var item = el('div','legend-item'), sw = el('span','legend-swatch'); sw.style.backgroundColor = COLORS[i%COLORS.length];
      item.appendChild(sw); item.appendChild(el('span',null,r.category));
      var vs = el('span',null,fmt(r.total)+' ('+pct+'%)'); vs.style.marginLeft='auto'; vs.style.color='#8b949e'; item.appendChild(vs); legend.appendChild(item);
    });
    layout.appendChild(legend); c.appendChild(layout);
  }
  async function loadSavings() {
    var data = await (await authFetch(BASE+'/api/savings?months=6'+acctParam())).json();
    var c = document.getElementById('savingsContent'); c.replaceChildren();
    if (!data.length) { c.appendChild(el('p','empty','No data.')); return; }
    data.forEach(function(m) {
      var row = el('div','savings-row'); row.appendChild(el('span',null,m.month));
      row.appendChild(el('span',null,'Income: '+fmt(m.income))); row.appendChild(el('span',null,'Expenses: '+fmt(m.expenses)));
      row.appendChild(el('span',m.savingsRate>=0?'income':'expense',m.savingsRate.toFixed(0)+'%')); c.appendChild(row);
    });
  }
  async function loadAlerts() {
    var data = await (await authFetch(BASE+'/api/alerts')).json();
    var c = document.getElementById('alertContent'); c.replaceChildren();
    if (!data.length) { c.appendChild(el('p','empty','No active alerts.')); return; }
    data.forEach(function(a) { c.appendChild(el('div','alert-item alert-'+a.severity,a.message)); });
  }
  function loadOverview() { loadPnl(); loadBudgets(); loadSpending(); loadSavings(); loadAlerts(); }

  // ── Transactions ────────────────────────────────────────────────────────
  var isAdmin = function() { return !currentUser || currentUser.role === 'admin'; };
  async function loadTransactions() {
    var data = await (await authFetch(BASE+'/api/transactions?limit=100'+acctParam())).json();
    var c = document.getElementById('txnContent'); c.replaceChildren();
    if (!data.length) { c.appendChild(el('p','empty','No transactions.')); return; }
    var table = document.createElement('table'), thead = document.createElement('thead'), hr = document.createElement('tr');
    var cols = ['Date','Description','Amount','Category']; if (isAdmin()) cols.push('Actions');
    cols.forEach(function(h){hr.appendChild(el('th',null,h));}); thead.appendChild(hr); table.appendChild(thead);
    var tbody = document.createElement('tbody');
    data.forEach(function(t) {
      var tr = document.createElement('tr'); tr.dataset.id = t.id;
      tr.appendChild(el('td',null,t.date)); tr.appendChild(el('td',null,t.description));
      tr.appendChild(el('td',t.amount>=0?'amt-pos':'amt-neg',fmt(t.amount))); tr.appendChild(el('td',null,t.category||'\\u2014'));
      if (isAdmin()) {
        var act = el('td','txn-actions');
        var eb = el('button','btn-sm','Edit'); eb.addEventListener('click',function(){startEdit(tr,t);});
        var db2 = el('button','btn-sm btn-danger','Delete'); db2.addEventListener('click',function(){deleteTxn(t.id);});
        act.appendChild(eb); act.appendChild(db2); tr.appendChild(act);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); c.appendChild(table);
  }
  function startEdit(tr, t) {
    var cells = tr.children;
    var di = document.createElement('input'); di.type='date'; di.value=t.date; cells[0].replaceChildren(di);
    var desc = document.createElement('input'); desc.type='text'; desc.value=t.description; cells[1].replaceChildren(desc);
    var ai = document.createElement('input'); ai.type='number'; ai.step='0.01'; ai.value=t.amount; cells[2].replaceChildren(ai); cells[2].className='';
    var ci = document.createElement('input'); ci.type='text'; ci.value=t.category||''; cells[3].replaceChildren(ci);
    cells[4].replaceChildren();
    var sb = el('button','btn-sm btn-save','Save');
    sb.addEventListener('click',function(){saveTxn(t.id,{date:di.value,description:desc.value,amount:parseFloat(ai.value),category:ci.value||undefined});});
    var cb = el('button','btn-sm','Cancel'); cb.addEventListener('click',function(){loadTransactions();});
    cells[4].appendChild(sb); cells[4].appendChild(cb);
  }
  async function saveTxn(id, u) {
    try { await authFetch(BASE+'/api/transactions/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(u)}); loadTransactions(); loadOverview(); }
    catch(e) { alert('Error: '+e.message); }
  }
  async function deleteTxn(id) {
    if (!confirm('Delete this transaction?')) return;
    try { await authFetch(BASE+'/api/transactions/'+id,{method:'DELETE'}); loadTransactions(); loadOverview(); }
    catch(e) { alert('Error: '+e.message); }
  }

  // ── Export ──────────────────────────────────────────────────────────────
  document.getElementById('exportBtn').addEventListener('click', function() {
    var format = document.getElementById('exportFormat').value;
    var url = BASE+'/api/export/'+format+'?'+acctParam().replace('&','');
    if (authToken) url += (url.indexOf('?')!==-1?'&':'?')+'token='+authToken;
    var a = document.createElement('a'); a.href = url; a.download = 'transactions.'+format; a.click();
  });

  // ── Accounts tab ────────────────────────────────────────────────────────
  async function loadAccountsTab() {
    try {
      var nw = await (await authFetch(BASE+'/api/net-worth')).json();
      var sc = document.getElementById('nwStats'); sc.replaceChildren();
      [{label:'Total Assets',value:nw.totalAssets,cls:'income'},{label:'Total Liabilities',value:nw.totalLiabilities,cls:'expense'},{label:'Net Worth',value:nw.netWorth,cls:nw.netWorth>=0?'income':'expense'}].forEach(function(s) {
        var card = el('div','nw-stat'); card.appendChild(el('div','nw-value '+s.cls,fmt(s.value))); card.appendChild(el('div','nw-label',s.label)); sc.appendChild(card);
      });
      var tc = document.getElementById('accountsTable'); tc.replaceChildren();
      if (!nw.accounts||!nw.accounts.length) { tc.appendChild(el('p','empty','No accounts. Add accounts via the CLI.')); }
      else {
        var table = document.createElement('table'), thead = document.createElement('thead'), hrow = document.createElement('tr');
        ['Name','Type','Institution','Balance'].forEach(function(h){hrow.appendChild(el('th',null,h));}); thead.appendChild(hrow); table.appendChild(thead);
        var tbody = document.createElement('tbody');
        nw.accounts.forEach(function(a) {
          var tr = document.createElement('tr'); tr.className = 'acct-row';
          tr.appendChild(el('td',null,a.name)); tr.appendChild(el('td',null,a.account_subtype));
          tr.appendChild(el('td',null,a.institution||'\\u2014'));
          tr.appendChild(el('td',a.current_balance>=0?'amt-pos':'amt-neg',fmt(a.current_balance)));
          tr.addEventListener('click',function(){navigateTo('transactions?accountId='+a.id);});
          tbody.appendChild(tr);
        });
        table.appendChild(tbody); tc.appendChild(table);
      }
      var trend = await (await authFetch(BASE+'/api/net-worth/trend?months=12')).json();
      var nc = document.getElementById('nwTrend'); nc.replaceChildren();
      if (!trend||!trend.length) { nc.appendChild(el('p','empty','No balance history yet.')); return; }
      var maxVal = Math.max.apply(null,trend.map(function(t){return Math.max(t.totalAssets,t.totalLiabilities);}))||1;
      trend.forEach(function(t) {
        var row = el('div','nw-trend-bar'); row.appendChild(el('span',null,t.date));
        var track = el('div','nw-bar-track'), fill = el('div','nw-bar-fill');
        fill.style.width = (t.totalAssets/maxVal*100)+'%'; fill.style.background = '#3fb950';
        track.appendChild(fill); row.appendChild(track);
        row.appendChild(el('span',t.netWorth>=0?'income':'expense',fmt(t.netWorth))); nc.appendChild(row);
      });
    } catch(e) { document.getElementById('nwStats').replaceChildren(el('p','empty','Error loading accounts.')); }
  }

  // ── Traces ──────────────────────────────────────────────────────────────
  function fmtDur(ms) { return ms<1000?ms+'ms':(ms/1000).toFixed(1)+'s'; }
  function fmtTok(n) { return n>=1000?(n/1000).toFixed(1)+'k':String(n); }
  async function loadTraces() {
    try {
      var traces = await (await authFetch(BASE+'/api/traces?limit=100')).json();
      var stats = await (await authFetch(BASE+'/api/traces/stats')).json();
      var sc = document.getElementById('traceStats'); sc.replaceChildren();
      [{label:'Total Calls',value:stats.totalCalls},{label:'Errors',value:stats.errorCalls},{label:'Total Tokens',value:fmtTok(stats.totalTokens)},{label:'Avg Latency',value:fmtDur(stats.avgDurationMs)}].forEach(function(s) {
        var card = el('div','trace-stat'); card.appendChild(el('div','stat-value',String(s.value))); card.appendChild(el('div','stat-label',s.label)); sc.appendChild(card);
      });
      var tbody = document.getElementById('traceTableBody'); tbody.replaceChildren();
      if (!traces.length) { var er = document.createElement('tr'); var etd = el('td','empty','No LLM calls recorded yet.'); etd.setAttribute('colspan','9'); er.appendChild(etd); tbody.appendChild(er); return; }
      traces.slice().reverse().forEach(function(t) {
        var tr = document.createElement('tr');
        tr.appendChild(el('td','log-ts',t.timestamp?t.timestamp.slice(11,19):''));
        tr.appendChild(el('td','trace-model',t.model)); tr.appendChild(el('td','trace-provider',t.provider));
        tr.appendChild(el('td','trace-duration',fmtDur(t.durationMs)));
        tr.appendChild(el('td','trace-tokens',fmtTok(t.inputTokens))); tr.appendChild(el('td','trace-tokens',fmtTok(t.outputTokens)));
        tr.appendChild(el('td',null,fmtTok(t.promptLength))); tr.appendChild(el('td',null,fmtTok(t.responseLength)));
        var st = el('td',t.status==='ok'?'trace-status-ok':'trace-status-error',t.status==='ok'?'OK':'ERR');
        if (t.error) st.title = t.error; tr.appendChild(st); tbody.appendChild(tr);
      });
    } catch(e) {
      var tb = document.getElementById('traceTableBody'); tb.replaceChildren();
      var er = document.createElement('tr'); var etd = el('td','empty','Error loading traces.'); etd.setAttribute('colspan','9'); er.appendChild(etd); tb.appendChild(er);
    }
  }

  // ── Logs ────────────────────────────────────────────────────────────────
  async function loadLogs() {
    var data = await (await authFetch(BASE+'/api/logs?limit=100')).json();
    var c = document.getElementById('logContent'); c.replaceChildren();
    if (!data.length) { c.appendChild(el('p','empty','No log entries.')); return; }
    data.forEach(function(entry) {
      var row = el('div','log-entry');
      row.appendChild(el('span','log-ts',entry.ts?entry.ts.slice(11,19):''));
      row.appendChild(el('span','log-level log-level-'+(entry.level||'info'),entry.level||'info'));
      row.appendChild(el('span','log-msg',entry.msg||'')); c.appendChild(row);
    });
    c.scrollTop = c.scrollHeight;
  }

  // ── Chat ────────────────────────────────────────────────────────────────
  var chatMessages = document.getElementById('chatMessages');
  var chatInput = document.getElementById('chatInput');
  var chatSend = document.getElementById('chatSend');
  var sessionList = document.getElementById('sessionList');
  var activeSessionId = null, isLiveSession = true;

  // Lightweight markdown to HTML converter.
  // Security: HTML entities are escaped FIRST, so all user content is
  // neutralized before markdown tags are applied. Only our controlled
  // markdown transformations produce HTML in the output.
  var BT = String.fromCharCode(96), BT3 = BT+BT+BT;
  function renderMd(text) {
    if (!text) return '';
    var s = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var codeBlockRe = new RegExp(BT3+'(\\\\w*)\\\\n([\\\\s\\\\S]*?)'+BT3,'g');
    s = s.replace(codeBlockRe, function(m,lang,code){return '<pre><code>'+code.replace(/\\n$/,'')+'</code></pre>';});
    s = s.replace(/((?:^\\|.+\\|$\\n?)+)/gm, function(block) {
      var rows = block.trim().split('\\n').filter(function(r){return !/^\\|[\\s\\-:|]+\\|$/.test(r);}); if(!rows.length) return block;
      var html = '<table>'; rows.forEach(function(row,i) {
        var cells = row.split('|').filter(function(c,j,a){return j>0&&j<a.length-1;}); var tag = i===0?'th':'td';
        html += '<tr>'+cells.map(function(c){return '<'+tag+'>'+c.trim()+'</'+tag+'>';}).join('')+'</tr>';
      }); return html+'</table>';
    });
    s = s.replace(/^### (.+)$/gm,'<h3>$1</h3>'); s = s.replace(/^## (.+)$/gm,'<h2>$1</h2>'); s = s.replace(/^# (.+)$/gm,'<h1>$1</h1>');
    s = s.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>'); s = s.replace(/\\*(.+?)\\*/g,'<em>$1</em>');
    s = s.replace(new RegExp(BT+'([^'+BT+']+)'+BT,'g'),'<code>$1</code>');
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/((?:^[\\-\\*] .+$\\n?)+)/gm, function(block){return '<ul>'+block.trim().split('\\n').map(function(l){return '<li>'+l.replace(/^[\\-\\*] /,'')+'</li>';}).join('')+'</ul>';});
    s = s.replace(/((?:^\\d+\\. .+$\\n?)+)/gm, function(block){return '<ol>'+block.trim().split('\\n').map(function(l){return '<li>'+l.replace(/^\\d+\\. /,'')+'</li>';}).join('')+'</ol>';});
    s = s.replace(/\\n\\n+/g,'</p><p>'); s = '<p>'+s+'</p>';
    s = s.replace(/<p><(pre|ul|ol|h[123]|table)/g,'<$1'); s = s.replace(/<\\/(pre|ul|ol|h[123]|table)><\\/p>/g,'</$1>'); s = s.replace(/<p><\\/p>/g,'');
    return s;
  }
  function addChatMsg(sender, text, useMarkdown) {
    var isUser = sender==='You';
    var div = el('div','chat-msg '+(isUser?'msg-user':'msg-assistant'));
    div.appendChild(el('div','sender',sender));
    var bubble = el('div','bubble'), textDiv = el('div','text');
    if (useMarkdown && text) {
      // Safe: renderMd escapes all HTML entities before applying markdown transforms
      textDiv.innerHTML = renderMd(text);
    } else { textDiv.textContent = text||''; }
    bubble.appendChild(textDiv); div.appendChild(bubble);
    chatMessages.appendChild(div); chatMessages.scrollTop = chatMessages.scrollHeight; return div;
  }
  function renderSessionMessages(messages) {
    chatMessages.replaceChildren();
    if (!messages||!messages.length) { chatMessages.appendChild(el('p','empty','No messages in this session.')); return; }
    messages.forEach(function(row) { addChatMsg('You',row.query,false); if (row.answer) addChatMsg('Wilson',row.answer,true); });
  }
  async function loadSessions() {
    try {
      var sessions = await (await authFetch(BASE+'/api/chat/sessions')).json();
      sessionList.replaceChildren();
      if (!sessions||!sessions.length) { sessionList.appendChild(el('p','empty','No sessions yet.')); return; }
      sessions.forEach(function(s) {
        var item = el('div','session-item'); if (s.id===activeSessionId) item.classList.add('active');
        item.appendChild(el('div','session-title',s.title||'Untitled'));
        var d = new Date(s.started_at+'Z');
        item.appendChild(el('div','session-date',d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})));
        item.addEventListener('click',function(){selectSession(s.id);}); sessionList.appendChild(item);
      });
    } catch(e) {}
  }
  async function selectSession(id) {
    activeSessionId = id; isLiveSession = false; loadSessions();
    try {
      var messages = await (await authFetch(BASE+'/api/chat/sessions/'+id)).json();
      renderSessionMessages(messages);
    } catch(e) { chatMessages.replaceChildren(); chatMessages.appendChild(el('p','empty','Error loading session.')); }
  }
  async function sendChat() {
    var q = chatInput.value.trim(); if (!q) return;
    chatInput.value = ''; chatSend.disabled = true;
    addChatMsg('You',q,false); var pending = addChatMsg('Wilson','Thinking...',false);
    try {
      var payload = activeSessionId?{query:q,sessionId:activeSessionId}:{query:q};
      var res = await authFetch(BASE+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      var data = await res.json(); var answer = data.answer||'No response.';
      if (data.sessionId) { activeSessionId = data.sessionId; isLiveSession = true; }
      // Safe: renderMd escapes all HTML entities before applying markdown transforms
      pending.querySelector('.text').innerHTML = renderMd(answer);
      loadSessions();
    } catch(e) { pending.querySelector('.text').textContent = 'Error: '+e.message; }
    chatSend.disabled = false; chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  chatSend.addEventListener('click',sendChat);
  chatInput.addEventListener('keydown',function(e){if(e.key==='Enter')sendChat();});
  document.getElementById('newChatBtn').addEventListener('click',function(){activeSessionId=null;isLiveSession=true;chatMessages.replaceChildren();loadSessions();});

  function loadAll() { loadAccountOptions(); activateTab(location.hash.replace('#/','')||'overview'); loadSessions(); }
  checkAuth();
})();
</script>
</body>
</html>`;
}
