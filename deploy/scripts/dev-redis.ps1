<#
.SYNOPSIS
    Makes Redis available to ATOZAS on Windows, and keeps it available.

.DESCRIPTION
    Redis has no supported native Windows build, so development runs it inside
    WSL. Two WSL behaviours make that unreliable, and both have bitten this
    project:

      1. WSL2 shuts an idle distribution down after about a minute, even with
         systemd as PID 1. Redis disappears mid-session; the API keeps serving
         but every generation fails at admission with ECONNREFUSED.

         Neither `vmIdleTimeout=-1` in .wslconfig nor a detached process inside
         the distribution prevents this — both were measured, and the VM still
         went away within 120s. What WSL actually tracks is whether a
         *Windows-side* wsl.exe session is attached, so this script leaves one
         parked: `wsl.exe -e sleep infinity`.

         That holder is launched through WMI rather than Start-Process. A
         Start-Process child belongs to the launching shell's job object, so it
         is killed when that terminal (or an agent/CI harness running it) tears
         its process tree down — which is exactly what happened during
         development, taking Redis with it minutes later. A process created via
         Win32_Process.Create is parented to WmiPrvSE instead and survives.

      2. The default NAT networking mode relays Windows localhost into WSL, and
         that relay intermittently fails to forward 6379 — `redis-cli ping`
         succeeds inside WSL while Windows gets ECONNREFUSED. The fix is
         `networkingMode=mirrored` in %USERPROFILE%\.wslconfig, which this
         script checks for and reports.

    Run it once per Windows session, before `npm run dev`:

        powershell -ExecutionPolicy Bypass -File deploy\scripts\dev-redis.ps1

    Stop holding the VM open (and reclaim its memory) with:

        powershell -ExecutionPolicy Bypass -File deploy\scripts\dev-redis.ps1 -Stop
#>
[CmdletBinding()]
param(
    [string]$Distro = 'Ubuntu',
    [int]$Port = 6379,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'

function Write-Step  { param([string]$m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok    { param([string]$m) Write-Host "  [ OK ]   $m" -ForegroundColor Green }
function Write-Warn2 { param([string]$m) Write-Host "  [WARN]   $m" -ForegroundColor Yellow }
function Write-Bad   { param([string]$m) Write-Host "  [FAIL]   $m" -ForegroundColor Red }

# Test-NetConnection reports false negatives against WSL, so probe with a real
# Redis PING and read the reply.
function Test-Redis {
    param([int]$Port, [int]$TimeoutMs = 4000)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        if (-not $client.ConnectAsync('127.0.0.1', $Port).Wait($TimeoutMs)) { return $false }
        $stream = $client.GetStream()
        $stream.ReadTimeout = $TimeoutMs
        $ping = [Text.Encoding]::ASCII.GetBytes("PING`r`n")
        $stream.Write($ping, 0, $ping.Length)
        $buffer = New-Object byte[] 16
        $read = $stream.Read($buffer, 0, $buffer.Length)
        return ([Text.Encoding]::ASCII.GetString($buffer, 0, $read)).StartsWith('+PONG')
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

# The keep-alive is a Windows process, so it is found through WMI rather than
# through anything inside the distribution.
function Get-KeepAlive {
    Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'sleep\s+infinity' }
}

if ($Stop) {
    Write-Step 'Releasing the WSL keep-alive'
    $held = Get-KeepAlive
    if ($held) {
        $held | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Write-Ok "Released $(@($held).Count) keep-alive process(es)."
    } else {
        Write-Ok 'No keep-alive was running.'
    }
    Write-Host '  Run `wsl --shutdown` to reclaim the VM memory.'
    return
}

Write-Step 'Checking WSL networking mode'
$wslConfig = Join-Path $env:USERPROFILE '.wslconfig'
if ((Test-Path $wslConfig) -and (Select-String -Path $wslConfig -Pattern '^\s*networkingMode\s*=\s*mirrored' -Quiet)) {
    Write-Ok 'networkingMode=mirrored is set'
} else {
    Write-Warn2 "networkingMode=mirrored is NOT set in $wslConfig"
    Write-Warn2 'Redis may be reachable inside WSL but refused on Windows. Add:'
    Write-Host  '    [wsl2]'
    Write-Host  '    networkingMode=mirrored'
    Write-Warn2 'then run `wsl --shutdown` and re-run this script.'
}

Write-Step "Ensuring redis-server is enabled and running in $Distro"
# `systemctl enable` makes Redis come back on its own after `wsl --shutdown`,
# so this only has to be done once, but it is idempotent.
$null = wsl -d $Distro -u root -e bash -lc 'systemctl enable redis-server >/dev/null 2>&1; systemctl start redis-server'
$state = (wsl -d $Distro -u root -e bash -lc 'systemctl is-active redis-server').Trim()
if ($state -eq 'active') {
    Write-Ok "redis-server is $state inside $Distro"
} else {
    Write-Bad "redis-server is '$state' inside $Distro"
    wsl -d $Distro -u root -e bash -lc 'systemctl status redis-server --no-pager -l | tail -20'
    exit 1
}

Write-Step 'Confirming Redis is bound to loopback only'
$bind = (wsl -d $Distro -u root -e bash -lc "grep -E '^bind' /etc/redis/redis.conf | head -1").Trim()
if ($bind -match '127\.0\.0\.1') {
    Write-Ok "redis.conf: $bind"
} else {
    Write-Warn2 "redis.conf bind line is '$bind' - Redis should listen on loopback only."
}

Write-Step 'Parking a Windows-side keep-alive so WSL does not shut the distribution down'
$held = Get-KeepAlive
if ($held) {
    Write-Ok "keep-alive already running (pid $(@($held)[0].ProcessId))"
} else {
    # Deliberately not Start-Process: see the note in the header. This must not
    # be a child of the calling shell, or it dies with that shell's job object.
    $spawn = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = "wsl.exe -d $Distro -u root -e sleep infinity"
    }
    if ($spawn.ReturnValue -ne 0) {
        Write-Warn2 "could not spawn keep-alive (Win32_Process.Create returned $($spawn.ReturnValue))"
    } else {
        Start-Sleep -Seconds 4
        $held = Get-KeepAlive
        if ($held) {
            Write-Ok "keep-alive started (pid $(@($held)[0].ProcessId), detached from this shell)"
        } else {
            Write-Warn2 'keep-alive did not stay up; the distro may shut down when idle.'
        }
    }
}

Write-Step "Verifying Redis answers on 127.0.0.1:$Port from Windows"
if (Test-Redis -Port $Port) {
    Write-Ok "Redis replied +PONG on 127.0.0.1:$Port"
} else {
    Write-Bad "Redis did NOT answer on 127.0.0.1:$Port from Windows"
    Write-Warn2 'It is running inside WSL, so this is the localhost relay.'
    Write-Warn2 'Set networkingMode=mirrored (above), then `wsl --shutdown` and re-run.'
    exit 1
}

Write-Host ''
Write-Host 'Redis is ready. Next:' -ForegroundColor Green
Write-Host '  powershell -ExecutionPolicy Bypass -File deploy\scripts\dev-llama.ps1'
Write-Host '  cd server; npm run dev'
Write-Host '  cd server; npm run worker'
Write-Host '  cd client; npm run dev'
