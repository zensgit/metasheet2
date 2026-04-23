import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Wave 2 WP4 slice 1 (审批模板分类): introduce a nullable `category` column on
 * `approval_templates` so the template center can group/filter by business
 * category (eg 请假 / 采购 / 报销). The partial index covers the common case
 * where callers scope by category AND status; rows with NULL category are
 * excluded from the index so uncategorized templates do not bloat it.
 *
 * Template-level ACL, field linkage, and conditional field visibility are also
 * WP4 targets but are intentionally out of scope for this slice.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_templates ADD COLUMN IF NOT EXISTS category TEXT`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_approval_templates_category_status
    ON approval_templates(category, status)
    WHERE category IS NOT NULL`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_approval_templates_category_status`.execute(db)
  await sql`ALTER TABLE approval_templates DROP COLUMN IF EXISTS category`.execute(db)
}
