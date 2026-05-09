#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_OUTPUT_DIR = 'docs/development'
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
const SECRET_PATTERNS = [
  /https:\/\/oapi\.dingtalk\.com\/robot\/send\?[^\s"'`<>]*access_token=(?!<redacted>)[^\s&"'`<>]{8,}/i,
  /\bBearer\s+(?!<redacted>)[A-Za-z0-9._~+/=-]{20,}/i,
  /\bSEC[A-Za-z0-9+/=_-]{8,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:client_secret|DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET)\s*=\s*(?!<redacted>)[^\s&"'`<>]{8,}/i,
  /\bpublicToken=(?!<redacted>)[A-Za-z0-9._~+/=-]{12,}/i,
]

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-p4-final-docs.mjs [options]

Generates final DingTalk remote-smoke development and verification Markdown from
a finalized P4 session, release-ready smoke status, and final handoff summary.
It does not call DingTalk or staging.

Options:
  --session-dir <dir>          Finalized DingTalk P4 smoke session directory
  --handoff-summary <file>     Final handoff-summary.json path
  --status-summary <file>      Smoke status JSON, default <session-dir>/smoke-status.json
  --compiled-summary <file>    Compiled summary JSON, default <session-dir>/compiled/summary.json
  --output-dir <dir>           Output docs directory, default ${DEFAULT_OUTPUT_DIR}
  --date <yyyymmdd>            Date suffix, default current UTC date
  --development-md <file>      Development Markdown path
  --verification-md <file>     Verification Markdown path
  --require-release-ready      Reject unless session, compiled, status, handoff, and publish checks pass
  --help                       Show this help
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`)
  return next
}

function defaultDate() {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '')
}

function parseArgs(argv) {
  const opts = {
    sessionDir: '',
    handoffSummary: '',
    statusSummary: '',
    compiledSummary: '',
    outputDir: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR),
    date: defaultDate(),
    developmentMd: '',
    verificationMd: '',
    requireReleaseReady: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--session-dir':
        opts.sessionDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--handoff-summary':
        opts.handoffSummary = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--status-summary':
        opts.statusSummary = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--compiled-summary':
        opts.compiledSummary = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--date':
        opts.date = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--development-md':
        opts.developmentMd = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--verification-md':
        opts.verificationMd = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--require-release-ready':
        opts.requireReleaseReady = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!opts.sessionDir) throw new Error('--session-dir is required')
  if (!opts.handoffSummary) throw new Error('--handoff-summary is required')
  if (!/^\d{8}$/.test(opts.date)) throw new Error('--date must be formatted as yyyymmdd')
  opts.statusSummary ||= path.join(opts.sessionDir, 'smoke-status.json')
  opts.compiledSummary ||= path.join(opts.sessionDir, 'compiled', 'summary.json')
  opts.developmentMd ||= path.join(opts.outputDir, `dingtalk-final-remote-smoke-development-${opts.date}.md`)
  opts.verificationMd ||= path.join(opts.outputDir, `dingtalk-final-remote-smoke-verification-${opts.date}.md`)
  return opts
}

function relativePath(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function assertFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`${label} does not exist or is not a file: ${relativePath(file)}`)
  }
}

function readJson(file, label) {
  assertFile(file, label)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function redactString(value) {
  return String(value ?? '')
    .replace(/(access_token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/(publicToken=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&](?:sign|timestamp)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/\b((?:client_secret|DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET)\s*=\s*)[^&\s)"'`<>]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '<jwt:redacted>')
}

function markdownEscape(value) {
  return redactString(value).replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function statusOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'not_available'
}

function compactSnapshot(value) {
  if (value === null || value === undefined || value === '') return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 180 ? `${text.slice(0, 177)}...` : text
}

function requiredChecks(statusSummary, compiledSummary) {
  const fromStatus = Array.isArray(statusSummary?.requiredChecks) ? statusSummary.requiredChecks : []
  const fromCompiled = Array.isArray(compiledSummary?.requiredChecks) ? compiledSummary.requiredChecks : []
  const byId = new Map([...fromCompiled, ...fromStatus]
    .filter((check) => check && typeof check.id === 'string')
    .map((check) => [check.id, check]))

  return REQUIRED_CHECK_IDS.map((id) => {
    const check = byId.get(id) ?? {}
    return {
      id,
      docSection: statusOf(check.docSection),
      topLevelLabel: statusOf(check.topLevelLabel),
      status: statusOf(check.status),
      source: statusOf(check.source ?? check.evidence?.source),
      evidenceSnapshot: compactSnapshot(check.evidenceSnapshot ?? check.evidence ?? null),
      manualEvidenceIssueCount: Number.isFinite(check.manualEvidenceIssueCount) ? check.manualEvidenceIssueCount : 0,
    }
  })
}

