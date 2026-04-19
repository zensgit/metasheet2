#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

function printHelp() {
  console.log(`Usage: node scripts/ops/prefill-yjs-rollout-signoff.mjs [options]

Prefills the Yjs internal rollout signoff template with runtime, retention,
evidence, and rollout-context values so the remaining human trial results can
be filled in manually.

Options:
  --status-json <path>       Runtime status JSON path (required)
  --retention-json <path>    Retention JSON path (required)
  --report-json <path>       Combined rollout report JSON path
  --packet-dir <path>        Packet export directory path
  --output-path <path>       Output markdown path (required)
  --environment <value>      Rollout environment label
  --owner <value>            Rollout owner
  --approver <value>         Review approver
  --window <value>           Rollout window
  --enabled-value <value>    ENABLE_YJS_COLLAB value
  --pilot-sheets <value>     Pilot sheets summary
  --pilot-users <value>      Pilot users summary
  --expected-users <value>   Expected concurrent editors
  --excluded-sheets <value>  Excluded critical sheets
  --help                     Show this help
`)
}

function parseArgs(argv) {
  const opts = {
    statusJson: '',
    retentionJson: '',
    reportJson: '',
    packetDir: '',
    outputPath: '',
    environment: process.env.YJS_TRIAL_ENVIRONMENT || '',
    owner: process.env.YJS_TRIAL_OWNER || '',
    approver: process.env.YJS_TRIAL_REVIEWER || '',
    window: process.env.YJS_TRIAL_WINDOW || '',
    enabledValue: process.env.ENABLE_YJS_COLLAB || 'true',
    pilotSheets: process.env.YJS_TRIAL_SHEETS || '',
    pilotUsers: process.env.YJS_TRIAL_USERS || '',
    expectedUsers: process.env.YJS_TRIAL_USER_COUNT || '',
    excludedSheets: process.env.YJS_TRIAL_EXCLUDED_SHEETS || '',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]

    switch (arg) {
      case '--status-json':
        opts.statusJson = path.resolve(process.cwd(), next)
        i += 1
        break
      case '--retention-json':
        opts.retentionJson = path.resolve(process.cwd(), next)
        i += 1
        break
      case '--report-json':
        opts.reportJson = path.resolve(process.cwd(), next)
        i += 1
        break
      case '--packet-dir':
        opts.packetDir = path.resolve(process.cwd(), next)
        i += 1
        break
      case '--output-path':
        opts.outputPath = path.resolve(process.cwd(), next)
        i += 1
        break
      case '--environment':
        opts.environment = next
        i += 1
        break
      case '--owner':
        opts.owner = next
        i += 1
        break
      case '--approver':
        opts.approver = next
        i += 1
        break
      case '--window':
        opts.window = next
        i += 1
        break
      case '--enabled-value':
        opts.enabledValue = next
        i += 1
        break
      case '--pilot-sheets':
        opts.pilotSheets = next
        i += 1
        break
      case '--pilot-users':
        opts.pilotUsers = next
        i += 1
        break
      case '--expected-users':
        opts.expectedUsers = next
        i += 1
        break
      case '--excluded-sheets':
        opts.excludedSheets = next
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

  if (!opts.statusJson || !opts.retentionJson || !opts.outputPath) {
    console.error('Missing required arguments: --status-json, --retention-json, and --output-path are required.')
    printHelp()
    process.exit(1)
  }

  return opts
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function relFromOutput(outputPath, targetPath) {
  if (!targetPath) {
    return ''
  }

  return path.relative(path.dirname(outputPath), targetPath).replaceAll('\\', '/')
}

function lineValue(value) {
  return value || '(fill in)'
}

function renderSignoff({
  outputPath,
  statusJsonPath,
  retentionJsonPath,
  reportJsonPath,
  packetDir,
  status,
  retention,
  opts,
}) {
  const metrics = status.metrics || {}
  const stats = retention.stats || {}
  const hottestRecord = retention.hottestRecords?.[0]

  return `# Yjs Internal Rollout Signoff

Date: ${new Date().toISOString().slice(0, 10)}

Use this after the first limited internal rollout run.

## Rollout Context

- Environment: ${lineValue(opts.environment)}
- Rollout owner: ${lineValue(opts.owner)}
- Review approver: ${lineValue(opts.approver)}
- Rollout window: ${lineValue(opts.window)}
- Enabled by: ${lineValue(opts.owner)}
- \`ENABLE_YJS_COLLAB\` value: ${lineValue(opts.enabledValue)}

## Target Scope

- Pilot sheets: ${lineValue(opts.pilotSheets)}
- Pilot users: ${lineValue(opts.pilotUsers)}
- Expected concurrent editors: ${lineValue(opts.expectedUsers)}
- Excluded critical sheets: ${lineValue(opts.excludedSheets)}

## Evidence

- Runtime status report path: ${relFromOutput(outputPath, statusJsonPath)}
- Retention health report path: ${relFromOutput(outputPath, retentionJsonPath)}
- Combined rollout report path: ${lineValue(relFromOutput(outputPath, reportJsonPath))}
- Packet export path: ${lineValue(relFromOutput(outputPath, packetDir))}

## Runtime Snapshot

- \`enabled\`: ${String(metrics.enabled)}
- \`initialized\`: ${String(metrics.initialized)}
- \`activeDocCount\`: ${String(metrics.activeDocCount ?? '(missing)')}
- \`pendingWriteCount\`: ${String(metrics.pendingWriteCount ?? '(missing)')}
- \`flushFailureCount\`: ${String(metrics.flushFailureCount ?? '(missing)')}
- \`activeSocketCount\`: ${String(metrics.activeSocketCount ?? '(missing)')}

## Retention Snapshot

- \`statesCount\`: ${String(stats.statesCount ?? '(missing)')}
- \`updatesCount\`: ${String(stats.updatesCount ?? '(missing)')}
- \`orphanStatesCount\`: ${String(stats.orphanStatesCount ?? '(missing)')}
- \`orphanUpdatesCount\`: ${String(stats.orphanUpdatesCount ?? '(missing)')}
- Hottest record observed: ${hottestRecord ? `${hottestRecord.docId} (${hottestRecord.updateCount} updates)` : 'none'}

## User Validation

- Text field collaborative editing verified:
- Reconnect / resume verified:
- Presence / awareness verified:
- Unexpected write failures:
- Unexpected flush failures:

## Decision

- [ ] GO: keep pilot enabled
- [ ] HOLD: keep enabled but do not expand
- [ ] NO-GO: disable \`ENABLE_YJS_COLLAB\`

## Notes

- Follow-up actions:
- Known limitations accepted:
- Rollback required:
`
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const status = readJson(opts.statusJson)
  const retention = readJson(opts.retentionJson)

  mkdirSync(path.dirname(opts.outputPath), { recursive: true })
  writeFileSync(
    opts.outputPath,
    `${renderSignoff({
      outputPath: opts.outputPath,
      statusJsonPath: opts.statusJson,
      retentionJsonPath: opts.retentionJson,
      reportJsonPath: opts.reportJson,
      packetDir: opts.packetDir,
      status,
      retention,
      opts,
    })}\n`,
    'utf8'
  )

  console.log(`Wrote ${path.relative(process.cwd(), opts.outputPath)}`)
}

await main()
