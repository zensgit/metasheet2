#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_OUTPUT_ROOT = 'output/dingtalk-public-form-mobile-signoff'
const VALID_STATUSES = new Set(['pass', 'fail', 'skipped', 'pending'])
const VALID_SOURCES = new Set(['manual-client', 'server-observation', 'operator-note'])
const CHECKS = [
  {
    id: 'public-anonymous-submit',
    label: 'Public anonymous submit succeeds',
    scenario: 'Fully public anonymous form',
    kind: 'allow-submit',
    commandHint: '--record-insert-delta 1',
  },
  {
    id: 'dingtalk-unbound-rejected',
    label: 'DingTalk login required form rejects an unbound user',
    scenario: 'Login-required form, local user is not DingTalk-bound',
    kind: 'deny-submit',
    commandHint: '--submit-blocked --record-insert-delta 0 --blocked-reason "DingTalk binding required"',
  },
  {
    id: 'dingtalk-bound-submit',
    label: 'DingTalk login required form accepts a bound user',
    scenario: 'Login-required form, local user is DingTalk-bound',
    kind: 'allow-submit',
    commandHint: '--record-insert-delta 1',
  },
  {
    id: 'selected-unbound-rejected',
    label: 'Selected-user form rejects a selected but unbound user',
    scenario: 'Selected users or groups, selected local user is not DingTalk-bound',
    kind: 'deny-submit',
    commandHint: '--submit-blocked --record-insert-delta 0 --blocked-reason "DingTalk binding required"',
  },
  {
    id: 'selected-bound-submit',
    label: 'Selected-user form accepts a selected bound user',
    scenario: 'Selected users or groups, selected local user is DingTalk-bound',
    kind: 'allow-submit',
    commandHint: '--record-insert-delta 1',
  },
  {
    id: 'selected-unlisted-bound-rejected',
    label: 'Selected-user form rejects a bound user outside the allowlist',
    scenario: 'Selected users or groups, DingTalk-bound local user is not selected',
    kind: 'deny-submit',
    commandHint: '--submit-blocked --record-insert-delta 0 --blocked-reason "Not in selected user or group allowlist"',
  },
  {
    id: 'granted-bound-without-grant-rejected',
    label: 'DingTalk-authorized form rejects a bound user without an enabled grant',
    scenario: 'DingTalk-authorized form, local user is bound but grant is disabled or missing',
    kind: 'deny-submit',
    commandHint: '--submit-blocked --record-insert-delta 0 --blocked-reason "DingTalk grant required"',
  },
  {
    id: 'granted-bound-with-grant-submit',
    label: 'DingTalk-authorized form accepts a bound user with an enabled grant',
    scenario: 'DingTalk-authorized form, local user is bound and grant is enabled',
    kind: 'allow-submit',
    commandHint: '--record-insert-delta 1',
  },
  {
    id: 'password-change-bypass-observed',
    label: 'DingTalk public form is not blocked by local password-change requirement',
    scenario: 'DingTalk-bound public-form visitor still has local must_change_password=true',
    kind: 'render',
    commandHint: '--form-rendered --no-password-change-required-shown',
  },
]
const CHECK_BY_ID = new Map(CHECKS.map((check) => [check.id, check]))
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
  console.log(`Usage: node scripts/ops/dingtalk-public-form-mobile-signoff.mjs [options]

Builds and validates a redaction-safe mobile signoff packet for DingTalk public
form access modes. It does not call DingTalk or staging.

Options:
  --init-kit <dir>       Write mobile-signoff.json, checklist, and artifact folders
  --record <file>        Update one check in an existing mobile-signoff.json
  --input <file>         Input mobile-signoff.json to compile
  --output-dir <dir>     Output dir, default ${DEFAULT_OUTPUT_ROOT}/<run-id>
  --strict               Exit non-zero unless every required check passes
  --help                 Show this help

Record mode options:
  --check-id <id>        Required with --record
  --status <status>      Required with --record: pass, fail, skipped, pending
  --source <source>      manual-client, server-observation, or operator-note
  --operator <name>      Operator name or role, not a token or password
  --performed-at <iso>   Defaults to now for pass/fail if not already present
  --summary <text>       Short evidence summary
  --notes <text>         Extra evidence notes
  --artifact <path>      Relative artifact path, repeatable
  --before-record-count <n>
  --after-record-count <n>
  --record-insert-delta <n>
  --submit-blocked
  --blocked-reason <text>
  --form-rendered
  --password-change-required-shown
  --no-password-change-required-shown
  --dry-run              Validate and print the updated check without writing

Evidence can be screenshot-free. For allowed submits, record a positive
recordInsertDelta or before/after record counts. For blocked submits, record
submitBlocked=true plus zero delta or equal before/after counts. Screenshots or
recordings may be attached as optional local artifacts.
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
    initKit: '',
    record: '',
    input: '',
    outputDir: '',
    strict: false,
    checkId: '',
    status: '',
    source: '',
    operator: '',
    performedAt: '',
    summary: '',
    notes: '',
    artifacts: [],
    beforeRecordCount: null,
    afterRecordCount: null,
    recordInsertDelta: null,
    submitBlocked: null,
    blockedReason: '',
    formRendered: null,
    passwordChangeRequiredShown: null,
    dryRun: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--init-kit':
        opts.initKit = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--record':
        opts.record = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--input':
        opts.input = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--strict':
        opts.strict = true
        break
      case '--check-id':
        opts.checkId = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--status':
        opts.status = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--source':
        opts.source = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--operator':
        opts.operator = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--performed-at':
        opts.performedAt = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--summary':
        opts.summary = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--notes':
        opts.notes = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--artifact':
        opts.artifacts.push(readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--before-record-count':
        opts.beforeRecordCount = parseNonNegativeInteger(readRequiredValue(argv, i, arg), arg)
        i += 1
        break
      case '--after-record-count':
        opts.afterRecordCount = parseNonNegativeInteger(readRequiredValue(argv, i, arg), arg)
        i += 1
        break
      case '--record-insert-delta':
        opts.recordInsertDelta = parseNonNegativeInteger(readRequiredValue(argv, i, arg), arg)
        i += 1
        break
      case '--submit-blocked':
        opts.submitBlocked = true
        break
      case '--blocked-reason':
        opts.blockedReason = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--form-rendered':
        opts.formRendered = true
        break
      case '--password-change-required-shown':
        opts.passwordChangeRequiredShown = true
        break
      case '--no-password-change-required-shown':
        opts.passwordChangeRequiredShown = false
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

  const modeCount = Number(Boolean(opts.initKit)) + Number(Boolean(opts.input)) + Number(Boolean(opts.record))
  if (modeCount > 1) {
    throw new Error('--init-kit, --record, and --input are mutually exclusive')
  }
  if (modeCount === 0) {
    throw new Error('one of --init-kit, --record, or --input is required')
  }
  if (opts.record) {
    if (!opts.checkId) {
      throw new Error('--record requires --check-id')
    }
    if (!CHECK_BY_ID.has(opts.checkId)) {
      throw new Error(`unknown --check-id: ${opts.checkId}`)
    }
    if (!opts.status) {
      throw new Error('--record requires --status')
    }
    if (!VALID_STATUSES.has(opts.status)) {
      throw new Error(`invalid --status: ${opts.status}`)
    }
    if (opts.source && !VALID_SOURCES.has(opts.source)) {
      throw new Error(`invalid --source: ${opts.source}`)
    }
  }
  return opts
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative integer`)
  }
  return parsed
}

