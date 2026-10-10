param(
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$EnvFile = '',
  [string]$ApiBase = 'http://127.0.0.1/api',
  [string]$PsqlPath = '',
  [string]$AdminEmail = '',
  [string]$AdminPassword = '',
  [string]$AdminName = 'Administrator',
  [string]$VerifyLogin = '1'
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
  Write-Host "[multitable-onprem-bootstrap-admin] $Message"
}

function Require-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Resolve-Setting {
  param(
    [string]$Value,
    [string]$EnvName,
    [string]$DefaultValue = ''
  )

  if (-not [string]::IsNullOrWhiteSpace($Value)) {
    return $Value
  }

  $envValue = [System.Environment]::GetEnvironmentVariable($EnvName)
  if (-not [string]::IsNullOrWhiteSpace($envValue)) {
    return $envValue
  }

  return $DefaultValue
}

function Require-StrongJwtSecret {
  param(
    [string]$Secret,
    [string]$ResolvedEnvFile
  )

  if ([string]::IsNullOrWhiteSpace($Secret)) {
    throw "JWT_SECRET is missing in $ResolvedEnvFile"
  }

  switch ($Secret) {
    'change-me' { throw "JWT_SECRET uses an insecure placeholder/default value in $ResolvedEnvFile" }
    'change-me-in-production' { throw "JWT_SECRET uses an insecure placeholder/default value in $ResolvedEnvFile" }
    'test' { throw "JWT_SECRET uses an insecure placeholder/default value in $ResolvedEnvFile" }
    'dev-secret' { throw "JWT_SECRET uses an insecure placeholder/default value in $ResolvedEnvFile" }
    'dev-secret-key' { throw "JWT_SECRET uses an insecure placeholder/default value in $ResolvedEnvFile" }
    'fallback-development-secret-change-in-production' { throw "JWT_SECRET uses an insecure placeholder/default value in $ResolvedEnvFile" }
    'your-secret-key-here' { throw "JWT_SECRET uses an insecure placeholder/default value in $ResolvedEnvFile" }
    'your-dev-secret-key-here' { throw "JWT_SECRET uses an insecure placeholder/default value in $ResolvedEnvFile" }
  }

  if ($Secret.Length -lt 32) {
    throw "JWT_SECRET must be at least 32 characters in $ResolvedEnvFile"
  }
}

function Require-BcryptSaltRounds {
  param(
    [string]$Rounds,
    [string]$ResolvedEnvFile
  )

  if ([string]::IsNullOrWhiteSpace($Rounds)) {
    throw "BCRYPT_SALT_ROUNDS must be set in $ResolvedEnvFile or environment"
  }

  if ($Rounds -notmatch '^[0-9]+$') {
    throw "BCRYPT_SALT_ROUNDS must be numeric (got: $Rounds)"
  }

  if ([int]$Rounds -lt 12) {
    throw "BCRYPT_SALT_ROUNDS must be >= 12 for production (got: $Rounds)"
  }
}

function Import-AppEnvFile {
  param([string]$ResolvedEnvFile)

  foreach ($rawLine in Get-Content -Path $ResolvedEnvFile) {
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

    [System.Environment]::SetEnvironmentVariable($name, $value)
  }
}

function Invoke-NodeCapture {
  param(
    [string]$Description,
    [string]$Script,
    [string[]]$Arguments = @()
  )

  Write-Info $Description
  $tempRoot = if ($script:resolvedRoot -and -not [string]::IsNullOrWhiteSpace($script:resolvedRoot)) {
    Join-Path $script:resolvedRoot '.tmp\node-bootstrap'
  } else {
    Join-Path ([System.IO.Path]::GetTempPath()) 'metasheet-node-bootstrap'
  }
  [System.IO.Directory]::CreateDirectory($tempRoot) | Out-Null
  $tempScriptPath = Join-Path $tempRoot (([System.IO.Path]::GetRandomFileName()) + '.cjs')
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $normalizedScript = @'
process.argv.splice(1, 1);
'@ + "`n" + $Script
  [System.IO.File]::WriteAllText($tempScriptPath, $normalizedScript, $utf8NoBom)

  try {
    $output = & node $tempScriptPath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$Description failed"
    }
  } finally {
    Remove-Item -LiteralPath $tempScriptPath -Force -ErrorAction SilentlyContinue
  }

  return ($output | Out-String).Trim()
}

