<#
.SYNOPSIS
  Downloads the ATOZAS model weights on a Windows development machine.

.DESCRIPTION
  The Windows counterpart to fetch-models.sh. The catalogue is not duplicated
  here: it comes from server/scripts/model-manifest.mjs, which reads
  modelRegistry.js, so this script picks up new models automatically.

  Downloads resume: a partial transfer is written to <file>.part and only
  renamed once complete, so an interrupted run can never leave a truncated GGUF
  that llama-server would later fail to load in a confusing way.

  Licences differ per model and are printed before each download:
    Qwen3-4B-2507     Apache-2.0
    Qwen3-4B          Apache-2.0
    Phi-4-mini        MIT
    Gemma 3 4B        Gemma Terms of Use (+ Prohibited Use Policy)
    Llama 3.2 3B      Llama 3.2 Community License (+ "Built with Llama" notice)

.PARAMETER Only
  Download just these model ids. Default: everything in the registry.

.PARAMETER Role
  Restrict to 'chat' or 'embedding'.

.EXAMPLE
  .\deploy\scripts\fetch-models.ps1
  .\deploy\scripts\fetch-models.ps1 -Only gemma-3-4b-it,llama-3.2-3b-instruct
  .\deploy\scripts\fetch-models.ps1 -Role chat
#>
[CmdletBinding()]
param(
    [string]$ModelDir = '',
    [string[]]$Only   = @(),
    [ValidateSet('chat', 'embedding', 'all')]
    [string]$Role     = 'all',
    [switch]$Checksum
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Bad($msg)  { Write-Host "[x] $msg" -ForegroundColor Red }

# $PSScriptRoot is not populated in every invocation style, and a blank one
# silently turns the defaults into paths relative to the drive root.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$repoRoot  = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
if (-not $ModelDir) { $ModelDir = Join-Path $repoRoot 'models' }

$serverDir = Join-Path $repoRoot 'server'
$manifestArgs = @((Join-Path $serverDir 'scripts\model-manifest.mjs'))
if ($Role -ne 'all') { $manifestArgs += @('--role', $Role) }

Write-Step 'Reading the model manifest from the registry'
$manifest = & node @manifestArgs | ConvertFrom-Json
if (-not $manifest) { Write-Bad 'Could not read the model manifest.'; exit 1 }

if ($Only.Count) {
    $manifest = $manifest | Where-Object { $Only -contains $_.id }
    if (-not $manifest) { Write-Bad "None of the requested ids exist in the registry."; exit 1 }
}

New-Item -ItemType Directory -Force -Path $ModelDir | Out-Null
$ModelDir = (Resolve-Path $ModelDir).Path

# A 4 GB download that dies at 95% because the disk filled is a bad afternoon.
$drive = Get-PSDrive -Name (Split-Path -Qualifier $ModelDir).TrimEnd(':')
$freeGB = [Math]::Round($drive.Free / 1GB, 1)
Write-Host "    target:    $ModelDir"
Write-Host "    free disk: $freeGB GB"
if ($freeGB -lt 13) { Write-Warn "Less than 13 GB free; the full set needs roughly 13 GB." }

$downloaded = 0
foreach ($model in $manifest) {
    $path = Join-Path $ModelDir $model.file

    if (Test-Path $path) {
        $sizeGB = [Math]::Round((Get-Item $path).Length / 1GB, 2)
        Write-Step "$($model.id): already present ($sizeGB GB)"
    }
    else {
        Write-Step "$($model.id): downloading"
        Write-Host "    licence: $($model.license)"
        if ($model.licenseNotes) { Write-Host "    note:    $($model.licenseNotes)" -ForegroundColor Yellow }
        Write-Host "    from:    $($model.url)"

        $part = "$path.part"
        try {
            # curl.exe ships with Windows 10+ and handles resume and redirects
            # far better than Invoke-WebRequest for multi-GB files.
            & curl.exe -fL --retry 3 --retry-delay 5 --continue-at - -o $part $model.url
            if ($LASTEXITCODE -ne 0) { throw "curl exited with $LASTEXITCODE" }
            Move-Item -Force $part $path
            $downloaded++
        }
        catch {
            Write-Bad "$($model.id): download failed - $($_.Exception.Message)"
            Write-Host "    The partial file is kept at $part and will resume on the next run."
            continue
        }
    }

    if ($Checksum) {
        Write-Host "    computing SHA-256 (slow on a multi-GB file)"
        $actual = (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLower()
        if (-not $model.sha256) {
            Write-Warn "no expected checksum recorded. Record this in server/.env and deploy/MODELS.md:"
            Write-Host "        $actual"
        }
        elseif ($model.sha256.ToLower() -ne $actual) {
            Write-Bad "$($model.id): CHECKSUM MISMATCH"
            Write-Host "        expected: $($model.sha256)"
            Write-Host "        actual:   $actual"
            Write-Host "    Delete the file and re-run."
            exit 1
        }
        else { Write-Host "    checksum verified" }
    }
}

Write-Host ''
Write-Step "Done - $downloaded newly downloaded, $($manifest.Count) in the catalogue"
Write-Host ''
Write-Host 'Next: regenerate the router preset and start llama-server:'
Write-Host '  .\deploy\scripts\dev-llama.ps1 -Embeddings'
Write-Host ''
