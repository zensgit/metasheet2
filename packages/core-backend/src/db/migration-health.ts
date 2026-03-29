export {
  DIRECTORY_MIGRATION_TABLES as REQUIRED_DIRECTORY_TABLES,
  buildMigrationOrderCheck as buildMigrationOrderFinding,
} from './migration-audit'

import {
  DIRECTORY_MIGRATION_TABLES,
  DIRECTORY_REQUIRED_MIGRATIONS,
  buildMigrationOrderCheck,
} from './migration-audit'

export interface MigrationSnapshot {
  name: string
  executedAt?: Date
}

export interface MigrationListEntry {
  name: string
  status: 'executed' | 'pending' | 'unknown'
  executedAt: string | null
}

export interface DirectorySchemaFinding {
  available: boolean
  expected: string[]
  present: string[]
  missing: string[]
}

export interface RequiredMigrationsFinding {
  expected: string[]
  present: string[]
  missing: string[]
}

export interface MigrationAuditReport {
  generatedAt: string
  filesystemMigrations: {
    count: number
    first: string | null
    last: string | null
  }
  trackedMigrations: {
    available: boolean
    count: number
    executedCount: number
    pendingCount: number
    lastExecuted: string | null
  }
  order: {
    ok: boolean | null
    message: string
    firstMismatchIndex: number | null
    expectedName: string | null
    actualName: string | null
  }
  directorySchema: DirectorySchemaFinding
  requiredDirectoryMigrations: RequiredMigrationsFinding
  warnings: string[]
  errors: string[]
}

export const REQUIRED_DIRECTORY_MIGRATIONS = DIRECTORY_REQUIRED_MIGRATIONS

export function buildMigrationListEntries(
  filesystemNames: readonly string[],
  trackedMigrations?: readonly MigrationSnapshot[],
): MigrationListEntry[] {
  if (!trackedMigrations) {
    return filesystemNames.map((name) => ({
      name,
      status: 'unknown',
      executedAt: null,
    }))
  }

  const trackedLookup = new Map(
    trackedMigrations.map((migration) => [
      migration.name,
      migration.executedAt?.toISOString() ?? null,
    ]),
  )

  return filesystemNames.map((name) => {
    const executedAt = trackedLookup.get(name) ?? null
    return {
      name,
      status: executedAt ? 'executed' : 'pending',
      executedAt,
    }
  })
}

export function buildDirectorySchemaFinding(
  tableAvailability?: Readonly<Record<string, boolean>>,
): DirectorySchemaFinding {
  if (!tableAvailability) {
    return {
      available: false,
      expected: [...DIRECTORY_MIGRATION_TABLES],
      present: [],
      missing: [],
    }
  }

  const present = DIRECTORY_MIGRATION_TABLES.filter((tableName) => tableAvailability[tableName] === true)
  const missing = DIRECTORY_MIGRATION_TABLES.filter((tableName) => tableAvailability[tableName] !== true)
  return {
    available: true,
    expected: [...DIRECTORY_MIGRATION_TABLES],
    present,
    missing,
  }
}

export function buildMigrationAuditReport(params: {
  filesystemNames: readonly string[]
  trackedMigrations?: readonly MigrationSnapshot[]
  tableAvailability?: Readonly<Record<string, boolean>>
}): MigrationAuditReport {
  const trackedMigrations = params.trackedMigrations
  const executed = trackedMigrations?.filter((migration) => migration.executedAt)
  const orderCheck = trackedMigrations
    ? buildMigrationOrderCheck(
        params.filesystemNames,
        executed?.map((migration) => migration.name) ?? [],
      )
    : null
  const directorySchema = buildDirectorySchemaFinding(params.tableAvailability)
  const warnings: string[] = []
  const errors: string[] = []

  if (!trackedMigrations) {
    warnings.push('Database migration tracking unavailable; order drift not evaluated.')
  } else if (!orderCheck?.ok) {
    errors.push('Executed migrations do not match the filesystem prefix order.')
  }

  if (!directorySchema.available) {
    warnings.push('Database directory schema availability not checked.')
  } else if (directorySchema.missing.length > 0) {
    errors.push(`Directory schema is missing ${directorySchema.missing.length} required table(s).`)
  }

  const presentDirectoryMigrations = DIRECTORY_REQUIRED_MIGRATIONS.filter((name) => params.filesystemNames.includes(name))
  const missingDirectoryMigrations = DIRECTORY_REQUIRED_MIGRATIONS.filter((name) => !params.filesystemNames.includes(name))

  if (missingDirectoryMigrations.length > 0) {
    errors.push(`Repository is missing ${missingDirectoryMigrations.length} required directory migration file(s).`)
  }

  return {
    generatedAt: new Date().toISOString(),
    filesystemMigrations: {
      count: params.filesystemNames.length,
      first: params.filesystemNames[0] ?? null,
      last: params.filesystemNames.at(-1) ?? null,
    },
    trackedMigrations: {
      available: Boolean(trackedMigrations),
      count: trackedMigrations?.length ?? 0,
      executedCount: executed?.length ?? 0,
      pendingCount: trackedMigrations
        ? params.filesystemNames.length - (executed?.length ?? 0)
        : params.filesystemNames.length,
      lastExecuted: executed?.at(-1)?.name ?? null,
    },
    order: trackedMigrations
      ? {
          ok: orderCheck?.ok ?? false,
          message: orderCheck?.ok
            ? 'Executed migrations match the filesystem prefix order.'
            : 'Executed migrations do not match the filesystem prefix order.',
          firstMismatchIndex: orderCheck?.firstMismatchIndex ?? null,
          expectedName: orderCheck?.expectedName ?? null,
          actualName: orderCheck?.actualName ?? null,
        }
      : {
          ok: null,
          message: 'Database migration tracking unavailable; order drift not evaluated.',
          firstMismatchIndex: null,
          expectedName: null,
          actualName: null,
        },
    directorySchema,
    requiredDirectoryMigrations: {
      expected: [...DIRECTORY_REQUIRED_MIGRATIONS],
      present: presentDirectoryMigrations,
      missing: missingDirectoryMigrations,
    },
    warnings,
    errors,
  }
}
