param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$Pm2AppName = 'metasheet-backend',
  [string]$Pm2Env = 'production'
)

$ErrorActionPreference = 'Stop'
$RetiredSensitiveEnvKeys = @(
  'METASHEET_C6_TEST_FAILURE_INJECTION_ENABLED',
  'INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON'
)

function Resolve-RootDirPath {
  param([string]$Candidate)

  $trimmed = $Candidate.Trim().Trim('"')
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    throw 'RootDir is empty after normalization'
  }

  if (-not (Test-Path -LiteralPath $trimmed)) {
    throw "RootDir does not exist: $trimmed"
  }

  return [System.IO.Path]::GetFullPath($trimmed)
}

$resolvedRoot = Resolve-RootDirPath -Candidate $RootDir
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

  throw "Could not find app.env or docker\app.env under $BaseDir"
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

function Get-AppEnvKeySet {
  param([string]$EnvFile)

  $keys = @{}
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
    if (-not [string]::IsNullOrWhiteSpace($name)) {
      $keys[$name] = $true
    }
  }

  return $keys
}

function Clear-RetiredSensitiveEnvKeysAbsentFromFile {
  param(
    [string[]]$KeyNames,
    [hashtable]$EnvFileKeys
  )

  foreach ($key in $KeyNames) {
    if (-not $EnvFileKeys.ContainsKey($key)) {
      Remove-Item -Path ("Env:{0}" -f $key) -ErrorAction SilentlyContinue
    }
  }
}

function Add-PathEntryIfExists {
  param([string]$PathEntry)

  if ([string]::IsNullOrWhiteSpace($PathEntry) -or -not (Test-Path -LiteralPath $PathEntry)) {
    return
  }

  $currentPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
  $entries = @()
  if (-not [string]::IsNullOrWhiteSpace($currentPath)) {
    $entries = @($currentPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }

  $alreadyPresent = $false
  foreach ($entry in $entries) {
    if ($entry.TrimEnd('\') -ieq $PathEntry.TrimEnd('\')) {
      $alreadyPresent = $true
      break
    }
  }

  if (-not $alreadyPresent) {
    $env:PATH = if ([string]::IsNullOrWhiteSpace($currentPath)) { $PathEntry } else { "$PathEntry;$currentPath" }
  }
}

function Get-WindowsToolPathCandidates {
  $candidates = @()
  $programFiles = [Environment]::GetEnvironmentVariable('ProgramFiles')
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')

  foreach ($base in @($programFiles, $programFilesX86, 'C:\Program Files', 'C:\Program Files (x86)')) {
    if (-not [string]::IsNullOrWhiteSpace($base)) {
      $candidates += (Join-Path $base 'nodejs')
    }
  }

  $npmBases = @($env:APPDATA, 'C:\Users\Administrator\AppData\Roaming')
  if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    $npmBases += (Join-Path $env:USERPROFILE 'AppData\Roaming')
  }

  foreach ($base in $npmBases) {
    if (-not [string]::IsNullOrWhiteSpace($base)) {
      $candidates += (Join-Path $base 'npm')
    }
  }

  $systemRoot = if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { 'C:\Windows' } else { $env:SystemRoot }
  $candidates += @(
    (Join-Path $systemRoot 'System32'),
    $systemRoot
  )

  return $candidates | Select-Object -Unique
}

function Initialize-WindowsSystemToolPath {
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    return
  }

  foreach ($candidate in Get-WindowsToolPathCandidates) {
    Add-PathEntryIfExists -PathEntry $candidate
  }
}

function Set-EnvIfMissing {
  param(
    [string]$Name,
    [string]$Value
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return
  }

  $current = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($current)) {
    Set-Item -Path ("Env:{0}" -f $Name) -Value $Value
  }
}

