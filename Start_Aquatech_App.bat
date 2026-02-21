@echo off
setlocal EnableDelayedExpansion

if /i "%~1" neq "run" (
  start "Aquatech FB-Lite" cmd /k ""%~f0" run"
  exit /b
)

cd /d "%~dp0"
set "DOCKER_CMD=docker"
set "DOCKER_EXE=C:\Program Files\Docker\Docker\resources\bin\docker.exe"
set "DOCKER_DESKTOP_EXE=C:\Program Files\Docker\Docker\Docker Desktop.exe"
set "LOG_FILE=%~dp0start_log.txt"

if not exist "%~dp0.env" (
  if exist "%~dp0.env.example" (
    copy /Y "%~dp0.env.example" "%~dp0.env" >nul
    echo Created .env from .env.example.
    echo IMPORTANT: review .env and set real Google OAuth and secret values before launch use.
  ) else (
    echo Missing .env and .env.example in app folder.
    pause
    exit /b 1
  )
)

echo [%date% %time%] Starting launcher > "%LOG_FILE%"

echo =====================================
echo   Aquatech FB-Lite - Starting App
echo =====================================

where docker >nul 2>&1
if errorlevel 1 (
  if exist "%DOCKER_EXE%" (
    set "DOCKER_CMD=%DOCKER_EXE%"
  ) else (
    echo Docker is not installed or not found.
    echo Install Docker Desktop, then run this file again:
    echo https://www.docker.com/products/docker-desktop/
    pause
    exit /b 1
  )
)

"%DOCKER_CMD%" info >nul 2>&1
if errorlevel 1 (
  if exist "%DOCKER_DESKTOP_EXE%" (
    echo Docker Desktop is not running. Starting it now...
    echo [%date% %time%] Docker not ready, attempting Desktop launch >> "%LOG_FILE%"
    start "" "%DOCKER_DESKTOP_EXE%"
    call :wait_for_docker
    if errorlevel 1 (
      echo Docker Desktop did not become ready in time.
      echo Open Docker Desktop manually and wait until it is running, then retry.
      echo [%date% %time%] Docker did not become ready in time >> "%LOG_FILE%"
      echo Log file: "%LOG_FILE%"
      pause
      exit /b 1
    )
  ) else (
    echo Docker Desktop is not running.
    echo Please open Docker Desktop and wait until it says it is running.
    echo [%date% %time%] Docker Desktop executable not found >> "%LOG_FILE%"
    echo Log file: "%LOG_FILE%"
    pause
    exit /b 1
  )
)

echo.
echo Building and starting containers...
"%DOCKER_CMD%" compose up --build -d
if errorlevel 1 (
  echo Failed to start containers.
  echo [%date% %time%] docker compose up failed >> "%LOG_FILE%"
  echo Log file: "%LOG_FILE%"
  pause
  exit /b 1
)

echo.
echo App is starting. Opening browser tabs...
start "" "http://localhost:3000"
start "" "http://localhost:8000"

echo.
echo Done. Your app should be available at:
echo - Frontend: http://localhost:3000
echo - Backend:  http://localhost:8000
echo.
echo To stop the app, double-click Stop_Aquatech_App.bat
echo [%date% %time%] Startup completed successfully >> "%LOG_FILE%"
echo Log file: "%LOG_FILE%"
pause
exit /b 0

:wait_for_docker
echo Waiting for Docker Desktop to become ready...
for /l %%I in (1,1,24) do (
  timeout /t 5 /nobreak >nul
  "%DOCKER_CMD%" info >nul 2>&1
  if not errorlevel 1 exit /b 0
)
exit /b 1
