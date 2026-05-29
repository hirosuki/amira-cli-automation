const { google } = require('googleapis');
const axios = require('axios');
const { Parser } = require('json2csv');
const fs = require('fs');
const path = require('path');

// Salesforce config
const REPORT_ID = '00OUb00000JDJUwMAP';
const SF_INSTANCE_URL = 'https://istation.my.salesforce.com';

// Priority / status filters
const ACTIVE_PRIORITIES = ['P0', 'P1', 'P2'];
const EXCLUDED_STATUSES = ['Closed/Complete', 'Closed (Unresolved)'];

// Environment variables
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || '#daily-briefing';
const GOOGLE_DRIVE_FOLDER_ID = '1WfFQTkAqwHd-3bObix-2lwrQzRc5T08u';
const GOOGLE_CREDENTIALS = process.env.GOOGLE_DRIVE_CREDENTIALS
  ? JSON.parse(process.env.GOOGLE_DRIVE_CREDENTIALS)
  : null;
const SF_SESSION_ID = process.env.SF_SESSION_ID;

/**
 * Download report as JSON via SF Analytics REST API using session ID
 */
async function downloadReport() {
  console.log('📥 Downloading report via SF Analytics API...');

  if (!SF_SESSION_ID) {
    throw new Error('SF_SESSION_ID secret is not set.');
  }

  const url = `${SF_INSTANCE_URL}/services/data/v59.0/analytics/reports/${REPORT_ID}?includeDetails=true`;
  console.log(`  URL: ${url}`);

  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${SF_SESSION_ID}`,
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  console.log(`✅ Report data received (HTTP ${resp.status})`);
  return resp.data;
}

/**
 * Convert SF Analytics API JSON into flat case objects
 */
function parseReportData(reportData) {
  const cases = [];

  const factMap = reportData.factMap || {};
  const columns = reportData.reportMetadata?.detailColumns || [];
  const columnInfo = reportData.reportExtendedMetadata?.detailColumnInfo || {};

  // Build column label map
  const colLabels = {};
  columns.forEach(col => {
    colLabels[col] = columnInfo[col]?.label || col;
  });

  console.log(`  Columns: ${columns.map(c => colLabels[c]).join(', ')}`);

  // Rows live under keys like "T!T", "0!T", etc.
  Object.entries(factMap).forEach(([key, value]) => {
    if (!value.rows) return;
    value.rows.forEach(row => {
      const obj = {};
      row.dataCells.forEach((cell, idx) => {
        const label = colLabels[columns[idx]] || columns[idx];
        obj[label] = cell.label || cell.value || '';
      });
      cases.push(obj);
    });
  });

  console.log(`  Extracted ${cases.length} total rows`);
  return cases;
}

/**
 * Normalize to standard case shape using fuzzy key matching
 */
function normalizeCase(row) {
  const keys = Object.keys(row);
  const find = (...names) => {
    for (const n of names) {
      const k = keys.find(k => k.toLowerCase().includes(n.toLowerCase()));
      if (k) return row[k] || '';
    }
    return '';
  };
  return {
    status: find('Status'),
    accountName: find('Account Name', 'Account'),
    accountState: find('State', 'Billing State'),
    dateTimeOpened: find('Date/Time Opened', 'Opened', 'Created'),
    caseNumber: find('Case Number', 'Number'),
    subject: find('Subject'),
    caseOwner: find('Case Owner', 'Owner'),
    age: find('Age', 'Days Open'),
    priority: find('Priority'),
  };
}

/**
 * Filter to active priority cases only
 */
function filterCases(cases) {
  // If no cases matched strict priority filter, return all open cases
  const strict = cases.filter(c => {
    const fields = [c.caseNumber, c.subject, c.status, c.priority].join(' ');
    const hasPriority = ACTIVE_PRIORITIES.some(p => fields.includes(p));
    const isOpen = !EXCLUDED_STATUSES.some(s => c.status?.includes(s));
    return hasPriority && isOpen;
  });

  if (strict.length > 0) return strict;

  // Fallback: return all open cases
  console.log('  No P0/P1/P2 matches found — returning all open cases');
  return cases.filter(c => !EXCLUDED_STATUSES.some(s => c.status?.includes(s)));
}

/**
 * Generate summary metrics using real SF Priority field
 * SF values: Low, Medium, High, Critical (mapped to P2, P2, P1, P0)
 */
function generateSummary(cases) {
  const byPriority = { P0: 0, P1: 0, P2: 0 };
  const byStatus = {};

  const samplePriorities = [...new Set(cases.map(c => c.priority).filter(Boolean))];
  console.log(`  Priority field values found: ${JSON.stringify(samplePriorities)}`);

  const priorityMap = {
    'critical': 'P0',
    'high': 'P1',
    'medium': 'P2',
    'low': 'P2',
  };

  cases.forEach(c => {
    const raw = (c.priority || '').toLowerCase().trim();
    const mapped = priorityMap[raw];
    if (mapped) {
      byPriority[mapped]++;
    } else {
      // No priority set — count as P2
      byPriority['P2']++;
    }

    const s = c.status || 'Unknown';
    byStatus[s] = (byStatus[s] || 0) + 1;
  });

  return {
    totalCases: cases.length,
    byPriority,
    byStatus,
    asOf: new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }),
  };
}

/**
 * Send summary to Slack
 */
async function sendToSlack(cases, summary) {
  console.log('📤 Sending to Slack...');

  const priorityRows = ACTIVE_PRIORITIES
    .filter(p => summary.byPriority[p])
    .map(p => `${p}: ${summary.byPriority[p]}`)
    .join(' | ') || 'None';

  const statusRows = Object.entries(summary.byStatus)
    .map(([s, n]) => `• ${s}: ${n}`)
    .join('\n') || 'None';

  const resp = await axios.post(
    'https://slack.com/api/chat.postMessage',
    {
      channel: SLACK_CHANNEL,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '📋 MWGL Case Report' } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Total Active Cases:*\n${summary.totalCases}` },
            { type: 'mrkdwn', text: `*By Priority:*\n${priorityRows}` },
          ],
        },
        { type: 'section', text: { type: 'mrkdwn', text: `*By Status:*\n${statusRows}` } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: `*Last Updated:* ${summary.asOf}` } },
      ],
    },
    { headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' } }
  );

  if (!resp.data.ok) throw new Error(`Slack error: ${resp.data.error}`);
  console.log('✅ Sent to Slack');
}

