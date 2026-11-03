<#
.SYNOPSIS
  Starts the local llama.cpp chat router and embedding server for Windows development.

.DESCRIPTION
  Mirrors the production systemd units on a development machine.

  The chat server runs in llama.cpp *router* mode: it is started without a
  --model, and instead reads deploy/llama/models.ini (generated from the model
  registry) to learn which chat model ATOZAS serves. That is one model - there is
  no model picker - so router mode is here for parity with production and to keep
  models.ini registry-generated, not for switching.

  Note on ports: this machine runs XAMPP Apache on 8080, which is what produced
  the "Local (llama.cpp) request failed (404)" error - the app was reaching
  Apache, not llama-server. Chat therefore uses 8081 and embeddings 8082, the
  same ports as production.

.PARAMETER MaxLoaded
  How many chat models may be resident at once. Keep at 1 on a 16 GB box; each
  additional Q4 4B model costs roughly 2.5 GB of weights plus its KV cache.

.PARAMETER Embeddings
  Also start the embedding server on 8082. Without it, document retrieval falls
  back to keyword-only search - fine for UI work, but not for judging answer
  quality. Live web retrieval is unaffected: it ranks passages lexically.

.EXAMPLE
  .\deploy\scripts\dev-llama.ps1
  .\deploy\scripts\dev-llama.ps1 -Embeddings
  .\deploy\scripts\dev-llama.ps1 -MaxLoaded 2
#>
[CmdletBinding()]
param(
    # Defaults are filled below — $PSScriptRoot is empty while param() defaults
    # are evaluated (PowerShell quirk), which produced paths like
    # C:\..\..\.llamacpp-cpu and broke Test-Path.
    [string]$LlamaDir   = '',
    [string]$ModelDir   = '',
    [string]$Preset     = '',
    [string]$EmbedModel = "Qwen3-Embedding-0.6B-Q8_0.gguf",
    [int]$ChatPort      = 8081,
    [int]$EmbedPort     = 8082,
    [int]$Threads       = 0,
    [int]$ContextSize   = 8192,
    [int]$Parallel      = 2,
    [int]$MaxLoaded     = 1,
    [switch]$Embeddings,
    # Kill any llama-server already holding the chat/embedding ports and start
    # fresh. Use this to recover from an orphaned server left by a previous run.
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Bad($msg)  { Write-Host "[x] $msg" -ForegroundColor Red }

# Script dir is reliable here; param defaults are not.
$scriptDir = if ($PSScriptRoot) {
    $PSScriptRoot
} else {
    Split-Path -Parent $MyInvocation.MyCommand.Path
}
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir '..\..'))

if (-not $LlamaDir) { $LlamaDir = Join-Path $repoRoot '.llamacpp-cpu' }
if (-not $ModelDir) { $ModelDir = Join-Path $repoRoot 'models' }
if (-not $Preset)   { $Preset   = Join-Path $repoRoot 'deploy\llama\models.ini' }

$LlamaDir = [System.IO.Path]::GetFullPath($LlamaDir)
$ModelDir = [System.IO.Path]::GetFullPath($ModelDir)
$Preset   = [System.IO.Path]::GetFullPath($Preset)

# Leave a couple of cores for the OS, Node and MongoDB.
if ($Threads -le 0) {
    $Threads = [Math]::Max(2, [Environment]::ProcessorCount - 2)
}

$server = Join-Path $LlamaDir 'llama-server.exe'
if (-not (Test-Path -LiteralPath $server)) {
    Write-Bad "llama-server.exe not found at: $server"
    Write-Host "Download a CPU build from https://github.com/ggml-org/llama.cpp/releases"
    Write-Host "and extract it to .llamacpp-cpu\ in the repository root."
    exit 1
}

