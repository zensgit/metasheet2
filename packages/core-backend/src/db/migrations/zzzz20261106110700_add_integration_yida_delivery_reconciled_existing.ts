import { sql, type Kysely } from 'kysely'

/**
 * YiDa ⑦.5 cut-over reconciliation (R-71 ⑤; design baseline v2.3 §8). Evidence that a legacy record ALREADY
 * EXISTS in the customer's YiDa form, kept apart from send evidence.
 *
 * WHAT IT ADDS
 *   - Ledger (090): a sixth status `reconciled_existing` and a new column `observed_instance_id` (never
 *     `ack_instance_id`). Such a row is only ever INSERTed (intent 'create', instance_id NULL, no claim, no ack,
 *     observed_instance_id NOT NULL), so it occupies the 091 create fence (tenant, workspace, target_ref,
 *     business_key_digest) WHERE intent = 'create' and the send path can no longer create the same seven keys.
 *     A partial unique index keeps one reconciled row per (tenant, workspace, target_ref, observed instance).
 *   - Audit (090 + zzzz20261105033000): event `reconcile`, status `reconciled_existing`, reason `legacy_readback`,
 *     only in that exact combination.
 *   - The ledger guard (090, widened by zzzz20261106110300 with the two binding columns) is redefined from THAT
 *     binding body with one more immutable column, observed_instance_id. Every binding clause is kept; up()
 *     refuses (fail closed) when the binding columns are absent, so this migration always runs after 110300.
 *     A `reconciled_existing` row cannot be updated at all (the transition whitelist starts only from prepared
 *     or dispatching) and cannot be deleted.
 *   - Three append-only evidence tables: runs (one per tenant/target/commandId), pages (one per read page, with
 *     the sha256 of the raw response bytes) and observations (records a person must look at in YiDa).
 *
 * Reconciled rows carry NULL source_record_digest / creation_identity_digest: no source binding, so the
 * identity fence (110300) does not cover them and no write-back selector (status 'acknowledged' + a non-NULL
 * source_record_digest) can ever choose them. No switch here; values-free fixed codes only.
 *
 * down() REFUSES while any reconciled ledger row, reconcile audit row or reconciliation run exists (append-only
 * evidence). With none it restores the exact previous state: the 110300 guard body, the 090 shape CHECKs, the
 * five-value status/event CHECKs and the five-value reason CHECK left by zzzz20261105033000.
 */

export const YIDA_RECONCILED_EXISTING_STATUS = 'reconciled_existing'
export const YIDA_RECONCILE_AUDIT_EVENT = 'reconcile'
export const YIDA_RECONCILE_AUDIT_REASON = 'legacy_readback'
export const YIDA_RECONCILED_OBSERVED_INDEX = 'uniq_integration_yida_delivery_reconciled_observed'
export const YIDA_RECONCILIATION_RUNNING_INDEX = 'uniq_integration_yida_reconciliation_running'
export const YIDA_RECONCILED_EXISTING_DOWN_REFUSED_CODE = 'YIDA_DELIVERY_RECONCILED_EXISTING_PRESENT'
export const YIDA_RECONCILIATION_TABLES = Object.freeze(['integration_yida_reconciliation_runs',
  'integration_yida_reconciliation_pages', 'integration_yida_reconciliation_observations'] as const)
export const YIDA_RECONCILIATION_COUNT_COLUMNS = Object.freeze(['count_scanned', 'count_registered', 'count_would_register',
  'count_already_reconciled', 'count_duplicate_remote', 'count_own_acknowledged', 'count_duplicate_with_own',
  'count_own_in_flight', 'count_observed_for_unknown', 'count_own_not_sent', 'count_project_mismatch',
  'count_key_unmatchable'] as const)
export const YIDA_RECONCILIATION_OBSERVED_OUTCOMES = Object.freeze(['duplicate_remote', 'duplicate_with_own',
  'own_in_flight', 'observed_for_unknown', 'own_not_sent', 'key_unmatchable'] as const)
export const YIDA_RECONCILIATION_ERROR_CODES = Object.freeze(['RETRY', 'THROTTLED', 'RESPONSE', 'TOO_LARGE',
  'UNAVAILABLE', 'ABORTED', 'BUDGET', 'TOTAL_CHANGED'] as const)

