#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

const DEFAULT_ENV_FILE = path.join(homedir(), '.config', 'yuantus', 'dingtalk-p4-staging.env')
const DEFAULT_OUTPUT_ROOT = 'output/dingtalk-p4-release-readiness'
const DEFAULT_SMOKE_OUTPUT_DIR = 'output/dingtalk-p4-remote-smoke-session/142-session'
const SCHEMA_VERSION = 1
const PUBLIC_REGRESSION_PROFILES = ['ops', 'product', 'all']
const TEST_ONLY_REGRESSION_PROFILES = ['selftest', 'selftest-secret']
const SELFTEST_UNLOCK_ENV = 'DINGTALK_P4_RELEASE_READINESS_ALLOW_SELFTEST'
const SMOKE_SESSION_SCRIPT_ENV = 'DINGTALK_P4_RELEASE_READINESS_SMOKE_SESSION_SCRIPT'
const SMOKE_SESSION_INPUT_ENV_KEYS = [
  'DINGTALK_P4_API_BASE',
  'API_BASE',
  'DINGTALK_P4_WEB_BASE',
  'WEB_BASE',
  'PUBLIC_APP_URL',
  'DINGTALK_P4_AUTH_TOKEN',
  'ADMIN_TOKEN',
  'AUTH_TOKEN',
  'DINGTALK_P4_GROUP_A_WEBHOOK',
  'DINGTALK_GROUP_A_WEBHOOK',
  'DINGTALK_P4_GROUP_B_WEBHOOK',
  'DINGTALK_GROUP_B_WEBHOOK',
  'DINGTALK_P4_GROUP_A_SECRET',
  'DINGTALK_GROUP_A_SECRET',
  'DINGTALK_P4_GROUP_B_SECRET',
  'DINGTALK_GROUP_B_SECRET',
  'DINGTALK_P4_ALLOWED_USER_IDS',
  'DINGTALK_P4_ALLOWED_USER_ID',
  'DINGTALK_P4_ALLOWED_MEMBER_GROUP_IDS',
  'DINGTALK_P4_ALLOWED_MEMBER_GROUP_ID',
  'DINGTALK_P4_PERSON_USER_IDS',
  'DINGTALK_P4_PERSON_USER_ID',
  'DINGTALK_P4_AUTHORIZED_USER_ID',
  'DINGTALK_P4_UNAUTHORIZED_USER_ID',
  'DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID',
]

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-p4-release-readiness.mjs [options]

Combines the private DingTalk P4 env readiness check and local P4 regression
gate into one go/no-go report before the final 142/staging smoke.

Options:
  --p4-env-file <file>             Env file path, default ${DEFAULT_ENV_FILE}
  --regression-profile <profile>   Regression profile: ops, product, or all; default ops
  --regression-plan-only           Plan regression commands without executing them
  --run-smoke-session              If readiness passes, start the final smoke session automatically
  --smoke-output-dir <dir>         Smoke session output dir, default ${DEFAULT_SMOKE_OUTPUT_DIR}
  --smoke-timeout-ms <ms>          Forwarded to dingtalk-p4-smoke-session.mjs; 0 uses its default
  --output-dir <dir>               Output dir, default ${DEFAULT_OUTPUT_ROOT}/<run-id>
  --timeout-ms <ms>                Forwarded to regression gate
  --allow-failures                 Exit 0 but still write fail/manual_pending status
  --help                           Show this help

Typical flow:
  node scripts/ops/dingtalk-p4-release-readiness.mjs
  # Or collapse readiness + smoke handoff into one command:
  node scripts/ops/dingtalk-p4-release-readiness.mjs --run-smoke-session --smoke-output-dir ${DEFAULT_SMOKE_OUTPUT_DIR}
`)
}

function readRequiredValue(argv, index, flag) {
  const next = argv[index + 1]
  if (!next || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return next
}

function makeRunId() {
  return `dingtalk-p4-release-readiness-${new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}`
}

function parsePositiveInteger(value, flag, { allowZero = false } = {}) {
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`${flag} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
  const next = Number.parseInt(value, 10)
  if (!allowZero && next <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return next
}

