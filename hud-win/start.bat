@echo off
rem Agent HUD for Windows -- launcher
rem
rem IMPORTANT: ELECTRON_RUN_AS_NODE must be cleared. When this script is run
rem from an Electron host terminal (VS Code, DSH, ...), the variable is
rem inherited and Electron degrades to plain Node, failing with:
rem   TypeError: Cannot read properties of undefined (reading 'whenReady')
rem Keep this file ASCII-only: non-ASCII comments break under some code pages.
cd /d "%~dp0"

if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [ERROR] Electron not found. Run: npm install
  pause
  exit /b 1
)

set ELECTRON_RUN_AS_NODE=

rem Launch the exe directly. Two things were verified the hard way on Windows:
rem   1. The app path must be given explicitly. Electron does NOT pick up the
rem      current directory on its own -- without "." it starts an empty window
rem      titled "Electron" instead of loading our app.
rem   2. Do not use cmd's `start` for this. `start "" "electron.exe" "."`
rem      mangles quoting: the empty pair is read as a window title, argv
rem      shifts, and Electron prints its usage banner instead of launching.
rem The console window stays open while the HUD runs; close it to stop the HUD.
"%~dp0node_modules\electron\dist\electron.exe" .
