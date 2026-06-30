import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * OAPI-4a — per-base/sheet scoped API tokens (design-lock
 * `docs/development/multitable-oapi4-scoped-tokens-designlock-20260629.md`, RATIFIED).
 *
 * Additive, nullable, NO backfill: existing tokens keep `base_ids = sheet_ids = NULL` →
 * **unscoped → creator-wide**, exactly today's OAPI-2 behavior. Scoping is opt-in per token; no
 * token's behavior changes on deploy. `text[]` whitelists; the §3 AND-composition is applied in the
 * request-time `oapiScopeGuard`, not in SQL.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE multitable_api_tokens ADD COLUMN IF NOT EXISTS base_ids text[]`.execute(db)
  await sql`ALTER TABLE multitable_api_tokens ADD COLUMN IF NOT EXISTS sheet_ids text[]`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE multitable_api_tokens DROP COLUMN IF EXISTS sheet_ids`.execute(db)
  await sql`ALTER TABLE multitable_api_tokens DROP COLUMN IF EXISTS base_ids`.execute(db)
}
