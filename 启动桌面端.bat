@echo off
setlocal
cd /d "%~dp0"
title DeepSeek Harness Desktop

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] Node.js not found. Please install Node.js 18+ from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo  First run: installing dependencies - Electron plus latest harness. May take a few minutes...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [ERROR] Dependency install failed. Check your network and try again.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo  Starting DeepSeek Harness Desktop...
echo.
call npm start
if errorlevel 1 (
  echo.
  echo  [ERROR] App failed to start. See logs above.
  echo.
  pause
)