function Resolve-PsqlCandidate {
  param([string]$Candidate)

  if ([string]::IsNullOrWhiteSpace($Candidate)) {
    return $null
  }

  $trimmed = $Candidate.Trim().Trim('"')
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    return $null
  }

  if (Test-Path -LiteralPath $trimmed -PathType Container) {
    $trimmed = Join-Path $trimmed 'psql.exe'
  }

  if (Test-Path -LiteralPath $trimmed -PathType Leaf) {
    return [System.IO.Path]::GetFullPath($trimmed)
  }

  return $null
}

function Resolve-PsqlCommand {
  param([string]$ExplicitPath = '')

  $overrideCandidates = @(
    $ExplicitPath,
    [System.Environment]::GetEnvironmentVariable('PSQL_PATH'),
    [System.Environment]::GetEnvironmentVariable('POSTGRES_BIN_DIR'),
    [System.Environment]::GetEnvironmentVariable('PG_BIN')
  )

  foreach ($candidate in $overrideCandidates) {
    $resolved = Resolve-PsqlCandidate -Candidate $candidate
    if ($resolved) {
      return $resolved
    }
  }

  $command = Get-Command 'psql' -ErrorAction SilentlyContinue
  if ($command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
    return $command.Source
  }

  $searchRoots = @(
    'C:\Program Files\PostgreSQL',
    'C:\Program Files (x86)\PostgreSQL',
    [System.Environment]::ExpandEnvironmentVariables('%ProgramFiles%\PostgreSQL'),
    [System.Environment]::ExpandEnvironmentVariables('%ProgramFiles(x86)%\PostgreSQL')
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

  foreach ($root in $searchRoots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
      continue
    }

    $versionDirs = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
    foreach ($dir in $versionDirs) {
      $resolved = Resolve-PsqlCandidate -Candidate (Join-Path $dir.FullName 'bin')
      if ($resolved) {
        return $resolved
      }
    }
  }

  $chocoResolved = Resolve-PsqlCandidate -Candidate 'C:\ProgramData\chocolatey\bin\psql.exe'
  if ($chocoResolved) {
    return $chocoResolved
  }

  throw 'Missing required command: psql. Add PostgreSQL bin to PATH or set PSQL_PATH / POSTGRES_BIN_DIR.'
}

function Invoke-PsqlCapture {
  param(
    [string]$Description,
    [string]$PsqlCommand,
    [string]$DatabaseUrl,
    [string]$Sql,
    [string[]]$Variables = @(),
    [switch]$TrimOutput
  )

  Write-Info $Description
  $psqlArgs = @($DatabaseUrl, '-v', 'ON_ERROR_STOP=1', '-X', '-A', '-t')
  foreach ($entry in $Variables) {
    $psqlArgs += '-v'
    $psqlArgs += $entry
  }

  $output = $Sql | & $PsqlCommand @psqlArgs
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed"
  }

  if ($TrimOutput) {
    return ($output | Out-String).Trim()
  }

  return $output
}

$resolvedRoot = Resolve-NormalizedPath -Candidate $RootDir -Label 'RootDir'
$resolvedEnvFile = if ([string]::IsNullOrWhiteSpace($EnvFile)) {
  Join-Path $resolvedRoot 'docker\app.env'
} else {
  Resolve-NormalizedPath -Candidate $EnvFile -Label 'EnvFile'
}

if (-not (Test-Path -LiteralPath $resolvedEnvFile)) {
  throw "EnvFile not found: $resolvedEnvFile"
}

