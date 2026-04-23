#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const DEFAULT_OUTPUT_ROOT = 'output/dingtalk-p4-remote-smoke-session'
const DEFAULT_API_BASE = 'http://127.0.0.1:8900'
const MANUAL_CHECK_IDS = new Set([
  'send-group-message-form-link',
  'authorized-user-submit',
  'unauthorized-user-denied',
  'no-email-user-create-bind',
])

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-p4-smoke-session.mjs [options]

Runs a DingTalk P4 smoke session in one operator command:
  1. preflight input/tooling checks
  2. API-only remote smoke workspace bootstrap
  3. non-strict evidence compile for the generated workspace
  4. session-summary.json / session-summary.md with remaining manual checks

This script does not fill real DingTalk-client/admin evidence and does not run
strict compile. After the session succeeds, place manual artifacts in the
generated workspace and run --finalize <session-dir>.

Options:
  --init-env-template <file>       Write a safe editable env template and exit
  --finalize <session-dir>         Run strict compile for an existing session and refresh session summary
  --env-file <file>                Optional KEY=VALUE file to read before env/CLI
  --api-base <url>                 Backend API base, default ${DEFAULT_API_BASE}
  --web-base <url>                 Public app base used by DingTalk message links
  --auth-token <token>             Bearer token for admin/table owner
  --group-a-webhook <url>          DingTalk group A robot webhook
  --group-b-webhook <url>          DingTalk group B robot webhook
  --group-a-secret <secret>        Optional DingTalk group A SEC... secret
  --group-b-secret <secret>        Optional DingTalk group B SEC... secret
  --allowed-user <id>              Local user allowed to fill; repeatable
  --allowed-member-group <id>      Allowed local member group; repeatable
  --person-user <id>               Optional local user for person smoke; repeatable
  --output-dir <dir>               Session output directory, default ${DEFAULT_OUTPUT_ROOT}/<run-id>
  --timeout-ms <ms>                Per-request timeout for child tools, default 15000
  --skip-api                       Skip preflight GET /health only
  --skip-health                    Skip runner GET /health only
  --skip-test-send                 Forward to dingtalk-p4-remote-smoke.mjs
  --skip-automation-test-run       Forward to dingtalk-p4-remote-smoke.mjs
  --allow-external-artifact-refs   Forward to evidence compiler
  --help                           Show this help

Environment fallbacks:
  DINGTALK_P4_API_BASE, API_BASE
  DINGTALK_P4_WEB_BASE, WEB_BASE, PUBLIC_APP_URL
  DINGTALK_P4_AUTH_TOKEN, ADMIN_TOKEN, AUTH_TOKEN
  DINGTALK_P4_GROUP_A_WEBHOOK, DINGTALK_GROUP_A_WEBHOOK
  DINGTALK_P4_GROUP_B_WEBHOOK, DINGTALK_GROUP_B_WEBHOOK
  DINGTALK_P4_GROUP_A_SECRET, DINGTALK_GROUP_A_SECRET
  DINGTALK_P4_GROUP_B_SECRET, DINGTALK_GROUP_B_SECRET
  DINGTALK_P4_ALLOWED_USER_IDS, DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS
  DINGTALK_P4_PERSON_USER_IDS
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return next
}

