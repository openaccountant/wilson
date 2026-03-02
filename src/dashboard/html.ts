/**
 * Self-contained HTML dashboard with inline CSS/JS.
 * No external dependencies — charts are CSS-based, data fetched via fetch().
 *
 * Security note: All dynamic data is inserted via textContent or safe DOM methods.
 * The only innerHTML usage is for trusted static template strings built from
 * local database data — not user-supplied or external content.
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
  .cat-row { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #21262d; font-size:13px; }
  .cat-row:last-child { border-bottom:none; }
  .cat-bar { flex:1; margin:0 12px; height:6px; background:#21262d; border-radius:3px; align-self:center; }
  .cat-bar-fill { height:100%; background:#58a6ff; border-radius:3px; }
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

  /* Transaction actions */
  .txn-actions { display:flex; gap:4px; }
  .btn-sm { padding:4px 8px; border:1px solid #30363d; border-radius:4px; background:#21262d; color:#e1e4e8; cursor:pointer; font-size:11px; }
  .btn-sm:hover { background:#30363d; }
  .btn-danger { color:#f85149; border-color:#f8514966; }
  .btn-danger:hover { background:#f8514933; }
  .btn-save { color:#3fb950; border-color:#3fb95066; }
  .btn-save:hover { background:#3fb95033; }
  td input, td select { background:#21262d; color:#e1e4e8; border:1px solid #30363d; padding:4px 6px; border-radius:4px; font-size:12px; width:100%; }

  /* Chat */
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

  /* Logs */
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

  /* Traces */
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

  /* Spending donut chart */
  .spending-layout { display:flex; gap:24px; align-items:center; }
  .donut-chart { flex-shrink:0; width:160px; height:160px; }
  .spending-legend { flex:1; }
  .legend-item { display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:13px; }
  .legend-swatch { width:12px; height:12px; border-radius:2px; flex-shrink:0; }

  .loading { color:#8b949e; font-style:italic; }
  .empty { color:#8b949e; }
</style>
</head>
<body>
<div class="header">
  <h1>Open Accountant Dashboard</h1>
  <div class="header-controls">
    <select id="monthPicker"></select>
  </div>
</div>

<div class="tab-bar">
  <button class="tab-btn active" data-tab="overview">Overview</button>
  <button class="tab-btn" data-tab="transactions">Transactions</button>
  <button class="tab-btn" data-tab="chat">Chat</button>
  <button class="tab-btn" data-tab="traces">Traces</button>
  <button class="tab-btn" data-tab="logs">Logs</button>
</div>

<!-- Overview Tab -->
<div class="tab-panel active" id="tab-overview">
  <div class="grid">
    <div class="card" id="pnlCard">
      <h3>Profit &amp; Loss</h3>
      <div class="pnl-grid" id="pnlContent"><p class="loading">Loading...</p></div>
    </div>
    <div class="card" id="budgetCard">
      <h3>Budgets</h3>
      <div id="budgetContent"><p class="loading">Loading...</p></div>
    </div>
    <div class="card" id="spendingCard">
      <h3>Spending by Category</h3>
      <div id="spendingContent"><p class="loading">Loading...</p></div>
    </div>
    <div class="card" id="savingsCard">
      <h3>Savings Rate Trend</h3>
      <div id="savingsContent"><p class="loading">Loading...</p></div>
    </div>
    <div class="card full-width" id="alertCard">
      <h3>Alerts</h3>
      <div id="alertContent"><p class="loading">Loading...</p></div>
    </div>
  </div>
</div>

<!-- Transactions Tab -->
<div class="tab-panel" id="tab-transactions">
  <div style="padding:16px 24px;">
    <div class="card full-width">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">Transactions</h3>
        <button id="exportCsvBtn" class="btn-sm" style="padding:4px 12px;">Export CSV</button>
      </div>
      <div id="txnContent"><p class="loading">Loading...</p></div>
    </div>
  </div>
</div>

<!-- Chat Tab -->
<div class="tab-panel" id="tab-chat">
  <div class="chat-layout">
    <div class="chat-sidebar" id="chatSidebar">
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

<!-- Traces Tab -->
<div class="tab-panel" id="tab-traces">
  <div class="traces-panel">
    <div class="trace-stats" id="traceStats"></div>
    <div class="trace-container">
      <table class="trace-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Model</th>
            <th>Provider</th>
            <th>Duration</th>
            <th>In Tokens</th>
            <th>Out Tokens</th>
            <th>Prompt</th>
            <th>Response</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="traceTableBody">
          <tr><td colspan="9" class="loading">Loading...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<!-- Logs Tab -->
<div class="tab-panel" id="tab-logs">
  <div class="log-panel">
    <div class="log-container" id="logContent">
      <p class="loading">Loading...</p>
    </div>
  </div>
</div>

<script>
(function() {
  'use strict';
  const BASE = 'http://localhost:${port}';
  let currentMonth = new Date().toISOString().slice(0,7);

  // Helpers — all use safe DOM methods (createElement + textContent)
  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function fmt(n) {
    const abs = Math.abs(n).toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
    return n >= 0 ? '$' + abs : '-$' + abs;
  }

  // Tab switching
  var tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      tabBtns.forEach(function(b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      // Load data for the tab on first visit
      if (btn.dataset.tab === 'transactions') loadTransactions();
      if (btn.dataset.tab === 'traces') loadTraces();
      if (btn.dataset.tab === 'logs') loadLogs();
    });
  });

  // Month picker
  const picker = document.getElementById('monthPicker');
  for (let i = 0; i < 12; i++) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const opt = document.createElement('option');
    opt.value = d.toISOString().slice(0,7);
    opt.textContent = d.toLocaleString('en-US', { month:'long', year:'numeric' });
    picker.appendChild(opt);
  }
  picker.addEventListener('change', function() { currentMonth = picker.value; loadOverview(); });

  async function loadPnl() {
    const data = await (await fetch(BASE+'/api/pnl?month='+currentMonth)).json();
    const container = document.getElementById('pnlContent');
    container.replaceChildren();
    [
      { label: 'Income', value: data.totalIncome, cls: 'income' },
      { label: 'Expenses', value: data.totalExpenses, cls: 'expense' },
      { label: 'Net', value: data.netProfitLoss, cls: data.netProfitLoss >= 0 ? 'income' : 'expense' },
    ].forEach(function(item) {
      const div = el('div', 'pnl-item');
      div.appendChild(el('div', 'label', item.label));
      const v = el('div', 'value ' + item.cls, fmt(item.value));
      div.appendChild(v);
      container.appendChild(div);
    });
  }

  async function loadBudgets() {
    const data = await (await fetch(BASE+'/api/budgets?month='+currentMonth)).json();
    const container = document.getElementById('budgetContent');
    container.replaceChildren();
    if (!data.length) { container.appendChild(el('p', 'empty', 'No budgets set.')); return; }
    data.forEach(function(b) {
      const bar = el('div', 'budget-bar');
      const labelRow = el('div', 'bar-label');
      labelRow.appendChild(el('span', null, b.category));
      labelRow.appendChild(el('span', null, b.percent_used + '%' + (b.over ? ' OVER' : '')));
      bar.appendChild(labelRow);
      const track = el('div', 'bar-track');
      const cls = b.over ? 'bar-over' : b.percent_used >= 80 ? 'bar-warn' : 'bar-ok';
      const fill = el('div', 'bar-fill ' + cls);
      fill.style.width = Math.min(b.percent_used, 100) + '%';
      track.appendChild(fill);
      bar.appendChild(track);
      container.appendChild(bar);
    });
  }

  var CATEGORY_COLORS = ['#3fb950','#58a6ff','#d29922','#f85149','#bc8cff','#79c0ff','#f0883e','#56d364','#db61a2','#8b949e'];

  async function loadSpending() {
    var data = await (await fetch(BASE+'/api/summary?month='+currentMonth)).json();
    var container = document.getElementById('spendingContent');
    container.replaceChildren();
    if (!data.length) { container.appendChild(el('p', 'empty', 'No spending data.')); return; }
    var total = data.reduce(function(s,r) { return s + Math.abs(r.total); }, 0);

    var layout = el('div', 'spending-layout');

    // SVG donut chart
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 200 200');
    svg.setAttribute('class', 'donut-chart');
    var R = 70, CX = 100, CY = 100, CIRC = 2 * Math.PI * R;
    var cumulative = 0;
    data.forEach(function(r, i) {
      var pct = total > 0 ? Math.abs(r.total) / total : 0;
      if (pct <= 0) return;
      var circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('cx', CX);
      circle.setAttribute('cy', CY);
      circle.setAttribute('r', R);
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', CATEGORY_COLORS[i % CATEGORY_COLORS.length]);
      circle.setAttribute('stroke-width', '30');
      circle.setAttribute('stroke-dasharray', CIRC);
      circle.setAttribute('stroke-dashoffset', CIRC * (1 - pct));
      circle.setAttribute('transform', 'rotate(' + (cumulative * 360 - 90) + ' ' + CX + ' ' + CY + ')');
      svg.appendChild(circle);
      cumulative += pct;
    });
    // Center total text
    var totalText = document.createElementNS(NS, 'text');
    totalText.setAttribute('x', CX);
    totalText.setAttribute('y', CY - 4);
    totalText.setAttribute('text-anchor', 'middle');
    totalText.setAttribute('fill', '#e1e4e8');
    totalText.setAttribute('font-size', '16');
    totalText.setAttribute('font-weight', '700');
    totalText.textContent = fmt(total * -1);
    svg.appendChild(totalText);
    var label = document.createElementNS(NS, 'text');
    label.setAttribute('x', CX);
    label.setAttribute('y', CY + 14);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', '#8b949e');
    label.setAttribute('font-size', '11');
    label.textContent = 'Total';
    svg.appendChild(label);
    layout.appendChild(svg);

    // Legend
    var legend = el('div', 'spending-legend');
    data.forEach(function(r, i) {
      var pct = total > 0 ? (Math.abs(r.total) / total * 100).toFixed(0) : 0;
      var item = el('div', 'legend-item');
      var swatch = el('span', 'legend-swatch');
      swatch.style.backgroundColor = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
      item.appendChild(swatch);
      item.appendChild(el('span', null, r.category));
      var valSpan = el('span', null, fmt(r.total) + ' (' + pct + '%)');
      valSpan.style.marginLeft = 'auto';
      valSpan.style.color = '#8b949e';
      item.appendChild(valSpan);
      legend.appendChild(item);
    });
    layout.appendChild(legend);
    container.appendChild(layout);
  }

  async function loadSavings() {
    const data = await (await fetch(BASE+'/api/savings?months=6')).json();
    const container = document.getElementById('savingsContent');
    container.replaceChildren();
    if (!data.length) { container.appendChild(el('p', 'empty', 'No data.')); return; }
    data.forEach(function(m) {
      const row = el('div', 'savings-row');
      row.appendChild(el('span', null, m.month));
      row.appendChild(el('span', null, 'Income: ' + fmt(m.income)));
      row.appendChild(el('span', null, 'Expenses: ' + fmt(m.expenses)));
      const rateSpan = el('span', m.savingsRate >= 0 ? 'income' : 'expense', m.savingsRate.toFixed(0) + '%');
      row.appendChild(rateSpan);
      container.appendChild(row);
    });
  }

  async function loadAlerts() {
    const data = await (await fetch(BASE+'/api/alerts')).json();
    const container = document.getElementById('alertContent');
    container.replaceChildren();
    if (!data.length) { container.appendChild(el('p', 'empty', 'No active alerts.')); return; }
    data.forEach(function(a) {
      const item = el('div', 'alert-item alert-' + a.severity, a.message);
      container.appendChild(item);
    });
  }

  function loadOverview() { loadPnl(); loadBudgets(); loadSpending(); loadSavings(); loadAlerts(); }
  loadOverview();

  // ── Transactions tab with inline edit/delete ──────────────────────────────

  async function loadTransactions() {
    const data = await (await fetch(BASE+'/api/transactions?limit=100')).json();
    const container = document.getElementById('txnContent');
    container.replaceChildren();
    if (!data.length) { container.appendChild(el('p', 'empty', 'No transactions.')); return; }
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['Date', 'Description', 'Amount', 'Category', 'Actions'].forEach(function(h) {
      headerRow.appendChild(el('th', null, h));
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    data.forEach(function(t) {
      var tr = document.createElement('tr');
      tr.dataset.id = t.id;
      tr.appendChild(el('td', null, t.date));
      tr.appendChild(el('td', null, t.description));
      tr.appendChild(el('td', t.amount >= 0 ? 'amt-pos' : 'amt-neg', fmt(t.amount)));
      tr.appendChild(el('td', null, t.category || '\\u2014'));
      var actionsTd = el('td', 'txn-actions');
      var editBtn = el('button', 'btn-sm', 'Edit');
      editBtn.addEventListener('click', function() { startEdit(tr, t); });
      var deleteBtn = el('button', 'btn-sm btn-danger', 'Delete');
      deleteBtn.addEventListener('click', function() { deleteTxn(t.id); });
      actionsTd.appendChild(editBtn);
      actionsTd.appendChild(deleteBtn);
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  function startEdit(tr, t) {
    var cells = tr.children;
    // Replace text cells with inputs
    var dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.value = t.date;
    cells[0].replaceChildren(dateInput);

    var descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.value = t.description;
    cells[1].replaceChildren(descInput);

    var amtInput = document.createElement('input');
    amtInput.type = 'number';
    amtInput.step = '0.01';
    amtInput.value = t.amount;
    cells[2].replaceChildren(amtInput);
    cells[2].className = '';

    var catInput = document.createElement('input');
    catInput.type = 'text';
    catInput.value = t.category || '';
    cells[3].replaceChildren(catInput);

    // Replace actions with save/cancel
    cells[4].replaceChildren();
    var saveBtn = el('button', 'btn-sm btn-save', 'Save');
    saveBtn.addEventListener('click', function() {
      saveTxn(t.id, {
        date: dateInput.value,
        description: descInput.value,
        amount: parseFloat(amtInput.value),
        category: catInput.value || undefined,
      });
    });
    var cancelBtn = el('button', 'btn-sm', 'Cancel');
    cancelBtn.addEventListener('click', function() { loadTransactions(); });
    cells[4].appendChild(saveBtn);
    cells[4].appendChild(cancelBtn);
  }

  async function saveTxn(id, updates) {
    try {
      await fetch(BASE+'/api/transactions/'+id, {
        method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(updates)
      });
      loadTransactions();
      loadOverview();
    } catch(e) { alert('Error saving: '+e.message); }
  }

  async function deleteTxn(id) {
    if (!confirm('Delete this transaction? This cannot be undone.')) return;
    try {
      await fetch(BASE+'/api/transactions/'+id, { method:'DELETE' });
      loadTransactions();
      loadOverview();
    } catch(e) { alert('Error deleting: '+e.message); }
  }

  // ── Export CSV ──────────────────────────────────────────────────────────
  document.getElementById('exportCsvBtn').addEventListener('click', function() {
    var a = document.createElement('a');
    a.href = BASE + '/api/export/csv';
    a.download = 'transactions.csv';
    a.click();
  });

  // ── Traces tab ────────────────────────────────────────────────────────────

  function fmtDuration(ms) {
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }
  function fmtTokens(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }
  function fmtChars(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  async function loadTraces() {
    try {
      var traces = await (await fetch(BASE+'/api/traces?limit=100')).json();
      var stats = await (await fetch(BASE+'/api/traces/stats')).json();

      // Render stats cards
      var statsContainer = document.getElementById('traceStats');
      statsContainer.replaceChildren();
      var statItems = [
        { label: 'Total Calls', value: stats.totalCalls },
        { label: 'Errors', value: stats.errorCalls },
        { label: 'Total Tokens', value: fmtTokens(stats.totalTokens) },
        { label: 'Avg Latency', value: fmtDuration(stats.avgDurationMs) },
      ];
      statItems.forEach(function(s) {
        var card = el('div', 'trace-stat');
        card.appendChild(el('div', 'stat-value', String(s.value)));
        card.appendChild(el('div', 'stat-label', s.label));
        statsContainer.appendChild(card);
      });

      // Render trace table
      var tbody = document.getElementById('traceTableBody');
      tbody.replaceChildren();
      if (!traces.length) {
        var emptyRow = document.createElement('tr');
        var emptyTd = el('td', 'empty', 'No LLM calls recorded yet.');
        emptyTd.setAttribute('colspan', '9');
        emptyRow.appendChild(emptyTd);
        tbody.appendChild(emptyRow);
        return;
      }
      // Show newest first
      traces.slice().reverse().forEach(function(t) {
        var tr = document.createElement('tr');
        var ts = t.timestamp ? t.timestamp.slice(11, 19) : '';
        tr.appendChild(el('td', 'log-ts', ts));
        tr.appendChild(el('td', 'trace-model', t.model));
        tr.appendChild(el('td', 'trace-provider', t.provider));
        tr.appendChild(el('td', 'trace-duration', fmtDuration(t.durationMs)));
        tr.appendChild(el('td', 'trace-tokens', fmtTokens(t.inputTokens)));
        tr.appendChild(el('td', 'trace-tokens', fmtTokens(t.outputTokens)));
        tr.appendChild(el('td', null, fmtChars(t.promptLength)));
        tr.appendChild(el('td', null, fmtChars(t.responseLength)));
        var statusTd = el('td', t.status === 'ok' ? 'trace-status-ok' : 'trace-status-error', t.status === 'ok' ? 'OK' : 'ERR');
        if (t.error) statusTd.title = t.error;
        tr.appendChild(statusTd);
        tbody.appendChild(tr);
      });
    } catch(e) {
      var tbody2 = document.getElementById('traceTableBody');
      tbody2.replaceChildren();
      var errRow = document.createElement('tr');
      var errTd = el('td', 'empty', 'Error loading traces.');
      errTd.setAttribute('colspan', '9');
      errRow.appendChild(errTd);
      tbody2.appendChild(errRow);
    }
  }

  // ── Logs tab ──────────────────────────────────────────────────────────────

  async function loadLogs() {
    var data = await (await fetch(BASE+'/api/logs?limit=100')).json();
    var container = document.getElementById('logContent');
    container.replaceChildren();
    if (!data.length) { container.appendChild(el('p', 'empty', 'No log entries.')); return; }
    data.forEach(function(entry) {
      var row = el('div', 'log-entry');
      var ts = entry.ts ? entry.ts.slice(11, 19) : '';
      row.appendChild(el('span', 'log-ts', ts));
      row.appendChild(el('span', 'log-level log-level-' + (entry.level || 'info'), entry.level || 'info'));
      row.appendChild(el('span', 'log-msg', entry.msg || ''));
      container.appendChild(row);
    });
    container.scrollTop = container.scrollHeight;
  }

  // ── Chat tab ──────────────────────────────────────────────────────────────

  var chatMessages = document.getElementById('chatMessages');
  var chatInput = document.getElementById('chatInput');
  var chatSend = document.getElementById('chatSend');
  var sessionList = document.getElementById('sessionList');
  var activeSessionId = null;
  var isLiveSession = true;

  // Lightweight markdown to HTML converter.
  // Security: HTML entities are escaped FIRST, so all user content is
  // neutralized before markdown tags are applied. Only our controlled
  // markdown transformations produce HTML in the output.
  var BT = String.fromCharCode(96);
  var BT3 = BT+BT+BT;
  function renderMd(text) {
    if (!text) return '';
    var s = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Code blocks
    var codeBlockRe = new RegExp(BT3+'(\\\\w*)\\\\n([\\\\s\\\\S]*?)'+BT3, 'g');
    s = s.replace(codeBlockRe, function(m, lang, code) {
      return '<pre><code>' + code.replace(/\\n$/, '') + '</code></pre>';
    });
    // Tables
    s = s.replace(/((?:^\\|.+\\|$\\n?)+)/gm, function(block) {
      var rows = block.trim().split('\\n').filter(function(r) { return !/^\\|[\\s\\-:|]+\\|$/.test(r); });
      if (!rows.length) return block;
      var html = '<table>';
      rows.forEach(function(row, i) {
        var cells = row.split('|').filter(function(c,j,a) { return j > 0 && j < a.length - 1; });
        var tag = i === 0 ? 'th' : 'td';
        html += '<tr>' + cells.map(function(c) { return '<' + tag + '>' + c.trim() + '</' + tag + '>'; }).join('') + '</tr>';
      });
      return html + '</table>';
    });
    // Headers
    s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // Bold and italic
    s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
    // Inline code
    var inlineCodeRe = new RegExp(BT+'([^'+BT+']+)'+BT, 'g');
    s = s.replace(inlineCodeRe, '<code>$1</code>');
    // Links
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // Unordered lists
    s = s.replace(/((?:^[\\-\\*] .+$\\n?)+)/gm, function(block) {
      var items = block.trim().split('\\n').map(function(l) { return '<li>' + l.replace(/^[\\-\\*] /, '') + '</li>'; });
      return '<ul>' + items.join('') + '</ul>';
    });
    // Ordered lists
    s = s.replace(/((?:^\\d+\\. .+$\\n?)+)/gm, function(block) {
      var items = block.trim().split('\\n').map(function(l) { return '<li>' + l.replace(/^\\d+\\. /, '') + '</li>'; });
      return '<ol>' + items.join('') + '</ol>';
    });
    // Paragraphs
    s = s.replace(/\\n\\n+/g, '</p><p>');
    s = '<p>' + s + '</p>';
    s = s.replace(/<p><(pre|ul|ol|h[123]|table)/g, '<$1');
    s = s.replace(/<\\/(pre|ul|ol|h[123]|table)><\\/p>/g, '</$1>');
    s = s.replace(/<p><\\/p>/g, '');
    return s;
  }

  function addChatMsg(sender, text, useMarkdown) {
    var isUser = sender === 'You';
    var div = el('div', 'chat-msg ' + (isUser ? 'msg-user' : 'msg-assistant'));
    div.appendChild(el('div', 'sender', sender));
    var bubble = el('div', 'bubble');
    var textDiv = el('div', 'text');
    if (useMarkdown && text) {
      // Safe: renderMd escapes all HTML entities before applying markdown transforms
      textDiv.innerHTML = renderMd(text);
    } else {
      textDiv.textContent = text || '';
    }
    bubble.appendChild(textDiv);
    div.appendChild(bubble);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
  }

  function renderSessionMessages(messages) {
    chatMessages.replaceChildren();
    if (!messages || !messages.length) {
      chatMessages.appendChild(el('p', 'empty', 'No messages in this session.'));
      return;
    }
    messages.forEach(function(row) {
      addChatMsg('You', row.query, false);
      if (row.answer) addChatMsg('Wilson', row.answer, true);
    });
  }

  async function loadSessions() {
    try {
      var sessions = await (await fetch(BASE+'/api/chat/sessions')).json();
      sessionList.replaceChildren();
      if (!sessions || !sessions.length) {
        sessionList.appendChild(el('p', 'empty', 'No sessions yet.'));
        return;
      }
      sessions.forEach(function(s) {
        var item = el('div', 'session-item');
        if (s.id === activeSessionId) item.classList.add('active');
        var title = s.title || 'Untitled';
        item.appendChild(el('div', 'session-title', title));
        var d = new Date(s.started_at + 'Z');
        item.appendChild(el('div', 'session-date', d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})));
        item.addEventListener('click', function() { selectSession(s.id); });
        sessionList.appendChild(item);
      });
    } catch(e) { /* ignore */ }
  }

  async function selectSession(id) {
    activeSessionId = id;
    isLiveSession = false;
    // Update active state in sidebar
    sessionList.querySelectorAll('.session-item').forEach(function(item, i) { item.classList.remove('active'); });
    var items = sessionList.querySelectorAll('.session-item');
    // Re-highlight by re-rendering (simplest approach)
    loadSessions();
    // Load that session's messages
    try {
      var messages = await (await fetch(BASE+'/api/chat/sessions/'+id)).json();
      renderSessionMessages(messages);
    } catch(e) {
      chatMessages.replaceChildren();
      chatMessages.appendChild(el('p', 'empty', 'Error loading session.'));
    }
  }

  async function sendChat() {
    var q = chatInput.value.trim();
    if (!q) return;
    chatInput.value = '';
    chatSend.disabled = true;
    addChatMsg('You', q, false);
    var pending = addChatMsg('Wilson', 'Thinking...', false);
    try {
      var payload = activeSessionId ? {query:q, sessionId: activeSessionId} : {query:q};
      var res = await fetch(BASE+'/api/chat', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
      });
      var data = await res.json();
      var answer = data.answer || 'No response.';
      if (data.sessionId) {
        activeSessionId = data.sessionId;
        isLiveSession = true;
      }
      // Safe: renderMd escapes all HTML entities before applying markdown transforms
      pending.querySelector('.text').innerHTML = renderMd(answer);
      // Refresh session list to show updated titles
      loadSessions();
    } catch(e) {
      pending.querySelector('.text').textContent = 'Error: '+e.message;
    }
    chatSend.disabled = false;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') sendChat(); });

  // New Chat button
  document.getElementById('newChatBtn').addEventListener('click', function() {
    activeSessionId = null;
    isLiveSession = true;
    chatMessages.replaceChildren();
    loadSessions();
  });

  // Load sessions on startup
  loadSessions();
})();
</script>
</body>
</html>`;
}
