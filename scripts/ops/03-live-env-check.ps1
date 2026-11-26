# 03-live-env-check.ps1 - values-free check of switch keys in the LIVE backend process
# environment and in both app.env files. Windows PowerShell 5.1, read-only.
#
# RUN (same window as 02, and only after 02 printed PM2OWNER_RESULT owned=true status=complete):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\03-live-env-check.ps1 -InstallRoot '<install root>'
#   optional: -Keys 'KEY_A,KEY_B'   (default: the 27 keys of install sheet steps 3 and 4)
#   optional: -ScheduledTaskName 'MetaSheet-PM2'
#
# On the demo host, leave PM2_HOME unset. 02 and 03 keep <profile>\.pm2 when that
# tree already holds pm2.pid, dump.pm2, or an app pid file. They use
# <profile>\.pm2-runtime only when that confirmed default tree is absent and
# exactly one MetaSheet-PM2 task exists. Or set PM2_HOME before both scripts.
# Do not create pm2.pid. Do not start pm2. A live node.exe named by pm2.pid is
# not a God unless its command line is pm2\lib\Daemon.js.
#
# WHY: a key deleted from app.env can stay in the running backend. pm2 restart --update-env
# merges the variables present at restart time and does not drop a variable that is no
# longer in the file. The start script clears only its two retired test keys. app.env
# alone does not tell what the backend reads.
#
# HOW process env is read:
#   god          pm2.pid names this account's live Daemon.js, the app pid is live and
#                owned and is not a child of pm2-runtime, and the pipe is already
#                present. Then ONE `pm2 jlist`. A non-God node in pm2.pid does not
#                qualify, and jlist is not run for a God that does not own the app.
#   pm2-runtime  the MetaSheet-PM2 task and pm2-runtime process in 02 are live and
#                owned, the app's parent is that pm2-runtime, the pipe is already
#                present, and the home is already initialized (so the pm2 client
#                creates no directory or file). Then ONE `pm2 jlist`, with PM2_HOME
#                set to that home for the child only. A non-God pm2.pid does not
#                hide this path.
#   otherwise    NO pm2 command. A pm2 command with nobody listening starts an empty God.
# pm2 is <install root>\node_modules\.bin\pm2.cmd when present, else pm2.cmd on PATH,
# searched after the same Windows folders the start script prepends. `pm2 jlist` is read
# into memory as UTF-8 (never a file, never printed). Windows PowerShell 5.1 parses it
# with JavaScriptSerializer (case-sensitive keys). ConvertFrom-Json is not used there:
# it rejects the document when the env holds both Path and PATH. Leading noise is skipped.
# Exactly one app named metasheet-backend must be listed. Keys are matched
# case-insensitively in pm2_env and in pm2_env.env. Canary: PATH must be visible in one
# of the two bags, else the answer is incomplete (env_not_visible), never absent.
#   machine / user   the Windows machine-level and user-level environment of this account.
#
# STATE WORDS (never a value):
#   absent          no such key (or no such file)
#   empty           the key is set to an empty value
#   literal-true    the value is exactly: true
#   loose-true      not literal-true, but it starts like true after trimming and one quote
#   literal-production / literal-mock   only for NODE_ENV / MULTITABLE_EMAIL_TRANSPORT
#   exists          any other non-empty value, including an exact false
#   unknown         (process only) the process environment was not read
#
# OUTPUT (closed lines only; never a path, account, PID, command line or value):
#   LIVEENV_FILE root=found|absent docker=found|absent start_script_uses=root|docker|none
#   LIVEENV_DBURL relation=same|differs|root_absent|docker_absent
#   LIVEENV_PM2 pm2_home_set=true|false daemon_alive=true|false daemon_class=god|other|unknown|none daemon_owner_is_current_user=true|false|unknown pm2_cmd=local|path|none read=ok|skipped|failed app_matches=<n>|- hosting=god|pm2-runtime|none rpc_pipe=present|absent|unknown
#       daemon_alive is the pm2.pid fact. On pm2-runtime it stays false while hosting=pm2-runtime and read=ok.
#   LIVEENV_DBURL_PROCESS process=same|differs|absent|unknown
#   LIVEENV key=<KEY> process=<w> root=<w> docker=<w> machine=<w> user=<w> dup=none|same|differs pdup=none|same|differs
#   then the LAST line
#   LIVEENV_RESULT keys=<n> status=complete
#   LIVEENV_RESULT keys=<n> status=incomplete reason=<word>
# A run with no LIVEENV_RESULT line did not finish. Never read a missing line as absent.
# reasons: install_root_not_found, bad_key, no_daemon, daemon_not_owned, owner_unreadable,
# pm2_not_found, pm2_timeout, pm2_failed, parse_failed, app_count, env_not_visible,
# parser_unavailable, read_error, pipe_unknown, stray_daemon, host_ambiguous,
# task_not_running, app_not_under_runtime, app_not_under_god, pm2_home_not_initialized.
#
# -CiProbe (CI only, never on site): JSON fixture for the process table, the task and the
# pipe. The first line is then LIVEENV_PROBE ci=true. A log that contains LIVEENV_PROBE
# is not a field acceptance. The fixture cannot make this script skip the hosting decision.
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string[]]$Keys = @(),
  [string]$AppName = 'metasheet-backend',
  [string]$ScheduledTaskName = 'MetaSheet-PM2',
  [string]$CiProbe = '',
  [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'onprem-live-env-lib.ps1')

