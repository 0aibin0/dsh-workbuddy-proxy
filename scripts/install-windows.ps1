<#
.SYNOPSIS
  Install dsh-workbuddy-proxy into a DSH profile on Windows.

.DESCRIPTION
  Idempotent. It does four things:
    1. declares the plugin in <profile>/package.json (dependency + bundle)
    2. creates the node_modules junction so the host can import the plugin
    3. adds the `workbuddyproxy` provider route to <profile>/cordis.patch.yml
    4. seeds the fingerprint library in $DSH_HOME

  It does NOT touch credentials: the proxy reads the account vault that
  dsh-connect-workbuddy writes, so that plugin must be installed and signed in.

.PARAMETER PluginDir
  Path of the plugin source (the cloned repo). Defaults to the repo root.

.PARAMETER Profile
  DSH profile name. The desktop app uses "desktop".

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -PluginDir C:\tools\dsh-workbuddy-proxy
#>
[CmdletBinding()]
param(
  [string]$PluginDir = (Split-Path -Parent $PSScriptRoot),
  [string]$Profile = 'desktop',
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [int]$Port = 14577
)

$ErrorActionPreference = 'Stop'

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Note($m) { Write-Host "    $m" -ForegroundColor DarkGray }
function Ok($m) { Write-Host "    [ok] $m" -ForegroundColor Green }
function Warn2($m) { Write-Host "    [!] $m" -ForegroundColor Yellow }

$PluginDir = (Resolve-Path -LiteralPath $PluginDir).Path
$profileDir = Join-Path $DshHome "profiles\$Profile"
$pkgPath = Join-Path $profileDir 'package.json'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'

Step "DSH home : $DshHome"
Step "profile  : $profileDir"
Step "plugin   : $PluginDir"

foreach ($p in @($pkgPath, $patchPath)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "not found: $p" }
}

