#!/usr/bin/env node

/**
 * Daily Briefing Script
 * Pulls Gmail unread count, Calendar events, and Salesforce cases
 * Generates JSON report and posts to Slack
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const moment = require('moment');

// Configuration
const CONFIG = {
  reportDir: './reports',
  reportFile: 'briefing.json',
};

// Ensure reports directory exists
if (!fs.existsSync(CONFIG.reportDir)) {
  fs.mkdirSync(CONFIG.reportDir, { recursive: true });
}

/**
 * Load Google OAuth credentials from environment
 */
function getGoogleAuth() {
  try {
    const credentialsJson = process.env.GOOGLE_CREDENTIALS;
    if (!credentialsJson) {
      throw new Error('GOOGLE_CREDENTIALS environment variable not set');
    }

    const credentials = JSON.parse(credentialsJson);
    
    // Handle both service account and OAuth credentials
    if (credentials.type === 'service_account') {
      return new google.auth.GoogleAuth({
        credentials,
        scopes: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/calendar.readonly',
        ],
      });
    } else if (credentials.installed) {
      // OAuth credentials
      const { client_id, client_secret, redirect_uris } = credentials.installed;
      return new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
    } else {
      throw new Error('Invalid credentials format');
    }
  } catch (error) {
    console.error('❌ Error loading Google credentials:', error.message);
    throw error;
  }
}

/**
 * Get unread email count from Gmail
 */
async function getUnreadEmails(auth) {
  try {
    const gmail = google.gmail({ version: 'v1', auth });
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 1,
    });
    return response.data.resultSizeEstimate || 0;
  } catch (error) {
    console.error('⚠️  Error fetching Gmail data:', error.message);
    return 0;
  }
}

/**
 * Get today's calendar events
 */
async function getTodaysEvents(auth) {
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    return response.data.items || [];
  } catch (error) {
    console.error('⚠️  Error fetching Calendar data:', error.message);
    return [];
  }
}

/**
 * Get open Salesforce cases via REST API
 */
async function getSalesforceData() {
  try {
    const sfUsername = process.env.SF_USERNAME;
    const sfPassword = process.env.SF_PASSWORD;
    const sfSecurityToken = process.env.SF_SECURITY_TOKEN;

    if (!sfUsername || !sfPassword) {
      console.warn('⚠️  Salesforce credentials not configured, skipping SF data');
      return { openCases: 0, casesList: [] };
    }

    // Authenticate with Salesforce
    const authUrl = 'https://login.salesforce.com/services/oauth2/token';
    const authBody = new URLSearchParams({
      grant_type: 'password',
      client_id: process.env.SF_CLIENT_ID || '',
      client_secret: process.env.SF_CLIENT_SECRET || '',
      username: sfUsername,
      password: sfPassword + sfSecurityToken,
    });

    const authResponse = await fetch(authUrl, {
      method: 'POST',
      body: authBody,
    });

    if (!authResponse.ok) {
      console.warn('⚠️  Salesforce authentication failed');
      return { openCases: 0, casesList: [] };
    }

    const { access_token } = await authResponse.json();

    // Query open cases
    const instanceUrl = process.env.SF_INSTANCE_URL || 'https://amira.my.salesforce.com';
    const query = encodeURIComponent(
      "SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate FROM Case WHERE Status != 'Closed' ORDER BY CreatedDate DESC LIMIT 10"
    );

    const casesResponse = await fetch(
      `${instanceUrl}/services/data/v59.0/query?q=${query}`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    );

    if (!casesResponse.ok) {
      console.warn('⚠️  Failed to query Salesforce cases');
      return { openCases: 0, casesList: [] };
    }

    const { records } = await casesResponse.json();
    return {
      openCases: records.length,
      casesList: records.map((c) => ({
        id: c.Id,
        number: c.CaseNumber,
        subject: c.Subject,
        status: c.Status,
        priority: c.Priority,
        createdDate: c.CreatedDate,
      })),
    };
  } catch (error) {
    console.error('⚠️  Error fetching Salesforce data:', error.message);
    return { openCases: 0, casesList: [] };
  }
}

/**
 * Post briefing to Slack webhook
 */
async function postToSlack(briefing) {
  try {
    const webhookUrl = process.env.SLACK_WEBHOOK;
    if (!webhookUrl) {
      console.log('ℹ️  Slack webhook not configured, skipping Slack post');
      return;
    }

    const message = {
      text: '📋 Daily Briefing',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '📋 Daily Briefing',
          },
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Unread Emails:*\n${briefing.unreadEmails}`,
            },
            {
              type: 'mrkdwn',
              text: `*Today's Events:*\n${briefing.todaysEvents}`,
            },
            {
              type: 'mrkdwn',
              text: `*Open SF Cases:*\n${briefing.openCases}`,
            },
            {
              type: 'mrkdwn',
              text: `*Generated:*\n${briefing.timestamp}`,
            },
          ],
        },
      ],
    };

    if (briefing.eventsList.length > 0) {
      message.blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*📅 Upcoming Events:*\n${briefing.eventsList
            .slice(0, 5)
            .map((e) => `• ${e.title} @ ${moment(e.time).format('h:mm A')}`)
            .join('\n')}`,
        },
      });
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      console.warn('⚠️  Failed to post to Slack');
    } else {
      console.log('✅ Posted briefing to Slack');
    }
  } catch (error) {
    console.error('⚠️  Error posting to Slack:', error.message);
  }
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('🚀 Starting Daily Briefing...');

    // Get Google Auth
    const auth = getGoogleAuth();

    // Fetch data in parallel
    console.log('📧 Fetching Gmail data...');
    console.log('📅 Fetching Calendar data...');
    console.log('🔧 Fetching Salesforce data...');

    const [unreadEmails, events, sfData] = await Promise.all([
      getUnreadEmails(auth),
      getTodaysEvents(auth),
      getSalesforceData(),
    ]);

    // Build briefing report
    const briefing = {
      timestamp: moment().format('MM-DD-YYYY HH:mm:ss'),
      unreadEmails,
      todaysEvents: events.length,
      openCases: sfData.openCases,
      eventsList: events.map((event) => ({
        title: event.summary || '(No title)',
        time: event.start.dateTime || event.start.date,
        duration: event.summary ? '1h' : null,
      })),
      casesList: sfData.casesList,
    };

    // Save report
    const reportPath = path.join(CONFIG.reportDir, CONFIG.reportFile);
    fs.writeFileSync(reportPath, JSON.stringify(briefing, null, 2));
    console.log(`✅ Report saved to ${reportPath}`);

    // Post to Slack
    await postToSlack(briefing);

    // Output summary
    console.log('\n📊 Daily Briefing Summary:');
    console.log(`   Unread Emails: ${briefing.unreadEmails}`);
    console.log(`   Today's Events: ${briefing.todaysEvents}`);
    console.log(`   Open Salesforce Cases: ${briefing.openCases}`);
    console.log(`   Generated: ${briefing.timestamp}\n`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run the script
main();
