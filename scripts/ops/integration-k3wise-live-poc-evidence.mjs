#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SECRET_KEY_PATTERN = /password|secret|token|session|credential|api[-_]?key|authorization/i
const SAFE_SECRET_PLACEHOLDERS = new Set(['', '<redacted>', '<set-at-runtime>', 'redacted', '***'])
const VALID_STATUSES = new Set(['pass', 'partial', 'fail', 'skipped', 'todo', 'blocked'])
// Customer evidence often spells phase status with localized or English
// synonyms (e.g. "passed", "成功", "完成", "failed", "失败", "进行中").
// Without a synonym map, anything not in VALID_STATUSES silently defaults
// to 'todo' — flipping a completed phase into a false PARTIAL decision.
const STATUS_SYNONYMS = new Map([
  ['passed', 'pass'], ['passing', 'pass'], ['complete', 'pass'], ['completed', 'pass'],
  ['done', 'pass'], ['ok', 'pass'], ['success', 'pass'], ['successful', 'pass'], ['succeeded', 'pass'],
  ['通过', 'pass'], ['成功', 'pass'], ['完成', 'pass'], ['已完成', 'pass'], ['已通过', 'pass'], ['完毕', 'pass'],
  ['failed', 'fail'], ['fails', 'fail'], ['error', 'fail'], ['errored', 'fail'], ['failure', 'fail'],
  ['失败', 'fail'], ['失败了', 'fail'], ['错误', 'fail'], ['出错', 'fail'],
  ['partially', 'partial'], ['in-progress', 'partial'], ['in progress', 'partial'], ['inprogress', 'partial'],
  ['ongoing', 'partial'], ['working', 'partial'],
  ['进行中', 'partial'], ['部分通过', 'partial'], ['部分', 'partial'],
  ['skip', 'skipped'], ['n/a', 'skipped'], ['na', 'skipped'], ['not applicable', 'skipped'],
  ['跳过', 'skipped'], ['不适用', 'skipped'],
  ['stuck', 'blocked'], ['waiting', 'blocked'], ['hold', 'blocked'], ['on hold', 'blocked'], ['on-hold', 'blocked'],
  ['阻塞', 'blocked'], ['卡住', 'blocked'], ['等待中', 'blocked'],
  ['pending', 'todo'], ['queued', 'todo'], ['planned', 'todo'], ['not started', 'todo'], ['not-started', 'todo'],
  ['待办', 'todo'], ['待做', 'todo'], ['未开始', 'todo'], ['未做', 'todo'],
])
// Customer-supplied evidence often carries spreadsheet-export style booleans
// (string "true" / "yes" / "是", or number 0 / 1). Strict `=== true` checks
// silently let those slip past — same bug class as preflight #1168 / #1169.
// Mirror that helper here (intentionally local; keeping evidence.mjs free
// of cross-file imports for the customer-runnable script surface).
const TRUE_BOOLEAN_TEXT = new Set(['true', '1', 'yes', 'y', 'on', '是', '启用', '开启'])
const FALSE_BOOLEAN_TEXT = new Set(['false', '0', 'no', 'n', 'off', '否', '禁用', '关闭'])

class LivePocEvidenceError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'LivePocEvidenceError'
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeSafeBoolean(value, field) {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new LivePocEvidenceError(`${field} must be a finite boolean, 0/1, or boolean-like string`, { field })
    }
    if (value === 1) return true
    if (value === 0) return false
    throw new LivePocEvidenceError(`${field} must be 0 or 1 when given as a number`, { field, received: value })
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized.length === 0) return false
    if (TRUE_BOOLEAN_TEXT.has(normalized)) return true
    if (FALSE_BOOLEAN_TEXT.has(normalized)) return false
  }
  throw new LivePocEvidenceError(`${field} must be a boolean, 0/1, or boolean-like string`, { field })
}

function asObject(value, field) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new LivePocEvidenceError(`${field} must be an object`, { field })
  }
  return value
}

function asArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new LivePocEvidenceError(`${field} must be an array`, { field })
  }
  return value
}

// Customer evidence often serializes IDs (productId, runId) as numbers when
// exported from spreadsheets that auto-coerce numeric strings. Accept finite
// numbers and bigints as identifier text; arrays/objects/booleans/NaN/Infinity
// still produce '' so downstream "missing required field" checks remain
// authoritative.
function text(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'bigint') return String(value)
  return ''
}

function normalizeStatus(value) {
  const status = text(value).toLowerCase()
  if (VALID_STATUSES.has(status)) return status
  if (STATUS_SYNONYMS.has(status)) return STATUS_SYNONYMS.get(status)
  return 'todo'
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (!isPlainObject(value)) return value
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    result[key] = SECRET_KEY_PATTERN.test(key) ? '<redacted>' : redact(child)
  }
  return result
}

function findSecretLeaks(value, location = 'root', leaks = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSecretLeaks(item, `${location}[${index}]`, leaks))
    return leaks
  }
  if (!isPlainObject(value)) return leaks
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${location}.${key}`
    if (SECRET_KEY_PATTERN.test(key) && typeof child === 'string') {
      const normalized = child.trim()
      if (normalized.length >= 4 && !SAFE_SECRET_PLACEHOLDERS.has(normalized.toLowerCase())) {
        leaks.push(childPath)
      }
      continue
    }
    findSecretLeaks(child, childPath, leaks)
  }
  return leaks
}

function hasBomPipeline(packet) {
  return asArray(packet.pipelines, 'packet.pipelines').some((pipeline) => {
    return text(pipeline.sourceObject).toLowerCase() === 'bom' || text(pipeline.targetObject).toLowerCase() === 'bom'
  })
}

function hasSqlChannel(packet) {
  return asArray(packet.externalSystems, 'packet.externalSystems').some((system) => {
    return text(system.kind).toLowerCase() === 'erp:k3-wise-sqlserver'
  })
}

// During incident response a customer/operator might hand-edit the packet JSON
// to retry an evidence run. Coerce safety fields through normalizeSafeBoolean
// so a hand-typed `"true"` / `"false"` / `0` / `1` is interpreted the same way
// the preflight script would have written it. The safety contract is unchanged:
// saveOnly must be truthy, autoSubmit / autoAudit must be falsy, and
// productionWriteBlocked must be truthy — coercion only widens the input
// surface, it does not weaken the gate.
function requirePacketSafety(packet) {
  const safety = asObject(packet.safety, 'packet.safety')
  const saveOnly = normalizeSafeBoolean(safety.saveOnly, 'packet.safety.saveOnly')
  const autoSubmit = normalizeSafeBoolean(safety.autoSubmit, 'packet.safety.autoSubmit')
  const autoAudit = normalizeSafeBoolean(safety.autoAudit, 'packet.safety.autoAudit')
  if (!saveOnly || autoSubmit || autoAudit) {
    throw new LivePocEvidenceError('preflight packet must be Save-only with autoSubmit=false and autoAudit=false', {
      field: 'packet.safety',
    })
  }
  const productionWriteBlocked = normalizeSafeBoolean(safety.productionWriteBlocked, 'packet.safety.productionWriteBlocked')
  if (!productionWriteBlocked) {
    throw new LivePocEvidenceError('preflight packet must explicitly block production writes', {
      field: 'packet.safety.productionWriteBlocked',
    })
  }
}

function phase(statusSource, id, label, required = true) {
  const source = asObject(statusSource, id)
  return {
    id,
    label,
    required,
    status: normalizeStatus(source.status),
    evidence: text(source.evidence || source.archivePath || source.runId || source.requestId || ''),
    details: redact(source),
  }
}

function addIssue(issues, severity, code, message, phaseId = null) {
  issues.push({ severity, code, message, phaseId })
}

function evaluatePhases(packet, evidence) {
  const connections = asObject(evidence.connections, 'evidence.connections')
  const bomRequired = hasBomPipeline(packet)
  const sqlExpected = hasSqlChannel(packet)
  const phases = [
    phase(evidence.gate, 'gate', 'GATE answers archived', true),
    phase(connections.plm, 'plmConnection', 'PLM testConnection', true),
    phase(connections.k3Wise, 'k3Connection', 'K3 WISE testConnection', true),
    phase(evidence.materialDryRun, 'materialDryRun', 'Material dry-run', true),
    phase(evidence.materialSaveOnly, 'materialSaveOnly', 'Material Save-only write', true),
    phase(evidence.deadLetterReplay, 'deadLetterReplay', 'Dead letter and replay', true),
    phase(evidence.bomPoC, 'bomPoC', 'Simple BOM PoC', bomRequired),
    phase(evidence.rollback, 'rollback', 'Rollback or cleanup', true),
    phase(evidence.customerConfirmation, 'customerConfirmation', 'Customer confirmation', true),
  ]
  if (sqlExpected) {
    phases.splice(3, 0, phase(connections.sqlServer, 'sqlConnection', 'K3 SQL Server channel test', false))
  }
  return phases
}

function evaluateMaterialSaveOnly(evidence, issues) {
  const save = asObject(evidence.materialSaveOnly, 'evidence.materialSaveOnly')
  const status = normalizeStatus(save.status)
  if (status !== 'pass') return

  if (normalizeSafeBoolean(save.autoSubmit, 'materialSaveOnly.autoSubmit') || normalizeSafeBoolean(save.autoAudit, 'materialSaveOnly.autoAudit')) {
    addIssue(issues, 'fail', 'SAVE_ONLY_VIOLATED', 'material Save-only evidence has autoSubmit or autoAudit enabled', 'materialSaveOnly')
  }
  const rowsWritten = Number(save.rowsWritten)
  if (!Number.isInteger(rowsWritten) || rowsWritten < 1 || rowsWritten > 3) {
    addIssue(issues, 'fail', 'SAVE_ONLY_ROW_COUNT', 'material Save-only must write between 1 and 3 rows', 'materialSaveOnly')
  }
  if (!text(save.runId)) {
    addIssue(issues, 'fail', 'SAVE_ONLY_RUN_ID_REQUIRED', 'material Save-only evidence must include runId', 'materialSaveOnly')
  }
  if (asArray(save.k3Records, 'materialSaveOnly.k3Records').length === 0) {
    addIssue(issues, 'fail', 'K3_RECORD_REQUIRED', 'material Save-only evidence must include at least one K3 test record', 'materialSaveOnly')
  }
}

function evaluateBom(packet, evidence, issues) {
  if (!hasBomPipeline(packet)) return
  const bom = asObject(evidence.bomPoC, 'evidence.bomPoC')
  if (normalizeStatus(bom.status) !== 'pass') return
  if (!text(bom.productId)) {
    addIssue(issues, 'fail', 'BOM_PRODUCT_SCOPE_REQUIRED', 'BOM PoC evidence must include productId', 'bomPoC')
  }
  if (normalizeSafeBoolean(bom.legacyPipelineOptionsSourceProductId, 'bomPoC.legacyPipelineOptionsSourceProductId')) {
    addIssue(issues, 'fail', 'LEGACY_BOM_PRODUCT_ID_USED', 'BOM PoC must not use pipeline.options.source.productId', 'bomPoC')
  }
}

function determineDecision(phases, issues) {
  if (issues.some((issue) => issue.severity === 'fail')) return 'FAIL'
  if (phases.some((item) => item.required && item.status === 'fail')) return 'FAIL'
  if (phases.some((item) => item.status === 'blocked')) return 'PARTIAL'
  if (phases.some((item) => item.required && item.status !== 'pass')) return 'PARTIAL'
  if (issues.length > 0) return 'PARTIAL'
  return 'PASS'
}

function buildEvidenceReport(packet, evidence, { generatedAt = new Date().toISOString() } = {}) {
  if (!isPlainObject(packet)) throw new LivePocEvidenceError('packet must be a JSON object')
  if (!isPlainObject(evidence)) throw new LivePocEvidenceError('evidence must be a JSON object')

  requirePacketSafety(packet)
  const secretLeaks = [
    ...findSecretLeaks(packet, 'packet'),
    ...findSecretLeaks(evidence, 'evidence'),
  ]
  if (secretLeaks.length > 0) {
    throw new LivePocEvidenceError('evidence contains unredacted secret-like fields', {
      secretLeaks,
    })
  }

  const issues = []
  const phases = evaluatePhases(packet, evidence)
  evaluateMaterialSaveOnly(evidence, issues)
  evaluateBom(packet, evidence, issues)

  for (const item of phases) {
    if (!VALID_STATUSES.has(item.status)) {
      addIssue(issues, 'fail', 'INVALID_PHASE_STATUS', `invalid status for ${item.id}`, item.id)
    }
    if (item.required && item.status === 'skipped') {
      addIssue(issues, 'warn', 'REQUIRED_PHASE_SKIPPED', `${item.label} is required but skipped`, item.id)
    }
  }

  const decision = determineDecision(phases, issues)
  return {
    schemaVersion: 1,
    generatedAt,
    decision,
    packet: {
      tenantId: packet.tenantId,
      workspaceId: packet.workspaceId,
      projectId: packet.projectId || null,
      generatedAt: packet.generatedAt || null,
      status: packet.status || null,
      safety: redact(packet.safety || {}),
    },
    scope: {
      bomRequired: hasBomPipeline(packet),
      sqlChannelExpected: hasSqlChannel(packet),
    },
    phases,
    issues,
    redactedEvidence: redact(evidence),
  }
}

function renderMarkdown(report) {
  const lines = [
    `# K3 WISE Live PoC Evidence Report - ${report.generatedAt.slice(0, 10)}`,
    '',
    '## Decision',
    '',
    `- Decision: ${report.decision}`,
    `- Tenant: ${report.packet.tenantId}`,
    `- Workspace: ${report.packet.workspaceId}`,
    `- BOM required: ${report.scope.bomRequired}`,
    `- SQL channel expected: ${report.scope.sqlChannelExpected}`,
    `- Save-only: ${report.packet.safety.saveOnly}`,
    `- Auto Submit: ${report.packet.safety.autoSubmit}`,
    `- Auto Audit: ${report.packet.safety.autoAudit}`,
    '',
    '## Phase Results',
    '',
    '| Phase | Required | Status | Evidence |',
    '|---|---:|---|---|',
    ...report.phases.map((item) => `| ${item.label} | ${item.required ? 'yes' : 'no'} | ${item.status} | ${item.evidence || '-'} |`),
    '',
    '## Issues',
    '',
  ]
  if (report.issues.length === 0) {
    lines.push('No issues recorded.', '')
  } else {
    lines.push('| Severity | Code | Phase | Message |', '|---|---|---|---|')
    for (const issue of report.issues) {
      lines.push(`| ${issue.severity} | ${issue.code} | ${issue.phaseId || '-'} | ${issue.message} |`)
    }
    lines.push('')
  }
  lines.push(
    '## Next Action',
    '',
    report.decision === 'PASS'
      ? 'M3 UI can start after the customer signs off the evidence package.'
      : report.decision === 'PARTIAL'
        ? 'Keep work in M2 and close the incomplete or blocked evidence items before starting M3 UI.'
        : 'Stop live work and revisit GATE assumptions, connectivity, or K3 payload contract before retrying.',
    '',
  )
  return `${lines.join('\n')}\n`
}

