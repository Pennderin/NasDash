@echo off
title Tabor Media Hub
cd /d "%~dp0"

:: Install dependencies if needed
if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo ERROR: npm install failed. Make sure Node.js is installed.
        echo Download from: https://nodejs.org
        pause
        exit /b 1
    )
    echo.
)

:: Start the widget
echo Starting Tabor Media Hub...
echo This window can be minimized.
call npx electron .
pause
