@echo off
REM Start the browser-agent in this terminal.
REM First launch opens a visible Chromium window so you can log into
REM ChatGPT. Subsequent launches run headless (no visible window) by
REM default — set AGENT_HEADLESS=false in .env to keep it visible, or
REM AGENT_HEADLESS=true to force headless even on first launch.
REM Stop with Ctrl+C — the agent's shutdown handler kills the Chromium
REM process tree so no orphaned chrome.exe is left behind.

setlocal EnableDelayedExpansion
cd /d "%~dp0"

if not exist ".env" (
  echo .env not found. Copy .env.example to .env and fill in the secrets.
  exit /b 1
)

REM Load .env into env vars; skip blank and comment lines.
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /R /V /C:"^#" /C:"^$" ".env"`) do (
  set "%%A=%%B"
)

if not exist "browser-agent\dist\index.js" (
  echo browser-agent is not built. Run: cd browser-agent ^&^& npx tsc -p .
  exit /b 1
)

REM Best-effort cleanup of any orphaned Chrome for Testing processes
REM from a previous unclean shutdown. We match by the persistent profile
REM dir to avoid killing the user's normal Chrome.
REM (commented-out by default; uncomment if you observe leaks)
REM wmic process where "CommandLine like '%%%AGENT_PROFILE_DIR%%%'" call terminate >nul 2>&1

if /I "%AGENT_HEADLESS%"=="" set "AGENT_HEADLESS=auto"
echo [browser-agent] AGENT_HEADLESS=%AGENT_HEADLESS%
echo [browser-agent] profile=%AGENT_PROFILE_DIR%
if /I "%AGENT_HEADLESS%"=="false" (
  echo [browser-agent] visible Chromium window will open. Log into ChatGPT once.
) else (
  echo [browser-agent] running headless. First-time login requires AGENT_HEADLESS=false.
)
node browser-agent\dist\index.js
