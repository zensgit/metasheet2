import * as path from 'path'
import { promises as fs } from 'fs'
import {
  Migrator,
  NO_MIGRATIONS,
  type MigrationResultSet,
} from 'kysely'
import { db } from './db'
import { createCoreBackendMigrationProvider } from './migration-provider'

type MigrationCommand = 'latest' | 'list' | 'rollback' | 'reset' | 'help'

const recognizedFlags = new Set(['latest', 'list', 'rollback', 'reset', 'help', 'h'])

function parseCommand(argv: string[]): MigrationCommand {
  for (const arg of argv) {
    const flag = arg.replace(/^--/, '')
    if (!recognizedFlags.has(flag)) continue
    if (flag === 'h') return 'help'
    return flag as MigrationCommand
  }
  return 'latest'
}

function buildMigrator(): Migrator {
  return new Migrator({
    db,
    // Some deployed environments already executed later migrations before
    // newly-added earlier-named migrations were merged into main. Allow
    // unordered histories so those environments can continue applying the
    // still-missing migrations instead of hard-failing on order checks.
    allowUnorderedMigrations: true,
    provider: createCoreBackendMigrationProvider({
      fsImpl: fs,
      pathImpl: path,
      runtimeDir: __dirname,
    }),
  })
}

function reportResults(results: MigrationResultSet['results']): void {
  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`migration "${it.migrationName}" was executed successfully`)
    } else if (it.status === 'Error') {
      console.error(`failed to execute migration "${it.migrationName}"`)
    }
  })
}

async function exitOnError(label: string, run: () => Promise<MigrationResultSet>): Promise<void> {
  const { error, results } = await run()
  reportResults(results)
  if (error) {
    console.error(`failed to ${label}`)
    console.error(error)
    process.exit(1)
  }
}

async function commandLatest(): Promise<void> {
  const migrator = buildMigrator()
  await exitOnError('migrate', () => migrator.migrateToLatest())
  await db.destroy()
}

async function commandList(): Promise<void> {
  const migrator = buildMigrator()
  const all = await migrator.getMigrations()
  const applied = all.filter((m) => m.executedAt)
  const pending = all.filter((m) => !m.executedAt)
  console.log(`Applied: ${applied.length}`)
  console.log(`Pending: ${pending.length}`)
  if (pending.length > 0) {
    console.log('\nPending migrations (in load order):')
    for (const m of pending) {
      console.log(`  - ${m.name}`)
    }
  } else {
    console.log('\nNo pending migrations — schema is up to date.')
  }
  await db.destroy()
}

// Positive confirmation that a SPECIFIC migration is applied. `--latest` exiting 0 is NOT proof a
// given migration ran (an empty pending set, an excluded/no-op entry, or a partially-applied history
// all exit 0), so acceptance tooling needs a name-level check against the unified ledger. Exit codes:
//   0 = applied, 1 = known but still pending, 2 = name not found among known migrations.
async function commandConfirm(name: string): Promise<void> {
  const migrator = buildMigrator()
  const all = await migrator.getMigrations()
  await db.destroy()
  const target = all.find((m) => m.name === name)
  if (!target) {
    console.error(`migration "${name}" not found among the known migrations`)
    process.exit(2)
  }
  if (!target.executedAt) {
    console.error(`migration "${name}" is NOT applied (still pending)`)
    process.exit(1)
  }
  console.log(`migration "${name}" is applied`)
}

async function commandRollback(): Promise<void> {
  const migrator = buildMigrator()
  await exitOnError('roll back', () => migrator.migrateDown())
  await db.destroy()
}

async function commandReset(): Promise<void> {
  if (process.env.ALLOW_DB_RESET !== 'true') {
    console.error(
      'Refusing to --reset without ALLOW_DB_RESET=true.\n' +
      'This rolls back ALL migrations and is destructive. ' +
      'Set ALLOW_DB_RESET=true in the environment to confirm intent.',
    )
    process.exit(1)
  }
  const migrator = buildMigrator()
  await exitOnError('reset', () => migrator.migrateTo(NO_MIGRATIONS))
  await db.destroy()
}

function printHelp(): void {
  console.log(`Usage: tsx src/db/migrate.ts [flag]

  (no flag)    Migrate to latest (default; same as --latest).
  --list       Show applied count + pending migration names. Read-only.
  --confirm N  Confirm migration N is applied (exit 0 applied / 1 pending / 2 unknown). Read-only.
  --rollback   Roll back the most recently applied migration (one step).
  --reset      Roll back ALL migrations. Requires ALLOW_DB_RESET=true env.
  --help       Show this message.

Notes:
- Multiple flags are not supported. The first recognized flag wins.
- Without --list, the script will mutate the database. Run --list first
  to preview what's pending before running --latest in production envs.`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  // --confirm <name>: read-only name-level check (takes an argument, so handled before the flag parser).
  const confirmIdx = argv.indexOf('--confirm')
  if (confirmIdx !== -1) {
    const name = argv[confirmIdx + 1]
    if (!name || name.startsWith('--')) {
      console.error('--confirm requires a migration name, e.g. --confirm 066_create_integration_stock_prep_audit')
      process.exit(2)
    }
    return commandConfirm(name)
  }

  const command = parseCommand(argv)

  if (command === 'help') {
    printHelp()
    return
  }
  if (command === 'list') return commandList()
  if (command === 'rollback') return commandRollback()
  if (command === 'reset') return commandReset()
  return commandLatest()
}

main()
