import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'

import { sealDirectEventOperation } from '../../src/multitable/recovery-archive-seals'
import { dropScratchDatabase, formatScratchDropOutcome } from '../helpers/scratch-database'

// Actual migrations, in their production order. Every FK and authority trigger stays enabled.
export const OWNED_CLAIM_MIGRATIONS = [
  'zzz20251231_create_meta_schema',
  'zzzz20260318110000_add_multitable_bases_and_permissions',
  'zzzz20260319103000_create_multitable_attachments',
  'zzzz20260430172000_create_meta_record_revisions',
  'zzzz20260617120000_create_meta_records_trash',
  'zzzz20260624120000_create_meta_config_revisions',
  'zzzz20260708090000_create_meta_tombstone_tables',
  'zzzz20260709100000_add_delete_revision_id_to_meta_records_trash',
  'zzzz20260711090000_add_multitable_attachments_blob_purged_at',
  'zzzz20260713150000_create_meta_record_version_markers',
  'zzzz20260715160000_add_meta_record_chain_seq',
  'zzzz20260715170000_add_meta_sheet_recovery_writer_state',
  'zzzz20260715180000_create_meta_history_trust_checkpoints',
  'zzzz20260715210000_create_meta_record_history_operations',
  'zzzz20260826120000_create_meta_recovery_archive_catalog',
  'zzzz20260826121000_add_recovery_archive_staging_cleanup_protocol',
  'zzzz20260826122000_add_section_causality_substrate',
  'zzzz20260826122500_add_operation_binding_to_nonrecord_history',
  'zzzz20260826123000_add_archive_writer_block_ownership',
  'zzzz20260828120000_add_recovery_archive_snapshot_reservations',
  'zzzz20260828121000_add_recovery_archive_key_registry',
  'zzzz20260828124000_add_recovery_archive_source_pin_authority',
  'zzzz20260828126000_amend_recovery_archive_claim_anchor',
  'zzzz20260918120000_add_recovery_archive_section_checkpoints',
  'zzzz20260918140000_create_recovery_archive_manual_requests',
  'zzzz20260919120000_add_attachment_blob_purge_claim',
] as const

export async function createOwnedClaimFixture(admin: Pool) {
  const prefix = `tm_owned_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const name = `${prefix}_db`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(process.env.DATABASE_URL!)
  url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.toString(), max: 6, connectionTimeoutMillis: 500, options: '-c timezone=Asia/Taipei' })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  const identity = { actorId: randomUUID(), requestId: randomUUID(),
    workspaceId: `${prefix}_workspace`, baseId: `${prefix}_base`, sheetId: `${prefix}_sheet` }
  const keyId = `${prefix}_key`
  const checkpointId = `${prefix}_checkpoint`
  async function dispose() {
    await db.destroy()
    const outcome = await dropScratchDatabase(admin, name)
    console.log(formatScratchDropOutcome('recovery-archive-owned-claim', outcome))
    if (outcome.forced || outcome.residualBackends !== 0) throw new Error('owned_claim_scratch_cleanup_not_clean')
  }
  try {
    for (const filename of OWNED_CLAIM_MIGRATIONS) {
      const migration = await import(`../../src/db/migrations/${filename}.ts`)
      await db.transaction().execute(migration.up)
    }
    await pool.query(`INSERT INTO meta_bases (id,name,workspace_id,owner_id)
      VALUES ($1,'Synthetic',$2,$3)`, [identity.baseId, identity.workspaceId, identity.actorId])
    await pool.query(`INSERT INTO meta_sheets (id,base_id,name,recovery_writer_owner_fence)
      VALUES ($1,$2,'Synthetic',6)`, [identity.sheetId, identity.baseId])
    await pool.query(`INSERT INTO meta_history_trust_checkpoints
      (id,sheet_id,state,trusted_since_seq) VALUES ($1,$2,'active',1)`, [checkpointId, identity.sheetId])
    await pool.query('INSERT INTO meta_recovery_archive_keys (key_id) VALUES ($1)', [keyId])
  } catch (error) {
    await dispose()
    throw error
  }
  return { pool, identity, keyId, checkpointId, dispose,
    async addHead(provided?: PoolClient) {
      const client = provided ?? await pool.connect()
      if (!provided) await client.query('BEGIN')
      try {
        const operationId = randomUUID()
        const result = await client.query(`INSERT INTO meta_record_revisions
          (sheet_id,record_id,version,action,operation_id,snapshot)
          VALUES ($1,$2,1,'create',$3::uuid,'{}') RETURNING seq::text`,
        [identity.sheetId, `${prefix}_record_${operationId}`, operationId])
        const endpointSeq = String(result.rows[0].seq)
        await sealDirectEventOperation((text, params) => client.query(text, params), {
          sheetId: identity.sheetId, operationId, endpointSeq, eventCount: 1, operationKind: 'ordinary',
        })
        if (!provided) await client.query('COMMIT')
        return { operationId, endpointSeq }
      } finally {
        if (!provided) {
          await client.query('ROLLBACK')
          client.release()
        }
      }
    },
    async addAttachments(count: number) {
      const ids = Array.from({ length: count }, (_, index) => `${prefix}_attachment_${index}`)
      for (const id of ids) {
        await pool.query(`INSERT INTO multitable_attachments
          (id,sheet_id,storage_file_id,filename,mime_type,size,storage_path)
          VALUES ($1,$2,$3,'Synthetic','application/octet-stream',17,$4)`,
        [id, identity.sheetId, `${id}_storage`, `${id}_opaque`])
      }
      return ids
    },
  }
}

export type OwnedClaimFixture = Awaited<ReturnType<typeof createOwnedClaimFixture>>
