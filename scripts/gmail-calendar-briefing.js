const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');

async function main() {
  try {
    console.log('🚀 Starting Gmail & Calendar Briefing...');

    // Parse Google OAuth credentials
    // GOOGLE_CREDENTIALS should be a JSON object with:
    // { client_id, client_secret, refresh_token, redirect_uri }
    const credentialsRaw = process.env.GOOGLE_CREDENTIALS;
    if (!credentialsRaw) throw new Error('GOOGLE_CREDENTIALS env var is not set');

    // Strip any surrounding quotes that may have been added accidentally
    const cleaned = credentialsRaw.trim().replace(/^["']|["']$/g, '');
    const credentials = JSON.parse(cleaned);

    const auth = new google.auth.OAuth2(
      credentials.client_id,
      credentials.client_secret,
      credentials.redirect_uri || 'urn:ietf:wg:oauth:2.0:oob'
    );
    auth.setCredentials({
      refresh_token: credentials.refresh_token,
      access_token: credentials.access_token,
    });

    const gmail = google.gmail({ version: 'v1', auth });
    const calendar = google.calendar({ version: 'v3', auth });

    const briefing = {
      timestamp: new Date().toISOString(),
      gmail: {},
      calendar: {},
      slack: {},
    };

    // Get unread emails since yesterday
    console.log('📧 Fetching unread emails...');
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const afterTimestamp = Math.floor(yesterday.getTime() / 1000);

    const gmailRes = await gmail.users.messages.list({
      userId: 'me',
      q: `is:unread after:${afterTimestamp}`,
      maxResults: 20,
    });

    const messages = gmailRes.data.messages || [];
    briefing.gmail.unreadCount = gmailRes.data.resultSizeEstimate || messages.length;
    briefing.gmail.subjects = [];

    for (const msg of messages.slice(0, 5)) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From'],
      });
      const headers = detail.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const from = headers.find(h => h.name === 'From')?.value || '';
      briefing.gmail.subjects.push({ subject, from });
    }

    // Get today's calendar events
    console.log('📅 Fetching calendar events...');
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

    const calRes = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    briefing.calendar.events = (calRes.data.items || []).map(e => ({
      summary: e.summary || '(no title)',
      start: e.start?.dateTime || e.start?.date || '',
      end: e.end?.dateTime || e.end?.date || '',
    }));

    // Get Slack mentions
    console.log('💬 Checking Slack mentions...');
    try {
      const slackToken = process.env.SLACK_BOT_TOKEN;
      const userId = process.env.SLACK_USER_ID;

      const searchRes = await axios.get('https://slack.com/api/search.messages', {
        headers: { Authorization: `Bearer ${slackToken}` },
        params: {
          query: `<@${userId}>`,
          count: 10,
          sort: 'timestamp',
        },
      });

      if (searchRes.data.ok) {
        briefing.slack.mentionCount = searchRes.data.messages?.total || 0;
        briefing.slack.mentions = (searchRes.data.messages?.matches || []).slice(0, 5).map(m => ({
          channel: m.channel?.name || m.channel?.id || 'unknown',
          text: m.text?.substring(0, 100) || '',
          user: m.username || m.user || 'unknown',
        }));
      } else {
        briefing.slack.mentionCount = 0;
        briefing.slack.mentions = [];
        briefing.slack.error = searchRes.data.error;
      }
    } catch (slackErr) {
      briefing.slack.error = slackErr.message;
      briefing.slack.mentionCount = 0;
      briefing.slack.mentions = [];
    }

    // Build Slack message
    const lines = [];
    lines.push('*📬 Daily Briefing — ' + new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + '*');
    lines.push('');

    lines.push('*📧 Gmail — Unread since yesterday:* ' + (briefing.gmail.unreadCount || 0));
    if (briefing.gmail.subjects.length > 0) {
      briefing.gmail.subjects.forEach(m => {
        lines.push('  • ' + m.subject.substring(0, 60) + (m.from ? ' — _' + m.from.substring(0, 40) + '_' : ''));
      });
    } else {
      lines.push('  _No unread emails_');
    }
    lines.push('');

    lines.push('*📅 Calendar — Today\'s Events:*');
    if (briefing.calendar.events.length > 0) {
      briefing.calendar.events.forEach(e => {
        const start = e.start ? new Date(e.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '';
        lines.push('  • ' + (start ? start + ' — ' : '') + e.summary);
      });
    } else {
      lines.push('  _No events today_');
    }
    lines.push('');

    lines.push('*💬 Slack Mentions:* ' + (briefing.slack.mentionCount || 0));
    if (briefing.slack.mentions && briefing.slack.mentions.length > 0) {
      briefing.slack.mentions.forEach(m => {
        lines.push('  • #' + m.channel + ': ' + m.text.substring(0, 80));
      });
    } else if (briefing.slack.error) {
      lines.push('  _Could not fetch mentions: ' + briefing.slack.error + '_');
    } else {
      lines.push('  _No mentions_');
    }

    const slackMessage = lines.join('\n');
    console.log('\n--- Briefing Preview ---');
    console.log(slackMessage);
    console.log('------------------------\n');

    // Post to Slack
    const webhookUrl = process.env.SLACK_WEBHOOK;
    if (webhookUrl) {
      const webhookRes = await axios.post(webhookUrl, { text: slackMessage });
      console.log('✅ Posted to Slack #daily-briefing:', webhookRes.status);
    } else {
      console.log('⚠️ No SLACK_WEBHOOK set — skipping Slack post');
    }

    // Save briefing report
    const reportPath = 'briefing-report.json';
    fs.writeFileSync(reportPath, JSON.stringify(briefing, null, 2));
    console.log('✅ Saved briefing report to', reportPath);

    console.log('✅ Done!');
  } catch (err) {
    console.error('❌ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
