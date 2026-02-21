@echo off
setlocal

cd /d "%~dp0"
set "DOCKER_CMD=docker"
set "DOCKER_EXE=C:\Program Files\Docker\Docker\resources\bin\docker.exe"

echo =====================================
echo   Aquatech FB-Lite - Stopping App
echo =====================================

where docker >nul 2>&1
if errorlevel 1 (
  if exist "%DOCKER_EXE%" (
    set "DOCKER_CMD=%DOCKER_EXE%"
  ) else (
    echo Docker is not installed (or not found).
    pause
    exit /b 1
  )
)

"%DOCKER_CMD%" compose down
if errorlevel 1 (
  echo Could not stop containers. Check Docker Desktop is running.
  pause
  exit /b 1
)

echo.
echo App stopped.
pause
