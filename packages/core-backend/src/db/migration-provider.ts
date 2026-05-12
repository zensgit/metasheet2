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
  includeSupersededLegacySqlMigrations?: boolean
}

const SUPERSEDED_LEGACY_SQL_MIGRATIONS = [
  '032_create_approval_records',
  '033_create_rbac_core',
  '034_create_spreadsheets',
  '035_create_files',
  '036_create_spreadsheet_permissions',
  '037_add_gallery_form_support',
  '038_config_and_secrets',
  '040_data_sources',
  '041_script_sandbox',
  '042_core_model_completion',
  '042a_core_model_views',
  '042b_external_data_model',
  '042c_audit_placeholder',
  '042d_audit_and_cache',
  '042d_plugins_and_templates',
  '043_core_model_views',
  '044_external_data_model',
  '045_audit_placeholder',
  '046_plugins_and_templates',
  '047_audit_and_cache',
  '047_create_event_bus_tables',
  '048_create_event_bus_tables',
  '049_create_bpmn_workflow_tables',
  '050_create_snapshot_core',
  '051_create_minimal_views',
  '052_recreate_minimal_views',
  '053_create_protection_rules',
  '054_create_users_table',
  '055_create_attendance_import_tokens',
]

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

function getProviderFolderCandidates(
  runtimeDir: string,
  pathImpl: NodePathLike
): string[] {
  return dedupe([
    pathImpl.join(runtimeDir, 'migrations'),
    pathImpl.resolve(runtimeDir, '../../migrations'),
    pathImpl.resolve(runtimeDir, '../../../migrations'),
  ])
}

function getSqlFolderCandidates(
  runtimeDir: string,
  pathImpl: NodePathLike
): string[] {
  return dedupe([
    pathImpl.join(runtimeDir, 'migrations'),
    pathImpl.resolve(runtimeDir, '../../../src/db/migrations'),
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
  const providerFolders = getProviderFolderCandidates(runtimeDir, pathImpl)
  const sqlFolders = getSqlFolderCandidates(runtimeDir, pathImpl)
  const includeSupersededLegacySql =
    options.includeSupersededLegacySqlMigrations ??
    process.env.MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL === 'true'
  const configuredExcludedNames =
    options.excludedNames ??
    (process.env.MIGRATION_EXCLUDE || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  const excludedNames = getExcludedNames(
    [
      ...(includeSupersededLegacySql ? [] : SUPERSEDED_LEGACY_SQL_MIGRATIONS),
      ...configuredExcludedNames,
    ]
  )

  return {
    async getMigrations() {
      const migrations: Record<string, Migration> = {}

      for (const folder of providerFolders) {
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

      for (const folder of sqlFolders) {
        await addSqlFileMigrations(migrations, folder, fsImpl, pathImpl)
      }

      return Object.fromEntries(
        Object.entries(migrations).filter(([name]) => !excludedNames.has(name))
      )
    },
  }
}
