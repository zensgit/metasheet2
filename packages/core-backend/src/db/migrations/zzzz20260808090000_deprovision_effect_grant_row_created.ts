import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * Rev 4.4 (closeout-review directive, 2026-08-08): the OPS-01 explicit disabled grant row must
 * be ledger-evidenced as an EXISTENCE change, or restore cannot reverse it.
 *
 * Prior shape wrote the deny row unconditionally, outside the effects ledger: a person who
 * never had a grant, deprovisioned and later rehired, was left with an orphan enabled=FALSE
 * row that permanently blocked ensureGrant's creation-only OAuth auto-grant — with nothing in
 * the ledger for restore to act on.
 *
 * `grant_row_created = TRUE` marks a grant_changed effect whose change is the CREATION of the
 * disabled row (before_active = after_active = FALSE — nothing was ever enabled; the delta is
 * the row's existence). Restore reverses it by deleting the row, restoring absence.
 *
 * The CHECK pins the shape at the schema layer (§5.2 schema authority), and the immutability
 * trigger arm is extended so the creation flag is as tamper-proof as the rest of the evidence.
 */

const IMMUTABILITY_FN_WITH_GRANT_ROW_CREATED = `
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

const IMMUTABILITY_FN_PRIOR = IMMUTABILITY_FN_WITH_GRANT_ROW_CREATED.replace(
  "           OR NEW.grant_row_created IS DISTINCT FROM OLD.grant_row_created\n",
  '',
)

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE directory_deprovision_effects
      ADD COLUMN IF NOT EXISTS grant_row_created boolean NOT NULL DEFAULT FALSE
  `.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      DROP CONSTRAINT IF EXISTS ddfx_grant_row_created_scope_check
  `.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      ADD CONSTRAINT ddfx_grant_row_created_scope_check
      CHECK (
        grant_row_created = FALSE
        OR (
          effect_type = 'grant_changed'
          AND before_active = FALSE
          AND after_active = FALSE
        )
      )
  `.execute(db)
  await sql.raw(IMMUTABILITY_FN_WITH_GRANT_ROW_CREATED).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const witness = await sql`
    SELECT 1 AS present
      FROM directory_deprovision_effects
     WHERE grant_row_created = TRUE
     LIMIT 1
  `.execute(db)
  if (witness.rows.length > 0) {
    throw new Error(
      'refusing to drop grant_row_created: deny-row creation evidence exists and would become irreversible',
    )
  }
  await sql.raw(IMMUTABILITY_FN_PRIOR).execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      DROP CONSTRAINT IF EXISTS ddfx_grant_row_created_scope_check
  `.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      DROP COLUMN IF EXISTS grant_row_created
  `.execute(db)
}
