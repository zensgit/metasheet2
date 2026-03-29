import * as path from 'path'
import { promises as fs } from 'fs'
import { FileMigrationProvider, Migrator, NO_MIGRATIONS } from 'kysely'
import { db } from './db'
import {
  buildMigrationListEntries,
  collectMigrationAuditReport,
  filterAndSortMigrations,
  formatMigrationAuditReport,
  formatMigrationList,
  getMigrationCliHelp,
  loadFilesystemMigrationNames,
  parseMigrationCliArgs,
} from './migration-audit'

function createProvider() {
  const baseProvider = new FileMigrationProvider({
    fs,
    path,
    migrationFolder: path.join(__dirname, 'migrations'),
  })

  return {
    async getMigrations() {
      const migrations = await baseProvider.getMigrations()
      return filterAndSortMigrations(migrations)
    },
  }
}

function createMigrator() {
  return new Migrator({
    db,
    provider: createProvider(),
  })
}

function printMigrationResults(results: ReadonlyArray<{ migrationName: string; status: string }> | undefined): void {
  results?.forEach((result) => {
    if (result.status === 'Success') {
      console.log(`migration "${result.migrationName}" was executed successfully`)
      return
    }

    if (result.status === 'NotExecuted') {
      console.log(`migration "${result.migrationName}" was skipped`)
      return
    }

    console.error(`failed to execute migration "${result.migrationName}"`)
  })
}

function ensureDestructiveAllowed(action: 'rollback' | 'reset', allowDestructive: boolean): void {
  if (allowDestructive) {
    return
  }

  throw new Error(
    `${action} is destructive. Re-run with --allow-destructive or set ALLOW_DESTRUCTIVE_MIGRATIONS=true.`,
  )
}

async function runList(json: boolean): Promise<void> {
  const provider = createProvider()
  const filesystemNames = await loadFilesystemMigrationNames(provider)
  let trackedMigrations = null

  try {
    trackedMigrations = await createMigrator().getMigrations()
  } catch {
    trackedMigrations = null
  }

  const entries = buildMigrationListEntries(filesystemNames, trackedMigrations)

  if (json) {
    console.log(JSON.stringify(entries, null, 2))
    return
  }

  console.log(formatMigrationList(entries))

  if (!trackedMigrations) {
    console.warn('\nTracking unavailable: DATABASE_URL not configured or database is unreachable in the current environment.')
  }
}

async function runAudit(json: boolean): Promise<void> {
  const report = await collectMigrationAuditReport({
    db,
    migrator: createMigrator(),
    provider: createProvider(),
    databaseEnabled: Boolean(process.env.DATABASE_URL),
  })

  console.log(json ? JSON.stringify(report, null, 2) : formatMigrationAuditReport(report))

  if (report.errors.length > 0) {
    process.exitCode = 1
  }
}

async function runMutatingAction(action: 'latest' | 'up' | 'rollback' | 'reset' | 'to', allowDestructive: boolean, targetMigrationName?: string): Promise<void> {
  const migrator = createMigrator()

  if (action === 'rollback') {
    ensureDestructiveAllowed('rollback', allowDestructive)
    const result = await migrator.migrateDown()
    printMigrationResults(result.results)
    if (result.error) {
      throw result.error
    }
    return
  }

  if (action === 'reset') {
    ensureDestructiveAllowed('reset', allowDestructive)
    const result = await migrator.migrateTo(NO_MIGRATIONS)
    printMigrationResults(result.results)
    if (result.error) {
      throw result.error
    }
    return
  }

  if (action === 'up') {
    const result = await migrator.migrateUp()
    printMigrationResults(result.results)
    if (result.error) {
      throw result.error
    }
    return
  }

  if (action === 'to') {
    if (!targetMigrationName) {
      throw new Error('missing migration name after --to')
    }

    const result = await migrator.migrateTo(targetMigrationName)
    printMigrationResults(result.results)
    if (result.error) {
      throw result.error
    }
    return
  }

  const result = await migrator.migrateToLatest()
  printMigrationResults(result.results)
  if (result.error) {
    throw result.error
  }
}

async function main(): Promise<void> {
  const options = parseMigrationCliArgs(process.argv.slice(2))

  try {
    if (options.action === 'help') {
      console.log(getMigrationCliHelp())
      return
    }

    if (options.action === 'list') {
      await runList(options.json)
      return
    }

    if (options.action === 'audit') {
      await runAudit(options.json)
      return
    }

    await runMutatingAction(options.action, options.allowDestructive, options.targetMigrationName)
  } finally {
    await db.destroy()
  }
}

main().catch((error) => {
  console.error('failed to run migration command')
  console.error(error)
  process.exit(1)
})