function nowIso() {
  return new Date().toISOString()
}

function makeRunId() {
  return `dingtalk-mobile-${nowIso().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}`
}

function makeTemplateCheck(check) {
  return {
    id: check.id,
    status: 'pending',
    evidence: {
      source: '',
      operator: '',
      performedAt: '',
      summary: '',
      notes: '',
      artifacts: [],
      beforeRecordCount: null,
      afterRecordCount: null,
      recordInsertDelta: null,
      submitBlocked: null,
      blockedReason: '',
      formRendered: null,
      passwordChangeRequiredShown: null,
    },
  }
}

function makeTemplate() {
  return {
    tool: 'dingtalk-public-form-mobile-signoff',
    runId: makeRunId(),
    createdAt: nowIso(),
    environment: '',
    commit: '',
    checks: CHECKS.map(makeTemplateCheck),
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function renderChecklist() {
  const rows = CHECKS.map((check) => (
    `| \`${check.id}\` | ${check.label} | ${check.scenario} | \`${check.commandHint}\` |`
  )).join('\n')

  return `# DingTalk Public Form Mobile Signoff Checklist

This kit records the final real DingTalk mobile checks without storing secrets.
Screenshots are optional. Service-side record counts and visible blocked reasons
are enough when they are captured in \`mobile-signoff.json\`.

Do not paste webhook URLs, signing secrets, bearer tokens, JWTs, public form
tokens, or temporary passwords into this kit.

| Check ID | Expected result | Scenario | Screenshot-free evidence hint |
| --- | --- | --- | --- |
${rows}

Compile after filling \`mobile-signoff.json\`:

\`\`\`bash
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs \\
  --input mobile-signoff.json \\
  --output-dir compiled \\
  --strict
\`\`\`

Record one check without hand-editing the JSON:

\`\`\`bash
node scripts/ops/dingtalk-public-form-mobile-signoff.mjs \\
  --record mobile-signoff.json \\
  --check-id public-anonymous-submit \\
  --status pass \\
  --source server-observation \\
  --operator qa \\
  --summary "Anonymous public form inserted one record." \\
  --record-insert-delta 1
\`\`\`
`
}

function initKit(outputDir) {
  mkdirSync(outputDir, { recursive: true })
  const artifactsDir = path.join(outputDir, 'artifacts')
  for (const check of CHECKS) {
    mkdirSync(path.join(artifactsDir, check.id), { recursive: true })
  }
  writeJson(path.join(outputDir, 'mobile-signoff.json'), makeTemplate())
  writeFileSync(path.join(outputDir, 'mobile-signoff-checklist.md'), renderChecklist(), 'utf8')
  console.log(`[dingtalk-public-form-mobile-signoff] wrote kit: ${outputDir}`)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function hasPositiveInsert(evidence) {
  const delta = numberOrNull(evidence.recordInsertDelta)
  if (delta !== null) return delta > 0
  const before = numberOrNull(evidence.beforeRecordCount)
  const after = numberOrNull(evidence.afterRecordCount)
  return before !== null && after !== null && after > before
}

function hasZeroInsert(evidence) {
  const delta = numberOrNull(evidence.recordInsertDelta)
  if (delta !== null) return delta === 0
  const before = numberOrNull(evidence.beforeRecordCount)
  const after = numberOrNull(evidence.afterRecordCount)
  return before !== null && after !== null && after === before
}

function validateArtifactRef(inputDir, checkId, ref, errors) {
  if (typeof ref !== 'string' || !ref.trim()) {
    errors.push(`${checkId}: artifact refs must be non-empty strings`)
    return
  }
  if (path.isAbsolute(ref) || ref.includes('\0')) {
    errors.push(`${checkId}: artifact must be a relative path`)
    return
  }
  const normalized = path.normalize(ref)
  if (normalized.startsWith('..') || normalized.includes(`${path.sep}..${path.sep}`)) {
    errors.push(`${checkId}: artifact must stay inside the signoff kit`)
    return
  }
  const artifactPath = path.join(inputDir, normalized)
  if (!existsSync(artifactPath)) {
    errors.push(`${checkId}: artifact does not exist: ${ref}`)
    return
  }
  const stat = statSync(artifactPath)
  if (!stat.isFile() || stat.size === 0) {
    errors.push(`${checkId}: artifact must be a non-empty file: ${ref}`)
    return
  }
  if (stat.size <= 2 * 1024 * 1024 && /\.(?:txt|md|json|log|csv)$/i.test(ref)) {
    scanSecrets(readFileSync(artifactPath, 'utf8'), `${checkId}: artifact ${ref}`, errors)
  }
}

function scanSecrets(value, label, errors) {
  if (typeof value !== 'string' || value.length === 0) return
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(value)) {
      errors.push(`${label} contains secret-like value: ${pattern.name}`)
    }
  }
}

function scanObjectStrings(value, label, errors) {
  if (typeof value === 'string') {
    scanSecrets(value, label, errors)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanObjectStrings(item, `${label}[${index}]`, errors))
    return
  }
  if (isObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      scanObjectStrings(nested, `${label}.${key}`, errors)
    }
  }
}

