@echo off
cd /d %~dp0
if not exist node_modules call npm install --no-audit --no-fund
start "" http://localhost:8080
node server.mjs
pause
