const { google } = require('googleapis');
const axios = require('axios');
const { Parser } = require('json2csv');

// Salesforce config
const REPORT_ID = '00OUb00000JDJUwMAP';
const SF_LOGIN_URL = 'https://istation.my.salesforce.com';

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
const SF_USERNAME = process.env.SF_USERNAME;
const SF_PASSWORD = process.env.SF_PASSWORD;
const SF_SECURITY_TOKEN = process.env.SF_SECURITY_TOKEN || '';

/**
 * Authenticate with Salesforce REST API (no browser needed)
 * Returns { accessToken, instanceUrl }
 */
async function sfLogin() {
  console.log('🔐 Authenticating with Salesforce REST API...');

  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: '3MVG9pe2TCmdlRSjk4OJRFenTAyKjuqV_PXAlKQ5hFAtcDPJjkgHDr2b3OyxjkYCbMjXlJXvkNblWi2KJhYze',
    client_secret: '6E7A3F2C7E9A1B4D8F2E5C9A3B7E1D4F6A2C8E5B9D3F7A1C4E8B2D6F9A3C7E',
    username: SF_USERNAME,
    password: SF_PASSWORD + SF_SECURITY_TOKEN,
  });

  try {
    const resp = await axios.post(
      `${SF_LOGIN_URL}/services/oauth2/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    console.log(`✅ SF login successful. Instance: ${resp.data.instance_url}`);
    return { accessToken: resp.data.access_token, instanceUrl: resp.data.instance_url };
  } catch (err) {
    const detail = err.response?.data || err.message;
    throw new Error(`SF OAuth failed: ${JSON.stringify(detail)}`);
  }
}

/**
 * Download report as CSV using SF Analytics REST API
 */
async function downloadReportCsv(accessToken, instanceUrl) {
  console.log('📥 Downloading report via SF Analytics API...');

  const url = `${instanceUrl}/services/data/v59.0/analytics/reports/${REPORT_ID}?includeDetails=true`;

  const resp = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  console.log(`✅ Report data received. Processing...`);
  return resp.data;
}

/**
 * Convert SF Analytics API JSON report into flat case objects
 */
function parseReportData(reportData) {
  const cases = [];

  try {
    const factMap = reportData.factMap || {};
    const columns = reportData.reportMetadata?.detailColumns || [];
    const columnInfo = reportData.reportExtendedMetadata?.detailColumnInfo || {};

    // Get column label mapping
    const colLabels = {};
    columns.forEach(col => {
      colLabels[col] = columnInfo[col]?.label || col;
    });

    console.log(`  Report columns: ${columns.map(c => colLabels[c]).join(', ')}`);

    // Extract rows from factMap (T!T = grand total rows key pattern)
    Object.entries(factMap).forEach(([key, value]) => {
      if (!value.rows) return;
      value.rows.forEach(row => {
        const caseObj = {};
        row.dataCells.forEach((cell, idx) => {
          const colName = colLabels[columns[idx]] || columns[idx];
          caseObj[colName] = cell.label || cell.value || '';
        });
        cases.push(caseObj);
      });
    });

    console.log(`  Extracted ${cases.length} rows from report`);
  } catch (e) {
    console.error('  Error parsing report JSON:', e.message);
    throw e;
  }

  return cases;
}

/**
 * Normalize to our standard case shape
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
  };
}

/**
 * Filter active priority cases
 */
function filterCases(cases) {
  return cases.filter(c => {
    const hasPriority = ACTIVE_PRIORITIES.some(p =>
      c.caseNumber?.includes(p) || c.subject?.includes(p) || c.status?.includes(p)
    );
    const isOpen = !EXCLUDED_STATUSES.some(s => c.status?.includes(s));
    return hasPriority && isOpen;
  });
}

/**
 * Generate summary
 */
function generateSummary(cases) {
  const byPriority = {};
  const byStatus = {};

  cases.forEach(c => {
    ACTIVE_PRIORITIES.forEach(p => {
      if (c.caseNumber?.includes(p) || c.subject?.includes(p) || c.status?.includes(p)) {
        byPriority[p] = (byPriority[p] || 0) + 1;
      }
    });
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
 * Send to Slack
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
 * Main
 */
async function main() {
  try {
    console.log('🚀 Starting MWGL Case Report workflow...');

    // Auth via REST API — no browser, no Puppeteer
    const { accessToken, instanceUrl } = await sfLogin();

    // Pull report data
    const reportData = await downloadReportCsv(accessToken, instanceUrl);

    // Parse + normalize
    const rawCases = parseReportData(reportData);
    const allCases = rawCases.map(normalizeCase);
    const filteredCases = filterCases(allCases);
    const summary = generateSummary(filteredCases);

    console.log(`\n📊 Summary:`);
    console.log(`  Total active: ${summary.totalCases}`);
    console.log(`  By priority: ${JSON.stringify(summary.byPriority)}`);
    console.log(`  By status: ${JSON.stringify(summary.byStatus)}`);

    await sendToSlack(filteredCases, summary);
    await uploadToGoogleDrive(filteredCases);

    console.log('\n✅ Workflow completed successfully!');
  } catch (err) {
    console.error('❌ Workflow failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
