#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const DEFAULT_OUTPUT_ROOT = 'output/dingtalk-p4-regression-gate'
const SCHEMA_VERSION = 1

const OPS_CHECKS = [
  {
    id: 'ops-regression-gate',
    label: 'P4 regression gate runner',
    command: ['node', '--test', 'scripts/ops/dingtalk-p4-regression-gate.test.mjs'],
  },
  {
    id: 'ops-smoke-session',
    label: 'P4 smoke session contract',
    command: ['node', '--test', 'scripts/ops/dingtalk-p4-smoke-session.test.mjs'],
  },
  {
    id: 'ops-smoke-status',
    label: 'P4 smoke status and TODO reporter',
    command: ['node', '--test', 'scripts/ops/dingtalk-p4-smoke-status.test.mjs'],
  },
  {
    id: 'ops-remote-smoke',
    label: 'P4 API-only remote smoke workspace',
    command: ['node', '--test', 'scripts/ops/dingtalk-p4-remote-smoke.test.mjs'],
  },
  {
    id: 'ops-smoke-preflight',
    label: 'P4 remote smoke preflight',
    command: ['node', '--test', 'scripts/ops/dingtalk-p4-smoke-preflight.test.mjs'],
  },
  {
    id: 'ops-compile-evidence',
    label: 'P4 evidence compiler',
    command: ['node', '--test', 'scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs'],
  },
  {
    id: 'ops-evidence-record',
    label: 'P4 manual evidence recorder',
    command: ['node', '--test', 'scripts/ops/dingtalk-p4-evidence-record.test.mjs'],
  },
  {
    id: 'ops-handoff-packet',
    label: 'P4 offline handoff and packet validation',
    command: [
      'node',
      '--test',
      'scripts/ops/dingtalk-p4-offline-handoff.test.mjs',
      'scripts/ops/dingtalk-p4-final-handoff.test.mjs',
      'scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs',
    ],
  },
  {
    id: 'ops-final-docs',
    label: 'P4 final docs generator',
    command: ['node', '--test', 'scripts/ops/dingtalk-p4-final-docs.test.mjs'],
  },
  {
    id: 'ops-mobile-signoff',
    label: 'DingTalk public form mobile signoff tooling',
    command: ['node', '--test', 'scripts/ops/dingtalk-public-form-mobile-signoff.test.mjs'],
  },
  {
    id: 'ops-diff-check',
    label: 'Git whitespace diff check',
    command: ['git', 'diff', '--check'],
  },
]

