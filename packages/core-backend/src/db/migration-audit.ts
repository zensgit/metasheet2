import type { Kysely, MigrationInfo, Migrator, MigrationProvider } from 'kysely'
import { sql } from 'kysely'
import type { Database } from './types'
import { checkTableExists } from './migrations/_patterns'

export const DIRECTORY_MIGRATION_TABLES = [
  'user_external_identities',
  'user_external_auth_grants',
  'directory_integrations',
  'directory_departments',
  'directory_accounts',
  'directory_account_departments',
  'directory_account_links',
  'directory_sync_runs',
  'directory_template_centers',
  'directory_template_center_versions',
  'directory_sync_alerts',
] as const

export const DIRECTORY_REQUIRED_MIGRATIONS = [
  'zzzz20260323120000_create_user_external_identities',
  'zzzz20260323133000_harden_user_external_identities',
  'zzzz20260324143000_create_user_external_auth_grants',
  'zzzz20260324150000_create_directory_sync_tables',
  'zzzz20260325100000_add_mobile_to_users_table',
  'zzzz20260327110000_create_directory_template_center_and_alerts',
] as const

export type MigrationCliAction =
  | 'latest'
  | 'list'
  | 'audit'
  | 'up'
  | 'rollback'
  | 'reset'
  | 'to'
  | 'help'

export interface ParsedMigrationCliArgs {
  action: MigrationCliAction
  targetMigrationName?: string
  json: boolean
  allowDestructive: boolean
}

export interface MigrationListEntry {
  name: string
  status: 'executed' | 'pending' | 'unknown'
  executedAt: string | null
}

export interface RecordedMigrationExecution {
  name: string
  executedAt: string
}

export interface MigrationOrderCheck {
  ok: boolean | null
  firstMismatchIndex: number | null
  expectedName: string | null
  actualName: string | null
}

export interface DirectorySchemaAudit {
  expectedTables: readonly string[]
  presentTables: string[]
  missingTables: string[]
}

export interface RequiredMigrationAudit {
  expectedNames: readonly string[]
  presentNames: string[]
  missingNames: string[]
}

export interface MigrationAuditReport {
  generatedAt: string
  databaseReachable: boolean
  migrationTableExists: boolean
  migrationLockTableExists: boolean
  filesystemMigrations: {
    count: number
    first: string | null
    last: string | null
  }
  trackedMigrations: {
    available: boolean
    executedCount: number
    pendingCount: number
    lastExecuted: string | null
  }
  orderCheck: MigrationOrderCheck
  requiredDirectoryMigrations: RequiredMigrationAudit
  directorySchema: DirectorySchemaAudit | null
  warnings: string[]
  errors: string[]
}

interface MigrationAuditContext {
  db: Kysely<Database>
  migrator: Migrator
  provider: MigrationProvider
  databaseEnabled: boolean
}

function describeAuditError(error: unknown): string {
  if (error instanceof Error) {
    const parts = [
      error.message,
      (error as Error & { code?: string }).code,
      (error as Error & { errno?: string | number }).errno,
    ].filter((part): part is string | number => part !== undefined && part !== null && String(part).trim().length > 0)

    if (parts.length > 0) {
      return parts.join(' | ')
    }
  }

  const text = String(error ?? '').trim()
  if (text.length > 0) {
    return text
  }

  return process.env.DATABASE_URL
    ? 'DATABASE_URL is configured but the database is unreachable in the current environment.'
    : 'DATABASE_URL is not configured.'
}

