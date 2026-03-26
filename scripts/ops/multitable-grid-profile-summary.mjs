import fs from 'fs/promises'
import path from 'path'

const DEFAULT_REPORT_GLOB_ROOT = path.resolve('output/playwright/multitable-grid-profile-local')
const reportPath = process.env.REPORT_JSON || ''
const outputPath = process.env.SUMMARY_MD || ''
const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY || ''

const thresholds = {
  uiGridOpenMaxMs: Number(process.env.UI_GRID_OPEN_MAX_MS || 350),
  uiGridSearchHitMaxMs: Number(process.env.UI_GRID_SEARCH_HIT_MAX_MS || 300),
  apiGridInitialLoadMaxMs: Number(process.env.API_GRID_INITIAL_LOAD_MAX_MS || 25),
  apiGridSearchHitMaxMs: Number(process.env.API_GRID_SEARCH_HIT_MAX_MS || 25),
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function findLatestReport() {
  if (reportPath) return path.resolve(reportPath)
  const root = DEFAULT_REPORT_GLOB_ROOT
  let dirs = []
  try {
    dirs = await fs.readdir(root, { withFileTypes: true })
  } catch {
    throw new Error(`No profile reports found under ${root}`)
  }
  const candidates = dirs
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, 'report.json'))
  const existing = []
  for (const candidate of candidates) {
    if (await fileExists(candidate)) existing.push(candidate)
  }
  if (!existing.length) {
    throw new Error(`No profile report.json found under ${root}`)
  }
  existing.sort()
  return existing.at(-1)
}

function checkMetric(name, actual, max) {
  const ok = typeof actual === 'number' && Number.isFinite(actual) && actual <= max
  return { name, actual, max, ok }
}

function metricValue(report, name) {
  return report?.metrics?.[name]?.durationMs
}

function formatMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)} ms` : 'n/a'
}

async function main() {
  const resolvedReportPath = await findLatestReport()
  const raw = await fs.readFile(resolvedReportPath, 'utf8')
  const report = JSON.parse(raw)

  const checks = [
    checkMetric('ui.grid.open', metricValue(report, 'ui.grid.open'), thresholds.uiGridOpenMaxMs),
    checkMetric('ui.grid.search-hit', metricValue(report, 'ui.grid.search-hit'), thresholds.uiGridSearchHitMaxMs),
    checkMetric('api.grid.initial-load', metricValue(report, 'api.grid.initial-load'), thresholds.apiGridInitialLoadMaxMs),
    checkMetric('api.grid.search-hit', metricValue(report, 'api.grid.search-hit'), thresholds.apiGridSearchHitMaxMs),
  ]
  const failed = checks.filter((item) => !item.ok)
  const overallOk = Boolean(report?.ok) && failed.length === 0

  const markdown = [
    '# Multitable Grid Profile',
    '',
    `- Overall: **${overallOk ? 'PASS' : 'FAIL'}**`,
    `- Report: \`${resolvedReportPath}\``,
    `- Row count: \`${report?.rowCount ?? 'unknown'}\``,
    `- Base: \`${report?.metadata?.baseId ?? 'unknown'}\``,
    `- Sheet: \`${report?.metadata?.sheetId ?? 'unknown'}\``,
    '',
    '| Metric | Actual | Threshold | Status |',
    '| --- | ---: | ---: | :---: |',
    ...checks.map((item) => `| \`${item.name}\` | ${formatMs(item.actual)} | ${item.max.toFixed(2)} ms | ${item.ok ? 'PASS' : 'FAIL'} |`),
    '',
  ]

  if (failed.length) {
    markdown.push('## Failed Thresholds', '')
    for (const item of failed) {
      markdown.push(`- \`${item.name}\` = ${formatMs(item.actual)} exceeds ${item.max.toFixed(2)} ms`)
    }
    markdown.push('')
  }

  if (report?.metadata) {
    markdown.push('## Metadata', '')
    markdown.push('```json')
    markdown.push(JSON.stringify(report.metadata, null, 2))
    markdown.push('```')
    markdown.push('')
  }

  const summary = `${markdown.join('\n')}\n`
  const resolvedOutputPath = outputPath || path.join(path.dirname(resolvedReportPath), 'summary.md')
  let wroteSummaryFile = false
  try {
    await fs.writeFile(resolvedOutputPath, summary, 'utf8')
    wroteSummaryFile = true
  } catch (error) {
    process.stderr.write(`[multitable-grid-profile-summary] WARN: failed to write summary file: ${error.message}\n`)
  }
  if (stepSummaryPath) {
    try {
      await fs.appendFile(stepSummaryPath, `${summary}\n`, 'utf8')
    } catch (error) {
      process.stderr.write(`[multitable-grid-profile-summary] WARN: failed to append GitHub step summary: ${error.message}\n`)
    }
  }

  process.stdout.write(`[multitable-grid-profile-summary] report=${resolvedReportPath}\n`)
  if (wroteSummaryFile) process.stdout.write(`[multitable-grid-profile-summary] summary=${resolvedOutputPath}\n`)
  else process.stdout.write(`${summary}\n`)
  if (!overallOk) {
    process.stderr.write('[multitable-grid-profile-summary] ERROR: threshold check failed\n')
    process.exit(1)
  }
}

main().catch((error) => {
  process.stderr.write(`[multitable-grid-profile-summary] ERROR: ${error.message}\n`)
  process.exit(1)
})
