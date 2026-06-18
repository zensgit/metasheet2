/**
 * Migration: #18 phase-2 (2b) conditional read-deny rules — storage only (inert until rules are authored
 * AND the per-sheet flag is on).
 *
 * Adds `meta_sheets.conditional_read_rules` jsonb, DEFAULT '[]'. A rule is
 * `{ id, fieldId, operator, value?, effect:'deny_read' }`; a record whose data matches ANY rule is
 * read-denied — fed into the SAME per-record deny set #18 already enforces on every read surface
 * (loadDeniedRecordIds), so admin-bypass / no-cardinality-leak / masking all come from the #18 machinery.
 *
 * Double-inert + non-breaking: gated by the existing `row_level_read_permissions_enabled` flag (default
 * false → no surface even computes the deny set) AND default-empty rules (flag on + no rules = no
 * rule-deny). Byte-identical to today until an owner both enables the flag and authors a rule.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_sheets ADD COLUMN IF NOT EXISTS conditional_read_rules jsonb NOT NULL DEFAULT '[]'::jsonb`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE meta_sheets DROP COLUMN IF EXISTS conditional_read_rules`.execute(db)
}
