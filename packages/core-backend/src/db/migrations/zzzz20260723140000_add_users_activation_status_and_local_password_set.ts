import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

/**
 * T1a — directory admission activation lifecycle (design lock Rev 4.2).
 *
 * Adds dual-axis columns:
 * - activation_status: pending_activation | activated (CHECK)
 * - local_password_set: whether password_hash is a usable local login secret
 *
 * Backfill: EVERY existing row → activated + local_password_set=true so password
 * login cannot mass-fail after migrate. Pending-create runtime stays env-gated
 * default OFF (see isDirectoryPendingActivationEnabled).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'users')
  if (!exists) return

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS activation_status text
  `.execute(db)

  await sql`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS local_password_set boolean
  `.execute(db)

  // Stock backfill BEFORE NOT NULL / defaults that would trap new rows as false.
  await sql`
    UPDATE users
    SET
      activation_status = COALESCE(NULLIF(trim(activation_status), ''), 'activated'),
      local_password_set = COALESCE(local_password_set, TRUE)
  `.execute(db)

  await sql`
    ALTER TABLE users
    ALTER COLUMN activation_status SET DEFAULT 'activated'
  `.execute(db)

  await sql`
    ALTER TABLE users
    ALTER COLUMN activation_status SET NOT NULL
  `.execute(db)

  await sql`
    ALTER TABLE users
    ALTER COLUMN local_password_set SET DEFAULT TRUE
  `.execute(db)

  await sql`
    ALTER TABLE users
    ALTER COLUMN local_password_set SET NOT NULL
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_activation_status_check'
      ) THEN
        ALTER TABLE users
        ADD CONSTRAINT users_activation_status_check
        CHECK (activation_status IN ('pending_activation', 'activated'));
      END IF;
    END $$
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_users_activation_status
    ON users (activation_status)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const exists = await checkTableExists(db, 'users')
  if (!exists) return

  await sql`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_activation_status_check
  `.execute(db)

  await sql`
    DROP INDEX IF EXISTS idx_users_activation_status
  `.execute(db)

  await sql`
    ALTER TABLE users DROP COLUMN IF EXISTS activation_status
  `.execute(db)

  await sql`
    ALTER TABLE users DROP COLUMN IF EXISTS local_password_set
  `.execute(db)
}