const quoted = (values: readonly string[]) => values.map(value => `'${value}'`).join(', ')
const LEDGER_STATUSES_090 = ['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent'] as const
const AUDIT_EVENTS_090 = ['prepare', 'claim', 'acknowledgement', 'unknown', 'cancel'] as const
// The reason CHECK as zzzz20261105033000 leaves it (five values); down() restores exactly this one.
const AUDIT_REASONS_033000 = ['transport_unknown', 'commit_unknown', 'receipt_invalid', 'manual_recovery', 'receipt_unparsed'] as const
const UUID = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`
const INSTANCE_ID = `'^[A-Za-z0-9_-]{1,128}$'`
const HEX64 = `'^[0-9a-f]{64}$'`

// One single-column CHECK, located through pg_constraint by its conkey (090 lets PostgreSQL name these; the
// name is read, never assumed). Zero or several matches fail closed. When the located CHECK already contains
// `marker` (up) / no longer contains it (down) nothing changes, so both directions replay.
function replaceColumnCheck(table: string, column: string, canonical: string, body: string, marker: string, direction: 'up' | 'down') {
  return `
  SELECT a.attnum INTO column_attnum FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = to_regclass('${table}') AND a.attname = '${column}' AND NOT a.attisdropped;
  IF column_attnum IS NULL THEN RAISE EXCEPTION 'YIDA_DELIVERY_RECONCILE_COLUMN_MISSING' USING ERRCODE = '42703'; END IF;
  SELECT count(*), min(c.conname), min(pg_catalog.pg_get_constraintdef(c.oid, true)) INTO check_count, check_name, check_definition
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = to_regclass('${table}') AND c.contype = 'c' AND c.conkey = ARRAY[column_attnum]::smallint[];
  IF check_count <> 1 THEN RAISE EXCEPTION 'YIDA_DELIVERY_RECONCILE_CHECK_AMBIGUOUS' USING ERRCODE = '55000'; END IF;
  IF position('''${marker}''' IN check_definition) ${direction === 'up' ? '=' : '>'} 0 THEN
    EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I', check_name);
    ALTER TABLE ${table} ADD CONSTRAINT ${canonical} CHECK (${body});
  END IF;`
}

// The guard as zzzz20261106110300 defines it (LEDGER_GUARD_WITH_BINDING), byte for byte. down() restores it.
export const LEDGER_GUARD_WITH_BINDING_110300 = `
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

// The same body with observed_instance_id added to the immutable list (one clause; everything else equal).
export const LEDGER_GUARD_WITH_RECONCILE = LEDGER_GUARD_WITH_BINDING_110300.replace(
  '    OR OLD.creation_identity_digest IS DISTINCT FROM NEW.creation_identity_digest\n',
  '    OR OLD.creation_identity_digest IS DISTINCT FROM NEW.creation_identity_digest\n'
  + '    OR OLD.observed_instance_id IS DISTINCT FROM NEW.observed_instance_id\n')
if (LEDGER_GUARD_WITH_RECONCILE === LEDGER_GUARD_WITH_BINDING_110300) throw new Error('YIDA_DELIVERY_RECONCILE_GUARD_TEMPLATE')

const STATUS_SHAPE_090 = `
    (status IN ('prepared', 'not_sent') AND claim_token IS NULL AND claim_actor_id IS NULL
      AND ack_status_code IS NULL AND ack_instance_id IS NULL)
    OR (status IN ('dispatching', 'outcome_unknown') AND claim_token IS NOT NULL
      AND claim_actor_id IS NOT NULL AND ack_status_code IS NULL AND ack_instance_id IS NULL)
    OR (status = 'acknowledged' AND claim_token IS NOT NULL AND claim_actor_id IS NOT NULL
      AND ack_status_code IS NOT NULL AND ack_instance_id IS NOT NULL)
  `
const STATUS_SHAPE_RECONCILE = `
    (status IN ('prepared', 'not_sent') AND claim_token IS NULL AND claim_actor_id IS NULL
      AND ack_status_code IS NULL AND ack_instance_id IS NULL AND observed_instance_id IS NULL)
    OR (status IN ('dispatching', 'outcome_unknown') AND claim_token IS NOT NULL
      AND claim_actor_id IS NOT NULL AND ack_status_code IS NULL AND ack_instance_id IS NULL
      AND observed_instance_id IS NULL)
    OR (status = 'acknowledged' AND claim_token IS NOT NULL AND claim_actor_id IS NOT NULL
      AND ack_status_code IS NOT NULL AND ack_instance_id IS NOT NULL AND observed_instance_id IS NULL)
    OR (status = 'reconciled_existing' AND intent = 'create' AND instance_id IS NULL AND claim_token IS NULL
      AND claim_actor_id IS NULL AND ack_status_code IS NULL AND ack_instance_id IS NULL
      AND observed_instance_id IS NOT NULL AND source_record_digest IS NULL AND creation_identity_digest IS NULL)
  `
