@echo off
setlocal
chcp 65001 >nul
set "BAT_PATH=%~f0"
set "PROJECT_ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false; $c=[IO.File]::ReadAllText($env:BAT_PATH,(New-Object System.Text.UTF8Encoding $false)); iex (($c -split ('::POWER'+'SHELL::'),2)[1])"
exit /b %ERRORLEVEL%

::POWERSHELL::
$ErrorActionPreference = 'Stop'
$envName = 'production'
$root = $env:PROJECT_ROOT.TrimEnd('\')

function Write-Line([string]$Text) {
  [Console]::Out.WriteLine($Text)
}

function Find-Gh {
  $cmd = Get-Command gh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'GitHub CLI\gh.exe'),
    (Join-Path $env:LOCALAPPDATA 'GitHub CLI\gh.exe')
  )
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }
  return $null
}

function Show-Safe([string]$Text, [string]$Secret) {
  if ([string]::IsNullOrEmpty($Text)) { return }
  if (-not [string]::IsNullOrEmpty($Secret) -and $Text.Contains($Secret)) {
    Write-Line '  gh error. The secret value was hidden.'
    return
  }
  foreach ($line in ($Text -split "`r?`n")) {
    if (-not [string]::IsNullOrWhiteSpace($line)) { Write-Line "  $line" }
  }
}

function Unquote-Value([string]$Value) {
  if ($Value.Length -ge 2 -and $Value.StartsWith('"') -and $Value.EndsWith('"')) {
    $inner = $Value.Substring(1, $Value.Length - 2)
    $inner = $inner.Replace('\\', [string][char]1).Replace('\n', "`n").Replace('\r', "`r").Replace('\t', "`t").Replace('\"', '"')
    return $inner.Replace([string][char]1, '\')
  }
  if ($Value.Length -ge 2 -and $Value.StartsWith("'") -and $Value.EndsWith("'")) {
    return $Value.Substring(1, $Value.Length - 2)
  }
  return $Value
}

function Read-EnvFile([string]$Path) {
  $items = New-Object System.Collections.Generic.List[object]
  $lines = [IO.File]::ReadAllLines($Path)
  foreach ($raw in $lines) {
    $line = $raw.Trim().TrimStart([char]0xFEFF)
    if ($line.Length -eq 0) { continue }
    if ($line.StartsWith('#')) { continue }
    if ($line.StartsWith('export ')) { $line = $line.Substring(7).Trim() }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }
    $name = $line.Substring(0, $eq).Trim()
    $value = Unquote-Value $line.Substring($eq + 1)
    $value = $value.TrimStart([char]0xFEFF)
    $items.Add([pscustomobject]@{ Name = $name; Value = $value; File = $Path })
  }
  return $items
}

function Set-GhSecret([string]$Gh, [string]$Name, [string]$Value, [string]$Repo) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Gh
  $psi.Arguments = "secret set $Name --env $envName --repo `"$Repo`""
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding $false
  $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding $false
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($Value)
  $proc.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $proc.StandardInput.Close()
  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  return [pscustomobject]@{ Code = $proc.ExitCode; Out = $stdout; Err = $stderr }
}

Write-Line ''
Write-Line 'Adding new .env secrets to the production GitHub Environment.'
Write-Line 'Existing secrets are not changed or deleted.'
Write-Line ''

$gh = Find-Gh
if (-not $gh) {
  Write-Line 'GitHub CLI (gh) was not found. Install it from https://cli.github.com/'
  exit 1
}

Set-Location -LiteralPath $root
& $gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Line 'gh is not logged in. Run: gh auth login'
  exit 1
}

$repo = (& $gh repo view --json nameWithOwner --jq .nameWithOwner 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repo)) {
  Write-Line 'No GitHub repo was found for this folder. Run this from the project root.'
  exit 1
}

$existing = New-Object 'System.Collections.Generic.HashSet[string]'
$listRaw = & $gh secret list --env $envName --repo $repo --json name 2>&1 | Out-String
if ($LASTEXITCODE -eq 0) {
  try {
    $parsed = $listRaw | ConvertFrom-Json
    foreach ($item in @($parsed)) {
      if ($item.name) { [void]$existing.Add([string]$item.name) }
    }
  } catch {
    $LASTEXITCODE = 1
  }
}
if ($LASTEXITCODE -ne 0) {
  $table = & $gh secret list --env $envName --repo $repo 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Write-Line 'Could not read the production secret list. Nothing was added.'
    Show-Safe $table ''
    exit 1
  }
  foreach ($row in ($table -split "`r?`n")) {
    $trim = $row.Trim()
    if ($trim.Length -eq 0 -or $trim.StartsWith('NAME')) { continue }
    $name = ($trim -split '\s+', 2)[0]
    if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$') { [void]$existing.Add($name) }
  }
}

$skipDirs = @('node_modules', '.git', 'dist', 'admin-dist', 'build', 'coverage', '.deploy-backups', '.deploy-staging', '.deploy-runtime')
$envFiles = Get-ChildItem -LiteralPath $root -Recurse -Force -File -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Name -eq '.env' -and -not ($_.FullName.Substring($root.Length).Split('\') | Where-Object { $skipDirs -contains $_ })
  } |
  Sort-Object FullName

if (-not $envFiles) {
  Write-Line 'No .env file was found.'
  exit 1
}

Write-Line 'Read .env files:'
foreach ($file in $envFiles) {
  Write-Line ("  " + $file.FullName.Substring($root.Length).TrimStart('\'))
}
Write-Line ''

$added = New-Object System.Collections.Generic.List[string]
$skipped = New-Object System.Collections.Generic.List[string]
$failed = New-Object System.Collections.Generic.List[string]
$seen = New-Object 'System.Collections.Generic.HashSet[string]'

foreach ($file in $envFiles) {
  foreach ($item in (Read-EnvFile $file.FullName)) {
    $name = $item.Name
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      $skipped.Add("$name  - invalid name")
      continue
    }
    if ($seen.Contains($name)) {
      $skipped.Add("$name  - already listed in another .env")
      continue
    }
    [void]$seen.Add($name)
    if ([string]::IsNullOrEmpty($item.Value)) {
      $skipped.Add("$name  - empty value")
      continue
    }
    if ($existing.Contains($name)) {
      $skipped.Add("$name  - already exists in GitHub")
      continue
    }
    $result = Set-GhSecret $gh $name $item.Value $repo
    if ($result.Code -eq 0) {
      [void]$existing.Add($name)
      $added.Add($name)
    } else {
      $failed.Add($name)
      Show-Safe ($result.Err + $result.Out) $item.Value
    }
  }
}

Write-Line ("Added ({0}):" -f $added.Count)
if ($added.Count -eq 0) { Write-Line '  (none)' }
foreach ($name in $added) { Write-Line "  $name" }
Write-Line ''
Write-Line ("Skipped ({0}):" -f $skipped.Count)
if ($skipped.Count -eq 0) { Write-Line '  (none)' }
foreach ($line in $skipped) { Write-Line "  $line" }
Write-Line ''
Write-Line ("Failed ({0}):" -f $failed.Count)
if ($failed.Count -eq 0) { Write-Line '  (none)' }
foreach ($name in $failed) { Write-Line "  $name" }
Write-Line ''
Write-Line ("Summary: added {0}, skipped {1}, failed {2}" -f $added.Count, $skipped.Count, $failed.Count)

if ($failed.Count -gt 0) { exit 1 }
exit 0