function buildModel(opts) {
  const sessionSummary = readJson(path.join(opts.sessionDir, 'session-summary.json'), 'session summary')
  const statusSummary = readJson(opts.statusSummary, 'smoke status summary')
  const compiledSummary = readJson(opts.compiledSummary, 'compiled summary')
  const handoffSummary = readJson(opts.handoffSummary, 'handoff summary')
  const checks = requiredChecks(statusSummary, compiledSummary)
  const packetDir = handoffSummary.outputDir
    ? handoffSummary.outputDir
    : relativePath(path.dirname(opts.handoffSummary))
  const publishStatus = handoffSummary.publishCheck?.status ?? statusSummary.handoff?.publishStatus ?? 'not_available'
  const handoffStatus = handoffSummary.status ?? statusSummary.handoff?.status ?? 'not_available'
  const secretFindingCount = Array.isArray(handoffSummary.publishCheck?.secretFindings)
    ? handoffSummary.publishCheck.secretFindings.length
    : statusSummary.handoff?.secretFindingCount ?? 0

  return {
    date: opts.date,
    generatedAt: new Date().toISOString(),
    sessionDir: relativePath(opts.sessionDir),
    packetDir: redactString(packetDir),
    outputDir: relativePath(opts.outputDir),
    developmentMd: relativePath(opts.developmentMd),
    verificationMd: relativePath(opts.verificationMd),
    handoffSummary: relativePath(opts.handoffSummary),
    statusSummary: relativePath(opts.statusSummary),
    compiledSummary: relativePath(opts.compiledSummary),
    sessionPhase: statusOf(sessionSummary.sessionPhase),
    sessionStatus: statusOf(sessionSummary.overallStatus),
    finalStrictStatus: statusOf(sessionSummary.finalStrictStatus),
    compiledStatus: statusOf(compiledSummary.overallStatus),
    smokeStatus: statusOf(statusSummary.overallStatus),
    apiBootstrapStatus: statusOf(compiledSummary.apiBootstrapStatus),
    remoteClientStatus: statusOf(compiledSummary.remoteClientStatus),
    remoteSmokePhase: statusOf(statusSummary.remoteSmokePhase ?? compiledSummary.remoteSmokePhase),
    handoffStatus: statusOf(handoffStatus),
    publishStatus: statusOf(publishStatus),
    secretFindingCount,
    requiredChecks: checks,
    totals: {
      requiredChecks: checks.length,
      passedChecks: checks.filter((check) => check.status === 'pass').length,
      remainingChecks: checks.filter((check) => check.status !== 'pass').length,
      manualEvidenceIssues: checks.reduce((total, check) => total + check.manualEvidenceIssueCount, 0),
    },
    failures: [
      ...(Array.isArray(handoffSummary.failures) ? handoffSummary.failures : []),
      ...(Array.isArray(statusSummary.handoff?.failures) ? statusSummary.handoff.failures : []),
    ].map((failure) => redactString(failure)),
  }
}

function validateReleaseReady(model, requireReleaseReady) {
  if (!requireReleaseReady) return
  const failures = []
  if (model.sessionPhase !== 'finalize') failures.push('sessionPhase is not finalize')
  if (model.sessionStatus !== 'pass') failures.push('session overallStatus is not pass')
  if (model.finalStrictStatus !== 'pass') failures.push('finalStrictStatus is not pass')
  if (model.compiledStatus !== 'pass') failures.push('compiled summary overallStatus is not pass')
  if (model.apiBootstrapStatus !== 'pass') failures.push('API bootstrap status is not pass')
  if (model.remoteClientStatus !== 'pass') failures.push('remote client status is not pass')
  if (model.remoteSmokePhase !== 'finalize_pending') failures.push('remote smoke phase is not finalize_pending')
  if (model.smokeStatus !== 'release_ready') failures.push('smoke status is not release_ready')
  if (model.handoffStatus !== 'pass') failures.push('handoff status is not pass')
  if (model.publishStatus !== 'pass') failures.push('publish status is not pass')
  if (model.totals.remainingChecks !== 0) failures.push('not all required checks passed')
  if (model.totals.manualEvidenceIssues !== 0) failures.push('manual evidence issues remain')
  if (model.secretFindingCount !== 0) failures.push('publish check reported secret findings')
  if (model.failures.length !== 0) failures.push('handoff or status failures remain')
  if (failures.length > 0) throw new Error(`release-ready final docs rejected: ${failures.join('; ')}`)
}

function renderCheckRows(model) {
  return model.requiredChecks
    .map((check) => `| ${markdownEscape(check.docSection)} | ${markdownEscape(check.topLevelLabel)} | \`${markdownEscape(check.id)}\` | ${markdownEscape(check.status)} | ${markdownEscape(check.source)} | ${markdownEscape(check.evidenceSnapshot)} | ${check.manualEvidenceIssueCount} |`)
    .join('\n')
}

