/**
 * Attendance Daily Gate Dashboard Report
 *
 * Collects the latest runs for strict/perf workflows from GitHub Actions,
 * evaluates gate health, and writes Markdown + JSON evidence.
 *
 * Outputs (stdout + optional GITHUB_OUTPUT):
 * - REPORT_STATUS=pass|fail
 * - REPORT_DIR=...
 * - REPORT_MARKDOWN=...
 * - REPORT_JSON=...
 */

import fs from 'fs/promises'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const token = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()
const repo = String(process.env.GITHUB_REPOSITORY || 'zensgit/metasheet2').trim()
const apiBase = String(process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
const branch = String(process.env.BRANCH || 'main').trim()
const includeDrillRuns = String(process.env.INCLUDE_DRILL_RUNS || '').trim() === 'true'
const preflightWorkflow = String(process.env.PREFLIGHT_WORKFLOW || 'attendance-remote-preflight-prod.yml').trim()
const metricsWorkflow = String(process.env.METRICS_WORKFLOW || 'attendance-remote-metrics-prod.yml').trim()
const storageWorkflow = String(process.env.STORAGE_WORKFLOW || 'attendance-remote-storage-prod.yml').trim()
const cleanupWorkflow = String(process.env.CLEANUP_WORKFLOW || 'attendance-remote-upload-cleanup-prod.yml').trim()
const strictWorkflow = String(process.env.STRICT_WORKFLOW || 'attendance-strict-gates-prod.yml').trim()
const perfWorkflow = String(process.env.PERF_WORKFLOW || 'attendance-import-perf-baseline.yml').trim()
const longrunWorkflow = String(process.env.LONGRUN_WORKFLOW || 'attendance-import-perf-longrun.yml').trim()
const lookbackHours = Math.max(1, Number(process.env.LOOKBACK_HOURS || 36))
const outputRoot = String(process.env.OUTPUT_DIR || 'output/playwright/attendance-daily-gate-dashboard').trim()

const [owner, repoName] = repo.split('/')

function die(message) {
  console.error(`[attendance-daily-gate-report] ERROR: ${message}`)
  process.exit(1)
}

function info(message) {
  console.log(`[attendance-daily-gate-report] ${message}`)
}

function toIsoNoMs(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function makeRunId() {
  const d = new Date()
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

function isDrillRun(run) {
  // Workflows may tag run-name like "... [DRILL]" for expected failure drills, or
  // "... [DEBUG]" for manual debug runs that should not replace production signals.
  const title = String(run?.display_title || run?.name || '').toUpperCase()
  return title.includes('[DRILL]') || title.includes('[DEBUG]')
}

const execFileAsync = promisify(execFile)

async function apiGet(pathname) {
  const url = `${apiBase}${pathname}`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'attendance-daily-gate-report',
    },
  })
  const raw = await res.text()
  let body = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    throw new Error(`GET ${pathname} failed: HTTP ${res.status} ${raw.slice(0, 240)}`)
  }
  return body
}

async function tryGetRunArtifacts({ ownerValue, repoValue, runId }) {
  const pathname = `/repos/${ownerValue}/${repoValue}/actions/runs/${runId}/artifacts?per_page=100`
  try {
    const body = await apiGet(pathname)
    const list = Array.isArray(body?.artifacts) ? body.artifacts : []
    return { list, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    info(`WARN: failed to query run artifacts for ${runId}: ${message}`)
    return { list: [], error: message }
  }
}

async function tryDownloadArtifactZip({ archiveUrl, zipPath }) {
  try {
    const res = await fetch(archiveUrl, {
      headers: {
        // GitHub REST API requires JSON accept headers for artifact download endpoints
        // (the response is a redirect to the actual archive URL).
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'attendance-daily-gate-report',
      },
      redirect: 'follow',
    })
    if (!res.ok) {
      const raw = await res.text()
      throw new Error(`HTTP ${res.status} ${raw.slice(0, 240)}`)
    }
    const ab = await res.arrayBuffer()
    await fs.writeFile(zipPath, Buffer.from(ab))
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    info(`WARN: failed to download artifact zip: ${message}`)
    return false
  }
}

async function tryReadZipText({ zipPath, innerPath }) {
  try {
    const { stdout } = await execFileAsync('unzip', ['-p', zipPath, innerPath], { maxBuffer: 2 * 1024 * 1024 })
    return String(stdout || '')
  } catch {
    return null
  }
}

function parseMetricsStepSummary(text) {
  if (!text) return null
  const reason = text.match(/^- Failure reason: `([^`]+)`/m)?.[1] || null
  const missingMetrics = text.match(/^- Missing metrics: `([^`]+)`/m)?.[1] || null
  const urlMatch = text.match(/^- Metrics URL: `([^`]+)` \(max_time=`([^`]+)`s\)/m)
  const metricsUrl = urlMatch?.[1] || null
  const maxTime = urlMatch?.[2] || null
  return {
    reason,
    missingMetrics,
    metricsUrl,
    maxTime,
  }
}

