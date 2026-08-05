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
    [string]$LlamaDir   = "$PSScriptRoot\..\..\.llamacpp-cpu",
    [string]$ModelDir   = "$PSScriptRoot\..\..\models",
    [string]$Preset     = "$PSScriptRoot\..\llama\models.ini",
    [string]$EmbedModel = "Qwen3-Embedding-0.6B-Q8_0.gguf",
    [int]$ChatPort      = 8081,
    [int]$EmbedPort     = 8082,
    [int]$Threads       = 0,
    [int]$ContextSize   = 8192,
    [int]$Parallel      = 2,
    [int]$MaxLoaded     = 1,
    [switch]$Embeddings
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Bad($msg)  { Write-Host "[x] $msg" -ForegroundColor Red }

# Leave a couple of cores for the OS, Node and MongoDB.
if ($Threads -le 0) {
    $Threads = [Math]::Max(2, [Environment]::ProcessorCount - 2)
}

$server = Join-Path $LlamaDir 'llama-server.exe'
if (-not (Test-Path $server)) {
    Write-Bad "llama-server.exe not found at: $server"
    Write-Host "Download a CPU build from https://github.com/ggml-org/llama.cpp/releases"
    Write-Host "and extract it to .llamacpp-cpu\ in the repository root."
    exit 1
}

# Regenerate the router preset so it always matches modelRegistry.js and only
# lists models whose weights are actually on this host.
Write-Step "Generating router preset from the model registry"
$serverDir = Join-Path $PSScriptRoot '..\..\server'
& node (Join-Path $serverDir 'scripts\generate-llama-preset.mjs') `
    --models-dir $ModelDir --out $Preset --parallel $Parallel
if ($LASTEXITCODE -ne 0) {
    Write-Bad "Could not build $Preset - no chat model weights found in $ModelDir."
    Write-Host "Download them with: .\deploy\scripts\fetch-models.ps1"
    exit 1
}

# Fail early with a clear message rather than letting the app get a 404 from
# whatever else is listening.
function Test-PortFree([int]$Port) {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $procId = ($conn | Select-Object -First 1).OwningProcess
        $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
        Write-Bad "Port $Port is already in use by '$name' (PID $procId)."
        return $false
    }
    return $true
}

if (-not (Test-PortFree $ChatPort)) { exit 1 }
if ($Embeddings -and -not (Test-PortFree $EmbedPort)) { exit 1 }

Write-Step "Starting llama-server (chat router) on 127.0.0.1:$ChatPort"
Write-Host "    preset:  $Preset"
Write-Host "    threads: $Threads   context: $ContextSize   parallel: $Parallel   max loaded: $MaxLoaded"

# No --model: that is what puts llama-server into router mode. Per-model paths
# and context sizes come from the preset; everything below is a global default
# the router passes down to each child server it spawns.
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

if ($Embeddings) {
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
        Start-Process -FilePath $server -ArgumentList $embedArgs -PassThru -NoNewWindow | Out-Null
    }
}

# The router answers as soon as it has parsed the preset; individual models are
# only loaded on the first request that names them.
Write-Step "Waiting for the chat router to come up"
$healthy = $false
for ($i = 0; $i -lt 180; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$ChatPort/v1/models" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch { Start-Sleep -Seconds 1 }
    if ($chatProc.HasExited) { Write-Bad "llama-server exited during startup."; exit 1 }
}

if ($healthy) {
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
    Write-Host "Now start the application in two more terminals:"
    Write-Host "  cd server; npm run dev"
    Write-Host "  cd server; npm run dev:worker"
    Write-Host ""
    Write-Host "Press Ctrl+C to stop llama-server."
    Wait-Process -Id $chatProc.Id
} else {
    Write-Bad "Model did not load within 180 seconds."
    Stop-Process -Id $chatProc.Id -Force -ErrorAction SilentlyContinue
    exit 1
}