function renderDevelopment(model) {
  return `# DingTalk Final Remote Smoke Development

- Date: ${model.date}
- Generated at: ${model.generatedAt}
- Session directory: \`${model.sessionDir}\`
- Packet directory: \`${model.packetDir}\`
- Status summary: \`${model.statusSummary}\`
- Handoff summary: \`${model.handoffSummary}\`

## Completed Work

- Ran the P4 smoke session through final strict evidence compilation.
- Collected API/bootstrap, DingTalk-client, and manual-admin evidence.
- Exported the final gated evidence packet.
- Ran the publish validator and release-ready status gate.

## Final Status

- Session phase: **${model.sessionPhase}**
- Session status: **${model.sessionStatus}**
- Final strict status: **${model.finalStrictStatus}**
- Compiled status: **${model.compiledStatus}**
- API bootstrap status: **${model.apiBootstrapStatus}**
- Remote client status: **${model.remoteClientStatus}**
- Remote smoke phase: **${model.remoteSmokePhase}**
- Smoke status: **${model.smokeStatus}**
- Handoff status: **${model.handoffStatus}**
- Publish status: **${model.publishStatus}**

## Required Checks

| Doc | Step | Check | Status | Source | Evidence Snapshot | Manual Issues |
| --- | --- | --- | --- | --- | --- | --- |
${renderCheckRows(model)}

## Residual Risks

- Manual screenshot truthfulness still depends on operator evidence quality.
- Raw artifacts must remain restricted to the release team unless separately reviewed.
- Do not publish this packet externally until the human release owner reviews the final artifacts.
`
}

function renderVerification(model) {
  const failures = model.failures.length
    ? model.failures.map((failure) => `- ${markdownEscape(failure)}`).join('\n')
    : '- None'

  return `# DingTalk Final Remote Smoke Verification

- Date: ${model.date}
- Generated at: ${model.generatedAt}

## Commands

\`\`\`bash
node scripts/ops/dingtalk-p4-smoke-status.mjs \\
  --session-dir ${model.sessionDir} \\
  --handoff-summary ${model.handoffSummary} \\
  --require-release-ready

node scripts/ops/validate-dingtalk-staging-evidence-packet.mjs \\
  --packet-dir ${model.packetDir} \\
  --output-json ${model.packetDir}/publish-check.json

node scripts/ops/dingtalk-p4-final-docs.mjs \\
  --session-dir ${model.sessionDir} \\
  --handoff-summary ${model.handoffSummary} \\
  --require-release-ready \\
  --output-dir ${model.outputDir} \\
  --date ${model.date}
\`\`\`

## Actual Results

- Required checks passed: ${model.totals.passedChecks}/${model.totals.requiredChecks}
- Remaining checks: ${model.totals.remainingChecks}
- Manual evidence issues: ${model.totals.manualEvidenceIssues}
- Secret findings: ${model.secretFindingCount}
- Session status: **${model.sessionStatus}**
- Final strict status: **${model.finalStrictStatus}**
- Compiled status: **${model.compiledStatus}**
- API bootstrap status: **${model.apiBootstrapStatus}**
- Remote client status: **${model.remoteClientStatus}**
- Remote smoke phase: **${model.remoteSmokePhase}**
- Smoke status: **${model.smokeStatus}**
- Handoff status: **${model.handoffStatus}**
- Publish status: **${model.publishStatus}**

## Required Checks

| Doc | Step | Check | Status | Source | Evidence Snapshot | Manual Issues |
| --- | --- | --- | --- | --- | --- | --- |
${renderCheckRows(model)}

## Failures

${failures}

## Evidence Hygiene

- This report is generated from redacted summaries and does not include raw tokens, full webhooks, cookies, public form tokens, or temporary passwords.
- Final raw artifacts still require human review before external sharing.
`
}

function assertNoSecrets(text, label) {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new Error(`${label} contains secret-like value`)
  }
}

function writeOutputs(opts, model) {
  const development = renderDevelopment(model)
  const verification = renderVerification(model)
  assertNoSecrets(development, 'development markdown')
  assertNoSecrets(verification, 'verification markdown')
  mkdirSync(path.dirname(opts.developmentMd), { recursive: true })
  mkdirSync(path.dirname(opts.verificationMd), { recursive: true })
  writeFileSync(opts.developmentMd, development, 'utf8')
  writeFileSync(opts.verificationMd, verification, 'utf8')
  console.log(`Wrote ${relativePath(opts.developmentMd)}`)
  console.log(`Wrote ${relativePath(opts.verificationMd)}`)
}

try {
  const opts = parseArgs(process.argv.slice(2))
  const model = buildModel(opts)
  validateReleaseReady(model, opts.requireReleaseReady)
  writeOutputs(opts, model)
} catch (error) {
  console.error(`[dingtalk-p4-final-docs] ERROR: ${redactString(error instanceof Error ? error.message : String(error))}`)
  process.exit(1)
}
