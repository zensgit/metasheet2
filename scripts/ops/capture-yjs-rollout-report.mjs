#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function printHelp() {
  console.log(`Usage: node scripts/ops/capture-yjs-rollout-report.mjs [options]

Captures one combined Yjs rollout report from:
- runtime status
- retention/storage health

Options:
  --base-url <url>        Base URL, default from YJS_BASE_URL or http://localhost:3000
  --token <token>         Admin bearer token, default from YJS_ADMIN_TOKEN or ADMIN_TOKEN
  --database-url <url>    Database URL, default from YJS_DATABASE_URL or DATABASE_URL
  --output-dir <dir>      Output directory, default artifacts/yjs-rollout
  --help                  Show this help
`)
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.YJS_BASE_URL || 'http://localhost:3000',
    token: process.env.YJS_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '',
    databaseUrl: process.env.YJS_DATABASE_URL || process.env.DATABASE_URL || '',
    outputDir: path.resolve(process.cwd(), 'artifacts/yjs-rollout'),
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    switch (arg) {
      case '--base-url':
        opts.baseUrl = next
        i += 1
        break
      case '--token':
        opts.token = next
        i += 1
        break
      case '--database-url':
        opts.databaseUrl = next
        i += 1
        break
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

function runNodeScript(scriptPath, args, extraEnv = {}) {
  const result = spawnSync('node', [scriptPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...extraEnv,
    },
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0 && result.status !== 2) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${path.basename(scriptPath)} exited with status ${result.status}`)
  }

  return {
    exitCode: result.status ?? 1,
    payload: JSON.parse(result.stdout.trim()),
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new Error(`Incomplete ${label}: expected boolean`)
  }
}

function assertNonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Incomplete ${label}: expected non-negative number`)
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`Incomplete ${label}: expected array`)
  }
}

function validateRuntimePayload(payload) {
  if (!isPlainObject(payload)) {
    throw new Error('Incomplete runtime payload: expected object')
  }
  if (typeof payload.baseUrl !== 'string' || payload.baseUrl.trim().length === 0) {
    throw new Error('Incomplete runtime payload: missing baseUrl')
  }
  if (!isPlainObject(payload.metrics)) {
    throw new Error('Incomplete runtime payload: missing metrics object')
  }

  const { metrics } = payload
  assertBoolean(metrics.enabled, 'runtime payload metrics.enabled')
  assertBoolean(metrics.initialized, 'runtime payload metrics.initialized')
  assertNonNegativeNumber(metrics.activeDocCount, 'runtime payload metrics.activeDocCount')
  assertNonNegativeNumber(metrics.pendingWriteCount, 'runtime payload metrics.pendingWriteCount')
  assertNonNegativeNumber(metrics.flushSuccessCount, 'runtime payload metrics.flushSuccessCount')
  assertNonNegativeNumber(metrics.flushFailureCount, 'runtime payload metrics.flushFailureCount')
  assertNonNegativeNumber(metrics.activeSocketCount, 'runtime payload metrics.activeSocketCount')
  assertNonNegativeNumber(metrics.activeRecordCount, 'runtime payload metrics.activeRecordCount')
  assertArray(payload.failures, 'runtime payload failures')
}

function validateRetentionPayload(payload) {
  if (!isPlainObject(payload)) {
    throw new Error('Incomplete retention payload: expected object')
  }
  if (!isPlainObject(payload.stats)) {
    throw new Error('Incomplete retention payload: missing stats object')
  }

  const { stats } = payload
  assertNonNegativeNumber(stats.statesCount, 'retention payload stats.statesCount')
  assertNonNegativeNumber(stats.updatesCount, 'retention payload stats.updatesCount')
  assertNonNegativeNumber(stats.orphanStatesCount, 'retention payload stats.orphanStatesCount')
  assertNonNegativeNumber(stats.orphanUpdatesCount, 'retention payload stats.orphanUpdatesCount')
  assertArray(payload.failures, 'retention payload failures')
  assertArray(payload.hottestRecords, 'retention payload hottestRecords')
}

function toHeadline(result) {
  return result.exitCode === 0 ? 'HEALTHY' : 'UNHEALTHY'
}

function renderMarkdown(report) {
  const runtime = report.runtime.payload
  const retention = report.retention.payload

  return `# Yjs Rollout Report

Date: ${report.generatedAt}

## Runtime

- status: ${toHeadline(report.runtime)}
- base URL: ${runtime.baseUrl}
- enabled: ${runtime.metrics.enabled}
- initialized: ${runtime.metrics.initialized}
- active docs: ${runtime.metrics.activeDocCount}
- pending writes: ${runtime.metrics.pendingWriteCount}
- flush failures: ${runtime.metrics.flushFailureCount}
- active sockets: ${runtime.metrics.activeSocketCount}

## Retention

- status: ${toHeadline(report.retention)}
- states count: ${retention.stats.statesCount}
- updates count: ${retention.stats.updatesCount}
- orphan states: ${retention.stats.orphanStatesCount}
- orphan updates: ${retention.stats.orphanUpdatesCount}

## Hottest Records

${Array.isArray(retention.hottestRecords) && retention.hottestRecords.length > 0
    ? retention.hottestRecords.map((row) => `- ${row.record_id}: ${row.updateCount ?? row.updatecount}`).join('\n')
    : '- none'}

## Failures

### Runtime

${runtime.failures.length > 0 ? runtime.failures.map((failure) => `- ${failure}`).join('\n') : '- none'}

### Retention

${retention.failures.length > 0 ? retention.failures.map((failure) => `- ${failure}`).join('\n') : '- none'}
`
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2))
    if (!opts.token) {
      console.error('Missing admin token. Use --token, YJS_ADMIN_TOKEN, or ADMIN_TOKEN.')
      process.exit(1)
    }
    if (!opts.databaseUrl) {
      console.error('Missing database URL. Use --database-url, YJS_DATABASE_URL, or DATABASE_URL.')
      process.exit(1)
    }

    const runtimeScript = path.resolve(process.cwd(), 'scripts/ops/check-yjs-rollout-status.mjs')
    const retentionScript = path.resolve(process.cwd(), 'scripts/ops/check-yjs-retention-health.mjs')

    const runtime = runNodeScript(runtimeScript, ['--json-only'], {
      YJS_BASE_URL: opts.baseUrl,
      YJS_ADMIN_TOKEN: opts.token,
    })
    const retention = runNodeScript(retentionScript, ['--json-only'], {
      YJS_DATABASE_URL: opts.databaseUrl,
    })

    validateRuntimePayload(runtime.payload)
    validateRetentionPayload(retention.payload)

    const generatedAt = new Date().toISOString()
    const timestamp = generatedAt.replace(/[:.]/g, '-')
    mkdirSync(opts.outputDir, { recursive: true })

    const report = {
      generatedAt,
      runtime,
      retention,
    }

    const jsonPath = path.join(opts.outputDir, `yjs-rollout-report-${timestamp}.json`)
    const mdPath = path.join(opts.outputDir, `yjs-rollout-report-${timestamp}.md`)

    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    writeFileSync(mdPath, `${renderMarkdown(report)}\n`, 'utf8')

    console.log(`Wrote ${jsonPath}`)
    console.log(`Wrote ${mdPath}`)

    const exitCode = runtime.exitCode === 0 && retention.exitCode === 0 ? 0 : 2
    process.exit(exitCode)
  } catch (error) {
    console.error(`Failed to capture Yjs rollout report: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

await main()
