#!/usr/bin/env node

/**
 * Google OAuth Setup Script
 * Run this locally to generate a refresh token for GitHub Actions
 */

const { google } = require('googleapis');
const readline = require('readline');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables are required');
  console.error('\nSet them with:');
  console.error('  export GOOGLE_CLIENT_ID="your-client-id"');
  console.error('  export GOOGLE_CLIENT_SECRET="your-client-secret"');
  process.exit(1);
}

const REDIRECT_URL = 'urn:ietf:wg:oauth:2.0:oob';

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URL
);

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  try {
    console.log('\n🔐 Google OAuth Setup for Daily Briefing\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ];

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
    });

    console.log('Step 1️⃣  Visit this URL to authorize Daily Briefing:\n');
    console.log(`📍 ${authUrl}\n`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const openBrowser = await prompt('Open in browser? (y/n): ');
    if (openBrowser.toLowerCase() === 'y') {
      const { spawn } = require('child_process');
      const isWindows = process.platform === 'win32';
      const command = isWindows ? 'start' : 'open';
      spawn(command, [authUrl]);
      console.log('✅ Opening browser...\n');
    }

    const code = await prompt('Step 2️⃣  Paste the authorization code here: ');

    if (!code) {
      console.error('❌ Error: No code provided');
      process.exit(1);
    }

    console.log('\n⏳ Exchanging code for tokens...\n');
    const { tokens } = await oauth2Client.getToken(code);

    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      console.error('❌ Error: No refresh token received');
      console.error('This might happen if:');
      console.error('  - You already authorized this app (revoke access and try again)');
      console.error('  - The authorization code expired (try again)');
      process.exit(1);
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('✅ Success! Here is your refresh token:\n');
    console.log(`🔑 ${refreshToken}\n`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('📋 Next steps:\n');
    console.log('1. Copy the refresh token above (including the full string)\n');
    console.log('2. Go to your GitHub repo → Settings → Secrets and variables → Actions\n');
    console.log('3. Click "New repository secret"\n');
    console.log('4. Name: GOOGLE_CREDENTIALS');
    console.log('   Value: (paste the refresh token)\n');
    console.log('5. Click "Add secret"\n');
    console.log('6. Re-run the Daily Briefing workflow in GitHub Actions\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.message.includes('invalid_grant')) {
      console.error('\n⚠️  The authorization code expired or is invalid.');
      console.error('Please run the script again and authorize within a few minutes.\n');
    }
    process.exit(1);
  }
}

main();