function validatePassCheck(inputDir, check, entry, errors) {
  const evidence = isObject(entry.evidence) ? entry.evidence : {}
  const summary = typeof evidence.summary === 'string' ? evidence.summary.trim() : ''
  const notes = typeof evidence.notes === 'string' ? evidence.notes.trim() : ''
  const source = typeof evidence.source === 'string' ? evidence.source.trim() : ''
  const artifacts = Array.isArray(evidence.artifacts) ? evidence.artifacts : []

  if (!source || !VALID_SOURCES.has(source)) {
    errors.push(`${check.id}: pass evidence requires source ${Array.from(VALID_SOURCES).join(', ')}`)
  }
  if (!summary && !notes) {
    errors.push(`${check.id}: pass evidence requires summary or notes`)
  }
  for (const artifact of artifacts) {
    validateArtifactRef(inputDir, check.id, artifact, errors)
  }

  if (check.kind === 'allow-submit' && !hasPositiveInsert(evidence)) {
    errors.push(`${check.id}: allowed submit requires a positive recordInsertDelta or increasing before/after record counts`)
  }
  if (check.kind === 'deny-submit') {
    if (evidence.submitBlocked !== true) {
      errors.push(`${check.id}: denied submit requires submitBlocked=true`)
    }
    if (!hasZeroInsert(evidence)) {
      errors.push(`${check.id}: denied submit requires recordInsertDelta=0 or equal before/after record counts`)
    }
    if (typeof evidence.blockedReason !== 'string' || !evidence.blockedReason.trim()) {
      errors.push(`${check.id}: denied submit requires blockedReason`)
    }
  }
  if (check.kind === 'render') {
    if (evidence.formRendered !== true) {
      errors.push(`${check.id}: render check requires formRendered=true`)
    }
    if (evidence.passwordChangeRequiredShown !== false) {
      errors.push(`${check.id}: render check requires passwordChangeRequiredShown=false`)
    }
  }
}