function parseArgs(argv) {
  const opts = {
    p4EnvFile: DEFAULT_ENV_FILE,
    regressionProfile: 'ops',
    regressionPlanOnly: false,
    runSmokeSession: false,
    smokeOutputDir: path.resolve(process.cwd(), DEFAULT_SMOKE_OUTPUT_DIR),
    smokeTimeoutMs: 0,
    outputDir: '',
    timeoutMs: 0,
    allowFailures: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--p4-env-file':
        opts.p4EnvFile = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--regression-profile':
        opts.regressionProfile = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--regression-plan-only':
        opts.regressionPlanOnly = true
        break
      case '--run-smoke-session':
        opts.runSmokeSession = true
        break
      case '--smoke-output-dir':
        opts.smokeOutputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--smoke-timeout-ms':
        opts.smokeTimeoutMs = parsePositiveInteger(readRequiredValue(argv, i, arg), arg, { allowZero: true })
        i += 1
        break
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--timeout-ms':
        opts.timeoutMs = parsePositiveInteger(readRequiredValue(argv, i, arg), arg, { allowZero: true })
        i += 1
        break
      case '--allow-failures':
        opts.allowFailures = true
        break
      case '--help':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  const selftestProfileAllowed = TEST_ONLY_REGRESSION_PROFILES.includes(opts.regressionProfile)
    && process.env[SELFTEST_UNLOCK_ENV] === '1'
  if (!PUBLIC_REGRESSION_PROFILES.includes(opts.regressionProfile) && !selftestProfileAllowed) {
    throw new Error(`--regression-profile must be one of: ${PUBLIC_REGRESSION_PROFILES.join(', ')}`)
  }

  if (!opts.outputDir) {
    opts.outputDir = path.resolve(process.cwd(), DEFAULT_OUTPUT_ROOT, makeRunId())
  }
  return opts
}

function redactString(value) {
  return String(value ?? '')
    .replace(/(access_token=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/(publicToken=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/([?&](?:sign|timestamp)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/((?:client_secret|DINGTALK_CLIENT_SECRET|DINGTALK_STATE_SECRET)=)[^\s&]+/gi, '$1<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\bSEC[A-Za-z0-9+/=_-]{8,}\b/g, 'SEC<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '<jwt:redacted>')
}

function sanitizeValue(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry))
  if (typeof value === 'object') {
    const next = {}
    for (const [key, entryValue] of Object.entries(value)) {
      next[key] = sanitizeValue(entryValue)
    }
    return next
  }
  return value
}

function relativePath(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function buildSmokeSessionCommand(opts) {
  const args = [
    'node scripts/ops/dingtalk-p4-smoke-session.mjs',
    '--env-file',
    shellQuote(opts.p4EnvFile),
    '--require-manual-targets',
    '--output-dir',
    shellQuote(relativePath(opts.smokeOutputDir)),
  ]
  if (opts.smokeTimeoutMs > 0) args.push('--timeout-ms', String(opts.smokeTimeoutMs))
  return args.join(' ')
}

function runNodeTool(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    ...(options.env ? { env: options.env } : {}),
  })
  return {
    exitCode: result.status ?? 1,
    stdout: redactString(result.stdout ?? ''),
    stderr: redactString(result.stderr || result.error?.message || ''),
  }
}

function smokeSessionEnv() {
  const env = { ...process.env }
  for (const key of SMOKE_SESSION_INPUT_ENV_KEYS) {
    delete env[key]
  }
  return env
}

function writeTextFile(file, content) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${redactString(content ?? '')}`, 'utf8')
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

function runEnvReadiness(opts, envDir) {
  const jsonPath = path.join(envDir, 'readiness-summary.json')
  const mdPath = path.join(envDir, 'readiness-summary.md')
  const result = runNodeTool([
    'scripts/ops/dingtalk-p4-env-bootstrap.mjs',
    '--check',
    '--p4-env-file',
    opts.p4EnvFile,
    '--output-dir',
    envDir,
  ])
  const summary = readJsonIfExists(jsonPath)
  return {
    id: 'env-readiness',
    label: 'Private DingTalk P4 env readiness',
    status: summary?.overallStatus === 'pass' ? 'pass' : 'fail',
    exitCode: result.exitCode,
    summaryJson: existsSync(jsonPath) ? relativePath(jsonPath) : null,
    summaryMd: existsSync(mdPath) ? relativePath(mdPath) : null,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    details: summary
      ? {
          envFile: summary.envFile,
          environment: summary.environment,
          failedChecks: summary.checks.filter((check) => check.status === 'fail').map((check) => check.id),
        }
      : {},
  }
}

function runRegressionGate(opts, regressionDir) {
  const args = [
    'scripts/ops/dingtalk-p4-regression-gate.mjs',
    '--profile',
    opts.regressionProfile,
    '--output-dir',
    regressionDir,
  ]
  if (opts.regressionPlanOnly) args.push('--plan-only')
  if (opts.timeoutMs > 0) args.push('--timeout-ms', String(opts.timeoutMs))
  const result = runNodeTool(args)
  const jsonPath = path.join(regressionDir, 'summary.json')
  const mdPath = path.join(regressionDir, 'summary.md')
  const summary = readJsonIfExists(jsonPath)
  const status = summary?.overallStatus === 'pass'
    ? 'pass'
    : summary?.overallStatus === 'plan_only'
      ? 'skipped'
      : 'fail'
  return {
    id: 'regression-gate',
    label: `Local DingTalk P4 regression gate (${opts.regressionProfile})`,
    status,
    exitCode: result.exitCode,
    summaryJson: existsSync(jsonPath) ? relativePath(jsonPath) : null,
    summaryMd: existsSync(mdPath) ? relativePath(mdPath) : null,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    details: summary
      ? {
          profile: summary.profile,
          planOnly: summary.planOnly,
          totals: summary.totals,
          failedChecks: summary.checks.filter((check) => check.status === 'fail').map((check) => check.id),
        }
      : {},
  }
}

function runSmokeSession(opts) {
  const scriptPath = process.env[SMOKE_SESSION_SCRIPT_ENV] || 'scripts/ops/dingtalk-p4-smoke-session.mjs'
  const stdoutLog = path.join(opts.outputDir, 'smoke-session.stdout.log')
  const stderrLog = path.join(opts.outputDir, 'smoke-session.stderr.log')
  const args = [
    scriptPath,
    '--env-file',
    opts.p4EnvFile,
    '--require-manual-targets',
    '--output-dir',
    opts.smokeOutputDir,
  ]
  if (opts.smokeTimeoutMs > 0) args.push('--timeout-ms', String(opts.smokeTimeoutMs))
  const result = runNodeTool(args, { env: smokeSessionEnv() })
  writeTextFile(stdoutLog, result.stdout)
  writeTextFile(stderrLog, result.stderr)
  const sessionSummaryJson = path.join(opts.smokeOutputDir, 'session-summary.json')
  const sessionSummaryMd = path.join(opts.smokeOutputDir, 'session-summary.md')
  const smokeStatusJson = path.join(opts.smokeOutputDir, 'smoke-status.json')
  const smokeStatusMd = path.join(opts.smokeOutputDir, 'smoke-status.md')
  const smokeTodoMd = path.join(opts.smokeOutputDir, 'smoke-todo.md')
  const sessionSummary = readJsonIfExists(sessionSummaryJson)
  const smokeStatusSummary = readJsonIfExists(smokeStatusJson)
  const hasValidSessionSummary = typeof sessionSummary?.overallStatus === 'string' && sessionSummary.overallStatus.trim()
  const status = result.exitCode === 0 && hasValidSessionSummary
    ? sessionSummary.overallStatus
    : 'fail'
  return {
    requested: true,
    status,
    exitCode: result.exitCode,
    reason: result.exitCode === 0 && !hasValidSessionSummary ? 'missing_session_summary' : null,
    outputDir: relativePath(opts.smokeOutputDir),
    stdoutLog: relativePath(stdoutLog),
    stderrLog: relativePath(stderrLog),
    sessionSummaryJson: existsSync(sessionSummaryJson) ? relativePath(sessionSummaryJson) : null,
    sessionSummaryMd: existsSync(sessionSummaryMd) ? relativePath(sessionSummaryMd) : null,
    smokeStatusJson: existsSync(smokeStatusJson) ? relativePath(smokeStatusJson) : null,
    smokeStatusMd: existsSync(smokeStatusMd) ? relativePath(smokeStatusMd) : null,
    smokeTodoMd: existsSync(smokeTodoMd) ? relativePath(smokeTodoMd) : null,
    sessionPhase: sessionSummary?.sessionPhase ?? null,
    overallStatus: sessionSummary?.overallStatus ?? null,
    finalStrictStatus: sessionSummary?.finalStrictStatus ?? null,
    remoteSmokePhase: smokeStatusSummary?.remoteSmokePhase ?? sessionSummary?.remoteSmokePhase ?? null,
    remoteSmokeTodos: smokeStatusSummary?.remoteSmokeTodos
      ? {
          total: smokeStatusSummary.remoteSmokeTodos.total,
          completed: smokeStatusSummary.remoteSmokeTodos.completed,
          remaining: smokeStatusSummary.remoteSmokeTodos.remaining,
        }
      : null,
    currentFocus: smokeStatusSummary?.executionPlan?.currentFocus
      ? {
          phaseLabel: smokeStatusSummary.executionPlan.currentFocus.phaseLabel,
          checkId: smokeStatusSummary.executionPlan.currentFocus.checkId,
          todo: smokeStatusSummary.executionPlan.currentFocus.todo,
          nextAction: smokeStatusSummary.executionPlan.currentFocus.nextAction,
        }
      : null,
  }
}

function computeOverallStatus(checks) {
  if (checks.some((check) => check.status === 'fail')) return 'fail'
  if (checks.some((check) => check.status === 'skipped')) return 'manual_pending'
  return 'pass'
}

function renderMarkdown(summary) {
  const lines = [
    '# DingTalk P4 Release Readiness',
    '',
    `- Overall status: **${summary.overallStatus}**`,
    `- Generated at: \`${summary.generatedAt}\``,
    `- Env file: \`${summary.p4EnvFile}\``,
    `- Regression profile: \`${summary.regressionProfile}\``,
    `- Regression plan only: \`${summary.regressionPlanOnly}\``,
    '',
    '## Gates',
    '',
    '| Gate | Status | Exit | Summary | Failed checks |',
    '| --- | --- | ---: | --- | --- |',
  ]

  for (const gate of summary.gates) {
    const failedChecks = gate.details?.failedChecks?.length ? gate.details.failedChecks.map((id) => `\`${id}\``).join('<br>') : ''
    const summaryLink = gate.summaryMd ? `[md](${gate.summaryMd})` : ''
    lines.push(`| \`${gate.id}\` | ${gate.status} | ${gate.exitCode} | ${summaryLink} | ${failedChecks} |`)
  }

  if (summary.smokeSession?.requested) {
    lines.push('')
    lines.push('## Smoke Session')
    lines.push('')
    lines.push(`- Status: **${summary.smokeSession.status}**`)
    if (summary.smokeSession.remoteSmokePhase) {
      lines.push(`- Remote smoke phase: **${summary.smokeSession.remoteSmokePhase}**`)
    }
    if (summary.smokeSession.remoteSmokeTodos) {
      lines.push(`- Remote TODO: **${summary.smokeSession.remoteSmokeTodos.completed}/${summary.smokeSession.remoteSmokeTodos.total}** complete, **${summary.smokeSession.remoteSmokeTodos.remaining}** remaining`)
    }
    if (summary.smokeSession.currentFocus) {
      lines.push(`- Current focus: \`${summary.smokeSession.currentFocus.checkId}\` - ${summary.smokeSession.currentFocus.nextAction}`)
    }
    if (summary.smokeSession.reason) {
      lines.push(`- Reason: \`${summary.smokeSession.reason}\``)
    }
    if (summary.smokeSession.outputDir) {
      lines.push(`- Output dir: \`${summary.smokeSession.outputDir}\``)
    }
    if (summary.smokeSession.sessionSummaryMd) {
      lines.push(`- Session summary: [md](${summary.smokeSession.sessionSummaryMd})`)
    }
    if (summary.smokeSession.smokeStatusMd) {
      lines.push(`- Smoke status: [md](${summary.smokeSession.smokeStatusMd})`)
    }
    if (summary.smokeSession.smokeTodoMd) {
      lines.push(`- Smoke todo: [md](${summary.smokeSession.smokeTodoMd})`)
    }
    if (summary.smokeSession.stdoutLog) {
      lines.push(`- Logs: [stdout](${summary.smokeSession.stdoutLog}) / [stderr](${summary.smokeSession.stderrLog})`)
    }
  }

  lines.push('')
  lines.push('## Next Step')
  lines.push('')
  if (summary.runSmokeSession) {
    if (summary.smokeSession?.status === 'pass' || summary.smokeSession?.status === 'manual_pending') {
      lines.push('Smoke session was started automatically after readiness passed. Continue with manual DingTalk evidence collection inside the generated session workspace.')
    } else {
      lines.push('Smoke session was requested but not completed successfully. Resolve the blocking gate or smoke-session failure first, then rerun this command.')
    }
  } else if (summary.overallStatus === 'pass') {
    lines.push('Run the final remote smoke session:')
    lines.push('')
    lines.push('```bash')
    lines.push(summary.plannedSmokeSession.command)
    lines.push('```')
  } else {
    lines.push('Do not run the final remote smoke yet. Resolve failed gates first, then rerun this readiness command.')
  }

  lines.push('')
  lines.push('## Secret Policy')
  lines.push('')
  lines.push('Bearer tokens, DingTalk robot access tokens, SEC secrets, JWTs, public form tokens, timestamps, and signs are redacted from this report.')
  return `${lines.join('\n')}\n`
}

