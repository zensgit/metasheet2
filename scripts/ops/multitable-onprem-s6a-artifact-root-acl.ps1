#requires -Version 5.1
<#
.SYNOPSIS
  Applies the NTFS ACL the S6-A sealed-snapshot artifact root needs on Windows,
  verifies it, and only then writes the win32 artifact-ACL attestation into the
  service environment file.

.DESCRIPTION
  Follow-up 1 of docs/development/stock-preparation-s6a-windows-runtime-parity-20260818.md.

  The sealed-export code asserts the confidentiality of the artifact tree with
  POSIX modes (mkdir 0o700 / chmod 0o700 / chmod 0o600). On win32 those calls
  succeed and then no-op, so the control is absent at runtime. The runtime gate
  added by that change refuses to boot the S6-A runtime on win32 unless
  MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_WIN32_ARTIFACT_ACL_ATTESTED is
  exactly 'true'.

  Without this helper that attestation is an operator ASSERTION. This helper makes
  it an ENFORCED fact: it applies the ACL, re-reads it, and writes the attestation
  only when the re-read proves the control is actually in place. It removes a stale
  attestation when the re-read fails, so a host that was attested once cannot stay
  attested after its ACL drifts.

  Contract of the emitted lines (parseable, values-free — no path, no account name,
  no SID ever reaches stdout):

    s6aArtifactRootAclApplied=YES|NO
    s6aArtifactRootAclVerified=PASS|FAIL|SKIP
    s6aWin32ArtifactAclAttested=YES|NO
    s6aArtifactRootAclReason=<TOKEN>

  SKIP is the documented third verified value for "the step did not run" (opted
  out, not win32, or the sealed-snapshot flag is off for this host).

  Idempotent: `icacls /inheritance:r /grant:r` is a replace, and the env file is
  rewritten only when the attestation line is not already exactly right, so a
  re-run leaves both the ACL and the env file byte-identical.

  Dot-sourceable: `. .\multitable-onprem-s6a-artifact-root-acl.ps1` defines the
  helpers without running them, which is how the tests inject a fake icacls runner
  and fake ACL facts.
#>
param(
  [string]$EnvFilePath = '',
  [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [ValidateSet('auto', 'off')]
  [string]$Mode = 'auto'
)

$ErrorActionPreference = 'Stop'

# Same names the runtime reads (plugins/plugin-integration-core/lib/sealed-export/
# stock-preparation-runtime-config.cjs FEATURE_FLAG / ENV.artifactRoot /
# ENV.win32ArtifactAclAttested). Keep them in sync with that module.
$S6aFeatureFlagEnvName = 'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED'
$S6aArtifactRootEnvName = 'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ARTIFACT_ROOT'
$S6aAttestationEnvName = 'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_WIN32_ARTIFACT_ACL_ATTESTED'
# The runtime compares this literal without trimming or case-folding.
$S6aAttestationValue = 'true'

# Well-known SIDs, not display names: the on-prem hosts are not guaranteed to be
# English, and "BUILTIN\Administrators" / "NT AUTHORITY\SYSTEM" are localized.
# icacls accepts the *S-<sid> form for both /grant and lookup.
$S6aSystemSid = 'S-1-5-18'
$S6aAdministratorsSid = 'S-1-5-32-544'
$S6aForbiddenSids = @(
  'S-1-1-0',       # Everyone
  'S-1-5-11',      # Authenticated Users
  'S-1-5-32-545',  # BUILTIN\Users
  'S-1-5-32-546'   # BUILTIN\Guests
)

function Test-S6aWindowsPlatform {
  return ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
}

function Resolve-S6aAppEnvFile {
  param([string]$Candidate, [string]$BaseDir)

  if (-not [string]::IsNullOrWhiteSpace($Candidate)) {
    return [System.IO.Path]::GetFullPath($Candidate.Trim().Trim('"'))
  }

  # Same order attendance-onprem-start-pm2.ps1 resolves it in, so the attestation
  # lands in the file PM2 will actually source when the caller passes nothing.
  foreach ($leaf in @('app.env', 'docker\app.env')) {
    $candidate = Join-Path $BaseDir $leaf
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }

  return ''
}

function Get-S6aAppEnvMap {
  param([string]$EnvFile)

  # Mirror of the Import-AppEnvFile parser used by multitable-onprem-apply-package.ps1
  # and attendance-onprem-start-pm2.ps1: last assignment wins, surrounding quotes
  # stripped, '#' comments and non-assignment lines ignored.
  $map = @{}
  foreach ($rawLine in Get-Content -LiteralPath $EnvFile) {
    $line = $rawLine.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) { continue }

    $parts = $line -split '=', 2
    if ($parts.Length -ne 2) { continue }

    $name = $parts[0].Trim()
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $value = $parts[1].Trim()

    if ($value.Length -ge 2) {
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
          ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }

    $map[$name] = $value
  }

  return $map
}

