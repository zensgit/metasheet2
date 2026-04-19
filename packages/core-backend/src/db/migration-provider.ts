import * as path from 'path'
import { promises as fs } from 'fs'
import {
  FileMigrationProvider,
  sql,
  type Migration,
  type MigrationProvider,
} from 'kysely'

type NodeFsLike = Pick<typeof fs, 'readdir' | 'readFile'>
type NodePathLike = Pick<typeof path, 'basename' | 'join' | 'resolve'>

interface CreateCoreBackendMigrationProviderOptions {
  fsImpl?: NodeFsLike
  pathImpl?: NodePathLike
  runtimeDir?: string
  excludedNames?: string[]
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

function isMissingDirectoryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

function getMigrationFolderCandidates(
  runtimeDir: string,
  pathImpl: NodePathLike
): string[] {
  return dedupe([
    pathImpl.join(runtimeDir, 'migrations'),
    pathImpl.resolve(runtimeDir, '../../migrations'),
    pathImpl.resolve(runtimeDir, '../../../migrations'),
  ])
}

function normalizeMigrationName(name: string): string {
  const trimmed = name.trim()
  return trimmed.replace(/\.(sql|ts|js|mjs|mts)$/i, '')
}

function getExcludedNames(values: string[]): Set<string> {
  return new Set(
    values
      .map((value) => normalizeMigrationName(path.basename(value)))
      .filter(Boolean)
  )
}

function createSqlFileMigration(
  fsImpl: NodeFsLike,
  filePath: string
): Migration {
  return {
    async up(db) {
      const sqlText = await fsImpl.readFile(filePath, 'utf8')
      await sql.raw(sqlText).execute(db)
    },
  }
}

async function addProviderMigrations(
  destination: Record<string, Migration>,
  provider: MigrationProvider
) {
  const migrations = await provider.getMigrations()

  for (const [name, migration] of Object.entries(migrations)) {
    if (name.startsWith('_')) {
      continue
    }

    if (destination[name]) {
      throw new Error(`Duplicate migration name detected: ${name}`)
    }

    destination[name] = migration
  }
}

async function addSqlFileMigrations(
  destination: Record<string, Migration>,
  folder: string,
  fsImpl: NodeFsLike,
  pathImpl: NodePathLike
) {
  let files: string[]

  try {
    files = await fsImpl.readdir(folder)
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return
    }

    throw error
  }

  for (const fileName of files) {
    if (fileName.startsWith('.') || fileName.startsWith('_') || !fileName.endsWith('.sql')) {
      continue
    }

    const migrationName = pathImpl.basename(fileName, '.sql')

    if (destination[migrationName]) {
      throw new Error(`Duplicate migration name detected: ${migrationName}`)
    }

    destination[migrationName] = createSqlFileMigration(
      fsImpl,
      pathImpl.join(folder, fileName)
    )
  }
}

export function createCoreBackendMigrationProvider(
  options: CreateCoreBackendMigrationProviderOptions = {}
): MigrationProvider {
  const fsImpl = options.fsImpl ?? fs
  const pathImpl = options.pathImpl ?? path
  const runtimeDir = options.runtimeDir ?? __dirname
  const candidateFolders = getMigrationFolderCandidates(runtimeDir, pathImpl)
  const excludedNames = getExcludedNames(
    options.excludedNames ??
      (process.env.MIGRATION_EXCLUDE || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
  )

  return {
    async getMigrations() {
      const migrations: Record<string, Migration> = {}

      for (const folder of candidateFolders) {
        await addProviderMigrations(
          migrations,
          new FileMigrationProvider({
            fs: fsImpl,
            path: pathImpl,
            migrationFolder: folder,
          })
        ).catch((error) => {
          if (isMissingDirectoryError(error)) {
            return
          }

          throw error
        })
      }

      for (const folder of candidateFolders) {
        await addSqlFileMigrations(migrations, folder, fsImpl, pathImpl)
      }

      return Object.fromEntries(
        Object.entries(migrations).filter(([name]) => !excludedNames.has(name))
      )
    },
  }
}
