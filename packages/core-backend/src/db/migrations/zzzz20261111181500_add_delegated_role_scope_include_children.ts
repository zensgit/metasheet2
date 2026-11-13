/**
 * Delegated department scopes persist `include_children`.
 *
 * Contract for the admin-users writer (this file does not wire that API):
 * - Column, both tables, snakecase: `include_children`
 * - Type: boolean NOT NULL DEFAULT true
 * - API counterpart: `includeChildren`
 * - Tables (names verified against zzzz20260409113000 and zzzz20260409134000):
 *   `delegated_role_admin_scopes`, `delegated_role_scope_template_departments`
 * - Existing rows and an INSERT that omits the column store true.
 * - The unique key stays (admin_user_id, namespace, directory_department_id) on
 *   admin scopes, and (template_id, directory_department_id) on template departments.
 *   One flag per department row. Overlap is across ancestor and descendant rows.
 *
 * Release order. A build that does not read this column always expands descendants,
 * so it treats a stored false as true and broadens access. Every reader of these
 * tables (stock-preparation member expansion, the security-action privilege witness,
 * and the admin-users delegation list, count, and access queries) must be running
 * a build that honors the column before any writer persists false.
 *
 * up() is idempotent. The first run adds the column with a constant default, so
 * existing rows become true without a table rewrite. A later run finds the column
 * and does nothing.
 *
 * down() is not a single-statement CASE guard. PostgreSQL resolves a column
 * reference when it parses the statement, including a reference written in a CASE
 * branch that information_schema would not select. A missing include_children
 * therefore fails that statement even when the CASE looks like it skips the table.
 *
 * The tables themselves are the presence contract: both were created by earlier
 * migrations, and this down() locks them. Column presence is a later catalog read.
 * A count that names include_children is sent only after that read says the column
 * is there, and only as its own statement. A table with no such catalog row is not
 * counted. DROP COLUMN IF EXISTS then covers a column that is already gone. That
 * is not a claim that one statement can both discover and read the column.
 *
 * Lock order, before any false-row read: ACCESS EXCLUSIVE on
 * delegated_role_admin_scopes, then delegated_role_scope_template_departments,
 * in one LOCK TABLE. That is the mode DROP COLUMN takes, so the check does not
 * upgrade the lock afterwards. A concurrent insert or update of false cannot
 * commit between the count and the drop. The migration runner holds this work in
 * one transaction. Refusal throws, the transaction rolls back, the lock ends, and
 * both columns stay.
 *
 * Refusal is the sum of false rows on whichever of the two columns is present.
 * One false row on either table refuses the whole down(). Nothing is dropped.
 * Clear the false rows, or leave the columns in place. With no false row, dropping
 * the columns matches the old always-expand behavior because every remaining
 * scope is true.
 *
 * Ordering: no zzzz20261111 migration existed when this file was added. It sorts
 * after the 2026-11-06 security-action proof migration and after the
 * delegated-scope tables it alters.
 */
import { sql, type Kysely } from 'kysely'

export const DELEGATED_SCOPE_INCLUDE_CHILDREN_COLUMN = 'include_children'
export const DELEGATED_SCOPE_INCLUDE_CHILDREN_TABLES = [
  'delegated_role_admin_scopes',
  'delegated_role_scope_template_departments',
] as const
export const DELEGATED_SCOPE_INCLUDE_CHILDREN_DOWN_REFUSED_CODE = 'DELEGATED_SCOPE_INCLUDE_CHILDREN_FALSE_ROWS_PRESENT'

const MIGRATION = 'zzzz20261111181500_add_delegated_role_scope_include_children'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE delegated_role_admin_scopes
      ADD COLUMN IF NOT EXISTS include_children boolean NOT NULL DEFAULT true
  `.execute(db)
  await sql`
    ALTER TABLE delegated_role_scope_template_departments
      ADD COLUMN IF NOT EXISTS include_children boolean NOT NULL DEFAULT true
  `.execute(db)
}

const ADMIN_SCOPES = 'delegated_role_admin_scopes'
const TEMPLATE_DEPARTMENTS = 'delegated_role_scope_template_departments'

export async function down(db: Kysely<unknown>): Promise<void> {
  // One statement, fixed order, before any read of include_children. ACCESS
  // EXCLUSIVE is the mode the later DROP COLUMN takes, so this does not upgrade.
  await sql`
    LOCK TABLE delegated_role_admin_scopes, delegated_role_scope_template_departments
    IN ACCESS EXCLUSIVE MODE
  `.execute(db)

  const found = await sql<{ table_name: string }>`
    SELECT table_name
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND column_name = 'include_children'
       AND table_name IN ('delegated_role_admin_scopes', 'delegated_role_scope_template_departments')
  `.execute(db)
  const present = new Set(found.rows.map((row) => row.table_name))

  let falseRows = 0
  if (present.has(ADMIN_SCOPES)) {
    const result = await sql<{ count: number }>`
      SELECT count(*)::int AS count
        FROM delegated_role_admin_scopes
       WHERE include_children IS FALSE
    `.execute(db)
    falseRows += Number(result.rows[0]?.count ?? 0)
  }
  if (present.has(TEMPLATE_DEPARTMENTS)) {
    const result = await sql<{ count: number }>`
      SELECT count(*)::int AS count
        FROM delegated_role_scope_template_departments
       WHERE include_children IS FALSE
    `.execute(db)
    falseRows += Number(result.rows[0]?.count ?? 0)
  }
  if (falseRows > 0) {
    const error = new Error(
      `[${MIGRATION}] down() refused: ${falseRows} scope row(s) store include_children = false. Dropping the column would make a reader that ignores the flag expand those departments to every descendant and silently broaden access. Nothing was changed. Clear the false rows first, or leave the column in place.`,
    )
    ;(error as Error & { code?: string }).code = DELEGATED_SCOPE_INCLUDE_CHILDREN_DOWN_REFUSED_CODE
    throw error
  }
  await sql`ALTER TABLE delegated_role_scope_template_departments DROP COLUMN IF EXISTS include_children`.execute(db)
  await sql`ALTER TABLE delegated_role_admin_scopes DROP COLUMN IF EXISTS include_children`.execute(db)
}
