import { sql, type Kysely } from 'kysely'

/** Historical and uninstrumented rows remain NULL; no attribution is inferred. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE user_roles ADD COLUMN assignment_source text
    CONSTRAINT user_roles_assignment_source_check CHECK (assignment_source IN ('manual', 'creation'))`.execute(db)
}

/** Do not silently discard recorded provenance during rollback. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`LOCK TABLE user_roles IN ACCESS EXCLUSIVE MODE`.execute(db)
  const result=await sql<{ count: number }>`SELECT count(*)::int AS count FROM user_roles WHERE assignment_source IS NOT NULL`.execute(db)
  if (Number(result.rows[0]?.count ?? 0)>0) throw new Error('USER_ROLE_ASSIGNMENT_PROVENANCE_PRESENT')
  await sql`ALTER TABLE user_roles DROP COLUMN assignment_source`.execute(db)
}