function validateRecordedCheck(inputFile, check, entry) {
  const errors = []
  const inputDir = path.dirname(inputFile)
  const evidence = isObject(entry.evidence) ? entry.evidence : {}
  const summary = typeof evidence.summary === 'string' ? evidence.summary.trim() : ''
  const notes = typeof evidence.notes === 'string' ? evidence.notes.trim() : ''

  scanObjectStrings(entry, `record.${check.id}`, errors)

  if (!VALID_STATUSES.has(entry.status)) {
    errors.push(`${check.id}: invalid status ${JSON.stringify(entry.status)}`)
  }
  if (entry.status === 'pass') {
    validatePassCheck(inputDir, check, entry, errors)
  }
  if (entry.status === 'fail' && !summary && !notes) {
    errors.push(`${check.id}: fail evidence requires summary or notes`)
  }
  return errors
}

function validateEvidence(inputFile, evidence, strict) {
  const errors = []
  const warnings = []
  const inputDir = path.dirname(inputFile)
  const entries = Array.isArray(evidence.checks) ? evidence.checks : []
  const entryById = new Map(entries.map((entry) => [entry?.id, entry]))

  scanObjectStrings(evidence, 'evidence', errors)

  for (const check of CHECKS) {
    const entry = entryById.get(check.id)
    if (!entry) {
      errors.push(`missing check: ${check.id}`)
      continue
    }
    if (!VALID_STATUSES.has(entry.status)) {
      errors.push(`${check.id}: invalid status ${JSON.stringify(entry.status)}`)
      continue
    }
    if (entry.status === 'fail') {
      warnings.push(`${check.id}: marked fail`)
    }
    if (strict && entry.status !== 'pass') {
      errors.push(`${check.id}: strict mode requires pass, got ${entry.status}`)
    }
    if (entry.status === 'pass') {
      validatePassCheck(inputDir, check, entry, errors)
    }
  }

  for (const entry of entries) {
    if (!CHECK_BY_ID.has(entry?.id)) {
      warnings.push(`unknown check ignored: ${entry?.id ?? '<missing id>'}`)
    }
  }

  return { errors, warnings }
}

function redactString(value) {
  let redacted = value
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern.regex, `<redacted:${pattern.name}>`)
  }
  return redacted
}

function redactValue(value) {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactValue(nested)]))
  }
  return value
}

function summarize(evidence, validation) {
  const entries = Array.isArray(evidence.checks) ? evidence.checks : []
  const entryById = new Map(entries.map((entry) => [entry?.id, entry]))
  const rows = CHECKS.map((check) => {
    const status = entryById.get(check.id)?.status ?? 'missing'
    return `| \`${check.id}\` | ${check.label} | ${status} | ${check.scenario} |`
  }).join('\n')
  const counts = CHECKS.reduce((acc, check) => {
    const status = entryById.get(check.id)?.status ?? 'missing'
    acc[status] = (acc[status] ?? 0) + 1
    return acc
  }, {})

  return `# DingTalk Public Form Mobile Signoff Summary

- Run ID: \`${evidence.runId || 'unknown'}\`
- Environment: \`${evidence.environment || 'not recorded'}\`
- Commit: \`${evidence.commit || 'not recorded'}\`
- Strict-ready: \`${validation.errors.length === 0 ? 'yes' : 'no'}\`
- Pass: ${counts.pass ?? 0}
- Fail: ${counts.fail ?? 0}
- Pending: ${counts.pending ?? 0}
- Skipped: ${counts.skipped ?? 0}
- Missing: ${counts.missing ?? 0}

| Check ID | Expected result | Status | Scenario |
| --- | --- | --- | --- |
${rows}

## Errors

${validation.errors.length ? validation.errors.map((error) => `- ${error}`).join('\n') : '- None'}

## Warnings

${validation.warnings.length ? validation.warnings.map((warning) => `- ${warning}`).join('\n') : '- None'}
`
}

