param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$SourceDir = '',
  [string]$TargetDir = ''
)

$ErrorActionPreference = 'Stop'

function Resolve-ExistingDirectory {
  param(
    [string]$Candidate,
    [string]$Label
  )

  $trimmed = $Candidate.Trim().Trim('"')
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    throw "$Label is empty after normalization"
  }

  if (-not (Test-Path -LiteralPath $trimmed -PathType Container)) {
    throw "$Label does not exist: $trimmed"
  }

  return [System.IO.Path]::GetFullPath($trimmed)
}

function Resolve-WebDistSource {
  param([string]$BaseDir)

  if (-not [string]::IsNullOrWhiteSpace($SourceDir)) {
    return Resolve-ExistingDirectory -Candidate $SourceDir -Label 'SourceDir'
  }

  if (-not [string]::IsNullOrWhiteSpace($env:WEB_DIST_SOURCE)) {
    return Resolve-ExistingDirectory -Candidate $env:WEB_DIST_SOURCE -Label 'WEB_DIST_SOURCE'
  }

  return Resolve-ExistingDirectory -Candidate (Join-Path $BaseDir 'apps\web\dist') -Label 'web dist source'
}

function Resolve-WebDistTarget {
  param([string]$BaseDir)

  if (-not [string]::IsNullOrWhiteSpace($TargetDir)) {
    return [System.IO.Path]::GetFullPath($TargetDir.Trim().Trim('"'))
  }

  if (-not [string]::IsNullOrWhiteSpace($env:WEB_DIST_TARGET)) {
    return [System.IO.Path]::GetFullPath($env:WEB_DIST_TARGET.Trim().Trim('"'))
  }

  $rootInfo = Get-Item -LiteralPath $BaseDir
  $parent = $rootInfo.Parent
  if ($parent -and $parent.Name -eq 'packages') {
    $deployRoot = $parent.Parent.FullName
    return [System.IO.Path]::GetFullPath((Join-Path $deployRoot 'apps\web\dist'))
  }

  if ($parent -and $parent.Parent -and $parent.Parent.Name -eq 'packages') {
    $deployRoot = $parent.Parent.Parent.FullName
    return [System.IO.Path]::GetFullPath((Join-Path $deployRoot 'apps\web\dist'))
  }

  return [System.IO.Path]::GetFullPath((Join-Path $BaseDir 'apps\web\dist'))
}

function Test-SamePath {
  param(
    [string]$Left,
    [string]$Right
  )

  if (-not (Test-Path -LiteralPath $Left -PathType Container)) {
    return $false
  }
  if (-not (Test-Path -LiteralPath $Right -PathType Container)) {
    return $false
  }

  $leftFull = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Left).Path).TrimEnd('\', '/')
  $rightFull = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Right).Path).TrimEnd('\', '/')
  return $leftFull.Equals($rightFull, [System.StringComparison]::OrdinalIgnoreCase)
}

$resolvedRoot = Resolve-ExistingDirectory -Candidate $RootDir -Label 'RootDir'
$source = Resolve-WebDistSource -BaseDir $resolvedRoot
$target = Resolve-WebDistTarget -BaseDir $resolvedRoot

$sourceIndex = Join-Path $source 'index.html'
if (-not (Test-Path -LiteralPath $sourceIndex -PathType Leaf)) {
  throw "Missing web dist source index.html: $sourceIndex"
}

if (Test-SamePath -Left $source -Right $target) {
  Write-Host "[attendance-onprem-publish-web-dist] Web dist already at nginx root: $target"
  exit 0
}

$targetParent = Split-Path -Parent $target
New-Item -ItemType Directory -Force -Path $targetParent | Out-Null

$tmpTarget = Join-Path $targetParent ('.web-dist.tmp.' + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmpTarget | Out-Null

try {
  Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $tmpTarget -Recurse -Force
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  Move-Item -LiteralPath $tmpTarget -Destination $target
}
catch {
  if (Test-Path -LiteralPath $tmpTarget) {
    Remove-Item -LiteralPath $tmpTarget -Recurse -Force -ErrorAction SilentlyContinue
  }
  throw
}

Write-Host '[attendance-onprem-publish-web-dist] Published web dist'
Write-Host "  source: $source"
Write-Host "  target: $target"
