#!/usr/bin/env node

/**
 * Daily Briefing v2 - Clean & Tested
 * Fetches Gmail, Google Calendar, and Slack data
 * Posts formatted summary to Slack
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ============================================================================
// CONFIGURATION
// ============================================================================

const REPORT_DIR = path.join(__dirname, '..', 'reports');
const TIMEZONE = 'America/Chicago'; // CST/CDT

// Ensure reports directory exists
if (!fs.existsSync(REPORT_DIR)) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

// ============================================================================
// GOOGLE AUTH
// ============================================================================

function getGoogleAuth() {
  try {
    const credentialsJson = process.env.GOOGLE_CREDENTIALS;
    if (!credentialsJson) {
      throw new Error('GOOGLE_CREDENTIALS environment variable is not set');
    }

    const credentials = JSON.parse(credentialsJson);
    
    // OAuth2 token format
    if (credentials.client_id && credentials.refresh_token) {
      const oauth2Client = new google.auth.OAuth2(
        credentials.client_id,
        credentials.client_secret,
        credentials.redirect_uris?.[0] || 'urn:ietf:wg:oauth:2.0:oob'
      );
      
      oauth2Client.setCredentials({
        refresh_token: credentials.refresh_token,
      });
      
      return oauth2Client;
    }
    
    throw new Error('Invalid GOOGLE_CREDENTIALS format. Expected OAuth2 token with client_id and refresh_token.');
  } catch (error) {
    console.error('❌ Google Auth Error:', error.message);
    throw error;
  }
}

// ============================================================================
// GMAIL: Fetch unread emails since yesterday
// ============================================================================

async function fetchUnreadEmails(auth) {
  try {
    console.log('📧 Fetching unread emails...');
    const gmail = google.gmail({ version: 'v1', auth });
    
    // Calculate yesterday's date
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const afterDate = yesterday.toISOString().split('T')[0].replace(/-/g, '/');
    
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: `is:unread after:${afterDate}`,
      maxResults: 20,
    });
    
    const messages = response.data.messages || [];
    const emailList = [];
    
    // Fetch details for first 10 emails
    for (const message of messages.slice(0, 10)) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });
      
      const headers = detail.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
      
      emailList.push({ subject, from });
    }
    
    console.log(`✅ Found ${messages.length} unread emails`);
    return { count: messages.length, emails: emailList };
  } catch (error) {
    console.error('❌ Gmail Error:', error.message);
    return { count: 0, emails: [], error: error.message };
  }
}

// ============================================================================
// CALENDAR: Fetch today's events
// ============================================================================

async function fetchTodaysEvents(auth) {
  try {
    console.log('📅 Fetching calendar events...');
    const calendar = google.calendar({ version: 'v3', auth });
    
    // Today's date range
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
    
    const events = (response.data.items || []).map(event => {
      const start = event.start?.dateTime || event.start?.date;
      const end = event.end?.dateTime || event.end?.date;
      
      return {
        summary: event.summary || '(no title)',
        start: start ? new Date(start).toLocaleTimeString('en-US', { 
          hour: '2-digit', 
          minute: '2-digit',
          hour12: true 
        }) : 'All day',
        end: end ? new Date(end).toLocaleTimeString('en-US', { 
          hour: '2-digit', 
          minute: '2-digit',
          hour12: true 
        }) : '',
      };
    });
    
    console.log(`✅ Found ${events.length} calendar events`);
    return events;
  } catch (error) {
    console.error('❌ Calendar Error:', error.message);
    return [];
  }
}

// ============================================================================
// SLACK: Fetch mentions and unread messages
// ============================================================================

async function fetchSlackMentions() {
  try {
    const token = process.env.SLACK_BOT_TOKEN;
    const userId = process.env.SLACK_USER_ID;
    
    if (!token || !userId) {
      console.log('⚠️  Slack credentials not set - skipping Slack mentions');
      return { count: 0, mentions: [], skipped: true };
    }
    
    console.log('💬 Fetching Slack mentions...');
    
    // Calculate yesterday's timestamp
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayTs = Math.floor(yesterday.getTime() / 1000);
    
    const query = `<@${userId}>`;
    const url = `https://slack.com/api/search.messages?query=${encodeURIComponent(query)}&count=20&sort=timestamp&sort_dir=desc`;
    
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    const data = await response.json();
    
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error || 'Unknown error'}`);
    }
    
    const matches = (data.messages?.matches || []).filter(
      m => parseFloat(m.ts) >= yesterdayTs
    );
    
    const mentions = matches.map(m => {
      const timestamp = new Date(parseFloat(m.ts) * 1000).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
      
      return {
        text: (m.text || '').replace(/<[^>]+>/g, '').trim().substring(0, 100),
        user: m.username || m.user || 'Unknown',
        channel: m.channel?.name || m.channel?.id || 'Unknown',
        time: timestamp,
      };
    });
    
    console.log(`✅ Found ${mentions.length} Slack mentions`);
    return { count: mentions.length, mentions };
  } catch (error) {
    console.error('❌ Slack Error:', error.message);
    return { count: 0, mentions: [], error: error.message };
  }
}

// ============================================================================
// SLACK: Post formatted briefing
// ============================================================================

async function postToSlack(briefing) {
  try {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    
    if (!webhookUrl) {
      console.log('⚠️  SLACK_WEBHOOK_URL not set - skipping Slack post');
      return;
    }
    
    console.log('📤 Posting to Slack...');
    
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
    
    const blocks = [];
    
    // Header
    blocks.push({
      type: 'header',
      text: {
        type: 'plain_text',
        text: '📋 Daily Briefing',
        emoji: true
      }
    });
    
    // Date and summary
    blocks.push({
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Date:*\n${today}`
        },
        {
          type: 'mrkdwn',
          text: `*Summary:*\n📧 ${briefing.gmail.count} emails  📅 ${briefing.calendar.length} events  💬 ${briefing.slack.count} mentions`
        }
      ]
    });
    
    blocks.push({ type: 'divider' });
    
    // Gmail section
    if (briefing.gmail.error) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*📧 Unread Emails*\n⚠️ Error: ${briefing.gmail.error}`
        }
      });
    } else if (briefing.gmail.count === 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*📧 Unread Emails*\nNo unread emails since yesterday! 🎉'
        }
      });
    } else {
      let emailText = `*📧 Unread Emails (${briefing.gmail.count})*\n`;
      briefing.gmail.emails.slice(0, 5).forEach((email, i) => {
        const fromShort = email.from.length > 40 ? email.from.substring(0, 37) + '...' : email.from;
        emailText += `${i + 1}. *${email.subject}*\n   _From: ${fromShort}_\n`;
      });
      if (briefing.gmail.count > 5) {
        emailText += `\n_...and ${briefing.gmail.count - 5} more_`;
      }
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: emailText }
      });
    }
    
    blocks.push({ type: 'divider' });
    
    // Calendar section
    if (briefing.calendar.length === 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: "*📅 Today's Calendar*\nNo events scheduled for today."
        }
      });
    } else {
      let calendarText = `*📅 Today's Calendar (${briefing.calendar.length} events)*\n`;
      briefing.calendar.forEach((event, i) => {
        const timeRange = event.end ? `${event.start} - ${event.end}` : event.start;
        calendarText += `${i + 1}. *${event.summary}*\n   ${timeRange}\n`;
      });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: calendarText }
      });
    }
    
    blocks.push({ type: 'divider' });
    
    // Slack mentions section
    if (briefing.slack.skipped) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*💬 Slack Mentions*\n_Not configured - add SLACK_BOT_TOKEN and SLACK_USER_ID to enable_'
        }
      });
    } else if (briefing.slack.error) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*💬 Slack Mentions*\n⚠️ Error: ${briefing.slack.error}`
        }
      });
    } else if (briefing.slack.count === 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*💬 Slack Mentions*\nNo mentions since yesterday.'
        }
      });
    } else {
      let slackText = `*💬 Slack Mentions (${briefing.slack.count})*\n`;
      briefing.slack.mentions.slice(0, 5).forEach((mention, i) => {
        slackText += `${i + 1}. *#${mention.channel}* at ${mention.time}\n   @${mention.user}: ${mention.text}\n`;
      });
      if (briefing.slack.count > 5) {
        slackText += `\n_...and ${briefing.slack.count - 5} more_`;
      }
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: slackText }
      });
    }
    
    // Footer
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Generated at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })} CST`
        }
      ]
    });
    
    const payload = {
      text: `📋 Daily Briefing — ${today}`,
      blocks
    };
    
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.statusText}`);
    }
    
    console.log('✅ Posted to Slack successfully');
  } catch (error) {
    console.error('❌ Slack Post Error:', error.message);
  }
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

async function main() {
  try {
    console.log('🚀 Starting Daily Briefing v2...\n');
    
    const startTime = Date.now();
    
    // Authenticate with Google
    const auth = getGoogleAuth();
    
    // Fetch all data in parallel
    const [gmail, calendar, slack] = await Promise.all([
      fetchUnreadEmails(auth),
      fetchTodaysEvents(auth),
      fetchSlackMentions(),
    ]);
    
    // Build briefing object
    const briefing = {
      timestamp: new Date().toISOString(),
      generated_at: new Date().toLocaleString('en-US', { timeZone: TIMEZONE }),
      gmail,
      calendar,
      slack,
    };
    
    // Save report to file
    const reportFilename = `briefing-${new Date().toISOString().split('T')[0]}.json`;
    const reportPath = path.join(REPORT_DIR, reportFilename);
    fs.writeFileSync(reportPath, JSON.stringify(briefing, null, 2));
    console.log(`\n✅ Report saved: ${reportPath}`);
    
    // Post to Slack
    await postToSlack(briefing);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✅ Daily Briefing complete in ${duration}s`);
    
  } catch (error) {
    console.error('\n❌ Fatal Error:', error.message);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  }
}

// Run the script
main();
