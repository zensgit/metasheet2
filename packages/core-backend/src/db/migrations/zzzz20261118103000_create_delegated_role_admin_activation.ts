import { sql, type Kysely } from 'kysely'

/** Stored choices are independent of the rollout and of plugin admission. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE delegated_role_admin_activation (
      admin_user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      namespace text NOT NULL,
      enabled boolean NOT NULL,
      revision uuid NOT NULL,
      PRIMARY KEY (admin_user_id, namespace)
    )
  `.execute(db)
}

/** An older reader would ignore persisted stops and could open the audience again. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`LOCK TABLE delegated_role_admin_activation IN ACCESS EXCLUSIVE MODE`.execute(db)
  const result = await sql<{ present: boolean }>`
    SELECT EXISTS (SELECT 1 FROM delegated_role_admin_activation) AS present
  `.execute(db)
  if (result.rows[0]?.present !== false) throw new Error('DELEGATED_SCOPE_ACTIVATION_STATE_PRESENT')
  await sql`DROP TABLE delegated_role_admin_activation`.execute(db)
}
