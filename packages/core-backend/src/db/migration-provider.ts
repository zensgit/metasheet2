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

// SUPERSEDED_LEGACY_SQL_MIGRATIONS — this is ONE of THREE independent migration
// exclusion/skip mechanisms in this repo; they intentionally differ from each other and
// unifying them by force would break the CI/replay lanes that depend on their specific
// shapes. Full account, including a per-item gap/zombie audit, lives in
// docs/development/migration-legacy-sql-skip-design-20260512.md (the design decision) and
// docs/development/superseded-legacy-migrations-gap-audit-20260710.md (the 2026-07-10 audit
// that verified every item below has no live reader with a missing modern replacement,
// except the two exceptions called out inline). The three mechanisms:
//   1. THIS list — raw numeric SQL migrations (032-055, plus 20250926) that the modern
//      timestamp/zzzz migration stream has fully replaced. They become NO-OP HISTORY
//      MARKERS (see createNoopMigration below) rather than being deleted: upgraded
//      databases already carry these names in kysely_migration, and Kysely treats a
//      missing provider entry as migration-history corruption, so the name must stay
//      visible even though the body no longer runs. Escape hatch for compatibility audits
//      only: MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true (never a normal deploy switch).
//   2. The CI per-PR gate's MIGRATION_EXCLUDE env var (plugin-tests.yml,
//      observability-strict.yml, observability-e2e.yml, safety-guard-e2e.yml) — DROPS a
//      migration entirely (no history marker at all), used where CI's own schema-build
//      order cannot yet satisfy a migration's FK/constraint assumptions.
//   3. migration-replay.yml's OWN MIGRATION_EXCLUDE subset — a different, narrower list for
//      a different job (run db:migrate twice against a fresh db, assert idempotency), which
//      independently dropped 20250925_create_view_tables.sql after #3627/#3632; #4162 later
//      re-verified that fix and aligned the per-PR gate lists.
//      See the comments on that env var in each workflow file for the per-item and
//      per-occurrence detail.
//
// Known, deliberate overlap between this list and mechanism #2:
// 048_create_event_bus_tables and 049_create_bpmn_workflow_tables appear in BOTH — no-op AND
// CI-excluded is redundant but harmless (belt-and-suspenders). 042a_core_model_views was the
// third overlap until #4162 removed its stale CI exclusion; it remains an audited no-op marker.
//
// Known asymmetry that this list does NOT close (tracked, not a bug in this file): production
// and on-prem `db:migrate` runs use no MIGRATION_EXCLUDE. #4162 closed the modern migration
// coverage gap for views/view_states, gantt, 20250925, and the snapshot/protection/change-
// management cluster. The remaining CI exclusions are 008/048/049 plus user_orgs outside
// plugin-tests; do not "fix" those by deleting entries from this list because the mechanisms
// serve different failure modes.
//
// Per-item disposition below (grouped; full object-level mapping is in the 2026-07-10 audit
// doc's §1/§2 tables). Everything is a verified zombie (no live reader depends on the legacy
// object) unless a comment says otherwise. Reviving any of these — e.g. by flipping
// MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true in a real deployment — requires re-auditing for
// a live reader/writer first: the modern schema has no equivalent object for most of them, and
// a silent gap on fresh installs is exactly the failure class this list exists to prevent (see
// the 035_create_files incident below, and PR #4016 which closed it).
const SUPERSEDED_LEGACY_SQL_MIGRATIONS = [
  // 032-036: legacy approval/RBAC/spreadsheet/file/permission core tables, superseded by the
  // modern core-model timestamp migration stream. 035_create_files was a genuine silent gap
  // (zombie with an active fresh-install risk: no modern migration created `files`) until PR
  // #4016 added the bridge migration zzzz20260710120000_create_files.ts; kept no-op here
  // (safe) rather than reactivated now that the gap is closed from the other side.
  '032_create_approval_records',
  '033_create_rbac_core',
  '034_create_spreadsheets',
  '035_create_files',
  '036_create_spreadsheet_permissions',
  // 037: view_configs + indexes — zombie, no modern reader/writer found.
  '037_add_gallery_form_support',
  // 038: secrets / secret_access_logs / config_history — zombie. DO NOT reactivate without a
  // security review first; these are sensitive-data tables.
  '038_config_and_secrets',
  // 040: data_source_schemas/query_templates/query_history/data_sync_jobs/
  // data_sync_history/connection_metrics — zombie.
  '040_data_sources',
  // 041: script_sandbox (8-table package) — zombie.
  '041_script_sandbox',
  // 042/042a-042d, 043-047: core-model/views/external-data/audit/plugin/cache duplicates and
  // predecessors of the modern equivalents. Two of these back genuinely dead application code,
  // not just unused tables — WorkflowRepository.ts (042 workflow_tokens/workflow_incidents) and
  // DataMaterializationService.ts (042b/044 external_tables) have zero importers repo-wide, so
  // reviving the migration alone would not make the feature live.
  '042_core_model_completion',
  '042a_core_model_views',
  '042b_external_data_model',
  '042c_audit_placeholder',
  '042d_audit_and_cache',
  '042d_plugins_and_templates',
  '043_core_model_views',
  '044_external_data_model',
  '045_audit_placeholder',
  // 046: plugin_manifests — zombie; the modern plugin system uses plugin_registry instead.
  '046_plugins_and_templates',
  '047_audit_and_cache',
  // 047/048: event-bus predecessors. event_handlers/event_queue have no modern replacement —
  // the modern 8-table event-bus migration does not recreate them (a real, low-risk gap).
  // event_dead_letters has a soft modern successor, dead_letter_events; EventBusService.ts:875
  // has an explicit fallback that already tolerates the legacy table's absence.
  '047_create_event_bus_tables',
  '048_create_event_bus_tables',
  '049_create_bpmn_workflow_tables',
  '050_create_snapshot_core',
  '051_create_minimal_views',
  '052_recreate_minimal_views',
  '053_create_protection_rules',
  // 054: legacy users table. users.permissions drifted TEXT[] -> jsonb with no transitional
  // migration (AuthService.ts:357 tolerates both shapes at read time, but the SQL-level shape
  // has diverged); users.name NOT NULL -> nullable; avatar_url/is_active/is_admin are absent
  // from this legacy shape. See the 2026-07-10 audit §2 for the full column-drift table.
  '054_create_users_table',
  '055_create_attendance_import_tokens',
  // #3751 entity-machine baseline conflict (42P07 duplicate_table on audit_logs): this legacy raw
  // SQL migration is fully superseded by the idempotent zz20251231_create_audit_tables.ts twin
  // (same 10 tables + 3 views + partitioned audit_logs with guarded dynamic monthly partitions).
  // Machines that executed the zz twin first (allowUnorderedMigrations histories) must never
  // replay this earlier-named file; fresh installs get every object from the twin.
  '20250926_create_audit_tables',
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

function createNoopMigration(): Migration {
  return {
    async up() {
      // Superseded legacy SQL migrations remain visible so Kysely can validate
      // existing migration history, but they must not replay on fresh installs.
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
  const supersededLegacySqlNames = getExcludedNames(
    includeSupersededLegacySql ? [] : SUPERSEDED_LEGACY_SQL_MIGRATIONS
  )
  const excludedNames = getExcludedNames(configuredExcludedNames)

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

      for (const name of Object.keys(migrations)) {
        if (supersededLegacySqlNames.has(name)) {
          migrations[name] = createNoopMigration()
        }
      }

      return Object.fromEntries(
        Object.entries(migrations).filter(([name]) => !excludedNames.has(name))
      )
    },
  }
}
