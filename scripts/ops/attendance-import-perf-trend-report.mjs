/**
 * Attendance Import Perf Long-Run Trend Report
 *
 * Reads perf-summary.json files from:
 * - CURRENT_ROOT (required)
 * - HISTORY_ROOT (optional)
 *
 * Produces Markdown + JSON report for 10k/100k commit and 50k/100k/500k preview
 * regression runs.
 */

import fs from 'fs/promises'
import path from 'path'

const currentRoot = String(process.env.CURRENT_ROOT || 'output/playwright/attendance-import-perf-longrun/current').trim()
const historyRoot = String(process.env.HISTORY_ROOT || 'output/playwright/attendance-import-perf-longrun/history').trim()
const outputRoot = String(process.env.OUTPUT_DIR || 'output/playwright/attendance-import-perf-longrun/report').trim()
const trendDepth = Math.max(2, Number(process.env.TREND_DEPTH || 7))
const failOnRegression = process.env.FAIL_ON_REGRESSION === 'true'
const regressionFactor = Number.isFinite(Number(process.env.REGRESSION_FACTOR || 1.3))
  ? Math.max(1.05, Number(process.env.REGRESSION_FACTOR || 1.3))
  : 1.3

function die(message) {
  console.error(`[attendance-import-perf-trend-report] ERROR: ${message}`)
  process.exit(1)
}

function info(message) {
  console.log(`[attendance-import-perf-trend-report] ${message}`)
}

function nowId() {
  const d = new Date()
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function collectSummaryFiles(root) {
  const files = []
  if (!(await pathExists(root))) return files

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (entry.isFile() && entry.name === 'perf-summary.json') {
        files.push(fullPath)
      }
      if (entry.isFile() && /^rows\d+.*\.json$/i.test(entry.name)) {
        files.push(fullPath)
      }
    }
  }

  await walk(root)
  return files
}

function toNumber(value) {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function scenarioSortValue(scenario) {
  const rowsMatch = scenario.match(/(\d{3,})/)
  if (rowsMatch) return Number(rowsMatch[1])
  return Number.MAX_SAFE_INTEGER
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  if (low === high) return sorted[low]
  const weight = rank - low
  return sorted[low] * (1 - weight) + sorted[high] * weight
}

function formatMs(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--'
  return String(Math.round(value))
}

function formatFloat(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--'
  const numeric = Number(value)
  return numeric.toFixed(digits)
}

function formatChunk(items, records) {
  if (!Number.isFinite(items) || !Number.isFinite(records)) return '--'
  return `${Math.floor(items)}/${Math.floor(records)}`
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return '--'
  return `${(value * 100).toFixed(1)}%`
}

function recordFromSummary(summary, sourcePath, sourceType) {
  const rows = toNumber(summary?.rows)
  const mode = String(summary?.mode || '')
  const scenario = String(summary?.scenario || `${rows || 'na'}-${mode || 'unknown'}`)
  const startedAtRaw = String(summary?.startedAt || '')
  const startedAt = startedAtRaw && Number.isFinite(Date.parse(startedAtRaw))
    ? new Date(startedAtRaw).toISOString()
    : null

  return {
    scenario,
    rows,
    mode,
    uploadCsv: Boolean(summary?.uploadCsv),
    recordUpsertStrategy: String(summary?.recordUpsertStrategy || summary?.perfMetrics?.recordUpsertStrategy || ''),
    startedAt,
    previewMs: toNumber(summary?.previewMs),
    commitMs: toNumber(summary?.commitMs),
    exportMs: toNumber(summary?.exportMs),
    rollbackMs: toNumber(summary?.rollbackMs),
    processedRows: toNumber(summary?.processedRows),
    failedRows: toNumber(summary?.failedRows),
    elapsedMs: toNumber(summary?.elapsedMs),
    progressPercent: toNumber(summary?.progressPercent),
    throughputRowsPerSec: toNumber(summary?.throughputRowsPerSec),
    chunkItemsSize: toNumber(summary?.chunkConfig?.itemsChunkSize ?? summary?.perfMetrics?.chunkConfig?.itemsChunkSize),
    chunkRecordsSize: toNumber(summary?.chunkConfig?.recordsChunkSize ?? summary?.perfMetrics?.chunkConfig?.recordsChunkSize),
    regressions: Array.isArray(summary?.regressions) ? summary.regressions.map((v) => String(v)) : [],
    sourceType,
    sourcePath,
  }
}

async function parseRecords(root, sourceType) {
  const paths = await collectSummaryFiles(root)
  const records = []
  for (const filePath of paths) {
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') continue
      records.push(recordFromSummary(parsed, filePath, sourceType))
    } catch {
      // Ignore broken files and continue.
    }
  }
  return records
}

