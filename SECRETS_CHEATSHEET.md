# GitHub Secrets Quick Reference

Copy these to GitHub → Settings → Secrets and variables → Actions

## 1. GOOGLE_CREDENTIALS

**Name:** `GOOGLE_CREDENTIALS`

**Value:** (JSON format - replace with your actual credentials)
```json
{
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_CLIENT_SECRET",
  "refresh_token": "YOUR_REFRESH_TOKEN",
  "redirect_uris": ["urn:ietf:wg:oauth:2.0:oob"]
}
```

**Get from:**
- Google Cloud Console: https://console.cloud.google.com/
- OAuth Playground: https://developers.google.com/oauthplayground/

---

## 2. SLACK_WEBHOOK_URL

**Name:** `SLACK_WEBHOOK_URL`

**Value:** `https://hooks.slack.com/services/T.../B.../...`

**Get from:**
- Slack API: https://api.slack.com/apps
- Your App → Incoming Webhooks → Add New Webhook

---

## 3. SLACK_BOT_TOKEN (Optional)

**Name:** `SLACK_BOT_TOKEN`

**Value:** `xoxb-...` or `xoxp-...`

**Get from:**
- Slack API: https://api.slack.com/apps
- Your App → OAuth & Permissions → Bot User OAuth Token

**Required Scopes:**
- `search:read`
- `users:read`

---

## 4. SLACK_USER_ID (Optional)

**Name:** `SLACK_USER_ID`

**Value:** `U...` (e.g., `U01ABC123DEF`)

**Get from:**
- Slack → Your Profile → Click three dots → Copy member ID

---

## Testing Checklist

After adding secrets:

1. ✅ Go to Actions → Daily Briefing v2
2. ✅ Click "Run workflow"
3. ✅ Wait 30-60 seconds
4. ✅ Check run logs for success messages
5. ✅ Verify Slack message appeared in channel
6. ✅ Download artifact to see JSON report

---

**Pro Tip:** Test with just GOOGLE_CREDENTIALS and SLACK_WEBHOOK_URL first. Add Slack bot tokens later if you want the mentions feature.
