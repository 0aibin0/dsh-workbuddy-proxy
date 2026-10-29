@echo off
rem ===========================================================================
rem  dsh-workbuddy-proxy - one-click installer for Windows
rem
rem  Double-click this file, or run:
rem      install.bat [-Profile desktop] [-Port 14577] [-DshHome C:\Users\me\.dsh]
rem
rem  The plugin directory is ALWAYS the directory this .bat lives in, so you can
rem  put the repository anywhere (C:\tools\, D:\Downloads\, a USB stick, ...).
rem ===========================================================================
setlocal EnableExtensions
chcp 65001 > nul

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "PS1=%ROOT%\scripts\install-windows.ps1"

echo ============================================================
echo   dsh-workbuddy-proxy  -  one-click installer
echo ============================================================
echo.
echo   plugin dir : %ROOT%
echo.

if not exist "%PS1%" (
  echo   [ERROR] scripts\install-windows.ps1 not found under "%ROOT%"
  echo           Download the WHOLE repository, not a single file.
  echo.
  pause
  exit /b 1
)

set "PROFILE=desktop"
set "PORT=14577"
set "DSHHOME="

:parse
if "%~1"=="" goto run
if /i "%~1"=="-Profile" (
  set "PROFILE=%~2"
  shift
  shift
  goto parse
)
if /i "%~1"=="-Port" (
  set "PORT=%~2"
  shift
  shift
  goto parse
)
if /i "%~1"=="-DshHome" (
  set "DSHHOME=%~2"
  shift
  shift
  goto parse
)
if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage
echo   [WARN] unknown argument: %~1
shift
goto parse

:usage
echo   usage: install.bat [-Profile desktop] [-Port 14577] [-DshHome C:\Users\me\.dsh]
echo.
pause
exit /b 0

:run
echo   profile    : %PROFILE%
echo   port       : %PORT%
if not "%DSHHOME%"=="" echo   dsh home   : %DSHHOME%
echo.

set "PS_ARGS=-NoProfile -ExecutionPolicy Bypass -File "%PS1%" -PluginDir "%ROOT%" -Profile "%PROFILE%" -Port "%PORT%""
if not "%DSHHOME%"=="" set "PS_ARGS=%PS_ARGS% -DshHome "%DSHHOME%""

powershell %PS_ARGS%
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo   [OK] installer finished.
) else (
  echo   [FAIL] installer exited with code %RC%.
)
echo.
echo   Next: restart DSH, then pick a model whose name ends with ^(Proxy^).
echo.
pause
exit /b %RC%
