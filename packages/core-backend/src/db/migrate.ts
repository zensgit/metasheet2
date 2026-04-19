import * as path from 'path'
import { promises as fs } from 'fs'
import {
  Migrator,
} from 'kysely'
import { db } from './db'
import { createCoreBackendMigrationProvider } from './migration-provider'

async function migrateToLatest() {
  const migrator = new Migrator({
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

  const { error, results } = await migrator.migrateToLatest()

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`migration "${it.migrationName}" was executed successfully`)
    } else if (it.status === 'Error') {
      console.error(`failed to execute migration "${it.migrationName}"`)
    }
  })

  if (error) {
    console.error('failed to migrate')
    console.error(error)
    process.exit(1)
  }

  await db.destroy()
}

migrateToLatest()