function parsePreflightStepSummary(text) {
  if (!text) return null

  const rc = text.match(/^- Remote exit code: `([^`]+)`/m)?.[1] || null

  // Attempt to classify the first preflight error line into a stable reason code.
  const errorLine = text.match(/^\[attendance-preflight\] ERROR: (.+)$/m)?.[1] || null
  const message = String(errorLine || '').trim()

  let reason = null
  if (rc === '97') {
    reason = 'DRILL_FAIL'
  } else if (message.includes('Compose file not found')) {
    reason = 'COMPOSE_FILE_MISSING'
  } else if (message.includes('Missing env file')) {
    reason = 'ENV_FILE_MISSING'
  } else if (message.includes('Missing nginx config')) {
    reason = 'NGINX_CONF_MISSING'
  } else if (message.includes('exposes Postgres port 5432')) {
    reason = 'DB_EXPOSED'
  } else if (message.includes('exposes Redis port 6379')) {
    reason = 'REDIS_EXPOSED'
  } else if (message.includes('JWT_SECRET is missing')) {
    reason = 'JWT_SECRET_MISSING'
  } else if (message.includes("JWT_SECRET is still 'change-me'")) {
    reason = 'JWT_SECRET_INSECURE'
  } else if (message.includes('POSTGRES_PASSWORD is missing')) {
    reason = 'POSTGRES_PASSWORD_MISSING'
  } else if (message.includes("POSTGRES_PASSWORD is still 'change-me'")) {
    reason = 'POSTGRES_PASSWORD_INSECURE'
  } else if (message.includes('DATABASE_URL is missing')) {
    reason = 'DATABASE_URL_MISSING'
  } else if (message.includes("DATABASE_URL still contains 'change-me'")) {
    reason = 'DATABASE_URL_INSECURE'
  } else if (message.includes('ATTENDANCE_IMPORT_REQUIRE_TOKEN must be set to')) {
    reason = 'IMPORT_REQUIRE_TOKEN_MISSING'
  } else if (message.includes('ATTENDANCE_IMPORT_UPLOAD_DIR is missing')) {
    reason = 'UPLOAD_DIR_MISSING'
  } else if (message.includes('ATTENDANCE_IMPORT_UPLOAD_DIR must be an absolute path')) {
    reason = 'UPLOAD_DIR_NOT_ABSOLUTE'
  } else if (message.includes('docker-compose volume mount for ATTENDANCE_IMPORT_UPLOAD_DIR not found')) {
    reason = 'UPLOAD_DIR_VOLUME_MOUNT_MISSING'
  } else if (message.includes('nginx upload location missing')) {
    reason = 'NGINX_UPLOAD_LOCATION_MISSING'
  } else if (message.includes('nginx upload location is missing client_max_body_size')) {
    reason = 'NGINX_UPLOAD_BODY_SIZE_MISSING'
  } else if (message.includes('nginx upload client_max_body_size too small')) {
    reason = 'NGINX_UPLOAD_BODY_SIZE_TOO_SMALL'
  } else if (message) {
    reason = 'PREFLIGHT_FAILED'
  } else if (rc && rc !== '0') {
    reason = 'REMOTE_FAILED'
  }

  return {
    rc,
    reason,
  }
}

function parseStorageStepSummary(text) {
  if (!text) return null
  const reason = text.match(/^- Failure reason: `([^`]+)`/m)?.[1] || null
  const computedMatch = text.match(
    /- Computed: df_used_pct=`([^`]+)` .* upload_gb=`([^`]+)` .* oldest_file_days=`([^`]+)` .* file_count=`([^`]+)`/m,
  )
  const dfUsedPct = computedMatch?.[1] || null
  const uploadGb = computedMatch?.[2] || null
  const oldestFileDays = computedMatch?.[3] || null
  const fileCount = computedMatch?.[4] || null
  return {
    reason,
    dfUsedPct,
    uploadGb,
    oldestFileDays,
    fileCount,
  }
}

