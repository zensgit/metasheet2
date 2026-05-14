#!/usr/bin/env node

/**
 * Phase 3 release gate skeleton.
 *
 * Routing + blocked-mode + shared redaction + JSON+MD report writer.
 * All sub-gates are blocked at this PR's stage (D0). Real harnesses
 * land in subsequent PRs (R3 D1 SMTP, R4 D4 automation soak). D2/D3
 * stay blocked under the K3 PoC stage-1 lock.
 *
 * Exit codes:
 *   0  PASS
 *   1  FAIL
 *   2  BLOCKED — never collapsed into FAIL.
 *
 * Email real-send is NOT routed here at D0; the existing
 * `verify:multitable-email:real-send` script (
 * `scripts/ops/multitable-email-real-send-smoke.ts`) is left untouched
 * and will be bound into the aggregator in PR R3.
 *
 * See:
 *   docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md
 *   docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md
 */

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { redactString } from './multitable-phase3-release-gate-redact.mjs'
import { buildReport, writeReport } from './multitable-phase3-release-gate-report.mjs'

const TOOL = 'multitable-phase3-release-gate'
const DEFAULT_OUTPUT_DIR = 'output/multitable-phase3-release-gate'

const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_BLOCKED = 2

const SUB_GATES = {
  'perf:large-table': {
    requiredEnv: ['MULTITABLE_PERF_LARGE_TABLE_CONFIRM', 'MULTITABLE_PERF_TARGET_DB'],
    deferral: 'D2 — Large Table Performance Gate',
    blockedReason:
      'Lane D2 deferred under K3 PoC stage-1 lock. Requires K3-free staging plus T4 closure before activation.',
  },
  'permissions:matrix': {
    requiredEnv: ['MULTITABLE_PERM_MATRIX_CONFIRM'],
    deferral: 'D3 — Permission Matrix Gate',
    blockedReason:
      'Lane D3 deferred. Requires explicit snapshot-vs-golden-matrix semantics decision (T5) before activation.',
  },
  'automation:soak': {
    requiredEnv: ['MULTITABLE_AUTOMATION_SOAK_CONFIRM'],
    deferral: 'D4 — Automation Soak Gate',
    blockedReason:
      'Lane D4 implementation stub. D0 skeleton only; real soak harness lands in PR R4.',
  },
}

const AGGREGATE_GATE = 'release:phase3'
const PUBLIC_GATES = [AGGREGATE_GATE, ...Object.keys(SUB_GATES)]

function printHelp() {
  console.log(`Usage: node scripts/ops/multitable-phase3-release-gate.mjs --gate <id> [options]

Runs the Phase 3 release gate skeleton. All sub-gates are blocked at
the D0 PR stage; only routing, redaction, and report writing are
exercised.

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

function runSubGate(gate, env) {
  const config = SUB_GATES[gate]
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

function runAggregate(env) {
  const startedAt = new Date().toISOString()
  const children = []
  for (const gate of Object.keys(SUB_GATES)) {
    const child = runSubGate(gate, env)
    children.push({
      gate: child.gate,
      status: child.status,
      exitCode: child.exitCode,
      deferral: child.deferral,
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

export function executeGate(gate, env) {
  if (gate === AGGREGATE_GATE) return runAggregate(env)
  return runSubGate(gate, env)
}

function main(argv) {
  const opts = parseArgs(argv)
  mkdirSync(opts.outputDir, { recursive: true })
  const result = executeGate(opts.gate, process.env)
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