function compileEvidence(opts) {
  const evidence = readJson(opts.input)
  const validation = validateEvidence(opts.input, evidence, opts.strict)
  const outputDir = opts.outputDir || path.join(process.cwd(), DEFAULT_OUTPUT_ROOT, evidence.runId || makeRunId())
  mkdirSync(outputDir, { recursive: true })

  const summary = {
    tool: 'dingtalk-public-form-mobile-signoff',
    runId: evidence.runId || '',
    generatedAt: nowIso(),
    strict: opts.strict,
    status: validation.errors.length === 0 ? 'pass' : 'fail',
    errors: validation.errors,
    warnings: validation.warnings,
    requiredChecks: CHECKS.map((check) => ({
      id: check.id,
      status: evidence.checks?.find((entry) => entry.id === check.id)?.status ?? 'missing',
      kind: check.kind,
    })),
  }

  writeJson(path.join(outputDir, 'summary.json'), summary)
  writeFileSync(path.join(outputDir, 'summary.md'), summarize(evidence, validation), 'utf8')
  writeJson(path.join(outputDir, 'mobile-signoff.redacted.json'), redactValue(evidence))

  if (validation.errors.length > 0) {
    console.error(`[dingtalk-public-form-mobile-signoff] validation failed: ${validation.errors.length} error(s)`)
    for (const error of validation.errors) {
      console.error(`- ${error}`)
    }
    process.exitCode = 1
    return
  }
  console.log(`[dingtalk-public-form-mobile-signoff] wrote summary: ${path.join(outputDir, 'summary.md')}`)
}

function setEvidenceValue(evidence, key, value) {
  if (value !== '' && value !== null) {
    evidence[key] = value
  }
}

function appendArtifacts(evidence, refs) {
  if (refs.length === 0) return
  const existing = Array.isArray(evidence.artifacts) ? evidence.artifacts : []
  evidence.artifacts = Array.from(new Set([...existing, ...refs]))
}

function recordCheck(opts) {
  const signoff = readJson(opts.record)
  if (!Array.isArray(signoff.checks)) {
    signoff.checks = []
  }

  const check = CHECK_BY_ID.get(opts.checkId)
  let entry = signoff.checks.find((candidate) => candidate?.id === opts.checkId)
  if (!entry) {
    entry = makeTemplateCheck(check)
    signoff.checks.push(entry)
  }
  if (!isObject(entry.evidence)) {
    entry.evidence = {}
  }

  entry.status = opts.status
  const evidence = entry.evidence
  setEvidenceValue(evidence, 'source', opts.source)
  setEvidenceValue(evidence, 'operator', opts.operator)
  setEvidenceValue(evidence, 'summary', opts.summary)
  setEvidenceValue(evidence, 'notes', opts.notes)
  setEvidenceValue(evidence, 'beforeRecordCount', opts.beforeRecordCount)
  setEvidenceValue(evidence, 'afterRecordCount', opts.afterRecordCount)
  setEvidenceValue(evidence, 'recordInsertDelta', opts.recordInsertDelta)
  setEvidenceValue(evidence, 'submitBlocked', opts.submitBlocked)
  setEvidenceValue(evidence, 'blockedReason', opts.blockedReason)
  setEvidenceValue(evidence, 'formRendered', opts.formRendered)
  setEvidenceValue(evidence, 'passwordChangeRequiredShown', opts.passwordChangeRequiredShown)
  appendArtifacts(evidence, opts.artifacts)

  if ((opts.status === 'pass' || opts.status === 'fail') && !evidence.performedAt) {
    evidence.performedAt = opts.performedAt || nowIso()
  } else {
    setEvidenceValue(evidence, 'performedAt', opts.performedAt)
  }

  const errors = validateRecordedCheck(opts.record, check, entry)
  if (errors.length > 0) {
    console.error(`[dingtalk-public-form-mobile-signoff] record rejected: ${errors.length} error(s)`)
    for (const error of errors) {
      console.error(`- ${error}`)
    }
    process.exitCode = 1
    return
  }

  if (opts.dryRun) {
    console.log(JSON.stringify(redactValue(entry), null, 2))
    return
  }

  writeJson(opts.record, signoff)
  console.log(`[dingtalk-public-form-mobile-signoff] recorded ${opts.checkId}: ${opts.status}`)
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.initKit) {
      initKit(opts.initKit)
      return
    }
    if (opts.record) {
      recordCheck(opts)
      return
    }
    compileEvidence(opts)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

main()
