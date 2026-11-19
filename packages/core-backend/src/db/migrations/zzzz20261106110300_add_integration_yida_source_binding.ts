import { sql, type Kysely } from 'kysely'

/**
 * YiDa source binding and creation-identity fence (design baseline v2.3 §3.3 and §7.2; decisions D16 a, D18, D20).
 *
 * WHAT IT ADDS (additive; every existing row keeps working with both new columns NULL):
 *   - `source_record_digest` and `creation_identity_digest` on the three tables a draft row travels through:
 *     `integration_yida_draft_rows` (093), `integration_yida_send_approvals` (095) and
 *     `integration_yida_delivery_ledger` (090). Each is a 64-hex sha256 or NULL. A row drafted from pasted
 *     rowsText has both NULL; only a row read by the server from a registered project sheet carries them.
 *       * source_record_digest   = sha256(canonical({ version: 1, kind: 'yida-source-record', sheetId, recordId,
 *                                   keyFieldId, keyValue, projectNo, fieldBindings, fieldDependencies }))
 *                                   — the PHYSICAL binding; used for re-authorization and write-back targeting,
 *                                   never as a fence.
 *       * creation_identity_digest = sha256(canonical({ version: 1, kind: 'yida-creation-identity', keyValue,
 *                                   projectNo })) — the LOGICAL creation identity: exactly the inputs of the
 *                                   material code, so "same code" is "same identity".
 *   - the IDENTITY FENCE on the ledger: a partial unique index over
 *     (tenant_id, COALESCE(workspace_id, ''), target_ref, creation_identity_digest) WHERE intent = 'create' AND
 *     creation_identity_digest IS NOT NULL. It coexists with the seven-key fence (091). Under one target the same
 *     identity is created once, whatever happened to the physical record or the seven business keys.
 *   - the two new columns join the immutable-column list of the 090 ledger guard (an UPDATE that touches either
 *     raises YIDA_DELIVERY_IMMUTABLE, as for every other identity column).
 *
 * WHAT IT DOES NOT DO. No switch, no send authority, no change to the seven-key fence, the status machine or the
 * audit tables. Unbound rows (NULL identity) are not covered by the new index; the host refuses them on formal
 * targets (D20) and slot 1, the material TEST copy, may still take them (R-71 decision 1).
 *
 * down() REFUSES while any row of the three tables carries a non-NULL digest (append-only evidence); with none it
 * restores the exact 090 guard function, drops the index and the six columns. Values-free: fixed codes only.
 */

export const YIDA_SOURCE_BINDING_DIGEST_COLUMNS = Object.freeze(['source_record_digest', 'creation_identity_digest'] as const)
export const YIDA_SOURCE_BINDING_TABLES = Object.freeze(['integration_yida_draft_rows', 'integration_yida_send_approvals',
  'integration_yida_delivery_ledger'] as const)
export const YIDA_CREATION_IDENTITY_FENCE = 'uniq_integration_yida_delivery_create_identity'
export const YIDA_SOURCE_BINDING_DOWN_REFUSED_CODE = 'YIDA_SOURCE_BINDING_ROWS_PRESENT'

const digestColumns = (table: string) => YIDA_SOURCE_BINDING_DIGEST_COLUMNS.map(column =>
  `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} TEXT CHECK (${column} IS NULL OR ${column} ~ '^[0-9a-f]{64}$');`).join('\n')

// The 090 guard function with the two identity columns added to its immutable list. Everything else is 090's
// body, byte for byte (transitions, claim rules, updated_at).
const LEDGER_GUARD_WITH_BINDING = `
CREATE OR REPLACE FUNCTION integration_yida_delivery_ledger_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'YIDA_DELIVERY_IMMUTABLE'; END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
    OR OLD.row_key IS DISTINCT FROM NEW.row_key
    OR OLD.owner_id IS DISTINCT FROM NEW.owner_id
    OR OLD.target_ref IS DISTINCT FROM NEW.target_ref
    OR OLD.target_revision IS DISTINCT FROM NEW.target_revision
    OR OLD.plan_revision IS DISTINCT FROM NEW.plan_revision
    OR OLD.payload_digest IS DISTINCT FROM NEW.payload_digest
    OR OLD.business_key_digest IS DISTINCT FROM NEW.business_key_digest
    OR OLD.credential_ref IS DISTINCT FROM NEW.credential_ref
    OR OLD.credential_generation IS DISTINCT FROM NEW.credential_generation
    OR OLD.intent IS DISTINCT FROM NEW.intent
    OR OLD.instance_id IS DISTINCT FROM NEW.instance_id
    OR OLD.source_record_digest IS DISTINCT FROM NEW.source_record_digest
    OR OLD.creation_identity_digest IS DISTINCT FROM NEW.creation_identity_digest
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_IMMUTABLE';
  END IF;
  IF NOT ((OLD.status = 'prepared' AND NEW.status IN ('dispatching', 'not_sent'))
    OR (OLD.status = 'dispatching' AND NEW.status IN ('acknowledged', 'outcome_unknown'))) THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_TRANSITION';
  END IF;
  IF OLD.status = 'prepared' AND NEW.status = 'dispatching'
    AND (NEW.claim_token IS NULL OR NEW.claim_actor_id IS NULL) THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_CLAIM';
  END IF;
  IF OLD.status = 'dispatching'
    AND (NEW.claim_token IS DISTINCT FROM OLD.claim_token
      OR NEW.claim_actor_id IS DISTINCT FROM OLD.claim_actor_id) THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_CLAIM';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
`

