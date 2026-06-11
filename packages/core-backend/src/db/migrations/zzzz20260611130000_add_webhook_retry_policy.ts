import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Webhook configurable retry policy (ladder rank-6).
 *
 * `max_retries` already exists (default 3). Add two NULLABLE backoff columns so
 * existing rows are unchanged — NULL means "use the service default" (1s base,
 * uncapped exponential), exactly today's behavior. A per-webhook policy is
 * stored only when the caller opts in.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE multitable_webhooks
      ADD COLUMN IF NOT EXISTS retry_base_delay_ms integer,
      ADD COLUMN IF NOT EXISTS retry_max_delay_ms integer
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE multitable_webhooks
      DROP COLUMN IF EXISTS retry_max_delay_ms,
      DROP COLUMN IF EXISTS retry_base_delay_ms
  `.execute(db)
}
