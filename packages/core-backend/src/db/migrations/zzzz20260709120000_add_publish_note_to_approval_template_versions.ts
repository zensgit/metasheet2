import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * B3-09 (模板治理 — 版本历史 + 发布说明): a nullable free-text note captured on
 * `approval_template_versions` at PUBLISH time (`publishTemplate` writes it alongside the
 * `status = 'published'` flip — see ApprovalProductService.publishTemplate). `NULL` for every
 * pre-existing version (never published under this column, or published without a note) — the
 * versions-list endpoint and TemplateDetailView both render that as "no note" (backward
 * compatible, no backfill needed).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_template_versions ADD COLUMN IF NOT EXISTS publish_note TEXT`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE approval_template_versions DROP COLUMN IF EXISTS publish_note`.execute(db)
}