# ---------------------------------------------------------------- 1. package.json
Step "declaring the plugin in package.json"
$pkgText = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8
$linkSpec = ($PluginDir -replace '\\', '/')
if ($pkgText -match '"dsh-workbuddy-proxy"') {
  Note "already declared - skipped"
} else {
  $lines = Get-Content -LiteralPath $pkgPath -Encoding UTF8
  $out = New-Object System.Collections.Generic.List[string]
  $depDone = $false
  $bundleDone = $false
  foreach ($line in $lines) {
    $out.Add($line)
    if (-not $depDone -and $line -match '^(\s*)"dependencies"\s*:\s*\{') {
      $out.Add(($matches[1] + '  ') + '"dsh-workbuddy-proxy": "link:' + $linkSpec + '",')
      $depDone = $true
      continue
    }
    if (-not $bundleDone -and $line -match '^(\s*)"bundles"\s*:\s*\[') {
      $out.Add(($matches[1] + '  ') + '"dsh-workbuddy-proxy",')
      $bundleDone = $true
    }
  }
  if (-not $depDone) { throw "could not find the dependencies block in $pkgPath" }
  if (-not $bundleDone) { throw "could not find the bundles array in $pkgPath" }
  [System.IO.File]::WriteAllText($pkgPath, ($out -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  Ok "dependency + bundle added"
}

# ---------------------------------------------------------------- 2. node_modules junction
Step "linking the plugin into node_modules"
$nmDir = Join-Path $profileDir 'node_modules'
$linkPath = Join-Path $nmDir 'dsh-workbuddy-proxy'
if (-not (Test-Path -LiteralPath $nmDir)) { New-Item -ItemType Directory -Path $nmDir -Force | Out-Null }
if (Test-Path -LiteralPath $linkPath) {
  Note "already linked - skipped"
} else {
  cmd /c mklink /J "`"$linkPath`"" "`"$PluginDir`"" | Out-Null
  if (-not (Test-Path -LiteralPath $linkPath)) { throw "junction creation failed: $linkPath" }
  Ok "junction created"
}

# ---------------------------------------------------------------- 3. provider route
Step "adding the workbuddyproxy provider route"
$patchText = Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8
if ($patchText -match 'workbuddyproxy') {
  Note "already present - skipped"
} else {
  $plines = Get-Content -LiteralPath $patchPath -Encoding UTF8
  $idx = -1
  $indent = ''
  $inBlock = $false
  for ($i = 0; $i -lt $plines.Count; $i++) {
    if (-not $inBlock) {
      if ($plines[$i] -match '^\s*-\s*id:\s*llm-pi-ai\s*$') { $inBlock = $true }
      continue
    }
    if ($plines[$i] -match '^(\s*)providers:\s*$') {
      $idx = $i
      $indent = $matches[1]
      break
    }
  }
  if ($idx -lt 0) { throw "could not find the llm-pi-ai providers block in $patchPath" }
  $i2 = $indent + '  '
  $block = @(
    ($i2 + 'workbuddyproxy:'),
    ($i2 + '  api: openai-completions'),
    ($i2 + '  baseURL: http://127.0.0.1:' + $Port + '/v1'),
    ($i2 + '  headers:'),
    ($i2 + '    Authorization: Bearer workbuddy-proxy-local'),
    ($i2 + '  models:')
  )
  $models = @(
    @('glm-5.3-flash', 'GLM-5.3-Flash (Proxy)', 131072, 'low: low', 'high: high', 'max: max'),
    @('glm-5.3', 'GLM-5.3 (Proxy)', 64000, 'low: low', 'high: high', 'max: max'),
    @('deepseek-v4.1-flash', 'Deepseek-V4.1-Flash (Proxy)', 128000, 'low: low', 'high: high', 'max: max'),
    @('minimax-m3.1-flash', 'MiniMax-M3.1-Flash (Proxy)', 128000, 'low: low', 'medium: medium', 'high: high', 'max: max'),
    @('kimi-k3-1', 'Kimi-K3 (Proxy)', 32000, 'low: low', 'high: high'),
    @('space-bunny', 'Space-Bunny (Proxy)', 128000, 'low: low', 'high: high', 'max: max')
  )
  foreach ($m in $models) {
    $block += ($i2 + '    - id: ' + $m[0])
    $block += ($i2 + '      name: ' + $m[1])
    $block += ($i2 + '      input:')
    $block += ($i2 + '        - text')
    $block += ($i2 + '        - image')
    $block += ($i2 + '      reasoningEfforts:')
    for ($e = 3; $e -lt $m.Count; $e++) {
      $pair = $m[$e] -split ': '
      $block += ($i2 + '        ' + $pair[0] + ': ' + $pair[1])
    }
    $block += ($i2 + '      contextWindow: 1000000')
    $block += ($i2 + '      maxTokens: ' + $m[2])
  }
  $new = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $plines.Count; $i++) {
    $new.Add($plines[$i])
    if ($i -eq $idx) { foreach ($b in $block) { $new.Add($b) } }
  }
  [System.IO.File]::WriteAllText($patchPath, ($new -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  Ok "provider route added (port $Port)"
}

# ---------------------------------------------------------------- 4. plugin port config
$pluginPatch = Join-Path $PluginDir 'cordis.patch.yml'
if (Test-Path -LiteralPath $pluginPatch) {
  $pt = Get-Content -LiteralPath $pluginPatch -Raw -Encoding UTF8
  if ($pt -notmatch "port:\s*$Port") {
    $pt = [regex]::Replace($pt, 'port:\s*\d+', "port: $Port")
    [System.IO.File]::WriteAllText($pluginPatch, $pt, (New-Object System.Text.UTF8Encoding($false)))
    Ok "plugin port set to $Port"
  }
}

# ---------------------------------------------------------------- 5. fingerprint library
Step "seeding the fingerprint library"
$fpPath = Join-Path $DshHome 'workbuddy-proxy-fingerprints.json'
if (Test-Path -LiteralPath $fpPath) {
  Note "already present - skipped"
} else {
  $fp = @{
    version = 1
    items   = @(
      @{
        id   = 'dsh-repository-file-tools'
        mode = 'tag'
        text = 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @"..." quotes a path containing spaces.'
      }
    )
  }
  $json = $fp | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($fpPath, ($json + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  Ok "written: $fpPath"
}

# ---------------------------------------------------------------- 6. account vault
Step "checking the WorkBuddy account vault"
$vault = Join-Path $DshHome 'workbuddy-vault'
$found = $false
if (Test-Path -LiteralPath $vault) {
  $found = @(Get-ChildItem -LiteralPath $vault -Recurse -Filter *.json -ErrorAction SilentlyContinue).Count -gt 0
}
if ($found) {
  Ok "vault found - the proxy can forward"
} else {
  Warn2 "no account vault under $vault"
  Note "install and sign in the dsh-connect-workbuddy plugin on this machine first,"
  Note "or copy $DshHome\workbuddy-vault from a machine that is already signed in."
}

Write-Host ""
Write-Host "done. next steps:" -ForegroundColor Cyan
Write-Host "  1. restart DSH (the route and the plugin are read at startup)"
Write-Host "  2. check  http://127.0.0.1:$Port/healthz"
Write-Host "  3. pick a model whose name ends with '(Proxy)' in the model picker"
