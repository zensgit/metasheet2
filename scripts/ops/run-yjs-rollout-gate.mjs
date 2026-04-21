#!/usr/bin/env node

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function printHelp() {
  console.log(`Usage: node scripts/ops/run-yjs-rollout-gate.mjs [options]

Runs the Yjs internal rollout gate sequence:
- runtime status check
- retention health check
- packet export
- rollout report capture
- signoff draft prefill

Options:
  --base-url <url>        Base URL, default from YJS_BASE_URL or http://localhost:3000
  --token <token>         Admin bearer token, default from YJS_ADMIN_TOKEN or ADMIN_TOKEN
  --database-url <url>    Database URL, default from YJS_DATABASE_URL or DATABASE_URL
  --output-dir <dir>      Output directory, default artifacts/yjs-rollout-gate
  --print-plan            Print the execution plan only
  --help                  Show this help
`)
}

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.YJS_BASE_URL || 'http://localhost:3000',
    token: process.env.YJS_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '',
    databaseUrl: process.env.YJS_DATABASE_URL || process.env.DATABASE_URL || '',
    outputDir: path.resolve(process.cwd(), 'artifacts/yjs-rollout-gate'),
    printPlan: false,
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
      case '--print-plan':
        opts.printPlan = true
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

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function printPlan(opts) {
  console.log('Yjs rollout gate plan')
  console.log(`- base URL: ${opts.baseUrl}`)
  console.log(`- output dir: ${opts.outputDir}`)
  console.log(`- token present: ${Boolean(opts.token)}`)
  console.log(`- database URL present: ${Boolean(opts.databaseUrl)}`)
  console.log('- steps:')
  console.log('  1. check-yjs-rollout-status.mjs')
  console.log('  2. check-yjs-retention-health.mjs')
  console.log('  3. export-yjs-rollout-packet.mjs')
  console.log('  4. capture-yjs-rollout-report.mjs')
  console.log('  5. prefill signoff draft into gate output directory')
}

function extractFirstWrittenJsonPath(stdout) {
  const match = stdout.match(/Wrote\s+(.+\.json)/)
  return match ? match[1].trim() : ''
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.printPlan) {
    printPlan(opts)
    process.exit(0)
  }

  if (!opts.token) {
    console.error('Missing admin token. Use --token, YJS_ADMIN_TOKEN, or ADMIN_TOKEN.')
    process.exit(1)
  }
  if (!opts.databaseUrl) {
    console.error('Missing database URL. Use --database-url, YJS_DATABASE_URL, or DATABASE_URL.')
    process.exit(1)
  }

  const statusScript = path.resolve(process.cwd(), 'scripts/ops/check-yjs-rollout-status.mjs')
  const retentionScript = path.resolve(process.cwd(), 'scripts/ops/check-yjs-retention-health.mjs')
  const exportScript = path.resolve(process.cwd(), 'scripts/ops/export-yjs-rollout-packet.mjs')
  const reportScript = path.resolve(process.cwd(), 'scripts/ops/capture-yjs-rollout-report.mjs')
  const signoffScript = path.resolve(process.cwd(), 'scripts/ops/prefill-yjs-rollout-signoff.mjs')

  const packetDir = path.join(opts.outputDir, 'packet')
  const reportsDir = path.join(opts.outputDir, 'reports')
  const statusPath = path.join(opts.outputDir, 'status.json')
  const retentionPath = path.join(opts.outputDir, 'retention.json')
  mkdirSync(opts.outputDir, { recursive: true })

  const statusResult = runNodeScript(statusScript, ['--json-only'], {
    YJS_BASE_URL: opts.baseUrl,
    YJS_ADMIN_TOKEN: opts.token,
  })
  if (statusResult.exitCode !== 0 && statusResult.exitCode !== 2) {
    process.stderr.write(statusResult.stderr)
    process.exit(statusResult.exitCode)
  }
  writeFileSync(statusPath, statusResult.stdout, 'utf8')

  const retentionResult = runNodeScript(retentionScript, ['--json-only'], {
    YJS_DATABASE_URL: opts.databaseUrl,
  })
  if (retentionResult.exitCode !== 0 && retentionResult.exitCode !== 2) {
    process.stderr.write(retentionResult.stderr)
    process.exit(retentionResult.exitCode)
  }
  writeFileSync(retentionPath, retentionResult.stdout, 'utf8')

  const exportResult = runNodeScript(exportScript, ['--output-dir', packetDir])
  if (exportResult.exitCode !== 0) {
    process.stderr.write(exportResult.stderr)
    process.exit(exportResult.exitCode)
  }

  const reportResult = runNodeScript(reportScript, ['--output-dir', reportsDir], {
    YJS_BASE_URL: opts.baseUrl,
    YJS_ADMIN_TOKEN: opts.token,
    YJS_DATABASE_URL: opts.databaseUrl,
  })
  if (reportResult.exitCode !== 0 && reportResult.exitCode !== 2) {
    process.stderr.write(reportResult.stderr)
    process.exit(reportResult.exitCode)
  }

  const reportJsonPath =
    extractFirstWrittenJsonPath(reportResult.stdout) ||
    readdirSync(reportsDir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => path.join(reportsDir, file))
      .at(-1) ||
    ''

  const signoffCopy = path.join(opts.outputDir, 'yjs-internal-rollout-signoff.md')
  const signoffResult = runNodeScript(
    signoffScript,
    [
      '--status-json',
      statusPath,
      '--retention-json',
      retentionPath,
      '--output-path',
      signoffCopy,
      '--packet-dir',
      packetDir,
      ...(reportJsonPath ? ['--report-json', reportJsonPath] : []),
    ],
    {
      YJS_TRIAL_ENVIRONMENT: process.env.YJS_TRIAL_ENVIRONMENT || '',
      YJS_TRIAL_OWNER: process.env.YJS_TRIAL_OWNER || '',
      YJS_TRIAL_REVIEWER: process.env.YJS_TRIAL_REVIEWER || '',
      YJS_TRIAL_WINDOW: process.env.YJS_TRIAL_WINDOW || '',
      ENABLE_YJS_COLLAB: process.env.ENABLE_YJS_COLLAB || 'true',
      YJS_TRIAL_SHEETS: process.env.YJS_TRIAL_SHEETS || '',
      YJS_TRIAL_USERS: process.env.YJS_TRIAL_USERS || '',
      YJS_TRIAL_USER_COUNT: process.env.YJS_TRIAL_USER_COUNT || '',
      YJS_TRIAL_EXCLUDED_SHEETS: process.env.YJS_TRIAL_EXCLUDED_SHEETS || '',
    }
  )
  if (signoffResult.exitCode !== 0) {
    process.stderr.write(signoffResult.stderr)
    process.exit(signoffResult.exitCode)
  }

  console.log(`Wrote status snapshot: ${statusPath}`)
  console.log(`Wrote retention snapshot: ${retentionPath}`)
  console.log(`Wrote packet: ${packetDir}`)
  console.log(`Wrote reports: ${reportsDir}`)
  console.log(`Wrote signoff draft: ${signoffCopy}`)

  const unhealthy = statusResult.exitCode === 2 || retentionResult.exitCode === 2 || reportResult.exitCode === 2
  process.exit(unhealthy ? 2 : 0)
}

await main()
