import type { Kysely } from 'kysely'
import { sql } from 'kysely'

const COMPENSATED_EFFECT_IMMUTABILITY = `
        IF OLD.status = 'compensated'
           AND (
             NEW.status IS DISTINCT FROM OLD.status
             OR NEW.reversed_at IS DISTINCT FROM OLD.reversed_at
             OR NEW.reversed_by IS DISTINCT FROM OLD.reversed_by
             OR NEW.compensation_note IS DISTINCT FROM OLD.compensation_note
           ) THEN
          RAISE EXCEPTION 'compensated deprovision effect evidence is immutable';
        END IF;
`

function immutabilityFunction(compensationGuard: string): string {
  return `
    CREATE OR REPLACE FUNCTION directory_deprovision_reject_identity_update()
    RETURNS trigger AS $$
    BEGIN
      IF TG_TABLE_NAME = 'directory_deprovision_events' THEN
        IF NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.integration_id IS DISTINCT FROM OLD.integration_id
           OR NEW.directory_account_id IS DISTINCT FROM OLD.directory_account_id
           OR NEW.local_user_id IS DISTINCT FROM OLD.local_user_id
           OR NEW.link_witness_account_id IS DISTINCT FROM OLD.link_witness_account_id
           OR NEW.link_witness_local_user_id IS DISTINCT FROM OLD.link_witness_local_user_id
           OR NEW.policy IS DISTINCT FROM OLD.policy
           OR NEW.globally_clear IS DISTINCT FROM OLD.globally_clear
           OR NEW.access_generation_at_apply IS DISTINCT FROM OLD.access_generation_at_apply
           OR NEW.event_origin IS DISTINCT FROM OLD.event_origin
           OR NEW.run_id IS DISTINCT FROM OLD.run_id
           OR NEW.triggered_by IS DISTINCT FROM OLD.triggered_by THEN
          RAISE EXCEPTION 'directory_deprovision_events identity fields are immutable';
        END IF;
      ELSIF TG_TABLE_NAME = 'directory_deprovision_effects' THEN
${compensationGuard}
        IF NEW.event_id IS DISTINCT FROM OLD.event_id
           OR NEW.local_user_id IS DISTINCT FROM OLD.local_user_id
           OR NEW.effect_type IS DISTINCT FROM OLD.effect_type
           OR NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.before_active IS DISTINCT FROM OLD.before_active
           OR NEW.after_active IS DISTINCT FROM OLD.after_active
           OR NEW.grant_row_created IS DISTINCT FROM OLD.grant_row_created
           OR NEW.access_generation_at_apply IS DISTINCT FROM OLD.access_generation_at_apply THEN
          RAISE EXCEPTION 'directory_deprovision_effects identity fields are immutable';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
`
}

const IMMUTABILITY_FN_WITH_COMPENSATION_NOTE = immutabilityFunction(
  COMPENSATED_EFFECT_IMMUTABILITY,
)
const IMMUTABILITY_FN_PRIOR = immutabilityFunction('')

/**
 * OPS-01: record cleanup of a superseded grant-row creation without claiming
 * that the full deprovision event was restored.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE directory_deprovision_effects
      ADD COLUMN IF NOT EXISTS compensation_note text
  `.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      DROP CONSTRAINT IF EXISTS ddef_status_check
  `.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      ADD CONSTRAINT ddef_status_check
      CHECK (status IN ('applied','reversed','superseded','compensated'))
  `.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      DROP CONSTRAINT IF EXISTS ddfx_compensation_scope_check
  `.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      ADD CONSTRAINT ddfx_compensation_scope_check
      CHECK (
        (
          status = 'compensated'
          AND effect_type = 'grant_changed'
          AND grant_row_created = TRUE
          AND reversed_at IS NOT NULL
          AND COALESCE(length(btrim(reversed_by)), 0) > 0
          AND COALESCE(length(btrim(compensation_note)), 0) >= 8
        )
        OR (
          status <> 'compensated'
          AND compensation_note IS NULL
        )
      )
  `.execute(db)
  await sql.raw(IMMUTABILITY_FN_WITH_COMPENSATION_NOTE).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const witness = await sql`
    SELECT 1 AS present
      FROM directory_deprovision_effects
     WHERE status = 'compensated'
     LIMIT 1
  `.execute(db)
  if (witness.rows.length > 0) {
    throw new Error(
      'refusing to drop compensated effect status: OPS-01 compensation evidence exists',
    )
  }

  await sql.raw(IMMUTABILITY_FN_PRIOR).execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      DROP CONSTRAINT IF EXISTS ddfx_compensation_scope_check
  `.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      DROP CONSTRAINT IF EXISTS ddef_status_check
  `.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      ADD CONSTRAINT ddef_status_check
      CHECK (status IN ('applied','reversed','superseded'))
  `.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      DROP COLUMN IF EXISTS compensation_note
  `.execute(db)
}
