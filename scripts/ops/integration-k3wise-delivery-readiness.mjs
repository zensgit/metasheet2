#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_OUTPUT_ROOT = 'artifacts/integration-k3wise/delivery-readiness'
const BLOCKED_DECISION = 'BLOCKED'
const INTERNAL_READY_DECISION = 'INTERNAL_READY_WAITING_CUSTOMER_GATE'
const CUSTOMER_READY_DECISION = 'CUSTOMER_TRIAL_READY'
const CUSTOMER_SIGNED_OFF_DECISION = 'CUSTOMER_TRIAL_SIGNED_OFF'

class K3WiseDeliveryReadinessError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'K3WiseDeliveryReadinessError'
    this.details = details
  }
}

function nowStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new K3WiseDeliveryReadinessError(`${flag} requires a value`, { flag })
  }
  return next
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    postdeploySmoke: '',
    preflightPacket: '',
    liveEvidenceReport: '',
    outDir: '',
    failOnBlocked: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--postdeploy-smoke':
        opts.postdeploySmoke = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--preflight-packet':
        opts.preflightPacket = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--live-evidence-report':
        opts.liveEvidenceReport = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--out-dir':
        opts.outDir = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--fail-on-blocked':
        opts.failOnBlocked = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new K3WiseDeliveryReadinessError(`unknown option: ${arg}`, { arg })
    }
  }

  return opts
}

function printHelp() {
  console.log(`Usage: node scripts/ops/integration-k3wise-delivery-readiness.mjs [options]

Combines K3 WISE delivery evidence into one readiness decision.

Options:
  --postdeploy-smoke <path>      integration-k3wise-postdeploy-smoke.json
  --preflight-packet <path>      packet.json from live PoC preflight
  --live-evidence-report <path>  integration-k3wise-live-poc-evidence-report.json
  --out-dir <dir>                Output directory, default ${DEFAULT_OUTPUT_ROOT}/<timestamp>
  --fail-on-blocked              Exit non-zero when the readiness decision is BLOCKED
  --help                         Show this help
`)
}

function gate(id, label, status, details = {}) {
  return {
    id,
    label,
    status,
    ...details,
  }
}

function evaluatePostdeploySmoke(evidence) {
  if (!evidence) {
    return gate('postdeploy-smoke', 'Deployed MetaSheet K3 WISE smoke', 'pending', {
      reason: 'postdeploy smoke evidence not provided',
      requiredFor: CUSTOMER_READY_DECISION,
    })
  }
  if (!isPlainObject(evidence)) {
    return gate('postdeploy-smoke', 'Deployed MetaSheet K3 WISE smoke', 'fail', {
      reason: 'postdeploy smoke evidence must be a JSON object',
    })
  }

  const authenticated = evidence.authenticated === true
  const signoff = evidence.signoff && typeof evidence.signoff === 'object' ? evidence.signoff : {}
  if (evidence.ok === true && authenticated && signoff.internalTrial === 'pass') {
    return gate('postdeploy-smoke', 'Deployed MetaSheet K3 WISE smoke', 'pass', {
      reason: signoff.reason || 'authenticated postdeploy smoke passed',
      summary: evidence.summary || {},
    })
  }
  if (evidence.ok === true && authenticated && signoff.internalTrial === undefined) {
    return gate('postdeploy-smoke', 'Deployed MetaSheet K3 WISE smoke', 'pass', {
      reason: 'authenticated postdeploy smoke passed; legacy evidence has no signoff block',
      summary: evidence.summary || {},
      warning: 'missing signoff.internalTrial in postdeploy evidence',
    })
  }
  return gate('postdeploy-smoke', 'Deployed MetaSheet K3 WISE smoke', 'fail', {
    reason: signoff.reason || (authenticated ? 'postdeploy smoke did not pass' : 'authenticated checks did not run'),
    authenticated,
    summary: evidence.summary || {},
  })
}