export function parseMigrationCliArgs(argv: readonly string[]): ParsedMigrationCliArgs {
  let action: MigrationCliAction = 'latest'
  let targetMigrationName: string | undefined
  let json = false
  let allowDestructive = process.env.ALLOW_DESTRUCTIVE_MIGRATIONS === 'true'

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    switch (argument) {
      case '--help':
      case '-h':
        action = 'help'
        break
      case '--list':
        action = 'list'
        break
      case '--audit':
        action = 'audit'
        break
      case '--up':
        action = 'up'
        break
      case '--rollback':
      case '--down':
        action = 'rollback'
        break
      case '--reset':
        action = 'reset'
        break
      case '--json':
        json = true
        break
      case '--allow-destructive':
        allowDestructive = true
        break
      case '--to': {
        const nextArgument = argv[index + 1]
        if (!nextArgument) {
          throw new Error('Missing migration name after --to')
        }
        action = 'to'
        targetMigrationName = nextArgument
        index += 1
        break
      }
      default:
        throw new Error(`Unknown migration argument: ${argument}`)
    }
  }

  return {
    action,
    targetMigrationName,
    json,
    allowDestructive,
  }
}

export function filterAndSortMigrations<T>(
  migrations: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(migrations)
      .filter(([name]) => !name.startsWith('_'))
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

export async function loadFilesystemMigrationNames(provider: MigrationProvider): Promise<string[]> {
  const migrations = await provider.getMigrations()
  return Object.keys(filterAndSortMigrations(migrations))
}

export function buildMigrationListEntries(
  filesystemNames: readonly string[],
  trackedMigrations: ReadonlyArray<MigrationInfo> | null,
): MigrationListEntry[] {
  if (!trackedMigrations) {
    return filesystemNames.map((name) => ({
      name,
      status: 'unknown',
      executedAt: null,
    }))
  }

  const trackedLookup = new Map(
    trackedMigrations.map((migration) => [migration.name, migration.executedAt?.toISOString() ?? null]),
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

export function buildMigrationOrderCheck(
  filesystemNames: readonly string[],
  executedNames: readonly string[],
  trackedAvailable = true,
): MigrationOrderCheck {
  if (!trackedAvailable) {
    return {
      ok: null,
      firstMismatchIndex: null,
      expectedName: null,
      actualName: null,
    }
  }

  const firstMismatchIndex = executedNames.findIndex((name, index) => filesystemNames[index] !== name)
  if (firstMismatchIndex === -1) {
    return {
      ok: true,
      firstMismatchIndex: null,
      expectedName: null,
      actualName: null,
    }
  }

  return {
    ok: false,
    firstMismatchIndex,
    expectedName: filesystemNames[firstMismatchIndex] ?? null,
    actualName: executedNames[firstMismatchIndex] ?? null,
  }
}

export function sortRecordedMigrationExecutions(
  executions: readonly RecordedMigrationExecution[],
): RecordedMigrationExecution[] {
  return executions
    .slice()
    .sort((left, right) => {
      const timestampDiff = new Date(left.executedAt).getTime() - new Date(right.executedAt).getTime()
      if (timestampDiff !== 0) {
        return timestampDiff
      }

      return left.name.localeCompare(right.name)
    })
}

export function buildExecutedMigrationNames(
  trackedMigrations: ReadonlyArray<MigrationInfo> | null,
  trackedExecutions: readonly RecordedMigrationExecution[] | null = null,
): string[] {
  if (trackedExecutions && trackedExecutions.length > 0) {
    return trackedExecutions.map((item) => item.name)
  }

  return trackedMigrations?.filter((item) => item.executedAt).map((item) => item.name) ?? []
}

export function buildRequiredMigrationAudit(filesystemNames: readonly string[]): RequiredMigrationAudit {
  const presentNames = DIRECTORY_REQUIRED_MIGRATIONS.filter((name) => filesystemNames.includes(name))
  const missingNames = DIRECTORY_REQUIRED_MIGRATIONS.filter((name) => !filesystemNames.includes(name))
  return {
    expectedNames: DIRECTORY_REQUIRED_MIGRATIONS,
    presentNames,
    missingNames,
  }
}

async function loadRecordedMigrationExecutions(db: Kysely<Database>): Promise<RecordedMigrationExecution[]> {
  const result = await sql<{ name: string; timestamp: Date | string | null }>`
    select name, timestamp
    from kysely_migration
  `.execute(db)

  const executions = result.rows
    .filter((row): row is { name: string; timestamp: Date | string } => row.timestamp !== null)
    .map((row) => ({
      name: row.name,
      executedAt: row.timestamp instanceof Date ? row.timestamp.toISOString() : new Date(row.timestamp).toISOString(),
    }))

  return sortRecordedMigrationExecutions(executions)
}

export async function collectMigrationAuditReport({
  db,
  migrator,
  provider,
  databaseEnabled,
}: MigrationAuditContext): Promise<MigrationAuditReport> {
  const filesystemNames = await loadFilesystemMigrationNames(provider)
  const requiredDirectoryMigrations = buildRequiredMigrationAudit(filesystemNames)
  const warnings: string[] = []
  const errors: string[] = []

  let trackedMigrations: ReadonlyArray<MigrationInfo> | null = null
  let trackedExecutions: RecordedMigrationExecution[] | null = null
  let databaseReachable = false
  let migrationTableExists = false
  let migrationLockTableExists = false
  let directorySchema: DirectorySchemaAudit | null = null

  if (!databaseEnabled) {
    warnings.push('DATABASE_URL 未设置，迁移审计仅基于本地 migration 文件执行。')
  } else {
    try {
      trackedMigrations = await migrator.getMigrations()
      databaseReachable = true
      migrationTableExists = await checkTableExists(db, 'kysely_migration')
      migrationLockTableExists = await checkTableExists(db, 'kysely_migration_lock')
      trackedExecutions = migrationTableExists ? await loadRecordedMigrationExecutions(db) : []

      const tableStates = await Promise.all(
        DIRECTORY_MIGRATION_TABLES.map(async (tableName) => ({
          tableName,
          exists: await checkTableExists(db, tableName),
        })),
      )

      directorySchema = {
        expectedTables: DIRECTORY_MIGRATION_TABLES,
        presentTables: tableStates.filter((item) => item.exists).map((item) => item.tableName),
        missingTables: tableStates.filter((item) => !item.exists).map((item) => item.tableName),
      }
    } catch (error) {
      const message = describeAuditError(error)
      warnings.push(`无法读取数据库迁移状态: ${message}`)
    }
  }

  const executedNames = buildExecutedMigrationNames(trackedMigrations, trackedExecutions)
  const orderCheck = buildMigrationOrderCheck(filesystemNames, executedNames, trackedMigrations !== null)

  if (orderCheck.ok === null) {
    warnings.push('数据库迁移跟踪不可用，顺序漂移检查已跳过。')
  } else if (!orderCheck.ok) {
    errors.push(
      `已执行 migration 序列与当前文件顺序不一致，首个漂移点为 #${orderCheck.firstMismatchIndex}: expected=${orderCheck.expectedName}, actual=${orderCheck.actualName}`,
    )
  }

  if (requiredDirectoryMigrations.missingNames.length > 0) {
    errors.push(`目录/IAM 必需 migration 文件缺失: ${requiredDirectoryMigrations.missingNames.join(', ')}`)
  }

  if (directorySchema && directorySchema.missingTables.length > 0) {
    errors.push(`目录/IAM 扩展表缺失: ${directorySchema.missingTables.join(', ')}`)
  }

  return {
    generatedAt: new Date().toISOString(),
    databaseReachable,
    migrationTableExists,
    migrationLockTableExists,
    filesystemMigrations: {
      count: filesystemNames.length,
      first: filesystemNames[0] ?? null,
      last: filesystemNames.at(-1) ?? null,
    },
    trackedMigrations: {
      available: trackedMigrations !== null,
      executedCount: executedNames.length,
      pendingCount: trackedMigrations ? trackedMigrations.filter((item) => !item.executedAt).length : filesystemNames.length,
      lastExecuted: trackedExecutions?.at(-1)?.name ?? executedNames.at(-1) ?? null,
    },
    orderCheck,
    requiredDirectoryMigrations,
    directorySchema,
    warnings,
    errors,
  }
}

export function formatMigrationList(entries: readonly MigrationListEntry[]): string {
  return entries
    .map((entry) => {
      const marker = entry.status === 'executed' ? 'executed' : entry.status === 'pending' ? 'pending ' : 'unknown '
      const timestamp = entry.executedAt ?? '-'
      return `${marker}  ${entry.name}  ${timestamp}`
    })
    .join('\n')
}

export function formatMigrationAuditReport(report: MigrationAuditReport): string {
  const lines = [
    `generatedAt: ${report.generatedAt}`,
    `databaseReachable: ${report.databaseReachable}`,
    `migrationTableExists: ${report.migrationTableExists}`,
    `migrationLockTableExists: ${report.migrationLockTableExists}`,
    `filesystemMigrations: count=${report.filesystemMigrations.count}, first=${report.filesystemMigrations.first ?? '-'}, last=${report.filesystemMigrations.last ?? '-'}`,
    `trackedMigrations: available=${report.trackedMigrations.available}, executed=${report.trackedMigrations.executedCount}, pending=${report.trackedMigrations.pendingCount}, lastExecuted=${report.trackedMigrations.lastExecuted ?? '-'}`,
    report.orderCheck.ok === null
      ? 'orderCheck: skipped'
      : report.orderCheck.ok
      ? 'orderCheck: ok'
      : `orderCheck: drift at #${report.orderCheck.firstMismatchIndex}, expected=${report.orderCheck.expectedName}, actual=${report.orderCheck.actualName}`,
    `requiredDirectoryMigrations: present=${report.requiredDirectoryMigrations.presentNames.length}, missing=${report.requiredDirectoryMigrations.missingNames.length}`,
  ]

  if (report.requiredDirectoryMigrations.missingNames.length > 0) {
    lines.push(`requiredDirectoryMigrations.missingNames: ${report.requiredDirectoryMigrations.missingNames.join(', ')}`)
  }

  if (report.directorySchema) {
    lines.push(
      `directorySchema: present=${report.directorySchema.presentTables.length}, missing=${report.directorySchema.missingTables.length}`,
    )
    if (report.directorySchema.missingTables.length > 0) {
      lines.push(`directorySchema.missingTables: ${report.directorySchema.missingTables.join(', ')}`)
    }
  } else {
    lines.push('directorySchema: unavailable')
  }

  if (report.warnings.length > 0) {
    lines.push(`warnings: ${report.warnings.join(' | ')}`)
  }

  if (report.errors.length > 0) {
    lines.push(`errors: ${report.errors.join(' | ')}`)
  }

  return lines.join('\n')
}

export function getMigrationCliHelp(): string {
  return [
    'MetaSheet migration CLI',
    '',
    'Usage:',
    '  pnpm --filter @metasheet/core-backend migrate',
    '  pnpm --filter @metasheet/core-backend exec tsx src/db/migrate.ts --list',
    '  pnpm --filter @metasheet/core-backend exec tsx src/db/migrate.ts --audit [--json]',
    '  pnpm --filter @metasheet/core-backend exec tsx src/db/migrate.ts --up',
    '  pnpm --filter @metasheet/core-backend exec tsx src/db/migrate.ts --to <migration-name>',
    '  pnpm --filter @metasheet/core-backend exec tsx src/db/migrate.ts --allow-destructive --rollback',
    '  pnpm --filter @metasheet/core-backend exec tsx src/db/migrate.ts --allow-destructive --reset',
    '',
    'Notes:',
    '  --audit 会同时检查 migration 顺序漂移和目录/IAM 扩展表缺失。',
    '  --rollback / --reset 需要显式设置 ALLOW_DESTRUCTIVE_MIGRATIONS=true 或追加 --allow-destructive。',
  ].join('\n')
}
