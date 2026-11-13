# Install dsh-context-compression-panel into a dsh profile.
#
# What this changes on disk (all reversible, see uninstall.ps1):
#   1. <DSH_HOME>\plugins-src\dsh-context-compression-panel  -> junction to this folder
#   2. <DSH_HOME>\profiles\<profile>\node_modules\dsh-context-compression-panel -> junction
#   3. <profile>\package.json: one dependency entry + one bundle entry (backed up first)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Profile desktop -DshHome "D:\dsh-home"

param(
  [string]$Profile = 'desktop',
  [string]$DshHome = ''
)

$ErrorActionPreference = 'Stop'
$name = 'dsh-context-compression-panel'
$project = $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DshHome = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) { Join-Path $env:USERPROFILE '.dsh' } else { $env:DSH_HOME }
}

$manifest = Join-Path $project 'package.json'
$client = Join-Path $project 'lib\client.js'
foreach ($required in @($manifest, $client)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "插件文件不完整，缺少：$required"
  }
}

$profiles = Join-Path $DshHome 'profiles'
$profileDir = Join-Path $profiles $Profile
$profileManifest = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $profileManifest -PathType Leaf)) {
  throw "找不到 profile：$profileManifest（确认 DSH_HOME 与 -Profile 名称）"
}

Write-Output "插件目录 : $project"
Write-Output "DSH_HOME : $DshHome"
Write-Output "Profile  : $Profile"

# --- 1. plugins-src junction (the space-free path the dependency spec points at)
$pluginsSrc = Join-Path $DshHome 'plugins-src'
if (-not (Test-Path -LiteralPath $pluginsSrc -PathType Container)) {
  New-Item -ItemType Directory -Path $pluginsSrc | Out-Null
}
$srcLink = Join-Path $pluginsSrc $name
if (Test-Path -LiteralPath $srcLink) {
  $existing = (Get-Item -LiteralPath $srcLink).Target
  Write-Output "已存在：$srcLink（指向 $existing），保持不变"
} else {
  New-Item -ItemType Junction -Path $srcLink -Target $project | Out-Null
  Write-Output "已创建 junction：$srcLink -> $project"
}

# --- 2. profile node_modules junction
$nodeModules = Join-Path $profileDir 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) {
  throw "找不到 $nodeModules —— 该 profile 还没有安装过依赖，先在 DSH 里打开一次或安装一个插件"
}
$modLink = Join-Path $nodeModules $name
if (Test-Path -LiteralPath $modLink) {
  $existing = (Get-Item -LiteralPath $modLink).Target
  Write-Output "已存在：$modLink（指向 $existing），保持不变"
} else {
  New-Item -ItemType Junction -Path $modLink -Target $srcLink | Out-Null
  Write-Output "已创建 junction：$modLink -> $srcLink"
}

# --- 3. profile package.json (dependency + bundle entry)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$profileManifest.bak-$stamp"
Copy-Item -LiteralPath $profileManifest -Destination $backup
Write-Output "已备份：$backup"

& node (Join-Path $project 'tools\profile-edit.mjs') add $profileManifest
if ($LASTEXITCODE -ne 0) {
  throw "写 profile package.json 失败（exit $LASTEXITCODE）。备份在 $backup"
}

# --- 4. verification
$check = Get-Content -LiteralPath $profileManifest -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not ($check.dsh.profile.bundles -contains $name)) {
  throw "校验失败：dsh.profile.bundles 里没有 $name"
}
if ($null -eq $check.dependencies.$name) {
  throw "校验失败：dependencies 里没有 $name"
}
Write-Output '校验通过：dependency 与 bundle 都已写入'

$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'DeepSeek Harness' }
Write-Output ''
if ($null -ne $running) {
  Write-Output '注意：DSH Desktop 正在运行。客户端插件在启动时组合加载，'
  Write-Output '请「完全退出 DSH Desktop」再重新打开，面板才会出现。'
} else {
  Write-Output '装好了。启动 DSH Desktop 后面板就会出现。'
}
Write-Output ''
Write-Output '装好后：对话输入框右侧会出现一个「压缩 High」小胶囊；点它展开面板。'
Write-Output '卸载： powershell -ExecutionPolicy Bypass -File uninstall.ps1'