const AUDIT_SHAPE_090 = `
    (event = 'prepare' AND status = 'prepared' AND reason IS NULL)
    OR (event = 'claim' AND status = 'dispatching' AND reason IS NULL)
    OR (event = 'acknowledgement' AND status = 'acknowledged' AND reason IS NULL)
    OR (event = 'unknown' AND status = 'outcome_unknown' AND reason IS NOT NULL)
    OR (event = 'cancel' AND status = 'not_sent' AND reason IS NULL)
  `
// The 090 branches, except that `legacy_readback` is reconcile-only (an 'unknown' event may never carry it), plus
// the reconcile branch. Every branch is NULL-safe (IS [NOT] NULL first): a CHECK that evaluates to NULL passes.
const AUDIT_SHAPE_RECONCILE = `
    (event = 'prepare' AND status = 'prepared' AND reason IS NULL)
    OR (event = 'claim' AND status = 'dispatching' AND reason IS NULL)
    OR (event = 'acknowledgement' AND status = 'acknowledged' AND reason IS NULL)
    OR (event = 'unknown' AND status = 'outcome_unknown' AND reason IS NOT NULL AND reason <> 'legacy_readback')
    OR (event = 'cancel' AND status = 'not_sent' AND reason IS NULL)
    OR (event = 'reconcile' AND status = 'reconciled_existing' AND reason IS NOT NULL AND reason = 'legacy_readback')
  `
const counts = YIDA_RECONCILIATION_COUNT_COLUMNS.map(column => `  ${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} BETWEEN 0 AND 60000),`).join('\n')
const appendOnly = (table: string, code: string) => `
CREATE OR REPLACE FUNCTION ${table}_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '${code}';
END;
$$;
DROP TRIGGER IF EXISTS trg_${table}_guard ON ${table};
CREATE TRIGGER trg_${table}_guard BEFORE UPDATE OR DELETE ON ${table}
  FOR EACH ROW EXECUTE FUNCTION ${table}_guard();
DROP TRIGGER IF EXISTS trg_${table}_truncate ON ${table};
CREATE TRIGGER trg_${table}_truncate BEFORE TRUNCATE ON ${table}
  FOR EACH STATEMENT EXECUTE FUNCTION ${table}_guard();
`
const RUN_IDENTITY = ['id', 'command_id', 'tenant_id', 'workspace_id', 'owner_id', 'target_ref', 'project_no',
  'project_key_target', 'key_definition_digest', 'mode', 'page_size', 'started_at']

