#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const VALID_STATUSES = new Set(['pass', 'fail', 'skipped', 'pending'])
const REQUIRED_CHECK_IDS = new Set([
  'create-table-form',
  'bind-two-dingtalk-groups',
  'set-form-dingtalk-granted',
  'send-group-message-form-link',
  'authorized-user-submit',
  'unauthorized-user-denied',
  'delivery-history-group-person',
  'no-email-user-create-bind',
])
const MANUAL_SOURCE_BY_CHECK_ID = new Map([
  ['send-group-message-form-link', 'manual-client'],
  ['authorized-user-submit', 'manual-client'],
  ['unauthorized-user-denied', 'manual-client'],
  ['no-email-user-create-bind', 'manual-admin'],
])
const STATUS_SCRIPT_ENV = 'DINGTALK_P4_EVIDENCE_RECORD_STATUS_SCRIPT'
const FINALIZE_SCRIPT_ENV = 'DINGTALK_P4_EVIDENCE_RECORD_FINALIZE_SCRIPT'
const FINAL_CLOSEOUT_SCRIPT_ENV = 'DINGTALK_P4_EVIDENCE_RECORD_FINAL_CLOSEOUT_SCRIPT'
const SECRET_PATTERNS = [
  {
    name: 'dingtalk_robot_webhook',
    regex: /https:\/\/oapi\.dingtalk\.com\/robot\/send\?[^\s"'`<>]*access_token=(?!<redacted>|\$|%24|\(\?)[^\s&"'`<>]{8,}/i,
  },
  {
    name: 'access_token_param',
    regex: /(?:^|[?&])access_token=(?!<redacted>|\$|%24|replace-me|\(\?)[A-Za-z0-9._~+/=-]{16,}/i,
  },
  {
    name: 'bearer_token',
    regex: /\bBearer\s+(?!<redacted>|\$|\{)[A-Za-z0-9._~+/=-]{20,}/i,
  },
  {
    name: 'dingtalk_sec_secret',
    regex: /\bSEC(?=[A-Za-z0-9+/=-]{12,}\b)(?=[A-Za-z0-9+/=-]*\d)[A-Za-z0-9+/=-]{12,}\b/,
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: 'public_form_token',
    regex: /\bpublicToken=(?!<redacted>|\$)[A-Za-z0-9._~+/=-]{12,}/i,
  },
  {
    name: 'client_secret',
    regex: /(?:^|[\s"'`&?])(?:client_secret|DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET)=(?!<redacted>|\$|\{)[^\s&"'`<>]{8,}/i,
  },
]

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-p4-evidence-record.mjs [options]

Updates one check inside a DingTalk P4 smoke evidence.json file. This is a
local helper for recording manual remote-smoke proof without hand-editing JSON.
With --session-dir, it also refreshes smoke-status.json / smoke-status.md /
smoke-todo.md automatically after a successful write. It does not call
DingTalk or staging.

Options:
  --session-dir <dir>        Session directory; defaults evidence to <dir>/workspace/evidence.json
  --evidence <file>          Evidence JSON path
  --check-id <id>            Required check ID to update
  --status <status>          pass, fail, skipped, or pending
  --source <source>          Evidence source, e.g. manual-client or manual-admin
  --operator <name>          Operator who performed the check
  --performed-at <iso>       ISO timestamp; defaults to now for pass checks
  --summary <text>           Human-readable result summary
  --notes <text>             Optional notes
  --artifact <path>          Relative artifact path; repeatable
  --submit-blocked           Set evidence.submitBlocked=true for unauthorized-user-denied
  --record-insert-delta <n>  Set evidence.recordInsertDelta
  --before-record-count <n>  Set evidence.beforeRecordCount
  --after-record-count <n>   Set evidence.afterRecordCount
  --blocked-reason <text>    Set evidence.blockedReason
  --admin-email-was-blank    Set evidence.adminEvidence.emailWasBlank=true for no-email-user-create-bind
  --admin-created-local-user-id <id>
                             Set evidence.adminEvidence.createdLocalUserId
  --admin-bound-dingtalk-external-id <id>
                             Set evidence.adminEvidence.boundDingTalkExternalId
  --admin-account-linked-after-refresh
                             Set evidence.adminEvidence.accountLinkedAfterRefresh=true
  --no-refresh-status        Skip automatic smoke-status refresh after write
  --finalize-when-ready      After refresh, auto-run --finalize when smoke status is ready
  --closeout-when-ready      After refresh, auto-run final closeout when smoke status is ready
  --closeout-packet-output-dir <dir>
                             Packet dir forwarded to final closeout
  --closeout-docs-output-dir <dir>
                             Docs dir forwarded to final closeout
  --closeout-date <yyyymmdd> Date suffix forwarded to final closeout docs
  --closeout-skip-docs       Forward --skip-docs to final closeout
  --allow-external-artifact-refs
                             Forward to auto finalize/final closeout strict compile
  --dry-run                  Validate and print the updated check without writing
  --help                     Show this help

Example:
  node scripts/ops/dingtalk-p4-evidence-record.mjs \\
    --session-dir output/dingtalk-p4-remote-smoke-session/142-session \\
    --check-id authorized-user-submit \\
    --status pass \\
    --source manual-client \\
    --operator qa \\
    --summary "Allowed DingTalk user opened the group link and submitted." \\
    --artifact artifacts/authorized-user-submit/authorized-submit.png
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
    sessionDir: '',
    evidence: '',
    checkId: '',
    status: '',
    source: '',
    operator: '',
    performedAt: '',
    summary: '',
    notes: '',
    artifacts: [],
    submitBlocked: false,
    recordInsertDelta: null,
    beforeRecordCount: null,
    afterRecordCount: null,
    blockedReason: '',
    adminEmailWasBlank: null,
    adminCreatedLocalUserId: '',
    adminBoundDingTalkExternalId: '',
    adminAccountLinkedAfterRefresh: null,
    noRefreshStatus: false,
    finalizeWhenReady: false,
    closeoutWhenReady: false,
    closeoutPacketOutputDir: '',
    closeoutDocsOutputDir: '',
    closeoutDate: '',
    closeoutSkipDocs: false,
    allowExternalArtifactRefs: false,
    dryRun: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--session-dir':
        opts.sessionDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--evidence':
        opts.evidence = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--check-id':
        opts.checkId = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--status':
        opts.status = readRequiredValue(argv, i, arg).trim().toLowerCase()
        i += 1
        break
      case '--source':
        opts.source = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--operator':
        opts.operator = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--performed-at':
        opts.performedAt = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--summary':
        opts.summary = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--notes':
        opts.notes = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--artifact':
        opts.artifacts.push(readRequiredValue(argv, i, arg).trim())
        i += 1
        break
      case '--submit-blocked':
        opts.submitBlocked = true
        break
      case '--record-insert-delta':
        opts.recordInsertDelta = readNumberValue(readRequiredValue(argv, i, arg), arg)
        i += 1
        break
      case '--before-record-count':
        opts.beforeRecordCount = readNumberValue(readRequiredValue(argv, i, arg), arg)
        i += 1
        break
      case '--after-record-count':
        opts.afterRecordCount = readNumberValue(readRequiredValue(argv, i, arg), arg)
        i += 1
        break
      case '--blocked-reason':
        opts.blockedReason = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--admin-email-was-blank':
        opts.adminEmailWasBlank = true
        break
      case '--admin-created-local-user-id':
        opts.adminCreatedLocalUserId = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--admin-bound-dingtalk-external-id':
        opts.adminBoundDingTalkExternalId = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--admin-account-linked-after-refresh':
        opts.adminAccountLinkedAfterRefresh = true
        break
      case '--no-refresh-status':
        opts.noRefreshStatus = true
        break
      case '--finalize-when-ready':
        opts.finalizeWhenReady = true
        break
      case '--closeout-when-ready':
        opts.closeoutWhenReady = true
        break
      case '--closeout-packet-output-dir':
        opts.closeoutPacketOutputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--closeout-docs-output-dir':
        opts.closeoutDocsOutputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--closeout-date':
        opts.closeoutDate = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--closeout-skip-docs':
        opts.closeoutSkipDocs = true
        break
      case '--allow-external-artifact-refs':
        opts.allowExternalArtifactRefs = true
        break
      case '--dry-run':
        opts.dryRun = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!opts.evidence && opts.sessionDir) {
    opts.evidence = path.join(opts.sessionDir, 'workspace', 'evidence.json')
  }
  if (!opts.evidence) throw new Error('--evidence or --session-dir is required')
  if (!opts.checkId) throw new Error('--check-id is required')
  if (!REQUIRED_CHECK_IDS.has(opts.checkId)) throw new Error(`unknown DingTalk P4 check id: ${opts.checkId}`)
  if (!opts.status) throw new Error('--status is required')
  if (!VALID_STATUSES.has(opts.status)) throw new Error(`--status must be one of: ${Array.from(VALID_STATUSES).join(', ')}`)
  if (opts.finalizeWhenReady && !opts.sessionDir) {
    throw new Error('--finalize-when-ready requires --session-dir')
  }
  if (opts.finalizeWhenReady && opts.noRefreshStatus) {
    throw new Error('--finalize-when-ready cannot be combined with --no-refresh-status')
  }
  if (opts.finalizeWhenReady && opts.dryRun) {
    throw new Error('--finalize-when-ready cannot be combined with --dry-run')
  }
  if (opts.closeoutWhenReady && !opts.sessionDir) {
    throw new Error('--closeout-when-ready requires --session-dir')
  }
  if (opts.closeoutWhenReady && opts.finalizeWhenReady) {
    throw new Error('--closeout-when-ready cannot be combined with --finalize-when-ready')
  }
  if (opts.closeoutWhenReady && opts.noRefreshStatus) {
    throw new Error('--closeout-when-ready cannot be combined with --no-refresh-status')
  }
  if (opts.closeoutWhenReady && opts.dryRun) {
    throw new Error('--closeout-when-ready cannot be combined with --dry-run')
  }
  if (opts.closeoutDate && !/^\d{8}$/.test(opts.closeoutDate)) {
    throw new Error('--closeout-date must be formatted as yyyymmdd')
  }
  return opts
}

function readNumberValue(value, flag) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a finite number`)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`)
  return parsed
}

function relativePath(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function redactString(value) {
  return String(value ?? '')
    .replace(/(access_token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/(publicToken=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/((?:client_secret|DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET)=)[^&\s)"'`<>]+/gi, '$1<redacted>')
    .replace(/([?&](?:sign|timestamp)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '<jwt:redacted>')
}

function compactText(value) {
  const text = redactString(value ?? '').trim()
  if (!text) return ''
  return text.length > 500 ? `${text.slice(0, 497)}...` : text
}

function assertNoSecretText(value, label) {
  const text = String(value ?? '')
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(text)) {
      throw new Error(`${label} contains secret-like value: ${pattern.name}`)
    }
  }
}

function readEvidence(file) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`evidence file does not exist: ${relativePath(file)}`)
  }
  try {
    const evidence = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(evidence?.checks)) throw new Error('evidence.checks must be an array')
    return evidence
  } catch (error) {
    throw new Error(`failed to parse evidence JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readJsonIfExists(file) {
  if (!existsSync(file) || !statSync(file).isFile()) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

function isDateLike(value) {
  if (!value) return false
  return Number.isFinite(Date.parse(value))
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeArtifactRef(value) {
  const normalized = value.replaceAll('\\', '/').trim()
  if (!normalized) throw new Error('artifact ref cannot be empty')
  if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized) || normalized.startsWith('//')) {
    throw new Error(`artifact ref must be relative: ${normalized}`)
  }
  const segments = normalized.split('/').filter(Boolean)
  const normalizedPosix = path.posix.normalize(normalized)
  if (segments.includes('..') || normalizedPosix === '..' || normalizedPosix.startsWith('../')) {
    throw new Error(`artifact ref cannot traverse outside evidence directory: ${normalized}`)
  }
  return normalizedPosix
}

function isLikelyText(buffer) {
  return !buffer.includes(0)
}

function validateArtifactRefs(opts) {
  const evidenceDir = path.dirname(opts.evidence)
  const expectedPrefix = `artifacts/${opts.checkId}/`
  const refs = opts.artifacts.map((artifact) => {
    assertNoSecretText(artifact, '--artifact')
    const normalized = normalizeArtifactRef(artifact)
    if (!normalized.startsWith(expectedPrefix)) {
      throw new Error(`artifact ref for ${opts.checkId} must live under ${expectedPrefix}`)
    }
    const fullPath = path.resolve(evidenceDir, normalized)
    const evidenceRoot = path.resolve(evidenceDir)
    if (fullPath !== evidenceRoot && !fullPath.startsWith(`${evidenceRoot}${path.sep}`)) {
      throw new Error(`artifact ref cannot escape evidence directory: ${normalized}`)
    }
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      throw new Error(`artifact file does not exist: ${normalized}`)
    }
    const stats = statSync(fullPath)
    if (stats.size <= 0) throw new Error(`artifact file is empty: ${normalized}`)
    if (stats.size <= 2 * 1024 * 1024) {
      const buffer = readFileSync(fullPath)
      if (isLikelyText(buffer)) assertNoSecretText(buffer.toString('utf8'), `artifact ${normalized}`)
    }
    return normalized
  })
  return Array.from(new Set(refs))
}

function validateManualPass(opts) {
  const requiredSource = MANUAL_SOURCE_BY_CHECK_ID.get(opts.checkId)
  if (!requiredSource || opts.status !== 'pass') return
  if (opts.source !== requiredSource) {
    throw new Error(`${opts.checkId} requires --source ${requiredSource} when status is pass`)
  }
  if (!opts.operator) throw new Error(`${opts.checkId} pass evidence requires --operator`)
  if (!opts.summary && !opts.notes) throw new Error(`${opts.checkId} pass evidence requires --summary or --notes`)
  if (opts.artifacts.length === 0) throw new Error(`${opts.checkId} pass evidence requires at least one --artifact`)
  if (!opts.performedAt) opts.performedAt = new Date().toISOString()
  if (!isDateLike(opts.performedAt)) throw new Error('--performed-at must be a valid date')
}

function hasZeroRecordInsertDelta(opts) {
  if (opts.recordInsertDelta !== null) return opts.recordInsertDelta === 0
  return opts.beforeRecordCount !== null && opts.afterRecordCount !== null && opts.beforeRecordCount === opts.afterRecordCount
}

function validateUnauthorizedDeniedPass(opts) {
  if (opts.checkId !== 'unauthorized-user-denied' || opts.status !== 'pass') return
  if (opts.submitBlocked !== true) {
    throw new Error('unauthorized-user-denied pass evidence requires --submit-blocked')
  }
  if (!hasZeroRecordInsertDelta(opts)) {
    throw new Error('unauthorized-user-denied pass evidence requires --record-insert-delta 0 or equal --before-record-count/--after-record-count')
  }
  if (!opts.blockedReason) {
    throw new Error('unauthorized-user-denied pass evidence requires --blocked-reason')
  }
}

function hasNoEmailAdminInputs(opts) {
  return opts.adminEmailWasBlank !== null
    || isNonEmptyString(opts.adminCreatedLocalUserId)
    || isNonEmptyString(opts.adminBoundDingTalkExternalId)
    || opts.adminAccountLinkedAfterRefresh !== null
}

function validateNoEmailAdminPass(opts) {
  if (hasNoEmailAdminInputs(opts) && opts.checkId !== 'no-email-user-create-bind') {
    throw new Error('admin evidence flags can only be used with no-email-user-create-bind')
  }
  if (opts.checkId !== 'no-email-user-create-bind' || opts.status !== 'pass') return
  if (opts.adminEmailWasBlank !== true) {
    throw new Error('no-email-user-create-bind pass evidence requires --admin-email-was-blank')
  }
  if (!isNonEmptyString(opts.adminCreatedLocalUserId)) {
    throw new Error('no-email-user-create-bind pass evidence requires --admin-created-local-user-id')
  }
  if (!isNonEmptyString(opts.adminBoundDingTalkExternalId)) {
    throw new Error('no-email-user-create-bind pass evidence requires --admin-bound-dingtalk-external-id')
  }
  if (opts.adminAccountLinkedAfterRefresh !== true) {
    throw new Error('no-email-user-create-bind pass evidence requires --admin-account-linked-after-refresh')
  }
}

function validateInputs(opts) {
  for (const [label, value] of [
    ['--source', opts.source],
    ['--operator', opts.operator],
    ['--summary', opts.summary],
    ['--notes', opts.notes],
    ['--blocked-reason', opts.blockedReason],
    ['--admin-created-local-user-id', opts.adminCreatedLocalUserId],
    ['--admin-bound-dingtalk-external-id', opts.adminBoundDingTalkExternalId],
  ]) {
    assertNoSecretText(value, label)
  }
  if (opts.performedAt && !isDateLike(opts.performedAt)) {
    throw new Error('--performed-at must be a valid date')
  }
  validateManualPass(opts)
  validateUnauthorizedDeniedPass(opts)
  validateNoEmailAdminPass(opts)
}

function findCheck(evidence, checkId) {
  const index = evidence.checks.findIndex((check) => check?.id === checkId)
  if (index === -1) throw new Error(`check id not found in evidence: ${checkId}`)
  return { index, check: evidence.checks[index] }
}

function buildEvidencePayload(opts, artifactRefs) {
  const payload = {}
  if (opts.source) payload.source = opts.source
  if (opts.operator) payload.operator = opts.operator
  if (opts.performedAt) payload.performedAt = opts.performedAt
  if (opts.summary) payload.summary = opts.summary
  if (opts.notes) payload.notes = opts.notes
  if (artifactRefs.length > 0) payload.artifacts = artifactRefs
  if (opts.submitBlocked) payload.submitBlocked = true
  if (opts.recordInsertDelta !== null) payload.recordInsertDelta = opts.recordInsertDelta
  if (opts.beforeRecordCount !== null) payload.beforeRecordCount = opts.beforeRecordCount
  if (opts.afterRecordCount !== null) payload.afterRecordCount = opts.afterRecordCount
  if (opts.blockedReason) payload.blockedReason = opts.blockedReason
  if (opts.checkId === 'no-email-user-create-bind' && opts.status === 'pass') {
    payload.adminEvidence = {
      emailWasBlank: true,
      createdLocalUserId: opts.adminCreatedLocalUserId,
      boundDingTalkExternalId: opts.adminBoundDingTalkExternalId,
      accountLinkedAfterRefresh: true,
      temporaryPasswordRedacted: true,
    }
  }
  return payload
}

function mergeEvidencePayload(previousEvidence, payload) {
  const next = {
    ...previousEvidence,
    ...payload,
  }
  if (previousEvidence.adminEvidence || payload.adminEvidence) {
    next.adminEvidence = {
      ...(previousEvidence.adminEvidence && typeof previousEvidence.adminEvidence === 'object' && !Array.isArray(previousEvidence.adminEvidence)
        ? previousEvidence.adminEvidence
        : {}),
      ...(payload.adminEvidence ?? {}),
    }
  }
  return next
}

function runNodeTool(script, args) {
  const resolvedScript = path.resolve(process.cwd(), script)
  const result = spawnSync(process.execPath, [resolvedScript, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: redactString(result.stdout ?? ''),
    stderr: redactString(result.stderr || result.error?.message || ''),
  }
}

function smokeStatusPaths(sessionDir) {
  return {
    smokeStatusJson: path.join(sessionDir, 'smoke-status.json'),
    smokeStatusMd: path.join(sessionDir, 'smoke-status.md'),
    smokeTodoMd: path.join(sessionDir, 'smoke-todo.md'),
  }
}

function sessionSummaryPath(sessionDir) {
  return path.join(sessionDir, 'session-summary.json')
}

function statusRefreshCommand(sessionDir) {
  return [
    'node scripts/ops/dingtalk-p4-smoke-status.mjs',
    '--session-dir',
    relativePath(sessionDir),
  ].join(' ')
}

function finalizeCommand(sessionDir, allowExternalArtifactRefs = false) {
  return [
    'node scripts/ops/dingtalk-p4-smoke-session.mjs',
    '--finalize',
    relativePath(sessionDir),
    ...(allowExternalArtifactRefs ? ['--allow-external-artifact-refs'] : []),
  ].join(' ')
}

function handoffCommand(sessionDir) {
  return [
    'node scripts/ops/dingtalk-p4-final-handoff.mjs',
    '--session-dir',
    relativePath(sessionDir),
  ].join(' ')
}

function finalCloseoutArgs(opts) {
  return [
    '--session-dir',
    opts.sessionDir,
    ...(opts.closeoutPacketOutputDir ? ['--packet-output-dir', opts.closeoutPacketOutputDir] : []),
    ...(opts.closeoutDocsOutputDir ? ['--docs-output-dir', opts.closeoutDocsOutputDir] : []),
    ...(opts.closeoutDate ? ['--date', opts.closeoutDate] : []),
    ...(opts.closeoutSkipDocs ? ['--skip-docs'] : []),
    ...(opts.allowExternalArtifactRefs ? ['--allow-external-artifact-refs'] : []),
  ]
}

function finalCloseoutCommand(opts) {
  return [
    'node scripts/ops/dingtalk-p4-final-closeout.mjs',
    ...finalCloseoutArgs(opts),
  ].map((part) => part.startsWith(process.cwd()) ? relativePath(part) : part).join(' ')
}

function refreshSmokeStatus(sessionDir) {
  const script = process.env[STATUS_SCRIPT_ENV] || 'scripts/ops/dingtalk-p4-smoke-status.mjs'
  const result = runNodeTool(script, ['--session-dir', sessionDir])
  const paths = smokeStatusPaths(sessionDir)
  return {
    ...paths,
    ...result,
    summary: readJsonIfExists(paths.smokeStatusJson),
  }
}

function shouldFinalizeWhenReady(statusSummary) {
  if (!statusSummary || typeof statusSummary !== 'object') return false
  return statusSummary.overallStatus === 'finalize_pending'
    && (statusSummary.remoteSmokeTodos?.remaining ?? 1) === 0
    && (statusSummary.totals?.gaps ?? 1) === 0
}

function runFinalizeSession(opts) {
  const script = process.env[FINALIZE_SCRIPT_ENV] || 'scripts/ops/dingtalk-p4-smoke-session.mjs'
  const result = runNodeTool(script, [
    '--finalize',
    opts.sessionDir,
    ...(opts.allowExternalArtifactRefs ? ['--allow-external-artifact-refs'] : []),
  ])
  const summaryPath = sessionSummaryPath(opts.sessionDir)
  return {
    ...result,
    sessionSummaryJson: summaryPath,
    summary: readJsonIfExists(summaryPath),
  }
}

function runFinalCloseout(opts) {
  const script = process.env[FINAL_CLOSEOUT_SCRIPT_ENV] || 'scripts/ops/dingtalk-p4-final-closeout.mjs'
  return runNodeTool(script, finalCloseoutArgs(opts))
}

function refreshAfterWrite(opts) {
  if (!opts.sessionDir || opts.noRefreshStatus) return

  const statusRefresh = refreshSmokeStatus(opts.sessionDir)
  if (statusRefresh.exitCode !== 0) {
    throw new Error(`evidence updated but smoke status refresh failed; rerun ${statusRefreshCommand(opts.sessionDir)} (${compactText(statusRefresh.stderr || statusRefresh.stdout) || 'unknown error'})`)
  }

  console.log(`Refreshed ${relativePath(statusRefresh.smokeStatusJson)}`)
  if (statusRefresh.summary?.overallStatus) {
    console.log(`Smoke overall status: ${statusRefresh.summary.overallStatus}`)
  }
  if (statusRefresh.summary?.remoteSmokePhase) {
    console.log(`Remote smoke phase: ${statusRefresh.summary.remoteSmokePhase}`)
  }
  if (statusRefresh.summary?.remoteSmokeTodos) {
    const todos = statusRefresh.summary.remoteSmokeTodos
    console.log(`Smoke TODO progress: ${todos.completed}/${todos.total} complete, ${todos.remaining} remaining`)
  }

  if (!opts.finalizeWhenReady && !opts.closeoutWhenReady) return
  if (!shouldFinalizeWhenReady(statusRefresh.summary)) {
    const action = opts.closeoutWhenReady ? 'closeout' : 'finalize'
    console.log(`Auto ${action} not attempted; current smoke status is ${statusRefresh.summary?.overallStatus ?? 'unknown'}`)
    return
  }

  if (opts.closeoutWhenReady) {
    const closeout = runFinalCloseout(opts)
    if (closeout.exitCode !== 0) {
      throw new Error(`evidence updated and smoke status refreshed, but auto closeout failed; rerun ${finalCloseoutCommand(opts)} (${compactText(closeout.stderr || closeout.stdout) || 'unknown error'})`)
    }
    console.log(`Final closeout completed: ${finalCloseoutCommand(opts)}`)
    return
  }

  const finalize = runFinalizeSession(opts)
  if (finalize.exitCode !== 0) {
    throw new Error(`evidence updated and smoke status refreshed, but auto finalize failed; rerun ${finalizeCommand(opts.sessionDir, opts.allowExternalArtifactRefs)} (${compactText(finalize.stderr || finalize.stdout) || 'unknown error'})`)
  }

  console.log(`Finalized session in ${relativePath(finalize.sessionSummaryJson)}`)
  if (finalize.summary?.overallStatus === 'pass' && finalize.summary?.finalStrictStatus === 'pass') {
    console.log(`Next handoff command: ${handoffCommand(opts.sessionDir)}`)
  }
}

function updateEvidence(evidence, opts) {
  const { index, check } = findCheck(evidence, opts.checkId)
  const artifactRefs = opts.status === 'pass' ? validateArtifactRefs(opts) : []
  const previousEvidence = check.evidence && typeof check.evidence === 'object' && !Array.isArray(check.evidence)
    ? check.evidence
    : {}
  const updatedCheck = {
    ...check,
    status: opts.status,
    evidence: mergeEvidencePayload(previousEvidence, buildEvidencePayload(opts, artifactRefs)),
  }
  evidence.checks[index] = updatedCheck
  evidence.updatedAt = new Date().toISOString()
  evidence.updatedBy = 'dingtalk-p4-evidence-record'
  return updatedCheck
}

try {
  const opts = parseArgs(process.argv.slice(2))
  validateInputs(opts)
  const evidence = readEvidence(opts.evidence)
  const updatedCheck = updateEvidence(evidence, opts)

  if (opts.dryRun) {
    console.log(JSON.stringify(updatedCheck, null, 2))
  } else {
    mkdirSync(path.dirname(opts.evidence), { recursive: true })
    writeFileSync(opts.evidence, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    console.log(`Updated ${updatedCheck.id} in ${relativePath(opts.evidence)}`)
    refreshAfterWrite(opts)
  }
} catch (error) {
  console.error(`[dingtalk-p4-evidence-record] ERROR: ${redactString(error instanceof Error ? error.message : String(error))}`)
  process.exit(1)
}
