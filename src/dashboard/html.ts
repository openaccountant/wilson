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
  .header select { background:#21262d; color:#e1e4e8; border:1px solid #30363d; padding:6px 10px; border-radius:6px; }
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
  .chat-container { grid-column:1/-1; }
  .chat-messages { max-height:300px; overflow-y:auto; padding:12px; background:#0d1117; border-radius:6px; margin-bottom:12px; min-height:100px; }
  .chat-msg { margin-bottom:12px; }
  .chat-msg .sender { font-size:11px; color:#8b949e; margin-bottom:2px; }
  .chat-msg .text { font-size:14px; line-height:1.5; white-space:pre-wrap; }
  .chat-input-row { display:flex; gap:8px; }
  .chat-input-row input { flex:1; background:#21262d; color:#e1e4e8; border:1px solid #30363d; padding:10px 14px; border-radius:6px; font-size:14px; }
  .chat-input-row input:focus { outline:none; border-color:#58a6ff; }
  .chat-input-row button { background:#238636; color:#fff; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600; }
  .chat-input-row button:hover { background:#2ea043; }
  .chat-input-row button:disabled { opacity:0.5; cursor:not-allowed; }
  .loading { color:#8b949e; font-style:italic; }
  .empty { color:#8b949e; }
</style>
</head>
<body>
<div class="header">
  <h1>Open Accountant Dashboard</h1>
  <div>
    <select id="monthPicker"></select>
  </div>
</div>

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
  <div class="card full-width" id="txnCard">
    <h3>Recent Transactions</h3>
    <div id="txnContent"><p class="loading">Loading...</p></div>
  </div>
  <div class="card chat-container">
    <h3>Chat with Open Accountant</h3>
    <div class="chat-messages" id="chatMessages"></div>
    <div class="chat-input-row">
      <input type="text" id="chatInput" placeholder="Ask Open Accountant anything..." />
      <button id="chatSend">Send</button>
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
  picker.addEventListener('change', function() { currentMonth = picker.value; loadAll(); });

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

  async function loadSpending() {
    const data = await (await fetch(BASE+'/api/summary?month='+currentMonth)).json();
    const container = document.getElementById('spendingContent');
    container.replaceChildren();
    if (!data.length) { container.appendChild(el('p', 'empty', 'No spending data.')); return; }
    const total = data.reduce(function(s,r) { return s + Math.abs(r.total); }, 0);
    data.forEach(function(r) {
      const pct = total > 0 ? (Math.abs(r.total) / total * 100).toFixed(0) : 0;
      const row = el('div', 'cat-row');
      row.appendChild(el('span', null, r.category));
      const barOuter = el('div', 'cat-bar');
      const barInner = el('div', 'cat-bar-fill');
      barInner.style.width = pct + '%';
      barOuter.appendChild(barInner);
      row.appendChild(barOuter);
      row.appendChild(el('span', null, fmt(r.total) + ' (' + pct + '%)'));
      container.appendChild(row);
    });
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

  async function loadTransactions() {
    const data = await (await fetch(BASE+'/api/transactions?limit=25')).json();
    const container = document.getElementById('txnContent');
    container.replaceChildren();
    if (!data.length) { container.appendChild(el('p', 'empty', 'No transactions.')); return; }
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['Date', 'Description', 'Amount', 'Category'].forEach(function(h) {
      headerRow.appendChild(el('th', null, h));
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    data.forEach(function(t) {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', null, t.date));
      tr.appendChild(el('td', null, t.description));
      tr.appendChild(el('td', t.amount >= 0 ? 'amt-pos' : 'amt-neg', fmt(t.amount)));
      tr.appendChild(el('td', null, t.category || '\\u2014'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  function loadAll() { loadPnl(); loadBudgets(); loadSpending(); loadSavings(); loadAlerts(); loadTransactions(); }
  loadAll();

  // Chat — uses safe DOM methods exclusively
  var chatMessages = document.getElementById('chatMessages');
  var chatInput = document.getElementById('chatInput');
  var chatSend = document.getElementById('chatSend');

  function addChatMsg(sender, text) {
    var div = el('div', 'chat-msg');
    div.appendChild(el('div', 'sender', sender));
    div.appendChild(el('div', 'text', text));
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
  }

  async function sendChat() {
    var q = chatInput.value.trim();
    if (!q) return;
    chatInput.value = '';
    chatSend.disabled = true;
    addChatMsg('You', q);
    var pending = addChatMsg('Open Accountant', 'Thinking...');
    try {
      var res = await fetch(BASE+'/api/chat', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({query:q})
      });
      var data = await res.json();
      pending.querySelector('.text').textContent = data.answer || 'No response.';
    } catch(e) {
      pending.querySelector('.text').textContent = 'Error: '+e.message;
    }
    chatSend.disabled = false;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') sendChat(); });
})();
</script>
</body>
</html>`;
}
