#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const moment = require('moment');

const CONFIG_FILE = path.join(process.env.HOME, '.amira-cli-config.json');
const CREDENTIALS_FILE = path.join(process.env.HOME, '.amira-cli-credentials.json');
const TOKENS_FILE = path.join(process.env.HOME, '.amira-cli-tokens.json');

let config = {};

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } else {
    config = {
      outputDir: '/mnt/c/Users/Calvin Xu/Desktop/Claude/Outputs',
      amiraAdminUrl: 'https://secure.app.amiralearning.com',
      amiraSqlUrl: 'https://secure.app.amiralearning.com/Setup/Sql',
      salesforceUrl: 'https://istation.lightning.force.com'
    };
  }
}

async function getGoogleAuth() {
  try {
    const credFile = require(CREDENTIALS_FILE);
    const { client_id, client_secret, redirect_uris } = credFile.installed;
    const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync(TOKENS_FILE)) {
      const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
      auth.setCredentials(tokens);
      return auth;
    }

    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.readonly'
    ];

    const authUrl = auth.generateAuthUrl({
      access_type: 'offline',
      scope: scopes
    });

    console.log('\n🔐 OAuth Authorization Required');
    console.log('Open this URL in your browser:');
    console.log(authUrl);
    console.log('\nAfter authorizing, paste the code below:');

    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve, reject) => {
      rl.question('Authorization code: ', async (code) => {
        rl.close();
        try {
          const { tokens } = await auth.getToken(code);
          auth.setCredentials(tokens);
          fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens));
          console.log('✅ OAuth token saved');
          resolve(auth);
        } catch (err) {
          reject(err);
        }
      });
    });
  } catch (err) {
    console.error('❌ OAuth error:', err.message);
    throw err;
  }
}

async function dailyBriefing() {
  console.log('📧 Fetching daily briefing...\n');

  try {
    const auth = await getGoogleAuth();
    const gmail = google.gmail({ version: 'v1', auth });
    const calendar = google.calendar({ version: 'v3', auth });

    console.log('📬 Fetching unread emails...');
    const emailRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 10
    });

    const emailCount = emailRes.data.resultSizeEstimate || 0;

    console.log('📅 Fetching calendar events...');
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const eventsRes = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: tomorrow.toISOString(),
      maxResults: 10
    });

    const events = eventsRes.data.items || [];

    const briefing = {
      timestamp: moment().format('MM-DD-YYYY HH:mm:ss'),
      unreadEmails: emailCount,
      todaysEvents: events.length,
      eventsList: events.map(e => ({
        title: e.summary,
        time: e.start?.dateTime || e.start?.date
      }))
    };

    console.log('\n✅ Daily briefing complete\n');
    console.log(JSON.stringify(briefing, null, 2));

    const filename = path.join(config.outputDir, `daily-briefing-${moment().format('MM-DD-YYYY')}.json`);
    fs.writeFileSync(filename, JSON.stringify(briefing, null, 2));
    console.log(`\n💾 Saved to ${filename}`);

    return briefing;
  } catch (err) {
    console.error('❌ Daily briefing error:', err.message);
    throw err;
  }
}

async function campusUsageExport(districtId) {
  console.log(`📊 Campus usage export for district ${districtId}`);
  console.log('\n⚠️  This requires direct database setup.');
}

async function assessmentCompletion(districtId) {
  console.log(`📈 Assessment completion for district ${districtId}`);
  console.log('\n⚠️  This requires direct database setup.');
}

async function listDistricts() {
  console.log('📋 Districts - requires database setup');
}

async function main() {
  loadConfig();
  const command = process.argv[2];

  try {
    switch (command) {
      case 'daily-briefing':
        await dailyBriefing();
        break;
      case 'campus-usage':
        const districtId = process.argv[3];
        if (!districtId) {
          console.error('❌ Usage: campus-usage <district-id>');
          process.exit(1);
        }
        await campusUsageExport(districtId);
        break;
      case 'assessment-completion':
        const districtId2 = process.argv[3];
        if (!districtId2) {
          console.error('❌ Usage: assessment-completion <district-id>');
          process.exit(1);
        }
        await assessmentCompletion(districtId2);
        break;
      case 'list-districts':
        await listDistricts();
        break;
      default:
        console.log(`\n📋 Amira CLI - Available Commands:\n  node index.js daily-briefing\n  node index.js campus-usage <district-id>\n  node index.js assessment-completion <district-id>\n  node index.js list-districts\n        `);
    }
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}

main();
