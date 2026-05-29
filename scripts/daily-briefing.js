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
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*✉️ Unread Emails (${emailCount}):*` },
      });
      
      // Add each email as a separate block for better readability
      briefing.unreadEmails.emails.slice(0, 5).forEach((email, i) => {
        blocks.push({
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*${i + 1}. ${email.subject}*\n_${email.from}_`,
            },
          ],
        });
      });
      
      if (emailCount > 5) {
        blocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `_+ ${emailCount - 5} more email${emailCount - 5 === 1 ? '' : 's'}_`,
            },
          ],
        });
      }
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
        // Check if it's an all-day event (no time component)
        const isAllDay = event.start.length === 10; // YYYY-MM-DD format
        
        let timeStr;
        if (isAllDay) {
          timeStr = 'All day';
        } else {
          // Parse ISO 8601 datetime with timezone info
          // Format: 2024-05-17T16:00:00-05:00
          const startMatch = event.start.match(/(\d{2}):(\d{2}):(\d{2})([-+]\d{2}:\d{2})/);
          const endMatch = event.end.match(/(\d{2}):(\d{2}):(\d{2})([-+]\d{2}:\d{2})/);
          
          if (startMatch && endMatch) {
            const startHour = parseInt(startMatch[1], 10);
            const startMin = startMatch[2];
            const endHour = parseInt(endMatch[1], 10);
            const endMin = endMatch[2];
            
            const startMoment = moment(`${startHour}:${startMin}`, 'HH:mm');
            const endMoment = moment(`${endHour}:${endMin}`, 'HH:mm');
            
            timeStr = `${startMoment.format('h:mm A')}–${endMoment.format('h:mm A')}`;
          } else {
            // Fallback: just parse as-is
            const startTime = moment(event.start).format('h:mm A');
            const endTime = moment(event.end).format('h:mm A');
            timeStr = `${startTime}–${endTime}`;
          }
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
 * Generate self-contained HTML briefing report
 */
function generateHTML(briefing) {
  const ts = briefing.timestamp;
  const emails = briefing.unreadEmails.emails || [];
  const events = briefing.todaysEvents || [];
  const mentions = briefing.slackMentions.mentions || [];

  const emailRows = emails.length
    ? emails.map(e => `
      <tr>
        <td class="sub" title="${e.subject.replace(/"/g,'')}">${e.subject}</td>
        <td class="muted">${e.from.replace(/<.*>/,'').trim()}</td>
      </tr>`).join('')
    : `<tr><td colspan="2" class="empty">No unread emails</td></tr>`;

  const eventRows = events.length
    ? events.map(e => {
        const isAllDay = e.start.length === 10;
        let timeStr = 'All day';
        if (!isAllDay) {
          const fmt = t => {
            const m = t.match(/T(\d{2}):(\d{2})/);
            if (!m) return t;
            let h = parseInt(m[1]), min = m[2];
            const ampm = h >= 12 ? 'PM' : 'AM';
            h = h % 12 || 12;
            return `${h}:${min} ${ampm}`;
          };
          timeStr = `${fmt(e.start)} – ${fmt(e.end)}`;
        }
        return `<tr>
          <td class="accent">${timeStr}</td>
          <td>${e.summary}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="2" class="empty">No events today</td></tr>`;

  const mentionRows = mentions.length
    ? mentions.map(m => `
      <tr>
        <td class="accent">#${m.channel}</td>
        <td class="muted">${m.ts}</td>
        <td class="sub">${m.text}</td>
      </tr>`).join('')
    : `<tr><td colspan="3" class="empty">No mentions</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Daily Briefing — ${ts}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@300;400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0c10;--surface:#111318;--border:#1e2330;--accent:#00d4ff;--green:#00e676;--text:#e2e8f0;--muted:#64748b;--warn:#ffcc00;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:"IBM Plex Sans",sans-serif;font-size:14px;min-height:100vh;}
body::before{content:"";position:fixed;inset:0;background-image:linear-gradient(rgba(0,212,255,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,255,.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0;}
.wrap{position:relative;z-index:1;max-width:1100px;margin:0 auto;padding:0 24px 60px;}
header{display:flex;align-items:center;justify-content:space-between;padding:28px 0 24px;border-bottom:1px solid var(--border);margin-bottom:32px;}
.brand{display:flex;align-items:center;gap:14px;}
.brand-icon{width:40px;height:40px;background:linear-gradient(135deg,var(--accent),#0066ff);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:20px;}
.brand-text h1{font-family:"IBM Plex Mono",monospace;font-size:18px;font-weight:600;letter-spacing:-.5px;}
.brand-text p{font-size:11px;color:var(--muted);font-family:"IBM Plex Mono",monospace;letter-spacing:.5px;text-transform:uppercase;margin-top:2px;}
.ts{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--muted);}
.kpi-row{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:32px;}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;position:relative;overflow:hidden;}
.kpi::after{content:"";position:absolute;bottom:0;left:0;right:0;height:2px;}
.kpi.emails::after{background:var(--accent);}.kpi.events::after{background:var(--green);}.kpi.mentions::after{background:var(--warn);}
.kpi-label{font-family:"IBM Plex Mono",monospace;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:10px;}
.kpi-value{font-family:"IBM Plex Mono",monospace;font-size:36px;font-weight:600;line-height:1;}
.kpi.emails .kpi-value{color:var(--accent);}.kpi.events .kpi-value{color:var(--green);}.kpi.mentions .kpi-value{color:var(--warn);}
.sections{display:flex;flex-direction:column;gap:20px;}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;}
.panel-header{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid var(--border);}
.panel-icon{font-size:16px;}
.panel-title{font-family:"IBM Plex Mono",monospace;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);}
.panel-count{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--accent);background:rgba(0,212,255,.08);padding:2px 8px;border-radius:4px;margin-left:auto;}
table{width:100%;border-collapse:collapse;}
thead th{font-family:"IBM Plex Mono",monospace;font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);padding:10px 16px;text-align:left;border-bottom:1px solid var(--border);background:var(--bg);}
tbody tr{border-bottom:1px solid var(--border);}tbody tr:hover{background:rgba(255,255,255,.02);}tbody tr:last-child{border-bottom:none;}
td{padding:11px 16px;font-size:13px;vertical-align:middle;}
td.accent{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--accent);white-space:nowrap;}
td.muted{color:var(--muted);font-size:12px;}
td.sub{max-width:400px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
td.empty{padding:40px 16px;text-align:center;color:var(--muted);font-family:"IBM Plex Mono",monospace;font-size:12px;}
footer{border-top:1px solid var(--border);padding:20px 0 0;display:flex;justify-content:space-between;color:var(--muted);font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.5px;margin-top:24px;}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="brand">
    <div class="brand-icon">📋</div>
    <div class="brand-text"><h1>Daily Briefing</h1><p>Calvin Xu · Amira Learning</p></div>
  </div>
  <span class="ts">${ts}</span>
</header>
<div class="kpi-row">
  <div class="kpi emails"><div class="kpi-label">✉️ Unread Emails</div><div class="kpi-value">${briefing.unreadEmails.count}</div></div>
  <div class="kpi events"><div class="kpi-label">📅 Today's Events</div><div class="kpi-value">${events.length}</div></div>
  <div class="kpi mentions"><div class="kpi-label">💬 Slack Mentions</div><div class="kpi-value">${briefing.slackMentions.count}</div></div>
</div>
<div class="sections">
  <div class="panel">
    <div class="panel-header"><span class="panel-icon">✉️</span><span class="panel-title">Unread Emails</span><span class="panel-count">${briefing.unreadEmails.count}</span></div>
    <table>
      <thead><tr><th>Subject</th><th>From</th></tr></thead>
      <tbody>${emailRows}</tbody>
    </table>
  </div>
  <div class="panel">
    <div class="panel-header"><span class="panel-icon">📅</span><span class="panel-title">Today's Calendar</span><span class="panel-count">${events.length}</span></div>
    <table>
      <thead><tr><th>Time</th><th>Event</th></tr></thead>
      <tbody>${eventRows}</tbody>
    </table>
  </div>
  <div class="panel">
    <div class="panel-header"><span class="panel-icon">💬</span><span class="panel-title">Slack Mentions</span><span class="panel-count">${briefing.slackMentions.count}</span></div>
    <table>
      <thead><tr><th>Channel</th><th>Time</th><th>Message</th></tr></thead>
      <tbody>${mentionRows}</tbody>
    </table>
  </div>
</div>
<footer>
  <span>DAILY BRIEFING · CALVIN XU · AMIRA LEARNING</span>
  <span>${ts}</span>
</footer>
</div>
</body>
</html>`;
}


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

    // Generate self-contained HTML report
    const dateStr = moment().format('YYYY-MM-DD');
    const htmlPath = path.join(CONFIG.reportDir, `Daily_Briefing_${dateStr}.html`);
    fs.writeFileSync(htmlPath, generateHTML(briefing), 'utf8');
    console.log(`✅ HTML report saved: ${htmlPath}`);

    await postToSlack(briefing);
    console.log('✅ Daily Briefing complete!');
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
  }
}

main();