function Test-S6aSealedSnapshotEnabled {
  param([hashtable]$EnvMap)

  # featureEnabled() in stock-preparation-runtime-config.cjs: trim + lower-case.
  # The FLAG is a deployment toggle; only the ATTESTATION is compared literally.
  if ($null -eq $EnvMap) { return $false }
  $raw = [string]$EnvMap[$S6aFeatureFlagEnvName]
  return ($raw.Trim().ToLowerInvariant() -eq 'true')
}

function Test-S6aArtifactRootShape {
  param([string]$Candidate)

  # requiredText() in the runtime rejects untrimmed text and control characters;
  # path.isAbsolute() rejects relative roots. Require a drive-qualified or UNC path
  # so a rooted-but-driveless value such as '\artifacts' cannot slip through.
  if ([string]::IsNullOrEmpty($Candidate)) { return $false }
  if ($Candidate.Length -gt 4096) { return $false }
  if ($Candidate.Trim() -ne $Candidate) { return $false }
  foreach ($char in $Candidate.ToCharArray()) {
    if ([int]$char -lt 0x20 -or [int]$char -eq 0x7f) { return $false }
  }
  if ($Candidate.Contains('"')) { return $false }
  return ($Candidate -match '^([A-Za-z]:\\|\\\\[^\\])')
}

function Resolve-S6aServiceAccount {
  # The PM2 service is started by scripts/ops/attendance-onprem-start-pm2.ps1, which
  # the apply helper invokes in-process. The identity that will own the node process
  # is therefore the identity running this script — that is how the deploy path
  # already "knows" the service account; there is no separate service-user config.
  $result = [pscustomobject]@{
    Ok = $false
    Sid = ''
    Elevated = $false
  }

  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity -or $null -eq $identity.User) { return $result }
    $sid = [string]$identity.User.Value
    if ($sid -notmatch '^S-1-[0-9]+(-[0-9]+)+$') { return $result }
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    $result.Elevated = $principal.IsInRole(
      [System.Security.Principal.WindowsBuiltInRole]::Administrator
    )
    $result.Sid = $sid
    $result.Ok = $true
  }
  catch {
    # Fail closed; the caller emits S6A_ARTIFACT_ROOT_ACL_SERVICE_ACCOUNT_UNKNOWN.
    return $result
  }

  return $result
}

function Resolve-S6aIcaclsPath {
  $systemRoot = if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { 'C:\Windows' } else { $env:SystemRoot }
  $candidate = Join-Path $systemRoot 'System32\icacls.exe'
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  return 'icacls'
}

function Invoke-S6aIcacls {
  param([string[]]$Arguments)

  # Single injection point. Output is captured and DISCARDED: icacls echoes the
  # target path and the granted principals, and neither may reach the deploy log.
  #
  # ErrorActionPreference is scoped to Continue for the native call: under 'Stop',
  # Windows PowerShell 5.1 turns any native stderr line into a terminating
  # NativeCommandError, which would hide the real exit code behind an exception.
  $output = @()
  $exitCode = 1
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& (Resolve-S6aIcaclsPath) @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
  }
  catch {
    $exitCode = 1
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  return [pscustomobject]@{
    ExitCode = $exitCode
    LineCount = @($output).Count
  }
}