const TABLES_UP_SQL = `
CREATE TABLE IF NOT EXISTS integration_yida_reconciliation_runs (
  id TEXT PRIMARY KEY CHECK (id ~ ${UUID}),
  command_id TEXT NOT NULL CHECK (command_id ~ ${UUID}),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  workspace_id TEXT CHECK (workspace_id IS NULL),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  target_ref TEXT NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 128),
  project_no TEXT NOT NULL CHECK (length(project_no) BETWEEN 1 AND 64),
  project_key_target TEXT NOT NULL CHECK (length(project_key_target) BETWEEN 1 AND 128),
  key_definition_digest TEXT NOT NULL CHECK (key_definition_digest ~ ${HEX64}),
  mode TEXT NOT NULL CHECK (mode IN ('count', 'register')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  page_size INTEGER NOT NULL CHECK (page_size BETWEEN 1 AND 100),
  next_page_number INTEGER NOT NULL DEFAULT 1 CHECK (next_page_number BETWEEN 1 AND 601),
  pages_done INTEGER NOT NULL DEFAULT 0 CHECK (pages_done BETWEEN 0 AND 600),
  total_count_first INTEGER CHECK (total_count_first IS NULL OR total_count_first BETWEEN 0 AND 60000),
  total_count_last INTEGER CHECK (total_count_last IS NULL OR total_count_last BETWEEN 0 AND 60000),
${counts}
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code IN (${quoted(YIDA_RECONCILIATION_ERROR_CODES)})),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT integration_yida_reconciliation_runs_command UNIQUE (tenant_id, target_ref, command_id),
  CONSTRAINT integration_yida_reconciliation_runs_finish CHECK ((status = 'completed') = (finished_at IS NOT NULL)),
  CONSTRAINT integration_yida_reconciliation_runs_error CHECK (status <> 'failed' OR last_error_code IS NOT NULL)
);
-- One reconciliation in flight per target.
CREATE UNIQUE INDEX IF NOT EXISTS ${YIDA_RECONCILIATION_RUNNING_INDEX}
  ON integration_yida_reconciliation_runs (tenant_id, target_ref) WHERE status = 'running';

-- Identity is fixed; completed is terminal; cursor and counts only move forward; never deleted.
CREATE OR REPLACE FUNCTION integration_yida_reconciliation_runs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'YIDA_RECONCILIATION_IMMUTABLE'; END IF;
  IF ${RUN_IDENTITY.map(column => `OLD.${column} IS DISTINCT FROM NEW.${column}`).join('\n    OR ')} THEN
    RAISE EXCEPTION 'YIDA_RECONCILIATION_IMMUTABLE';
  END IF;
  IF OLD.status = 'completed' THEN RAISE EXCEPTION 'YIDA_RECONCILIATION_TRANSITION'; END IF;
  IF NEW.next_page_number < OLD.next_page_number OR NEW.pages_done < OLD.pages_done
    OR (OLD.total_count_first IS NOT NULL AND NEW.total_count_first IS DISTINCT FROM OLD.total_count_first)
    OR ${YIDA_RECONCILIATION_COUNT_COLUMNS.map(column => `NEW.${column} < OLD.${column}`).join('\n    OR ')} THEN
    RAISE EXCEPTION 'YIDA_RECONCILIATION_TRANSITION';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_integration_yida_reconciliation_runs_guard ON integration_yida_reconciliation_runs;
CREATE TRIGGER trg_integration_yida_reconciliation_runs_guard BEFORE UPDATE OR DELETE ON integration_yida_reconciliation_runs
  FOR EACH ROW EXECUTE FUNCTION integration_yida_reconciliation_runs_guard();
CREATE OR REPLACE FUNCTION integration_yida_reconciliation_truncate_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'YIDA_RECONCILIATION_IMMUTABLE';
END;
$$;
DROP TRIGGER IF EXISTS trg_integration_yida_reconciliation_runs_truncate ON integration_yida_reconciliation_runs;
CREATE TRIGGER trg_integration_yida_reconciliation_runs_truncate BEFORE TRUNCATE ON integration_yida_reconciliation_runs
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_reconciliation_truncate_guard();

CREATE TABLE IF NOT EXISTS integration_yida_reconciliation_pages (
  id TEXT PRIMARY KEY CHECK (id ~ ${UUID}),
  run_id TEXT NOT NULL REFERENCES integration_yida_reconciliation_runs(id) ON DELETE RESTRICT,
  page_number INTEGER NOT NULL CHECK (page_number BETWEEN 1 AND 600),
  record_count INTEGER NOT NULL CHECK (record_count BETWEEN 0 AND 100),
  total_count INTEGER NOT NULL CHECK (total_count BETWEEN 0 AND 60000),
  response_digest TEXT NOT NULL CHECK (response_digest ~ ${HEX64}),
${counts}
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integration_yida_reconciliation_pages_number UNIQUE (run_id, page_number)
);
${appendOnly('integration_yida_reconciliation_pages', 'YIDA_RECONCILIATION_IMMUTABLE')}
CREATE TABLE IF NOT EXISTS integration_yida_reconciliation_observations (
  id TEXT PRIMARY KEY CHECK (id ~ ${UUID}),
  run_id TEXT NOT NULL REFERENCES integration_yida_reconciliation_runs(id) ON DELETE RESTRICT,
  page_number INTEGER NOT NULL CHECK (page_number BETWEEN 1 AND 600),
  target_ref TEXT NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 128),
  observed_instance_id TEXT NOT NULL CHECK (observed_instance_id ~ ${INSTANCE_ID}),
  business_key_digest TEXT CHECK (business_key_digest IS NULL OR business_key_digest ~ ${HEX64}),
  outcome TEXT NOT NULL CHECK (outcome IN (${quoted(YIDA_RECONCILIATION_OBSERVED_OUTCOMES)})),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integration_yida_reconciliation_observations_instance UNIQUE (run_id, observed_instance_id),
  CONSTRAINT integration_yida_reconciliation_observations_digest CHECK ((outcome = 'key_unmatchable') = (business_key_digest IS NULL))
);
${appendOnly('integration_yida_reconciliation_observations', 'YIDA_RECONCILIATION_IMMUTABLE')}
`