const PRODUCT_CHECKS = [
  {
    id: 'backend-automation-link-routes',
    label: 'Backend DingTalk automation link routes',
    command: [
      'pnpm',
      '--filter',
      '@metasheet/core-backend',
      'exec',
      'vitest',
      'run',
      'tests/integration/dingtalk-automation-link-routes.api.test.ts',
      '--watch=false',
    ],
  },
  {
    id: 'backend-public-form-flow',
    label: 'Backend public form and DingTalk form flow',
    command: [
      'pnpm',
      '--filter',
      '@metasheet/core-backend',
      'exec',
      'vitest',
      'run',
      'tests/integration/public-form-flow.test.ts',
      '--watch=false',
    ],
  },
  {
    id: 'backend-dingtalk-delivery-routes',
    label: 'Backend DingTalk delivery routes',
    command: [
      'pnpm',
      '--filter',
      '@metasheet/core-backend',
      'exec',
      'vitest',
      'run',
      'tests/integration/dingtalk-delivery-routes.api.test.ts',
      '--watch=false',
    ],
  },
  {
    id: 'backend-dingtalk-group-destination-routes',
    label: 'Backend DingTalk org destination catalog routes',
    command: [
      'pnpm',
      '--filter',
      '@metasheet/core-backend',
      'exec',
      'vitest',
      'run',
      'tests/integration/dingtalk-group-destination-routes.api.test.ts',
      '--watch=false',
    ],
  },
  {
    id: 'backend-dingtalk-services',
    label: 'Backend DingTalk group/person delivery services',
    command: [
      'pnpm',
      '--filter',
      '@metasheet/core-backend',
      'exec',
      'vitest',
      'run',
      'tests/unit/dingtalk-group-destination-service.test.ts',
      'tests/unit/dingtalk-person-delivery-service.test.ts',
      '--watch=false',
    ],
  },
  {
    id: 'backend-automation-v1',
    label: 'Backend automation v1 DingTalk org catalog contracts',
    command: [
      'pnpm',
      '--filter',
      '@metasheet/core-backend',
      'exec',
      'vitest',
      'run',
      'tests/unit/automation-v1.test.ts',
      '--watch=false',
    ],
  },
  {
    id: 'web-api-token-manager',
    label: 'Web API token manager DingTalk group binding UI',
    command: [
      'pnpm',
      '--filter',
      '@metasheet/web',
      'exec',
      'vitest',
      'run',
      'tests/multitable-api-token-manager.spec.ts',
      '--watch=false',
    ],
  },
  {
    id: 'web-form-share-manager',
    label: 'Web form share manager DingTalk access UI',
    command: [
      'pnpm',
      '--filter',
      '@metasheet/web',
      'exec',
      'vitest',
      'run',
      'tests/multitable-form-share-manager.spec.ts',
      '--watch=false',
    ],
  },
  {
    id: 'web-public-multitable-form',
    label: 'Web public multitable form DingTalk runtime UI',
    command: [
      'pnpm',
      '--filter',
      '@metasheet/web',
      'exec',
      'vitest',
      'run',
      'tests/public-multitable-form.spec.ts',
      '--watch=false',
    ],
  },
  {
    id: 'web-automation-manager',
    label: 'Web automation manager DingTalk destination catalog UI',
    command: [
      'pnpm',
      '--filter',
      '@metasheet/web',
      'exec',
      'vitest',
      'run',
      'tests/multitable-automation-manager.spec.ts',
      '--watch=false',
    ],
  },
  {
    id: 'web-automation-rule-editor',
    label: 'Web automation rule editor DingTalk destination catalog UI',
    command: [
      'pnpm',
      '--filter',
      '@metasheet/web',
      'exec',
      'vitest',
      'run',
      'tests/multitable-automation-rule-editor.spec.ts',
      '--watch=false',
    ],
  },
  {
    id: 'web-multitable-client',
    label: 'Web multitable client DingTalk form client coverage',
    command: [
      'pnpm',
      '--filter',
      '@metasheet/web',
      'exec',
      'vitest',
      'run',
      'tests/multitable-client.spec.ts',
      '--watch=false',
    ],
  },
  {
    id: 'backend-build',
    label: 'Backend build',
    command: ['pnpm', '--filter', '@metasheet/core-backend', 'build'],
  },
  {
    id: 'web-build',
    label: 'Web build',
    command: ['pnpm', '--filter', '@metasheet/web', 'build'],
  },
]

const SELFTEST_CHECKS = [
  {
    id: 'selftest-pass',
    label: 'Runner selftest pass',
    command: ['node', '-e', "console.log('dingtalk-p4-regression-gate selftest ok')"],
  },
]

const SELFTEST_SECRET_CHECKS = [
  {
    id: 'selftest-secret-redaction',
    label: 'Runner selftest secret redaction',
    command: [
      'node',
      '-e',
      "console.log('Bearer abcdefghijklmnopqrstuvwxyz1234567890 access_token=0123456789abcdef0123456789abcdef SECabcdefghijklmnop12345678 publicToken=public-0123456789')",
    ],
  },
]

const PROFILES = new Map([
  ['ops', OPS_CHECKS],
  ['product', PRODUCT_CHECKS],
  ['all', [...OPS_CHECKS, ...PRODUCT_CHECKS]],
  ['selftest', SELFTEST_CHECKS],
  ['selftest-secret', SELFTEST_SECRET_CHECKS],
])

const PUBLIC_PROFILES = ['ops', 'product', 'all']

