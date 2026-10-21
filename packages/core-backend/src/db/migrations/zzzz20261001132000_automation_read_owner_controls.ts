import { sql, type Kysely } from 'kysely'

/** Owner-scoped keyset history, independent of execution/profile availability.
 * Index-only additive change; rollback removes indexes, never retained history. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX idx_automation_read_grant_owner_page
    ON integration_automation_read_grants (tenant_id,owner_id,created_at DESC,id DESC)
    WHERE workspace_id IS NULL`.execute(db)
  await sql`CREATE INDEX idx_automation_read_request_owner_page
    ON integration_automation_read_requests (tenant_id,owner_id,created_at DESC,id DESC)
    WHERE workspace_id IS NULL`.execute(db)
  await sql`CREATE INDEX idx_automation_read_request_grant_page
    ON integration_automation_read_requests (tenant_id,owner_id,grant_id,created_at DESC,id DESC)
    WHERE workspace_id IS NULL`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_automation_read_request_grant_page`.execute(db)
  await sql`DROP INDEX idx_automation_read_request_owner_page`.execute(db)
  await sql`DROP INDEX idx_automation_read_grant_owner_page`.execute(db)
}