function run(opts) {
  mkdirSync(opts.outputDir, { recursive: true })
  const envDir = path.join(opts.outputDir, 'env-readiness')
  const regressionDir = path.join(opts.outputDir, 'regression-gate')
  mkdirSync(envDir, { recursive: true })
  mkdirSync(regressionDir, { recursive: true })

  const gates = [
    runEnvReadiness(opts, envDir),
    runRegressionGate(opts, regressionDir),
  ]
  const readinessStatus = computeOverallStatus(gates)
  let smokeSession = {
    requested: opts.runSmokeSession,
    status: 'not_requested',
  }
  let overallStatus = readinessStatus
  if (opts.runSmokeSession) {
    if (readinessStatus === 'pass') {
      smokeSession = runSmokeSession(opts)
      if (smokeSession.status === 'manual_pending') {
        overallStatus = 'manual_pending'
      } else if (smokeSession.status !== 'pass') {
        overallStatus = 'fail'
      }
    } else {
      smokeSession = {
        requested: true,
        status: 'blocked',
        reason: readinessStatus === 'manual_pending' ? 'regression_plan_only' : 'release_readiness_failed',
      }
    }
  }
  const summary = sanitizeValue({
    tool: 'dingtalk-p4-release-readiness',
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    outputDir: relativePath(opts.outputDir),
    p4EnvFile: opts.p4EnvFile,
    regressionProfile: opts.regressionProfile,
    regressionPlanOnly: opts.regressionPlanOnly,
    runSmokeSession: opts.runSmokeSession,
    plannedSmokeSession: {
      outputDir: relativePath(opts.smokeOutputDir),
      timeoutMs: opts.smokeTimeoutMs,
      command: buildSmokeSessionCommand(opts),
    },
    defaultSmokeOutputDir: DEFAULT_SMOKE_OUTPUT_DIR,
    overallStatus,
    gates,
    smokeSession,
  })

  const jsonPath = path.join(opts.outputDir, 'release-readiness-summary.json')
  const mdPath = path.join(opts.outputDir, 'release-readiness-summary.md')
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(mdPath, renderMarkdown(summary), 'utf8')
  console.log(`[dingtalk-p4-release-readiness] ${overallStatus}: ${relativePath(jsonPath)}`)
  return overallStatus === 'pass' || opts.allowFailures ? 0 : 1
}

try {
  const opts = parseArgs(process.argv.slice(2))
  process.exit(run(opts))
} catch (error) {
  console.error(`[dingtalk-p4-release-readiness] ERROR: ${redactString(error instanceof Error ? error.message : String(error))}`)
  process.exit(1)
}
