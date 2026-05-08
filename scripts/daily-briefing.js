#!/usr/bin/env node

/**
 * Daily Briefing Script - UPDATED VERSION
 * Pulls Gmail unread count and subjects, calendar events
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
    const credentials = JSON.parse(credentialsJson);
    if (credentials.type === 'service_account') {
      return new google.auth.GoogleAuth({
        credentials,
        scopes: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/calendar.readonly',
        ],
      });
    } else if (credentials.installed) {
      const client = new google.auth.OAuth2(
        credentials.installed.client_id,
        credentials.installed.client_secret,
        credentials.installed.redirect_uris[0]
      );
      return client;
    } else {
      throw new Error('Invalid credentials format');
    }
  } catch (error) {
    console.error('❌ Error loading Google credentials:', error.message);
    process.exit(1);
  }
}

/**
 * Get unread emails since yesterday
 */
async function getUnreadEmails(auth) {
  try {
    const gmail = google.gmail({ version: 'v1', auth });
    const yesterday = moment().subtract(1, 'day').format('YYYY/MM/DD');
    const query = `is:unread after:${yesterday}`;
    
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 10,
    });
    
    const messages = res.data.messages || [];
    const emailList = [];
    
    for (const message of messages) {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From'],
      });
      
      const headers = msg.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const from = headers.find(h => h.name === 'From')?.value || '(unknown)';
      
      emailList.push({
        id: message.id,
        from,
        subject,
      });
    }
    
    return {
      count: messages.length,
      emails: emailList,
    };
  } catch (error) {
    console.error('❌ Error fetching unread emails:', error.message);
    return { count: 0, emails: [] };
  }
}

/**
 * Get today's calendar events
 */
async function getTodaysEvents(auth) {
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const startOfDay = moment().startOf('day').toISOString();
    const endOfDay = moment().endOf('day').toISOString();
    
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay,
      timeMax: endOfDay,
      singleEvents: true,
      orderBy: 'startTime',
    });
    
    const events = res.data.items || [];
    const eventList = events.map(event => ({
      summary: event.summary,
      start: event.start.dateTime || event.start.date,
      end: event.end.dateTime || event.end.date,
    }));
    
    return eventList;
  } catch (error) {
    console.error('❌ Error fetching calendar events:', error.message);
    return [];
  }
}

/**
 * Post briefing to Slack webhook
 */
async function postToSlack(briefing) {
  try {
    const webhookUrl = process.env.SLACK_WEBHOOK;
    if (!webhookUrl) {
      console.log('⚠️  Slack webhook not configured');
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
              text: `*Unread Emails:*\n${briefing.unreadEmails.count} unread since yesterday`,
            },
            {
              type: 'mrkdwn',
              text: `*Generated:*\n${briefing.timestamp}`,
            },
          ],
        },
      ],
    };
    
    if (briefing.unreadEmails.count > 0) {
      let emailText = '*Recent Unread:*\n';
      briefing.unreadEmails.emails.slice(0, 3).forEach((email, i) => {
        emailText += `${i + 1}. ${email.subject}\n`;
      });
      message.blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: emailText,
        },
      });
    }
    
    if (briefing.todaysEvents.length > 0) {
      let eventsText = '*Today\'s Events:*\n';
      briefing.todaysEvents.forEach((event, i) => {
        const startTime = moment(event.start).format('h:mm A');
        eventsText += `${i + 1}. ${event.summary} @ ${startTime}\n`;
      });
      message.blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: eventsText,
        },
      });
    }
    
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    
    if (!response.ok) {
      console.error('❌ Failed to post to Slack:', response.statusText);
    } else {
      console.log('✅ Posted to Slack successfully');
    }
  } catch (error) {
    console.error('❌ Error posting to Slack:', error.message);
  }
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('🚀 Starting Daily Briefing...');
    
    const auth = getGoogleAuth();
    const [unreadEmails, todaysEvents] = await Promise.all([
      getUnreadEmails(auth),
      getTodaysEvents(auth),
    ]);
    
    const briefing = {
      timestamp: moment().format('YYYY-MM-DD HH:mm:ss'),
      unreadEmails,
      todaysEvents,
    };
    
    const reportPath = path.join(CONFIG.reportDir, CONFIG.reportFile);
    fs.writeFileSync(reportPath, JSON.stringify(briefing, null, 2));
    console.log(`✅ Report saved to ${reportPath}`);
    
    await postToSlack(briefing);
    console.log('✅ Daily Briefing complete!');
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  }
}

main();
