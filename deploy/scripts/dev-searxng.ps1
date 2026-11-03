<#
.SYNOPSIS
  Install (if needed) and start the local SearXNG that ATOZAS live web retrieval uses.

.DESCRIPTION
  Docker Desktop is not required. SearXNG is installed into the default WSL distro
  under ~/.local/share/atozas-searxng and bound to 127.0.0.1:8888 — the same URL
  server/.env expects for SEARXNG_BASE_URL.

  Prefer `docker compose -f deploy/searxng/docker-compose.yml up -d` on hosts that
  have Docker; this script exists so Windows/WSL development can still run the
  retrieval tier without it.
#>
[CmdletBinding()]
param(
    [switch]$InstallOnly,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "  [ OK ]   $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "  [WARN]   $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { Write-Host "  [FAIL]   $Message" -ForegroundColor Red }

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$InstallScriptWin = Join-Path $RepoRoot 'deploy\searxng\install-wsl.sh'
$WslInstallScript = (wsl -e wslpath -a "$InstallScriptWin").Trim()

if ($Stop) {
    Write-Step 'Stopping SearXNG in WSL'
    wsl -e bash -lc "pkill -f 'python -m searx.webapp' || true"
    Write-Ok 'Stop signal sent'
    exit 0
}

Write-Step 'Ensuring SearXNG is installed in WSL'
wsl -e bash -lc "chmod +x '$WslInstallScript' && '$WslInstallScript'"
if ($LASTEXITCODE -ne 0) {
    Write-Fail 'SearXNG install failed. See output above.'
    exit 1
}
Write-Ok 'Install/update complete'

if ($InstallOnly) { exit 0 }

# Refuse to start if something else already owns 8888.
$busy = Get-NetTCPConnection -LocalPort 8888 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    try {
        $probe = Invoke-WebRequest -Uri 'http://127.0.0.1:8888/search?q=atozas&format=json' -UseBasicParsing -TimeoutSec 5
        if ($probe.StatusCode -eq 200) {
            Write-Ok 'SearXNG already listening on 127.0.0.1:8888'
            exit 0
        }
    } catch {
        Write-Fail "Port 8888 is in use by PID $($busy.OwningProcess) but does not look like SearXNG."
        exit 1
    }
}

Write-Step 'Starting SearXNG on 127.0.0.1:8888'
$StartScriptWin = Join-Path $RepoRoot 'deploy\searxng\start-wsl.sh'
$WslStartScript = (wsl -e wslpath -a "$StartScriptWin").Trim()
$startOut = (wsl -e bash -lc "sed -i 's/\r$//' '$WslStartScript' && chmod +x '$WslStartScript' && '$WslStartScript'").Trim()
Write-Ok $startOut

$deadline = (Get-Date).AddSeconds(60)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        # Prefer /search JSON — that is the contract ATOZAS actually needs.
        # /healthz is not present on every SearXNG build.
        $res = Invoke-WebRequest -Uri 'http://127.0.0.1:8888/search?q=atozas&format=json' -UseBasicParsing -TimeoutSec 5
        if ($res.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        Start-Sleep -Seconds 1
    }
}

if (-not $ready) {
    Write-Fail 'SearXNG did not become healthy. Last log lines:'
    wsl -e bash -lc 'tail -n 60 "$HOME/.local/share/atozas-searxng/searxng.log" || true'
    exit 1
}

Write-Ok 'Healthy on http://127.0.0.1:8888'
Write-Host ''
Write-Host 'WEB_RETRIEVAL_ENABLED=true in server/.env — restart API + worker if they were already running.' -ForegroundColor Green
Write-Host 'Probe:  curl "http://127.0.0.1:8888/search?q=test&format=json"'