# Regenerate the router preset so it always matches modelRegistry.js and only
# lists models whose weights are actually on this host.
Write-Step "Generating router preset from the model registry"
$serverDir = Join-Path $repoRoot 'server'
& node (Join-Path $serverDir 'scripts\generate-llama-preset.mjs') `
    --models-dir $ModelDir --out $Preset --parallel $Parallel
if ($LASTEXITCODE -ne 0) {
    Write-Bad "Could not build $Preset - no chat model weights found in $ModelDir."
    Write-Host "Download them with: .\deploy\scripts\fetch-models.ps1"
    exit 1
}

# Classifies a port: 'free' | 'llama' (a llama-server already listening) |
# 'other' (something else — e.g. XAMPP Apache — that we must not touch).
function Get-PortOwner([int]$Port) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) { return [pscustomobject]@{ State = 'free'; Pid = $null; Name = $null } }
    $procId = ($conn | Select-Object -First 1).OwningProcess
    $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
    $state = if ($name -eq 'llama-server') { 'llama' } else { 'other' }
    return [pscustomobject]@{ State = $state; Pid = $procId; Name = $name }
}

# Frees a port when it is held by a stray llama-server (our own kind). This is
# what makes re-running the script idempotent: an embeddings server orphaned by
# a previous Ctrl+C no longer blocks the next start.
function Stop-StrayLlama([int]$Port, [string]$Label) {
    $owner = Get-PortOwner $Port
    if ($owner.State -eq 'llama') {
        Write-Warn "$Label port $Port held by a previous llama-server (PID $($owner.Pid)) - stopping it."
        Stop-Process -Id $owner.Pid -Force -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt 20; $i++) {
            if ((Get-PortOwner $Port).State -ne 'llama') { break }
            Start-Sleep -Milliseconds 200
        }
    }
}

# Processes THIS script started, so Ctrl+C / exit cleans them up instead of
# leaking an orphan onto 8082 (the recurring "port already in use" cause).
$owned = @()

if ($Restart) {
    Stop-StrayLlama $ChatPort 'Chat'
    if ($Embeddings) { Stop-StrayLlama $EmbedPort 'Embeddings' }
}

$chatOwner = Get-PortOwner $ChatPort
if ($chatOwner.State -eq 'other') {
    Write-Bad "Chat port $ChatPort is in use by '$($chatOwner.Name)' (PID $($chatOwner.Pid)), not llama-server."
    Write-Host "Stop that process, pick another -ChatPort, or re-run with -Restart if it is a stale llama-server."
    exit 1
}

$chatProc = $null
$reuseChat = $false
if ($chatOwner.State -eq 'llama') {
    Write-Warn "Reusing the llama-server already serving chat on 127.0.0.1:$ChatPort (PID $($chatOwner.Pid))."
    $reuseChat = $true
} else {
    Write-Step "Starting llama-server (chat router) on 127.0.0.1:$ChatPort"
    Write-Host "    preset:  $Preset"
    Write-Host "    threads: $Threads   context: $ContextSize   parallel: $Parallel   max loaded: $MaxLoaded"

    # No --model: that is what puts llama-server into router mode. Per-model
    # paths and context sizes come from the preset; everything below is a global
    # default the router passes down to each child server it spawns.
    $chatArgs = @(
        '--models-preset', $Preset,
        '--models-max', $MaxLoaded,
        '--host', '127.0.0.1',
        '--port', $ChatPort,
        '--threads', $Threads,
        '--threads-batch', $Threads,
        '--cont-batching',
        '--cache-prompt',
        '--no-webui'
    )
    $chatProc = Start-Process -FilePath $server -ArgumentList $chatArgs -PassThru -NoNewWindow
    $owned += $chatProc
}

if ($Embeddings) {
    $embedOwner = Get-PortOwner $EmbedPort
    if ($embedOwner.State -eq 'llama') {
        Write-Warn "Reusing the embedding server already on 127.0.0.1:$EmbedPort (PID $($embedOwner.Pid))."
    } elseif ($embedOwner.State -eq 'other') {
        Write-Warn "Embedding port $EmbedPort is held by '$($embedOwner.Name)' (PID $($embedOwner.Pid)) - skipping embeddings."
    } else {
        $embedModelPath = Join-Path $ModelDir $EmbedModel
        if (-not (Test-Path $embedModelPath)) {
            Write-Warn "Embedding model not found at $embedModelPath - retrieval will be keyword-only."
        } else {
            Write-Step "Starting llama-server (embeddings) on 127.0.0.1:$EmbedPort"
            $embedArgs = @(
                '--model', $embedModelPath,
                '--alias', 'qwen3-embedding-0.6b',
                '--host', '127.0.0.1',
                '--port', $EmbedPort,
                '--embedding',
                # Decoder model: the sequence is encoded into its final token, so
                # mean pooling would flatten every vector toward a constant.
                '--pooling', 'last',
                '--threads', '2',
                # Total context, split across the 4 slots: 8192 / 4 = 2048 per slot.
                '--ctx-size', '8192',
                '--parallel', '4',
                '--batch-size', '2048',
                '--ubatch-size', '2048',
                '--no-webui'
            )
            $embedProc = Start-Process -FilePath $server -ArgumentList $embedArgs -PassThru -NoNewWindow
            $owned += $embedProc
        }
    }
}

# Stops only the servers this run started. Registered for the normal exit path
# and for Ctrl+C via the engine event, so neither leaves an orphan behind.
function Stop-OwnedServers {
    foreach ($p in $script:owned) {
        if ($p -and -not $p.HasExited) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Stop-OwnedServers }

try {
    # The router answers as soon as it has parsed the preset; individual models
    # are only loaded on the first request that names them.
    Write-Step "Waiting for the chat router to come up"
    $healthy = $false
    for ($i = 0; $i -lt 180; $i++) {
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$ChatPort/v1/models" -UseBasicParsing -TimeoutSec 2
            if ($r.StatusCode -eq 200) { $healthy = $true; break }
        } catch { Start-Sleep -Seconds 1 }
        if ($chatProc -and $chatProc.HasExited) { Write-Bad "llama-server exited during startup."; exit 1 }
    }

    if (-not $healthy) {
        Write-Bad "Model did not load within 180 seconds."
        Stop-OwnedServers
        exit 1
    }

    Write-Host ""
    Write-Host "llama-server router is ready." -ForegroundColor Green
    Write-Host "  chat:      http://127.0.0.1:$ChatPort/v1"
    if ($Embeddings) { Write-Host "  embeddings: http://127.0.0.1:$EmbedPort/v1" }
    Write-Host ""
    Write-Host "Models being served:"
    try {
        $catalog = Invoke-RestMethod -Uri "http://127.0.0.1:$ChatPort/v1/models" -TimeoutSec 5
        foreach ($m in $catalog.data) { Write-Host "  - $($m.id)" }
    } catch { Write-Warn "Could not read the model catalogue." }
    Write-Host ""

    if ($owned.Count -eq 0) {
        Write-Host "Everything was already running - nothing to keep open. Servers keep running in the background." -ForegroundColor Green
        Write-Host "Stop them with: .\deploy\scripts\dev-llama.ps1 -Restart   (or Get-Process llama-server | Stop-Process)"
        exit 0
    }

    Write-Host "Now start the application in two more terminals:"
    Write-Host "  cd server; npm run dev"
    Write-Host "  cd server; npm run dev:worker"
    Write-Host ""
    Write-Host "Press Ctrl+C to stop the llama-server(s) this script started."

    # Wait on whatever we started (chat if we launched it, else the embed proc).
    $waitId = if ($chatProc) { $chatProc.Id } else { $owned[0].Id }
    Wait-Process -Id $waitId
} finally {
    Stop-OwnedServers
}