export const YIDA_RECONCILED_EXISTING_UP_SQL = `
DO $yida_reconciled_existing_up$
DECLARE
  column_attnum smallint;
  check_count integer;
  check_name text;
  check_definition text;
BEGIN
  IF to_regclass('integration_yida_delivery_ledger') IS NULL OR to_regclass('integration_yida_delivery_audit') IS NULL THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_RECONCILE_LEDGER_MISSING' USING ERRCODE = '42P01';
  END IF;
  -- The guard below references the 110300 binding columns: refuse instead of installing a broken guard.
  IF (SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('integration_yida_delivery_ledger')
      AND attname IN ('source_record_digest', 'creation_identity_digest') AND NOT attisdropped) <> 2 THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_RECONCILE_BINDING_MISSING' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE integration_yida_delivery_ledger IN SHARE ROW EXCLUSIVE MODE;
  ALTER TABLE integration_yida_delivery_ledger ADD COLUMN IF NOT EXISTS observed_instance_id TEXT;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = to_regclass('integration_yida_delivery_ledger')
      AND conname = 'integration_yida_delivery_observed_instance_id_check') THEN
    ALTER TABLE integration_yida_delivery_ledger ADD CONSTRAINT integration_yida_delivery_observed_instance_id_check
      CHECK (observed_instance_id IS NULL OR observed_instance_id ~ ${INSTANCE_ID});
  END IF;
  ${replaceColumnCheck('integration_yida_delivery_ledger', 'status', 'integration_yida_delivery_ledger_status_check',
    `status IN (${quoted([...LEDGER_STATUSES_090, YIDA_RECONCILED_EXISTING_STATUS])})`, YIDA_RECONCILED_EXISTING_STATUS, 'up')}
  ALTER TABLE integration_yida_delivery_ledger DROP CONSTRAINT IF EXISTS integration_yida_delivery_status_shape;
  ALTER TABLE integration_yida_delivery_ledger ADD CONSTRAINT integration_yida_delivery_status_shape CHECK (${STATUS_SHAPE_RECONCILE});
  ${replaceColumnCheck('integration_yida_delivery_audit', 'event', 'integration_yida_delivery_audit_event_check',
    `event IN (${quoted([...AUDIT_EVENTS_090, YIDA_RECONCILE_AUDIT_EVENT])})`, YIDA_RECONCILE_AUDIT_EVENT, 'up')}
  ${replaceColumnCheck('integration_yida_delivery_audit', 'status', 'integration_yida_delivery_audit_status_check',
    `status IN (${quoted([...LEDGER_STATUSES_090, YIDA_RECONCILED_EXISTING_STATUS])})`, YIDA_RECONCILED_EXISTING_STATUS, 'up')}
  ${replaceColumnCheck('integration_yida_delivery_audit', 'reason', 'integration_yida_delivery_audit_reason_check',
    `reason IS NULL OR reason IN (${quoted([...AUDIT_REASONS_033000, YIDA_RECONCILE_AUDIT_REASON])})`, YIDA_RECONCILE_AUDIT_REASON, 'up')}
  ALTER TABLE integration_yida_delivery_audit DROP CONSTRAINT IF EXISTS integration_yida_delivery_audit_shape;
  ALTER TABLE integration_yida_delivery_audit ADD CONSTRAINT integration_yida_delivery_audit_shape CHECK (${AUDIT_SHAPE_RECONCILE});
END;
$yida_reconciled_existing_up$;
CREATE UNIQUE INDEX IF NOT EXISTS ${YIDA_RECONCILED_OBSERVED_INDEX} ON integration_yida_delivery_ledger
  (tenant_id, COALESCE(workspace_id, ''), target_ref, observed_instance_id) WHERE status = '${YIDA_RECONCILED_EXISTING_STATUS}';
${LEDGER_GUARD_WITH_RECONCILE}
${TABLES_UP_SQL}
`