$resolvedAdminEmail = Resolve-Setting -Value $AdminEmail -EnvName 'ADMIN_EMAIL'
$resolvedAdminPassword = Resolve-Setting -Value $AdminPassword -EnvName 'ADMIN_PASSWORD'
$resolvedAdminName = Resolve-Setting -Value $AdminName -EnvName 'ADMIN_NAME' -DefaultValue 'Administrator'
$resolvedApiBase = Resolve-Setting -Value $ApiBase -EnvName 'API_BASE' -DefaultValue 'http://127.0.0.1/api'
$resolvedVerifyLogin = Resolve-Setting -Value $VerifyLogin -EnvName 'VERIFY_LOGIN' -DefaultValue '1'

if ([string]::IsNullOrWhiteSpace($resolvedAdminEmail)) {
  throw 'ADMIN_EMAIL is required'
}

if ([string]::IsNullOrWhiteSpace($resolvedAdminPassword)) {
  throw 'ADMIN_PASSWORD is required'
}

if ($resolvedAdminPassword.Length -lt 12) {
  throw 'ADMIN_PASSWORD must be at least 12 characters for production'
}

Set-Location $resolvedRoot
Require-Command -Name 'node'
$resolvedPsqlCommand = Resolve-PsqlCommand -ExplicitPath $PsqlPath

Import-AppEnvFile -ResolvedEnvFile $resolvedEnvFile

$databaseUrl = [System.Environment]::GetEnvironmentVariable('DATABASE_URL')
if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
  throw "DATABASE_URL missing in $resolvedEnvFile"
}

$jwtSecret = [System.Environment]::GetEnvironmentVariable('JWT_SECRET')
Require-StrongJwtSecret -Secret $jwtSecret -ResolvedEnvFile $resolvedEnvFile

$configuredRounds = [System.Environment]::GetEnvironmentVariable('BCRYPT_SALT_ROUNDS')
$bcryptSaltRounds = if ([string]::IsNullOrWhiteSpace($configuredRounds)) { '12' } else { $configuredRounds }
Require-BcryptSaltRounds -Rounds $bcryptSaltRounds -ResolvedEnvFile $resolvedEnvFile

$requireToken = [System.Environment]::GetEnvironmentVariable('ATTENDANCE_IMPORT_REQUIRE_TOKEN')
if ($requireToken -ne '1') {
  throw "ATTENDANCE_IMPORT_REQUIRE_TOKEN must be 1 in $resolvedEnvFile"
}

$uuidScript = @'
console.log(require("node:crypto").randomUUID());
'@
$generatedUserId = Invoke-NodeCapture -Description 'Generate admin user id' -Script $uuidScript

$bcryptScript = @'
const bcrypt = require("bcryptjs");
const rounds = Number(process.argv[1]);
const password = process.argv[2];
process.stdout.write(bcrypt.hashSync(password, rounds));
'@
$passwordHash = Invoke-NodeCapture -Description "Generate bcrypt password hash ($bcryptSaltRounds rounds)" -Script $bcryptScript -Arguments @($bcryptSaltRounds, $resolvedAdminPassword)
if ([string]::IsNullOrWhiteSpace($passwordHash)) {
  throw 'Failed to generate bcrypt password hash'
}

$upsertSql = @'
WITH upserted AS (
  INSERT INTO users (id, email, name, password_hash, role, permissions, is_admin, is_active, created_at, updated_at)
  VALUES (
    :'v_user_id',
    :'v_email',
    :'v_name',
    :'v_password_hash',
    'admin',
    '[]'::jsonb,
    true,
    true,
    NOW(),
    NOW()
  )
  ON CONFLICT (email) DO UPDATE
  SET
    name = EXCLUDED.name,
    password_hash = EXCLUDED.password_hash,
    role = 'admin',
    is_admin = true,
    is_active = true,
    updated_at = NOW()
  RETURNING id
)
SELECT id FROM upserted LIMIT 1;
'@

$adminUserId = Invoke-PsqlCapture -Description "Upsert admin user ($resolvedAdminEmail)" -PsqlCommand $resolvedPsqlCommand -DatabaseUrl $databaseUrl -Sql $upsertSql -Variables @(
  "v_user_id=$generatedUserId",
  "v_email=$resolvedAdminEmail",
  "v_name=$resolvedAdminName",
  "v_password_hash=$passwordHash"
) -TrimOutput

