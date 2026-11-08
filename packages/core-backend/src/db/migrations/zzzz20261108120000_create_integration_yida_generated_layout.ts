import { sql, type Kysely } from 'kysely'

/**
 * YiDa generated-layout seal (R-71 ⑦.4 PR-2 Y6, external review P1 of 2026-11-08; coordinator ruling T-level
 * default-forward, owner may veto within 24 h).
 *
 * WHY. The `generated` transform is validated per template (rule G1: one identity part, field parts on one side
 * only). That cannot stop a CROSS-TEMPLATE collision on one target: template A = [identity, field] with the field
 * cell holding P_B and template B = [field, identity] with the field cell holding P_A both produce P_A + P_B for two
 * different identities, and neither unique fence of the delivery ledger compares a generated code (they compare the
 * seven-key digest and the creation-identity digest, both of which differ here). The fix seals ONE generated layout
 * per approved target: a canonical, values-free signature of every generated entry's template (target, part kinds and
 * order, literal values, field / hash member targets, hash form, preset id and every preset option) is written here
 * once, atomically with the first approval (or admission) that uses a generated entry, and every later selection
 * for that target whose signature differs is refused (YIDA_SEND_APPROVAL_GENERATED_LAYOUT_CONFLICT, 409). A selection
 * WITHOUT a generated entry (a v2 layout, or a v3 config with none) has the null signature and is refused on a sealed
 * target as well (verifier r1 of the fix): otherwise a cell mapped directly onto the sealed code target could carry
 * another identity's generated code, and the guarantee would hold for generated codes only. With one sealed layout and
 * G1's one-side rule the identity part sits at one fixed offset for every code of the target, so two equal codes carry
 * equal identity parts, and equal identity parts are what the two fences refuse.
 *
 * WHAT IT ADDS (additive; nothing existing changes):
 *   - `integration_yida_generated_layout`: one row per approved target (`target_ref`, FK to the 094 approved-target
 *     row), the owner scope, `layout_digest` (sha256 of the canonical signature, 64-hex, values-free: no code, no
 *     cell, no credential), the draft operation whose approval / admission sealed it, the event and the actor.
 *   - the 094-style immutable guard: INSERT only; UPDATE / DELETE / TRUNCATE raise YIDA_GENERATED_LAYOUT_IMMUTABLE.
 *
 * WHAT IT DOES NOT DO. No switch, no send authority, no change to the two ledger fences, the approvals or the draft
 * store. A target whose drafts carry no generated entry never gets a row (the seal step reads the row and writes nothing
 * for them): sends before a target's first generated approval are invisible to the seal, so the guarantee holds from
 * that approval onward.
 *
 * UPGRADE ORDER. Apply this migration before the build that carries the seal step takes approvals: the send authority
 * reads this table for EVERY approval and admission (v2 included), so without it every approval fails closed
 * (YIDA_SEND_APPROVAL_UNAVAILABLE) until the table exists.
 *
 * CORRECTING A SEALED LAYOUT. There is no operator path and none is planned: the row is INSERT-only, a reused or
 * re-confirmed slot keeps its target_ref (and so its seal), and a second target for the same app/form is refused by the
 * locator check. A layout mistake is corrected by a NEW target (another form), or by an owner-approved privileged purge
 * of the seal row (guard disabled in a superuser session, audited, values-free) — never by the application.
 *
 * FK NOTE. `operation_id` REFERENCES integration_yida_draft_operations ON DELETE RESTRICT: a future draft purge (no
 * delete path exists today) must keep the sealing operation's row, or remove the seal row first through the privileged
 * path above.
 *
 * down() REFUSES (fixed code, ERRCODE 55000) while any row exists: a sealed layout is the evidence that every
 * GENERATED code sent under that target from the seal onward was minted under it. With no rows it drops the table and
 * the guard function.
 */

export const YIDA_GENERATED_LAYOUT_TABLE = 'integration_yida_generated_layout'
export const YIDA_GENERATED_LAYOUT_IMMUTABLE_CODE = 'YIDA_GENERATED_LAYOUT_IMMUTABLE'
export const YIDA_GENERATED_LAYOUT_DOWN_REFUSED_CODE = 'YIDA_GENERATED_LAYOUT_ROWS_PRESENT'

export const YIDA_GENERATED_LAYOUT_UP_SQL = `
CREATE TABLE IF NOT EXISTS integration_yida_generated_layout (
  target_ref TEXT PRIMARY KEY REFERENCES integration_yida_approved_target(target_ref) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  workspace_id TEXT CHECK (workspace_id IS NULL),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  layout_digest TEXT NOT NULL CHECK (layout_digest ~ '^[0-9a-f]{64}$'),
  operation_id TEXT NOT NULL REFERENCES integration_yida_draft_operations(operation_id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK (event IN ('approve', 'admit')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION integration_yida_generated_layout_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '${YIDA_GENERATED_LAYOUT_IMMUTABLE_CODE}';
END;
$$;
DROP TRIGGER IF EXISTS trg_yida_generated_layout_immutable ON integration_yida_generated_layout;
CREATE TRIGGER trg_yida_generated_layout_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_generated_layout
  FOR EACH ROW EXECUTE FUNCTION integration_yida_generated_layout_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_generated_layout_truncate ON integration_yida_generated_layout;
CREATE TRIGGER trg_yida_generated_layout_truncate
  BEFORE TRUNCATE ON integration_yida_generated_layout
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_generated_layout_immutable_guard();
`

export const YIDA_GENERATED_LAYOUT_DOWN_SQL = `
DO $yida_generated_layout_down$
DECLARE
  present boolean := false;
BEGIN
  IF to_regclass('${YIDA_GENERATED_LAYOUT_TABLE}') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM ${YIDA_GENERATED_LAYOUT_TABLE})' INTO present;
  END IF;
  IF present THEN
    RAISE EXCEPTION '${YIDA_GENERATED_LAYOUT_DOWN_REFUSED_CODE}' USING ERRCODE = '55000';
  END IF;
END;
$yida_generated_layout_down$;
DROP TABLE IF EXISTS integration_yida_generated_layout;
DROP FUNCTION IF EXISTS integration_yida_generated_layout_immutable_guard();
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_GENERATED_LAYOUT_UP_SQL).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_GENERATED_LAYOUT_DOWN_SQL).execute(db)
}
