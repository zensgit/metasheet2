#!/usr/bin/env tsx
/**
 * Multitable AI provider readiness gate (A1).
 *
 * Run via `pnpm verify:multitable-ai:readiness` (tsx — the script imports the
 * backend TS resolver in-process, mirroring
 * scripts/ops/multitable-email-transport-readiness.ts; plain `node` on a .mjs
 * importing backend TS is forbidden: CI Node 20 has no native type-stripping —
 * review #2478 F1).
 *
 * Exit codes (phase3 release-gate convention; BLOCKED never collapses to FAIL):
 *   0 — ready (declarative env contract satisfied; NO provider call is made)
 *   2 — disabled or blocked (BLOCKED)
 *   1 — script error only
 *
 * Artifacts: JSON + MD under --output-dir (default
 * output/multitable-ai-readiness-gate). Every byte written to stdout, stderr,
 * or the artifacts passes through the shared redactor (defense in depth — the
 * resolver report contains no env values by construction).
 *
 * NOT wired into verify:multitable-release:phase3 — the AI line is tracked by
 * its own staged arc; aggregation is a separate later decision.
 *
 * Usage note: pass flags WITHOUT the npm `--` separator —
 * `pnpm verify:multitable-ai:readiness --output-dir X`. pnpm forwards a
 * literal `--` to the script, and argument parsing is deliberately strict
 * (a misparse must exit 1, never masquerade as 0/2), so the `--` form exits 1.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import aiProviderReadinessModule from '../../packages/core-backend/src/services/ai-provider-readiness.ts'
import automationLogRedactModule from '../../packages/core-backend/src/multitable/automation-log-redact.ts'

const {
  renderAiProviderReadinessMarkdown,
  resolveAiProviderReadiness,
} = aiProviderReadinessModule as typeof import('../../packages/core-backend/src/services/ai-provider-readiness')

const {
  redactString,
  redactValue,
} = automationLogRedactModule as typeof import('../../packages/core-backend/src/multitable/automation-log-redact')

const TOOL = 'multitable-ai-readiness-gate'
const DEFAULT_OUTPUT_DIR = 'output/multitable-ai-readiness-gate'

const EXIT_READY = 0
const EXIT_SCRIPT_ERROR = 1
const EXIT_BLOCKED = 2

interface GateOptions {
  outputDir: string
}

function parseArgs(argv: string[]): GateOptions {
  const opts: GateOptions = {
    outputDir: path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR),
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--output-dir': {
        const value = argv[i + 1]
        if (!value) throw new Error('--output-dir requires a value')
        opts.outputDir = path.resolve(process.cwd(), value)
        i += 1
        break
      }
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return opts
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const report = resolveAiProviderReadiness(process.env)
  // Defensive second layer: structural redaction before serialization.
  const redactedReport = redactValue(report)

  const jsonPath = path.join(opts.outputDir, 'report.json')
  const mdPath = path.join(opts.outputDir, 'report.md')
  await fs.mkdir(opts.outputDir, { recursive: true })
  await fs.writeFile(jsonPath, redactString(`${JSON.stringify(redactedReport, null, 2)}\n`))
  await fs.writeFile(mdPath, redactString(renderAiProviderReadinessMarkdown(report)))

  const exitCode = report.status === 'ready' ? EXIT_READY : EXIT_BLOCKED
  process.stdout.write(redactString(
    `[${TOOL}] status=${report.status} ok=${report.ok} exit=${exitCode}\n`
    + `JSON report: ${jsonPath}\nMarkdown report: ${mdPath}\n`,
  ))

  process.exitCode = exitCode
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(redactString(`[${TOOL}] script error: ${message}\n`))
  process.exitCode = EXIT_SCRIPT_ERROR
})
