# Daily Briefing v2 - Setup Guide

## Overview
Automated daily briefing that runs at 7:45 AM CST Monday-Friday via GitHub Actions.

**Features:**
- ✅ Unread Gmail emails (count + subjects)
- ✅ Today's Google Calendar events
- ✅ Slack mentions (where you're tagged)
- ✅ Formatted Slack notification with blocks
- ✅ Manual trigger option
- ✅ JSON report saved as artifact

---

## Step 1: Configure GitHub Secrets

Go to your repository: **Settings → Secrets and variables → Actions → New repository secret**

### Required Secrets

#### 1. GOOGLE_CREDENTIALS
Your Google OAuth2 credentials for Gmail and Calendar access.

**Format:** JSON object
```json
{
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_CLIENT_SECRET",
  "refresh_token": "YOUR_REFRESH_TOKEN",
  "redirect_uris": ["urn:ietf:wg:oauth:2.0:oob"]
}
```

**How to get this:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable **Gmail API** and **Google Calendar API**
4. Create OAuth 2.0 credentials (Desktop app type)
5. Download the credentials JSON
6. Use OAuth Playground to get refresh_token:
   - Go to https://developers.google.com/oauthplayground/
   - Click gear icon → Use your own OAuth credentials
   - Enter your Client ID and Client Secret
   - Select scopes: `Gmail API v1` (readonly) and `Google Calendar API v3` (readonly)
   - Authorize and exchange code for tokens
   - Copy the refresh_token

#### 2. SLACK_WEBHOOK_URL
Your Slack Incoming Webhook URL for posting briefings.

**Format:** `https://hooks.slack.com/services/T.../B.../...`

**How to get this:**
1. Go to https://api.slack.com/apps
2. Create a new app (or use existing)
3. Go to **Incoming Webhooks**
4. Activate Incoming Webhooks
5. Click **Add New Webhook to Workspace**
6. Select the channel where you want briefings posted (e.g., #daily-briefing)
7. Copy the Webhook URL

#### 3. SLACK_BOT_TOKEN (Optional - for mentions)
Your Slack Bot User OAuth Token for reading mentions.

**Format:** `xoxb-...` or `xoxp-...`

**How to get this:**
1. Go to https://api.slack.com/apps
2. Select your app → **OAuth & Permissions**
3. Add these Bot Token Scopes:
   - `search:read` (Search messages)
   - `users:read` (View people in workspace)
4. Install app to workspace
5. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

#### 4. SLACK_USER_ID (Optional - for mentions)
Your Slack user ID to search for mentions.

**Format:** `U...` (e.g., `U01ABC123DEF`)

**How to get this:**
1. In Slack, click your profile picture → **Profile**
2. Click the three dots → **Copy member ID**

> **Note:** If you don't configure SLACK_BOT_TOKEN and SLACK_USER_ID, the briefing will still run but skip the mentions section.

---

## Step 2: Test the Workflow

### Option A: Manual Trigger (Recommended for first test)
1. Go to your repository on GitHub
2. Click **Actions** tab
3. Select **Daily Briefing v2** workflow
4. Click **Run workflow** → **Run workflow**
5. Wait 30-60 seconds, then check the run details

### Option B: Wait for Scheduled Run
The workflow runs automatically at **7:45 AM CST (1:45 PM UTC)** Monday-Friday.

---

## Step 3: Verify Success

### Check GitHub Actions Run
1. Go to **Actions** tab in your repository
2. Click the latest run
3. Expand the **Run daily briefing** step
4. Look for these success messages:
   ```
   📧 Fetching unread emails...
   ✅ Found X unread emails
   📅 Fetching calendar events...
   ✅ Found X calendar events
   💬 Fetching Slack mentions...
   ✅ Found X Slack mentions
   📤 Posting to Slack...
   ✅ Posted to Slack successfully
   ✅ Report saved: reports/briefing-YYYY-MM-DD.json
   ✅ Daily Briefing complete in X.XXs
   ```

### Check Slack Channel
You should see a formatted message like:

```
📋 Daily Briefing
━━━━━━━━━━━━━━━━━━━━
Date: Friday, May 9, 2026
Summary: 📧 3 emails  📅 5 events  💬 2 mentions

📧 Unread Emails (3)
1. Weekly Team Update
   From: John Smith <john@example.com>
2. Q2 Report Review
   From: Jane Doe <jane@example.com>
...

📅 Today's Calendar (5 events)
1. Team Standup
   9:00 AM - 9:30 AM
2. Client Demo
   2:00 PM - 3:00 PM
...

💬 Slack Mentions (2)
1. #support at 8:15 AM
   @alice: Hey @calvin, can you check case #12345?
...

Generated at 7:45 AM CST
```

### Download JSON Report
1. In the GitHub Actions run, scroll to **Artifacts**
2. Download **daily-briefing-report-XXX**
3. Extract and view `briefing-YYYY-MM-DD.json`

---

## Troubleshooting

### "GOOGLE_CREDENTIALS environment variable is not set"
- Make sure you added the secret in GitHub with exact name `GOOGLE_CREDENTIALS`
- Verify the JSON format is correct (valid JSON, no extra quotes)

### "Invalid GOOGLE_CREDENTIALS format"
- Ensure the JSON includes `client_id`, `client_secret`, and `refresh_token`
- Use OAuth2 token format, not service account

### "Slack API error: invalid_auth"
- Check SLACK_BOT_TOKEN is correct (starts with `xoxb-` or `xoxp-`)
- Verify bot has required scopes: `search:read`, `users:read`

### "Slack webhook failed"
- Verify SLACK_WEBHOOK_URL is correct
- Check the webhook is still active in Slack App settings

### Gmail/Calendar returns no data
- Verify OAuth scopes include Gmail and Calendar readonly access
- Check the refresh_token is valid and not expired
- Try regenerating credentials from OAuth Playground

---

## Customization

### Change Schedule
Edit `.github/workflows/daily-briefing-v2.yml`:
```yaml
schedule:
  - cron: '45 13 * * 1-5'  # 7:45 AM CST = 1:45 PM UTC
```

Use [crontab.guru](https://crontab.guru/) to generate cron expressions.

### Change Timezone
Edit `scripts/daily-briefing-v2.js`:
```javascript
const TIMEZONE = 'America/Chicago'; // CST/CDT
```

### Adjust Email/Event Limits
Edit `scripts/daily-briefing-v2.js`:
```javascript
maxResults: 20,  // Gmail query limit
.slice(0, 10)    // First 10 emails in report
.slice(0, 5)     // First 5 shown in Slack
```

---

## File Structure
```
amira-cli-automation/
├── .github/
│   └── workflows/
│       └── daily-briefing-v2.yml      ← GitHub Actions workflow
├── scripts/
│   └── daily-briefing-v2.js           ← Main script
├── reports/
│   └── briefing-YYYY-MM-DD.json       ← Generated reports
└── package.json                        ← Dependencies
```

---

## Support

If you encounter issues:
1. Check the GitHub Actions run logs for error messages
2. Verify all secrets are configured correctly
3. Test Google/Slack credentials independently
4. Check this guide's troubleshooting section

---

**Last Updated:** May 9, 2026
