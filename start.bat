@echo off
rem One-click launcher. First run installs deps; afterwards just starts
rem the widget (no console window — electron.exe is a GUI subsystem
rem binary, and `start ""` detaches it from this cmd so the shell
rem exits immediately).

cd /d "%~dp0"

if not exist "node_modules\electron" (
  echo First-time setup: installing dependencies. This takes ~30 seconds.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo === npm install failed. ===
    echo Make sure Node.js 22+ is installed: https://nodejs.org/
    echo.
    pause
    exit /b 1
  )
  echo.
  echo Setup complete.
  echo.
)

start "" "node_modules\electron\dist\electron.exe" .
