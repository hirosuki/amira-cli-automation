#!/usr/bin/env node

/**
 * Daily Briefing Script
 * Pulls Gmail unread emails, Google Calendar events, and Slack mentions
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
 * Load Google OAuth2 credentials from environment.
 * Supports:
 *   - OAuth2 token JSON with refresh_token (recommended for personal Gmail/Calendar)
 *   - Service account JSON with domain-wide delegation + GOOGLE_SUBJECT_EMAIL
 */
function getGoogleAuth() {
  try {
    const credentialsJson = process.env.GOOGLE_CREDENTIALS;
    if (!credentialsJson) throw new Error('GOOGLE_CREDENTIALS env var is not set');
    const credentials = JSON.parse(credentialsJson);

    if (credentials.client_id && credentials.refresh_token) {
      // OAuth2 token - recommended for personal Gmail
      const oauth2Client = new google.auth.OAuth2(
        credentials.client_id,
        credentials.client_secret,
        credentials.redirect_uri || 'urn:ietf:wg:oauth:2.0:oob'
      );
      oauth2Client.setCredentials({
        refresh_token: credentials.refresh_token,
        access_token: credentials.access_token || null,
      });
      return oauth2Client;
    } else if (credentials.type === 'service_account') {
      // Service account - requires domain-wide delegation and GOOGLE_SUBJECT_EMAIL
      const subject = process.env.GOOGLE_SUBJECT_EMAIL;
      if (!subject) {
        throw new Error('Service account requires GOOGLE_SUBJECT_EMAIL for domain-wide delegation. Use an OAuth2 token with refresh_token instead.');
      }
      return new google.auth.GoogleAuth({
        credentials,
        scopes: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/calendar.readonly',
        ],
        clientOptions: { subject },
      });
    } else {
      throw new Error('Unrecognized GOOGLE_CREDENTIALS format. Expected OAuth2 token JSON (with client_id + refresh_token) or service account JSON.');
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
      emailList.push({ id: message.id, from, subject });
    }

    return { count: messages.length, emails: emailList };
  } catch (error) {
    console.error('❌ Error fetching unread emails:', error.message);
    return { count: 0, emails: [], error: error.message };
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
    return events.map(event => ({
      summary: event.summary || '(no title)',
      start: event.start.dateTime || event.start.date,
      end: event.end.dateTime || event.end.date,
    }));
  } catch (error) {
    console.error('❌ Error fetching calendar events:', error.message);
    return [];
  }
}

/**
 * Get Slack mentions since yesterday
 * Requires: SLACK_BOT_TOKEN (xoxb-... or xoxp-...) and SLACK_USER_ID (U...)
 */
