#!/usr/bin/env node

/**
 * Phase 3 release gate skeleton.
 *
 * Routing + blocked-mode + shared redaction + JSON+MD report writer.
 * D1 binds the existing guarded email real-send smoke into this
 * aggregator. D4 binds the guarded automation soak harness. D2/D3
 * stay blocked under the K3 PoC stage-1 lock.
 *
 * Exit codes:
 *   0  PASS
 *   1  FAIL
 *   2  BLOCKED — never collapsed into FAIL.
 *
 * Email real-send is delegated to the existing
 * `verify:multitable-email:real-send` script
 * (`scripts/ops/multitable-email-real-send-smoke.ts`) so the Phase 3
 * release gate has a single GO/NO-GO aggregation surface without
 * duplicating SMTP send logic.
 *
 * See:
 *   docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md
 *   docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { redactString } from './multitable-phase3-release-gate-redact.mjs'
import { buildReport, writeReport } from './multitable-phase3-release-gate-report.mjs'

const TOOL = 'multitable-phase3-release-gate'
const DEFAULT_OUTPUT_DIR = 'output/multitable-phase3-release-gate'
const EMAIL_REAL_SEND_GATE = 'email:real-send'
const EMAIL_REAL_SEND_COMMAND = 'pnpm verify:multitable-email:real-send'
const AUTOMATION_SOAK_GATE = 'automation:soak'
const AUTOMATION_SOAK_COMMAND = 'pnpm verify:multitable-automation:soak'

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_BLOCKED = 2

const SUB_GATES = {
  [EMAIL_REAL_SEND_GATE]: {
    kind: 'delegate',
    requiredEnv: [
      'MULTITABLE_EMAIL_TRANSPORT',
      'MULTITABLE_EMAIL_REAL_SEND_SMOKE',
      'CONFIRM_SEND_EMAIL',
      'MULTITABLE_EMAIL_SMOKE_TO',
    ],
    deferral: 'D1 — Real SMTP Gate',
    blockedReason:
      'Lane D1 delegates to verify:multitable-email:real-send and stays BLOCKED until SMTP mode, explicit real-send smoke, explicit send confirmation, and a dedicated test recipient are configured.',
  },
  'perf:large-table': {
    kind: 'skeleton',
    requiredEnv: ['MULTITABLE_PERF_LARGE_TABLE_CONFIRM', 'MULTITABLE_PERF_TARGET_DB'],
    deferral: 'D2 — Large Table Performance Gate',
    blockedReason:
      'Lane D2 deferred under K3 PoC stage-1 lock. Requires K3-free staging plus T4 closure before activation.',
  },
  'permissions:matrix': {
    kind: 'skeleton',
    requiredEnv: ['MULTITABLE_PERM_MATRIX_CONFIRM'],
    deferral: 'D3 — Permission Matrix Gate',
    blockedReason:
      'Lane D3 deferred. Requires explicit snapshot-vs-golden-matrix semantics decision (T5) before activation.',
  },
  [AUTOMATION_SOAK_GATE]: {
    kind: 'delegate',
    requiredEnv: [
      'API_BASE',
      'AUTH_TOKEN',
      'MULTITABLE_AUTOMATION_SOAK_CONFIRM',
      'MULTITABLE_AUTOMATION_SOAK_EMAIL_SAFE_MODE',
      'MULTITABLE_AUTOMATION_SOAK_WEBHOOK_URL',
      'MULTITABLE_AUTOMATION_SOAK_FAIL_WEBHOOK_URL',
    ],
    deferral: 'D4 — Automation Soak Gate',
    blockedReason:
      'Lane D4 delegates to verify:multitable-automation:soak and stays BLOCKED until API/auth/confirm/email-safe-mode/webhook sink env is configured.',
  },
}

const AGGREGATE_GATE = 'release:phase3'
const PUBLIC_GATES = [AGGREGATE_GATE, ...Object.keys(SUB_GATES)]

function printHelp() {
  console.log(`Usage: node scripts/ops/multitable-phase3-release-gate.mjs --gate <id> [options]

Runs the Phase 3 release gate. D1 delegates \`email:real-send\` to
the existing guarded SMTP smoke harness. D4 delegates
\`automation:soak\` to the guarded automation soak harness. Deferred
or unconfigured gates return BLOCKED.

Gates:
  ${PUBLIC_GATES.map((g) => `\`${g}\``).join(', ')}

Options:
  --gate <id>            One of the gates above.
  --output-dir <dir>     Output directory, default ${DEFAULT_OUTPUT_DIR}/<gate>
  --output-json <file>   Output JSON path, default <output-dir>/report.json
  --output-md <file>     Output Markdown path, default <output-dir>/report.md
  --allow-blocked        Exit 0 even when the gate is BLOCKED.
                         Does not affect the recorded status field.
  --help                 Show this help.

Exit codes:
  0  PASS
  1  FAIL
  2  BLOCKED (the aggregator returns 2 when any child is blocked;
     it never collapses BLOCKED into FAIL)
`)
}

function readRequiredValue(argv, i, flag) {
  const value = argv[i + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function parseArgs(argv) {
  const opts = {
    gate: '',
    outputDir: '',
    outputJson: '',
    outputMd: '',
    allowBlocked: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--gate':
        opts.gate = readRequiredValue(argv, i, arg)
        i += 1
        break
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--output-json':
        opts.outputJson = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--output-md':
        opts.outputMd = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--allow-blocked':
        opts.allowBlocked = true
        break
      case '--help':
        printHelp()
        process.exit(0)
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!opts.gate) {
    throw new Error(`--gate is required. Choose one of: ${PUBLIC_GATES.join(', ')}`)
  }
  if (!PUBLIC_GATES.includes(opts.gate)) {
    throw new Error(`Unknown --gate value: ${opts.gate}. Choose one of: ${PUBLIC_GATES.join(', ')}`)
  }
  if (!opts.outputDir) {
    opts.outputDir = path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR, opts.gate.replace(/:/g, '-'))
  }
  if (!opts.outputJson) opts.outputJson = path.join(opts.outputDir, 'report.json')
  if (!opts.outputMd) opts.outputMd = path.join(opts.outputDir, 'report.md')
  return opts
}

function statusFromExitCode(exitCode) {
  if (exitCode === EXIT_PASS) return 'pass'
  if (exitCode === EXIT_BLOCKED) return 'blocked'
  return 'fail'
}

function keepProcessEnvForChild(env, extraEnv) {
  const passthroughKeys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'NODE_OPTIONS',
    'PNPM_HOME',
    'COREPACK_HOME',
  ]
  const childEnv = {}
  for (const key of passthroughKeys) {
    if (process.env[key]) childEnv[key] = process.env[key]
  }
  return {
    ...childEnv,
    ...env,
    ...extraEnv,
  }
}

function safeReadJson(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function runEmailRealSendGate(env, options = {}) {
  const config = SUB_GATES[EMAIL_REAL_SEND_GATE]
  const startedAt = new Date().toISOString()
  const outputDir =
    options.outputDir ??
    path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR, EMAIL_REAL_SEND_GATE.replace(/:/g, '-'))
  const childDir = path.join(outputDir, 'real-send-smoke')
  const childReportJson = path.join(childDir, 'report.json')
  const childReportMd = path.join(childDir, 'report.md')
  mkdirSync(childDir, { recursive: true })

  const child = spawnSync('pnpm', ['verify:multitable-email:real-send'], {
    cwd: options.cwd ?? process.cwd(),
    env: keepProcessEnvForChild(env, {
      EMAIL_REAL_SEND_JSON: childReportJson,
      EMAIL_REAL_SEND_MD: childReportMd,
    }),
    encoding: 'utf8',
  })

  const childExitCode = typeof child.status === 'number' ? child.status : EXIT_FAIL
  const status = child.error ? 'fail' : statusFromExitCode(childExitCode)
  const exitCode = status === 'pass' ? EXIT_PASS : status === 'blocked' ? EXIT_BLOCKED : EXIT_FAIL
  const childReport = safeReadJson(childReportJson)
  const missingEnv = config.requiredEnv.filter((name) => !env[name] || env[name] === '')

  let reason = 'Real SMTP send smoke passed.'
  if (child.error) {
    reason = `Failed to launch delegated real-send smoke: ${child.error.message}`
  } else if (status === 'blocked') {
    reason =
      'Delegated real-send smoke is BLOCKED. Configure SMTP mode, explicit real-send smoke, explicit send confirmation, and a dedicated test recipient before treating this gate as GO.'
  } else if (status === 'fail') {
    reason = 'Delegated real-send smoke returned FAIL.'
  }

  return {
    tool: TOOL,
    gate: EMAIL_REAL_SEND_GATE,
    status,
    exitCode,
    reason,
    requiredEnv: config.requiredEnv,
    missingEnv,
    deferral: config.deferral,
    startedAt,
    completedAt: new Date().toISOString(),
    delegatedCommand: EMAIL_REAL_SEND_COMMAND,
    childExitCode,
    childReportJson,
    childReportMd,
    childStatus: childReport?.status ?? status,
    childOk: childReport?.ok ?? status === 'pass',
    childMode: childReport?.mode,
    childNotificationStatus: childReport?.notificationStatus,
    childFailedReason: childReport?.failedReason,
  }
}

function runAutomationSoakGate(env, options = {}) {
  const config = SUB_GATES[AUTOMATION_SOAK_GATE]
  const startedAt = new Date().toISOString()
  const outputDir =
    options.outputDir ??
    path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR, AUTOMATION_SOAK_GATE.replace(/:/g, '-'))
  const childDir = path.join(outputDir, 'automation-soak')
  const childReportJson = path.join(childDir, 'report.json')
  const childReportMd = path.join(childDir, 'report.md')
  mkdirSync(childDir, { recursive: true })

  const child = spawnSync('pnpm', ['verify:multitable-automation:soak'], {
    cwd: options.cwd ?? process.cwd(),
    env: keepProcessEnvForChild(env, {
      AUTOMATION_SOAK_OUTPUT_DIR: childDir,
      AUTOMATION_SOAK_JSON: childReportJson,
      AUTOMATION_SOAK_MD: childReportMd,
    }),
    encoding: 'utf8',
  })

  const childExitCode = typeof child.status === 'number' ? child.status : EXIT_FAIL
  const status = child.error ? 'fail' : statusFromExitCode(childExitCode)
  const exitCode = status === 'pass' ? EXIT_PASS : status === 'blocked' ? EXIT_BLOCKED : EXIT_FAIL
  const childReport = safeReadJson(childReportJson)
  const missingEnv = config.requiredEnv.filter((name) => !env[name] || env[name] === '')

  let reason = 'Automation soak passed.'
  if (child.error) {
    reason = `Failed to launch delegated automation soak: ${child.error.message}`
  } else if (status === 'blocked') {
    reason =
      'Delegated automation soak is BLOCKED. Configure API/auth, explicit soak confirmation, mock email safe-mode acknowledgement, and controlled webhook sinks before treating this gate as GO.'
  } else if (status === 'fail') {
    reason = 'Delegated automation soak returned FAIL.'
  }

  return {
    tool: TOOL,
    gate: AUTOMATION_SOAK_GATE,
    status,
    exitCode,
    reason,
    requiredEnv: config.requiredEnv,
    missingEnv,
    deferral: config.deferral,
    startedAt,
    completedAt: new Date().toISOString(),
    delegatedCommand: AUTOMATION_SOAK_COMMAND,
    childExitCode,
    childReportJson,
    childReportMd,
    childStatus: childReport?.status ?? status,
    childIterations: childReport?.iterations,
    childEvidence: childReport?.evidence,
  }
}

function runSubGate(gate, env, options = {}) {
  const config = SUB_GATES[gate]
  if (gate === EMAIL_REAL_SEND_GATE) return runEmailRealSendGate(env, options)
  if (gate === AUTOMATION_SOAK_GATE) return runAutomationSoakGate(env, options)
  const startedAt = new Date().toISOString()
  const missingEnv = config.requiredEnv.filter((name) => !env[name] || env[name] === '')
  const baseReport = {
    tool: TOOL,
    gate,
    status: 'blocked',
    exitCode: EXIT_BLOCKED,
    requiredEnv: config.requiredEnv,
    missingEnv,
    deferral: config.deferral,
    startedAt,
  }
  if (missingEnv.length === 0) {
    return {
      ...baseReport,
      reason:
        `${config.blockedReason} (D0 skeleton: env vars accepted as input but no harness implementation present; gate remains blocked.)`,
      completedAt: new Date().toISOString(),
    }
  }
  return {
    ...baseReport,
    reason: config.blockedReason,
    completedAt: new Date().toISOString(),
  }
}

function runAggregate(env, options = {}) {
  const startedAt = new Date().toISOString()
  const children = []
  for (const gate of Object.keys(SUB_GATES)) {
    const childOutputDir = options.outputDir
      ? path.join(options.outputDir, 'children', gate.replace(/:/g, '-'))
      : undefined
    const child = runSubGate(gate, env, {
      ...options,
      outputDir: childOutputDir,
    })
    children.push({
      gate: child.gate,
      status: child.status,
      exitCode: child.exitCode,
      deferral: child.deferral,
      delegatedCommand: child.delegatedCommand,
      childReportJson: child.childReportJson,
      childReportMd: child.childReportMd,
    })
  }
  const anyFail = children.some((c) => c.status === 'fail')
  const anyBlocked = children.some((c) => c.status === 'blocked')
  let status = 'pass'
  let exitCode = EXIT_PASS
  let reason = 'All sub-gates passed.'
  if (anyFail) {
    status = 'fail'
    exitCode = EXIT_FAIL
    reason = 'One or more child sub-gates returned FAIL.'
  } else if (anyBlocked) {
    // Critical: BLOCKED must NOT collapse into FAIL. Aggregator returns 2.
    status = 'blocked'
    exitCode = EXIT_BLOCKED
    reason =
      'One or more child sub-gates are BLOCKED. Aggregator exits 2 (BLOCKED); it does not collapse into 1 (FAIL).'
  }
  return {
    tool: TOOL,
    gate: AGGREGATE_GATE,
    status,
    exitCode,
    reason,
    startedAt,
    completedAt: new Date().toISOString(),
    children,
  }
}

export function executeGate(gate, env, options = {}) {
  if (gate === AGGREGATE_GATE) return runAggregate(env, options)
  return runSubGate(gate, env, options)
}

function main(argv) {
  const opts = parseArgs(argv)
  mkdirSync(opts.outputDir, { recursive: true })
  const result = executeGate(opts.gate, process.env, {
    cwd: process.cwd(),
    outputDir: opts.outputDir,
  })
  const report = buildReport(result)
  writeReport({ outputJson: opts.outputJson, outputMd: opts.outputMd, report })
  const summary = redactString(
    `[${TOOL}] gate=${result.gate} status=${result.status} exit=${result.exitCode}`,
  )
  console.log(summary)
  if (opts.allowBlocked && result.status === 'blocked') return EXIT_PASS
  return result.exitCode
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`

if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (err) {
    const msg = redactString(err instanceof Error ? err.message : String(err))
    console.error(`[${TOOL}] ERROR: ${msg}`)
    process.exit(EXIT_FAIL)
  }
}