if ([string]::IsNullOrWhiteSpace($adminUserId)) {
  throw 'Failed to resolve admin user id'
}

$grantSql = @'
INSERT INTO user_roles (user_id, role_id)
VALUES (:'v_user_id', 'admin')
ON CONFLICT (user_id, role_id) DO NOTHING;

INSERT INTO user_permissions (user_id, permission_code)
SELECT :'v_user_id', p.code
FROM permissions p
WHERE p.code IN (
  'attendance:read',
  'attendance:write',
  'attendance:approve',
  'attendance:admin',
  'permissions:read',
  'permissions:write',
  'roles:read',
  'roles:write'
)
ON CONFLICT (user_id, permission_code) DO NOTHING;
'@

[void](Invoke-PsqlCapture -Description "Grant admin roles and permissions ($adminUserId)" -PsqlCommand $resolvedPsqlCommand -DatabaseUrl $databaseUrl -Sql $grantSql -Variables @(
  "v_user_id=$adminUserId"
))

$adminSessionToken = ''
if ($resolvedVerifyLogin -eq '1') {
  $loginBody = @{
    email = $resolvedAdminEmail
    password = $resolvedAdminPassword
  } | ConvertTo-Json -Compress

  try {
    Write-Info "Verify admin login via $resolvedApiBase/auth/login"
    $response = Invoke-WebRequest -UseBasicParsing -Uri (($resolvedApiBase.TrimEnd('/')) + '/auth/login') -Method Post -ContentType 'application/json' -Body $loginBody -TimeoutSec 30
    if ($response.StatusCode -ne 200) {
      throw "Admin login verification failed (HTTP $($response.StatusCode))"
    }
    try {
      $loginPayload = $response.Content | ConvertFrom-Json
      if ($loginPayload.data -and $loginPayload.data.token) {
        $adminSessionToken = [string]$loginPayload.data.token
      } elseif ($loginPayload.token) {
        $adminSessionToken = [string]$loginPayload.token
      }
    } catch {
      $adminSessionToken = ''
    }
  }
  catch {
    $statusCode = 0
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $statusCode = [int]$_.Exception.Response.StatusCode
    }

    $details = ''
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $details = $_.ErrorDetails.Message
    } elseif ($_.Exception.Message) {
      $details = $_.Exception.Message
    }

    throw "Admin login verification failed (HTTP $statusCode) $details"
  }
}

# ---------------------------------------------------------------------------------------------
# Fresh-install local org bootstrap (W1-6; owner ruling 2026-10-10 「W1-6 按此形状实现」).
# Twin of the same step in attendance-onprem-bootstrap-admin.sh -- same gate, same read-only SQL,
# same route, same messages (pinned by scripts/ops/attendance-onprem-bootstrap-admin-local-org.test.mjs).
#
# On a FRESH install only (user_orgs AND directory_integrations both empty), the logged-in
# bootstrap admin calls the EXISTING route POST /api/admin/directory/local/accounts with its own
# user id. That route's existing code creates the deployment's local org anchor
# (getOrCreateLocalIntegration) and the admin's active org membership; this script writes NO
# anchor/membership SQL of its own -- every psql statement below is a read-only count.
#
# Upgrade / directory-already-configured installs (either table has rows) are left untouched.
# Re-running is a no-op because the first successful run makes both tables non-empty.
#
# Fail-closed: any error throws with a values-free message. NOTE: the route commits the anchor
# before the membership transaction, so a failure inside that transaction can leave an anchor
# without a membership. That state is DETECTED by the read-only postcondition below (and
# reported) -- it is not rolled back by this script, and a re-run will skip because the anchor
# makes directory_integrations non-empty; finish it by calling the same route manually.
# ---------------------------------------------------------------------------------------------
$localOrgLogPrefix = 'Local org bootstrap'
$localOrgEmptinessSql = @'
SELECT (SELECT count(*) FROM user_orgs) || ':' || (SELECT count(*) FROM directory_integrations);
'@
$localOrgPostconditionSql = @'
SELECT (SELECT count(*) FROM directory_integrations WHERE provider = 'local' AND org_id = 'default' AND status = 'active') || ':' || (SELECT count(*) FROM user_orgs WHERE user_id = :'v_user_id' AND is_active = TRUE) || ':' || (SELECT count(*) FROM user_orgs WHERE user_id = :'v_user_id' AND is_active = TRUE AND org_id = 'default');
'@

