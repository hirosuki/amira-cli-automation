const puppeteer = require('puppeteer');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Parser } = require('json2csv');

// Salesforce report ID (extracted from report URL)
const REPORT_ID = '00OUb00000JDJUwMAP';
const SF_BASE_URL = 'https://istation.lightning.force.com';

// Direct CSV export URL — uses classic SF domain, bypasses Lightning UI entirely
const REPORT_EXPORT_URL = `https://istation.my.salesforce.com/${REPORT_ID}?export=1&enc=UTF-8&xf=csv`;

// Priority levels
const ACTIVE_PRIORITIES = ['P0', 'P1', 'P2'];
const EXCLUDED_STATUSES = ['Closed/Complete', 'Closed (Unresolved)'];

// Environment variables
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || '#daily-briefing';
const GOOGLE_DRIVE_FOLDER_ID = '1WfFQTkAqwHd-3bObix-2lwrQzRc5T08u';
const GOOGLE_CREDENTIALS = process.env.GOOGLE_DRIVE_CREDENTIALS ? JSON.parse(process.env.GOOGLE_DRIVE_CREDENTIALS) : null;
const SF_USERNAME = process.env.SF_USERNAME;
const SF_PASSWORD = process.env.SF_PASSWORD;

/**
 * Parse CSV text into array of objects using the header row
 */
function parseCsv(csvText) {
  const lines = csvText.trim().split('\n').filter(line => line.trim());
  if (lines.length < 2) return [];

  // Find the actual header row (skip Salesforce metadata lines at top)
  let headerIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes('status') || lines[i].toLowerCase().includes('case number')) {
      headerIdx = i;
      break;
    }
  }

  const headers = lines[headerIdx].split(',').map(h => h.replace(/"/g, '').trim());
  const rows = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith('"Grand Total"') || line.startsWith('Grand Total')) continue;

    // Handle quoted fields with commas inside
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') {
        inQuotes = !inQuotes;
      } else if (line[c] === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += line[c];
      }
    }
    values.push(current.trim());

    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }

  return rows;
}

/**
 * Normalize raw SF export row into our standard case shape
 */
function normalizeCase(row) {
  // SF export column names can vary — try common variants
  return {
    status: row['Status'] || row['Case Status'] || '',
    accountName: row['Account Name'] || row['Account'] || '',
    accountState: row['Billing State/Province'] || row['State'] || '',
    dateTimeOpened: row['Date/Time Opened'] || row['Opened'] || row['Created Date'] || '',
    caseNumber: row['Case Number'] || row['Number'] || '',
    subject: row['Subject'] || '',
    caseOwner: row['Case Owner'] || row['Owner'] || '',
    age: row['Age'] || row['Days Open'] || '',
  };
}

/**
 * Log in to Salesforce via Puppeteer and return session cookies
 */
async function getSalesforceCookies() {
  console.log('🔐 Launching browser for Salesforce authentication...');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate to the correct Salesforce login domain
    await page.goto('https://istation.my.salesforce.com/login/', { waitUntil: 'networkidle2', timeout: 30000 });
    console.log(`  Login page URL: ${page.url()}`);

    // Fill credentials
    // Dump page state before waiting so we can debug selector issues
    const preWaitUrl = page.url();
    const preWaitTitle = await page.title();
    console.log(`  Pre-selector URL: ${preWaitUrl}`);
    console.log(`  Pre-selector title: ${preWaitTitle}`);

    // Take a screenshot to see what the page looks like in CI
    await page.screenshot({ path: 'login-page.png', fullPage: false });
    console.log('  Screenshot saved: login-page.png');

    // Dump page HTML for selector debugging
    const pageHtml = await page.content();
    const inputMatches = pageHtml.match(/<input[^>]*id="[^"]*"[^>]*>/g) || [];
    console.log(`  Input fields found on page: ${inputMatches.length}`);
    inputMatches.forEach(el => console.log(`    ${el.slice(0, 120)}`));

    await page.waitForSelector('#username', { timeout: 15000 });
    await page.type('#username', SF_USERNAME);
    await page.type('#password', SF_PASSWORD);
    await page.click('#Login');

    // Wait for redirect away from login
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
    const postLoginUrl = page.url();
    console.log(`  Post-login URL: ${postLoginUrl}`);

    if (postLoginUrl.includes('login')) {
      throw new Error('Login failed — still on login page after submit. Check SF_USERNAME / SF_PASSWORD secrets.');
    }

    // Grab all cookies for this domain
    const cookies = await page.cookies();
    console.log(`✅ Authenticated. Got ${cookies.length} cookies.`);
    return { browser, cookies };

  } catch (err) {
    await browser.close();
    throw err;
  }
}

/**
 * Download the report as CSV using session cookies (no UI wait)
 */
