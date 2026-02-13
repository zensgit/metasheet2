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

const token = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()
const repo = String(process.env.GITHUB_REPOSITORY || 'zensgit/metasheet2').trim()
const apiBase = String(process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
const branch = String(process.env.BRANCH || 'main').trim()
const preflightWorkflow = String(process.env.PREFLIGHT_WORKFLOW || 'attendance-remote-preflight-prod.yml').trim()
const metricsWorkflow = String(process.env.METRICS_WORKFLOW || 'attendance-remote-metrics-prod.yml').trim()
const storageWorkflow = String(process.env.STORAGE_WORKFLOW || 'attendance-remote-storage-prod.yml').trim()
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
  // Workflows may tag run-name like "... [DRILL]" for expected failure drills.
  const title = String(run?.display_title || run?.name || '').toUpperCase()
  return title.includes('[DRILL]')
}

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

function renderMarkdown({ generatedAt, repoValue, branchValue, lookbackHoursValue, preflightGate, metricsGate, storageGate, strictGate, perfGate, longrunGate, overallStatus, p0Status, findings }) {
  const lines = []
  lines.push('# Attendance Daily Gate Dashboard')
  lines.push('')
  lines.push(`Generated at (UTC): \`${generatedAt}\``)
  lines.push(`Repository: \`${repoValue}\``)
  lines.push(`Branch: \`${branchValue}\``)
  lines.push(`Lookback: \`${lookbackHoursValue}h\``)
  lines.push(`P0 Status: **${p0Status.toUpperCase()}**`)
  lines.push(`Overall: **${overallStatus.toUpperCase()}**`)
  lines.push('')
  lines.push('## Gate Status')
  lines.push('')
  lines.push('| Gate | Severity | Latest Completed | Conclusion | Updated (UTC) | Status | Link |')
  lines.push('|---|---|---|---|---|---|---|')

  for (const gate of [preflightGate, metricsGate, storageGate, strictGate, perfGate, longrunGate]) {
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
  lines.push('- `P1` (Host metrics / perf gate failure/stale runs): fix same day, rerun gates with thresholds and record evidence.')
  lines.push('- `P2` (missing evidence metadata only): update docs within 24h.')
  lines.push('')

  if (findings.length === 0) {
    lines.push('## Findings')
    lines.push('')
    lines.push('- None.')
  } else {
    lines.push('## Findings')
    lines.push('')
    for (const finding of findings) {
      const link = finding.runUrl ? ` ([run](${finding.runUrl}))` : ''
      lines.push(`- [${finding.severity}] ${finding.gate} / ${finding.code}: ${finding.message}${link}`)
    }
  }

  lines.push('')
  lines.push('## Suggested Actions')
  lines.push('')
  lines.push('1. Re-run remote preflight or strict gate manually when any `P0` finding exists.')
  lines.push('2. Re-run host metrics / perf baseline / perf long run manually when any `P1` finding exists.')
  lines.push('3. Record evidence paths in production acceptance docs after gate recovery.')
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
  const strictRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: strictWorkflow, branchValue: branch })
  const perfRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: perfWorkflow, branchValue: branch })
  const longrunRuns = await tryGetWorkflowRuns({ ownerValue: owner, repoValue: repoName, workflowFile: longrunWorkflow, branchValue: branch })

  const preflightListRaw = Array.isArray(preflightRuns?.list) ? preflightRuns.list : []
  const preflightList = preflightListRaw.filter((run) => !isDrillRun(run))
  if (preflightListRaw.length !== preflightList.length) {
    info(`preflight: filtered drill runs (${preflightListRaw.length - preflightList.length})`)
  }
  const metricsListRaw = Array.isArray(metricsRuns?.list) ? metricsRuns.list : []
  const metricsList = metricsListRaw.filter((run) => !isDrillRun(run))
  if (metricsListRaw.length !== metricsList.length) {
    info(`metrics: filtered drill runs (${metricsListRaw.length - metricsList.length})`)
  }
  const storageListRaw = Array.isArray(storageRuns?.list) ? storageRuns.list : []
  const storageList = storageListRaw.filter((run) => !isDrillRun(run))
  if (storageListRaw.length !== storageList.length) {
    info(`storage: filtered drill runs (${storageListRaw.length - storageList.length})`)
  }
  const strictListRaw = Array.isArray(strictRuns?.list) ? strictRuns.list : []
  const strictList = strictListRaw.filter((run) => !isDrillRun(run))
  if (strictListRaw.length !== strictList.length) {
    info(`strict: filtered drill runs (${strictListRaw.length - strictList.length})`)
  }
  const perfListRaw = Array.isArray(perfRuns?.list) ? perfRuns.list : []
  const perfList = perfListRaw.filter((run) => !isDrillRun(run))
  if (perfListRaw.length !== perfList.length) {
    info(`perf: filtered drill runs (${perfListRaw.length - perfList.length})`)
  }
  const longrunListRaw = Array.isArray(longrunRuns?.list) ? longrunRuns.list : []
  const longrunList = longrunListRaw.filter((run) => !isDrillRun(run))
  if (longrunListRaw.length !== longrunList.length) {
    info(`longrun: filtered drill runs (${longrunListRaw.length - longrunList.length})`)
  }

  const preflightLatestAny = preflightList[0] ?? null
  const preflightLatestCompleted = preflightList.find((run) => run?.status === 'completed') ?? null
  const metricsLatestAny = metricsList[0] ?? null
  const metricsLatestCompleted = metricsList.find((run) => run?.status === 'completed') ?? null
  const storageLatestAny = storageList[0] ?? null
  const storageLatestCompleted = storageList.find((run) => run?.status === 'completed') ?? null
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

  const findings = [
    ...preflightGate.findings,
    ...metricsGate.findings,
    ...storageGate.findings,
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
    preflightGate,
    metricsGate,
    storageGate,
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