function parseEnvFile(file) {
  const resolved = path.resolve(process.cwd(), file)
  if (!existsSync(resolved)) {
    throw new Error(`--env-file does not exist: ${file}`)
  }

  const values = {}
  const content = readFileSync(resolved, 'utf8')
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) {
      throw new Error(`invalid env line ${index + 1} in ${file}`)
    }
    const [, key, rawValue] = match
    values[key] = unquoteEnvValue(rawValue.trim())
  }
  return values
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function envValue(source, ...names) {
  for (const name of names) {
    const value = source[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function splitList(value) {
  if (!value) return []
  return Array.from(new Set(
    String(value)
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  ))
}

function appendList(list, value) {
  for (const entry of splitList(value)) {
    if (!list.includes(entry)) list.push(entry)
  }
}

function parseArgs(argv) {
  let envFile = ''
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env-file') {
      envFile = readRequiredValue(argv, i, '--env-file')
      break
    }
  }

  const envFileValues = envFile ? parseEnvFile(envFile) : {}
  const env = { ...envFileValues, ...process.env }
  const opts = {
    initEnvTemplate: null,
    finalizeDir: null,
    envFile,
    apiBase: envValue(env, 'DINGTALK_P4_API_BASE', 'API_BASE') || DEFAULT_API_BASE,
    webBase: envValue(env, 'DINGTALK_P4_WEB_BASE', 'WEB_BASE', 'PUBLIC_APP_URL'),
    authToken: envValue(env, 'DINGTALK_P4_AUTH_TOKEN', 'ADMIN_TOKEN', 'AUTH_TOKEN'),
    groupAWebhook: envValue(env, 'DINGTALK_P4_GROUP_A_WEBHOOK', 'DINGTALK_GROUP_A_WEBHOOK'),
    groupBWebhook: envValue(env, 'DINGTALK_P4_GROUP_B_WEBHOOK', 'DINGTALK_GROUP_B_WEBHOOK'),
    groupASecret: envValue(env, 'DINGTALK_P4_GROUP_A_SECRET', 'DINGTALK_GROUP_A_SECRET'),
    groupBSecret: envValue(env, 'DINGTALK_P4_GROUP_B_SECRET', 'DINGTALK_GROUP_B_SECRET'),
    allowedUserIds: splitList(envValue(env, 'DINGTALK_P4_ALLOWED_USER_IDS', 'DINGTALK_P4_ALLOWED_USER_ID')),
    allowedMemberGroupIds: splitList(envValue(env, 'DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS', 'DINGTALK_P4_ALLOWED_MEMBER_GROUP_ID')),
    personUserIds: splitList(envValue(env, 'DINGTALK_P4_PERSON_USER_IDS', 'DINGTALK_P4_PERSON_USER_ID')),
    outputDir: null,
    timeoutMs: 15_000,
    skipApi: false,
    skipHealth: false,
    skipTestSend: false,
    skipAutomationTestRun: false,
    allowExternalArtifactRefs: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--env-file':
        i += 1
        break
      case '--init-env-template':
        opts.initEnvTemplate = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--finalize':
        opts.finalizeDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--api-base':
        opts.apiBase = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--web-base':
        opts.webBase = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--auth-token':
        opts.authToken = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--group-a-webhook':
        opts.groupAWebhook = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--group-b-webhook':
        opts.groupBWebhook = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--group-a-secret':
        opts.groupASecret = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--group-b-secret':
        opts.groupBSecret = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--allowed-user':
        appendList(opts.allowedUserIds, readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--allowed-member-group':
        appendList(opts.allowedMemberGroupIds, readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--person-user':
        appendList(opts.personUserIds, readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--timeout-ms':
        opts.timeoutMs = Number.parseInt(readRequiredValue(argv, i, arg), 10)
        i += 1
        break
      case '--skip-api':
        opts.skipApi = true
        break
      case '--skip-health':
        opts.skipHealth = true
        break
      case '--skip-test-send':
        opts.skipTestSend = true
        break
      case '--skip-automation-test-run':
        opts.skipAutomationTestRun = true
        break
      case '--allow-external-artifact-refs':
        opts.allowExternalArtifactRefs = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (opts.initEnvTemplate && opts.finalizeDir) {
    throw new Error('--init-env-template and --finalize are mutually exclusive')
  }
  if (opts.finalizeDir && opts.outputDir) {
    throw new Error('--output-dir is not used with --finalize; pass the session directory to --finalize')
  }

  return opts
}

function renderEnvTemplate() {
  return `# DingTalk P4 smoke session env template
# Fill this file locally or on the staging host. Do not commit it.
# Run:
#   node scripts/ops/dingtalk-p4-smoke-session.mjs --env-file <this-file> --output-dir output/dingtalk-p4-remote-smoke-session/<run>

DINGTALK_P4_API_BASE=http://142.171.239.56:8900
DINGTALK_P4_WEB_BASE=http://142.171.239.56:8081

# Admin/table-owner bearer token. Keep private.
DINGTALK_P4_AUTH_TOKEN=

# DingTalk group robot webhooks. Full webhook URLs must stay private.
DINGTALK_P4_GROUP_A_WEBHOOK=
DINGTALK_P4_GROUP_B_WEBHOOK=

# Optional SEC... robot signing secrets.
DINGTALK_P4_GROUP_A_SECRET=
DINGTALK_P4_GROUP_B_SECRET=

# Local user IDs or member group IDs allowed to submit the dingtalk_granted form.
# Use comma-separated values when there are multiple entries.
DINGTALK_P4_ALLOWED_USER_IDS=
DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS=

# Optional local user IDs for direct DingTalk person-message delivery history.
DINGTALK_P4_PERSON_USER_IDS=
`
}

function writeEnvTemplate(file) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, renderEnvTemplate(), 'utf8')
  console.log(`Wrote ${relativePath(file)}`)
}

function makeRunId() {
  return `dingtalk-p4-session-${new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}`
}

function redactString(value) {
  return String(value)
    .replace(/(access_token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/(publicToken=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&](?:sign|timestamp)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/((?:client_secret|DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET)=)[^\s&]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '<jwt:redacted>')
}

function compactText(value) {
  const redacted = redactString(value ?? '').trim()
  if (!redacted) return ''
  return redacted.length > 2000 ? `${redacted.slice(0, 1997)}...` : redacted
}

function relativePath(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function buildChildEnv(opts) {
  return {
    ...process.env,
    DINGTALK_P4_API_BASE: opts.apiBase,
    DINGTALK_P4_WEB_BASE: opts.webBase,
    DINGTALK_P4_AUTH_TOKEN: opts.authToken,
    DINGTALK_P4_GROUP_A_WEBHOOK: opts.groupAWebhook,
    DINGTALK_P4_GROUP_B_WEBHOOK: opts.groupBWebhook,
    DINGTALK_P4_GROUP_A_SECRET: opts.groupASecret,
    DINGTALK_P4_GROUP_B_SECRET: opts.groupBSecret,
    DINGTALK_P4_ALLOWED_USER_IDS: opts.allowedUserIds.join(','),
    DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS: opts.allowedMemberGroupIds.join(','),
    DINGTALK_P4_PERSON_USER_IDS: opts.personUserIds.join(','),
  }
}

function runNodeStep(id, label, script, args, outputDir, env) {
  mkdirSync(outputDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  })
  const finishedAt = new Date().toISOString()
  return {
    id,
    label,
    status: result.status === 0 ? 'pass' : 'fail',
    exitCode: result.status ?? 1,
    outputDir: relativePath(outputDir),
    startedAt,
    finishedAt,
    stdout: compactText(result.stdout),
    stderr: compactText(result.stderr),
  }
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

function extractPendingManualChecks(evidencePath) {
  const evidence = readJsonIfExists(evidencePath)
  if (!Array.isArray(evidence?.checks)) return []
  return evidence.checks
    .filter((check) => check && check.status !== 'pass')
    .map((check) => ({
      id: check.id,
      status: check.status ?? 'pending',
      manual: MANUAL_CHECK_IDS.has(check.id),
      source: typeof check.evidence?.source === 'string' ? check.evidence.source : '',
    }))
}

function computeOverallStatus(steps, pendingChecks) {
  if (steps.some((step) => step.status === 'fail')) return 'fail'
  return pendingChecks.length > 0 ? 'manual_pending' : 'pass'
}

function strictCompileCommand(evidencePath, compiledDir) {
  return `node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs --input ${relativePath(evidencePath)} --output-dir ${relativePath(compiledDir)} --strict`
}

function exportPacketCommand(outputDir, requireFinalPass = false) {
  return [
    'node scripts/ops/export-dingtalk-staging-evidence-packet.mjs',
    '--include-output',
    relativePath(outputDir),
    ...(requireFinalPass ? ['--require-dingtalk-p4-pass'] : []),
  ].join(' ')
}

function finalHandoffCommand(outputDir) {
  return [
    'node scripts/ops/dingtalk-p4-final-handoff.mjs',
    '--session-dir',
    relativePath(outputDir),
  ].join(' ')
}

function statusCommand(outputDir) {
  return [
    'node scripts/ops/dingtalk-p4-smoke-status.mjs',
    '--session-dir',
    relativePath(outputDir),
  ].join(' ')
}

function evidenceRecordCommand(outputDir) {
  return [
    'node scripts/ops/dingtalk-p4-evidence-record.mjs',
    '--session-dir',
    relativePath(outputDir),
    '--check-id',
    '<check-id>',
    '--status',
    'pass',
    '--source',
    '<manual-client|manual-admin>',
    '--operator',
    '<operator>',
    '--summary',
    '"<summary>"',
    '--artifact',
    'artifacts/<check-id>/<file>',
  ].join(' ')
}

function finalizeCommand(outputDir, allowExternalArtifactRefs = false) {
  return [
    'node scripts/ops/dingtalk-p4-smoke-session.mjs',
    '--finalize',
    relativePath(outputDir),
    ...(allowExternalArtifactRefs ? ['--allow-external-artifact-refs'] : []),
  ].join(' ')
}

function renderFinalStrictSummary(summary) {
  const final = summary.finalStrictSummary
  if (!final) return ''
  const issues = Array.isArray(final.manualEvidenceIssues) && final.manualEvidenceIssues.length
    ? final.manualEvidenceIssues.map((issue) => `- \`${issue.id}\`: ${issue.code}`).join('\n')
    : '- None'
  const notPassed = Array.isArray(final.requiredChecksNotPassed) && final.requiredChecksNotPassed.length
    ? final.requiredChecksNotPassed.map((check) => `- \`${check.id}\`: ${check.status}`).join('\n')
    : '- None'

  return `
## Final Strict Summary

Final strict status: **${summary.finalStrictStatus}**

API bootstrap status: **${final.apiBootstrapStatus ?? 'unknown'}**

Remote client status: **${final.remoteClientStatus ?? 'unknown'}**

Required checks not passed:

${notPassed}

Manual evidence issues:

${issues}
`
}

function renderMarkdown(summary) {
  const rows = summary.steps.map((step) => {
    const stdout = typeof step.stdout === 'string' ? step.stdout : ''
    const stderr = typeof step.stderr === 'string' ? step.stderr : ''
    const notes = stderr || stdout.split(/\r?\n/).filter(Boolean).at(-1) || ''
    return `| \`${step.id}\` | ${step.label} | ${step.status} | ${step.exitCode} | ${notes.replaceAll('|', '\\|')} |`
  })
  const pending = summary.pendingChecks.length
    ? summary.pendingChecks.map((check) => `- \`${check.id}\`: ${check.status}${check.manual ? ' (manual evidence required)' : ''}`).join('\n')
    : '- None'
  const commands = summary.nextCommands.map((command) => `- \`${command}\``).join('\n')

  return `# DingTalk P4 Smoke Session Summary

Generated at: ${summary.generatedAt}

Overall status: **${summary.overallStatus}**

Output directory: \`${summary.outputDir}\`

## Steps

| ID | Step | Status | Exit | Notes |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

## Pending Checks

${pending}

## Next Commands

${commands}

${renderFinalStrictSummary(summary)}

## Secret Handling

- This summary redacts bearer tokens, DingTalk webhook tokens, signatures, timestamps, SEC secrets, JWTs, and public form tokens.
- Do not paste raw credentials into \`evidence.json\`, Markdown reports, or chat.
`
}

function writeSessionSummary(summary, outputDir) {
  const jsonPath = path.join(outputDir, 'session-summary.json')
  const mdPath = path.join(outputDir, 'session-summary.md')
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(mdPath, `${renderMarkdown(summary)}\n`, 'utf8')
  console.log(`Wrote ${relativePath(jsonPath)}`)
  console.log(`Wrote ${relativePath(mdPath)}`)
}

function runSession(opts) {
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1_000 || opts.timeoutMs > 120_000) {
    throw new Error('--timeout-ms must be an integer between 1000 and 120000')
  }

  const runId = makeRunId()
  const outputDir = opts.outputDir ?? path.resolve(process.cwd(), DEFAULT_OUTPUT_ROOT, runId)
  const preflightDir = path.join(outputDir, 'preflight')
  const workspaceDir = path.join(outputDir, 'workspace')
  const compiledDir = path.join(outputDir, 'compiled')
  const evidencePath = path.join(workspaceDir, 'evidence.json')
  const env = buildChildEnv(opts)
  const steps = []

  mkdirSync(outputDir, { recursive: true })

  const preflightArgs = [
    'scripts/ops/dingtalk-p4-smoke-preflight.mjs',
    '--output-dir',
    preflightDir,
    '--timeout-ms',
    String(opts.timeoutMs),
    ...(opts.skipApi ? ['--skip-api'] : []),
  ]
  steps.push(runNodeStep('preflight', 'Validate P4 smoke inputs and backend health', preflightArgs[0], preflightArgs.slice(1), preflightDir, env))

  if (steps.at(-1).status === 'pass') {
    const runnerArgs = [
      'scripts/ops/dingtalk-p4-remote-smoke.mjs',
      '--output-dir',
      workspaceDir,
      '--timeout-ms',
      String(opts.timeoutMs),
      ...(opts.skipHealth ? ['--skip-health'] : []),
      ...(opts.skipTestSend ? ['--skip-test-send'] : []),
      ...(opts.skipAutomationTestRun ? ['--skip-automation-test-run'] : []),
    ]
    steps.push(runNodeStep('api-runner', 'Bootstrap API-addressable P4 smoke workspace', runnerArgs[0], runnerArgs.slice(1), workspaceDir, env))
  }

  if (existsSync(evidencePath)) {
    const compileArgs = [
      'scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs',
      '--input',
      evidencePath,
      '--output-dir',
      compiledDir,
      ...(opts.allowExternalArtifactRefs ? ['--allow-external-artifact-refs'] : []),
    ]
    steps.push(runNodeStep('compile', 'Compile non-strict evidence summary', compileArgs[0], compileArgs.slice(1), compiledDir, env))
  }

  const pendingChecks = extractPendingManualChecks(evidencePath)
  const summary = {
    tool: 'dingtalk-p4-smoke-session',
    runId,
    generatedAt: new Date().toISOString(),
    outputDir: relativePath(outputDir),
    preflightDir: relativePath(preflightDir),
    workspaceDir: relativePath(workspaceDir),
    compiledDir: relativePath(compiledDir),
    overallStatus: computeOverallStatus(steps, pendingChecks),
    sessionPhase: 'bootstrap',
    finalStrictStatus: 'not_run',
    steps,
    pendingChecks,
    nextCommands: [
      statusCommand(outputDir),
      evidenceRecordCommand(outputDir),
      finalizeCommand(outputDir, opts.allowExternalArtifactRefs),
      exportPacketCommand(outputDir),
    ],
  }

  writeSessionSummary(summary, outputDir)
  return summary
}

function runFinalStrictCompile(opts) {
  const outputDir = opts.finalizeDir
  const preflightDir = path.join(outputDir, 'preflight')
  const workspaceDir = path.join(outputDir, 'workspace')
  const compiledDir = path.join(outputDir, 'compiled')
  const evidencePath = path.join(workspaceDir, 'evidence.json')
  const priorSummaryPath = path.join(outputDir, 'session-summary.json')

  if (!existsSync(evidencePath)) {
    throw new Error(`session workspace evidence does not exist: ${relativePath(evidencePath)}`)
  }

  const priorSummary = readJsonIfExists(priorSummaryPath)
  const env = buildChildEnv(opts)
  const strictCompileArgs = [
    'scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs',
    '--input',
    evidencePath,
    '--output-dir',
    compiledDir,
    '--strict',
    ...(opts.allowExternalArtifactRefs ? ['--allow-external-artifact-refs'] : []),
  ]
  const strictStep = runNodeStep(
    'strict-compile',
    'Compile final strict P4 smoke evidence',
    strictCompileArgs[0],
    strictCompileArgs.slice(1),
    compiledDir,
    env,
  )
  const priorSteps = Array.isArray(priorSummary?.steps)
    ? priorSummary.steps.filter((step) => step?.id !== 'strict-compile')
    : []
  const steps = [...priorSteps, strictStep]
  const pendingChecks = extractPendingManualChecks(evidencePath)
  const compiledSummary = readJsonIfExists(path.join(compiledDir, 'summary.json'))
  const strictPassed = strictStep.status === 'pass' && compiledSummary?.overallStatus === 'pass'
  const summary = {
    tool: 'dingtalk-p4-smoke-session',
    runId: priorSummary?.runId ?? makeRunId(),
    generatedAt: new Date().toISOString(),
    outputDir: relativePath(outputDir),
    preflightDir: relativePath(preflightDir),
    workspaceDir: relativePath(workspaceDir),
    compiledDir: relativePath(compiledDir),
    overallStatus: strictPassed ? 'pass' : 'fail',
    sessionPhase: 'finalize',
    finalStrictStatus: strictPassed ? 'pass' : 'fail',
    steps,
    pendingChecks,
    finalStrictSummary: compiledSummary
      ? {
          overallStatus: compiledSummary.overallStatus,
          apiBootstrapStatus: compiledSummary.apiBootstrapStatus,
          remoteClientStatus: compiledSummary.remoteClientStatus,
          requiredChecksNotPassed: compiledSummary.requiredChecksNotPassed ?? [],
          manualEvidenceIssues: compiledSummary.manualEvidenceIssues ?? [],
          manualEvidenceIssueCount: Array.isArray(compiledSummary.manualEvidenceIssues)
            ? compiledSummary.manualEvidenceIssues.length
            : 0,
          requiredChecksNotPassedCount: Array.isArray(compiledSummary.requiredChecksNotPassed)
            ? compiledSummary.requiredChecksNotPassed.length
            : 0,
        }
      : null,
    nextCommands: strictPassed
      ? [statusCommand(outputDir), finalHandoffCommand(outputDir), exportPacketCommand(outputDir, true)]
      : [statusCommand(outputDir), evidenceRecordCommand(outputDir), finalizeCommand(outputDir, opts.allowExternalArtifactRefs), finalHandoffCommand(outputDir), exportPacketCommand(outputDir, true)],
  }

  writeSessionSummary(summary, outputDir)
  return summary
}

try {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.initEnvTemplate) {
    writeEnvTemplate(opts.initEnvTemplate)
  } else if (opts.finalizeDir) {
    const summary = runFinalStrictCompile(opts)
    if (summary.overallStatus !== 'pass') process.exit(1)
  } else {
    const summary = runSession(opts)
    if (summary.overallStatus === 'fail') process.exit(1)
  }
} catch (error) {
  console.error(`[dingtalk-p4-smoke-session] ERROR: ${redactString(error instanceof Error ? error.message : String(error))}`)
  process.exit(1)
}
