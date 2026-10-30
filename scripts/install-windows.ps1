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
  [int]$Port = 14577,
  [string]$Vault = ''
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
# 词表在仓库里（lib/known-fingerprints.json，单一事实来源），这里只负责**合并**：
# 同 id 就地更新、新 id 追加、用户自己加的条目保留、仓库取代掉的旧 id 移除。
#
# 旧实现是「文件存在就跳过」—— 已安装的用户永远拿不到新词条，而闸门是会变的
# （2026-10-30 就实测出宿主身份句这条新闸门，漏掉它 = 整轮 400）。
Step "syncing the fingerprint library"
$fpPath = Join-Path $DshHome 'workbuddy-proxy-fingerprints.json'
$knownPath = Join-Path $PluginDir 'lib\known-fingerprints.json'
if (-not (Test-Path -LiteralPath $knownPath)) { throw "missing fingerprint list: $knownPath" }

$knownDoc = Get-Content -LiteralPath $knownPath -Raw -Encoding UTF8 | ConvertFrom-Json
$knownItems = @($knownDoc.items)
$superseded = @()
if ($knownDoc.PSObject.Properties.Name -contains 'supersedes') { $superseded = @($knownDoc.supersedes) }

$doc = @{ version = 2; items = @() }
if (Test-Path -LiteralPath $fpPath) {
  try {
    $parsed = Get-Content -LiteralPath $fpPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $kept = @()
    if ($null -ne $parsed -and ($parsed.PSObject.Properties.Name -contains 'items')) {
      foreach ($it in @($parsed.items)) {
        if ($null -eq $it) { continue }
        if ($superseded -contains [string]$it.id) { continue }
        $kept += $it
      }
    }
    $doc = @{ version = 2; items = $kept }
  } catch {
    Warn2 "existing fingerprint file is not valid JSON - it will be replaced"
    $doc = @{ version = 2; items = @() }
  }
}

$byId = @{}
$texts = @{}
foreach ($it in @($doc.items)) {
  $byId[[string]$it.id] = $it
  $texts[[string]$it.text] = $true
}

$added = 0
$updated = 0
foreach ($k in $knownItems) {
  $entry = @{ id = [string]$k.id; mode = [string]$k.mode; text = [string]$k.text }
  if (($k.PSObject.Properties.Name -contains 'replace') -and [string]$k.replace -ne '') {
    $entry['replace'] = [string]$k.replace
  }
  if ($byId.ContainsKey([string]$k.id)) {
    $old = $byId[[string]$k.id]
    $old | Add-Member -NotePropertyName 'mode' -NotePropertyValue $entry.mode -Force
    $old | Add-Member -NotePropertyName 'text' -NotePropertyValue $entry.text -Force
    if ($entry.ContainsKey('replace')) {
      $old | Add-Member -NotePropertyName 'replace' -NotePropertyValue $entry['replace'] -Force
    } elseif ($old.PSObject.Properties.Name -contains 'replace') {
      $old.PSObject.Properties.Remove('replace')
    }
    $updated += 1
    continue
  }
  if ($texts.ContainsKey([string]$k.text)) { continue }
  $doc.items = @($doc.items) + $entry
  $byId[[string]$k.id] = $entry
  $texts[[string]$k.text] = $true
  $added += 1
}

$json = $doc | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($fpPath, ($json + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Ok "fingerprints synced: $($doc.items.Count) item(s) (+$added new, ~$updated updated) -> $fpPath"

# ---------------------------------------------------------------- 6. account vault
Step "checking the WorkBuddy account vault"
$vaultDir = Join-Path $DshHome 'workbuddy-vault'

# 6a. 可选：从另一台机器导入账号库（无法在本机登录时用）
if ($Vault -ne '') {
  $src = (Resolve-Path -LiteralPath $Vault).Path
  $srcVault = if (Test-Path -LiteralPath (Join-Path $src 'workbuddy-vault')) { Join-Path $src 'workbuddy-vault' } else { $src }
  $have = @(Get-ChildItem -LiteralPath $srcVault -Recurse -Filter *.json -ErrorAction SilentlyContinue).Count
  if ($have -eq 0) {
    Warn2 "no *.json under $srcVault - nothing imported"
  } else {
    New-Item -ItemType Directory -Path $vaultDir -Force | Out-Null
    Copy-Item -Path (Join-Path $srcVault '*') -Destination $vaultDir -Recurse -Force
    Ok "imported $have account record(s) from $srcVault"
  }
}

$found = $false
if (Test-Path -LiteralPath $vaultDir) {
  $found = @(Get-ChildItem -LiteralPath $vaultDir -Recurse -Filter *.json -ErrorAction SilentlyContinue).Count -gt 0
}
if ($found) {
  Ok "vault found - the proxy can forward"
} else {
  Warn2 "no account vault under $vaultDir"
  Note "the dsh-connect-workbuddy plugin only writes the vault AFTER you sign in."
  Note "do this on this machine:"
  Note "  a) open the WorkBuddy plugin in DSH and sign in with the account; or"
  Note "  b) copy the vault from a signed-in machine and re-run with -Vault <that path>:"
  Note "     install.bat -Vault C:\Users\other\.dsh\workbuddy-vault"
  Note "     (the proxy forwards with that account; the tokens refresh themselves)"
}

Write-Host ""
Write-Host "done. next steps:" -ForegroundColor Cyan
Write-Host "  1. restart DSH (the route and the plugin are read at startup)"
Write-Host "  2. check  http://127.0.0.1:$Port/healthz"
Write-Host "  3. pick a model whose name ends with '(Proxy)' in the model picker"