function evaluatePreflightPacket(packet) {
  if (!packet) {
    return gate('preflight-packet', 'Customer GATE preflight packet', 'pending', {
      reason: 'preflight packet not provided',
      requiredFor: CUSTOMER_READY_DECISION,
    })
  }
  if (!isPlainObject(packet)) {
    return gate('preflight-packet', 'Customer GATE preflight packet', 'fail', {
      reason: 'preflight packet must be a JSON object',
    })
  }
  const safety = isPlainObject(packet.safety) ? packet.safety : {}
  const failures = []
  if (packet.status !== 'preflight-ready') failures.push('packet.status must be preflight-ready')
  if (safety.saveOnly !== true) failures.push('packet.safety.saveOnly must be true')
  if (safety.autoSubmit !== false) failures.push('packet.safety.autoSubmit must be false')
  if (safety.autoAudit !== false) failures.push('packet.safety.autoAudit must be false')
  if (safety.productionWriteBlocked !== true) failures.push('packet.safety.productionWriteBlocked must be true')

  if (failures.length > 0) {
    return gate('preflight-packet', 'Customer GATE preflight packet', 'fail', {
      reason: failures.join('; '),
      tenantId: packet.tenantId || null,
      workspaceId: packet.workspaceId || null,
    })
  }
  return gate('preflight-packet', 'Customer GATE preflight packet', 'pass', {
    reason: 'preflight packet is Save-only and production-write blocked',
    tenantId: packet.tenantId || null,
    workspaceId: packet.workspaceId || null,
    projectId: packet.projectId || null,
  })
}

function evaluateLiveEvidenceReport(report) {
  if (!report) {
    return gate('live-evidence', 'Customer live PoC evidence report', 'pending', {
      reason: 'live evidence report not provided',
      requiredFor: CUSTOMER_SIGNED_OFF_DECISION,
    })
  }
  if (!isPlainObject(report)) {
    return gate('live-evidence', 'Customer live PoC evidence report', 'fail', {
      reason: 'live evidence report must be a JSON object',
    })
  }
  if (report.decision === 'PASS') {
    return gate('live-evidence', 'Customer live PoC evidence report', 'pass', {
      reason: 'live PoC evidence decision is PASS',
      issues: Array.isArray(report.issues) ? report.issues.length : 0,
    })
  }
  return gate('live-evidence', 'Customer live PoC evidence report', 'fail', {
    reason: `live PoC evidence decision is ${report.decision || 'missing'}`,
    issues: Array.isArray(report.issues) ? report.issues : [],
  })
}

function decide(gates) {
  if (gates.some((item) => item.status === 'fail')) return BLOCKED_DECISION
  const postdeploy = gates.find((item) => item.id === 'postdeploy-smoke')
  const preflight = gates.find((item) => item.id === 'preflight-packet')
  const live = gates.find((item) => item.id === 'live-evidence')

  if (postdeploy?.status === 'pass' && preflight?.status === 'pass' && live?.status === 'pass') {
    return CUSTOMER_SIGNED_OFF_DECISION
  }
  if (postdeploy?.status === 'pass' && preflight?.status === 'pass') {
    return CUSTOMER_READY_DECISION
  }
  if (postdeploy?.status === 'pass') {
    return INTERNAL_READY_DECISION
  }
  return BLOCKED_DECISION
}

function nextAction(decision) {
  switch (decision) {
    case CUSTOMER_SIGNED_OFF_DECISION:
      return 'Customer trial is signed off. Production use still requires customer change approval, backup/rollback confirmation, and an agreed go-live window.'
    case CUSTOMER_READY_DECISION:
      return 'Start the customer K3 WISE test-account live PoC: create systems, run dry-run, run Save-only, compile live evidence.'
    case INTERNAL_READY_DECISION:
      return 'Wait for customer GATE answers, then run live preflight to produce a preflight-ready packet.'
    default:
      return 'Do not start customer live work. Fix failing gates or run the missing internal postdeploy smoke first.'
  }
}