function Read-LocalOrgCounts {
  param([string]$Sql, [string]$Description)

  $raw = Invoke-PsqlCapture -Description $Description -PsqlCommand $resolvedPsqlCommand -DatabaseUrl $databaseUrl -Sql $Sql -Variables @(
    "v_user_id=$adminUserId"
  ) -TrimOutput
  return ($raw -replace '\s', '')
}

if ($resolvedVerifyLogin -ne '1') {
  Write-Info "${localOrgLogPrefix}: skipped: it needs a logged-in admin session (VerifyLogin=1 with a running backend); nothing was written"
} else {
  if ([string]::IsNullOrWhiteSpace($adminSessionToken)) {
    throw "${localOrgLogPrefix}: the admin login response carried no session token; nothing was written"
  }

  try {
    $emptinessCounts = Read-LocalOrgCounts -Sql $localOrgEmptinessSql -Description "${localOrgLogPrefix}: read-only emptiness check"
  } catch {
    throw "${localOrgLogPrefix}: the read-only emptiness check failed; nothing was written"
  }
  if ($emptinessCounts -notmatch '^[0-9]+:[0-9]+$') {
    throw "${localOrgLogPrefix}: the read-only emptiness check returned an unexpected shape; nothing was written"
  }

  if ($emptinessCounts -ne '0:0') {
    Write-Info "${localOrgLogPrefix}: skipped: org membership or directory data already exists (upgrade or directory already configured); nothing was written"
  } else {
    $localOrgUrl = ($resolvedApiBase.TrimEnd('/')) + '/admin/directory/local/accounts'
    Write-Info "${localOrgLogPrefix}: fresh install detected (no org membership, no directory integration); creating the local org anchor and the admin membership via POST $localOrgUrl"
    $localOrgBody = @{ localUserId = $adminUserId } | ConvertTo-Json -Compress
    $localOrgCode = 0
    try {
      $localOrgResponse = Invoke-WebRequest -UseBasicParsing -Uri $localOrgUrl -Method Post -ContentType 'application/json' -Headers @{ Authorization = "Bearer $adminSessionToken" } -Body $localOrgBody -TimeoutSec 30
      $localOrgCode = [int]$localOrgResponse.StatusCode
    } catch {
      if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        $localOrgCode = [int]$_.Exception.Response.StatusCode
      }
    }

    try {
      $postconditionCounts = Read-LocalOrgCounts -Sql $localOrgPostconditionSql -Description "${localOrgLogPrefix}: read-only postcondition check"
    } catch {
      throw "${localOrgLogPrefix}: the route returned HTTP $localOrgCode and the read-only postcondition check failed; the org state is UNKNOWN -- inspect it before re-running"
    }

    if ($localOrgCode -eq 200 -and $postconditionCounts -eq '1:1:1') {
      Write-Info "${localOrgLogPrefix}: OK: local org anchor and admin membership created (one active anchor, exactly one active membership)"
    } elseif ($postconditionCounts -eq '0:0:0') {
      throw "${localOrgLogPrefix}: the route returned HTTP $localOrgCode; no anchor and no membership were written (safe to re-run)"
    } else {
      $anchorCount = ($postconditionCounts -split ':')[0]
      throw "${localOrgLogPrefix}: the route returned HTTP $localOrgCode and left a PARTIAL state (anchors=$anchorCount); a re-run will skip -- complete it by calling POST /api/admin/directory/local/accounts for the admin manually"
    }
  }
}

Write-Info "Admin bootstrap OK (email=$resolvedAdminEmail, user_id=$adminUserId)"
