@echo off
setlocal

cd /d "%~dp0"

set "TARGET=%~dp0Start_Aquatech_App.bat"
set "SHORTCUT_NAME=Aquatech FB-Lite.lnk"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$Desktop = [Environment]::GetFolderPath('Desktop');" ^
  "$ShortcutPath = Join-Path $Desktop '%SHORTCUT_NAME%';" ^
  "$WshShell = New-Object -ComObject WScript.Shell;" ^
  "$Shortcut = $WshShell.CreateShortcut($ShortcutPath);" ^
  "$Shortcut.TargetPath = '%TARGET%';" ^
  "$Shortcut.WorkingDirectory = '%~dp0';" ^
  "$Shortcut.IconLocation = 'shell32.dll,220';" ^
  "$Shortcut.Save();"

if errorlevel 1 (
  echo Could not create desktop shortcut automatically.
  echo You can still run Start_Aquatech_App.bat directly.
  pause
  exit /b 1
)

echo Desktop shortcut created: %SHORTCUT_NAME%
echo You can now start the app from your desktop.
pause
