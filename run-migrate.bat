@echo off
setlocal

if "%WSL_DISTRO%"=="" set "WSL_DISTRO=Ubuntu-22.04"
if "%METASHEET_LINUX_ROOT%"=="" set "METASHEET_LINUX_ROOT=/opt/metasheet"

echo [run-migrate] WSL_DISTRO=%WSL_DISTRO%
echo [run-migrate] METASHEET_LINUX_ROOT=%METASHEET_LINUX_ROOT%

wsl.exe -d "%WSL_DISTRO%" --cd "%METASHEET_LINUX_ROOT%" bash -lc "set -euo pipefail; test -f docker/app.env || { echo '[run-migrate] docker/app.env not found under %METASHEET_LINUX_ROOT%' >&2; exit 1; }; source docker/app.env; node packages/core-backend/dist/src/db/migrate.js"
if errorlevel 1 exit /b %errorlevel%

echo [run-migrate] Migration completed successfully.
endlocal
