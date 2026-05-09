# Daily Briefing Automation v2

Automated daily briefing that fetches Gmail, Google Calendar, and Slack data, then posts a formatted summary to Slack.

## Quick Start

1. **Configure GitHub Secrets** (see SETUP_GUIDE.md for details)
   - `GOOGLE_CREDENTIALS` - OAuth2 token for Gmail/Calendar
   - `SLACK_WEBHOOK_URL` - Slack webhook for posting
   - `SLACK_BOT_TOKEN` - Slack bot token (optional, for mentions)
   - `SLACK_USER_ID` - Your Slack user ID (optional, for mentions)

2. **Test the workflow**
   - Go to Actions → Daily Briefing v2 → Run workflow

3. **Schedule**: Runs automatically at 7:45 AM CST Monday-Friday

## What It Does

- ✅ Counts unread emails since yesterday
- ✅ Lists today's calendar events
- ✅ Finds Slack mentions (if configured)
- ✅ Posts formatted summary to Slack
- ✅ Saves JSON report as artifact

## Files

- `.github/workflows/daily-briefing-v2.yml` - GitHub Actions workflow
- `scripts/daily-briefing-v2.js` - Main script
- `SETUP_GUIDE.md` - Complete setup instructions

## Sample Output

```
📋 Daily Briefing
━━━━━━━━━━━━━━━━━━━━
Date: Friday, May 9, 2026
Summary: 📧 3 emails  📅 5 events  💬 2 mentions

📧 Unread Emails (3)
...

📅 Today's Calendar (5 events)
...

💬 Slack Mentions (2)
...
```

See SETUP_GUIDE.md for detailed configuration instructions.
