@echo off
setlocal

pushd "%~dp0"
if errorlevel 1 (
  echo Could not access app folder:
  echo %~dp0
  pause
  exit /b 1
)
set "DOCKER_CMD=docker"
set "DOCKER_EXE=C:\Program Files\Docker\Docker\resources\bin\docker.exe"

echo =====================================
echo   AquatechPM - Stopping App
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
popd
