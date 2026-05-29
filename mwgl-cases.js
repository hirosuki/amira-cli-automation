const puppeteer = require('puppeteer');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Parser } = require('json2csv');

// Salesforce report URL
const REPORT_URL = 'https://istation.lightning.force.com/lightning/r/Report/00OUb00000JDJUwMAP/view?queryScope=userFolders';

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
* Extract case data from Salesforce report table
*/
async function extractCaseData(page) {
  console.log('Extracting case data from Salesforce report...');

  try {
    // Wait for the report to load - increased timeout and added fallback selector
    await page.waitForSelector('[role="grid"]', { timeout: 60000 });

    // Extra wait for dynamic content to fully render
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Extract table data
    const cases = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[role="row"]'));
      const data = [];

      rows.forEach((row, idx) => {
        if (idx === 0) return; // Skip header row

        const cells = Array.from(row.querySelectorAll('[role="gridcell"]'));
        if (cells.length >= 8) {
          data.push({
            status: cells[0]?.textContent?.trim() || '',
            accountName: cells[1]?.textContent?.trim() || '',
            accountState: cells[2]?.textContent?.trim() || '',
            dateTimeOpened: cells[3]?.textContent?.trim() || '',
            caseNumber: cells[4]?.textContent?.trim() || '',
            subject: cells[5]?.textContent?.trim() || '',
            caseOwner: cells[6]?.textContent?.trim() || '',
            age: cells[7]?.textContent?.trim() || '',
          });
        }
      });

      return data;
    });

    console.log(`Extracted ${cases.length} total cases`);
    return cases;
  } catch (error) {
    console.error('Error extracting case data:', error);
    throw error;
  }
}

/**
* Filter cases by priority and status
*/
function filterCases(cases) {
  return cases.filter((caseItem) => {
    // Extract priority from case number (e.g., "P0-12345" or check status field)
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
    // Count by priority
    ACTIVE_PRIORITIES.forEach(p => {
      if (caseItem.caseNumber?.includes(p) || caseItem.status?.includes(p)) {
        byPriority[p] = (byPriority[p] || 0) + 1;
      }
    });

    // Count by status
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
  console.log('Sending summary to Slack...');

  const priorityRows = Object.entries(summary.byPriority)
    .map(([priority, count]) => `${priority}: ${count}`)
    .join(' | ');

  const statusRows = Object.entries(summary.byStatus)
    .map(([status, count]) => `${status}: ${count}`)
    .join('\n');

  const message = {
    channel: SLACK_CHANNEL,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '📋 MWGL Case Report',
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Total Active Cases:*\n${summary.totalCases}`,
          },
          {
            type: 'mrkdwn',
            text: `*By Priority:*\n${priorityRows}`,
          },
          {
            type: 'mrkdwn',
            text: `*By Status:*\n${statusRows}`,
          },
          {
            type: 'mrkdwn',
            text: `*Last Updated:*\n${summary.asOf}`,
          },
        ],
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Case Details:*\nCSV exported to Google Drive. Click below for full report.`,
        },
      },
    ],
  };

  try {
    await axios.post('https://slack.com/api/chat.postMessage', message, {
      headers: {
        Authorization: `Bearer ${SLACK_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    console.log('✅ Message sent to Slack');
  } catch (error) {
    console.error('Error sending to Slack:', error);
    throw error;
  }
}

/**
* Upload CSV to Google Drive
*/
async function uploadToGoogleDrive(cases) {
  console.log('Uploading CSV to Google Drive...');

  if (!GOOGLE_CREDENTIALS) {
    console.warn('⚠️ Google credentials not configured. Skipping Google Drive upload.');
    return;
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: GOOGLE_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    const drive = google.drive({ version: 'v3', auth });

    // Convert cases to CSV
    const parser = new Parser();
    const csv = parser.parse(cases);

    const timestamp = new Date().toISOString().slice(0, 10);
    const fileName = `MWGL_Cases_${timestamp}.csv`;

    // Create file in Google Drive
    const fileMetadata = {
      name: fileName,
      parents: [GOOGLE_DRIVE_FOLDER_ID],
    };

    const response = await drive.files.create(
      {
        resource: fileMetadata,
        media: {
          mimeType: 'text/csv',
          body: csv,
        },
      },
      { maxContentLength: Infinity }
    );

    console.log(`✅ CSV uploaded to Google Drive: ${response.data.name} (ID: ${response.data.id})`);
  } catch (error) {
    console.error('Error uploading to Google Drive:', error);
    throw error;
  }
}

/**
* Main execution
*/
async function main() {
  let browser;

  try {
    console.log('🚀 Starting MWGL Case Report workflow...');

    // Launch browser
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();

    // Set viewport for stability
    await page.setViewport({ width: 1280, height: 720 });

    // Navigate to Salesforce login page first
    console.log('🔐 Navigating to Salesforce login...');
    await page.goto('https://istation.lightning.force.com', { waitUntil: 'networkidle2', timeout: 30000 });

    // Perform login if login page is shown
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('salesforce.com/') && !currentUrl.includes('lightning')) {
      console.log('🔐 Login page detected. Authenticating...');
      await page.waitForSelector('#username', { timeout: 15000 });
      await page.type('#username', SF_USERNAME);
      await page.type('#password', SF_PASSWORD);
      await page.click('#Login');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
      console.log('✅ Login successful');
    } else {
      console.log('✅ Already authenticated or redirected');
    }

    // Now navigate to the report
    console.log('📍 Navigating to Salesforce report...');
    await page.goto(REPORT_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // If redirected to login again after navigating to report, re-authenticate
    const reportUrl = page.url();
    if (reportUrl.includes('login')) {
      console.log('🔐 Re-authentication required after report navigation...');
      await page.waitForSelector('#username', { timeout: 15000 });
      await page.type('#username', SF_USERNAME);
      await page.type('#password', SF_PASSWORD);
      await page.click('#Login');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 });
      await page.goto(REPORT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    }

    // Extract data
    const allCases = await extractCaseData(page);
    const filteredCases = filterCases(allCases);
    const summary = generateSummary(filteredCases);

    console.log(`\n📊 Summary:`);
    console.log(`  Total cases: ${summary.totalCases}`);
    console.log(`  By priority: ${JSON.stringify(summary.byPriority)}`);
    console.log(`  By status: ${JSON.stringify(summary.byStatus)}`);

    // Send to Slack
    await sendToSlack(filteredCases, summary);

    // Upload to Google Drive
    await uploadToGoogleDrive(filteredCases);

    console.log('\n✅ Workflow completed successfully!');
  } catch (error) {
    console.error('❌ Workflow failed:', error);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main();