function printHelp() {
  console.log(`Usage: node scripts/ops/dingtalk-p4-regression-gate.mjs [options]

Runs or plans the local DingTalk P4 regression gate and writes redacted JSON/MD
summaries. It does not call DingTalk or staging by itself; product checks only
run when this command is explicitly executed with a non-plan profile.

Options:
  --profile <ops|product|all>   Check profile to run, default ops
  --plan-only                   Write the selected command plan without executing checks
  --output-dir <dir>            Output directory, default ${DEFAULT_OUTPUT_ROOT}/<run-id>
  --summary-json <file>         Summary JSON path, default <output-dir>/summary.json
  --summary-md <file>           Summary Markdown path, default <output-dir>/summary.md
  --timeout-ms <ms>             Per-check timeout; default 0 means no timeout
  --fail-fast                   Stop after the first failed check
  --allow-failures              Exit 0 even if checks fail
  --help                        Show this help
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
  return `dingtalk-p4-regression-${new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')}`
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
    profile: 'ops',
    planOnly: false,
    outputDir: '',
    summaryJson: '',
    summaryMd: '',
    timeoutMs: 0,
    failFast: false,
    allowFailures: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--profile':
        opts.profile = readRequiredValue(argv, i, arg).trim()
        i += 1
        break
      case '--plan-only':
        opts.planOnly = true
        break
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--summary-json':
        opts.summaryJson = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--summary-md':
        opts.summaryMd = path.resolve(process.cwd(), readRequiredValue(argv, i, arg))
        i += 1
        break
      case '--timeout-ms':
        opts.timeoutMs = parsePositiveInteger(readRequiredValue(argv, i, arg), arg, { allowZero: true })
        i += 1
        break
      case '--fail-fast':
        opts.failFast = true
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

  if (!PROFILES.has(opts.profile)) {
    throw new Error(`--profile must be one of: ${PUBLIC_PROFILES.join(', ')}`)
  }

  if (!opts.outputDir) {
    opts.outputDir = path.resolve(process.cwd(), DEFAULT_OUTPUT_ROOT, makeRunId())
  }
  opts.summaryJson ||= path.join(opts.outputDir, 'summary.json')
  opts.summaryMd ||= path.join(opts.outputDir, 'summary.md')
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

function quoteShellArg(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(text)) return text
  return `'${text.replaceAll("'", "'\\''")}'`
}

function commandText(command) {
  return command.map((part) => quoteShellArg(part)).join(' ')
}

function relativePath(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function ensureOutputDir(opts) {
  mkdirSync(opts.outputDir, { recursive: true })
  mkdirSync(path.join(opts.outputDir, 'logs'), { recursive: true })
}

function writeLog(opts, checkId, stream, content) {
  const file = path.join(opts.outputDir, 'logs', `${checkId}.${stream}.log`)
  writeFileSync(file, redactString(content), 'utf8')
  return file
}

function compactText(value) {
  const text = redactString(value ?? '').trim()
  if (!text) return ''
  return text.length > 1200 ? `${text.slice(0, 1197)}...` : text
}

function planCheck(check) {
  return {
    id: check.id,
    label: check.label,
    command: commandText(check.command),
    status: 'skipped',
    skippedReason: 'plan_only',
    exitCode: null,
    durationMs: 0,
    stdoutLog: null,
    stderrLog: null,
    stdoutSample: '',
    stderrSample: '',
  }
}

function runCheck(opts, check) {
  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const [bin, ...args] = check.command
  const result = spawnSync(bin, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: opts.timeoutMs > 0 ? opts.timeoutMs : undefined,
    maxBuffer: 20 * 1024 * 1024,
  })
  const finishedAt = new Date().toISOString()
  const durationMs = Date.now() - startedMs
  const timedOut = result.error?.code === 'ETIMEDOUT'
  const exitCode = timedOut ? 124 : result.status ?? 1
  const stdoutLog = writeLog(opts, check.id, 'stdout', result.stdout ?? '')
  const stderrLog = writeLog(opts, check.id, 'stderr', result.stderr ?? String(result.error?.message ?? ''))

  return {
    id: check.id,
    label: check.label,
    command: commandText(check.command),
    status: exitCode === 0 ? 'pass' : 'fail',
    exitCode,
    durationMs,
    startedAt,
    finishedAt,
    timedOut,
    stdoutLog: relativePath(stdoutLog),
    stderrLog: relativePath(stderrLog),
    stdoutSample: compactText(result.stdout),
    stderrSample: compactText(result.stderr || result.error?.message || ''),
  }
}

function buildTotals(checks) {
  const totals = {
    total: checks.length,
    passed: checks.filter((check) => check.status === 'pass').length,
    failed: checks.filter((check) => check.status === 'fail').length,
    skipped: checks.filter((check) => check.status === 'skipped').length,
  }
  return totals
}

function renderMarkdown(summary) {
  const lines = [
    '# DingTalk P4 Regression Gate',
    '',
    `- Profile: \`${summary.profile}\``,
    `- Overall status: **${summary.overallStatus}**`,
    `- Plan only: \`${summary.planOnly}\``,
    `- Started at: \`${summary.startedAt}\``,
    `- Completed at: \`${summary.completedAt}\``,
    `- Totals: ${summary.totals.passed} passed, ${summary.totals.failed} failed, ${summary.totals.skipped} skipped, ${summary.totals.total} total`,
    '',
    '## Checks',
    '',
    '| Check | Status | Exit | Duration | Command | Logs |',
    '| --- | --- | ---: | ---: | --- | --- |',
  ]

  for (const check of summary.checks) {
    const logs = check.stdoutLog
      ? `[stdout](${check.stdoutLog}) / [stderr](${check.stderrLog})`
      : check.skippedReason ?? ''
    lines.push(`| \`${check.id}\` | ${check.status} | ${check.exitCode ?? ''} | ${check.durationMs}ms | \`${check.command.replaceAll('|', '\\|')}\` | ${logs} |`)
  }

  const failures = summary.checks.filter((check) => check.status === 'fail')
  if (failures.length > 0) {
    lines.push('')
    lines.push('## Failures')
    lines.push('')
    for (const check of failures) {
      const note = check.stderrSample || check.stdoutSample || 'No output captured.'
      lines.push(`- \`${check.id}\`: ${note.replace(/\s+/g, ' ')}`)
    }
  }

  return `${lines.join('\n')}\n`
}

function writeSummary(opts, summary) {
  mkdirSync(path.dirname(opts.summaryJson), { recursive: true })
  mkdirSync(path.dirname(opts.summaryMd), { recursive: true })
  writeFileSync(opts.summaryJson, `${JSON.stringify(sanitizeValue(summary), null, 2)}\n`, 'utf8')
  writeFileSync(opts.summaryMd, renderMarkdown(sanitizeValue(summary)), 'utf8')
}

function run(opts) {
  ensureOutputDir(opts)
  const startedAt = new Date().toISOString()
  const selectedChecks = PROFILES.get(opts.profile)
  const checks = []

  for (const check of selectedChecks) {
    if (opts.planOnly) {
      checks.push(planCheck(check))
      continue
    }

    const result = runCheck(opts, check)
    checks.push(result)
    if (result.status === 'fail' && opts.failFast) break
  }

  const totals = buildTotals(checks)
  const overallStatus = opts.planOnly ? 'plan_only' : totals.failed > 0 ? 'fail' : 'pass'
  const summary = {
    tool: 'dingtalk-p4-regression-gate',
    schemaVersion: SCHEMA_VERSION,
    profile: opts.profile,
    planOnly: opts.planOnly,
    failFast: opts.failFast,
    allowFailures: opts.allowFailures,
    timeoutMs: opts.timeoutMs,
    outputDir: relativePath(opts.outputDir),
    summaryJson: relativePath(opts.summaryJson),
    summaryMd: relativePath(opts.summaryMd),
    startedAt,
    completedAt: new Date().toISOString(),
    overallStatus,
    totals,
    checks,
  }

  writeSummary(opts, summary)
  console.log(`[dingtalk-p4-regression-gate] ${overallStatus}: ${relativePath(opts.summaryJson)}`)
  return overallStatus === 'fail' && !opts.allowFailures ? 1 : 0
}

try {
  const opts = parseArgs(process.argv.slice(2))
  process.exit(run(opts))
} catch (error) {
  console.error(`[dingtalk-p4-regression-gate] ERROR: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