function parseCleanupStepSummary(text) {
  if (!text) return null
  const reason = text.match(/^- Failure reason: `([^`]+)`/m)?.[1] || null
  const staleCount = text.match(/^\[attendance-clean-uploads\] stale_count=([0-9]+)/m)?.[1] || null
  return {
    reason,
    staleCount,
  }
}

async function tryEnrichGateFromStepSummary({
  ownerValue,
  repoValue,
  runId,
  artifactNamePrefix,
  metaOutDir,
  parse,
}) {
  const artifacts = await tryGetRunArtifacts({ ownerValue, repoValue, runId })
  if (artifacts.error) return null
  const list = Array.isArray(artifacts.list) ? artifacts.list : []

  const match = list.find((a) => a && typeof a.name === 'string' && a.name.startsWith(artifactNamePrefix)) || null
  if (!match || !match.archive_download_url) return null

  const tmpDir = path.join(metaOutDir, '.tmp')
  const zipPath = path.join(tmpDir, `${match.name}.zip`)
  await fs.mkdir(tmpDir, { recursive: true })

  try {
    const ok = await tryDownloadArtifactZip({ archiveUrl: match.archive_download_url, zipPath })
    if (!ok) return null

    const text = await tryReadZipText({ zipPath, innerPath: 'step-summary.md' })
    if (!text) return null

    const parsed = parse(text)
    if (!parsed) return null

    const meta = {
      runId,
      artifactId: match.id ?? null,
      artifactName: match.name,
      ...parsed,
    }
    await fs.mkdir(metaOutDir, { recursive: true })
    await fs.writeFile(path.join(metaOutDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    return meta
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    info(`WARN: gate meta enrichment failed: ${message}`)
    return null
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

async function tryGetWorkflowRuns({ ownerValue, repoValue, workflowFile, branchValue }) {
  const pathname = `/repos/${ownerValue}/${repoValue}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?branch=${encodeURIComponent(branchValue)}&per_page=20`
  try {
    const body = await apiGet(pathname)
    const list = Array.isArray(body?.workflow_runs) ? body.workflow_runs : []
    return { list, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    info(`WARN: failed to query workflow runs for ${workflowFile}: ${message}`)
    return { list: [], error: message }
  }
}

function ageHours(now, iso) {
  if (!iso) return Number.POSITIVE_INFINITY
  const value = Date.parse(iso)
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY
  return (now.getTime() - value) / (1000 * 60 * 60)
}

function formatRun(run) {
  if (!run) {
    return {
      id: null,
      status: 'missing',
      conclusion: 'missing',
      event: null,
      createdAt: null,
      updatedAt: null,
      url: null,
    }
  }
  return {
    id: run.id ?? null,
    status: String(run.status || 'unknown'),
    conclusion: String(run.conclusion || ''),
    event: String(run.event || ''),
    createdAt: run.created_at || null,
    updatedAt: run.updated_at || null,
    url: run.html_url || null,
  }
}

function evaluateGate({ name, severity, latestAny, latestCompleted, now, lookbackHoursValue, fetchError }) {
  const findings = []
  let ok = true
  const completed = formatRun(latestCompleted)
  const latest = formatRun(latestAny)

  if (fetchError) {
    ok = false
    findings.push({
      severity,
      code: 'WORKFLOW_QUERY_FAILED',
      gate: name,
      message: `${name}: failed to query workflow runs: ${fetchError}`,
      runUrl: null,
    })
    return {
      name,
      severity,
      ok,
      latest,
      completed,
      findings,
    }
  }

  if (!latestCompleted) {
    ok = false
    findings.push({
      severity,
      code: 'NO_COMPLETED_RUN',
      gate: name,
      message: `${name}: no completed run found on branch '${branch}'`,
      runUrl: latest.url,
    })
  } else {
    const runAgeHours = ageHours(now, completed.updatedAt)
    if (runAgeHours > lookbackHoursValue) {
      ok = false
      findings.push({
        severity: severity === 'P0' ? 'P1' : severity,
        code: 'STALE_RUN',
        gate: name,
        message: `${name}: latest completed run is stale (${runAgeHours.toFixed(1)}h > ${lookbackHoursValue}h)`,
        runUrl: completed.url,
      })
    }
    if (completed.conclusion !== 'success') {
      ok = false
      findings.push({
        severity,
        code: 'RUN_FAILED',
        gate: name,
        message: `${name}: latest completed run conclusion=${completed.conclusion || 'unknown'}`,
        runUrl: completed.url,
      })
    }
  }

  return {
    name,
    severity,
    ok,
    latest,
    completed,
    findings,
  }
}

function renderMarkdown({
  generatedAt,
  repoValue,
  branchValue,
  lookbackHoursValue,
  cleanupLookbackHoursValue,
  preflightGate,
  metricsGate,
  storageGate,
  cleanupGate,
  strictGate,
  perfGate,
  longrunGate,
  overallStatus,
  p0Status,
  findings,
}) {
  const workflowByGate = {
    'Remote Preflight': preflightWorkflow,
    'Host Metrics': metricsWorkflow,
    'Storage Health': storageWorkflow,
    'Upload Cleanup': cleanupWorkflow,
    'Strict Gates': strictWorkflow,
    'Perf Baseline': perfWorkflow,
    'Perf Long Run': longrunWorkflow,
  }

  const lines = []
  lines.push('# Attendance Daily Gate Dashboard')
  lines.push('')
  lines.push(`Generated at (UTC): \`${generatedAt}\``)
  lines.push(`Repository: \`${repoValue}\``)
  lines.push(`Branch: \`${branchValue}\``)
  lines.push(`Lookback: \`${lookbackHoursValue}h\` (Upload Cleanup uses \`${cleanupLookbackHoursValue}h\`)`)
  lines.push(`P0 Status: **${p0Status.toUpperCase()}**`)
  lines.push(`Overall: **${overallStatus.toUpperCase()}**`)
  lines.push('')
  lines.push('## Gate Status')
  lines.push('')
  lines.push('| Gate | Severity | Latest Completed | Conclusion | Updated (UTC) | Status | Link |')
  lines.push('|---|---|---|---|---|---|---|')

  for (const gate of [preflightGate, metricsGate, storageGate, cleanupGate, strictGate, perfGate, longrunGate]) {
    const completed = gate.completed
    const runId = completed.id ? `#${completed.id}` : '-'
    const conclusion = completed.conclusion || '-'
    const updatedAt = completed.updatedAt || '-'
    const status = gate.ok ? 'PASS' : 'FAIL'
    const link = completed.url ? `[run](${completed.url})` : '-'
    lines.push(`| ${gate.name} | ${gate.severity} | ${runId} | ${conclusion} | ${updatedAt} | ${status} | ${link} |`)
  }

  lines.push('')
  lines.push('## Escalation Rules')
  lines.push('')
  lines.push('- `P0` (Remote preflight / strict gate failure): immediate production block, rerun gate after fix, do not proceed with release actions.')
  lines.push('- `P1` (Host metrics / storage health / perf gate failure/stale runs): fix same day, rerun gates with thresholds and record evidence.')
  lines.push('- `P2` (weekly upload cleanup signal / missing evidence metadata): fix within 24h.')
  lines.push('')

  if (findings.length === 0) {
    lines.push('## Findings')
    lines.push('')
    lines.push('- None.')
  } else {
    const gateByName = {
      [preflightGate.name]: preflightGate,
      [metricsGate.name]: metricsGate,
      [storageGate.name]: storageGate,
      [cleanupGate.name]: cleanupGate,
      [strictGate.name]: strictGate,
      [perfGate.name]: perfGate,
      [longrunGate.name]: longrunGate,
    }
    lines.push('## Findings')
    lines.push('')
    for (const finding of findings) {
      const gate = gateByName[finding.gate] || null
      const meta = gate?.meta || null
      const metaBits = []
      if (meta?.reason) metaBits.push(`reason=${meta.reason}`)
      if (finding.gate === 'Remote Preflight') {
        if (meta?.rc) metaBits.push(`rc=${meta.rc}`)
      }
      if (finding.gate === 'Host Metrics') {
        if (meta?.missingMetrics) metaBits.push(`missing=${meta.missingMetrics}`)
        if (meta?.metricsUrl) metaBits.push(`metrics_url=${meta.metricsUrl}`)
      }
      if (finding.gate === 'Storage Health') {
        if (meta?.dfUsedPct) metaBits.push(`df_used_pct=${meta.dfUsedPct}`)
        if (meta?.uploadGb) metaBits.push(`upload_gb=${meta.uploadGb}`)
        if (meta?.oldestFileDays) metaBits.push(`oldest_days=${meta.oldestFileDays}`)
      }
      if (finding.gate === 'Upload Cleanup') {
        if (meta?.staleCount) metaBits.push(`stale_count=${meta.staleCount}`)
      }
      const metaSuffix = metaBits.length > 0 ? ` (${metaBits.join(' ')})` : ''
      const link = finding.runUrl ? ` ([run](${finding.runUrl}))` : ''
      lines.push(`- [${finding.severity}] ${finding.gate} / ${finding.code}: ${finding.message}${metaSuffix}${link}`)
    }
  }

  lines.push('')
  lines.push('## Remediation Hints')
  lines.push('')
  if (findings.length === 0) {
    lines.push('- None.')
  } else {
    const staleGates = new Set(findings.filter((f) => f && f.code === 'STALE_RUN').map((f) => f.gate))
    for (const gateName of staleGates) {
      const wf = workflowByGate[gateName]
      if (wf) lines.push(`- ${gateName}: stale signal. Re-run: \`gh workflow run ${wf}\``)
    }

    if (findings.some((f) => f && f.gate === 'Host Metrics' && f.code === 'RUN_FAILED')) {
      const reason = String(metricsGate?.meta?.reason || '').trim()
      if (reason) {
        lines.push(`- Host Metrics: failure reason detected: \`${reason}\`.`)
      } else {
        lines.push('- Host Metrics: open the run Step Summary and check `Failure reason`.')
      }

      if (reason === 'METRICS_FETCH_FAILED') {
        lines.push('- Host Metrics: fetch failed. Run Remote Preflight first, verify backend is up and port `8900` is reachable on the host (127.0.0.1), then inspect `metrics.log`.')
      } else if (reason === 'MISSING_REQUIRED_METRICS') {
        lines.push('- Host Metrics: required metric names missing. Verify attendance plugin is enabled and metrics are exported (HELP/TYPE lines exist for required counters). Redeploy if needed, then rerun Host Metrics.')
      } else if (reason) {
        lines.push('- Host Metrics: inspect `metrics.log` and the Step Summary output snippet for the first error.')
      } else {
        lines.push('- If `reason=METRICS_FETCH_FAILED`: run Remote Preflight first, verify backend is up and port `8900` is reachable on the host (127.0.0.1), then inspect `metrics.log`.')
        lines.push('- If `reason=MISSING_REQUIRED_METRICS`: verify attendance plugin is enabled and metrics are exported (HELP/TYPE lines exist for required counters). Redeploy if needed, then rerun Host Metrics.')
      }
    }

    if (findings.some((f) => f && f.gate === 'Storage Health' && f.code === 'RUN_FAILED')) {
      const reason = String(storageGate?.meta?.reason || '').trim()
      if (reason) {
        lines.push(`- Storage Health: failure reason detected: \`${reason}\`.`)
      } else {
        lines.push('- Storage Health: open the run Step Summary and check `Failure reason`.')
      }

      if (reason.includes('FS_USAGE_TOO_HIGH')) {
        lines.push('- Storage Health: filesystem usage too high. Run `Attendance Remote Docker GC (Prod)` (`gh workflow run attendance-remote-docker-gc-prod.yml -f prune=true`), then rerun Storage Health.')
      }
      if (reason.includes('UPLOAD_DIR_TOO_LARGE') || reason.includes('OLDEST_FILE_TOO_OLD')) {
        lines.push('- Storage Health: upload dir needs cleanup. Run `Remote Upload Cleanup (Prod)` (dry-run first; do not delete without confirm), then rerun Storage Health.')
      }
      if (!reason) {
        lines.push('- If `reason` includes `FS_USAGE_TOO_HIGH`: run `Attendance Remote Docker GC (Prod)` (`gh workflow run attendance-remote-docker-gc-prod.yml -f prune=true`), then rerun Storage Health.')
        lines.push('- If `reason` includes `UPLOAD_DIR_TOO_LARGE` or `OLDEST_FILE_TOO_OLD`: run `Remote Upload Cleanup (Prod)` (dry-run first; do not delete without confirm), then rerun Storage Health.')
      }
    }

    if (findings.some((f) => f && f.gate === 'Remote Preflight' && f.code === 'RUN_FAILED')) {
      const reason = String(preflightGate?.meta?.reason || '').trim()
      if (reason) {
        lines.push(`- Remote Preflight: failure reason detected: \`${reason}\`.`)
      }
      lines.push('- Remote Preflight: inspect `preflight.log` for the first failing check. Fix config drift, then rerun Remote Preflight and Strict Gates.')
      if (reason === 'DB_EXPOSED' || reason === 'REDIS_EXPOSED') {
        lines.push('- Remote Preflight: remove DB/Redis port exposure from production compose (use debug compose for localhost only), then redeploy.')
      }
      if (reason === 'IMPORT_REQUIRE_TOKEN_MISSING') {
        lines.push("- Remote Preflight: set `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1` in `docker/app.env` on deploy host, then rerun preflight.")
      }
      if (reason && reason.startsWith('NGINX_UPLOAD_')) {
        lines.push('- Remote Preflight: verify `docker/nginx.conf` includes the upload location and has `client_max_body_size >= 120m`, then redeploy.')
      }
    }

    if (findings.some((f) => f && f.gate === 'Upload Cleanup' && f.code === 'RUN_FAILED')) {
      const reason = String(cleanupGate?.meta?.reason || '').trim()
      if (reason) {
        lines.push(`- Upload Cleanup: failure reason detected: \`${reason}\`.`)
      } else {
        lines.push('- Upload Cleanup: open the run Step Summary and check `Failure reason`.')
      }

      if (reason === 'INPUT_VALIDATION_FAILED') {
        lines.push('- Upload Cleanup: input validation failed. Check workflow inputs (`max_file_age_days`, `max_delete_files`, `max_delete_gb`) and rerun.')
      } else if (reason === 'HOST_SYNC_FAILED') {
        lines.push('- Upload Cleanup: deploy-host sync failed. Run Remote Preflight (or set `skip_host_sync=true` for debugging) and fix host sync, then rerun.')
      } else if (reason) {
        lines.push('- Upload Cleanup: inspect `cleanup.log` for the first error line and rerun with dry-run first (`delete=false`).')
      }
    }
  }

  lines.push('')
  lines.push('## Suggested Actions')
  lines.push('')
  lines.push('1. Re-run remote preflight or strict gate manually when any `P0` finding exists.')
  lines.push('2. Re-run host metrics / storage health / perf baseline / perf long run manually when any `P1` finding exists.')
  lines.push('3. Record evidence paths in production acceptance docs after gate recovery.')
  lines.push('')
  lines.push('Quick re-run commands:')
  lines.push('')
  for (const gate of [preflightGate, metricsGate, storageGate, cleanupGate, strictGate, perfGate, longrunGate]) {
    const wf = workflowByGate[gate.name]
    if (!wf) continue
    lines.push(`- \`${gate.name}\`: \`gh workflow run ${wf}\``)
  }
  return `${lines.join('\n')}\n`
}