function buildReadinessReport(inputs = {}, { generatedAt = new Date().toISOString() } = {}) {
  const gates = [
    evaluatePostdeploySmoke(inputs.postdeploySmoke),
    evaluatePreflightPacket(inputs.preflightPacket),
    evaluateLiveEvidenceReport(inputs.liveEvidenceReport),
  ]
  const decision = decide(gates)
  return {
    schemaVersion: 1,
    generatedAt,
    decision,
    gates,
    productionUse: {
      ready: false,
      reason: 'production go-live requires explicit customer signoff, backup/rollback approval, and a scheduled change window',
    },
    nextAction: nextAction(decision),
  }
}

function renderMarkdown(report) {
  const lines = [
    `# K3 WISE Delivery Readiness - ${report.generatedAt.slice(0, 10)}`,
    '',
    '## Decision',
    '',
    `- Readiness: **${report.decision}**`,
    `- Production use ready: **${report.productionUse.ready ? 'yes' : 'no'}**`,
    `- Production note: ${report.productionUse.reason}`,
    `- Next action: ${report.nextAction}`,
    '',
    '## Gates',
    '',
    '| Gate | Status | Reason |',
    '|---|---|---|',
    ...report.gates.map((item) => `| ${item.label} | ${item.status} | ${item.reason || '-'} |`),
    '',
  ]
  return `${lines.join('\n')}\n`
}

async function readJsonFile(filePath, label) {
  if (!filePath) return null
  const absolutePath = path.resolve(filePath)
  let raw
  try {
    raw = await readFile(absolutePath, 'utf8')
  } catch (error) {
    throw new K3WiseDeliveryReadinessError(`${label} file cannot be read`, {
      path: absolutePath,
      cause: error && error.message ? error.message : String(error),
    })
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new K3WiseDeliveryReadinessError(`${label} file is not valid JSON`, {
      path: absolutePath,
      cause: error && error.message ? error.message : String(error),
    })
  }
}

async function runCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    printHelp()
    return 0
  }
  const [postdeploySmoke, preflightPacket, liveEvidenceReport] = await Promise.all([
    readJsonFile(opts.postdeploySmoke, 'postdeploy smoke'),
    readJsonFile(opts.preflightPacket, 'preflight packet'),
    readJsonFile(opts.liveEvidenceReport, 'live evidence report'),
  ])
  const report = buildReadinessReport({ postdeploySmoke, preflightPacket, liveEvidenceReport })
  const outDir = path.resolve(opts.outDir || path.join(DEFAULT_OUTPUT_ROOT, nowStamp()))
  await mkdir(outDir, { recursive: true })
  const jsonPath = path.join(outDir, 'integration-k3wise-delivery-readiness.json')
  const mdPath = path.join(outDir, 'integration-k3wise-delivery-readiness.md')
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(mdPath, renderMarkdown(report))
  console.log(JSON.stringify({
    ok: report.decision !== BLOCKED_DECISION,
    decision: report.decision,
    jsonPath,
    mdPath,
  }, null, 2))
  return opts.failOnBlocked && report.decision === BLOCKED_DECISION ? 1 : 0
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (entryPath && import.meta.url === entryPath) {
  runCli().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    const body = error instanceof K3WiseDeliveryReadinessError
      ? { ok: false, code: error.name, message: error.message, details: error.details }
      : { ok: false, code: error && error.name ? error.name : 'Error', message: error && error.message ? error.message : String(error) }
    console.error(JSON.stringify(body, null, 2))
    process.exitCode = 1
  })
}

export {
  BLOCKED_DECISION,
  CUSTOMER_READY_DECISION,
  CUSTOMER_SIGNED_OFF_DECISION,
  INTERNAL_READY_DECISION,
  K3WiseDeliveryReadinessError,
  buildReadinessReport,
  decide,
  evaluateLiveEvidenceReport,
  evaluatePostdeploySmoke,
  evaluatePreflightPacket,
  parseArgs,
  renderMarkdown,
  runCli,
}