function Initialize-WindowsSystemProfileEnv {
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    return
  }

  $systemRoot = if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { 'C:\Windows' } else { $env:SystemRoot }
  $systemProfile = Join-Path $systemRoot 'System32\config\systemprofile'
  $profileRoot = if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) { $systemProfile } else { $env:USERPROFILE }
  New-Item -ItemType Directory -Force -Path $profileRoot | Out-Null

  Set-EnvIfMissing -Name 'USERPROFILE' -Value $profileRoot
  Set-EnvIfMissing -Name 'HOME' -Value $profileRoot

  $pathRoot = [System.IO.Path]::GetPathRoot($profileRoot)
  if (-not [string]::IsNullOrWhiteSpace($pathRoot)) {
    $homeDrive = $pathRoot.TrimEnd('\')
    $homePath = $profileRoot.Substring($homeDrive.Length)
    if (-not $homePath.StartsWith('\')) {
      $homePath = '\' + $homePath
    }
    Set-EnvIfMissing -Name 'HOMEDRIVE' -Value $homeDrive
    Set-EnvIfMissing -Name 'HOMEPATH' -Value $homePath
  }

  $pm2Home = if ([string]::IsNullOrWhiteSpace($env:PM2_HOME)) {
    Join-Path $profileRoot '.pm2'
  } else {
    $env:PM2_HOME
  }
  New-Item -ItemType Directory -Force -Path $pm2Home | Out-Null
  Set-EnvIfMissing -Name 'PM2_HOME' -Value $pm2Home
}

function Resolve-Pm2Command {
  param([string]$BaseDir)

  $localPm2 = Join-Path $BaseDir 'node_modules\.bin\pm2.cmd'
  if (Test-Path $localPm2) {
    return $localPm2
  }

  return 'pm2'
}

function ConvertTo-ComparablePath {
  param([string]$Candidate)

  if ([string]::IsNullOrWhiteSpace($Candidate)) {
    return ''
  }

  try {
    return ([System.IO.Path]::GetFullPath($Candidate).TrimEnd('\')).ToLowerInvariant()
  }
  catch {
    return $Candidate.Trim().TrimEnd('\').ToLowerInvariant()
  }
}

function Get-Pm2AppProcess {
  param(
    [string]$Pm2Command,
    [string]$AppName
  )

  $jsonLines = & $Pm2Command jlist 2>$null
  if ($LASTEXITCODE -ne 0) {
    return $null
  }

  $json = ($jsonLines | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($json)) {
    return $null
  }

  try {
    $apps = $json | ConvertFrom-Json
    return @($apps) | Where-Object { $_.name -eq $AppName } | Select-Object -First 1
  }
  catch {
    return $null
  }
}

function Test-Pm2AppMatchesTarget {
  param(
    [object]$App,
    [string]$ExpectedScriptPath,
    [string]$ExpectedCwd
  )

  if ($null -eq $App -or $null -eq $App.pm2_env) {
    return $false
  }

  $actualScriptPath = ConvertTo-ComparablePath -Candidate ([string]$App.pm2_env.pm_exec_path)
  $actualCwd = ConvertTo-ComparablePath -Candidate ([string]$App.pm2_env.pm_cwd)
  $expectedScript = ConvertTo-ComparablePath -Candidate $ExpectedScriptPath
  $expectedRoot = ConvertTo-ComparablePath -Candidate $ExpectedCwd

  return $actualScriptPath -eq $expectedScript -and $actualCwd -eq $expectedRoot
}

function Test-Pm2AppHasRetiredSensitiveEnvKey {
  param(
    [object]$App,
    [string[]]$KeyNames,
    [hashtable]$EnvFileKeys
  )

  if ($null -eq $App -or $null -eq $App.pm2_env) {
    return $false
  }

  foreach ($key in $KeyNames) {
    if ($EnvFileKeys.ContainsKey($key)) {
      continue
    }
    if ($null -ne $App.pm2_env.PSObject.Properties[$key]) {
      return $true
    }
  }

  return $false
}

function Start-Pm2App {
  param(
    [string]$Pm2Command,
    [string]$ConfigPath,
    [string]$AppName,
    [string]$EnvName
  )

  & $Pm2Command start $ConfigPath --only $AppName --env $EnvName --update-env
  if ($LASTEXITCODE -ne 0) {
    throw "pm2 start failed for $AppName"
  }
}

$envFile = Resolve-AppEnvFile -BaseDir $resolvedRoot
$envFileKeys = Get-AppEnvKeySet -EnvFile $envFile
Import-AppEnvFile -EnvFile $envFile
Clear-RetiredSensitiveEnvKeysAbsentFromFile -KeyNames $RetiredSensitiveEnvKeys -EnvFileKeys $envFileKeys
Initialize-WindowsSystemToolPath
Initialize-WindowsSystemProfileEnv

$ecosystemConfig = Join-Path $resolvedRoot 'ecosystem.config.cjs'
if (-not (Test-Path $ecosystemConfig)) {
  throw "ecosystem.config.cjs not found under $resolvedRoot"
}

New-Item -ItemType Directory -Force -Path (Join-Path $resolvedRoot 'output\logs') | Out-Null

$pm2Command = Resolve-Pm2Command -BaseDir $resolvedRoot
$expectedScriptPath = Join-Path $resolvedRoot 'packages\core-backend\dist\src\index.js'
$existingApp = Get-Pm2AppProcess -Pm2Command $pm2Command -AppName $Pm2AppName

if ($null -ne $existingApp) {
  if (Test-Pm2AppHasRetiredSensitiveEnvKey -App $existingApp -KeyNames $RetiredSensitiveEnvKeys -EnvFileKeys $envFileKeys) {
    Write-Host "[attendance-onprem-start-pm2] deleting pm2 app definition for $Pm2AppName to retire sensitive/test-only env keys"
    & $pm2Command delete $Pm2AppName
    if ($LASTEXITCODE -ne 0) {
      throw "pm2 delete failed while retiring env keys for $Pm2AppName"
    }
    Start-Pm2App -Pm2Command $pm2Command -ConfigPath $ecosystemConfig -AppName $Pm2AppName -EnvName $Pm2Env
  }
  elseif (Test-Pm2AppMatchesTarget -App $existingApp -ExpectedScriptPath $expectedScriptPath -ExpectedCwd $resolvedRoot) {
    & $pm2Command restart $Pm2AppName --update-env
    if ($LASTEXITCODE -ne 0) {
      throw "pm2 restart failed for $Pm2AppName"
    }
  }
  else {
    Write-Host "[attendance-onprem-start-pm2] deleting stale pm2 app definition for $Pm2AppName before start"
    & $pm2Command delete $Pm2AppName
    if ($LASTEXITCODE -ne 0) {
      throw "pm2 delete failed for stale $Pm2AppName"
    }
    Start-Pm2App -Pm2Command $pm2Command -ConfigPath $ecosystemConfig -AppName $Pm2AppName -EnvName $Pm2Env
  }
}
else {
  & $pm2Command describe $Pm2AppName *> $null
  if ($LASTEXITCODE -ne 0) {
    Start-Pm2App -Pm2Command $pm2Command -ConfigPath $ecosystemConfig -AppName $Pm2AppName -EnvName $Pm2Env
  }
  else {
    Write-Host "[attendance-onprem-start-pm2] pm2 jlist did not return $Pm2AppName; falling back to restart"
    & $pm2Command restart $Pm2AppName --update-env
    if ($LASTEXITCODE -ne 0) {
      throw "pm2 restart failed for $Pm2AppName"
    }
  }
}

& $pm2Command save
if ($LASTEXITCODE -ne 0) {
  throw 'pm2 save failed'
}

Write-Host "[attendance-onprem-start-pm2] pm2 service is ready: $Pm2AppName"
