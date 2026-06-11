#!/usr/bin/env tsx

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import aiProviderReadinessModule from '../../packages/core-backend/src/services/ai-provider-readiness.ts'
import { redactString, redactValue } from './multitable-phase3-release-gate-redact.mjs'

const {
  renderAiProviderReadinessMarkdown,
  resolveAiProviderReadiness,
} = aiProviderReadinessModule as typeof import('../../packages/core-backend/src/services/ai-provider-readiness')

const PASS = 0
const FAIL = 1
const BLOCKED = 2

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')
const defaultOutputDir = 'output/multitable-ai-provider-readiness'

interface GateOptions {
  outputDir: string
  outputJson: string
  outputMd: string
}

function readRequiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function resolveOutputPath(value: string): string {
  return path.resolve(repoRoot, value)
}

function outputPathFromEnv(envName: string, fallback: string): string {
  const raw = process.env[envName]?.trim()
  return resolveOutputPath(raw || fallback)
}

function parseArgs(argv: string[]): GateOptions {
  let outputDir = process.env.AI_READINESS_OUTPUT_DIR?.trim() || ''
  let outputJson = process.env.AI_READINESS_JSON?.trim() || ''
  let outputMd = process.env.AI_READINESS_MD?.trim() || ''

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help') {
      printHelp()
      process.exit(PASS)
    }
    if (arg === '--output-dir') {
      outputDir = readRequiredValue(argv, i, arg)
      i += 1
      continue
    }
    if (arg === '--output-json') {
      outputJson = readRequiredValue(argv, i, arg)
      i += 1
      continue
    }
    if (arg === '--output-md') {
      outputMd = readRequiredValue(argv, i, arg)
      i += 1
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }

  const resolvedOutputDir = outputDir ? resolveOutputPath(outputDir) : resolveOutputPath(defaultOutputDir)
  return {
    outputDir: resolvedOutputDir,
    outputJson: outputJson ? resolveOutputPath(outputJson) : outputPathFromEnv('AI_READINESS_JSON', path.join(resolvedOutputDir, 'report.json')),
    outputMd: outputMd ? resolveOutputPath(outputMd) : outputPathFromEnv('AI_READINESS_MD', path.join(resolvedOutputDir, 'report.md')),
  }
}

function printHelp(): void {
  process.stdout.write(`Usage: pnpm verify:multitable-ai:readiness [options]

Runs the Multitable AI provider readiness gate. This is a declarative A1 gate:
it validates env shape only and never sends a live provider request.

Options:
  --output-dir <dir>     Output directory, default ${defaultOutputDir}
  --output-json <file>   Output JSON path, default <output-dir>/report.json
  --output-md <file>     Output Markdown path, default <output-dir>/report.md
  --help                 Show this help.

Exit codes:
  0  ready
  1  script failure
  2  disabled or blocked
`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const report = resolveAiProviderReadiness(process.env)
  const safeReport = redactValue(report)
  const markdown = redactString(renderAiProviderReadinessMarkdown(safeReport as typeof report))
  const json = `${redactString(JSON.stringify(safeReport, null, 2))}\n`

  await fs.mkdir(path.dirname(options.outputJson), { recursive: true })
  await fs.mkdir(path.dirname(options.outputMd), { recursive: true })
  await fs.writeFile(options.outputJson, json)
  await fs.writeFile(options.outputMd, markdown)

  process.stdout.write(markdown)
  process.stdout.write(`\nJSON report: ${redactString(options.outputJson)}\nMarkdown report: ${redactString(options.outputMd)}\n`)

  process.exitCode = report.status === 'ready' ? PASS : BLOCKED
}

main().catch((error: unknown) => {
  const message = redactString(error instanceof Error ? error.message : String(error))
  process.stderr.write(`multitable AI provider readiness failed: ${message}\n`)
  process.exitCode = FAIL
})