export const YIDA_RECONCILED_EXISTING_DOWN_SQL = `
DO $yida_reconciled_existing_down$
DECLARE
  column_attnum smallint;
  check_count integer;
  check_name text;
  check_definition text;
  present boolean := false;
BEGIN
  IF to_regclass('integration_yida_delivery_ledger') IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('integration_yida_delivery_ledger')
      AND attname = 'observed_instance_id' AND NOT attisdropped) THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM integration_yida_delivery_ledger WHERE status = ''${YIDA_RECONCILED_EXISTING_STATUS}'' OR observed_instance_id IS NOT NULL)' INTO present;
  END IF;
  IF NOT present AND to_regclass('integration_yida_delivery_audit') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM integration_yida_delivery_audit WHERE event = ''${YIDA_RECONCILE_AUDIT_EVENT}'' OR reason = ''${YIDA_RECONCILE_AUDIT_REASON}'' OR status = ''${YIDA_RECONCILED_EXISTING_STATUS}'')' INTO present;
  END IF;
  IF NOT present AND to_regclass('integration_yida_reconciliation_runs') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM integration_yida_reconciliation_runs)' INTO present;
  END IF;
  IF present THEN
    RAISE EXCEPTION '${YIDA_RECONCILED_EXISTING_DOWN_REFUSED_CODE}' USING ERRCODE = '55000';
  END IF;
  LOCK TABLE integration_yida_delivery_ledger IN SHARE ROW EXCLUSIVE MODE;
  ALTER TABLE integration_yida_delivery_audit DROP CONSTRAINT IF EXISTS integration_yida_delivery_audit_shape;
  ALTER TABLE integration_yida_delivery_audit ADD CONSTRAINT integration_yida_delivery_audit_shape CHECK (${AUDIT_SHAPE_090});
  ${replaceColumnCheck('integration_yida_delivery_audit', 'reason', 'integration_yida_delivery_audit_reason_check',
    `reason IS NULL OR reason IN (${quoted(AUDIT_REASONS_033000)})`, YIDA_RECONCILE_AUDIT_REASON, 'down')}
  ${replaceColumnCheck('integration_yida_delivery_audit', 'status', 'integration_yida_delivery_audit_status_check',
    `status IN (${quoted(LEDGER_STATUSES_090)})`, YIDA_RECONCILED_EXISTING_STATUS, 'down')}
  ${replaceColumnCheck('integration_yida_delivery_audit', 'event', 'integration_yida_delivery_audit_event_check',
    `event IN (${quoted(AUDIT_EVENTS_090)})`, YIDA_RECONCILE_AUDIT_EVENT, 'down')}
  ALTER TABLE integration_yida_delivery_ledger DROP CONSTRAINT IF EXISTS integration_yida_delivery_status_shape;
  ALTER TABLE integration_yida_delivery_ledger ADD CONSTRAINT integration_yida_delivery_status_shape CHECK (${STATUS_SHAPE_090});
  ${replaceColumnCheck('integration_yida_delivery_ledger', 'status', 'integration_yida_delivery_ledger_status_check',
    `status IN (${quoted(LEDGER_STATUSES_090)})`, YIDA_RECONCILED_EXISTING_STATUS, 'down')}
END;
$yida_reconciled_existing_down$;
DROP TABLE IF EXISTS integration_yida_reconciliation_observations;
DROP TABLE IF EXISTS integration_yida_reconciliation_pages;
DROP TABLE IF EXISTS integration_yida_reconciliation_runs;
DROP FUNCTION IF EXISTS integration_yida_reconciliation_observations_guard();
DROP FUNCTION IF EXISTS integration_yida_reconciliation_pages_guard();
DROP FUNCTION IF EXISTS integration_yida_reconciliation_runs_guard();
DROP FUNCTION IF EXISTS integration_yida_reconciliation_truncate_guard();
DROP INDEX IF EXISTS ${YIDA_RECONCILED_OBSERVED_INDEX};
${LEDGER_GUARD_WITH_BINDING_110300}
ALTER TABLE IF EXISTS integration_yida_delivery_ledger DROP CONSTRAINT IF EXISTS integration_yida_delivery_observed_instance_id_check;
ALTER TABLE IF EXISTS integration_yida_delivery_ledger DROP COLUMN IF EXISTS observed_instance_id;
`

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_RECONCILED_EXISTING_UP_SQL).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(YIDA_RECONCILED_EXISTING_DOWN_SQL).execute(db)
}