function sampleEvidence() {
  return {
    gate: {
      status: 'pass',
      archivePath: 'customer-secure-share://k3wise-gate-answers',
    },
    connections: {
      plm: { status: 'pass', requestId: 'plm-conn-001' },
      k3Wise: { status: 'pass', requestId: 'k3-conn-001' },
      sqlServer: { status: 'pass', requestId: 'sql-conn-001' },
    },
    materialDryRun: {
      status: 'pass',
      runId: 'run-dry-001',
      rowsPreviewed: 3,
    },
    materialSaveOnly: {
      status: 'pass',
      runId: 'run-save-001',
      rowsWritten: 2,
      autoSubmit: false,
      autoAudit: false,
      k3Records: [
        { materialCode: 'MAT-001', externalId: 'K3-1001', billNo: 'K3-BILL-001' },
        { materialCode: 'MAT-002', externalId: 'K3-1002', billNo: 'K3-BILL-002' },
      ],
    },
    deadLetterReplay: {
      status: 'pass',
      originalRunId: 'run-fail-001',
      replayRunId: 'run-replay-001',
    },
    bomPoC: {
      status: 'pass',
      runId: 'run-bom-001',
      productId: 'PRODUCT-TEST-001',
      legacyPipelineOptionsSourceProductId: false,
    },
    rollback: {
      status: 'pass',
      owner: 'customer-k3-admin',
      evidence: 'test records retained with TEST prefix',
    },
    customerConfirmation: {
      status: 'pass',
      owner: 'customer-evidence-owner',
      confirmedAt: '2026-04-25T10:00:00.000Z',
    },
  }
}