// The 090 guard function exactly as 090 created it (restored by down()).
const LEDGER_GUARD_090 = `
CREATE OR REPLACE FUNCTION integration_yida_delivery_ledger_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'YIDA_DELIVERY_IMMUTABLE'; END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
    OR OLD.row_key IS DISTINCT FROM NEW.row_key
    OR OLD.owner_id IS DISTINCT FROM NEW.owner_id
    OR OLD.target_ref IS DISTINCT FROM NEW.target_ref
    OR OLD.target_revision IS DISTINCT FROM NEW.target_revision
    OR OLD.plan_revision IS DISTINCT FROM NEW.plan_revision
    OR OLD.payload_digest IS DISTINCT FROM NEW.payload_digest
    OR OLD.business_key_digest IS DISTINCT FROM NEW.business_key_digest
    OR OLD.credential_ref IS DISTINCT FROM NEW.credential_ref
    OR OLD.credential_generation IS DISTINCT FROM NEW.credential_generation
    OR OLD.intent IS DISTINCT FROM NEW.intent
    OR OLD.instance_id IS DISTINCT FROM NEW.instance_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_IMMUTABLE';
  END IF;
  IF NOT ((OLD.status = 'prepared' AND NEW.status IN ('dispatching', 'not_sent'))
    OR (OLD.status = 'dispatching' AND NEW.status IN ('acknowledged', 'outcome_unknown'))) THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_TRANSITION';
  END IF;
  IF OLD.status = 'prepared' AND NEW.status = 'dispatching'
    AND (NEW.claim_token IS NULL OR NEW.claim_actor_id IS NULL) THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_CLAIM';
  END IF;
  IF OLD.status = 'dispatching'
    AND (NEW.claim_token IS DISTINCT FROM OLD.claim_token
      OR NEW.claim_actor_id IS DISTINCT FROM OLD.claim_actor_id) THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_CLAIM';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
`

/** 093 draft rows: the two digest columns. */
export const YIDA_SOURCE_BINDING_DRAFT_ROWS_UP_SQL = `
${digestColumns('integration_yida_draft_rows')}
`

/** 095 send approvals: the two digest columns (the approvals table is append-only; DDL is not a row write). */
export const YIDA_SOURCE_BINDING_APPROVALS_UP_SQL = `
${digestColumns('integration_yida_send_approvals')}
`

/** 090 ledger: the two digest columns, the identity fence and the widened immutable guard. */
export const YIDA_SOURCE_BINDING_LEDGER_UP_SQL = `
${digestColumns('integration_yida_delivery_ledger')}
DO $yida_identity_fence$
DECLARE
  has_duplicates boolean;
BEGIN
  -- Same lock mode as CREATE INDEX: nothing slips between the preflight and the index.
  LOCK TABLE integration_yida_delivery_ledger IN SHARE MODE;
  IF to_regclass('${YIDA_CREATION_IDENTITY_FENCE}') IS NULL THEN
    -- Never discard or choose among historical evidence; the fixed error carries no row material.
    SELECT EXISTS (SELECT 1 FROM integration_yida_delivery_ledger
      WHERE intent = 'create' AND creation_identity_digest IS NOT NULL
      GROUP BY tenant_id, COALESCE(workspace_id, ''), target_ref, creation_identity_digest HAVING count(*) > 1)
      INTO has_duplicates;
    IF has_duplicates THEN
      RAISE EXCEPTION 'YIDA_DELIVERY_IDENTITY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    CREATE UNIQUE INDEX ${YIDA_CREATION_IDENTITY_FENCE} ON integration_yida_delivery_ledger
      (tenant_id, COALESCE(workspace_id, ''), target_ref, creation_identity_digest)
      WHERE intent = 'create' AND creation_identity_digest IS NOT NULL;
  END IF;
END;
$yida_identity_fence$;
${LEDGER_GUARD_WITH_BINDING}
`

export const YIDA_SOURCE_BINDING_UP_SQL = `
${YIDA_SOURCE_BINDING_DRAFT_ROWS_UP_SQL}
${YIDA_SOURCE_BINDING_APPROVALS_UP_SQL}
${YIDA_SOURCE_BINDING_LEDGER_UP_SQL}
`

export const YIDA_SOURCE_BINDING_DOWN_SQL = `
DO $yida_source_binding_down$
DECLARE
  bound_rows boolean := false;
  present boolean;
BEGIN
  ${YIDA_SOURCE_BINDING_TABLES.map(table => `
  IF to_regclass('${table}') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = to_regclass('${table}') AND attname = 'creation_identity_digest' AND NOT attisdropped) THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM ${table} WHERE source_record_digest IS NOT NULL OR creation_identity_digest IS NOT NULL)' INTO present;
    bound_rows := bound_rows OR present;
  END IF;`).join('\n')}
  IF bound_rows THEN
    RAISE EXCEPTION '${YIDA_SOURCE_BINDING_DOWN_REFUSED_CODE}' USING ERRCODE = '55000';
  END IF;
END;
$yida_source_binding_down$;
${LEDGER_GUARD_090}
DROP INDEX IF EXISTS ${YIDA_CREATION_IDENTITY_FENCE};
${YIDA_SOURCE_BINDING_TABLES.map(table => YIDA_SOURCE_BINDING_DIGEST_COLUMNS.map(column =>
    `ALTER TABLE IF EXISTS ${table} DROP COLUMN IF EXISTS ${column};`).join('\n')).join('\n')}
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_SOURCE_BINDING_UP_SQL).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_SOURCE_BINDING_DOWN_SQL).execute(db)
}
