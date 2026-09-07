$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$dashboardRoot = Join-Path $projectRoot "docs"
$pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
$pythonPath = if ($pythonCommand) { $pythonCommand.Source } else { $null }

if (-not $pythonPath) {
    $pythonRoot = Join-Path $env:LOCALAPPDATA "Programs\Python"
    $knownPython = Join-Path $pythonRoot "Python312\python.exe"
    if (Test-Path $knownPython) {
        $pythonPath = $knownPython
    }
    elseif (Test-Path $pythonRoot) {
        $pythonPath = Get-ChildItem $pythonRoot -Filter python.exe -File -Recurse -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
}

if (-not $pythonPath) {
    Write-Host "Python was not found. Install Python 3.10+ and enable Add Python to PATH."
    Read-Host "Press Enter to close"
    exit 1
}

function Test-LocalPort([int]$Port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

if (-not (Test-LocalPort 8767)) {
    Start-Process -FilePath $pythonPath `
        -ArgumentList @("-m", "http.server", "8767", "--bind", "127.0.0.1") `
        -WorkingDirectory $dashboardRoot `
        -WindowStyle Hidden
}

if (-not (Test-LocalPort 7861)) {
    $previousPort = $env:PORT
    $previousDashboardUrl = $env:DASHBOARD_URL
    try {
        $env:PORT = "7861"
        $env:DASHBOARD_URL = "http://127.0.0.1:8767/"
        Start-Process -FilePath $pythonPath `
            -ArgumentList @("app.py") `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden
    }
    finally {
        $env:PORT = $previousPort
        $env:DASHBOARD_URL = $previousDashboardUrl
    }
}

Start-Sleep -Seconds 2
Start-Process "http://127.0.0.1:7861/"
Write-Host "Public portfolio is running:"
Write-Host "  AI POC:    http://127.0.0.1:7861/"
Write-Host "  Dashboard: http://127.0.0.1:8767/"
Write-Host "You may close this window; the local services will keep running."