function Get-S6aArtifactRootAclFacts {
  param(
    [string]$Path,
    [string]$ServiceAccountSid
  )

  # Verification is SID-based via Get-Acl rather than icacls text so it cannot be
  # defeated by a localized display name, and so the check is independent of the
  # command that applied the ACL.
  $facts = [pscustomobject]@{
    Ok = $false
    InheritanceDisabled = $false
    NoInheritedAce = $false
    NoForbiddenPrincipal = $false
    ServiceAceFullControl = $false
    SystemAceFullControl = $false
  }

  try {
    $acl = Get-Acl -LiteralPath $Path
    $facts.InheritanceDisabled = [bool]$acl.AreAccessRulesProtected
    $rules = @($acl.GetAccessRules(
      $true, $true, [System.Security.Principal.SecurityIdentifier]
    ))

    $facts.NoInheritedAce = (@($rules | Where-Object { $_.IsInherited }).Count -eq 0)
    $facts.NoForbiddenPrincipal = (@(
      $rules | Where-Object { $S6aForbiddenSids -contains [string]$_.IdentityReference.Value }
    ).Count -eq 0)
    $facts.ServiceAceFullControl = (@(
      $rules | Where-Object {
        [string]$_.IdentityReference.Value -eq $ServiceAccountSid -and
        $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
          [System.Security.AccessControl.FileSystemRights]::FullControl -and
        ($_.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0 -and
        ($_.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0
      }
    ).Count -ge 1)
    $facts.SystemAceFullControl = (@(
      $rules | Where-Object {
        [string]$_.IdentityReference.Value -eq $S6aSystemSid -and
        $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
          [System.Security.AccessControl.FileSystemRights]::FullControl
      }
    ).Count -ge 1)
  }
  catch {
    return $facts
  }

  $facts.Ok = (
    $facts.InheritanceDisabled -and
    $facts.NoInheritedAce -and
    $facts.NoForbiddenPrincipal -and
    $facts.ServiceAceFullControl -and
    $facts.SystemAceFullControl
  )
  return $facts
}

function Get-S6aEnvFileNewline {
  param([string]$Raw)

  if ($Raw -match "`r`n") { return "`r`n" }
  if ($Raw -match "`n") { return "`n" }
  return [System.Environment]::NewLine
}

function Set-S6aAppEnvKey {
  param(
    [string]$EnvFile,
    [string]$Name,
    [string]$Value
  )

  # Rewrites exactly one key and nothing else. Returns $true when the file changed;
  # an already-correct file is left byte-identical so re-running is a no-op.
  $raw = [System.IO.File]::ReadAllText($EnvFile)
  $newline = Get-S6aEnvFileNewline -Raw $raw
  $endsWithNewline = ($raw.Length -gt 0 -and ($raw.EndsWith("`n") -or $raw.EndsWith("`r")))
  # No Max-substrings argument: in PowerShell a NEGATIVE max splits from the END of
  # the string (so -1 would return the whole file as one element).
  $lines = @($raw -split "`r`n|`n|`r")
  if ($endsWithNewline -and $lines.Count -gt 0) {
    $lines = @($lines[0..($lines.Count - 2)])
  }
  if ($raw.Length -eq 0) { $lines = @() }

  $assignment = "$Name=$Value"
  $pattern = '^\s*' + [regex]::Escape($Name) + '\s*='
  $replaced = $false
  $rebuilt = @()
  foreach ($line in $lines) {
    if ($line -match $pattern) {
      if (-not $replaced) {
        $rebuilt += $assignment
        $replaced = $true
      }
      continue
    }
    $rebuilt += $line
  }
  if (-not $replaced) {
    $rebuilt += $assignment
  }

  $next = ($rebuilt -join $newline)
  if ($endsWithNewline -or $raw.Length -eq 0) {
    $next += $newline
  }
  if ($next -eq $raw) { return $false }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($EnvFile, $next, $utf8NoBom)
  return $true
}

function Remove-S6aAppEnvKey {
  param(
    [string]$EnvFile,
    [string]$Name
  )

  $raw = [System.IO.File]::ReadAllText($EnvFile)
  $newline = Get-S6aEnvFileNewline -Raw $raw
  $endsWithNewline = ($raw.Length -gt 0 -and ($raw.EndsWith("`n") -or $raw.EndsWith("`r")))
  $lines = @($raw -split "`r`n|`n|`r")
  if ($endsWithNewline -and $lines.Count -gt 0) {
    $lines = @($lines[0..($lines.Count - 2)])
  }
  if ($raw.Length -eq 0) { $lines = @() }

  $pattern = '^\s*' + [regex]::Escape($Name) + '\s*='
  $rebuilt = @($lines | Where-Object { $_ -notmatch $pattern })
  $next = ($rebuilt -join $newline)
  if ($endsWithNewline -and $rebuilt.Count -gt 0) {
    $next += $newline
  }
  if ($next -eq $raw) { return $false }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($EnvFile, $next, $utf8NoBom)
  return $true
}

function Invoke-S6aArtifactRootAclAttestation {
  param(
    [string]$EnvFile,
    [ValidateSet('auto', 'off')]
    [string]$AttestationMode = 'auto',
    [bool]$PlatformIsWindows = (Test-S6aWindowsPlatform)
  )

  $applied = 'NO'
  $verified = 'SKIP'
  $attested = 'NO'
  $reason = 'none'
  $applicable = $false
  $ok = $true

  try {
    if ($AttestationMode -eq 'off') {
      $reason = 'S6A_ARTIFACT_ROOT_ACL_DISABLED_BY_OPERATOR'
    }
    elseif (-not $PlatformIsWindows) {
      $reason = 'S6A_ARTIFACT_ROOT_ACL_NOT_APPLICABLE'
    }
    elseif ([string]::IsNullOrWhiteSpace($EnvFile) -or
            -not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
      $reason = 'S6A_ENV_FILE_MISSING'
      $ok = $false
    }
    else {
      $envMap = Get-S6aAppEnvMap -EnvFile $EnvFile
      if (-not (Test-S6aSealedSnapshotEnabled -EnvMap $envMap)) {
        # Host never enables S6-A: touch neither the filesystem nor the env file.
        $reason = 'S6A_ARTIFACT_ROOT_ACL_NOT_APPLICABLE'
      }
      else {
        $applicable = $true
        $artifactRoot = [string]$envMap[$S6aArtifactRootEnvName]

        if ([string]::IsNullOrEmpty($artifactRoot)) {
          $reason = 'S6A_ARTIFACT_ROOT_UNSET'
          $ok = $false
        }
        elseif (-not (Test-S6aArtifactRootShape -Candidate $artifactRoot)) {
          $reason = 'S6A_ARTIFACT_ROOT_NOT_ABSOLUTE'
          $ok = $false
        }
        else {
          $account = Resolve-S6aServiceAccount
          if (-not $account.Ok) {
            $reason = 'S6A_ARTIFACT_ROOT_ACL_SERVICE_ACCOUNT_UNKNOWN'
            $ok = $false
          }
          else {
            $created = $true
            try {
              if (-not (Test-Path -LiteralPath $artifactRoot -PathType Container)) {
                New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
              }
            }
            catch {
              # Never echo $_: the message carries the path.
              $created = $false
            }
            if (-not $created -or -not (Test-Path -LiteralPath $artifactRoot -PathType Container)) {
              $reason = 'S6A_ARTIFACT_ROOT_CREATE_FAILED'
              $ok = $false
            }
            else {
              $grants = @(
                ('*' + $S6aSystemSid + ':(OI)(CI)F'),
                ('*' + $account.Sid + ':(OI)(CI)F')
              )
              if ($account.Elevated) {
                $grants += ('*' + $S6aAdministratorsSid + ':(OI)(CI)F')
              }
              $arguments = @($artifactRoot, '/inheritance:r', '/grant:r') + $grants
              $icacls = Invoke-S6aIcacls -Arguments $arguments

              if ($null -eq $icacls -or $icacls.ExitCode -ne 0) {
                $reason = 'S6A_ARTIFACT_ROOT_ACL_APPLY_FAILED'
                $ok = $false
              }
              else {
                $applied = 'YES'
                $facts = Get-S6aArtifactRootAclFacts `
                  -Path $artifactRoot `
                  -ServiceAccountSid $account.Sid
                if ($null -eq $facts -or -not $facts.Ok) {
                  $verified = 'FAIL'
                  $reason = 'S6A_ARTIFACT_ROOT_ACL_VERIFY_FAILED'
                  $ok = $false
                }
                else {
                  $verified = 'PASS'
                  try {
                    Set-S6aAppEnvKey `
                      -EnvFile $EnvFile `
                      -Name $S6aAttestationEnvName `
                      -Value $S6aAttestationValue | Out-Null
                    Set-Item -Path ("Env:{0}" -f $S6aAttestationEnvName) -Value $S6aAttestationValue
                    $attested = 'YES'
                  }
                  catch {
                    $reason = 'S6A_ARTIFACT_ROOT_ACL_ENV_WRITE_FAILED'
                    $ok = $false
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  catch {
    $reason = 'S6A_ARTIFACT_ROOT_ACL_INTERNAL_ERROR'
    $ok = $false
  }

  if ($applicable -and $attested -ne 'YES') {
    # An attested host must be an ENFORCED host. If this run could not prove the
    # ACL, a previously written attestation is retracted rather than left standing.
    try {
      Remove-S6aAppEnvKey -EnvFile $EnvFile -Name $S6aAttestationEnvName | Out-Null
    }
    catch {
      $reason = 'S6A_ARTIFACT_ROOT_ACL_ENV_WRITE_FAILED'
      $ok = $false
    }
    Remove-Item -Path ("Env:{0}" -f $S6aAttestationEnvName) -ErrorAction SilentlyContinue
  }

  $lines = @(
    "s6aArtifactRootAclApplied=$applied",
    "s6aArtifactRootAclVerified=$verified",
    "s6aWin32ArtifactAclAttested=$attested",
    "s6aArtifactRootAclReason=$reason"
  )
  foreach ($line in $lines) { Write-Host $line }

  return [pscustomobject]@{
    Applicable = $applicable
    Applied = $applied
    Attested = $attested
    Lines = $lines
    Ok = $ok
    Reason = $reason
    Verified = $verified
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  $resolvedEnvFile = Resolve-S6aAppEnvFile -Candidate $EnvFilePath -BaseDir $RootDir
  $result = Invoke-S6aArtifactRootAclAttestation `
    -EnvFile $resolvedEnvFile `
    -AttestationMode $Mode
  if (-not $result.Ok) { exit 1 }
  exit 0
}
