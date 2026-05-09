@echo off
REM Deploy Daily Briefing v2 to GitHub

echo ================================================
echo Daily Briefing v2 - Deploy to GitHub
echo ================================================
echo.

cd /d "C:\Users\Calvin Xu\Desktop\amira-cli-automation"

echo Checking git status...
git status
echo.

echo Adding new files...
git add .github/workflows/daily-briefing-v2.yml
git add scripts/daily-briefing-v2.js
git add package.json
git add README.md
git add SETUP_GUIDE.md
git add SECRETS_CHEATSHEET.md
echo.

echo Committing changes...
git commit -m "Add Daily Briefing v2 - clean, tested automation"
echo.

echo Pushing to GitHub...
git push origin main
echo.

echo ================================================
echo Deployment complete!
echo ================================================
echo.
echo Next steps:
echo 1. Go to GitHub repository Settings - Secrets
echo 2. Add required secrets (see SECRETS_CHEATSHEET.md)
echo 3. Go to Actions - Daily Briefing v2 - Run workflow
echo.
pause
