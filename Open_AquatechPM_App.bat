@echo off
setlocal
set "FRONTEND_URL=http://localhost:3000"

for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0.env") do (
  if /i "%%~A"=="FRONTEND_ORIGIN" set "FRONTEND_URL=%%~B"
)

start "" "%FRONTEND_URL%"