function dedupeRecords(records) {
  const seen = new Set()
  const out = []
  for (const row of records) {
    const key = `${row.scenario}|${row.startedAt || 'na'}|${row.previewMs || 'na'}|${row.commitMs || 'na'}|${row.sourcePath}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

function sortByStartedDesc(a, b) {
  const av = a.startedAt ? Date.parse(a.startedAt) : 0
  const bv = b.startedAt ? Date.parse(b.startedAt) : 0
  return bv - av
}

function renderMarkdown(payload) {
  const lines = []
  const has500kPreview = payload.scenarios.some((row) => {
    const scenario = String(row?.scenario || '').toLowerCase()
    return scenario.includes('500k') || Number(row?.rows) >= 500000
  })
  lines.push('# Attendance Import Perf Long-Run Trend')
  lines.push('')
  lines.push(`Generated at (UTC): \`${payload.generatedAt}\``)
  lines.push(`Trend depth: \`${payload.trendDepth}\``)
  lines.push(`Fail on regression: \`${payload.failOnRegression}\``)
  lines.push(`Regression factor: \`${payload.regressionFactor}\``)
  lines.push(`Overall: **${payload.status.toUpperCase()}**`)
  lines.push('')

  lines.push('## Scenario Summary')
  lines.push('')
  lines.push('| Scenario | Rows | Mode | Upload | Upsert | Chunk | Samples | Latest Preview | Latest Commit | Latest Export | Latest Rollback | Latest Progress % | Latest Throughput | P95 Preview | P95 Commit | Status |')
  lines.push('|---|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|')
  for (const row of payload.scenarios) {
    const upload = row?.latest?.uploadCsv ? 'YES' : 'NO'
    const upsert = row?.latest?.recordUpsertStrategy ? String(row.latest.recordUpsertStrategy).toUpperCase() : '--'
    const chunk = formatChunk(row?.latest?.chunkItemsSize, row?.latest?.chunkRecordsSize)
    lines.push(`| ${row.scenario} | ${row.rows ?? '--'} | ${row.mode || '--'} | ${upload} | ${upsert} | ${chunk} | ${row.sampleCount} | ${formatMs(row.latest.previewMs)} | ${formatMs(row.latest.commitMs)} | ${formatMs(row.latest.exportMs)} | ${formatMs(row.latest.rollbackMs)} | ${formatFloat(row.latest.progressPercent)} | ${formatFloat(row.latest.throughputRowsPerSec)} rows/s | ${formatMs(row.p95.previewMs)} | ${formatMs(row.p95.commitMs)} | ${row.status.toUpperCase()} |`)
  }

  lines.push('')
  lines.push('## Trend Detail')
  lines.push('')

  if (payload.warnings.length === 0) {
    lines.push('- No regression warning triggered.')
  } else {
    for (const warning of payload.warnings) {
      lines.push(`- [${warning.severity}] ${warning.scenario}: ${warning.message}`)
    }
  }

  lines.push('')
  lines.push('## Notes')
  lines.push('')
  lines.push('- 10k and 100k scenarios are expected to run `commit` + optional `export` checks.')
  lines.push(`- 50k/100k${has500kPreview ? '/500k' : ''} scenarios are expected to run \`preview\` checks for scale trend.`)
  if (!has500kPreview) {
    lines.push('- 500k preview scenario is currently skipped (`include_rows500k_preview=false`).')
  }
  lines.push('- Use this report with strict gates and daily dashboard for Go/No-Go review.')

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
  const currentRecordsRaw = await parseRecords(currentRoot, 'current')
  const historyRecordsRaw = await parseRecords(historyRoot, 'history')
  const currentRecords = dedupeRecords(currentRecordsRaw).sort(sortByStartedDesc)
  const historyRecords = dedupeRecords(historyRecordsRaw).sort(sortByStartedDesc)

  if (currentRecords.length === 0) {
    die(`no perf summary found under CURRENT_ROOT: ${currentRoot}`)
  }

  const all = dedupeRecords([...currentRecords, ...historyRecords]).sort(sortByStartedDesc)
  const byScenario = new Map()
  for (const row of all) {
    const list = byScenario.get(row.scenario) || []
    list.push(row)
    byScenario.set(row.scenario, list)
  }
  for (const [scenario, rows] of byScenario.entries()) {
    byScenario.set(scenario, rows.sort(sortByStartedDesc))
  }

  const currentLatestByScenario = new Map()
  for (const row of currentRecords) {
    if (!currentLatestByScenario.has(row.scenario)) {
      currentLatestByScenario.set(row.scenario, row)
    }
  }

  const scenarios = Array.from(currentLatestByScenario.keys())
    .sort((a, b) => scenarioSortValue(a) - scenarioSortValue(b) || a.localeCompare(b))

  const scenarioRows = []
  const warnings = []

  for (const scenario of scenarios) {
    const latest = currentLatestByScenario.get(scenario)
    if (!latest) continue
    const samples = (byScenario.get(scenario) || []).slice(0, trendDepth)

    const previewSeries = samples.map((s) => s.previewMs).filter((v) => v !== null)
    const commitSeries = samples.map((s) => s.commitMs).filter((v) => v !== null)

    const p95Preview = percentile(previewSeries, 95)
    const p95Commit = percentile(commitSeries, 95)

    const itemWarnings = []

    if (latest.regressions.length > 0) {
      itemWarnings.push(`threshold regression: ${latest.regressions.join('; ')}`)
    }

    if (latest.previewMs !== null && p95Preview !== null && p95Preview > 0 && latest.previewMs > p95Preview * regressionFactor) {
      const ratio = latest.previewMs / p95Preview
      itemWarnings.push(`preview drift: latest=${Math.round(latest.previewMs)}ms vs p95=${Math.round(p95Preview)}ms (${fmtPct(ratio)})`)
    }

    if (latest.commitMs !== null && p95Commit !== null && p95Commit > 0 && latest.commitMs > p95Commit * regressionFactor) {
      const ratio = latest.commitMs / p95Commit
      itemWarnings.push(`commit drift: latest=${Math.round(latest.commitMs)}ms vs p95=${Math.round(p95Commit)}ms (${fmtPct(ratio)})`)
    }

    const status = itemWarnings.length > 0 ? 'warn' : 'pass'

    if (itemWarnings.length > 0) {
      for (const message of itemWarnings) {
        warnings.push({
          severity: latest.regressions.length > 0 ? 'P1' : 'P2',
          scenario,
          message,
        })
      }
    }

    scenarioRows.push({
      scenario,
      rows: latest.rows,
      mode: latest.mode,
      sampleCount: samples.length,
      latest,
      p95: {
        previewMs: p95Preview,
        commitMs: p95Commit,
      },
      status,
    })
  }

  const status = failOnRegression && warnings.length > 0 ? 'fail' : 'pass'
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const outDir = path.join(outputRoot, nowId())
  await fs.mkdir(outDir, { recursive: true })

  const payload = {
    generatedAt,
    trendDepth,
    failOnRegression,
    regressionFactor,
    status,
    currentCount: currentRecords.length,
    historyCount: historyRecords.length,
    scenarios: scenarioRows,
    warnings,
    input: {
      currentRoot,
      historyRoot,
    },
  }

  const markdown = renderMarkdown(payload)
  const markdownPath = path.join(outDir, 'attendance-import-perf-longrun-trend.md')
  const jsonPath = path.join(outDir, 'attendance-import-perf-longrun-trend.json')
  await fs.writeFile(markdownPath, markdown, 'utf8')
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const outputs = {
    report_status: status,
    report_dir: outDir,
    report_markdown: markdownPath,
    report_json: jsonPath,
  }
  await writeGithubOutput(outputs)

  info(`current summaries=${currentRecords.length} history summaries=${historyRecords.length}`)
  console.log(`REPORT_STATUS=${status}`)
  console.log(`REPORT_DIR=${outDir}`)
  console.log(`REPORT_MARKDOWN=${markdownPath}`)
  console.log(`REPORT_JSON=${jsonPath}`)
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  die(message)
})
