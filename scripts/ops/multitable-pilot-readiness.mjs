import fs from 'fs/promises'
import path from 'path'

const smokeReportPath = process.env.SMOKE_REPORT_JSON || ''
const profileReportPath = process.env.PROFILE_REPORT_JSON || ''
const profileSummaryPath = process.env.PROFILE_SUMMARY_MD || ''
const readinessMdPath = process.env.READINESS_MD || ''
const readinessJsonPath = process.env.READINESS_JSON || ''
const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY || ''

async function readJson(filePath, label) {
  if (!filePath) {
    throw new Error(`${label} path is required`)
  }
  const raw = await fs.readFile(path.resolve(filePath), 'utf8')
  return JSON.parse(raw)
}

async function readOptionalText(filePath) {
  if (!filePath) return null
  try {
    return await fs.readFile(path.resolve(filePath), 'utf8')
  } catch {
    return null
  }
}

function fmtMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)} ms` : 'n/a'
}

function summarizeSmoke(report) {
  const requiredChecks = [
    'ui.grid.import',
    'ui.person.assign',
    'ui.form.upload-comments',
    'ui.grid.search-hydration',
    'ui.conflict.retry',
  ]
  const missing = requiredChecks.filter((name) => !report.checks?.some((item) => item.name === name && item.ok))
  return {
    ok: Boolean(report.ok) && missing.length === 0,
    requiredChecks,
    missingChecks: missing,
  }
}

function summarizeProfile(report) {
  return {
    ok: Boolean(report.ok),
    rowCount: report.rowCount ?? null,
    uiGridOpenMs: report.metrics?.['ui.grid.open']?.durationMs ?? null,
    uiGridSearchHitMs: report.metrics?.['ui.grid.search-hit']?.durationMs ?? null,
    apiGridInitialLoadMs: report.metrics?.['api.grid.initial-load']?.durationMs ?? null,
    apiGridSearchHitMs: report.metrics?.['api.grid.search-hit']?.durationMs ?? null,
  }
}

async function main() {
  const smoke = await readJson(smokeReportPath, 'SMOKE_REPORT_JSON')
  const profile = await readJson(profileReportPath, 'PROFILE_REPORT_JSON')
  const profileSummary = await readOptionalText(profileSummaryPath)

  const smokeSummary = summarizeSmoke(smoke)
  const profileSummaryData = summarizeProfile(profile)
  const overallOk = smokeSummary.ok && profileSummaryData.ok

  const payload = {
    ok: overallOk,
    smoke: {
      report: path.resolve(smokeReportPath),
      ...smokeSummary,
    },
    profile: {
      report: path.resolve(profileReportPath),
      summary: profileSummaryPath ? path.resolve(profileSummaryPath) : null,
      ...profileSummaryData,
    },
    generatedAt: new Date().toISOString(),
  }

  const lines = [
    '# Multitable Pilot Readiness',
    '',
    `- Overall: **${overallOk ? 'PASS' : 'FAIL'}**`,
    `- Smoke report: \`${path.resolve(smokeReportPath)}\``,
    `- Profile report: \`${path.resolve(profileReportPath)}\``,
    '',
    '## Smoke Gates',
    '',
    `- Status: **${smokeSummary.ok ? 'PASS' : 'FAIL'}**`,
    `- Required checks: ${smokeSummary.requiredChecks.map((item) => `\`${item}\``).join(', ')}`,
    smokeSummary.missingChecks.length
      ? `- Missing checks: ${smokeSummary.missingChecks.map((item) => `\`${item}\``).join(', ')}`
      : '- Missing checks: none',
    '',
    '## Grid Profile',
    '',
    `- Status: **${profileSummaryData.ok ? 'PASS' : 'FAIL'}**`,
    `- Row count: \`${profileSummaryData.rowCount ?? 'unknown'}\``,
    `- ui.grid.open: ${fmtMs(profileSummaryData.uiGridOpenMs)}`,
    `- ui.grid.search-hit: ${fmtMs(profileSummaryData.uiGridSearchHitMs)}`,
    `- api.grid.initial-load: ${fmtMs(profileSummaryData.apiGridInitialLoadMs)}`,
    `- api.grid.search-hit: ${fmtMs(profileSummaryData.apiGridSearchHitMs)}`,
    '',
    '## Local Notes',
    '',
    '- Local dev-token pilot runs still require `RBAC_TOKEN_TRUST=true` on backend unless you use a real admin token.',
    '- Default local endpoints remain `http://127.0.0.1:7778` (backend) and `http://127.0.0.1:8899` (frontend).',
    '',
  ]

  if (profileSummary) {
    lines.push('## Profile Threshold Summary', '', profileSummary.trim(), '')
  }

  const markdown = `${lines.join('\n')}\n`
  const resolvedReadinessMdPath = readinessMdPath
    ? path.resolve(readinessMdPath)
    : path.join(path.dirname(path.resolve(profileReportPath)), 'readiness.md')
  const resolvedReadinessJsonPath = readinessJsonPath
    ? path.resolve(readinessJsonPath)
    : path.join(path.dirname(path.resolve(profileReportPath)), 'readiness.json')

  await fs.writeFile(resolvedReadinessMdPath, markdown, 'utf8')
  await fs.writeFile(resolvedReadinessJsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  if (stepSummaryPath) {
    await fs.appendFile(stepSummaryPath, `${markdown}\n`, 'utf8')
  }

  process.stdout.write(`[multitable-pilot-readiness] readiness_md=${resolvedReadinessMdPath}\n`)
  process.stdout.write(`[multitable-pilot-readiness] readiness_json=${resolvedReadinessJsonPath}\n`)
  if (!overallOk) process.exit(1)
}

main().catch((error) => {
  process.stderr.write(`[multitable-pilot-readiness] ERROR: ${error.message}\n`)
  process.exit(1)
})
