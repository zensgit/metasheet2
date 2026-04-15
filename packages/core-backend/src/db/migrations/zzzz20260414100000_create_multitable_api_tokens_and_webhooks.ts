import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── multitable_api_tokens ───────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS multitable_api_tokens (
      id text PRIMARY KEY,
      name text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      token_prefix text NOT NULL,
      scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      expires_at timestamptz,
      revoked boolean NOT NULL DEFAULT false,
      revoked_at timestamptz
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_multitable_api_tokens_hash
    ON multitable_api_tokens(token_hash)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_multitable_api_tokens_created_by
    ON multitable_api_tokens(created_by)
  `.execute(db)

  // ── multitable_webhooks ─────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS multitable_webhooks (
      id text PRIMARY KEY,
      name text NOT NULL,
      url text NOT NULL,
      secret text,
      events jsonb NOT NULL DEFAULT '[]'::jsonb,
      active boolean NOT NULL DEFAULT true,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz,
      last_delivered_at timestamptz,
      failure_count integer NOT NULL DEFAULT 0,
      max_retries integer NOT NULL DEFAULT 3
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_multitable_webhooks_created_by
    ON multitable_webhooks(created_by)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_multitable_webhooks_active
    ON multitable_webhooks(active)
  `.execute(db)

  // ── multitable_webhook_deliveries ───────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS multitable_webhook_deliveries (
      id text PRIMARY KEY,
      webhook_id text NOT NULL REFERENCES multitable_webhooks(id) ON DELETE CASCADE,
      event text NOT NULL,
      payload jsonb,
      status text NOT NULL DEFAULT 'pending',
      http_status integer,
      response_body text,
      attempt_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      delivered_at timestamptz,
      next_retry_at timestamptz
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_multitable_webhook_deliveries_webhook_id
    ON multitable_webhook_deliveries(webhook_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_multitable_webhook_deliveries_status
    ON multitable_webhook_deliveries(status)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_multitable_webhook_deliveries_status`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_multitable_webhook_deliveries_webhook_id`.execute(db)
  await sql`DROP TABLE IF EXISTS multitable_webhook_deliveries`.execute(db)

  await sql`DROP INDEX IF EXISTS idx_multitable_webhooks_active`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_multitable_webhooks_created_by`.execute(db)
  await sql`DROP TABLE IF EXISTS multitable_webhooks`.execute(db)

  await sql`DROP INDEX IF EXISTS idx_multitable_api_tokens_created_by`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_multitable_api_tokens_hash`.execute(db)
  await sql`DROP TABLE IF EXISTS multitable_api_tokens`.execute(db)
}
