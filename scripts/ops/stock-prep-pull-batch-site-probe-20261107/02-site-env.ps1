# ============================================================================
# 02-site-env.ps1 - read-only, values-free host half of the pull-batch site
#                   probe (pull batch BI-6a). Windows PowerShell 5.1, ASCII.
# ============================================================================
# The database cannot see three of the facts the install decision needs: the
# project-sheets switch, the table label locale and the time zone of the Node
# process. They live in <install root>\docker\app.env and in the process-level
# environment. This script prints ONE line per key with counts and yes/no only:
# never a value, a path, a host or an account name.
#
# HOW THE BACKEND READS app.env (ecosystem.config.cjs loadOnPremEnvFile): a
# line is trimmed; blank lines and lines starting '#' are skipped; the key is
# the text before the first '='; one pair of matching outer quotes is stripped
# from the value; the FIRST occurrence of a key wins; and a key already present
# in the process environment (Machine / User level) is NOT overridden. This
# script resolves each key the same way.
#
# RUN WITH (read-only; it opens app.env for reading and writes nothing):
#   powershell -NoProfile -ExecutionPolicy Bypass -File 02-site-env.ps1 -EnvFile '<install root>\docker\app.env' > site-env.log
# ============================================================================
param(
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [string]$ExpectedTimeZone = 'Asia/Shanghai',
  [string]$ExpectedWindowsTimeZone = 'China Standard Time'
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
  'SITE_ENV_RESULT status=incomplete reason=env_file_missing'
  exit 0
}

$lines = [System.IO.File]::ReadAllLines($EnvFile, [System.Text.Encoding]::UTF8)

function Get-EnvFileFacts([string]$Key) {
  $count = 0
  $first = $null
  foreach ($raw in $lines) {
    $line = $raw.Trim()
    if ($line.Length -gt 0 -and $line[0] -eq [char]0xFEFF) { $line = $line.Substring(1).Trim() }
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -le 0) { continue }
    if ($line.Substring(0, $eq).Trim() -ne $Key) { continue }
    $count++
    if ($count -eq 1) {
      $value = $line.Substring($eq + 1).Trim()
      if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $first = $value
    }
  }
  $machine = [Environment]::GetEnvironmentVariable($Key, 'Machine')
  $user = [Environment]::GetEnvironmentVariable($Key, 'User')
  $processLevel = $null
  if ($null -ne $machine) { $processLevel = $machine }
  if ($null -ne $user) { $processLevel = $user }
  $effective = $first
  if ($null -ne $processLevel) { $effective = $processLevel }
  return [pscustomobject]@{ Count = $count; Machine = ($null -ne $machine); User = ($null -ne $user); Effective = $effective }
}

function YesNo([bool]$b) { if ($b) { 'yes' } else { 'no' } }

# 1. Project-sheets switch: on only for the exact literal 'true' (no trim, no case folding).
$f = Get-EnvFileFacts 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
'SITE_ENV key=MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED app_env_lines={0} machine={1} user={2} effective_exact_true={3}' -f $f.Count, (YesNo $f.Machine), (YesNo $f.User), (YesNo ($f.Effective -ceq 'true'))

# 2. Table label locale: normalizeTemplateLabelLocale (stock-preparation-templates.cjs) - trim, lower case,
#    '_' -> '-'; zh / zh-cn / zh-hans / zh-hans-cn resolve to zh-CN; anything else, unset included, to en.
$f = Get-EnvFileFacts 'MULTITABLE_STOCK_PREP_TABLE_LABEL_LOCALE'
$locale = ''
if ($null -ne $f.Effective) { $locale = $f.Effective.Trim().ToLowerInvariant().Replace('_', '-') }
$zh = @('zh', 'zh-cn', 'zh-hans', 'zh-hans-cn') -contains $locale
'SITE_ENV key=MULTITABLE_STOCK_PREP_TABLE_LABEL_LOCALE app_env_lines={0} machine={1} user={2} resolves_zh_cn={3}' -f $f.Count, (YesNo $f.Machine), (YesNo $f.User), (YesNo $zh)

# 3. The pull-batch switch (not shipped yet): it must be absent before the owner flips it (O-BI-7).
$f = Get-EnvFileFacts 'STOCK_PREP_PULL_BATCH_ENABLED'
'SITE_ENV key=STOCK_PREP_PULL_BATCH_ENABLED app_env_lines={0} machine={1} user={2} effective_exact_true={3}' -f $f.Count, (YesNo $f.Machine), (YesNo $f.User), (YesNo ($f.Effective -ceq 'true'))

# 4. Node process time zone: TZ when set, else the Windows zone.
$f = Get-EnvFileFacts 'TZ'
$tzSet = ($null -ne $f.Effective -and $f.Effective.Trim().Length -gt 0)
$tzExpected = $tzSet -and ($f.Effective.Trim() -ceq $ExpectedTimeZone)
'SITE_ENV key=TZ app_env_lines={0} machine={1} user={2} set={3} is_expected={4}' -f $f.Count, (YesNo $f.Machine), (YesNo $f.User), (YesNo $tzSet), (YesNo $tzExpected)
$os = (Get-TimeZone).Id
'SITE_ENV key=os_time_zone is_expected={0}' -f (YesNo ($os -ceq $ExpectedWindowsTimeZone))

# 5. Multitable business time zone: unset or blank resolves to Asia/Shanghai (business-timezone.ts).
$f = Get-EnvFileFacts 'MULTITABLE_BUSINESS_TIMEZONE'
$biz = $ExpectedTimeZone
if ($null -ne $f.Effective -and $f.Effective.Trim().Length -gt 0) { $biz = $f.Effective.Trim() }
'SITE_ENV key=MULTITABLE_BUSINESS_TIMEZONE app_env_lines={0} machine={1} user={2} resolves_expected={3}' -f $f.Count, (YesNo $f.Machine), (YesNo $f.User), (YesNo ($biz -ceq $ExpectedTimeZone))

'SITE_ENV_RESULT status=complete keys=5'
