import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import type { Pool, PoolClient, QueryResult } from 'pg'
import { createRetentionDeploymentFixture } from './recovery-archive-retention-admission-fixture'
import { FOREIGN_RESET_MIGRATIONS } from './recovery-archive-foreign-reset-admission-fixture'

export const FRESH_WRITER_INITIAL_MIGRATIONS = [
  ...FOREIGN_RESET_MIGRATIONS.filter((name) => name <= 'zzzz20260826122500_add_operation_binding_to_nonrecord_history'
    && name !== 'zzzz20260715170000_add_meta_sheet_recovery_writer_state'),
  'zzzz20260624200000_add_config_revision_source',
].sort()
export const FRESH_WRITER_REMAINING_MIGRATIONS = FOREIGN_RESET_MIGRATIONS.filter((name) => !FRESH_WRITER_INITIAL_MIGRATIONS.includes(name))
export type WriterQuery = (sql: string, params?: unknown[]) => Promise<QueryResult>
export type WriterHook = (sql: string, params: unknown[] | undefined, client: PoolClient, execute: () => Promise<QueryResult>) => Promise<QueryResult>

export async function createFreshWriterFixture(admin: Pool) {
  const stage = await createRetentionDeploymentFixture(admin, 'missing-state')
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: stage.pool }) })
  try {
    await db.transaction().execute((await import('../../src/db/migrations/zzzz20260624200000_add_config_revision_source')).up)
    const scope = (await stage.query(`SELECT s.base_id,b.workspace_id FROM meta_sheets s JOIN meta_bases b ON b.id=s.base_id WHERE s.id=$1`, [stage.sheetId])).rows[0]
    const identity = { actorId: randomUUID(), requestId: randomUUID(), sheetId: stage.sheetId, baseId: scope.base_id as string, workspaceId: scope.workspace_id as string }
    const viewId = `${stage.sheetId}_g4_view`, keyId = `${stage.sheetId}_g4_key`, attachmentId = `${stage.sheetId}_g4_attachment`
    await stage.query(`INSERT INTO users(id,email,password_hash,role,permissions) VALUES($1,$2,'synthetic-unused','admin','["multitable:read","multitable:write","multitable:share","multitable:manage-schema"]')`, [identity.actorId, `${identity.actorId}@synthetic.invalid`])
    await stage.query('UPDATE meta_bases SET owner_id=$2 WHERE id=$1', [identity.baseId, identity.actorId])
    await stage.query("INSERT INTO meta_views(id,sheet_id,name,type,config) VALUES($1,$2,'Original','grid','{}')", [viewId, stage.sheetId])
    const control: { hook?: WriterHook; defaultRR: boolean; pid: number; inherited: string[]; autocommit: boolean } = { defaultRR: false, pid: 0, inherited: [], autocommit: false }
    const transaction = async <T>(work: (client: { query: WriterQuery }) => Promise<T>) => {
      const client = await stage.pool.connect(); control.pid = Reflect.get(client, 'processID') as number
      let prior: string | undefined
      try {
        if (control.defaultRR) { prior = (await client.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation; await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ'); control.inherited.push((await client.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation) }
        if (!control.autocommit) await client.query('BEGIN')
        const query: WriterQuery = (sql, params) => control.hook ? control.hook(sql, params, client, () => client.query(sql, params)) : client.query(sql, params)
        const value = await work({ query }); if (!control.autocommit) await client.query('COMMIT'); return value
      } catch (error) { if (!control.autocommit) await client.query('ROLLBACK'); throw error }
      finally { if (prior !== undefined) await client.query("SELECT set_config('default_transaction_isolation',$1,false)", [prior]); client.release() }
    }
    let completed = false
    async function completeMigrations() {
      if (completed) throw new Error('fresh_writer_fixture_migrations_already_complete')
      for (const name of FRESH_WRITER_REMAINING_MIGRATIONS) await db.transaction().execute((await import(`../../src/db/migrations/${name}.ts`)).up)
      await stage.query("INSERT INTO meta_history_trust_checkpoints(id,sheet_id,state,trusted_since_seq) VALUES($1,$2,'active',1)", [`${stage.sheetId}_checkpoint`, stage.sheetId])
      await stage.query('INSERT INTO meta_recovery_archive_keys(key_id) VALUES($1)', [keyId])
      await stage.query(`INSERT INTO multitable_attachments(id,sheet_id,storage_file_id,filename,mime_type,size,storage_path,storage_provider)
        VALUES($1,$2,$3,'Synthetic','application/octet-stream',17,$4,'local')`, [attachmentId, stage.sheetId, randomUUID(), `${randomUUID()}/sha256-${'5'.repeat(64)}`])
      completed = true
      console.log(`actualG4MigrationUps=${FRESH_WRITER_INITIAL_MIGRATIONS.length + FRESH_WRITER_REMAINING_MIGRATIONS.length}`)
    }
    console.log(`actualG4InitialMigrationUps=${FRESH_WRITER_INITIAL_MIGRATIONS.length}`)
    return { ...stage, identity, viewId, keyId, attachmentId, control, transaction, completeMigrations }
  } catch (error) { await stage.dispose(); throw error }
}
export type FreshWriterFixture = Awaited<ReturnType<typeof createFreshWriterFixture>>