$DefaultKeys = @(
  'SECURITY_ACTION_PROOF_ENABLED',
  'DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED',
  'DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED',
  'APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED',
  'USER_NOTIFICATION_PREFERENCES_ENABLED',
  'USER_RECYCLE_SWEEPER_ENABLED',
  'STOCK_PREP_PULL_BATCH_ENABLED',
  'MULTITABLE_STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED',
  'INTEGRATION_YIDA_OWNER_SEND_ENABLED',
  'INTEGRATION_YIDA_MULTI_TARGET_ENABLED',
  'INTEGRATION_YIDA_CONNECTION_TEST_ENABLED',
  'RBAC_BYPASS',
  'TASKS_ENABLED',
  'TASKS_SCHEDULER_ENABLED',
  'TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED',
  'INTEGRATION_CORE_STOCK_PREPARATION_PILOT_PATH',
  'METASHEET_C6_TEST_FAILURE_INJECTION_ENABLED',
  'INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON',
  'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED',
  'INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED',
  'AUTOMATION_CLASSB_OUTBOUND_ENABLED',
  'MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED',
  'DINGTALK_TODO_MIRROR_ENABLED',
  'ATTENDANCE_NOTIFICATION_WECOM_ENABLED',
  'MULTITABLE_EMAIL_TRANSPORT',
  'NODE_ENV',
  'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
)
$Words = @{ 'NODE_ENV' = 'production'; 'MULTITABLE_EMAIL_TRANSPORT' = 'mock' }
$Rank = @{ 'absent' = 0; 'empty' = 1; 'exists' = 2; 'literal-production' = 3; 'literal-mock' = 3; 'loose-true' = 4; 'literal-true' = 5 }

function Get-LiveEnvEntryName {
  param($Entry)
  if ($null -eq $Entry) { return '' }
  if ($Entry -is [System.Collections.IDictionary]) {
    if ($Entry.ContainsKey('name')) { return [string]$Entry['name'] }
    return ''
  }
  $prop = $Entry.PSObject.Properties['name']
  if ($null -eq $prop) { return '' }
  return [string]$prop.Value
}

