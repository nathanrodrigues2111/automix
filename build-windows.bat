@echo off
REM One-click Windows build. Double-click this file, or run `build-windows`
REM from a terminal in the repo root. Passes any args through to the PS
REM script (e.g. `build-windows -Run` to launch the exe when done).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0packaging\build-local.ps1" %*
if errorlevel 1 (
  echo.
  echo Build FAILED - see the error above.
  pause
  exit /b 1
)
echo.
echo Build complete. Exe: dist\Automix\Automix.exe
pause
