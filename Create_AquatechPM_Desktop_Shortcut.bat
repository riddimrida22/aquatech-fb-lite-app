@echo off
setlocal

pushd "%~dp0"
if errorlevel 1 (
  echo Could not access app folder:
  echo %~dp0
  pause
  exit /b 1
)

set "TARGET=%~dp0Start_AquatechPM_App.bat"
set "TARGET_DIR=%~dp0"
set "SHORTCUT_NAME=AquatechPM.lnk"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$Desktop = [Environment]::GetFolderPath('Desktop');" ^
  "$ShortcutPath = Join-Path $Desktop '%SHORTCUT_NAME%';" ^
  "$WshShell = New-Object -ComObject WScript.Shell;" ^
  "$Shortcut = $WshShell.CreateShortcut($ShortcutPath);" ^
  "$Shortcut.TargetPath = $env:ComSpec;" ^
  "$Shortcut.Arguments = '/c pushd ""%TARGET_DIR%"" && call ""%TARGET%""';" ^
  "$Shortcut.WorkingDirectory = [Environment]::GetFolderPath('Desktop');" ^
  "$Shortcut.IconLocation = 'shell32.dll,220';" ^
  "$Shortcut.Save();"

if errorlevel 1 (
  echo Could not create desktop shortcut automatically.
  echo You can still run Start_AquatechPM_App.bat directly.
  pause
  exit /b 1
)

echo Desktop shortcut created: %SHORTCUT_NAME%
echo You can now start the app from your desktop.
pause
popd