function Get-LiveEnvEntryBag {
  param($Entry, [string]$BagName)
  if ($null -eq $Entry) { return $null }
  if ($Entry -is [System.Collections.IDictionary]) {
    if (-not $Entry.ContainsKey($BagName)) { return $null }
    return $Entry[$BagName]
  }
  $prop = $Entry.PSObject.Properties[$BagName]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

function Invoke-LiveEnvCheck {
  $keyList = @()
  $resultLine = $null
  try {
    if (-not [string]::IsNullOrWhiteSpace($CiProbe)) {
      Import-LiveEnvCiProbe -Path $CiProbe
      'LIVEENV_PROBE ci=true'
    }
    $src = if ($Keys.Count -gt 0) { $Keys } else { $DefaultKeys }
    foreach ($key in $src) {
      foreach ($part in ([string]$key -split ',')) {
        $trimmed = $part.Trim()
        if ($trimmed.Length -gt 0) { $keyList += $trimmed }
      }
    }
    foreach ($key in $keyList) {
      if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,127}$') {
        'LIVEENV_RESULT keys=0 status=incomplete reason=bad_key'
        exit 2
      }
    }

    if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
      'LIVEENV_FILE root=absent docker=absent start_script_uses=none'
      'LIVEENV_RESULT keys=' + $keyList.Count + ' status=incomplete reason=install_root_not_found'
      exit 2
    }
    $rootMap = Read-LiveEnvFile (Join-Path $InstallRoot 'app.env')
    $dockerMap = Read-LiveEnvFile (Join-Path (Join-Path $InstallRoot 'docker') 'app.env')
    $uses = if ($null -ne $rootMap) { 'root' } elseif ($null -ne $dockerMap) { 'docker' } else { 'none' }
    'LIVEENV_FILE root={0} docker={1} start_script_uses={2}' -f $(if ($null -ne $rootMap) { 'found' } else { 'absent' }), $(if ($null -ne $dockerMap) { 'found' } else { 'absent' }), $uses
    'LIVEENV_DBURL relation=' + (Get-LiveEnvDbUrlRelation -RootFile $rootMap -DockerFile $dockerMap)

    $facts = Get-LiveEnvHostingFacts -AppName $AppName -ScheduledTaskName $ScheduledTaskName
    $decision = Resolve-LiveEnvHosting -Facts $facts
    $pm2Cmd = Resolve-LiveEnvPm2Command -InstallRoot $InstallRoot
    $readState = 'skipped'
    $appMatches = '-'
    $pm2Env = $null

    if (-not [bool]$decision.RunJlist) {
      $resultLine = [string]$decision.Reason
      if ([string]::IsNullOrEmpty($resultLine)) { $resultLine = 'no_daemon' }
    } elseif ([string]$pm2Cmd.Kind -eq 'none') {
      $resultLine = 'pm2_not_found'
    } else {
      $readState = 'failed'
      $invocation = Invoke-LiveEnvPm2Jlist -Pm2Path ([string]$pm2Cmd.Path) -ChildHome ([string]$facts.ResolvedHome) -SetChildHome ([string]$decision.Hosting -eq 'pm2-runtime') -TimeoutSeconds $TimeoutSeconds
      if ([string]$invocation.Status -eq 'timeout') {
        $resultLine = 'pm2_timeout'
      } elseif ([string]$invocation.Status -ne 'ok') {
        $resultLine = 'pm2_failed'
      } else {
        $parsed = ConvertFrom-LiveEnvJlistText -Text ([string]$invocation.Text)
        $invocation = $null
        if ($null -eq $parsed) {
          $resultLine = 'parse_failed'
        } else {
          $hits = New-Object System.Collections.ArrayList
          foreach ($entry in @($parsed)) {
            if ((Get-LiveEnvEntryName $entry) -ceq $AppName) { [void]$hits.Add($entry) }
          }
          $appMatches = [string]$hits.Count
          if ($hits.Count -ne 1) {
            $resultLine = 'app_count'
          } else {
            $candidate = Get-LiveEnvEntryBag -Entry $hits[0] -BagName 'pm2_env'
            if (-not (Test-LiveEnvBag $candidate)) {
              $resultLine = 'parse_failed'
            } else {
              $visible = $false
              $candidateBags = @()
              $candidateBags += , $candidate
              $nested = Get-LiveEnvEntryBag -Entry $candidate -BagName 'env'
              if (Test-LiveEnvBag $nested) { $candidateBags += , $nested }
              foreach ($bag in $candidateBags) {
                foreach ($bagKey in @(Get-LiveEnvBagKeys $bag)) {
                  if ([string]::Equals([string]$bagKey, 'PATH', [System.StringComparison]::OrdinalIgnoreCase)) { $visible = $true }
                }
              }
              if ($visible) { $pm2Env = $candidate; $readState = 'ok' } else { $resultLine = 'env_not_visible' }
              $candidate = $null
              $candidateBags = $null
            }
          }
          $parsed = $null
          $hits = $null
        }
      }
    }

    'LIVEENV_PM2 pm2_home_set={0} daemon_alive={1} daemon_class={2} daemon_owner_is_current_user={3} pm2_cmd={4} read={5} app_matches={6} hosting={7} rpc_pipe={8}' -f (Format-LiveEnvBool ([bool]$facts.HomeSet)), (Format-LiveEnvBool ([bool]$facts.DaemonAlive)), [string]$facts.DaemonClass, [string]$facts.DaemonOwner, [string]$pm2Cmd.Kind, $readState, $appMatches, [string]$decision.Hosting, [string]$facts.Pipe

    $bags = @()
    if ($null -ne $pm2Env) {
      $bags += , $pm2Env
      $nestedEnv = Get-LiveEnvEntryBag -Entry $pm2Env -BagName 'env'
      if (Test-LiveEnvBag $nestedEnv) { $bags += , $nestedEnv }
    }
    'LIVEENV_DBURL_PROCESS process=' + (Get-LiveEnvDbUrlProcess -Pm2Read $readState -EnvBags $bags -DockerFile $dockerMap)

    foreach ($name in $keyList) {
      $states = @{}
      $dup = 'none'
      foreach ($which in @('root', 'docker')) {
        $map = if ($which -eq 'root') { $rootMap } else { $dockerMap }
        $last = $null
        if ($null -ne $map -and $map.ContainsKey($name)) {
          $vals = $map[$name]
          $last = $vals[$vals.Count - 1]
          if ($vals.Count -gt 1) {
            $distinct = @($vals | ForEach-Object { Get-LiveEnvStateWord -Value $_ -Key $name -Words $Words } | Sort-Object -Unique)
            if ($distinct.Count -gt 1) { $dup = 'differs' } elseif ($dup -eq 'none') { $dup = 'same' }
          }
        }
        $states[$which] = Get-LiveEnvStateWord -Value $last -Key $name -Words $Words
      }
      $processState = 'unknown'
      $pdup = 'none'
      if ($readState -eq 'ok') {
        $found = @()
        foreach ($bag in $bags) {
          foreach ($bagKey in @(Get-LiveEnvBagKeys $bag)) {
            if ([string]::Equals([string]$bagKey, $name, [System.StringComparison]::OrdinalIgnoreCase)) {
              $found += (Get-LiveEnvStateWord -Value (Convert-LiveEnvBagValue (Get-LiveEnvBagItem $bag ([string]$bagKey))) -Key $name -Words $Words)
            }
          }
        }
        if ($found.Count -eq 0) { $processState = 'absent' }
        else {
          $processState = $found[0]
          foreach ($foundWord in $found) { if ($Rank[$foundWord] -gt $Rank[$processState]) { $processState = $foundWord } }
          if ($found.Count -gt 1) {
            if (@($found | Sort-Object -Unique).Count -gt 1) { $pdup = 'differs' } else { $pdup = 'same' }
          }
        }
      }
      $machineWord = 'absent'
      $userWord = 'absent'
      try { $machineWord = Get-LiveEnvStateWord -Value ([Environment]::GetEnvironmentVariable($name, 'Machine')) -Key $name -Words $Words } catch { $machineWord = 'absent' }
      try { $userWord = Get-LiveEnvStateWord -Value ([Environment]::GetEnvironmentVariable($name, 'User')) -Key $name -Words $Words } catch { $userWord = 'absent' }
      'LIVEENV key={0} process={1} root={2} docker={3} machine={4} user={5} dup={6} pdup={7}' -f $name, $processState, $states['root'], $states['docker'], $machineWord, $userWord, $dup, $pdup
    }
    $pm2Env = $null
    $bags = $null

    if ($null -eq $resultLine) {
      'LIVEENV_RESULT keys=' + $keyList.Count + ' status=complete'
      exit 0
    }
    'LIVEENV_RESULT keys=' + $keyList.Count + ' status=incomplete reason=' + $resultLine
    exit 2
  } catch {
    'LIVEENV_RESULT keys=' + $keyList.Count + ' status=incomplete reason=read_error'
    exit 3
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-LiveEnvCheck
}