async function downloadReportCsv(cookies) {
  console.log('📥 Downloading report CSV export...');

  // Convert Puppeteer cookies to cookie header string
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  const response = await axios.get(REPORT_EXPORT_URL, {
    headers: {
      Cookie: cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    maxRedirects: 5,
    timeout: 30000,
  });

  const contentType = response.headers['content-type'] || '';
  console.log(`  Response status: ${response.status} | Content-Type: ${contentType}`);

  if (response.status !== 200) {
    throw new Error(`CSV export returned HTTP ${response.status}`);
  }

  // If we got HTML back instead of CSV, we're probably on a login/error page
  if (contentType.includes('html') || String(response.data).trim().startsWith('<!DOCTYPE')) {
    throw new Error('CSV export returned HTML instead of CSV — session may have expired or export URL is wrong.');
  }

  console.log(`✅ CSV downloaded (${String(response.data).length} bytes)`);
  return String(response.data);
}

/**
 * Filter cases by priority and status
 */
function filterCases(cases) {
  return cases.filter((caseItem) => {
    const hasPriority = ACTIVE_PRIORITIES.some(p =>
      caseItem.caseNumber?.includes(p) ||
      caseItem.subject?.includes(p) ||
      caseItem.status?.includes(p)
    );

    const isNotClosed = !EXCLUDED_STATUSES.some(status =>
      caseItem.status?.includes(status)
    );

    return hasPriority && isNotClosed;
  });
}

/**
 * Generate summary metrics
 */
function generateSummary(cases) {
  const byPriority = {};
  const byStatus = {};

  cases.forEach(caseItem => {
    ACTIVE_PRIORITIES.forEach(p => {
      if (caseItem.caseNumber?.includes(p) || caseItem.status?.includes(p) || caseItem.subject?.includes(p)) {
        byPriority[p] = (byPriority[p] || 0) + 1;
      }
    });

    const status = caseItem.status || 'Unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
  });

  return {
    totalCases: cases.length,
    byPriority,
    byStatus,
    asOf: new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }),
  };
}

/**
 * Format and send summary to Slack
 */
async function sendToSlack(cases, summary) {
  console.log('📤 Sending summary to Slack...');

  const priorityRows = ACTIVE_PRIORITIES
    .filter(p => summary.byPriority[p])
    .map(p => `${p}: ${summary.byPriority[p]}`)
    .join(' | ') || 'None';

  const statusRows = Object.entries(summary.byStatus)
    .map(([status, count]) => `• ${status}: ${count}`)
    .join('\n') || 'None';

  const message = {
    channel: SLACK_CHANNEL,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📋 MWGL Case Report' },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Total Active Cases:*\n${summary.totalCases}` },
          { type: 'mrkdwn', text: `*By Priority:*\n${priorityRows}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*By Status:*\n${statusRows}` },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Last Updated:* ${summary.asOf}\nCSV exported to Google Drive.` },
      },
    ],
  };

  const resp = await axios.post('https://slack.com/api/chat.postMessage', message, {
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!resp.data.ok) {
    throw new Error(`Slack API error: ${resp.data.error}`);
  }
  console.log('✅ Message sent to Slack');
}

/**
 * Upload CSV to Google Drive
 */
async function uploadToGoogleDrive(csvText) {
  console.log('☁️  Uploading CSV to Google Drive...');

  if (!GOOGLE_CREDENTIALS) {
    console.warn('⚠️  Google credentials not configured. Skipping Google Drive upload.');
    return;
  }

  const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  const drive = google.drive({ version: 'v3', auth });

  const timestamp = new Date().toISOString().slice(0, 10);
  const fileName = `MWGL_Cases_${timestamp}.csv`;

  const { Readable } = require('stream');
  const stream = Readable.from([csvText]);

  const response = await drive.files.create({
    requestBody: { name: fileName, parents: [GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType: 'text/csv', body: stream },
  });

  console.log(`✅ CSV uploaded: ${response.data.name} (ID: ${response.data.id})`);
}

/**
 * Main execution
 */
async function main() {
  let browser;

  try {
    console.log('🚀 Starting MWGL Case Report workflow...');

    // Step 1: Authenticate via browser and grab session cookies
    const { browser: b, cookies } = await getSalesforceCookies();
    browser = b;

    // Step 2: Download report as CSV directly (no grid, no UI wait)
    const csvText = await downloadReportCsv(cookies);

    // Step 3: Parse + normalize
    const rawRows = parseCsv(csvText);
    console.log(`  Parsed ${rawRows.length} raw rows from CSV`);

    // Debug: log headers from first row to verify column mapping
    if (rawRows.length > 0) {
      console.log(`  CSV columns: ${Object.keys(rawRows[0]).join(', ')}`);
    }

    const allCases = rawRows.map(normalizeCase);
    const filteredCases = filterCases(allCases);
    const summary = generateSummary(filteredCases);

    console.log(`\n📊 Summary:`);
    console.log(`  Total active cases: ${summary.totalCases}`);
    console.log(`  By priority: ${JSON.stringify(summary.byPriority)}`);
    console.log(`  By status: ${JSON.stringify(summary.byStatus)}`);

    // Step 4: Send to Slack
    await sendToSlack(filteredCases, summary);

    // Step 5: Upload raw CSV to Google Drive
    await uploadToGoogleDrive(csvText);

    console.log('\n✅ Workflow completed successfully!');
  } catch (error) {
    console.error('❌ Workflow failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main();
