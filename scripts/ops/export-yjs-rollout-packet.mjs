#!/usr/bin/env node

import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

function printHelp() {
  console.log(`Usage: node scripts/ops/export-yjs-rollout-packet.mjs [options]

Exports the current Yjs rollout execution packet into one artifact directory.

Options:
  --output-dir <dir>   Output directory, default artifacts/yjs-rollout-packet
  --help               Show this help
`)
}

function parseArgs(argv) {
  const opts = {
    outputDir: path.resolve(process.cwd(), 'artifacts/yjs-rollout-packet'),
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    switch (arg) {
      case '--output-dir':
        opts.outputDir = path.resolve(process.cwd(), next)
        i += 1
        break
      case '--help':
        printHelp()
        process.exit(0)
      default:
        console.error(`Unknown argument: ${arg}`)
        printHelp()
        process.exit(1)
    }
  }

  return opts
}

const packetFiles = [
  'docs/operations/yjs-internal-rollout-checklist-20260416.md',
  'docs/operations/yjs-internal-rollout-execution-20260416.md',
  'docs/operations/yjs-ops-runbook-20260416.md',
  'docs/operations/yjs-retention-policy-20260416.md',
  'docs/operations/yjs-rollout-report-capture-20260416.md',
  'scripts/ops/check-yjs-rollout-status.mjs',
  'scripts/ops/check-yjs-retention-health.mjs',
  'scripts/ops/capture-yjs-rollout-report.mjs',
]

function renderReadme(outputDir) {
  const rel = (file) => path.relative(outputDir, path.resolve(process.cwd(), file)).replaceAll('\\', '/')
  return `# Yjs Rollout Packet

Generated at: ${new Date().toISOString()}

## Included Docs

- ${rel('docs/operations/yjs-internal-rollout-checklist-20260416.md')}
- ${rel('docs/operations/yjs-internal-rollout-execution-20260416.md')}
- ${rel('docs/operations/yjs-ops-runbook-20260416.md')}
- ${rel('docs/operations/yjs-retention-policy-20260416.md')}
- ${rel('docs/operations/yjs-rollout-report-capture-20260416.md')}

## Included Scripts

- ${rel('scripts/ops/check-yjs-rollout-status.mjs')}
- ${rel('scripts/ops/check-yjs-retention-health.mjs')}
- ${rel('scripts/ops/capture-yjs-rollout-report.mjs')}

## Recommended Order

1. Read the checklist
2. Run the runtime status check
3. Run the retention health check
4. Run the combined report capture
5. Store generated report artifacts alongside the rollout packet
`
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  mkdirSync(opts.outputDir, { recursive: true })

  for (const file of packetFiles) {
    const source = path.resolve(process.cwd(), file)
    const destination = path.join(opts.outputDir, file)
    mkdirSync(path.dirname(destination), { recursive: true })
    cpSync(source, destination)
    console.log(`Copied ${file}`)
  }

  const readmePath = path.join(opts.outputDir, 'README.md')
  writeFileSync(readmePath, `${renderReadme(opts.outputDir)}\n`, 'utf8')
  console.log(`Wrote ${path.relative(process.cwd(), readmePath)}`)
}

await main()
