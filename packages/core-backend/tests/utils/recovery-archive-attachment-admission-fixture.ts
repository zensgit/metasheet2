import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { createOwnedClaimFixture } from './recovery-archive-owned-claim-fixture'
import { dropScratchDatabase, formatScratchDropOutcome } from '../helpers/scratch-database'

export const ATTACHMENT_ADMISSION_EXTRA_MIGRATIONS = [
  '20250924190000_create_rbac_tables',
  'zzzz20260119100000_create_users_table',
  'zzzz20260324150000_create_directory_sync_tables',
  'zzzz20260405190000_create_spreadsheet_permissions',
  'zzzz20260406030000_add_spreadsheet_permission_subjects',
  'zzzz20260406093000_add_meta_record_created_by',
  'zzzz20260409134000_create_delegated_role_scope_templates',
  'zzzz20260409154000_create_platform_member_groups_and_delegated_group_scopes',
] as const

export async function createAttachmentAdmissionFixture(admin: Pool, missingProtectionSchema = false) {
  let fixture: Awaited<ReturnType<typeof createOwnedClaimFixture>>
  if (!missingProtectionSchema) fixture = await createOwnedClaimFixture(admin)
  else {
    const namespace = `tm_attachment_admission_${randomUUID().replaceAll('-', '').slice(0, 10)}`
    const database = `${namespace}_db`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(process.env.DATABASE_URL!)
    url.pathname = `/${database}`
    const pool = new Pool({ connectionString: url.toString(), max: 6, connectionTimeoutMillis: 500 })
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    for (const name of ['zzz20251231_create_meta_schema', 'zzzz20260318110000_add_multitable_bases_and_permissions',
      'zzzz20260319103000_create_multitable_attachments']) {
      await db.transaction().execute((await import(`../../src/db/migrations/${name}.ts`)).up)
    }
    const identity = { actorId: randomUUID(), requestId: randomUUID(), workspaceId: `${namespace}_workspace`,
      baseId: `${namespace}_base`, sheetId: `${namespace}_sheet` }
    await pool.query(`INSERT INTO meta_bases(id,name,workspace_id,owner_id) VALUES($1,'Synthetic',$2,$3)`,
      [identity.baseId, identity.workspaceId, identity.actorId])
    await pool.query(`INSERT INTO meta_sheets(id,base_id,name) VALUES($1,$2,'Synthetic')`, [identity.sheetId, identity.baseId])
    fixture = { pool, identity, keyId: '', checkpointId: '',
      async dispose() {
        await db.destroy()
        const outcome = await dropScratchDatabase(admin, database)
        console.log(formatScratchDropOutcome('attachment-admission', outcome))
        if (outcome.forced || outcome.residualBackends) throw new Error('attachment_admission_scratch_cleanup_not_clean')
      },
      async addHead() { throw new Error('early_schema_has_no_history') },
      async addAttachments() { throw new Error('early_schema_has_no_claim') },
    }
  }
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: fixture.pool }) })
  try {
    for (const name of ATTACHMENT_ADMISSION_EXTRA_MIGRATIONS) {
      await db.transaction().execute((await import(`../../src/db/migrations/${name}.ts`)).up)
    }
    await fixture.pool.query(`INSERT INTO users(id,email,password_hash,permissions) VALUES($1,$2,'synthetic-unused','["multitable:read"]')`,
      [fixture.identity.actorId, `${fixture.identity.actorId}@synthetic.invalid`])
    const fieldId = `${fixture.identity.sheetId}_files`
    const recordId = `${fixture.identity.sheetId}_record`
    await fixture.pool.query(`INSERT INTO meta_fields(id,sheet_id,name,type) VALUES($1,$2,'Synthetic','attachment')`,
      [fieldId, fixture.identity.sheetId])
    await fixture.pool.query(`INSERT INTO meta_records(id,sheet_id,data,created_by) VALUES($1,$2,$3::jsonb,$4)`,
      [recordId, fixture.identity.sheetId, JSON.stringify({ [fieldId]: [] }), fixture.identity.actorId])
    await fixture.pool.query(`INSERT INTO spreadsheet_permissions(sheet_id,user_id,subject_type,subject_id,perm_code)
      VALUES($1,$2,'user',$2,'spreadsheet:write')`, [fixture.identity.sheetId, fixture.identity.actorId])
    return { ...fixture, fieldId, recordId, missingProtectionSchema }
  } catch (error) { await fixture.dispose(); throw error }
}
export type AttachmentAdmissionFixture = Awaited<ReturnType<typeof createAttachmentAdmissionFixture>>
