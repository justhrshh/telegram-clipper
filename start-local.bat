@echo off
title Telegram Clipper - Local Mode
cd /d "%~dp0"
call npm run start:local
if errorlevel 1 (
    echo.
    echo [ERROR] Launcher exited with code %errorlevel%.
    pause
)
