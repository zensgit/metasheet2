import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

/**
 * D1/D3 — deprovision ledger schema + users.access_generation (Rev 4.2 companion).
 * manual_review-friendly defaults; no backfill of historical deprovisions.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  if (await checkTableExists(db, 'users')) {
    await sql`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS access_generation bigint NOT NULL DEFAULT 0
    `.execute(db)
  }

  if (!(await checkTableExists(db, 'directory_deprovision_events'))) {
    await sql`
      CREATE TABLE directory_deprovision_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id text NOT NULL,
        integration_id text NOT NULL,
        directory_account_id text NOT NULL,
        local_user_id text NOT NULL,
        run_id text,
        triggered_by text,
        event_origin text NOT NULL DEFAULT 'sync',
        access_generation_at_apply bigint NOT NULL,
        status text NOT NULL DEFAULT 'open',
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )
    `.execute(db)
    await sql`
      CREATE INDEX idx_directory_deprovision_events_user
      ON directory_deprovision_events (local_user_id)
    `.execute(db)
  }

  if (!(await checkTableExists(db, 'directory_deprovision_effects'))) {
    await sql`
      CREATE TABLE directory_deprovision_effects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid,
        local_user_id text NOT NULL,
        org_id text,
        effect_type text NOT NULL,
        before_active boolean NOT NULL,
        after_active boolean NOT NULL,
        access_generation_at_apply bigint NOT NULL,
        status text NOT NULL DEFAULT 'applied',
        reversed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )
    `.execute(db)
    await sql`
      CREATE INDEX idx_directory_deprovision_effects_user_status
      ON directory_deprovision_effects (local_user_id, status)
    `.execute(db)
  }

  // Immutability triggers: block UPDATE of identity columns on events/effects.
  await sql`
    CREATE OR REPLACE FUNCTION directory_deprovision_reject_identity_update()
    RETURNS trigger AS $$
    BEGIN
      IF TG_TABLE_NAME = 'directory_deprovision_events' THEN
        IF NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.integration_id IS DISTINCT FROM OLD.integration_id
           OR NEW.directory_account_id IS DISTINCT FROM OLD.directory_account_id
           OR NEW.local_user_id IS DISTINCT FROM OLD.local_user_id
           OR NEW.access_generation_at_apply IS DISTINCT FROM OLD.access_generation_at_apply
           OR NEW.event_origin IS DISTINCT FROM OLD.event_origin
           OR NEW.run_id IS DISTINCT FROM OLD.run_id THEN
          RAISE EXCEPTION 'directory_deprovision_events identity fields are immutable';
        END IF;
      ELSIF TG_TABLE_NAME = 'directory_deprovision_effects' THEN
        IF NEW.effect_type IS DISTINCT FROM OLD.effect_type
           OR NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.before_active IS DISTINCT FROM OLD.before_active
           OR NEW.after_active IS DISTINCT FROM OLD.after_active
           OR NEW.access_generation_at_apply IS DISTINCT FROM OLD.access_generation_at_apply
           OR NEW.local_user_id IS DISTINCT FROM OLD.local_user_id THEN
          RAISE EXCEPTION 'directory_deprovision_effects identity fields are immutable';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_deprovision_events_immutable ON directory_deprovision_events`.execute(db)
  await sql`
    CREATE TRIGGER trg_deprovision_events_immutable
    BEFORE UPDATE ON directory_deprovision_events
    FOR EACH ROW EXECUTE FUNCTION directory_deprovision_reject_identity_update()
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_deprovision_effects_immutable ON directory_deprovision_effects`.execute(db)
  await sql`
    CREATE TRIGGER trg_deprovision_effects_immutable
    BEFORE UPDATE ON directory_deprovision_effects
    FOR EACH ROW EXECUTE FUNCTION directory_deprovision_reject_identity_update()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_deprovision_effects_immutable ON directory_deprovision_effects`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_deprovision_events_immutable ON directory_deprovision_events`.execute(db)
  await sql`DROP FUNCTION IF EXISTS directory_deprovision_reject_identity_update()`.execute(db)
  await sql`DROP TABLE IF EXISTS directory_deprovision_effects`.execute(db)
  await sql`DROP TABLE IF EXISTS directory_deprovision_events`.execute(db)
  if (await checkTableExists(db, 'users')) {
    await sql`ALTER TABLE users DROP COLUMN IF EXISTS access_generation`.execute(db)
  }
}
