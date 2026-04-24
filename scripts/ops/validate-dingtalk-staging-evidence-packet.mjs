#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const DEFAULT_PACKET_DIR = 'artifacts/dingtalk-staging-evidence-packet'
const MAX_SECRET_SCAN_BYTES = 2 * 1024 * 1024
const REQUIRED_CHECK_IDS = [
  'create-table-form',
  'bind-two-dingtalk-groups',
  'set-form-dingtalk-granted',
  'send-group-message-form-link',
  'authorized-user-submit',
  'unauthorized-user-denied',
  'delivery-history-group-person',
  'no-email-user-create-bind',
]
const VALID_REMOTE_SMOKE_PHASES = new Set(['bootstrap_pending', 'manual_pending', 'finalize_pending', 'fail'])
const SECRET_PATTERNS = [
  {
    name: 'dingtalk_robot_webhook',
    regex: /https:\/\/oapi\.dingtalk\.com\/robot\/send\?[^\s"'`<>]*access_token=(?!<redacted>|\$|%24|\(\?)[^\s&"'`<>]{8,}/gi,
  },
  {
    name: 'access_token_param',
    regex: /(?:^|[?&])access_token=(?!<redacted>|\$|%24|replace-me|\(\?)[A-Za-z0-9._~+/=-]{16,}/gi,
  },
  {
    name: 'bearer_token',
    regex: /\bBearer\s+(?!<redacted>|\$|\{)[A-Za-z0-9._~+/=-]{20,}/gi,
  },
  {
    name: 'dingtalk_sec_secret',
    regex: /\bSEC(?=[A-Za-z0-9+/=-]{12,}\b)(?=[A-Za-z0-9+/=-]*\d)[A-Za-z0-9+/=-]{12,}\b/g,
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    name: 'dingtalk_secret_assignment',
    regex: /\b(?:DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET|client_secret)\s*=\s*(?!<redacted>|replace-me|\$|\s|$)[^\s&"'`<>]{8,}/gi,
  },
  {
    name: 'public_form_token',
    regex: /\bpublicToken=(?!<redacted>|\$)[A-Za-z0-9._~+/=-]{12,}/gi,
  },
]

function printHelp() {
  console.log(`Usage: node scripts/ops/validate-dingtalk-staging-evidence-packet.mjs [options]

Validates a DingTalk staging evidence packet before release handoff.

Options:
  --packet-dir <dir>        Packet directory, default ${DEFAULT_PACKET_DIR}
  --output-json <file>      Optional JSON report path
  --help                    Show this help
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return next
}

function parseArgs(argv) {
  const opts = {
    packetDir: path.resolve(process.cwd(), DEFAULT_PACKET_DIR),
    outputJson: '',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--packet-dir':
        opts.packetDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--output-json':
        opts.outputJson = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return opts
}

function relativePath(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function readJsonFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`${label} does not exist: ${relativePath(file)}`)
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function resolveInside(baseDir, relativeFile, label) {
  if (!relativeFile || path.isAbsolute(relativeFile)) {
    throw new Error(`${label} must be a relative path inside the packet`)
  }
  const resolved = path.resolve(baseDir, relativeFile)
  const normalizedBase = path.resolve(baseDir)
  if (resolved !== normalizedBase && !resolved.startsWith(`${normalizedBase}${path.sep}`)) {
    throw new Error(`${label} escapes the packet directory: ${relativeFile}`)
  }
  return resolved
}

function requireEmptyArray(value, field, failures) {
  if (!Array.isArray(value)) {
    failures.push(`${field} is not an array`)
    return []
  }
  if (value.length > 0) failures.push(`${field} is not empty`)
  return value
}

function evidenceTopLevelName(destination) {
  if (typeof destination !== 'string') return ''
  const parts = destination.replaceAll('\\', '/').split('/').filter(Boolean)
  if (parts[0] !== 'evidence' || !parts[1]) return ''
  return parts[1]
}

function validateRegisteredEvidenceEntries(packetDir, includedEvidence, failures) {
  const evidenceDir = path.join(packetDir, 'evidence')
  if (!existsSync(evidenceDir)) return
  if (!statSync(evidenceDir).isDirectory()) {
    failures.push('evidence is not a directory')
    return
  }

  const registered = new Set(
    Array.isArray(includedEvidence)
      ? includedEvidence.map((entry) => evidenceTopLevelName(entry?.destination)).filter(Boolean)
      : [],
  )
  for (const entry of readdirSync(evidenceDir, { withFileTypes: true })) {
    if (!registered.has(entry.name)) {
      failures.push(`evidence/${entry.name} is not registered in manifest includedEvidence`)
    }
  }
}

function hasPassingCheck(requiredChecks, id) {
  return Array.isArray(requiredChecks) && requiredChecks.some((check) => check?.id === id && check.status === 'pass')
}

function validateOptionalRemoteSmokePhase(value, field, failures) {
  if (value === undefined || value === null) return
  if (typeof value !== 'string' || !VALID_REMOTE_SMOKE_PHASES.has(value)) {
    failures.push(`${field} is not a recognized remote smoke phase`)
  }
}

function validateIncludedEvidence(packetDir, entry, index, failures) {
  const label = `includedEvidence[${index}]`
  let evidenceDir
  try {
    evidenceDir = resolveInside(packetDir, entry?.destination, `${label}.destination`)
  } catch (error) {
    failures.push(error.message)
    return
  }
  if (!existsSync(evidenceDir) || !statSync(evidenceDir).isDirectory()) {
    failures.push(`${label}.destination directory does not exist`)
    return
  }

  const status = entry.dingtalkP4FinalStatus
  if (status?.status !== 'pass') failures.push(`${label}.dingtalkP4FinalStatus.status is not pass`)
  if (status?.sessionPhase !== 'finalize') failures.push(`${label}.dingtalkP4FinalStatus.sessionPhase is not finalize`)
  if (status?.finalStrictStatus !== 'pass') failures.push(`${label}.dingtalkP4FinalStatus.finalStrictStatus is not pass`)
  if (status?.compiledOverallStatus !== 'pass') failures.push(`${label}.dingtalkP4FinalStatus.compiledOverallStatus is not pass`)
  if (status?.apiBootstrapStatus !== 'pass') failures.push(`${label}.dingtalkP4FinalStatus.apiBootstrapStatus is not pass`)
  if (status?.remoteClientStatus !== 'pass') failures.push(`${label}.dingtalkP4FinalStatus.remoteClientStatus is not pass`)
  validateOptionalRemoteSmokePhase(status?.remoteSmokePhase, `${label}.dingtalkP4FinalStatus.remoteSmokePhase`, failures)
  if (status?.requiredChecks !== REQUIRED_CHECK_IDS.length) {
    failures.push(`${label}.dingtalkP4FinalStatus.requiredChecks is not ${REQUIRED_CHECK_IDS.length}`)
  }

  let sessionSummary
  let compiledSummary
  try {
    sessionSummary = readJsonFile(path.join(evidenceDir, 'session-summary.json'), `${label}/session-summary.json`)
    compiledSummary = readJsonFile(path.join(evidenceDir, 'compiled', 'summary.json'), `${label}/compiled/summary.json`)
  } catch (error) {
    failures.push(error.message)
    return
  }

  if (sessionSummary.tool !== 'dingtalk-p4-smoke-session') failures.push(`${label}/session-summary.json tool is not dingtalk-p4-smoke-session`)
  if (sessionSummary.sessionPhase !== 'finalize') failures.push(`${label}/session-summary.json sessionPhase is not finalize`)
  if (sessionSummary.overallStatus !== 'pass') failures.push(`${label}/session-summary.json overallStatus is not pass`)
  if (sessionSummary.finalStrictStatus !== 'pass') failures.push(`${label}/session-summary.json finalStrictStatus is not pass`)
  requireEmptyArray(sessionSummary.pendingChecks, `${label}/session-summary.json pendingChecks`, failures)
  const strictStep = Array.isArray(sessionSummary.steps)
    ? sessionSummary.steps.find((step) => step?.id === 'strict-compile')
    : null
  if (!strictStep || strictStep.status !== 'pass') {
    failures.push(`${label}/session-summary.json strict-compile step is not pass`)
  }

  if (compiledSummary.tool !== 'compile-dingtalk-p4-smoke-evidence') failures.push(`${label}/compiled/summary.json tool is not compile-dingtalk-p4-smoke-evidence`)
  if (compiledSummary.overallStatus !== 'pass') failures.push(`${label}/compiled/summary.json overallStatus is not pass`)
  if (compiledSummary.apiBootstrapStatus !== 'pass') failures.push(`${label}/compiled/summary.json apiBootstrapStatus is not pass`)
  if (compiledSummary.remoteClientStatus !== 'pass') failures.push(`${label}/compiled/summary.json remoteClientStatus is not pass`)
  validateOptionalRemoteSmokePhase(compiledSummary.remoteSmokePhase, `${label}/compiled/summary.json remoteSmokePhase`, failures)
  if (
    typeof status?.remoteSmokePhase === 'string'
    && typeof compiledSummary.remoteSmokePhase === 'string'
    && status.remoteSmokePhase !== compiledSummary.remoteSmokePhase
  ) {
    failures.push(`${label}.dingtalkP4FinalStatus.remoteSmokePhase does not match compiled summary`)
  }
  if (compiledSummary.totals?.pendingChecks !== 0) failures.push(`${label}/compiled/summary.json totals.pendingChecks is not 0`)
  if (compiledSummary.totals?.missingRequiredChecks !== 0) failures.push(`${label}/compiled/summary.json totals.missingRequiredChecks is not 0`)
  if (compiledSummary.totals?.failedChecks !== 0) failures.push(`${label}/compiled/summary.json totals.failedChecks is not 0`)
  for (const id of REQUIRED_CHECK_IDS) {
    if (!hasPassingCheck(compiledSummary.requiredChecks, id)) {
      failures.push(`${label}/compiled/summary.json required check ${id} is not pass`)
    }
  }
  requireEmptyArray(compiledSummary.requiredChecksNotPassed, `${label}/compiled/summary.json requiredChecksNotPassed`, failures)
  requireEmptyArray(compiledSummary.manualEvidenceIssues, `${label}/compiled/summary.json manualEvidenceIssues`, failures)
  requireEmptyArray(compiledSummary.failedChecks, `${label}/compiled/summary.json failedChecks`, failures)
  requireEmptyArray(compiledSummary.missingRequiredChecks, `${label}/compiled/summary.json missingRequiredChecks`, failures)
}

function isLikelyText(buffer) {
  return !buffer.includes(0)
}

function scanFileForSecrets(file, packetDir, findings) {
  const stats = statSync(file)
  if (!stats.isFile() || stats.size > MAX_SECRET_SCAN_BYTES) return 0
  const buffer = readFileSync(file)
  if (!isLikelyText(buffer)) return 0
  const content = buffer.toString('utf8')
  let matches = 0
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0
    for (const match of content.matchAll(pattern.regex)) {
      findings.push({
        file: path.relative(packetDir, file).replaceAll('\\', '/'),
        pattern: pattern.name,
        preview: match[0].slice(0, 80),
      })
      matches += 1
    }
  }
  return matches
}

function walkFiles(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(fullPath, visit)
    } else if (entry.isFile()) {
      visit(fullPath)
    }
  }
}

function validatePacket(packetDir) {
  const failures = []
  const secretFindings = []
  const manifestPath = path.join(packetDir, 'manifest.json')
  const readmePath = path.join(packetDir, 'README.md')
  const manifest = readJsonFile(manifestPath, 'manifest.json')

  if (!existsSync(readmePath) || !statSync(readmePath).isFile()) {
    failures.push('README.md does not exist')
  }
  if (manifest.packet !== 'dingtalk-staging-evidence-packet') failures.push('manifest packet is not dingtalk-staging-evidence-packet')
  if (Number.isNaN(Date.parse(manifest.generatedAt ?? ''))) failures.push('manifest generatedAt is not a valid timestamp')
  if (manifest.requireDingTalkP4Pass !== true) failures.push('manifest requireDingTalkP4Pass is not true')
  if (!Array.isArray(manifest.includedEvidence) || manifest.includedEvidence.length === 0) {
    failures.push('manifest includedEvidence is empty')
  } else {
    validateRegisteredEvidenceEntries(packetDir, manifest.includedEvidence, failures)
    manifest.includedEvidence.forEach((entry, index) => validateIncludedEvidence(packetDir, entry, index, failures))
  }

  let scannedFiles = 0
  walkFiles(packetDir, (file) => {
    scannedFiles += 1
    scanFileForSecrets(file, packetDir, secretFindings)
  })
  for (const finding of secretFindings) {
    failures.push(`secret-like value detected in ${finding.file} (${finding.pattern})`)
  }

  return {
    tool: 'validate-dingtalk-staging-evidence-packet',
    generatedAt: new Date().toISOString(),
    packetDir: relativePath(packetDir),
    status: failures.length === 0 ? 'pass' : 'fail',
    includedEvidenceCount: Array.isArray(manifest.includedEvidence) ? manifest.includedEvidence.length : 0,
    scannedFiles,
    secretFindings,
    failures,
  }
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2))
    const report = validatePacket(opts.packetDir)
    if (opts.outputJson) {
      mkdirSync(path.dirname(opts.outputJson), { recursive: true })
      writeFileSync(opts.outputJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      console.log(`Wrote ${relativePath(opts.outputJson)}`)
    }
    if (report.status !== 'pass') {
      for (const failure of report.failures) console.error(`- ${failure}`)
      throw new Error(`DingTalk staging evidence packet publish check failed: ${relativePath(opts.packetDir)}`)
    }
    console.log(`DingTalk staging evidence packet publish check passed: ${relativePath(opts.packetDir)}`)
  } catch (error) {
    console.error(`[validate-dingtalk-staging-evidence-packet] ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

await main()
