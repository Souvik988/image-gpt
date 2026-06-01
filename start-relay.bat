@echo off
REM Start the relay-server in this terminal.
REM Loads .env into the environment, then runs node dist/index.js.
REM Stop with Ctrl+C.

setlocal EnableDelayedExpansion
cd /d "%~dp0"

if not exist ".env" (
  echo .env not found. Copy .env.example to .env and fill in the secrets.
  exit /b 1
)

REM Load .env line-by-line into the current cmd session.
REM findstr filters out blank lines and comment lines starting with #.
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /R /V /C:"^#" /C:"^$" ".env"`) do (
  set "%%A=%%B"
)

if not exist "relay-server\dist\index.js" (
  echo relay-server is not built. Run: cd relay-server ^&^& npx tsc -p .
  exit /b 1
)

echo [relay-server] starting on PORT=%PORT%
node relay-server\dist\index.js
