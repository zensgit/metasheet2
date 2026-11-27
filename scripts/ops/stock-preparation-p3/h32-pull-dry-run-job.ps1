# Queues one governed preview, then reads back only the job started by this call.
# Run only under the approved QA write step. No automatic enqueue retry.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TokenFile,
  [Parameter(Mandatory = $true)][string]$ProjectNo,
  [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$Ordinal,
  [ValidateRange(1, 300)][int]$PollSeconds = 120
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_http.ps1')
. (Join-Path $PSScriptRoot '_pull-plan-counts.ps1')
$route = '/api/integration/table-actions/plm.stock-preparation.pull-bom.v1/dry-run-jobs'
function Write-Incomplete([string]$Reason) {
  'PULLDRY_JOB_RESULT file=h32-pull-dry-run-job.ps1 status=incomplete reason=' + $Reason
}

try {
  if (-not (Test-ProjectNo $ProjectNo)) { Write-Incomplete 'project_no_invalid'; exit 2 }
  if (Initialize-Http $TokenFile) { Write-Incomplete 'http_init_failed'; exit 2 }
  $body = @{ parameters = @{ projectNo = $ProjectNo } }
  $start = Invoke-Http 'POST' $route $body -Integration
  if ($start.NoAnswer) { Write-Incomplete 'enqueue_no_answer'; exit 3 }
  'PULLDRY_JOB project={0} enqueue_http={1}' -f $Ordinal, $start.Status
  $jobId = [string]$start.Json.data.jobId
  if ($start.Status -ne 202 -or [string]::IsNullOrWhiteSpace($jobId)) {
    Write-Incomplete 'enqueue_refused'
    exit 3
  }

  $query = $route + '?projectNo=' + [Uri]::EscapeDataString($ProjectNo)
  $elapsed = [Diagnostics.Stopwatch]::StartNew()
  while ($elapsed.Elapsed.TotalSeconds -lt $PollSeconds) {
    $poll = Invoke-Http 'GET' $query -Integration
    if ($poll.NoAnswer -or $poll.Status -ne 200 -or [string]$poll.Json.data.jobId -cne $jobId) {
      Write-Incomplete 'poll_unconfirmed'
      exit 3
    }
    if ($poll.Json.data.status -ceq 'succeeded') {
      $line = Get-PullPlanCountsLine $poll.Json.data.result $Ordinal
      if (-not $line) { Write-Incomplete 'invalid_counts'; exit 3 }
      $line
      'PULLDRY_JOB_RESULT file=h32-pull-dry-run-job.ps1 status=complete'
      exit 0
    }
    if ($poll.Json.data.status -cne 'running') { Write-Incomplete 'job_not_succeeded'; exit 3 }
    Start-Sleep -Seconds 2
  }

  Write-Incomplete 'poll_timeout'
  exit 3
} catch {
  Write-Incomplete 'script_error'
  exit 3
} finally { Clear-Http }
