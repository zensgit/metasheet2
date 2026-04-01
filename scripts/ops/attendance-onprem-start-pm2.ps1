param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$Pm2AppName = 'metasheet-backend',
  [string]$Pm2Env = 'production'
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = (Resolve-Path $RootDir).Path
Set-Location $resolvedRoot

function Resolve-AppEnvFile {
  param([string]$BaseDir)

  $candidates = @(
    (Join-Path $BaseDir 'app.env'),
    (Join-Path $BaseDir 'docker\app.env')
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  throw "Could not find app.env or docker\\app.env under $BaseDir"
}

function Import-AppEnvFile {
  param([string]$EnvFile)

  foreach ($rawLine in Get-Content -Path $EnvFile) {
    $line = $rawLine.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) {
      continue
    }

    $parts = $line -split '=', 2
    if ($parts.Length -ne 2) {
      continue
    }

    $name = $parts[0].Trim()
    $value = $parts[1].Trim()

    if ($value.Length -ge 2) {
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }

    Set-Item -Path ("Env:{0}" -f $name) -Value $value
  }
}

function Resolve-Pm2Command {
  param([string]$BaseDir)

  $localPm2 = Join-Path $BaseDir 'node_modules\.bin\pm2.cmd'
  if (Test-Path $localPm2) {
    return $localPm2
  }

  return 'pm2'
}

$envFile = Resolve-AppEnvFile -BaseDir $resolvedRoot
Import-AppEnvFile -EnvFile $envFile

$ecosystemConfig = Join-Path $resolvedRoot 'ecosystem.config.cjs'
if (-not (Test-Path $ecosystemConfig)) {
  throw "ecosystem.config.cjs not found under $resolvedRoot"
}

New-Item -ItemType Directory -Force -Path (Join-Path $resolvedRoot 'output\logs') | Out-Null

$pm2Command = Resolve-Pm2Command -BaseDir $resolvedRoot

& $pm2Command describe $Pm2AppName *> $null
if ($LASTEXITCODE -eq 0) {
  & $pm2Command restart $Pm2AppName --update-env
  if ($LASTEXITCODE -ne 0) {
    throw "pm2 restart failed for $Pm2AppName"
  }
}
else {
  & $pm2Command start $ecosystemConfig --only $Pm2AppName --env $Pm2Env --update-env
  if ($LASTEXITCODE -ne 0) {
    throw "pm2 start failed for $Pm2AppName"
  }
}

& $pm2Command save
if ($LASTEXITCODE -ne 0) {
  throw 'pm2 save failed'
}

Write-Host "[attendance-onprem-start-pm2] pm2 service is ready: $Pm2AppName"
