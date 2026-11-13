# Uninstall dsh-context-compression-panel from a dsh profile.
#
# Reverses install.ps1 and what the panel changed while running:
#   1. removes the dependency + bundle entries from the profile package.json
#   2. removes both junctions (only when they actually point at this plugin)
#   3. removes the panel's marked config row from the profile patch, so the engine
#      goes back to its own defaults once the plugin is gone
#   4. removes the panel's diagnostic snapshot
# The plugin source folder is never touched.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Profile desktop -DshHome "D:\dsh-home"

param(
  [string]$Profile = 'desktop',
  [string]$DshHome = ''
)

$ErrorActionPreference = 'Continue'
$name = 'dsh-context-compression-panel'
$project = $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DshHome = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) { Join-Path $env:USERPROFILE '.dsh' } else { $env:DSH_HOME }
}

$profileManifest = Join-Path (Join-Path $DshHome 'profiles') (Join-Path $Profile 'package.json')
$nodeModules = Join-Path (Join-Path $DshHome 'profiles') (Join-Path $Profile 'node_modules')
$modLink = Join-Path $nodeModules $name
$pluginsSrc = Join-Path $DshHome 'plugins-src'
$srcLink = Join-Path $pluginsSrc $name

if (Test-Path -LiteralPath $profileManifest -PathType Leaf) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item -LiteralPath $profileManifest -Destination "$profileManifest.bak-$stamp"
  & node (Join-Path $project 'tools\profile-edit.mjs') remove $profileManifest
  if ($LASTEXITCODE -ne 0) {
    Write-Output "写 package.json 失败（exit $LASTEXITCODE），跳过后续删除以免留下半装状态"
    exit 1
  }
} else {
  Write-Output "没找到 $profileManifest，跳过 package.json"
}

foreach ($link in @($modLink, $srcLink)) {
  if (-not (Test-Path -LiteralPath $link)) {
    Write-Output "不存在：$link"
    continue
  }
  $item = Get-Item -LiteralPath $link -Force
  if ($item.LinkType -ne 'Junction') {
    Write-Output "跳过：$link 不是 junction（可能是 pnpm 复制出来的真实目录），请手动确认后再删"
    continue
  }
  $target = $item.Target
  if ($link -eq $modLink) {
    # node_modules 的 junction 指向 plugins-src 下的同名条目，直接删
    [IO.Directory]::Delete($link)
    Write-Output "已删除：$link（-> $target）"
  } else {
    $resolved = (Resolve-Path -LiteralPath $target -ErrorAction SilentlyContinue)
    if ($null -ne $resolved -and $resolved.Path -ne $project) {
      Write-Output "跳过：$link 指向 $target，不是本次的插件目录（$project）"
      continue
    }
    [IO.Directory]::Delete($link)
    Write-Output "已删除：$link（-> $target）"
  }
}

Write-Output ''

# --- the panel's config row in the profile patch ---------------------------
# Only the block between the two markers is removed; every other row stays byte
# for byte, so a hand-written patch is never rewritten wholesale.
$patchFile = Join-Path (Join-Path $DshHome 'profiles') (Join-Path $Profile 'cordis.patch.yml')
$begin = '# dsh-context-compression-panel:begin'
$end = '# dsh-context-compression-panel:end'
if (Test-Path -LiteralPath $patchFile -PathType Leaf) {
  $text = [IO.File]::ReadAllText($patchFile)
  if ($text.Contains($begin)) {
    $beginAt = $text.IndexOf($begin)
    $endAt = $text.IndexOf($end, $beginAt)
    $cut = if ($endAt -ge 0) { $text.Substring($beginAt, $endAt - $beginAt + $end.Length) } else { $text.Substring($beginAt) }
    $tail = $text.Substring($beginAt + $cut.Length)
    if ($tail.StartsWith("`r`n")) { $tail = $tail.Substring(2) } elseif ($tail.StartsWith("`n")) { $tail = $tail.Substring(1) }
    $next = $text.Substring(0, $beginAt) + $tail
    if ($next.Trim() -eq '') { $next = "[]`n" }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item -LiteralPath $patchFile -Destination "$patchFile.bak-$stamp"
    [IO.File]::WriteAllText($patchFile, $next)
    Write-Output "已清除补丁里的面板配置行：$patchFile（备份 $patchFile.bak-$stamp）"
  } else {
    Write-Output "补丁里没有面板配置行，跳过：$patchFile"
  }
} else {
  Write-Output "没找到 $patchFile，跳过"
}

$diagFile = Join-Path (Join-Path $DshHome 'profiles') (Join-Path $Profile '.context-compression-panel.diag.json')
if (Test-Path -LiteralPath $diagFile -PathType Leaf) {
  Remove-Item -LiteralPath $diagFile -Force
  Write-Output "已删除诊断快照：$diagFile"
}

Write-Output ''
Write-Output '卸载完成。完全退出 DSH Desktop 再打开，面板就会消失。'
