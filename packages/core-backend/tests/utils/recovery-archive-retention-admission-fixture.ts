import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type QueryResult } from 'pg'
import { createForeignResetFixture, FOREIGN_RESET_MIGRATIONS } from './recovery-archive-foreign-reset-admission-fixture'
import { dropScratchDatabase, formatScratchDropOutcome } from '../helpers/scratch-database'
import { canonicalSheetFenceKey } from '../../src/multitable/canonical-sheet-fence'
import { RECOVERY_AUTHORITY_TRIGGERS } from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'
import { sealDirectEventOperation } from '../../src/multitable/recovery-archive-seals'
import type { RetentionQueryFn } from '../../src/multitable/meta-revision-retention'

export type TombstoneKind = 'field' | 'link'
export const tombstoneTable = (kind: TombstoneKind) => kind === 'field' ? 'meta_field_value_tombstones' : 'meta_link_tombstones'
export const anchorColumn = (kind: TombstoneKind) => kind === 'field' ? 'config_revision_id' : 'source_revision_id'
export type TombstoneOptions = { sheetId?: string; id?: string; anchor?: string | null; days?: number; operationId?: string | null }

export async function createRetentionFixture(admin: Pool) {
  const fixture = await createForeignResetFixture(admin)
  const query = fixture.query
  const sha = '5'.repeat(64)
  await query("UPDATE multitable_attachments SET storage_file_id=$2,storage_path=$3,storage_provider='local' WHERE id=$1", [fixture.pins[0], randomUUID(), `${randomUUID()}/sha256-${sha}`])
  async function insert(kind: TombstoneKind, options: TombstoneOptions = {}, q: RetentionQueryFn = query) {
    const id = options.id ?? randomUUID(), sheet = options.sheetId ?? fixture.identity.sheetId
    const columns = kind === 'field' ? 'value' : 'foreign_record_id'
    const payload = kind === 'field' ? "'{\"synthetic\":true}'::jsonb" : "'synthetic_target'"
    await q(`INSERT INTO ${tombstoneTable(kind)}(id,sheet_id,field_id,record_id,${columns},reason,${anchorColumn(kind)},operation_id,created_at)
      VALUES($1::uuid,$2,$3,$4,${payload},'field_delete',$5::uuid,$6::uuid,clock_timestamp()-($7::int*interval '1 day'))`,
    [id, sheet, `${sheet}_deleted_field`, `${sheet}_deleted_record_${id}`, options.anchor ?? null, options.operationId ?? null, options.days ?? 40])
    return id
  }
  async function tagged(kind: TombstoneKind, options: TombstoneOptions = {}) {
    return fixture.transaction(async (q) => {
      const operationId = randomUUID(), sheet = options.sheetId ?? fixture.identity.sheetId
      await q('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(sheet)])
      const revision = await q(`INSERT INTO meta_record_revisions(sheet_id,record_id,version,action,operation_id,snapshot)
        VALUES($1,$2,1,'create',$3::uuid,'{}') RETURNING seq::text`, [sheet, `${sheet}_tag_event_${operationId}`, operationId])
      const id = await insert(kind, { ...options, operationId }, q)
      await sealDirectEventOperation(q, { sheetId: sheet, operationId, endpointSeq: revision.rows[0].seq, eventCount: 1, operationKind: 'ordinary' })
      return id
    })
  }
  return { ...fixture, insert, tagged,
    runner: <T>(work: (client: { query: RetentionQueryFn }) => Promise<T>) => fixture.transaction((q) => work({ query: q })),
    async floor(anchor: string) {
      const id = randomUUID()
      await query(`INSERT INTO meta_records_trash(id,record_id,sheet_id,base_id,data,delete_revision_id)
        VALUES($1::uuid,$2,$3,$4,'{}',$5)`, [id, `${fixture.identity.sheetId}_trash_${id}`, fixture.identity.sheetId, fixture.identity.baseId, anchor])
      return id
    },
  }
}
export type RetentionFixture = Awaited<ReturnType<typeof createRetentionFixture>>

/** Separate real production deployment stages; no temporary tables, fake DDL or disabled guard. */
export async function createRetentionDeploymentFixture(admin: Pool, mode: 'missing-floor' | 'missing-operation' | 'missing-table' | 'missing-state') {
  const prefix = `tm_retention_stage_${randomUUID().replaceAll('-', '').slice(0, 12)}`, database = `${prefix}_db`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`
  const pool = new Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 500, options: '-c statement_timeout=15000' })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  const names = mode === 'missing-floor' ? [
    'zzz20251231_create_meta_schema', 'zzzz20260318110000_add_multitable_bases_and_permissions',
    'zzzz20260430172000_create_meta_record_revisions', 'zzzz20260617120000_create_meta_records_trash',
    'zzzz20260624120000_create_meta_config_revisions', 'zzzz20260708090000_create_meta_tombstone_tables',
    'zzzz20260713150000_create_meta_record_version_markers', 'zzzz20260715160000_add_meta_record_chain_seq',
    'zzzz20260715170000_add_meta_sheet_recovery_writer_state', 'zzzz20260715210000_create_meta_record_history_operations',
    'zzzz20260826122500_add_operation_binding_to_nonrecord_history',
  ]
    : mode === 'missing-state' ? FOREIGN_RESET_MIGRATIONS.filter((name) => name <= 'zzzz20260826122500_add_operation_binding_to_nonrecord_history' && name !== 'zzzz20260715170000_add_meta_sheet_recovery_writer_state')
    : ['zzz20251231_create_meta_schema', 'zzzz20260318110000_add_multitable_bases_and_permissions', 'zzzz20260617120000_create_meta_records_trash',
      ...(mode === 'missing-table' ? [] : ['zzzz20260708090000_create_meta_tombstone_tables']), 'zzzz20260715170000_add_meta_sheet_recovery_writer_state']
  const query = (sql: string, params?: unknown[]) => pool.query(sql, params)
  async function dispose() {
    await db.destroy(); const outcome = await dropScratchDatabase(admin, database)
    console.log(formatScratchDropOutcome('retention-admission-stage', outcome))
    if (outcome.forced || outcome.residualBackends) throw new Error('retention_stage_cleanup_not_clean')
  }
  try {
    for (const name of names) await db.transaction().execute((await import(`../../src/db/migrations/${name}.ts`)).up)
    if (mode === 'missing-state') for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) await query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
    await query("INSERT INTO meta_bases(id,name,workspace_id) VALUES($1,'Synthetic',$2)", [`${prefix}_base`, `${prefix}_workspace`])
    const sheetId = `${prefix}_sheet`
    await query("INSERT INTO meta_sheets(id,base_id,name) VALUES($1,$2,'Synthetic')", [sheetId, `${prefix}_base`])
    const calls: string[] = []
    const runner = async <T>(work: (client: { query: RetentionQueryFn }) => Promise<T>) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work({ query: async (sql, params): Promise<QueryResult> => { calls.push(sql); return client.query(sql, params) } })
        await client.query('COMMIT'); return result
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    }
    console.log(`actualDeploymentMigrationUps=${names.length} mode=${mode}`)
    return { pool, query, runner, calls, sheetId, dispose }
  } catch (error) { await dispose(); throw error }
}