/**
 * Upload CSV to Google Drive
 */
async function uploadToGoogleDrive(cases) {
  console.log('☁️  Uploading to Google Drive...');

  if (!GOOGLE_CREDENTIALS) {
    console.warn('⚠️  No Google credentials — skipping Drive upload.');
    return;
  }

  const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });

  const parser = new Parser();
  const csv = parser.parse(cases.length ? cases : [{ note: 'No active cases' }]);
  const { Readable } = require('stream');

  const timestamp = new Date().toISOString().slice(0, 10);
  const fileName = `MWGL_Cases_${timestamp}.csv`;

  const response = await drive.files.create({
    requestBody: { name: fileName, parents: [GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType: 'text/csv', body: Readable.from([csv]) },
  });

  console.log(`✅ Uploaded: ${response.data.name} (ID: ${response.data.id})`);
}

/**
 * Generate a fully self-contained HTML report with data baked in
 */
function generateHTML(cases, summary) {
  const ts = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  });

  const byStatus = summary.byStatus || {};
  const byOwner = {};
  cases.forEach(c => { if (c.caseOwner) byOwner[c.caseOwner] = (byOwner[c.caseOwner] || 0) + 1; });
  const maxS = Math.max(...Object.values(byStatus), 1);
  const maxO = Math.max(...Object.values(byOwner), 1);
  const avgAge = (() => {
    const ages = cases.map(c => parseFloat(c.age) || 0).filter(n => n > 0);
    return ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;
  })();

  const statusRows = Object.entries(byStatus).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s, n]) => `
    <div class="si"><span class="sn">${s}</span>
    <div class="sbw"><div class="sb"><div class="sbf" style="width:${Math.round(n/maxS*100)}%"></div></div></div>
    <span class="sc">${n}</span></div>`).join('');

  const ownerRows = Object.entries(byOwner).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([o, n]) => {
    const ini = o.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    return `<div class="or"><div class="oa">${ini}</div>
    <div class="oi"><div class="on">${o}</div>
    <div class="ob"><div class="obf" style="width:${Math.round(n/maxO*100)}%"></div></div></div>
    <span class="oc">${n}</span></div>`;
  }).join('');

  const tableRows = cases
    .sort((a, b) => {
      // Sort by priority: P0 first, then P1, then P2
      const pOrder = { P0: 0, P1: 1, P2: 2 };
      const pMap = { 'critical': 'P0', 'high': 'P1', 'medium': 'P2', 'low': 'P2' };
      const pa = pOrder[pMap[(a.priority||'').toLowerCase()] || 'P2'];
      const pb = pOrder[pMap[(b.priority||'').toLowerCase()] || 'P2'];
      if (pa !== pb) return pa - pb;
      // Secondary sort: age descending
      return (parseFloat(b.age)||0) - (parseFloat(a.age)||0);
    })
    .map((c) => {
      const age = parseFloat(c.age) || 0;
      const ageClass = age >= 14 ? 'ah' : age >= 7 ? 'am' : 'al';
      const rawP = (c.priority || '').toLowerCase();
      const pMap = { 'critical': 'P0', 'high': 'P1', 'medium': 'P2', 'low': 'P2' };
      const priority = pMap[rawP] || 'P2';
      const priorityClass = priority === 'P0' ? 'be' : priority === 'P1' ? 'bp' : 'bw';
      const priorityLabel = c.priority || '—';
      const s = (c.status || '').toLowerCase();
      const badgeClass = s.includes('new') ? 'bn' : s.includes('open') ? 'bo' : s.includes('wait') ? 'bw' : s.includes('pend') ? 'bp' : s.includes('escal') ? 'be' : 'bd';
      return `<tr data-priority="${priority}">
        <td><span class="badge ${priorityClass}">${priorityLabel}</span></td>
        <td class="cn">${c.caseNumber || '—'}</td>
        <td>${c.accountName || '—'}</td>
        <td class="sub" title="${(c.subject || '').replace(/"/g, '')}">${c.subject || '—'}</td>
        <td><span class="badge ${badgeClass}">${c.status || '—'}</span></td>
        <td class="own">${c.caseOwner || '—'}</td>
        <td class="age ${ageClass}">${c.age ? c.age + 'd' : '—'}</td>
      </tr>`;
    }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>MWGL Case Report — ${ts}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@300;400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0c10;--surface:#111318;--border:#1e2330;--accent:#00d4ff;--warn:#ffcc00;--green:#00e676;--text:#e2e8f0;--muted:#64748b;--p0:#ff4444;--p1:#ff6b35;--p2:#ffcc00;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:"IBM Plex Sans",sans-serif;font-size:14px;min-height:100vh;}
body::before{content:"";position:fixed;inset:0;background-image:linear-gradient(rgba(0,212,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,255,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0;}
.wrap{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:0 24px 60px;}
header{display:flex;align-items:center;justify-content:space-between;padding:28px 0 24px;border-bottom:1px solid var(--border);margin-bottom:32px;}
.brand{display:flex;align-items:center;gap:14px;}.brand-icon{width:40px;height:40px;background:linear-gradient(135deg,var(--accent),#0066ff);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:20px;}
.brand-text h1{font-family:"IBM Plex Mono",monospace;font-size:18px;font-weight:600;letter-spacing:-.5px;}.brand-text p{font-size:11px;color:var(--muted);font-family:"IBM Plex Mono",monospace;letter-spacing:.5px;text-transform:uppercase;margin-top:2px;}
.ts{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--muted);}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:32px;}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;position:relative;overflow:hidden;}
.kpi::after{content:"";position:absolute;bottom:0;left:0;right:0;height:2px;}
.kpi.total::after{background:var(--accent);}.kpi.p0::after{background:var(--p0);}.kpi.p1::after{background:var(--p1);}.kpi.p2::after{background:var(--p2);}.kpi.avg::after{background:var(--green);}
.kpi-label{font-family:"IBM Plex Mono",monospace;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:10px;}
.kpi-value{font-family:"IBM Plex Mono",monospace;font-size:36px;font-weight:600;line-height:1;}
.kpi.total .kpi-value{color:var(--accent);}.kpi.p0 .kpi-value{color:var(--p0);}.kpi.p1 .kpi-value{color:var(--p1);}.kpi.p2 .kpi-value{color:var(--p2);}.kpi.avg .kpi-value{color:var(--green);}
.main-grid{display:grid;grid-template-columns:1fr 300px;gap:20px;margin-bottom:24px;}
@media(max-width:900px){.main-grid{grid-template-columns:1fr;}}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;}
.panel-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border);}
.panel-title{font-family:"IBM Plex Mono",monospace;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}
.panel-count{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--accent);background:rgba(0,212,255,.08);padding:2px 8px;border-radius:4px;}
.toolbar{display:flex;gap:10px;padding:12px 20px;border-bottom:1px solid var(--border);flex-wrap:wrap;}
.search-box{flex:1;min-width:200px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 12px;color:var(--text);font-family:"IBM Plex Mono",monospace;font-size:12px;outline:none;}
.search-box:focus{border-color:var(--accent);}.search-box::placeholder{color:var(--muted);}
.filter-btn{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:7px 12px;color:var(--muted);font-family:"IBM Plex Mono",monospace;font-size:11px;cursor:pointer;transition:all .15s;white-space:nowrap;}
.filter-btn:hover,.filter-btn.active{border-color:var(--accent);color:var(--accent);background:rgba(0,212,255,.06);}
.table-wrap{overflow-x:auto;}table{width:100%;border-collapse:collapse;}
thead th{font-family:"IBM Plex Mono",monospace;font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);padding:10px 16px;text-align:left;border-bottom:1px solid var(--border);background:var(--bg);white-space:nowrap;}
tbody tr{border-bottom:1px solid var(--border);}tbody tr:hover{background:rgba(255,255,255,.02);}tbody tr:last-child{border-bottom:none;}
td{padding:12px 16px;font-size:13px;vertical-align:middle;}
td.cn{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--accent);white-space:nowrap;}td.sub{max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}td.own{color:var(--muted);font-size:12px;white-space:nowrap;}td.age{font-family:"IBM Plex Mono",monospace;font-size:12px;text-align:right;white-space:nowrap;}
.ah{color:var(--p0);}.am{color:var(--p1);}.al{color:var(--green);}
.badge{display:inline-block;padding:3px 8px;border-radius:4px;font-family:"IBM Plex Mono",monospace;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;}
.bn{background:rgba(0,212,255,.12);color:var(--accent);}.bo{background:rgba(0,230,118,.12);color:var(--green);}.bw{background:rgba(255,204,0,.12);color:var(--warn);}.bp{background:rgba(255,107,53,.12);color:var(--p1);}.be{background:rgba(255,68,68,.15);color:var(--p0);}.bd{background:rgba(100,116,139,.15);color:var(--muted);}
.sidebar{display:flex;flex-direction:column;gap:20px;}.sl,.ol{padding:16px 20px;}
.si{display:flex;align-items:center;margin-bottom:12px;}.si:last-child{margin-bottom:0;}
.sbw{flex:1;margin:0 12px;}.sb{height:4px;border-radius:2px;background:var(--border);overflow:hidden;}.sbf{height:100%;border-radius:2px;background:var(--accent);}
.sn{font-size:12px;color:var(--text);white-space:nowrap;min-width:80px;}.sc{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--muted);min-width:24px;text-align:right;}
.or{display:flex;align-items:center;gap:10px;margin-bottom:10px;}.or:last-child{margin-bottom:0;}
.oa{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--accent),#0066ff);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#fff;flex-shrink:0;}
.oi{flex:1;min-width:0;}.on{font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ob{height:3px;border-radius:2px;background:var(--border);margin-top:4px;overflow:hidden;}.obf{height:100%;background:linear-gradient(90deg,var(--accent),#0066ff);border-radius:2px;}
.oc{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--muted);flex-shrink:0;}
footer{border-top:1px solid var(--border);padding:20px 0 0;display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.5px;}
#search-count{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--accent);background:rgba(0,212,255,.08);padding:2px 8px;border-radius:4px;}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="brand">
    <div class="brand-icon">📋</div>
    <div class="brand-text"><h1>MWGL Case Report</h1><p>Midwest / Great Lakes Pod · Salesforce</p></div>
  </div>
  <span class="ts">Generated ${ts} CT</span>
</header>
<div class="kpi-row">
  <div class="kpi total"><div class="kpi-label">Total Cases</div><div class="kpi-value">${summary.totalCases}</div></div>
  <div class="kpi p0"><div class="kpi-label">P0 Critical</div><div class="kpi-value">${summary.byPriority?.P0 || 0}</div></div>
  <div class="kpi p1"><div class="kpi-label">P1 High</div><div class="kpi-value">${summary.byPriority?.P1 || 0}</div></div>
  <div class="kpi p2"><div class="kpi-label">P2 Med/Low</div><div class="kpi-value">${summary.byPriority?.P2 || 0}</div></div>
  <div class="kpi avg"><div class="kpi-label">Avg Age (Days)</div><div class="kpi-value">${avgAge}</div></div>
</div>
<div class="main-grid">
  <div class="panel">
    <div class="panel-header"><span class="panel-title">Open Cases</span><span id="search-count">${cases.length} cases</span></div>
    <div class="toolbar">
      <input class="search-box" id="search" placeholder="Search case #, account, subject..." oninput="filterTable()"/>
      <button class="filter-btn active" onclick="setFilter('all',this)">All</button>
      <button class="filter-btn" onclick="setFilter('P0',this)">P0</button>
      <button class="filter-btn" onclick="setFilter('P1',this)">P1</button>
      <button class="filter-btn" onclick="setFilter('P2',this)">P2</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Priority</th><th>Case #</th><th>Account</th><th>Subject</th><th>Status</th><th>Owner</th><th>Age</th>
        </tr></thead>
        <tbody id="tbody">${tableRows}</tbody>
      </table>
    </div>
  </div>
  <div class="sidebar">
    <div class="panel"><div class="panel-header"><span class="panel-title">By Status</span></div><div class="sl">${statusRows}</div></div>
    <div class="panel"><div class="panel-header"><span class="panel-title">By Owner</span></div><div class="ol">${ownerRows}</div></div>
  </div>
</div>
<footer>
  <span>MWGL CASE REPORT · ${cases.length} OPEN CASES</span>
  <span>${ts} CT</span>
</footer>
</div>
<script>
const ROWS = Array.from(document.getElementById('tbody').querySelectorAll('tr'));
let activeF = 'all';
function setFilter(f, btn) {
  activeF = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  filterTable();
}
function filterTable() {
  const q = document.getElementById('search').value.toLowerCase();
  let count = 0;
  ROWS.forEach(tr => {
    const txt = tr.textContent.toLowerCase();
    const pri = tr.dataset.priority || '';
    const matchF = activeF === 'all' || pri === activeF;
    const matchQ = !q || txt.includes(q);
    const show = matchF && matchQ;
    tr.style.display = show ? '' : 'none';
    if (show) count++;
  });
  document.getElementById('search-count').textContent = count + ' case' + (count !== 1 ? 's' : '');
}
</script>
</body>
</html>`;
}

async function main() {
  try {
    console.log('🚀 Starting MWGL Case Report workflow...');

    const reportData = await downloadReport();
    const rawCases = parseReportData(reportData);
    const allCases = rawCases.map(normalizeCase);
    const filteredCases = filterCases(allCases);
    const summary = generateSummary(filteredCases);

    console.log(`\n📊 Summary:`);
    console.log(`  Total active: ${summary.totalCases}`);
    console.log(`  By priority: ${JSON.stringify(summary.byPriority)}`);
    console.log(`  By status: ${JSON.stringify(summary.byStatus)}`);

    await sendToSlack(filteredCases, summary);

    // Save report.json for GitHub Pages dashboard
    const reportJson = { generatedAt: new Date().toISOString(), summary, cases: filteredCases };
    const dashDir = path.join(__dirname, 'dashboard');
    if (!fs.existsSync(dashDir)) fs.mkdirSync(dashDir);
    fs.writeFileSync(path.join(dashDir, 'report.json'), JSON.stringify(reportJson, null, 2));
    console.log('✅ report.json saved to dashboard/');

    // Generate self-contained HTML report (no server needed — open directly in browser)
    const timestamp = new Date().toISOString().slice(0, 10);
    const htmlPath = path.join(dashDir, `MWGL_Cases_${timestamp}.html`);
    fs.writeFileSync(htmlPath, generateHTML(filteredCases, summary), 'utf8');
    console.log(`✅ HTML report saved: dashboard/MWGL_Cases_${timestamp}.html`);

    // Drive upload is best-effort — don't fail the whole workflow if it errors
    try {
      await uploadToGoogleDrive(filteredCases);
    } catch (driveErr) {
      console.warn(`⚠️  Google Drive upload skipped: ${driveErr.message}`);
    }

    console.log('\n✅ Workflow completed successfully!');
  } catch (err) {
    console.error('❌ Workflow failed:', err.message);
    if (err.response) {
      console.error('  HTTP status:', err.response.status);
      console.error('  Response:', JSON.stringify(err.response.data).slice(0, 500));
    }
    process.exit(1);
  }
}

main();
