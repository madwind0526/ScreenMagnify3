@echo off
setlocal
cd /d "%~dp0"

rem ScreenMagnify3 is a plain Electron app with no dev server. Stop any running instance first.
taskkill /IM electron.exe /FI "WINDOWTITLE eq ScreenMagnify3*" >nul 2>&1

if not exist "node_modules" (
    echo Installing dependencies...
    call npm install || (echo Install failed. & pause & exit /b 1)
)

start "ScreenMagnify3 App" /min cmd /c "npm start"
echo Done.
