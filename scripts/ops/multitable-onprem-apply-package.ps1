param(
  [Parameter(Mandatory = $true)]
  [string]$PackageArchive,
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$EnvFile = '',
  [string]$ApiBase = 'http://127.0.0.1/api',
  [string]$BaseUrl = 'http://127.0.0.1',
  [string]$CheckNginx = '1',
  [string]$RunHealthcheck = '1',
  [string]$InstallDeps = '1',
  [string]$BuildWeb = '0',
  [string]$BuildBackend = '0',
  [string]$RunMigrations = '1',
  [string]$RestartService = '1'
)

$ErrorActionPreference = 'Stop'

function Resolve-NormalizedPath {
  param(
    [string]$Candidate,
    [string]$Label = 'Path'
  )

  $trimmed = $Candidate.Trim().Trim('"')
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    throw "$Label is empty after normalization"
  }

  if (-not (Test-Path -LiteralPath $trimmed)) {
    throw "$Label does not exist: $trimmed"
  }

  return [System.IO.Path]::GetFullPath($trimmed)
}

function Write-Info {
  param([string]$Message)
  Write-Host "[multitable-onprem-apply-package] $Message"
}

function Require-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Invoke-CheckedCommand {
  param(
    [string]$Description,
    [scriptblock]$Command
  )

  Write-Info $Description
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed"
  }
}

function Expand-PackageArchive {
  param(
    [string]$ArchivePath,
    [string]$TargetDir
  )

  $archiveLower = $ArchivePath.ToLowerInvariant()
  if ($archiveLower.EndsWith('.zip')) {
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $TargetDir -Force
    return
  }

  if ($archiveLower.EndsWith('.tgz') -or $archiveLower.EndsWith('.tar.gz')) {
    Require-Command -Name 'tar'
    Invoke-CheckedCommand "Extract package archive via tar ($ArchivePath)" {
      tar -xzf $ArchivePath -C $TargetDir
    }
    return
  }

  throw "Unsupported package extension (expected .zip, .tgz, or .tar.gz): $ArchivePath"
}

function Invoke-Healthcheck {
  param([string]$Url)

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 20
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  }
  catch {
    return $false
  }
}

$resolvedRoot = Resolve-NormalizedPath -Candidate $RootDir -Label 'RootDir'
$resolvedArchive = Resolve-NormalizedPath -Candidate $PackageArchive -Label 'PackageArchive'
$resolvedEnvFile = if ([string]::IsNullOrWhiteSpace($EnvFile)) {
  Join-Path $resolvedRoot 'docker\app.env'
} else {
  Resolve-NormalizedPath -Candidate $EnvFile -Label 'EnvFile'
}

if (-not (Test-Path -LiteralPath $resolvedEnvFile)) {
  throw "EnvFile not found: $resolvedEnvFile"
}

$outputLogs = Join-Path $resolvedRoot 'output\logs'
$extractParent = Join-Path $resolvedRoot 'output\deploy'
New-Item -ItemType Directory -Force -Path $outputLogs | Out-Null
New-Item -ItemType Directory -Force -Path $extractParent | Out-Null

$extractRoot = Join-Path $extractParent ("package-apply-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

try {
  Write-Info "Package archive: $resolvedArchive"
  Write-Info "Deploy root: $resolvedRoot"
  Write-Info "Extract root: $extractRoot"

  Expand-PackageArchive -ArchivePath $resolvedArchive -TargetDir $extractRoot

  $packageRoot = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
  if (-not $packageRoot) {
    throw "Failed to locate extracted package root in $extractRoot"
  }

  foreach ($item in Get-ChildItem -LiteralPath $packageRoot.FullName -Force) {
    Copy-Item -LiteralPath $item.FullName -Destination $resolvedRoot -Recurse -Force
  }

  Set-Location $resolvedRoot

  Require-Command -Name 'node'
  Require-Command -Name 'pnpm'

  if ($InstallDeps -ne '0' -and -not (Test-Path -LiteralPath (Join-Path $resolvedRoot 'node_modules'))) {
    Invoke-CheckedCommand 'Install dependencies (pnpm install --frozen-lockfile)' {
      pnpm install --frozen-lockfile
    }
  }

  if ($RunMigrations -ne '0') {
    $migratePath = Join-Path $resolvedRoot 'packages\core-backend\dist\src\db\migrate.js'
    if (-not (Test-Path -LiteralPath $migratePath)) {
      throw "Missing backend migration entrypoint: $migratePath"
    }
    Invoke-CheckedCommand "Run database migrations ($migratePath)" {
      node $migratePath
    }
  }

  if ($RestartService -ne '0') {
    $startScript = Join-Path $resolvedRoot 'scripts\ops\attendance-onprem-start-pm2.ps1'
    if (-not (Test-Path -LiteralPath $startScript)) {
      throw "Missing PM2 startup helper: $startScript"
    }

    Write-Info 'Start or restart PM2 service'
    & $startScript -RootDir $resolvedRoot
    if ($LASTEXITCODE -ne 0) {
      throw 'pm2 startup failed'
    }
  }

  if ($RunHealthcheck -ne '0') {
    $healthUrl = ($BaseUrl.TrimEnd('/')) + '/health'
    $pluginsUrl = ($ApiBase.TrimEnd('/')) + '/plugins'
    if (-not (Invoke-Healthcheck -Url $healthUrl) -and -not (Invoke-Healthcheck -Url $pluginsUrl)) {
      throw "Healthcheck failed for $healthUrl and $pluginsUrl"
    }
    Write-Info "Healthcheck OK ($healthUrl or $pluginsUrl)"
  }

  Write-Info "Package deploy complete"
  Write-Info "Archive applied: $resolvedArchive"
  Write-Info "Root: $resolvedRoot"
}
finally {
  if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
