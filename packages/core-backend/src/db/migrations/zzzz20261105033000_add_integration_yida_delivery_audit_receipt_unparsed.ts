import { sql, type Kysely } from 'kysely'

/**
 * YiDa owner send, gate 6 (R-71 ⑦.1, owner choice a2, 2026-11-04): a FIFTH `outcome_unknown` reason for the
 * delivery audit, `receipt_unparsed`.
 *
 * WHAT IT CHANGES. `integration_yida_delivery_audit.reason` (created by 090 with a column CHECK over four
 * values: transport_unknown, commit_unknown, receipt_invalid, manual_recovery) additionally accepts
 * `receipt_unparsed`. The plugin writes it when the form transport RECEIVED a 2xx status line but could not use
 * the body (not UTF-8 / not JSON / no `result` / over the 16 KiB cap / errored or stalled stream past the body
 * deadline). Until now that case shared `receipt_invalid` with "4xx/5xx/redirect", so the ledger could not tell
 * "the remote answered 2xx" from "the remote refused". Nothing else moves: the ledger status machine, the
 * `outcome_unknown` row, the never-retry rule and the audit shape CHECK (`event = 'unknown'` <=> reason NOT NULL)
 * are untouched. No switch, no new env flag.
 *
 * HOW. The reason CHECK is located through pg_constraint as THE single-column CHECK on `reason` (090 lets
 * PostgreSQL name it, normally `integration_yida_delivery_audit_reason_check`; the name is verified, never
 * assumed), dropped, and re-added under the canonical name with five values. Replayable: when the located CHECK
 * already admits the new reason, up() is a no-op. Values-free: every refusal is a fixed code.
 *
 * down() REFUSES while any audit row already carries `receipt_unparsed` (the audit is append-only evidence; a
 * narrower CHECK could not hold it and the rows must not be rewritten). With no such row it restores the exact
 * four-value CHECK from 090.
 */

export const YIDA_DELIVERY_UNKNOWN_REASONS_090 = Object.freeze(['transport_unknown', 'commit_unknown', 'receipt_invalid', 'manual_recovery'] as const)
export const YIDA_DELIVERY_UNKNOWN_REASON_RECEIPT_UNPARSED = 'receipt_unparsed'
export const YIDA_DELIVERY_AUDIT_REASON_CHECK = 'integration_yida_delivery_audit_reason_check'
export const YIDA_DELIVERY_AUDIT_RECEIPT_UNPARSED_DOWN_REFUSED_CODE = 'YIDA_DELIVERY_AUDIT_RECEIPT_UNPARSED_PRESENT'

// The DO bodies are dollar-quoted, so plain single-quoted SQL literals are correct inside them.
const quoted = (values: readonly string[]) => values.map(value => `'${value}'`).join(', ')
const WIDENED = quoted([...YIDA_DELIVERY_UNKNOWN_REASONS_090, YIDA_DELIVERY_UNKNOWN_REASON_RECEIPT_UNPARSED])
const ORIGINAL = quoted(YIDA_DELIVERY_UNKNOWN_REASONS_090)

// Shared locator: the one CHECK whose conkey is exactly the `reason` column. The audit shape CHECK spans
// event/status/reason and is therefore never matched. Zero or several matches fail closed.
const LOCATE_REASON_CHECK = `
  SELECT a.attnum INTO reason_attnum FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = audit_oid AND a.attname = 'reason' AND NOT a.attisdropped;
  IF reason_attnum IS NULL THEN RAISE EXCEPTION 'YIDA_DELIVERY_AUDIT_REASON_COLUMN_MISSING' USING ERRCODE = '42703'; END IF;
  SELECT count(*), min(c.conname), min(pg_catalog.pg_get_constraintdef(c.oid, true)) INTO check_count, check_name, check_definition
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = audit_oid AND c.contype = 'c' AND c.conkey = ARRAY[reason_attnum]::smallint[];
  IF check_count <> 1 THEN RAISE EXCEPTION 'YIDA_DELIVERY_AUDIT_REASON_CHECK_AMBIGUOUS' USING ERRCODE = '55000'; END IF;
`

export const YIDA_DELIVERY_AUDIT_RECEIPT_UNPARSED_UP_SQL = `
DO $yida_receipt_unparsed_up$
DECLARE
  audit_oid oid := to_regclass('integration_yida_delivery_audit');
  reason_attnum smallint;
  check_count integer;
  check_name text;
  check_definition text;
BEGIN
  IF audit_oid IS NULL THEN RAISE EXCEPTION 'YIDA_DELIVERY_AUDIT_MISSING' USING ERRCODE = '42P01'; END IF;
  ${LOCATE_REASON_CHECK}
  -- Replay: the located CHECK already admits the new reason.
  IF position('''${YIDA_DELIVERY_UNKNOWN_REASON_RECEIPT_UNPARSED}''' IN check_definition) > 0 THEN RETURN; END IF;
  EXECUTE format('ALTER TABLE integration_yida_delivery_audit DROP CONSTRAINT %I', check_name);
  ALTER TABLE integration_yida_delivery_audit ADD CONSTRAINT ${YIDA_DELIVERY_AUDIT_REASON_CHECK}
    CHECK (reason IS NULL OR reason IN (${WIDENED}));
END;
$yida_receipt_unparsed_up$;
`

export const YIDA_DELIVERY_AUDIT_RECEIPT_UNPARSED_DOWN_SQL = `
DO $yida_receipt_unparsed_down$
DECLARE
  audit_oid oid := to_regclass('integration_yida_delivery_audit');
  reason_attnum smallint;
  check_count integer;
  check_name text;
  check_definition text;
BEGIN
  IF audit_oid IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM integration_yida_delivery_audit WHERE reason = '${YIDA_DELIVERY_UNKNOWN_REASON_RECEIPT_UNPARSED}') THEN
    RAISE EXCEPTION '${YIDA_DELIVERY_AUDIT_RECEIPT_UNPARSED_DOWN_REFUSED_CODE}' USING ERRCODE = '55000';
  END IF;
  ${LOCATE_REASON_CHECK}
  -- Already narrow (never widened, or already rolled back).
  IF position('''${YIDA_DELIVERY_UNKNOWN_REASON_RECEIPT_UNPARSED}''' IN check_definition) = 0 THEN RETURN; END IF;
  EXECUTE format('ALTER TABLE integration_yida_delivery_audit DROP CONSTRAINT %I', check_name);
  ALTER TABLE integration_yida_delivery_audit ADD CONSTRAINT ${YIDA_DELIVERY_AUDIT_REASON_CHECK}
    CHECK (reason IS NULL OR reason IN (${ORIGINAL}));
END;
$yida_receipt_unparsed_down$;
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_DELIVERY_AUDIT_RECEIPT_UNPARSED_UP_SQL).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_DELIVERY_AUDIT_RECEIPT_UNPARSED_DOWN_SQL).execute(db)
}
