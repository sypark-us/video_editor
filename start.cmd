@echo off
rem Starts a local server for Cutroom and opens it in the default browser.
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
start "Cutroom server (close this window to stop)" node test\serve.mjs 8080
timeout /t 1 >nul
start "" http://localhost:8080/
