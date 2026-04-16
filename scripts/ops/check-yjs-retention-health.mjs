#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const DEFAULTS = {
  maxUpdates: 100000,
  maxOrphanStates: 0,
  maxOrphanUpdates: 0,
  topLimit: 10,
}

function printHelp() {
  console.log(`Usage: node scripts/ops/check-yjs-retention-health.mjs [options]

Checks Yjs retention/storage health directly from PostgreSQL.

Options:
  --database-url <url>           Database URL, default from YJS_DATABASE_URL or DATABASE_URL
  --max-updates <count>          Alert threshold, default ${DEFAULTS.maxUpdates}
  --max-orphan-states <count>    Alert threshold, default ${DEFAULTS.maxOrphanStates}
  --max-orphan-updates <count>   Alert threshold, default ${DEFAULTS.maxOrphanUpdates}
  --top-limit <count>            Number of hottest records to print, default ${DEFAULTS.topLimit}
  --json                         Print raw JSON payload after the summary
  --json-only                    Print JSON payload only
  --help                         Show this help

Exit codes:
  0  healthy
  1  usage or execution failure
  2  data fetched but retention state is unhealthy
`)
}

function parseArgs(argv) {
  const opts = {
    databaseUrl: process.env.YJS_DATABASE_URL || process.env.DATABASE_URL || '',
    maxUpdates: DEFAULTS.maxUpdates,
    maxOrphanStates: DEFAULTS.maxOrphanStates,
    maxOrphanUpdates: DEFAULTS.maxOrphanUpdates,
    topLimit: DEFAULTS.topLimit,
    showJson: false,
    jsonOnly: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    switch (arg) {
      case '--database-url':
        opts.databaseUrl = next
        i += 1
        break
      case '--max-updates':
        opts.maxUpdates = Number(next)
        i += 1
        break
      case '--max-orphan-states':
        opts.maxOrphanStates = Number(next)
        i += 1
        break
      case '--max-orphan-updates':
        opts.maxOrphanUpdates = Number(next)
        i += 1
        break
      case '--top-limit':
        opts.topLimit = Number(next)
        i += 1
        break
      case '--json':
        opts.showJson = true
        break
      case '--json-only':
        opts.jsonOnly = true
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

function runPsql(databaseUrl, sql) {
  const result = spawnSync(
    'psql',
    [databaseUrl, '-X', '-q', '-t', '-A', '-c', sql],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `psql exited with status ${result.status}`)
  }

  return result.stdout.trim()
}

function buildPayload(databaseUrl, topLimit) {
  const statsSql = `
SELECT json_build_object(
  'statesCount', (SELECT count(*)::int FROM meta_record_yjs_states),
  'updatesCount', (SELECT count(*)::int FROM meta_record_yjs_updates),
  'orphanStatesCount', (
    SELECT count(*)::int
    FROM meta_record_yjs_states s
    LEFT JOIN meta_records r ON r.id = s.record_id
    WHERE r.id IS NULL
  ),
  'orphanUpdatesCount', (
    SELECT count(*)::int
    FROM meta_record_yjs_updates u
    LEFT JOIN meta_records r ON r.id = u.record_id
    WHERE r.id IS NULL
  )
);
`

  const topSql = `
SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
FROM (
  SELECT record_id, count(*)::int AS updateCount
  FROM meta_record_yjs_updates
  GROUP BY record_id
  ORDER BY updateCount DESC, record_id ASC
  LIMIT ${Math.max(1, topLimit)}
) t;
`

  const stats = JSON.parse(runPsql(databaseUrl, statsSql) || '{}')
  const hottestRecords = JSON.parse(runPsql(databaseUrl, topSql) || '[]')

  return {
    stats,
    hottestRecords,
  }
}

function assessPayload(payload, thresholds) {
  const stats = payload.stats ?? {}
  const failures = []

  if ((stats.updatesCount ?? 0) > thresholds.maxUpdates) {
    failures.push(`updatesCount ${stats.updatesCount} > ${thresholds.maxUpdates}`)
  }
  if ((stats.orphanStatesCount ?? 0) > thresholds.maxOrphanStates) {
    failures.push(`orphanStatesCount ${stats.orphanStatesCount} > ${thresholds.maxOrphanStates}`)
  }
  if ((stats.orphanUpdatesCount ?? 0) > thresholds.maxOrphanUpdates) {
    failures.push(`orphanUpdatesCount ${stats.orphanUpdatesCount} > ${thresholds.maxOrphanUpdates}`)
  }

  return failures
}

function printSummary(payload, failures) {
  const stats = payload.stats ?? {}
  console.log(`Yjs retention health: ${failures.length === 0 ? 'HEALTHY' : 'UNHEALTHY'}`)
  console.log(`States count: ${stats.statesCount ?? 0}`)
  console.log(`Updates count: ${stats.updatesCount ?? 0}`)
  console.log(`Orphan states: ${stats.orphanStatesCount ?? 0}`)
  console.log(`Orphan updates: ${stats.orphanUpdatesCount ?? 0}`)

  if (Array.isArray(payload.hottestRecords) && payload.hottestRecords.length > 0) {
    console.log('Hottest records:')
    for (const row of payload.hottestRecords) {
      console.log(`- ${row.record_id}: ${row.updatecount ?? row.updateCount}`)
    }
  }

  if (failures.length > 0) {
    console.log('Failures:')
    for (const failure of failures) {
      console.log(`- ${failure}`)
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.databaseUrl) {
    console.error('Missing database URL. Use --database-url, YJS_DATABASE_URL, or DATABASE_URL.')
    process.exit(1)
  }

  try {
    const payload = buildPayload(opts.databaseUrl, opts.topLimit)
    const failures = assessPayload(payload, opts)
    const outputPayload = {
      databaseUrlPresent: Boolean(opts.databaseUrl),
      thresholds: {
        maxUpdates: opts.maxUpdates,
        maxOrphanStates: opts.maxOrphanStates,
        maxOrphanUpdates: opts.maxOrphanUpdates,
        topLimit: opts.topLimit,
      },
      failures,
      ...payload,
    }

    if (opts.jsonOnly) {
      console.log(JSON.stringify(outputPayload, null, 2))
    } else {
      printSummary(payload, failures)
      if (opts.showJson) {
        console.log(JSON.stringify(outputPayload, null, 2))
      }
    }

    process.exit(failures.length === 0 ? 0 : 2)
  } catch (error) {
    console.error(`Failed to query Yjs retention health: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

await main()