async function writeGithubOutput(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) return
  const lines = []
  for (const [key, value] of Object.entries(outputs)) {
    lines.push(`${key}=${String(value)}`)
  }
  await fs.appendFile(outputPath, `${lines.join('\n')}\n`, 'utf8')
}

async function run() {
  if (!owner || !repoName) {
    die(`invalid GITHUB_REPOSITORY: '${repo}'`)
  }
  if (!token) {
    die('GH_TOKEN or GITHUB_TOKEN is required')
  }

  const now = new Date()
  const generatedAt = toIsoNoMs(now)
  const runId = makeRunId()
  const outDir = path.join(outputRoot, runId)
  await fs.mkdir(outDir, { recursive: true })

  info(`repository=${repo} branch=${branch}`)

  const preflightRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: preflightWorkflow, branchValue: branch })
  const metricsRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: metricsWorkflow, branchValue: branch })
  const storageRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: storageWorkflow, branchValue: branch })
  const cleanupRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: cleanupWorkflow, branchValue: branch })
  const strictRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: strictWorkflow, branchValue: branch })
  const perfRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: perfWorkflow, branchValue: branch })
  const longrunRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: longrunWorkflow, branchValue: branch })

  const preflightListRaw = Array.isArray(preflightRuns?.list) ? preflightRuns.list : []
  const preflightList = includeDrillRuns ? preflightListRaw : preflightListRaw.filter((run) => !isDrillRun(run))
  if (!includeDrillRuns && preflightListRaw.length !== preflightList.length) {
    info(`preflight: filtered drill/debug runs (${preflightListRaw.length - preflightList.length})`)
  }
  const metricsListRaw = Array.isArray(metricsRuns?.list) ? metricsRuns.list : []
  const metricsList = includeDrillRuns ? metricsListRaw : metricsListRaw.filter((run) => !isDrillRun(run))
  if (!includeDrillRuns && metricsListRaw.length !== metricsList.length) {
    info(`metrics: filtered drill/debug runs (${metricsListRaw.length - metricsList.length})`)
  }
  const storageListRaw = Array.isArray(storageRuns?.list) ? storageRuns.list : []
  const storageList = includeDrillRuns ? storageListRaw : storageListRaw.filter((run) => !isDrillRun(run))
  if (!includeDrillRuns && storageListRaw.length !== storageList.length) {
    info(`storage: filtered drill/debug runs (${storageListRaw.length - storageList.length})`)
  }
  const cleanupListRaw = Array.isArray(cleanupRuns?.list) ? cleanupRuns.list : []
  const cleanupList = includeDrillRuns ? cleanupListRaw : cleanupListRaw.filter((run) => !isDrillRun(run))
  if (!includeDrillRuns && cleanupListRaw.length !== cleanupList.length) {
    info(`cleanup: filtered drill/debug runs (${cleanupListRaw.length - cleanupList.length})`)
  }
  const strictListRaw = Array.isArray(strictRuns?.list) ? strictRuns.list : []
  const strictList = includeDrillRuns ? strictListRaw : strictListRaw.filter((run) => !isDrillRun(run))
  if (!includeDrillRuns && strictListRaw.length !== strictList.length) {
    info(`strict: filtered drill/debug runs (${strictListRaw.length - strictList.length})`)
  }
  const perfListRaw = Array.isArray(perfRuns?.list) ? perfRuns.list : []
  const perfList = includeDrillRuns ? perfListRaw : perfListRaw.filter((run) => !isDrillRun(run))
  if (!includeDrillRuns && perfListRaw.length !== perfList.length) {
    info(`perf: filtered drill/debug runs (${perfListRaw.length - perfList.length})`)
  }
  const longrunListRaw = Array.isArray(longrunRuns?.list) ? longrunRuns.list : []
  const longrunList = includeDrillRuns ? longrunListRaw : longrunListRaw.filter((run) => !isDrillRun(run))
  if (!includeDrillRuns && longrunListRaw.length !== longrunList.length) {
    info(`longrun: filtered drill/debug runs (${longrunListRaw.length - longrunList.length})`)
  }

  const preflightLatestAny = preflightList[0] ?? null
  const preflightLatestCompleted = preflightList.find((run) => run?.status === 'completed') ?? null
  const metricsLatestAny = metricsList[0] ?? null
  const metricsLatestCompleted = metricsList.find((run) => run?.status === 'completed') ?? null
  const storageLatestAny = storageList[0] ?? null
  const storageLatestCompleted = storageList.find((run) => run?.status === 'completed') ?? null
  const cleanupLatestAny = cleanupList[0] ?? null
  const cleanupLatestCompleted = cleanupList.find((run) => run?.status === 'completed') ?? null
  const strictLatestAny = strictList[0] ?? null
  const strictLatestCompleted = strictList.find((run) => run?.status === 'completed') ?? null
  const perfLatestAny = perfList[0] ?? null
  const perfLatestCompleted = perfList.find((run) => run?.status === 'completed') ?? null
  const longrunLatestAny = longrunList[0] ?? null
  const longrunLatestCompleted = longrunList.find((run) => run?.status === 'completed') ?? null

  const preflightGate = evaluateGate({
    name: 'Remote Preflight',
    severity: 'P0',
    latestAny: preflightLatestAny,
    latestCompleted: preflightLatestCompleted,
    now,
    lookbackHoursValue: lookbackHours,
    fetchError: preflightRuns.error,
  })
  const metricsGate = evaluateGate({
    name: 'Host Metrics',
    severity: 'P1',
    latestAny: metricsLatestAny,
    latestCompleted: metricsLatestCompleted,
    now,
    lookbackHoursValue: lookbackHours,
    fetchError: metricsRuns.error,
  })
  const storageGate = evaluateGate({
    name: 'Storage Health',
    severity: 'P1',
    latestAny: storageLatestAny,
    latestCompleted: storageLatestCompleted,
    now,
    lookbackHoursValue: lookbackHours,
    fetchError: storageRuns.error,
  })
  const cleanupLookbackHours = Math.max(lookbackHours, 200)
  const cleanupGate = evaluateGate({
    name: 'Upload Cleanup',
    severity: 'P2',
    latestAny: cleanupLatestAny,
    latestCompleted: cleanupLatestCompleted,
    now,
    lookbackHoursValue: cleanupLookbackHours,
    fetchError: cleanupRuns.error,
  })
  const strictGate = evaluateGate({
    name: 'Strict Gates',
    severity: 'P0',
    latestAny: strictLatestAny,
    latestCompleted: strictLatestCompleted,
    now,
    lookbackHoursValue: lookbackHours,
    fetchError: strictRuns.error,
  })
  const perfGate = evaluateGate({
    name: 'Perf Baseline',
    severity: 'P1',
    latestAny: perfLatestAny,
    latestCompleted: perfLatestCompleted,
    now,
    lookbackHoursValue: lookbackHours,
    fetchError: perfRuns.error,
  })

  const longrunGate = evaluateGate({
    name: 'Perf Long Run',
    severity: 'P1',
    latestAny: longrunLatestAny,
    latestCompleted: longrunLatestCompleted,
    now,
    lookbackHoursValue: lookbackHours,
    fetchError: longrunRuns.error,
  })

  const hasRunFailed = (gate) => Array.isArray(gate?.findings) && gate.findings.some((f) => f && f.code === 'RUN_FAILED')

  // Best-effort: enrich failing remote gates by parsing their step-summary artifacts.
  // Never fail the dashboard on enrichment errors.
  const metaRoot = path.join(outDir, 'gate-meta')
  try {
    await fs.mkdir(metaRoot, { recursive: true })
    if (hasRunFailed(preflightGate) && preflightGate.completed?.id) {
      const runId = preflightGate.completed.id
      const meta = await tryEnrichGateFromStepSummary({
        ownerValue: owner,
        repoValue: repoName,
        runId,
        artifactNamePrefix: `attendance-remote-preflight-prod-${runId}-`,
        metaOutDir: path.join(metaRoot, 'preflight'),
        parse: parsePreflightStepSummary,
      })
      if (meta) preflightGate.meta = meta
    }
    if (hasRunFailed(metricsGate) && metricsGate.completed?.id) {
      const runId = metricsGate.completed.id
      const meta = await tryEnrichGateFromStepSummary({
        ownerValue: owner,
        repoValue: repoName,
        runId,
        artifactNamePrefix: `attendance-remote-metrics-prod-${runId}-`,
        metaOutDir: path.join(metaRoot, 'metrics'),
        parse: parseMetricsStepSummary,
      })
      if (meta) metricsGate.meta = meta
    }
    if (hasRunFailed(storageGate) && storageGate.completed?.id) {
      const runId = storageGate.completed.id
      const meta = await tryEnrichGateFromStepSummary({
        ownerValue: owner,
        repoValue: repoName,
        runId,
        artifactNamePrefix: `attendance-remote-storage-prod-${runId}-`,
        metaOutDir: path.join(metaRoot, 'storage'),
        parse: parseStorageStepSummary,
      })
      if (meta) storageGate.meta = meta
    }
    if (hasRunFailed(cleanupGate) && cleanupGate.completed?.id) {
      const runId = cleanupGate.completed.id
      const meta = await tryEnrichGateFromStepSummary({
        ownerValue: owner,
        repoValue: repoName,
        runId,
        artifactNamePrefix: `attendance-remote-upload-cleanup-prod-${runId}-`,
        metaOutDir: path.join(metaRoot, 'cleanup'),
        parse: parseCleanupStepSummary,
      })
      if (meta) cleanupGate.meta = meta
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    info(`WARN: gate meta enrichment skipped: ${message}`)
  }

  const findings = [
    ...preflightGate.findings,
    ...metricsGate.findings,
    ...storageGate.findings,
    ...cleanupGate.findings,
    ...strictGate.findings,
    ...perfGate.findings,
    ...longrunGate.findings,
  ]
  const overallStatus = findings.length === 0 ? 'pass' : 'fail'
  const p0Status = findings.some((f) => f && f.severity === 'P0') ? 'fail' : 'pass'

  const report = {
    generatedAt,
    repository: repo,
    branch,
    lookbackHours,
    p0Status,
    overallStatus,
    gates: {
      preflight: preflightGate,
      metrics: metricsGate,
      storage: storageGate,
      cleanup: cleanupGate,
      strict: strictGate,
      perf: perfGate,
      longrun: longrunGate,
    },
    findings,
  }

  const markdown = renderMarkdown({
    generatedAt,
    repoValue: repo,
    branchValue: branch,
    lookbackHoursValue: lookbackHours,
    cleanupLookbackHoursValue: cleanupLookbackHours,
    preflightGate,
    metricsGate,
    storageGate,
    cleanupGate,
    strictGate,
    perfGate,
    longrunGate,
    overallStatus,
    p0Status,
    findings,
  })

  const markdownPath = path.join(outDir, 'attendance-daily-gate-dashboard.md')
  const jsonPath = path.join(outDir, 'attendance-daily-gate-dashboard.json')
  await fs.writeFile(markdownPath, markdown, 'utf8')
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  const outputs = {
    report_p0_status: p0Status,
    report_status: overallStatus,
    report_dir: outDir,
    report_markdown: markdownPath,
    report_json: jsonPath,
  }
  await writeGithubOutput(outputs)

  console.log(`REPORT_STATUS=${overallStatus}`)
  console.log(`REPORT_P0_STATUS=${p0Status}`)
  console.log(`REPORT_DIR=${outDir}`)
  console.log(`REPORT_MARKDOWN=${markdownPath}`)
  console.log(`REPORT_JSON=${jsonPath}`)
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  die(message)
})
