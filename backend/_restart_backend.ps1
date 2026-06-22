$ErrorActionPreference = "SilentlyContinue"
$root = "C:\Users\bertr\Organized\Curated\Projects_Master\AquatechPM\code\AquatechPM"
$backend = Join-Path $root "backend"
$py = Join-Path $backend ".venv\Scripts\python.exe"
$envFile = Join-Path $root ".env"

# Kill any existing uvicorn on :8000
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'uvicorn' -and $_.CommandLine -match 'app.main:app' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 800

# Load .env into this process environment
Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
    $idx = $line.IndexOf("=")
    $k = $line.Substring(0, $idx).Trim()
    $v = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
    [System.Environment]::SetEnvironmentVariable($k, $v, "Process")
  }
}

# Start uvicorn with reload, detached, logging to file
$log = Join-Path $backend "uvicorn.log"
$args = @("-m","uvicorn","app.main:app","--host","127.0.0.1","--port","8000")
Start-Process -FilePath $py -ArgumentList $args -WorkingDirectory $backend `
  -RedirectStandardOutput $log -RedirectStandardError (Join-Path $backend "uvicorn.err.log") `
  -WindowStyle Hidden
Write-Output "backend restarting with --reload; logs at $log"
