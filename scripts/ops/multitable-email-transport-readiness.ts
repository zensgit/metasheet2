#!/usr/bin/env tsx

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import emailTransportReadinessModule from '../../packages/core-backend/src/services/email-transport-readiness.ts'

const {
  renderEmailTransportReadinessMarkdown,
  resolveEmailTransportReadiness,
} = emailTransportReadinessModule as typeof import('../../packages/core-backend/src/services/email-transport-readiness')

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')

function outputPath(envName: string, fallback: string): string {
  const raw = process.env[envName]?.trim()
  return path.resolve(repoRoot, raw || fallback)
}

async function main(): Promise<void> {
  const report = resolveEmailTransportReadiness(process.env)
  const jsonPath = outputPath('EMAIL_READINESS_JSON', 'output/multitable-email-transport-readiness/report.json')
  const mdPath = outputPath('EMAIL_READINESS_MD', 'output/multitable-email-transport-readiness/report.md')
  const markdown = renderEmailTransportReadinessMarkdown(report)

  await fs.mkdir(path.dirname(jsonPath), { recursive: true })
  await fs.mkdir(path.dirname(mdPath), { recursive: true })
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  await fs.writeFile(mdPath, markdown)

  process.stdout.write(markdown)
  process.stdout.write(`\nJSON report: ${jsonPath}\nMarkdown report: ${mdPath}\n`)

  process.exitCode = report.ok ? 0 : 2
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`multitable email transport readiness failed: ${message}\n`)
  process.exitCode = 1
})
