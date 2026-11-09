import { sql, type Kysely } from 'kysely'

/**
 * YiDa standardization slice Y2: MORE THAN ONE owner-attested YiDa target (app + form) per deployment.
 *
 * WHAT IT ADDS (additive; the existing single-target row is untouched and stays the tenant's FIRST target):
 *   - `integration_yida_approved_target.slot` and its audit `slot` accept 1..16 instead of exactly 1. Slot 1 keeps
 *     its meaning (the initialization slot). Slots 2..16 are additional targets of the SAME anchor owner/tenant:
 *     a BEFORE INSERT trigger refuses a slot > 1 unless slot 1 exists with that same tenant/owner and NULL workspace.
 *   - a unique index on `draft_target_ref`: one approved target per local draft target (= per app/form locator).
 *   - `integration_yida_target_registrations`: the append-only command record of each additional target (slot,
 *     target_ref, owner, tenant, its own sealed draft operation and its own generation-1 credential material). It is
 *     the idempotency/command anchor for slots 2..16, the way `integration_yida_initializations` is for slot 1.
 *
 * WHAT IT DOES NOT DO. No send authority, no grant, no switch. Every new row is written only by the host
 * multi-target registration path, which is default OFF behind INTEGRATION_YIDA_MULTI_TARGET_ENABLED (exact 'true').
 * With the switch OFF every reader keeps selecting `slot = 1` exactly as before.
 *
 * down() REFUSES while any additional target or registration row exists (the approved target, its audit row and
 * its registration are permanent, append-only evidence; dropping or re-narrowing them would discard it). With no
 * such row it restores the exact pre-Y2 constraints and drops what up() added. Values-free: the refusal names a
 * code only.
 */

export const YIDA_MULTI_TARGET_MAX_SLOT = 16
export const YIDA_MULTI_TARGET_DOWN_REFUSED_CODE = 'YIDA_MULTI_TARGET_ROWS_PRESENT'

export const YIDA_MULTI_TARGET_UP_SQL = `
ALTER TABLE integration_yida_approved_target DROP CONSTRAINT IF EXISTS integration_yida_approved_target_slot_check;
ALTER TABLE integration_yida_approved_target
  ADD CONSTRAINT integration_yida_approved_target_slot_check CHECK (slot BETWEEN 1 AND 16);
ALTER TABLE integration_yida_approved_target_audit DROP CONSTRAINT IF EXISTS integration_yida_approved_target_audit_slot_check;
ALTER TABLE integration_yida_approved_target_audit
  ADD CONSTRAINT integration_yida_approved_target_audit_slot_check CHECK (slot BETWEEN 1 AND 16);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_yida_approved_target_draft
  ON integration_yida_approved_target (draft_target_ref);

CREATE OR REPLACE FUNCTION integration_yida_approved_target_extra_slot_guard() RETURNS trigger
LANGUAGE plpgsql AS $yida_extra_slot$
BEGIN
  IF NEW.slot <> 1 AND NOT EXISTS (SELECT 1 FROM integration_yida_approved_target first_target
    WHERE first_target.slot = 1 AND first_target.tenant_id = NEW.tenant_id
      AND first_target.owner_id = NEW.owner_id AND first_target.workspace_id IS NULL) THEN
    RAISE EXCEPTION 'YIDA_APPROVED_TARGET_EXTRA_SLOT';
  END IF;
  RETURN NEW;
END;
$yida_extra_slot$;
DROP TRIGGER IF EXISTS trg_yida_approved_target_extra_slot ON integration_yida_approved_target;
CREATE TRIGGER trg_yida_approved_target_extra_slot
  BEFORE INSERT ON integration_yida_approved_target
  FOR EACH ROW EXECUTE FUNCTION integration_yida_approved_target_extra_slot_guard();

CREATE TABLE IF NOT EXISTS integration_yida_target_registrations (
  command_id TEXT PRIMARY KEY CHECK (command_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  slot INTEGER NOT NULL UNIQUE CHECK (slot BETWEEN 2 AND 16)
    REFERENCES integration_yida_approved_target(slot) ON DELETE RESTRICT,
  target_ref TEXT NOT NULL UNIQUE REFERENCES integration_yida_approved_target(target_ref) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  workspace_id TEXT CHECK (workspace_id IS NULL),
  operation_id TEXT NOT NULL REFERENCES integration_yida_draft_operations(operation_id) ON DELETE RESTRICT,
  credential_ref TEXT NOT NULL UNIQUE REFERENCES integration_yida_credential_materials(credential_ref) ON DELETE RESTRICT,
  credential_generation INTEGER NOT NULL CHECK (credential_generation = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION integration_yida_target_registration_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $yida_registration$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := NOW();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'YIDA_TARGET_REGISTRATION_IMMUTABLE' USING ERRCODE = '55000';
END;
$yida_registration$;
DROP TRIGGER IF EXISTS trg_yida_target_registrations_immutable ON integration_yida_target_registrations;
CREATE TRIGGER trg_yida_target_registrations_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_target_registrations
  FOR EACH ROW EXECUTE FUNCTION integration_yida_target_registration_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_target_registrations_truncate ON integration_yida_target_registrations;
CREATE TRIGGER trg_yida_target_registrations_truncate
  BEFORE TRUNCATE ON integration_yida_target_registrations
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_target_registration_immutable_guard();
REVOKE ALL ON TABLE integration_yida_target_registrations FROM PUBLIC;
`

export const YIDA_MULTI_TARGET_DOWN_SQL = `
DO $yida_multi_target_down$
BEGIN
  IF EXISTS (SELECT 1 FROM integration_yida_approved_target WHERE slot <> 1)
    OR EXISTS (SELECT 1 FROM integration_yida_approved_target_audit WHERE slot <> 1)
    OR (to_regclass('integration_yida_target_registrations') IS NOT NULL
      AND EXISTS (SELECT 1 FROM integration_yida_target_registrations)) THEN
    RAISE EXCEPTION '${YIDA_MULTI_TARGET_DOWN_REFUSED_CODE}' USING ERRCODE = '55000';
  END IF;
END;
$yida_multi_target_down$;
DROP TABLE IF EXISTS integration_yida_target_registrations;
DROP FUNCTION IF EXISTS integration_yida_target_registration_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_approved_target_extra_slot ON integration_yida_approved_target;
DROP FUNCTION IF EXISTS integration_yida_approved_target_extra_slot_guard();
DROP INDEX IF EXISTS uniq_integration_yida_approved_target_draft;
ALTER TABLE integration_yida_approved_target_audit DROP CONSTRAINT IF EXISTS integration_yida_approved_target_audit_slot_check;
ALTER TABLE integration_yida_approved_target_audit
  ADD CONSTRAINT integration_yida_approved_target_audit_slot_check CHECK (slot = 1);
ALTER TABLE integration_yida_approved_target DROP CONSTRAINT IF EXISTS integration_yida_approved_target_slot_check;
ALTER TABLE integration_yida_approved_target
  ADD CONSTRAINT integration_yida_approved_target_slot_check CHECK (slot = 1);
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_MULTI_TARGET_UP_SQL).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_MULTI_TARGET_DOWN_SQL).execute(db)
}
