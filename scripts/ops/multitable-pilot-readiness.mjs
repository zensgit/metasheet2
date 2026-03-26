import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')

const smokeReportPath = process.env.SMOKE_REPORT_JSON || ''
const profileReportPath = process.env.PROFILE_REPORT_JSON || ''
const profileSummaryPath = process.env.PROFILE_SUMMARY_MD || ''
const gateReportPath = process.env.GATE_REPORT_JSON || ''
const requireGateReport = process.env.REQUIRE_GATE_REPORT !== 'false'
const onPremGateReportPath = process.env.ONPREM_GATE_REPORT_JSON || ''
const requireOnPremGate = process.env.REQUIRE_ONPREM_GATE === 'true'
const requireExplicitOnPremGate = process.env.REQUIRE_EXPLICIT_ONPREM_GATE === 'true'
const readinessMdPath = process.env.READINESS_MD || ''
const readinessJsonPath = process.env.READINESS_JSON || ''
const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY || ''
const onPremGateRoot = path.join(repoRoot, 'output/releases/multitable-onprem/gates')

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

async function readOptionalJson(filePath) {
  const text = await readOptionalText(filePath)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function resolveOnPremGateReportPath() {
  if (requireExplicitOnPremGate && !onPremGateReportPath) {
    throw new Error('REQUIRE_EXPLICIT_ONPREM_GATE=true requires ONPREM_GATE_REPORT_JSON')
  }
  if (onPremGateReportPath) return path.resolve(onPremGateReportPath)
  try {
    const entries = await fs.readdir(onPremGateRoot, { withFileTypes: true })
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    const latest = dirs.at(-1)
    if (!latest) return null
    const reportPath = path.join(onPremGateRoot, latest, 'report.json')
    await fs.access(reportPath)
    return reportPath
  } catch {
    return null
  }
}

function fmtMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)} ms` : 'n/a'
}

function summarizeSmoke(report) {
  const requiredChecks = [
    'ui.route.grid-entry',
    'ui.route.form-entry',
    'ui.import.failed-retry',
    'ui.import.mapping-reconcile',
    'ui.import.people-repair-reconcile',
    'ui.import.people-manual-fix',
    'api.import.people-manual-fix-hydration',
    'ui.person.assign',
    'ui.form.upload-comments',
    'api.form.attachment-delete-clear',
    'ui.grid.search-hydration',
    'ui.conflict.retry',
    'ui.field-manager.prop-reconcile',
    'ui.field-manager.type-reconcile',
    'ui.field-manager.target-removal',
    'ui.view-manager.prop-reconcile',
    'ui.view-manager.field-schema-reconcile',
    'ui.view-manager.target-removal',
    'ui.gallery.config-replay',
    'ui.calendar.config-replay',
    'ui.timeline.config-replay',
    'ui.kanban.config-replay',
    'ui.kanban.empty-card-fields-replay',
    'ui.kanban.clear-group-replay',
    'api.multitable.view-submit',
  ]
  const missing = requiredChecks.filter((name) => !report.checks?.some((item) => item.name === name && item.ok))
  return {
    ok: Boolean(report.ok) && missing.length === 0,
    requiredChecks,
    missingChecks: missing,
  }
}

function summarizeEmbedHostProtocol(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const protocolChecks = [
    'ui.embed-host.ready',
    'ui.embed-host.state-query.initial',
    'ui.embed-host.navigate.generated-request-id',
    'ui.embed-host.navigate.applied',
    'ui.embed-host.navigate.explicit-request-id',
    'ui.embed-host.state-query.final',
  ]
  const availableChecks = protocolChecks.filter((name) => checks.some((item) => item.name === name))
  const available = availableChecks.length > 0
  const missingChecks = available
    ? protocolChecks.filter((name) => !checks.some((item) => item.name === name && item.ok))
    : []
  return {
    available,
    ok: !available || missingChecks.length === 0,
    requiredWhenPresent: protocolChecks,
    observedChecks: availableChecks,
    missingChecks,
  }
}

function summarizeEmbedHostNavigationProtection(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const protectionChecks = [
    'ui.embed-host.form-ready',
    'ui.embed-host.form-draft',
    'ui.embed-host.navigate.blocked-dialog',
    'ui.embed-host.navigate.blocked',
    'ui.embed-host.navigate.confirm-dialog',
    'ui.embed-host.navigate.confirmed',
    'api.embed-host.discard-unsaved-form-draft',
  ]
  const availableChecks = protectionChecks.filter((name) => checks.some((item) => item.name === name))
  const available = availableChecks.length > 0
  const missingChecks = available
    ? protectionChecks.filter((name) => !checks.some((item) => item.name === name && item.ok))
    : []
  return {
    available,
    ok: !available || missingChecks.length === 0,
    requiredWhenPresent: protectionChecks,
    observedChecks: availableChecks,
    missingChecks,
  }
}

function summarizeImportDraftRecovery(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const uiCheck = checks.find((item) => item.name === 'ui.import.mapping-reconcile')
  return {
    ok: Boolean(uiCheck?.ok),
    uiCheck: uiCheck ?? null,
  }
}

function summarizePeopleRepairReconcile(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const uiCheck = checks.find((item) => item.name === 'ui.import.people-repair-reconcile')
  return {
    ok: Boolean(uiCheck?.ok),
    uiCheck: uiCheck ?? null,
  }
}

function summarizePeopleImportRecovery(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const uiCheck = checks.find((item) => item.name === 'ui.import.people-manual-fix')
  const apiCheck = checks.find((item) => item.name === 'api.import.people-manual-fix-hydration')
  return {
    ok: Boolean(uiCheck?.ok) && Boolean(apiCheck?.ok),
    uiCheck: uiCheck ?? null,
    apiCheck: apiCheck ?? null,
  }
}

function summarizeManagerRecovery(report) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const fieldCheck = checks.find((item) => item.name === 'ui.field-manager.prop-reconcile')
  const fieldTypeCheck = checks.find((item) => item.name === 'ui.field-manager.type-reconcile')
  const fieldRemovalCheck = checks.find((item) => item.name === 'ui.field-manager.target-removal')
  const viewCheck = checks.find((item) => item.name === 'ui.view-manager.prop-reconcile')
  const viewFieldSchemaCheck = checks.find((item) => item.name === 'ui.view-manager.field-schema-reconcile')
  const viewRemovalCheck = checks.find((item) => item.name === 'ui.view-manager.target-removal')
  return {
    ok: Boolean(fieldCheck?.ok) &&
      Boolean(fieldTypeCheck?.ok) &&
      Boolean(fieldRemovalCheck?.ok) &&
      Boolean(viewCheck?.ok) &&
      Boolean(viewFieldSchemaCheck?.ok) &&
      Boolean(viewRemovalCheck?.ok),
    fieldCheck: fieldCheck ?? null,
    fieldTypeCheck: fieldTypeCheck ?? null,
    fieldRemovalCheck: fieldRemovalCheck ?? null,
    viewCheck: viewCheck ?? null,
    viewFieldSchemaCheck: viewFieldSchemaCheck ?? null,
    viewRemovalCheck: viewRemovalCheck ?? null,
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

function summarizeGates(report, reportPath, required) {
  if (!report) {
    return {
      ok: !required,
      required,
      report: reportPath ? path.resolve(reportPath) : null,
      checks: [],
      missingChecks: [],
      failedStep: null,
      missingReport: true,
    }
  }
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const missing = checks.filter((check) => !check.ok).map((check) => check.name)
  return {
    ok: Boolean(report?.ok) && missing.length === 0,
    required,
    report: reportPath ? path.resolve(reportPath) : null,
    checks,
    missingChecks: missing,
    failedStep: report?.failedStep ?? null,
    missingReport: false,
  }
}

function summarizeOnPremReleaseGate(report, reportPath) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const missing = checks.filter((check) => !check.ok).map((check) => check.name)
  return {
    ok: Boolean(report?.ok) && missing.length === 0,
    report: reportPath ? path.resolve(reportPath) : null,
    packageName: report?.packageName ?? null,
    checks,
    missingChecks: missing,
    signoffRecoveryPath: report?.signoffRecoveryPath ?? null,
  }
}

async function main() {
  const smoke = await readJson(smokeReportPath, 'SMOKE_REPORT_JSON')
  const profile = await readJson(profileReportPath, 'PROFILE_REPORT_JSON')
  const profileSummary = await readOptionalText(profileSummaryPath)
  const gateReport = gateReportPath ? await readOptionalJson(gateReportPath) : null
  const resolvedOnPremGateReportPath = await resolveOnPremGateReportPath()
  const onPremGateReport = resolvedOnPremGateReportPath
    ? await readJson(resolvedOnPremGateReportPath, 'ONPREM_GATE_REPORT_JSON')
    : null

  const smokeSummary = summarizeSmoke(smoke)
  const importDraftRecovery = summarizeImportDraftRecovery(smoke)
  const peopleRepairReconcile = summarizePeopleRepairReconcile(smoke)
  const peopleImportRecovery = summarizePeopleImportRecovery(smoke)
  const managerRecovery = summarizeManagerRecovery(smoke)
  const embedHostProtocol = summarizeEmbedHostProtocol(smoke)
  const embedHostNavigationProtection = summarizeEmbedHostNavigationProtection(smoke)
  const profileSummaryData = summarizeProfile(profile)
  const gateSummary = summarizeGates(gateReport, gateReportPath, requireGateReport)
  const onPremGateSummary = onPremGateReport
    ? summarizeOnPremReleaseGate(onPremGateReport, resolvedOnPremGateReportPath)
    : null
  if (requireOnPremGate && !onPremGateSummary) {
    throw new Error('REQUIRE_ONPREM_GATE=true but no on-prem release gate report was found')
  }
  const overallOk = smokeSummary.ok &&
    embedHostProtocol.ok &&
    embedHostNavigationProtection.ok &&
    profileSummaryData.ok &&
    gateSummary.ok &&
    (!requireOnPremGate || Boolean(onPremGateSummary?.ok))
  const signoffRecoveryPath = onPremGateSummary?.signoffRecoveryPath ?? null

  const payload = {
    ok: overallOk,
    smoke: {
      report: path.resolve(smokeReportPath),
      ...smokeSummary,
    },
    importDraftRecovery: {
      ...importDraftRecovery,
      flow: [
        'Import records',
        'Preview the pasted rows and confirm header auto-mapping',
        'Rename the mapped field in the background and confirm the preview label updates without a warning',
        'Change the same field to a non-importable type and confirm importing is blocked',
        'Click Reconcile draft and confirm the stale mapping is cleared',
      ],
    },
    peopleRepairReconcile: {
      ...peopleRepairReconcile,
      flow: [
        'Import records into a people field and enter the manual-fix result panel',
        'Pick a person from the picker',
        'Change the same field to a non-people type in the background',
        'Confirm Apply fixes is blocked until Reconcile draft is clicked',
        'Retry after reconcile and confirm the row still imports successfully',
      ],
    },
    peopleImportRecovery: {
      ...peopleImportRecovery,
      flow: [
        'Import records',
        'If people mismatch appears, use Select person/Select people in the result panel',
        'Search and confirm the person in the picker',
        'Apply fixes and retry',
        'Search the imported row again in grid',
        'Confirm API hydration check passes',
      ],
    },
    managerRecovery: {
      ...managerRecovery,
      flow: [
        'Open Fields or Views manager',
        'Dirty an existing config draft',
        'Apply an upstream field/view patch while the manager stays open',
        'Wait for the background-change warning banner',
        'Dismiss the close confirmation once to verify the draft is protected',
        'Click Reload latest and confirm the UI now reflects the server state',
        'Rename a dependent field and verify labels reconcile without losing the current manager session',
        'Change a dependent field type and verify saving is blocked until Reload latest',
        'Open a temporary field/view config and delete that target from the backend',
        'Confirm the config panel closes itself and no stale warning remains',
      ],
    },
    embedHostProtocol,
    embedHostNavigationProtection,
    profile: {
      report: path.resolve(profileReportPath),
      summary: profileSummaryPath ? path.resolve(profileSummaryPath) : null,
      ...profileSummaryData,
    },
    gates: gateSummary,
    onPremReleaseGate: onPremGateSummary,
    onPremReleaseGateBinding: {
      required: requireOnPremGate,
      explicitRequired: requireExplicitOnPremGate,
      explicitReport: onPremGateReportPath ? path.resolve(onPremGateReportPath) : null,
      resolvedReport: resolvedOnPremGateReportPath ? path.resolve(resolvedOnPremGateReportPath) : null,
    },
    signoffRecoveryPath,
    generatedAt: new Date().toISOString(),
  }

  const lines = [
    '# Multitable Pilot Readiness',
    '',
    `- Overall: **${overallOk ? 'PASS' : 'FAIL'}**`,
    `- Smoke report: \`${path.resolve(smokeReportPath)}\``,
    `- Profile report: \`${path.resolve(profileReportPath)}\``,
    '',
  ]

  if (signoffRecoveryPath) {
    lines.push(
      '## Sign-Off Recovery Path',
      '',
      `- Step 1 command: \`${signoffRecoveryPath.step1RunPreflight ?? 'missing'}\``,
      `- Repair instruction: ${signoffRecoveryPath.step2RepairInstruction ?? 'missing'}`,
      `- Repair helper path: \`${signoffRecoveryPath.step2RepairHelper ?? 'missing'}\``,
      Array.isArray(signoffRecoveryPath.step3ReturnEvidence) && signoffRecoveryPath.step3ReturnEvidence.length
        ? `- Return both files: ${signoffRecoveryPath.step3ReturnEvidence.map((item) => `\`${item}\``).join(', ')}`
        : '- Return both files: missing',
      '',
    )
  }

  lines.push(
    '## Smoke Gates',
    '',
    `- Status: **${smokeSummary.ok ? 'PASS' : 'FAIL'}**`,
    `- Required checks: ${smokeSummary.requiredChecks.map((item) => `\`${item}\``).join(', ')}`,
    smokeSummary.missingChecks.length
      ? `- Missing checks: ${smokeSummary.missingChecks.map((item) => `\`${item}\``).join(', ')}`
      : '- Missing checks: none',
    '',
    '## Import Draft Reconcile Chain',
    '',
    `- Status: **${importDraftRecovery.ok ? 'PASS' : 'FAIL'}**`,
    `- UI check: ${importDraftRecovery.uiCheck?.ok ? '`ui.import.mapping-reconcile`' : '`missing`'}`,
    '- Flow:',
    '- Import records',
    '- Preview the pasted rows and confirm header auto-mapping',
    '- Rename the mapped field in the background and confirm the preview label updates without a warning',
    '- Change the same field to a non-importable type and confirm importing is blocked',
    '- Click `Reconcile draft` and confirm the stale mapping is cleared',
    '',
    '## People Repair Reconcile Chain',
    '',
    `- Status: **${peopleRepairReconcile.ok ? 'PASS' : 'FAIL'}**`,
    `- UI check: ${peopleRepairReconcile.uiCheck?.ok ? '`ui.import.people-repair-reconcile`' : '`missing`'}`,
    '- Flow:',
    '- Import records into a people field and enter the manual-fix result panel',
    '- Pick a person from the picker',
    '- Change the same field to a non-people type in the background',
    '- Confirm `Apply fixes and retry` is blocked until `Reconcile draft` is clicked',
    '- Retry after reconcile and confirm the row still imports successfully',
    '',
    '## People Import Recovery Chain',
    '',
    `- Status: **${peopleImportRecovery.ok ? 'PASS' : 'FAIL'}**`,
    `- UI check: ${peopleImportRecovery.uiCheck?.ok ? '`ui.import.people-manual-fix`' : '`missing`'}`,
    `- API check: ${peopleImportRecovery.apiCheck?.ok ? '`api.import.people-manual-fix-hydration`' : '`missing`'}`,
    '- Flow:',
    '- Import records',
    '- If people mismatch appears, use `Select person` or `Select people` in the result panel',
    '- Search and confirm the person in the picker',
    '- Click `Apply fixes and retry`',
    '- Search the imported row again in grid',
    '- Confirm API hydration passes for the imported record',
    '',
    '## Manager Recovery Chain',
    '',
    `- Status: **${managerRecovery.ok ? 'PASS' : 'FAIL'}**`,
    `- Field manager check: ${managerRecovery.fieldCheck?.ok ? '`ui.field-manager.prop-reconcile`' : '`missing`'}`,
    `- Field manager type reconcile: ${managerRecovery.fieldTypeCheck?.ok ? '`ui.field-manager.type-reconcile`' : '`missing`'}`,
    `- Field manager removal check: ${managerRecovery.fieldRemovalCheck?.ok ? '`ui.field-manager.target-removal`' : '`missing`'}`,
    `- View manager check: ${managerRecovery.viewCheck?.ok ? '`ui.view-manager.prop-reconcile`' : '`missing`'}`,
    `- View manager field schema reconcile: ${managerRecovery.viewFieldSchemaCheck?.ok ? '`ui.view-manager.field-schema-reconcile`' : '`missing`'}`,
    `- View manager removal check: ${managerRecovery.viewRemovalCheck?.ok ? '`ui.view-manager.target-removal`' : '`missing`'}`,
    '- Flow:',
    '- Open `Fields` or `Views` manager',
    '- Dirty an existing config draft',
    '- Apply an upstream field/view patch while the manager stays open',
    '- Wait for the background-change warning banner',
    '- Dismiss the close confirmation once to verify the draft is protected',
    '- Click `Reload latest` and confirm the UI reflects the server state',
    '- Rename a dependent field and verify labels reconcile without closing the manager',
    '- Change a dependent field type and verify save is blocked until `Reload latest`',
    '- Open a temporary field/view config and delete that target from the backend',
    '- Confirm the config panel closes itself and no stale warning remains',
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
    '## Embed Host Protocol Evidence',
    '',
    `- Available in smoke: \`${embedHostProtocol.available ? 'true' : 'false'}\``,
    `- Status: **${embedHostProtocol.ok ? 'PASS' : 'FAIL'}**`,
    `- Required when present: ${embedHostProtocol.requiredWhenPresent.map((item) => `\`${item}\``).join(', ')}`,
    embedHostProtocol.observedChecks.length
      ? `- Observed checks: ${embedHostProtocol.observedChecks.map((item) => `\`${item}\``).join(', ')}`
      : '- Observed checks: none',
    embedHostProtocol.missingChecks.length
      ? `- Missing checks: ${embedHostProtocol.missingChecks.map((item) => `\`${item}\``).join(', ')}`
      : '- Missing checks: none',
    '',
    '## Embed Host Navigation Protection',
    '',
    `- Available in smoke: \`${embedHostNavigationProtection.available ? 'true' : 'false'}\``,
    `- Status: **${embedHostNavigationProtection.ok ? 'PASS' : 'FAIL'}**`,
    `- Required when present: ${embedHostNavigationProtection.requiredWhenPresent.map((item) => `\`${item}\``).join(', ')}`,
    embedHostNavigationProtection.observedChecks.length
      ? `- Observed checks: ${embedHostNavigationProtection.observedChecks.map((item) => `\`${item}\``).join(', ')}`
      : '- Observed checks: none',
    embedHostNavigationProtection.missingChecks.length
      ? `- Missing checks: ${embedHostNavigationProtection.missingChecks.map((item) => `\`${item}\``).join(', ')}`
      : '- Missing checks: none',
    '',
    '## Local Notes',
    '',
    '- Local dev-token pilot runs still require `RBAC_TOKEN_TRUST=true` on backend unless you use a real admin token.',
    '- Default local endpoints remain `http://127.0.0.1:7778` (backend) and `http://127.0.0.1:8899` (frontend).',
    '',
  )

  lines.push(
    '## Build & Test Gates',
    '',
    `- Status: **${gateSummary.ok ? 'PASS' : 'FAIL'}**`,
    `- Required binding: \`${requireGateReport ? 'true' : 'false'}\``,
    `- Report: \`${gateSummary.report ?? 'missing'}\``,
    `- Missing report: \`${gateSummary.missingReport ? 'true' : 'false'}\``,
    gateSummary.failedStep
      ? `- Failed step: \`${gateSummary.failedStep}\``
      : '- Failed step: none',
    gateSummary.checks.length
      ? `- Checks: ${gateSummary.checks.map((item) => `\`${item.name}\``).join(', ')}`
      : '- Checks: none',
    gateSummary.missingChecks.length
      ? `- Failing checks: ${gateSummary.missingChecks.map((item) => `\`${item}\``).join(', ')}`
      : '- Failing checks: none',
    '',
  )

  if (onPremGateSummary) {
    lines.push(
      '## On-Prem Release Gate',
      '',
      `- Status: **${onPremGateSummary.ok ? 'PASS' : 'FAIL'}**`,
      `- Required binding: \`${requireOnPremGate ? 'true' : 'false'}\``,
      `- Explicit report required: \`${requireExplicitOnPremGate ? 'true' : 'false'}\``,
      `- Report: \`${onPremGateSummary.report}\``,
      `- Package name: \`${onPremGateSummary.packageName ?? 'unknown'}\``,
      onPremGateSummary.checks.length
        ? `- Checks: ${onPremGateSummary.checks.map((item) => `\`${item.name}\``).join(', ')}`
        : '- Checks: none',
      onPremGateSummary.missingChecks.length
        ? `- Failing checks: ${onPremGateSummary.missingChecks.map((item) => `\`${item}\``).join(', ')}`
        : '- Failing checks: none',
      '',
    )
  } else if (requireOnPremGate) {
    lines.push(
      '## On-Prem Release Gate',
      '',
      '- Status: **FAIL**',
      `- Required binding: \`${requireOnPremGate ? 'true' : 'false'}\``,
      `- Explicit report required: \`${requireExplicitOnPremGate ? 'true' : 'false'}\``,
      '- Report: `missing`',
      '',
    )
  }

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

  let wroteMarkdown = false
  let wroteJson = false
  try {
    await fs.writeFile(resolvedReadinessMdPath, markdown, 'utf8')
    wroteMarkdown = true
  } catch (error) {
    process.stderr.write(`[multitable-pilot-readiness] WARN: failed to write readiness markdown: ${error.message}\n`)
  }
  try {
    await fs.writeFile(resolvedReadinessJsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    wroteJson = true
  } catch (error) {
    process.stderr.write(`[multitable-pilot-readiness] WARN: failed to write readiness json: ${error.message}\n`)
  }
  if (stepSummaryPath) {
    try {
      await fs.appendFile(stepSummaryPath, `${markdown}\n`, 'utf8')
    } catch (error) {
      process.stderr.write(`[multitable-pilot-readiness] WARN: failed to append GitHub step summary: ${error.message}\n`)
    }
  }

  if (wroteMarkdown) process.stdout.write(`[multitable-pilot-readiness] readiness_md=${resolvedReadinessMdPath}\n`)
  if (wroteJson) process.stdout.write(`[multitable-pilot-readiness] readiness_json=${resolvedReadinessJsonPath}\n`)
  if (!wroteMarkdown) process.stdout.write(`${markdown}\n`)
  if (!wroteJson) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  if (!overallOk) process.exit(1)
}

main().catch((error) => {
  process.stderr.write(`[multitable-pilot-readiness] ERROR: ${error.message}\n`)
  process.exit(1)
})