async function getSlackMentions() {
  try {
    const token = process.env.SLACK_BOT_TOKEN;
    const userId = process.env.SLACK_USER_ID;

    if (!token) {
      console.log('⚠️  SLACK_BOT_TOKEN not set — skipping Slack mentions');
      return { count: 0, mentions: [], skipped: true };
    }
    if (!userId) {
      console.log('⚠️  SLACK_USER_ID not set — skipping Slack mentions');
      return { count: 0, mentions: [], skipped: true };
    }

    const query = `<@${userId}>`;
    const searchRes = await fetch(
      `https://slack.com/api/search.messages?query=${encodeURIComponent(query)}&count=20&sort=timestamp&sort_dir=desc`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const searchData = await searchRes.json();
    if (!searchData.ok) throw new Error(`Slack API error: ${searchData.error}`);

    const yesterdayTs = moment().subtract(1, 'day').unix();
    const matches = (searchData.messages?.matches || []).filter(
      m => parseFloat(m.ts) >= yesterdayTs
    );

    const mentions = matches.map(m => ({
      text: m.text.replace(/<[^>]+>/g, '').trim().substring(0, 120),
      user: m.username || m.user || 'unknown',
      channel: m.channel?.name || 'unknown',
      ts: moment.unix(parseFloat(m.ts)).format('h:mm A'),
    }));

    return { count: mentions.length, mentions };
  } catch (error) {
    console.error('❌ Error fetching Slack mentions:', error.message);
    return { count: 0, mentions: [], error: error.message };
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

    const emailCount = briefing.unreadEmails.count;
    const eventCount = briefing.todaysEvents.length;
    const mentionCount = briefing.slackMentions.count;

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: '📋 Daily Briefing' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Generated:*\n${briefing.timestamp}` },
          { type: 'mrkdwn', text: `*Summary:*\n✉️ ${emailCount} emails  📅 ${eventCount} events  💬 ${mentionCount} mentions` },
        ],
      },
      { type: 'divider' },
    ];

    // Emails section
    if (briefing.unreadEmails.error) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*✉️ Unread Emails:*\n⚠️ Could not fetch — ${briefing.unreadEmails.error}` },
      });
    } else if (emailCount === 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*✉️ Unread Emails:*\nNo unread emails since yesterday. 🎉' },
      });
    } else {
      let emailText = `*✉️ Unread Emails (${emailCount}):*\n`;
      briefing.unreadEmails.emails.slice(0, 5).forEach((email, i) => {
        emailText += `${i + 1}. *${email.subject}*\n   _From: ${email.from}_\n`;
      });
      if (emailCount > 5) emailText += `_...and ${emailCount - 5} more_\n`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: emailText } });
    }
    blocks.push({ type: 'divider' });

    // Calendar section
    if (eventCount === 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: "*📅 Today's Calendar:*\nNo events scheduled today." },
      });
    } else {
      let eventsText = `*📅 Today's Calendar (${eventCount} events):*\n`;
      briefing.todaysEvents.forEach((event, i) => {
        // Parse ISO datetime strings properly, preserving timezone info
        const start = moment(event.start);
        const end = moment(event.end);
        
        // Check if it's an all-day event (no time component)
        const isAllDay = event.start.length === 10; // YYYY-MM-DD format
        
        let timeStr;
        if (isAllDay) {
          timeStr = 'All day';
        } else {
          // Use utcOffset to preserve the original timezone, then format
          const startTime = start.utcOffset(start.utcOffset()).format('h:mm A');
          const endTime = end.utcOffset(end.utcOffset()).format('h:mm A');
          timeStr = `${startTime}–${endTime}`;
        }
        
        eventsText += `${i + 1}. *${event.summary}* — ${timeStr}\n`;
      });
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: eventsText } });
    }
    blocks.push({ type: 'divider' });

    // Slack mentions section
    if (briefing.slackMentions.skipped) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*💬 Slack Mentions:*\n⚠️ Skipped — set SLACK_BOT_TOKEN and SLACK_USER_ID secrets to enable.' },
      });
    } else if (briefing.slackMentions.error) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*💬 Slack Mentions:*\n⚠️ Could not fetch — ${briefing.slackMentions.error}` },
      });
    } else if (mentionCount === 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*💬 Slack Mentions:*\nNo mentions since yesterday.' },
      });
    } else {
      let mentionsText = `*💬 Slack Mentions (${mentionCount}):*\n`;
      briefing.slackMentions.mentions.slice(0, 5).forEach((m, i) => {
        mentionsText += `${i + 1}. *#${m.channel}* at ${m.ts} by @${m.user}\n   ${m.text}\n`;
      });
      if (mentionCount > 5) mentionsText += `_...and ${mentionCount - 5} more_\n`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: mentionsText } });
    }

    const message = {
      text: `📋 Daily Briefing — ${briefing.timestamp}`,
      blocks,
    };

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

    const [unreadEmails, todaysEvents, slackMentions] = await Promise.all([
      getUnreadEmails(auth),
      getTodaysEvents(auth),
      getSlackMentions(),
    ]);

    const briefing = {
      timestamp: moment().format('YYYY-MM-DD HH:mm:ss'),
      unreadEmails,
      todaysEvents,
      slackMentions,
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