function parseArgs(argv) {
  const args = { outDir: 'artifacts/integration-live-poc/evidence' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--packet') {
      args.packet = argv[++i]
    } else if (arg === '--evidence') {
      args.evidence = argv[++i]
    } else if (arg === '--out-dir') {
      args.outDir = argv[++i]
    } else if (arg === '--print-sample-evidence') {
      args.printSampleEvidence = true
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new LivePocEvidenceError(`unknown argument: ${arg}`)
    }
  }
  return args
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log('Usage: node scripts/ops/integration-k3wise-live-poc-evidence.mjs --packet packet.json --evidence evidence.json --out-dir artifacts/integration-live-poc/evidence')
    console.log('       node scripts/ops/integration-k3wise-live-poc-evidence.mjs --print-sample-evidence')
    return 0
  }
  if (args.printSampleEvidence) {
    console.log(JSON.stringify(sampleEvidence(), null, 2))
    return 0
  }
  if (!args.packet || !args.evidence) {
    throw new LivePocEvidenceError('--packet and --evidence are required')
  }

  const packet = JSON.parse(await readFile(args.packet, 'utf8'))
  const evidence = JSON.parse(await readFile(args.evidence, 'utf8'))
  const report = buildEvidenceReport(packet, evidence)
  const outDir = path.resolve(args.outDir)
  await mkdir(outDir, { recursive: true })
  const jsonPath = path.join(outDir, 'integration-k3wise-live-poc-evidence-report.json')
  const mdPath = path.join(outDir, 'integration-k3wise-live-poc-evidence-report.md')
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(mdPath, renderMarkdown(report))
  console.log(JSON.stringify({
    ok: true,
    decision: report.decision,
    jsonPath,
    mdPath,
    issues: report.issues.length,
  }, null, 2))
  return 0
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (entryPath && import.meta.url === entryPath) {
  runCli().catch((error) => {
    const body = error instanceof LivePocEvidenceError
      ? { ok: false, code: error.name, message: error.message, details: error.details }
      : { ok: false, code: error && error.name ? error.name : 'Error', message: error && error.message ? error.message : String(error) }
    console.error(JSON.stringify(body, null, 2))
    process.exitCode = 1
  })
}

export {
  LivePocEvidenceError,
  buildEvidenceReport,
  findSecretLeaks,
  redact,
  renderMarkdown,
  runCli,
  sampleEvidence,
}
