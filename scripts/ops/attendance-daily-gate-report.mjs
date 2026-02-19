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
const contractWorkflow = String(process.env.CONTRACT_WORKFLOW || 'attendance-gate-contract-matrix.yml').trim()
const protectionWorkflow = String(process.env.PROTECTION_WORKFLOW || 'attendance-branch-protection-prod.yml').trim()
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

async function tryListOpenIssues({ ownerValue, repoValue }) {
  const pathname = `/repos/${ownerValue}/${repoValue}/issues?state=open&per_page=100`
  try {
    const body = await apiGet(pathname)
    const list = Array.isArray(body) ? body : []
    return { list, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    info(`WARN: failed to list open issues: ${message}`)
    return { list: [], error: message }
  }
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

async function tryListZipEntries({ zipPath }) {
  try {
    const { stdout } = await execFileAsync('unzip', ['-Z1', zipPath], { maxBuffer: 2 * 1024 * 1024 })
    return String(stdout || '')
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

async function tryReadZipTextBySuffix({ zipPath, suffix }) {
  const entries = await tryListZipEntries({ zipPath })
  const matches = entries.filter((entry) => entry.endsWith(suffix))
  if (matches.length === 0) return null
  matches.sort()
  const innerPath = matches[matches.length - 1]
  return tryReadZipText({ zipPath, innerPath })
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

function parseBranchProtectionStepSummary(text) {
  if (!text) return null
  const reason = text.match(/^- Failure reason: `([^`]+)`/m)?.[1] || null
  const branch = text.match(/^- Branch: `([^`]+)`/m)?.[1] || null
  const checks = text.match(/^- Required checks: `([^`]+)`/m)?.[1] || null
  const strict = text.match(/^- Require strict: `([^`]+)`/m)?.[1] || null
  const enforceAdmins = text.match(/^- Require enforce admins: `([^`]+)`/m)?.[1] || null
  return {
    reason,
    branch,
    checks,
    strict,
    enforceAdmins,
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

function parsePerfSummaryJson(text) {
  if (!text) return null
  let value = null
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }

  const regressionsRaw = Array.isArray(value?.regressions) ? value.regressions : []
  const regressionsSample = regressionsRaw
    .slice(0, 3)
    .map((entry) => {
      const asString = typeof entry === 'string' ? entry : JSON.stringify(entry)
      return asString.length > 160 ? `${asString.slice(0, 160)}...` : asString
    })
    .filter(Boolean)
    .join(' | ')

  const previewMs = typeof value?.previewMs === 'number' ? value.previewMs : null
  const commitMs = typeof value?.commitMs === 'number' ? value.commitMs : null
  const exportMs = typeof value?.exportMs === 'number' ? value.exportMs : null
  const rollbackMs = typeof value?.rollbackMs === 'number' ? value.rollbackMs : null
  const rows = typeof value?.rows === 'number' ? value.rows : null
  const scenario = typeof value?.scenario === 'string' ? value.scenario : null
  const mode = typeof value?.mode === 'string' ? value.mode : null
  const uploadCsv = typeof value?.uploadCsv === 'boolean' ? value.uploadCsv : null

  return {
    reason: regressionsRaw.length > 0 ? 'REGRESSION' : null,
    scenario,
    rows,
    mode,
    uploadCsv: uploadCsv === null ? null : uploadCsv ? 'true' : 'false',
    previewMs: previewMs === null ? null : String(previewMs),
    commitMs: commitMs === null ? null : String(commitMs),
    exportMs: exportMs === null ? null : String(exportMs),
    rollbackMs: rollbackMs === null ? null : String(rollbackMs),
    regressionsCount: String(regressionsRaw.length),
    regressionsSample: regressionsSample || null,
  }
}

function parseStrictGateSummaryJson(text) {
  if (!text) return null
  let value = null
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }

  const expectedGates = ['preflight', 'apiSmoke', 'provisioning', 'playwrightProd', 'playwrightDesktop', 'playwrightMobile']
  const validStatuses = new Set(['PASS', 'FAIL', 'SKIP'])
  const gates = value && typeof value.gates === 'object' && value.gates ? value.gates : {}
  const gateReasons = value && typeof value.gateReasons === 'object' && value.gateReasons ? value.gateReasons : {}
  const invalidReasonsRaw = []

  const schemaVersionRaw = value && Object.prototype.hasOwnProperty.call(value, 'schemaVersion') ? value.schemaVersion : null
  const schemaVersion = typeof schemaVersionRaw === 'number' && Number.isInteger(schemaVersionRaw) && schemaVersionRaw >= 1
    ? schemaVersionRaw
    : null
  if (schemaVersionRaw !== null && schemaVersion === null) invalidReasonsRaw.push('schema_version')

  if (!(value && typeof value.generatedAt === 'string' && value.generatedAt.trim())) invalidReasonsRaw.push('generated_at')
  if (!(value && typeof value.apiBase === 'string')) invalidReasonsRaw.push('api_base')
  if (!(value && typeof value.webUrl === 'string')) invalidReasonsRaw.push('web_url')
  if (!(value && typeof value.expectProductMode === 'string' && value.expectProductMode.trim())) invalidReasonsRaw.push('expect_product_mode')
  if (!(value && typeof value.exitCode === 'number' && Number.isFinite(value.exitCode))) invalidReasonsRaw.push('exit_code')

  const failed = expectedGates
    .filter((gate) => String(gates?.[gate] || '').toUpperCase() === 'FAIL')
  const failedGates = failed.length > 0 ? failed.join(',') : null
  const failedGateReasons = {}
  for (const gate of failed) {
    const code = gateReasons && Object.prototype.hasOwnProperty.call(gateReasons, gate) ? gateReasons[gate] : null
    if (typeof code === 'string' && code.trim()) {
      failedGateReasons[gate] = code.trim()
    }
  }

  for (const gate of expectedGates) {
    const status = String(gates?.[gate] || '').toUpperCase()
    if (!validStatuses.has(status)) {
      invalidReasonsRaw.push(`gates.${gate}`)
    }
    if (!Object.prototype.hasOwnProperty.call(gateReasons, gate)) {
      continue
    }
    const code = gateReasons[gate]
    if (code === null || code === undefined) continue
    if (typeof code !== 'string' || !/^[A-Z0-9_]+$/.test(code.trim())) {
      invalidReasonsRaw.push(`gateReasons.${gate}`)
    }
  }

  const invalidReasons = Array.from(new Set(invalidReasonsRaw))
  const summaryValid = invalidReasons.length === 0

  return {
    reason: summaryValid ? (failedGates ? 'GATE_FAILED' : null) : 'SUMMARY_INVALID',
    failedGates,
    failedGateReasons,
    schemaVersion,
    summaryValid,
    summaryInvalidReasons: summaryValid ? null : invalidReasons,
    gates,
  }
}

async function tryEnrichGateFromStepSummary({
  ownerValue,
  repoValue,
  runId,
  artifactNamePrefix,
  metaOutDir,
  innerSuffix = null,
  innerPath = 'step-summary.md',
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

    const text = innerSuffix
      ? await tryReadZipTextBySuffix({ zipPath, suffix: innerSuffix })
      : await tryReadZipText({ zipPath, innerPath })
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
  protectionGate,
  metricsGate,
  storageGate,
  cleanupGate,
  strictGate,
  perfGate,
  longrunGate,
  contractGate,
  openTrackingIssues,
  openTrackingIssuesError,
  overallStatus,
  p0Status,
  findings,
}) {
  const workflowByGate = {
    'Remote Preflight': preflightWorkflow,
    'Branch Protection': protectionWorkflow,
    'Host Metrics': metricsWorkflow,
    'Storage Health': storageWorkflow,
    'Upload Cleanup': cleanupWorkflow,
    'Strict Gates': strictWorkflow,
    'Perf Baseline': perfWorkflow,
    'Perf Long Run': longrunWorkflow,
    'Gate Contract Matrix': contractWorkflow,
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
  lines.push('| Gate | Severity | Latest Completed | Conclusion | Reason | Updated (UTC) | Status | Link |')
  lines.push('|---|---|---|---|---|---|---|---|')

  function gateReasonCell(gate) {
    if (!gate || gate.ok) return '-'
    const codes = Array.isArray(gate.findings) ? gate.findings.map((f) => f?.code).filter(Boolean) : []
    const has = (code) => codes.includes(code)
    let reason = 'FAIL'
    if (has('WORKFLOW_QUERY_FAILED')) reason = 'WORKFLOW_QUERY_FAILED'
    else if (has('NO_COMPLETED_RUN')) reason = 'NO_COMPLETED_RUN'
    else if (has('STALE_RUN')) reason = 'STALE_RUN'
    else if (has('STRICT_SUMMARY_INVALID')) reason = 'STRICT_SUMMARY_INVALID'
    else if (has('STRICT_SUMMARY_MISSING')) reason = 'STRICT_SUMMARY_MISSING'
    else if (has('RUN_FAILED')) reason = String(gate?.meta?.reason || 'RUN_FAILED')
    else if (codes.length > 0) reason = String(codes[0])

    const extra = []
    const meta = gate?.meta || null
    if (meta && typeof meta === 'object') {
      if (gate.name === 'Remote Preflight') {
        if (meta.rc) extra.push(`rc=${meta.rc}`)
      }
      if (gate.name === 'Branch Protection') {
        if (meta.branch) extra.push(`branch=${meta.branch}`)
        if (meta.checks) extra.push(`checks=${meta.checks}`)
        if (meta.strict) extra.push(`strict=${meta.strict}`)
        if (meta.enforceAdmins) extra.push(`enforce_admins=${meta.enforceAdmins}`)
      }
      if (gate.name === 'Host Metrics') {
        if (meta.missingMetrics) extra.push(`missing=${meta.missingMetrics}`)
      }
      if (gate.name === 'Storage Health') {
        if (meta.dfUsedPct) extra.push(`df=${meta.dfUsedPct}`)
        if (meta.uploadGb) extra.push(`upload_gb=${meta.uploadGb}`)
        if (meta.oldestFileDays) extra.push(`oldest_days=${meta.oldestFileDays}`)
      }
      if (gate.name === 'Upload Cleanup') {
        if (meta.staleCount) extra.push(`stale_count=${meta.staleCount}`)
      }
      if (gate.name === 'Strict Gates') {
        if (meta.summaryValid === false) extra.push('summary=invalid')
        if (meta.summaryInvalidReasons && Array.isArray(meta.summaryInvalidReasons) && meta.summaryInvalidReasons.length > 0) {
          extra.push(`invalid=${meta.summaryInvalidReasons.slice(0, 2).join(',')}`)
        }
        if (meta.failedGates) extra.push(`failed=${meta.failedGates}`)
        const pairs = meta.failedGateReasons && typeof meta.failedGateReasons === 'object' ? Object.entries(meta.failedGateReasons) : []
        if (pairs.length > 0) {
          const head = pairs.slice(0, 2).map(([k, v]) => `${k}=${v}`)
          extra.push(`reasons=${head.join(' ')}`)
        }
      }
      if (gate.name === 'Perf Baseline' || gate.name === 'Perf Long Run') {
        if (meta.rows) extra.push(`rows=${meta.rows}`)
        if (meta.mode) extra.push(`mode=${meta.mode}`)
        if (meta.uploadCsv) extra.push(`upload=${meta.uploadCsv}`)
        if (meta.regressionsCount) extra.push(`regressions=${meta.regressionsCount}`)
      }
    }

    const value = extra.length > 0 ? `${reason} ${extra.join(' ')}` : reason
    // Keep the table readable.
    if (value.length > 90) return `\`${value.slice(0, 87)}...\``
    return `\`${value}\``
  }

  for (const gate of [preflightGate, protectionGate, metricsGate, storageGate, cleanupGate, strictGate, perfGate, longrunGate, contractGate]) {
    const completed = gate.completed
    const runId = completed.id ? `#${completed.id}` : '-'
    const conclusion = completed.conclusion || '-'
    const reason = gateReasonCell(gate)
    const updatedAt = completed.updatedAt || '-'
    const status = gate.ok ? 'PASS' : 'FAIL'
    const link = completed.url ? `[run](${completed.url})` : '-'
    lines.push(`| ${gate.name} | ${gate.severity} | ${runId} | ${conclusion} | ${reason} | ${updatedAt} | ${status} | ${link} |`)
  }

  lines.push('')
  lines.push('## Artifact Download Commands')
  lines.push('')
  for (const gate of [preflightGate, protectionGate, metricsGate, storageGate, cleanupGate, strictGate, perfGate, longrunGate, contractGate]) {
    const runIdValue = gate?.completed?.id
    if (!runIdValue) continue
    lines.push(`- ${gate.name} (#${runIdValue}): \`gh run download ${runIdValue} -D "output/playwright/ga/${runIdValue}"\``)
  }

  lines.push('')
  lines.push('## Escalation Rules')
  lines.push('')
  lines.push('- `P0` (Remote preflight / strict gate failure): immediate production block, rerun gate after fix, do not proceed with release actions.')
  lines.push('- `P1` (Branch protection / host metrics / storage health / perf / contract-matrix failure/stale runs): fix same day, rerun gates and record evidence.')
  lines.push('- `P2` (weekly upload cleanup signal / missing evidence metadata): fix within 24h.')
  lines.push('')

  if (findings.length === 0) {
    lines.push('## Findings')
    lines.push('')
    lines.push('- None.')
  } else {
    const gateByName = {
      [preflightGate.name]: preflightGate,
      [protectionGate.name]: protectionGate,
      [metricsGate.name]: metricsGate,
      [storageGate.name]: storageGate,
      [cleanupGate.name]: cleanupGate,
      [strictGate.name]: strictGate,
      [perfGate.name]: perfGate,
      [longrunGate.name]: longrunGate,
      [contractGate.name]: contractGate,
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
      if (finding.gate === 'Branch Protection') {
        if (meta?.branch) metaBits.push(`branch=${meta.branch}`)
        if (meta?.checks) metaBits.push(`checks=${meta.checks}`)
        if (meta?.strict) metaBits.push(`strict=${meta.strict}`)
        if (meta?.enforceAdmins) metaBits.push(`enforce_admins=${meta.enforceAdmins}`)
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
      if (finding.gate === 'Perf Baseline' || finding.gate === 'Perf Long Run') {
        if (meta?.rows) metaBits.push(`rows=${meta.rows}`)
        if (meta?.mode) metaBits.push(`mode=${meta.mode}`)
        if (meta?.uploadCsv) metaBits.push(`upload_csv=${meta.uploadCsv}`)
        if (meta?.previewMs) metaBits.push(`preview_ms=${meta.previewMs}`)
        if (meta?.commitMs) metaBits.push(`commit_ms=${meta.commitMs}`)
        if (meta?.exportMs) metaBits.push(`export_ms=${meta.exportMs}`)
        if (meta?.rollbackMs) metaBits.push(`rollback_ms=${meta.rollbackMs}`)
        if (meta?.regressionsCount) metaBits.push(`regressions=${meta.regressionsCount}`)
      }
      if (finding.gate === 'Strict Gates') {
        if (meta?.summaryValid === false) metaBits.push('summary_valid=false')
        if (Array.isArray(meta?.summaryInvalidReasons) && meta.summaryInvalidReasons.length > 0) {
          metaBits.push(`summary_invalid=${meta.summaryInvalidReasons.join(',')}`)
        }
        if (meta?.failedGates) metaBits.push(`failed=${meta.failedGates}`)
        if (meta?.failedGateReasons && typeof meta.failedGateReasons === 'object') {
          for (const [gateName, code] of Object.entries(meta.failedGateReasons)) {
            if (!code) continue
            metaBits.push(`${gateName}_reason=${code}`)
          }
        }
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

    if (findings.some((f) => f && f.gate === 'Branch Protection' && f.code === 'RUN_FAILED')) {
      const reason = String(protectionGate?.meta?.reason || '').trim()
      if (reason) {
        lines.push(`- Branch Protection: failure reason detected: \`${reason}\`.`)
      } else {
        lines.push('- Branch Protection: open the run Step Summary and check `Failure reason`.')
      }
      lines.push('- Branch Protection: keep required checks `contracts (strict)` + `contracts (dashboard)` on `main` and rerun the branch-protection workflow.')
      if (reason === 'BRANCH_NOT_PROTECTED') {
        lines.push('- Branch Protection: `main` is unprotected. Enable branch protection immediately (required status checks + strict) and rerun.')
      } else if (reason === 'REQUIRED_CHECKS_MISSING') {
        lines.push('- Branch Protection: one or more required checks are missing. Restore required contexts and rerun.')
      } else if (reason === 'STRICT_NOT_ENABLED') {
        lines.push('- Branch Protection: `required_status_checks.strict` is disabled. Re-enable strict mode and rerun.')
      } else if (reason === 'ENFORCE_ADMINS_DISABLED') {
        lines.push('- Branch Protection: `enforce_admins.enabled` is disabled. Enable enforce-admins and rerun to prevent bypass pushes.')
      } else if (reason === 'API_FORBIDDEN') {
        lines.push('- Branch Protection: workflow token lacks branch-protection read permission. Configure an admin-capable token secret (for example `ATTENDANCE_ADMIN_GH_TOKEN`) and rerun.')
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

    if (findings.some((f) => f && f.gate === 'Perf Baseline' && f.code === 'RUN_FAILED')) {
      if (perfGate?.meta?.regressionsCount && perfGate.meta.regressionsCount !== '0') {
        lines.push(`- Perf Baseline: regressions detected (count=${perfGate.meta.regressionsCount}). See perf artifacts for details.`)
        if (perfGate.meta.regressionsSample) {
          lines.push(`- Perf Baseline: sample regressions: ${perfGate.meta.regressionsSample}`)
        }
      } else {
        lines.push('- Perf Baseline: inspect perf artifacts (`perf.log`, `perf-summary.json`) for the first error and threshold evaluation.')
      }
    }

    if (findings.some((f) => f && f.gate === 'Perf Long Run' && f.code === 'RUN_FAILED')) {
      if (longrunGate?.meta?.regressionsCount && longrunGate.meta.regressionsCount !== '0') {
        lines.push(`- Perf Long Run: regressions detected (count=${longrunGate.meta.regressionsCount}). See perf artifacts for details.`)
        if (longrunGate.meta.regressionsSample) {
          lines.push(`- Perf Long Run: sample regressions: ${longrunGate.meta.regressionsSample}`)
        }
      } else {
        lines.push('- Perf Long Run: inspect perf artifacts (`perf.log`, scenario summaries) for the first error and threshold evaluation.')
      }
    }

    if (findings.some((f) => f && f.gate === 'Gate Contract Matrix' && f.code === 'RUN_FAILED')) {
      lines.push('- Gate Contract Matrix: contract regression detected. Open matrix artifacts and fix strict/dashboard contract scripts or schema drift before merging.')
    }

    if (findings.some((f) => f && f.gate === 'Strict Gates' && f.code === 'RUN_FAILED')) {
      const failedGates = String(strictGate?.meta?.failedGates || '').trim()
      const failedReasonsObj = strictGate?.meta?.failedGateReasons && typeof strictGate.meta.failedGateReasons === 'object'
        ? strictGate.meta.failedGateReasons
        : null
      if (failedGates) {
        lines.push(`- Strict Gates: failed gates detected: \`${failedGates}\`.`)
      } else {
        lines.push('- Strict Gates: inspect the strict gates artifact logs (`gate-*.log`) to identify the failing gate.')
      }

      if (failedGates.includes('apiSmoke')) {
        const apiReason = failedReasonsObj && typeof failedReasonsObj.apiSmoke === 'string' ? failedReasonsObj.apiSmoke : ''
        if (apiReason) {
          lines.push(`- Strict Gates: \`apiSmoke\` failure reason detected: \`${apiReason}\`.`)
        }
        if (apiReason === 'AUTH_FAILED') {
          lines.push('- Strict Gates: `apiSmoke` auth failed. Refresh the admin token (or rotate JWT secret carefully) and rerun strict gates.')
        } else if (apiReason === 'RATE_LIMITED') {
          lines.push('- Strict Gates: `apiSmoke` was rate-limited. Wait briefly and rerun; consider reviewing rate-limit settings if this is frequent.')
        } else if (apiReason === 'PRODUCT_MODE_MISMATCH') {
          lines.push('- Strict Gates: `apiSmoke` product mode mismatch. Ensure `PRODUCT_MODE=attendance` and `/api/auth/me -> features.mode` matches, then rerun.')
        } else if (apiReason === 'FEATURE_DISABLED') {
          lines.push('- Strict Gates: `apiSmoke` feature disabled. Ensure attendance plugin is enabled in the target environment, then rerun.')
        } else if (apiReason === 'ADMIN_API_MISSING') {
          lines.push('- Strict Gates: `apiSmoke` attendance-admin API missing. Deploy the backend that includes attendance-admin routes, then rerun.')
        } else if (apiReason === 'ADMIN_BATCH_RESOLVE_MISSING') {
          lines.push('- Strict Gates: `apiSmoke` attendance-admin batch resolve API missing. Deploy the backend that includes the batch resolve route (or disable `require_batch_resolve` only for debugging).')
        } else if (apiReason === 'ADMIN_BATCH_RESOLVE_SCHEMA_MISMATCH') {
          lines.push('- Strict Gates: `apiSmoke` batch resolve failed due to DB/schema mismatch. Run DB migrations for attendance-admin users (and verify ID types), redeploy, then rerun.')
        } else if (apiReason === 'ADMIN_BATCH_RESOLVE_FAILED') {
          lines.push('- Strict Gates: `apiSmoke` batch resolve failed. Inspect backend logs + DB, then rerun.')
        } else if (apiReason === 'AUDIT_EXPORT_MISSING') {
          lines.push('- Strict Gates: `apiSmoke` audit export endpoint missing. Deploy backend/route changes for audit export, then rerun.')
        } else if (apiReason === 'AUDIT_SUMMARY_MISSING') {
          lines.push('- Strict Gates: `apiSmoke` audit summary endpoint missing. Deploy backend/route changes for audit summary, then rerun.')
        } else if (apiReason === 'AUDIT_EXPORT_SCHEMA_MISSING') {
          lines.push('- Strict Gates: `apiSmoke` audit export failed due to schema mismatch (missing column). Run DB migrations (audit log table) and redeploy, then rerun.')
        } else if (apiReason === 'AUDIT_EXPORT_BAD_HEADERS') {
          lines.push('- Strict Gates: `apiSmoke` audit export CSV headers mismatch. Deploy backend fixes to ensure headers include `occurredAt/action/route`, then rerun.')
        } else if (apiReason === 'AUDIT_EXPORT_FAILED') {
          lines.push('- Strict Gates: `apiSmoke` audit export failed. Inspect backend logs + DB migrations, then rerun.')
        } else if (apiReason === 'AUDIT_SUMMARY_FAILED' || apiReason === 'AUDIT_SUMMARY_BAD_RESPONSE') {
          lines.push('- Strict Gates: `apiSmoke` audit summary failed. Inspect backend logs + DB migrations, then rerun.')
        } else if (apiReason === 'PREVIEW_ASYNC_IDEMPOTENCY_NOT_SUPPORTED') {
          lines.push('- Strict Gates: `apiSmoke` async preview idempotency retry is not supported (commitToken required). Deploy backend fix for preview-async idempotency, then rerun (disable `require_preview_async` only for debugging).')
        } else if (apiReason === 'IDEMPOTENCY_NOT_SUPPORTED') {
          lines.push('- Strict Gates: `apiSmoke` import commit idempotency retry is not supported. Deploy backend fix for idempotencyKey commit retry, then rerun.')
        } else if (apiReason === 'COMMIT_TOKEN_REJECTED') {
          lines.push('- Strict Gates: `apiSmoke` import commitToken rejected. Inspect `gate-api-smoke.log` for the first COMMIT_TOKEN_* error and verify token issuance/expiry/server clock.')
        } else if (apiReason === 'IMPORT_UPLOAD_FAILED') {
          lines.push('- Strict Gates: `apiSmoke` import upload failed. Run Remote Preflight to validate nginx upload config + volume mount, then rerun.')
        } else if (apiReason === 'IMPORT_EXPORT_MISSING' || apiReason === 'IMPORT_EXPORT_BAD_HEADERS') {
          lines.push('- Strict Gates: `apiSmoke` import export.csv is missing or malformed. Deploy backend fixes and rerun strict gates.')
        } else if (apiReason === 'PLUGIN_INACTIVE') {
          lines.push('- Strict Gates: `apiSmoke` attendance plugin is not active. Enable/activate plugin-attendance in the target environment, then rerun.')
        } else {
          lines.push('- Strict Gates: `apiSmoke` failed. Inspect `gate-api-smoke.log` in the strict gates artifacts.')
        }
      }
      if (failedGates.includes('provisioning')) {
        const provReason = failedReasonsObj && typeof failedReasonsObj.provisioning === 'string' ? failedReasonsObj.provisioning : ''
        if (provReason) {
          lines.push(`- Strict Gates: \`provisioning\` failure reason detected: \`${provReason}\`.`)
        }
        if (provReason === 'AUTH_FAILED') {
          lines.push('- Strict Gates: `provisioning` auth failed. Refresh the admin token and rerun (permission grants require admin).')
        } else if (provReason === 'RATE_LIMITED') {
          lines.push('- Strict Gates: `provisioning` was rate-limited. Wait briefly and rerun.')
        } else if (provReason === 'ENDPOINT_MISSING') {
          lines.push('- Strict Gates: `provisioning` endpoint missing. Ensure backend routes include `/api/permissions/grant`, then redeploy.')
        } else if (provReason === 'DNS_FAILED') {
          lines.push('- Strict Gates: `provisioning` failed due to DNS resolution. Check deploy DNS/network and rerun.')
        } else if (provReason === 'CONNECTION_REFUSED') {
          lines.push('- Strict Gates: `provisioning` connection refused. Check API availability and rerun.')
        } else if (provReason === 'TIMEOUT') {
          lines.push('- Strict Gates: `provisioning` timed out. Check deploy load/network and rerun.')
        }
        lines.push('- Strict Gates: `provisioning` failed. Inspect `gate-provision-*.log` in the strict gates artifacts.')
      }
      if (failedGates.includes('playwrightProd')) {
        const pwReason = failedReasonsObj && typeof failedReasonsObj.playwrightProd === 'string' ? failedReasonsObj.playwrightProd : ''
        if (pwReason) {
          lines.push(`- Strict Gates: \`playwrightProd\` failure reason detected: \`${pwReason}\`.`)
        }
        if (pwReason === 'AUTH_FAILED') {
          lines.push('- Strict Gates: `playwrightProd` auth failed. Refresh the admin token and rerun.')
        } else if (pwReason === 'PRODUCT_MODE_MISMATCH') {
          lines.push('- Strict Gates: `playwrightProd` product mode mismatch. Ensure `PRODUCT_MODE=attendance` and `/api/auth/me -> features.mode` matches, then rerun.')
        } else if (pwReason === 'FEATURE_DISABLED') {
          lines.push('- Strict Gates: `playwrightProd` feature disabled. Ensure attendance plugin is enabled, then rerun.')
        } else if (pwReason === 'RATE_LIMITED') {
          lines.push('- Strict Gates: `playwrightProd` was rate-limited. Wait briefly and rerun.')
        } else if (pwReason === 'TIMEOUT') {
          lines.push('- Strict Gates: `playwrightProd` timed out. Inspect server load + screenshots; consider increasing playwright timeouts if needed.')
        } else if (pwReason === 'COMMIT_TOKEN_REJECTED') {
          lines.push('- Strict Gates: `playwrightProd` import commitToken rejected. Inspect logs and verify backend commitToken behavior.')
        } else if (pwReason === 'LEGACY_IMPORT_USED') {
          lines.push('- Strict Gates: `playwrightProd` used legacy import API. Deploy frontend/backend changes to use upload + commitToken flow, then rerun.')
        } else if (pwReason === 'PUNCH_TOO_SOON') {
          lines.push('- Strict Gates: `playwrightProd` hit PUNCH_TOO_SOON (business rule). Wait for min punch interval then rerun.')
        }
        lines.push('- Strict Gates: `playwrightProd` failed. Inspect `gate-playwright-production-flow.log` and screenshots under `playwright-production-flow/`.')
      }
      if (failedGates.includes('playwrightDesktop')) {
        const pwReason = failedReasonsObj && typeof failedReasonsObj.playwrightDesktop === 'string' ? failedReasonsObj.playwrightDesktop : ''
        if (pwReason) {
          lines.push(`- Strict Gates: \`playwrightDesktop\` failure reason detected: \`${pwReason}\`.`)
        }
        if (pwReason === 'AUTH_FAILED') {
          lines.push('- Strict Gates: `playwrightDesktop` auth failed. Refresh the admin token and rerun.')
        } else if (pwReason === 'PRODUCT_MODE_MISMATCH') {
          lines.push('- Strict Gates: `playwrightDesktop` product mode mismatch. Ensure `PRODUCT_MODE=attendance` and `/api/auth/me -> features.mode` matches, then rerun.')
        } else if (pwReason === 'FEATURE_DISABLED') {
          lines.push('- Strict Gates: `playwrightDesktop` feature disabled. Ensure attendance plugin is enabled, then rerun.')
        } else if (pwReason === 'RATE_LIMITED') {
          lines.push('- Strict Gates: `playwrightDesktop` was rate-limited. Wait briefly and rerun.')
        } else if (pwReason === 'TIMEOUT') {
          lines.push('- Strict Gates: `playwrightDesktop` timed out. Inspect screenshots + logs; consider increasing timeouts if needed.')
        } else if (pwReason === 'COMMIT_TOKEN_REJECTED') {
          lines.push('- Strict Gates: `playwrightDesktop` import commitToken rejected. Inspect logs and verify backend commitToken behavior.')
        } else if (pwReason === 'LEGACY_IMPORT_USED') {
          lines.push('- Strict Gates: `playwrightDesktop` used legacy import API. Deploy frontend/backend changes to use upload + commitToken flow, then rerun.')
        } else if (pwReason === 'PUNCH_TOO_SOON') {
          lines.push('- Strict Gates: `playwrightDesktop` hit PUNCH_TOO_SOON (business rule). Wait for min punch interval then rerun.')
        }
        lines.push('- Strict Gates: `playwrightDesktop` failed. Inspect `gate-playwright-full-flow-desktop.log` and screenshots under `playwright-full-flow-desktop/`.')
      }
      if (failedGates.includes('playwrightMobile')) {
        const pwReason = failedReasonsObj && typeof failedReasonsObj.playwrightMobile === 'string' ? failedReasonsObj.playwrightMobile : ''
        if (pwReason) {
          lines.push(`- Strict Gates: \`playwrightMobile\` failure reason detected: \`${pwReason}\`.`)
        }
        if (pwReason === 'AUTH_FAILED') {
          lines.push('- Strict Gates: `playwrightMobile` auth failed. Refresh the admin token and rerun.')
        } else if (pwReason === 'PRODUCT_MODE_MISMATCH') {
          lines.push('- Strict Gates: `playwrightMobile` product mode mismatch. Ensure `PRODUCT_MODE=attendance` and `/api/auth/me -> features.mode` matches, then rerun.')
        } else if (pwReason === 'FEATURE_DISABLED') {
          lines.push('- Strict Gates: `playwrightMobile` feature disabled. Ensure attendance plugin is enabled, then rerun.')
        } else if (pwReason === 'RATE_LIMITED') {
          lines.push('- Strict Gates: `playwrightMobile` was rate-limited. Wait briefly and rerun.')
        } else if (pwReason === 'TIMEOUT') {
          lines.push('- Strict Gates: `playwrightMobile` timed out. Inspect screenshots + logs; consider increasing timeouts if needed.')
        } else if (pwReason === 'COMMIT_TOKEN_REJECTED') {
          lines.push('- Strict Gates: `playwrightMobile` import commitToken rejected. Inspect logs and verify backend commitToken behavior.')
        } else if (pwReason === 'LEGACY_IMPORT_USED') {
          lines.push('- Strict Gates: `playwrightMobile` used legacy import API. Deploy frontend/backend changes to use upload + commitToken flow, then rerun.')
        } else if (pwReason === 'PUNCH_TOO_SOON') {
          lines.push('- Strict Gates: `playwrightMobile` hit PUNCH_TOO_SOON (business rule). Wait for min punch interval then rerun.')
        }
        lines.push('- Strict Gates: `playwrightMobile` failed. Inspect `gate-playwright-full-flow-mobile.log` and screenshots under `playwright-full-flow-mobile/`.')
      }
    }

    if (findings.some((f) => f && f.gate === 'Strict Gates' && f.code === 'STRICT_SUMMARY_INVALID')) {
      lines.push('- Strict Gates: latest run has an invalid `gate-summary.json` contract (fields/types/status values).')
      lines.push('- Strict Gates: inspect strict artifact `gate-summary.json` and ensure schema/version fields are emitted by the latest scripts.')
    }

    if (findings.some((f) => f && f.gate === 'Strict Gates' && f.code === 'STRICT_SUMMARY_MISSING')) {
      lines.push('- Strict Gates: latest run is `success` but `gate-summary.json` is missing from strict artifacts.')
      lines.push('- Strict Gates: rerun strict gates and verify upload artifacts include gate summaries before considering the gate healthy.')
    }
  }

  lines.push('')
  lines.push('## Suggested Actions')
  lines.push('')
  lines.push('1. Re-run remote preflight or strict gate manually when any `P0` finding exists.')
  lines.push('2. Re-run branch protection / host metrics / storage health / perf baseline / perf long run / contract matrix manually when any `P1` finding exists.')
  lines.push('3. Record evidence paths in production acceptance docs after gate recovery.')
  lines.push('')
  lines.push('Quick re-run commands:')
  lines.push('')
  for (const gate of [preflightGate, protectionGate, metricsGate, storageGate, cleanupGate, strictGate, perfGate, longrunGate, contractGate]) {
    const wf = workflowByGate[gate.name]
    if (!wf) continue
    lines.push(`- \`${gate.name}\`: \`gh workflow run ${wf}\``)
  }

  lines.push('')
  lines.push('## Open Tracking Issues (P1)')
  lines.push('')
  if (openTrackingIssuesError) {
    lines.push(`- Unable to list open issues: \`${openTrackingIssuesError}\``)
  } else if (!Array.isArray(openTrackingIssues) || openTrackingIssues.length === 0) {
    lines.push('- None open.')
  } else {
    for (const issue of openTrackingIssues) {
      const number = issue?.number ? `#${issue.number}` : '#?'
      const title = String(issue?.title || '').trim() || '(missing title)'
      const url = String(issue?.html_url || '').trim()
      const updatedAt = String(issue?.updated_at || '').trim()
      const link = url ? `[${number}](${url})` : number
      lines.push(`- ${link}: ${title}${updatedAt ? ` (updated: \`${updatedAt}\`)` : ''}`)
    }
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
  const protectionRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: protectionWorkflow, branchValue: branch })
  const metricsRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: metricsWorkflow, branchValue: branch })
  const storageRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: storageWorkflow, branchValue: branch })
  const cleanupRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: cleanupWorkflow, branchValue: branch })
  const strictRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: strictWorkflow, branchValue: branch })
  const perfRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: perfWorkflow, branchValue: branch })
  const longrunRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: longrunWorkflow, branchValue: branch })
  const contractRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: contractWorkflow, branchValue: branch })

  const preflightListRaw = Array.isArray(preflightRuns?.list) ? preflightRuns.list : []
  const preflightList = includeDrillRuns ? preflightListRaw : preflightListRaw.filter((run) => !isDrillRun(run))
  if (!includeDrillRuns && preflightListRaw.length !== preflightList.length) {
    info(`preflight: filtered drill/debug runs (${preflightListRaw.length - preflightList.length})`)
  }
  const protectionListRaw = Array.isArray(protectionRuns?.list) ? protectionRuns.list : []
  const protectionList = includeDrillRuns ? protectionListRaw : protectionListRaw.filter((run) => !isDrillRun(run))
  if (!includeDrillRuns && protectionListRaw.length !== protectionList.length) {
    info(`protection: filtered drill/debug runs (${protectionListRaw.length - protectionList.length})`)
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
  const contractListRaw = Array.isArray(contractRuns?.list) ? contractRuns.list : []
  const contractList = includeDrillRuns ? contractListRaw : contractListRaw.filter((run) => !isDrillRun(run))
  if (!includeDrillRuns && contractListRaw.length !== contractList.length) {
    info(`contract: filtered drill/debug runs (${contractListRaw.length - contractList.length})`)
  }

  const preflightLatestAny = preflightList[0] ?? null
  const preflightLatestCompleted = preflightList.find((run) => run?.status === 'completed') ?? null
  const protectionLatestAny = protectionList[0] ?? null
  const protectionLatestCompleted = protectionList.find((run) => run?.status === 'completed') ?? null
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
  const contractLatestAny = contractList[0] ?? null
  const contractLatestCompleted = contractList.find((run) => run?.status === 'completed') ?? null

  const preflightGate = evaluateGate({
    name: 'Remote Preflight',
    severity: 'P0',
    latestAny: preflightLatestAny,
    latestCompleted: preflightLatestCompleted,
    now,
    lookbackHoursValue: lookbackHours,
    fetchError: preflightRuns.error,
  })
  const protectionGate = evaluateGate({
    name: 'Branch Protection',
    severity: 'P1',
    latestAny: protectionLatestAny,
    latestCompleted: protectionLatestCompleted,
    now,
    lookbackHoursValue: lookbackHours,
    fetchError: protectionRuns.error,
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

  const contractGate = evaluateGate({
    name: 'Gate Contract Matrix',
    severity: 'P1',
    latestAny: contractLatestAny,
    latestCompleted: contractLatestCompleted,
    now,
    lookbackHoursValue: lookbackHours,
    fetchError: contractRuns.error,
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
    if (hasRunFailed(protectionGate) && protectionGate.completed?.id) {
      const runId = protectionGate.completed.id
      const meta = await tryEnrichGateFromStepSummary({
        ownerValue: owner,
        repoValue: repoName,
        runId,
        artifactNamePrefix: `attendance-branch-protection-prod-${runId}-`,
        metaOutDir: path.join(metaRoot, 'protection'),
        parse: parseBranchProtectionStepSummary,
      })
      if (meta) protectionGate.meta = meta
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
    if (strictGate.completed?.id) {
      const runId = strictGate.completed.id
      const meta = await tryEnrichGateFromStepSummary({
        ownerValue: owner,
        repoValue: repoName,
        runId,
        artifactNamePrefix: `attendance-strict-gates-prod-${runId}-`,
        metaOutDir: path.join(metaRoot, 'strict'),
        innerSuffix: 'gate-summary.json',
        parse: parseStrictGateSummaryJson,
      })
      if (meta) {
        strictGate.meta = meta
        if (meta.summaryValid === false) {
          strictGate.ok = false
          strictGate.findings.push({
            severity: 'P0',
            code: 'STRICT_SUMMARY_INVALID',
            gate: 'Strict Gates',
            message: 'Strict Gates: latest completed run has invalid gate-summary.json contract',
            runUrl: strictGate.completed.url,
          })
        }
      } else if (strictGate.completed?.conclusion === 'success') {
        strictGate.ok = false
        strictGate.findings.push({
          severity: 'P0',
          code: 'STRICT_SUMMARY_MISSING',
          gate: 'Strict Gates',
          message: 'Strict Gates: latest completed run succeeded but gate-summary.json is missing from artifacts',
          runUrl: strictGate.completed.url,
        })
      }
    }
    if (hasRunFailed(perfGate) && perfGate.completed?.id) {
      const runId = perfGate.completed.id
      const meta = await tryEnrichGateFromStepSummary({
        ownerValue: owner,
        repoValue: repoName,
        runId,
        artifactNamePrefix: `attendance-import-perf-${runId}-`,
        metaOutDir: path.join(metaRoot, 'perf'),
        innerSuffix: 'perf-summary.json',
        parse: parsePerfSummaryJson,
      })
      if (meta) perfGate.meta = meta
    }
    if (hasRunFailed(longrunGate) && longrunGate.completed?.id) {
      const runId = longrunGate.completed.id
      const meta = await tryEnrichGateFromStepSummary({
        ownerValue: owner,
        repoValue: repoName,
        runId,
        artifactNamePrefix: `attendance-import-perf-longrun-rows10k-commit-${runId}-`,
        metaOutDir: path.join(metaRoot, 'longrun'),
        innerSuffix: 'rows10000-commit.json',
        parse: parsePerfSummaryJson,
      })
      if (meta) {
        longrunGate.meta = meta
      } else {
        const drillMeta = await tryEnrichGateFromStepSummary({
          ownerValue: owner,
          repoValue: repoName,
          runId,
          artifactNamePrefix: `attendance-import-perf-longrun-drill-${runId}-`,
          metaOutDir: path.join(metaRoot, 'longrun'),
          innerSuffix: 'rows10000-commit.json',
          parse: parsePerfSummaryJson,
        })
        if (drillMeta) longrunGate.meta = drillMeta
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    info(`WARN: gate meta enrichment skipped: ${message}`)
  }

  const findings = [
    ...preflightGate.findings,
    ...protectionGate.findings,
    ...metricsGate.findings,
    ...storageGate.findings,
    ...cleanupGate.findings,
    ...strictGate.findings,
    ...perfGate.findings,
    ...longrunGate.findings,
    ...contractGate.findings,
  ]
  const overallStatus = findings.length === 0 ? 'pass' : 'fail'
  const p0Status = findings.some((f) => f && f.severity === 'P0') ? 'fail' : 'pass'

  const openIssues = await tryListOpenIssues({ ownerValue: owner, repoValue: repoName })
  const openIssuesListRaw = Array.isArray(openIssues?.list) ? openIssues.list : []
  const openTrackingIssues = openIssuesListRaw
    .filter((issue) => issue && !issue.pull_request && String(issue.title || '').startsWith('[Attendance P1]'))
    .slice(0, 10)
  const openTrackingIssuesError = openIssues.error

  function toGateFlat(gate) {
    const completed = gate?.completed && typeof gate.completed === 'object' ? gate.completed : {}
    const meta = gate?.meta && typeof gate.meta === 'object' ? gate.meta : null

    const codesRaw = Array.isArray(gate?.findings)
      ? gate.findings.map((f) => (f && f.code ? String(f.code) : '')).filter(Boolean)
      : []
    const codes = Array.from(new Set(codesRaw))
    const has = (code) => codes.includes(code)

    let reasonCode = null
    if (!gate?.ok) {
      if (has('WORKFLOW_QUERY_FAILED')) reasonCode = 'WORKFLOW_QUERY_FAILED'
      else if (has('NO_COMPLETED_RUN')) reasonCode = 'NO_COMPLETED_RUN'
      else if (has('STALE_RUN')) reasonCode = 'STALE_RUN'
      else if (has('STRICT_SUMMARY_INVALID')) reasonCode = 'STRICT_SUMMARY_INVALID'
      else if (has('STRICT_SUMMARY_MISSING')) reasonCode = 'STRICT_SUMMARY_MISSING'
      else if (has('RUN_FAILED')) reasonCode = String(meta?.reason || 'RUN_FAILED')
      else reasonCode = codes[0] || 'FAIL'
    }

    const summaryBits = []
    if (meta) {
      if (gate.name === 'Remote Preflight') {
        if (meta.rc) summaryBits.push(`rc=${meta.rc}`)
      } else if (gate.name === 'Branch Protection') {
        if (meta.branch) summaryBits.push(`branch=${meta.branch}`)
        if (meta.checks) summaryBits.push(`checks=${meta.checks}`)
        if (meta.strict) summaryBits.push(`strict=${meta.strict}`)
        if (meta.enforceAdmins) summaryBits.push(`enforce_admins=${meta.enforceAdmins}`)
      } else if (gate.name === 'Host Metrics') {
        if (meta.missingMetrics) summaryBits.push(`missing=${meta.missingMetrics}`)
        if (meta.metricsUrl) summaryBits.push(`metrics_url=${meta.metricsUrl}`)
      } else if (gate.name === 'Storage Health') {
        if (meta.dfUsedPct) summaryBits.push(`df_used_pct=${meta.dfUsedPct}`)
        if (meta.uploadGb) summaryBits.push(`upload_gb=${meta.uploadGb}`)
        if (meta.oldestFileDays) summaryBits.push(`oldest_days=${meta.oldestFileDays}`)
      } else if (gate.name === 'Upload Cleanup') {
        if (meta.staleCount) summaryBits.push(`stale_count=${meta.staleCount}`)
      } else if (gate.name === 'Strict Gates') {
        if (meta.failedGates) summaryBits.push(`failed=${meta.failedGates}`)
        const pairs = meta.failedGateReasons && typeof meta.failedGateReasons === 'object' ? Object.entries(meta.failedGateReasons) : []
        if (pairs.length > 0) {
          summaryBits.push(`reasons=${pairs.slice(0, 3).map(([k, v]) => `${k}=${v}`).join(' ')}`)
        }
      } else if (gate.name === 'Perf Baseline' || gate.name === 'Perf Long Run') {
        if (meta.rows) summaryBits.push(`rows=${meta.rows}`)
        if (meta.mode) summaryBits.push(`mode=${meta.mode}`)
        if (meta.uploadCsv) summaryBits.push(`upload_csv=${meta.uploadCsv}`)
        if (meta.regressionsCount) summaryBits.push(`regressions=${meta.regressionsCount}`)
      }
    }

    const reasonSummary = reasonCode
      ? summaryBits.length > 0 ? `${reasonCode} ${summaryBits.join(' ')}` : reasonCode
      : null

    const flat = {
      gate: gate?.name || null,
      severity: gate?.severity || null,
      status: gate?.ok ? 'PASS' : 'FAIL',
      reasonCode,
      reasonSummary,
      runId: completed.id ?? null,
      runUrl: completed.url ?? null,
      conclusion: completed.conclusion ?? null,
      updatedAt: completed.updatedAt ?? null,
    }

    if (gate.name === 'Strict Gates') {
      flat.summaryPresent = Boolean(meta)
      flat.summaryValid = meta ? (meta.summaryValid !== false) : false
      flat.summarySchemaVersion = meta?.schemaVersion ?? null
      flat.summaryInvalidReasons = Array.isArray(meta?.summaryInvalidReasons) ? meta.summaryInvalidReasons : null
    }

    if (meta) {
      if (gate.name === 'Remote Preflight') {
        flat.remoteExitCode = meta.rc ?? null
      } else if (gate.name === 'Branch Protection') {
        flat.branch = meta.branch ?? null
        flat.requiredChecks = meta.checks ?? null
        flat.requireStrict = meta.strict ?? null
        flat.requireEnforceAdmins = meta.enforceAdmins ?? null
      } else if (gate.name === 'Host Metrics') {
        flat.missingMetrics = meta.missingMetrics ?? null
        flat.metricsUrl = meta.metricsUrl ?? null
      } else if (gate.name === 'Storage Health') {
        flat.dfUsedPct = meta.dfUsedPct ?? null
        flat.uploadGb = meta.uploadGb ?? null
        flat.oldestFileDays = meta.oldestFileDays ?? null
        flat.fileCount = meta.fileCount ?? null
      } else if (gate.name === 'Upload Cleanup') {
        flat.staleCount = meta.staleCount ?? null
      } else if (gate.name === 'Strict Gates') {
        flat.failedGates = meta.failedGates ?? null
        flat.failedGateReasons = meta.failedGateReasons ?? null
      } else if (gate.name === 'Perf Baseline' || gate.name === 'Perf Long Run') {
        flat.scenario = meta.scenario ?? null
        flat.rows = meta.rows ?? null
        flat.mode = meta.mode ?? null
        flat.uploadCsv = meta.uploadCsv ?? null
        flat.previewMs = meta.previewMs ?? null
        flat.commitMs = meta.commitMs ?? null
        flat.exportMs = meta.exportMs ?? null
        flat.rollbackMs = meta.rollbackMs ?? null
        flat.regressionsCount = meta.regressionsCount ?? null
        flat.regressionsSample = meta.regressionsSample ?? null
      }
    }

    return flat
  }

  const gateFlat = {
    schemaVersion: 2,
    preflight: toGateFlat(preflightGate),
    protection: toGateFlat(protectionGate),
    metrics: toGateFlat(metricsGate),
    storage: toGateFlat(storageGate),
    cleanup: toGateFlat(cleanupGate),
    strict: toGateFlat(strictGate),
    perf: toGateFlat(perfGate),
    longrun: toGateFlat(longrunGate),
    contract: toGateFlat(contractGate),
  }

  const report = {
    generatedAt,
    repository: repo,
    branch,
    lookbackHours,
    p0Status,
    overallStatus,
    openTrackingIssues,
    gateFlat,
    gates: {
      preflight: preflightGate,
      protection: protectionGate,
      metrics: metricsGate,
      storage: storageGate,
      cleanup: cleanupGate,
      strict: strictGate,
      perf: perfGate,
      longrun: longrunGate,
      contract: contractGate,
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
    protectionGate,
    metricsGate,
    storageGate,
    cleanupGate,
    strictGate,
    perfGate,
    longrunGate,
    contractGate,
    openTrackingIssues,
    openTrackingIssuesError,
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
