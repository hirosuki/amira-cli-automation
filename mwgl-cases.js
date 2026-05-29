const { google } = require('googleapis');
const axios = require('axios');
const { Parser } = require('json2csv');

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
 * Generate summary metrics
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
 * Main
 */
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
