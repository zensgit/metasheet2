import { sql, type Kysely } from 'kysely'
import { applyMigrationTimeouts, readMigrationTimeouts, restoreMigrationTimeouts } from '../migration-timeouts'

export const STRICT_LOGIN_GRANT_MIGRATION_NAME = 'zzzz20261118120000_strict_login_grant_scope'
export const STRICT_LOGIN_GRANT_DOWN_BLOCKED_CODE = 'STRICT_LOGIN_GRANT_DOWN_BLOCKED'
export const STRICT_LOGIN_GRANT_DOWN_REQUIRES_TRANSACTION_CODE = 'STRICT_LOGIN_GRANT_DOWN_REQUIRES_TRANSACTION'
export const STRICT_LOGIN_GRANT_DOWN_REQUIRES_READ_COMMITTED_CODE = 'STRICT_LOGIN_GRANT_DOWN_REQUIRES_READ_COMMITTED'
export const STRICT_LOGIN_GRANT_PREREQUISITE_CODE = 'STRICT_LOGIN_GRANT_PREREQUISITE_MISSING'

export const STRICT_LOGIN_GRANT_SCOPE_TABLE = 'directory_connection_login_scope'
export const STRICT_LOGIN_GRANT_RECEIPT_TABLE = 'admin_login_grant_command_receipts'
export const STRICT_LOGIN_GRANT_GRANT_TABLE = 'user_external_identity_login_grants'
export const STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN = 'external_auth_context'
export const STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX = 'user_external_identity_login_grants_live_slot_uq'
export const STRICT_LOGIN_GRANT_RECEIPT_PRIMARY_KEY = 'admin_login_grant_command_receipts_pkey'
export const STRICT_LOGIN_GRANT_RECEIPT_PROOF_UNIQUE = 'admin_login_grant_command_receipts_proof_uq'
export const STRICT_LOGIN_GRANT_GRANT_ORDINAL_UNIQUE = 'user_external_identity_login_grants_command_ordinal_uq'
export const STRICT_LOGIN_GRANT_GRANT_USER_UNIQUE = 'user_external_identity_login_grants_command_user_uq'

export const STRICT_LOGIN_GRANT_TABLES = [
  STRICT_LOGIN_GRANT_SCOPE_TABLE,
  STRICT_LOGIN_GRANT_RECEIPT_TABLE,
  STRICT_LOGIN_GRANT_GRANT_TABLE,
] as const

export const STRICT_LOGIN_GRANT_FUNCTIONS = [
  'strict_login_grant_truncate_guard',
  'strict_login_grant_scope_guard',
  'strict_login_grant_receipt_guard',
  'strict_login_grant_grant_guard',
  'strict_login_grant_context_guard',
  'strict_login_grant_assert_bundle',
  'strict_login_grant_bundle_commit',
] as const

export const STRICT_LOGIN_GRANT_TRIGGERS = [
  'strict_login_grant_scope_guard',
  'strict_login_grant_scope_truncate',
  'strict_login_grant_receipt_guard',
  'strict_login_grant_receipt_truncate',
  'strict_login_grant_receipt_commit',
  'strict_login_grant_grant_guard',
  'strict_login_grant_grant_truncate',
  'strict_login_grant_grant_commit',
  'strict_login_grant_context_guard',
  'strict_login_grant_challenge_commit',
] as const

export const STRICT_LOGIN_GRANT_SESSION_CHECKS = [
  'user_sessions_external_auth_context_presence_chk',
  'user_sessions_external_auth_context_shape_chk',
] as const

export const STRICT_LOGIN_GRANT_PREREQUISITES = [
  'directory_integrations',
  'user_external_identities',
  'user_external_identity_evidence',
  'security_action_challenges',
  'user_sessions',
  'user_session_revocations',
  'directory_deprovision_events',
  'directory_sync_runs',
] as const

const IDENT = /^[a-z_][a-z0-9_]*$/
export const STRICT_LOGIN_GRANT_CONTEXT_KEYS = [
  'accessGeneration',
  'applicationRevision',
  'assurance',
  'bindingRevision',
  'capRev',
  'connectionId',
  'evidenceId',
  'grantId',
  'identityId',
  'orgId',
  'policyRevision',
  'provider',
  'scopeAsserted',
  'subjectAppScope',
  'subjectKey',
  'v',
] as const

const LOCK_ORDER = [
  'directory_integrations',
  'user_external_identities',
  'user_external_identity_evidence',
  STRICT_LOGIN_GRANT_GRANT_TABLE,
  STRICT_LOGIN_GRANT_RECEIPT_TABLE,
  'user_sessions',
  STRICT_LOGIN_GRANT_SCOPE_TABLE,
] as const

function fail(code: string, message: string): never {
  const error = new Error(`${code}: ${message}`)
  ;(error as Error & { code?: string }).code = code
  throw error
}

function isDownRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === STRICT_LOGIN_GRANT_DOWN_BLOCKED_CODE
    || code === STRICT_LOGIN_GRANT_DOWN_REQUIRES_TRANSACTION_CODE
    || code === STRICT_LOGIN_GRANT_DOWN_REQUIRES_READ_COMMITTED_CODE
}

function quoteIdent(identifier: string): string {
  if (!IDENT.test(identifier)) {
    fail(STRICT_LOGIN_GRANT_PREREQUISITE_CODE, 'strict login grant schema name refused. Nothing was changed.')
  }
  return `"${identifier}"`
}

function qualified(schemaName: string, identifier: string): string {
  return `${quoteIdent(schemaName)}.${quoteIdent(identifier)}`
}

async function currentSchema(db: Kysely<unknown>): Promise<string> {
  const found = await sql<{ schema_name: string | null }>`
    SELECT candidate.nspname AS schema_name
      FROM pg_catalog.unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS candidate(nspname, ord)
     ORDER BY candidate.ord
  `.execute(db)
  for (const row of found.rows) {
    const name = row?.schema_name
    if (typeof name !== 'string' || name.length === 0 || name.startsWith('pg_') || name === 'information_schema') continue
    if (!IDENT.test(name)) break
    return name
  }
  fail(STRICT_LOGIN_GRANT_PREREQUISITE_CODE, 'strict login grant schema name refused. Nothing was changed.')
}

async function requireCallerTransaction(db: Kysely<unknown>): Promise<void> {
  const first = await sql<{ xid: string }>`SELECT pg_catalog.pg_current_xact_id()::text AS xid`.execute(db)
  const second = await sql<{ xid: string }>`SELECT pg_catalog.pg_current_xact_id()::text AS xid`.execute(db)
  const firstXid = first.rows[0]?.xid
  const secondXid = second.rows[0]?.xid
  if (typeof firstXid !== 'string' || firstXid.length === 0 || firstXid !== secondXid) {
    fail(
      STRICT_LOGIN_GRANT_DOWN_REQUIRES_TRANSACTION_CODE,
      'down() requires an open caller transaction so its ACCESS EXCLUSIVE locks stay held through the empty check and drop. A plain autocommit invocation changes nothing.',
    )
  }
  const isolation = await sql<{ isolation: string }>`
    SELECT pg_catalog.current_setting('transaction_isolation') AS isolation
  `.execute(db)
  if (isolation.rows[0]?.isolation !== 'read committed') {
    fail(
      STRICT_LOGIN_GRANT_DOWN_REQUIRES_READ_COMMITTED_CODE,
      'down() requires read committed before it locks, checks, or drops. Repeatable read, serializable, and every other isolation are refused and change nothing.',
    )
  }
}

async function relationExists(db: Kysely<unknown>, schemaName: string, name: string): Promise<boolean> {
  const found = await sql<{ reg: string | null }>`
    SELECT pg_catalog.to_regclass(${qualified(schemaName, name)})::text AS reg
  `.execute(db)
  return typeof found.rows[0]?.reg === 'string' && found.rows[0].reg.length > 0
}

async function assertPrerequisites(db: Kysely<unknown>, schemaName: string): Promise<void> {
  for (const name of STRICT_LOGIN_GRANT_PREREQUISITES) {
    if (!(await relationExists(db, schemaName, name))) {
      fail(STRICT_LOGIN_GRANT_PREREQUISITE_CODE, 'strict login grant prerequisites refused. Nothing was changed.')
    }
  }
}

async function namedOwnedTables(db: Kysely<unknown>, schemaName: string): Promise<number> {
  const found = await sql<{ relname: string }>`
    SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schemaName}
       AND c.relname IN (
         ${STRICT_LOGIN_GRANT_TABLES[0]},
         ${STRICT_LOGIN_GRANT_TABLES[1]},
         ${STRICT_LOGIN_GRANT_TABLES[2]}
       )
  `.execute(db)
  return new Set(found.rows.map((row) => row.relname)).size
}

async function census(db: Kysely<unknown>, schemaName: string): Promise<'absent' | 'installed' | 'partial'> {
  const tables = await sql<{ relname: string }>`
    SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schemaName}
       AND c.relkind = 'r'
       AND c.relpersistence = 'p'
       AND c.relname IN (
         ${STRICT_LOGIN_GRANT_TABLES[0]},
         ${STRICT_LOGIN_GRANT_TABLES[1]},
         ${STRICT_LOGIN_GRANT_TABLES[2]}
       )
  `.execute(db)
  const functions = await sql<{ proname: string }>`
    SELECT p.proname
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ${schemaName}
       AND p.proname IN (
         ${STRICT_LOGIN_GRANT_FUNCTIONS[0]},
         ${STRICT_LOGIN_GRANT_FUNCTIONS[1]},
         ${STRICT_LOGIN_GRANT_FUNCTIONS[2]},
         ${STRICT_LOGIN_GRANT_FUNCTIONS[3]},
         ${STRICT_LOGIN_GRANT_FUNCTIONS[4]},
         ${STRICT_LOGIN_GRANT_FUNCTIONS[5]},
         ${STRICT_LOGIN_GRANT_FUNCTIONS[6]}
       )
  `.execute(db)
  const triggers = await sql<{ tgname: string }>`
    SELECT t.tgname
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schemaName}
       AND NOT t.tgisinternal
       AND t.tgname IN (
         ${STRICT_LOGIN_GRANT_TRIGGERS[0]},
         ${STRICT_LOGIN_GRANT_TRIGGERS[1]},
         ${STRICT_LOGIN_GRANT_TRIGGERS[2]},
         ${STRICT_LOGIN_GRANT_TRIGGERS[3]},
         ${STRICT_LOGIN_GRANT_TRIGGERS[4]},
         ${STRICT_LOGIN_GRANT_TRIGGERS[5]},
         ${STRICT_LOGIN_GRANT_TRIGGERS[6]},
         ${STRICT_LOGIN_GRANT_TRIGGERS[7]},
         ${STRICT_LOGIN_GRANT_TRIGGERS[8]},
         ${STRICT_LOGIN_GRANT_TRIGGERS[9]}
       )
  `.execute(db)
  const checks = await sql<{ conname: string }>`
    SELECT con.conname
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schemaName}
       AND c.relname = 'user_sessions'
       AND con.contype = 'c'
       AND con.conname IN (
         ${STRICT_LOGIN_GRANT_SESSION_CHECKS[0]},
         ${STRICT_LOGIN_GRANT_SESSION_CHECKS[1]}
       )
  `.execute(db)
  const indexes = await sql<{ relname: string }>`
    SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schemaName}
       AND c.relkind = 'i'
       AND c.relname = ${STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX}
  `.execute(db)
  const column = await sql<{ attname: string }>`
    SELECT a.attname
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schemaName}
       AND c.relname = 'user_sessions'
       AND a.attname = ${STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN}
       AND a.attnum > 0
       AND NOT a.attisdropped
  `.execute(db)
  const present = new Set(tables.rows.map((row) => row.relname)).size
    + new Set(functions.rows.map((row) => row.proname)).size
    + new Set(triggers.rows.map((row) => row.tgname)).size
    + new Set(checks.rows.map((row) => row.conname)).size
    + new Set(indexes.rows.map((row) => row.relname)).size
    + new Set(column.rows.map((row) => row.attname)).size
  const expected = STRICT_LOGIN_GRANT_TABLES.length
    + STRICT_LOGIN_GRANT_FUNCTIONS.length
    + STRICT_LOGIN_GRANT_TRIGGERS.length
    + STRICT_LOGIN_GRANT_SESSION_CHECKS.length
    + 1
    + 1
  const named = await namedOwnedTables(db, schemaName)
  if (present === 0 && named === 0) return 'absent'
  if (present === expected && named === STRICT_LOGIN_GRANT_TABLES.length) return 'installed'
  return 'partial'
}

function contextShapeSql(): string {
  const keyList = STRICT_LOGIN_GRANT_CONTEXT_KEYS.map((key) => `'${key}'`).join(', ')
  const required = STRICT_LOGIN_GRANT_CONTEXT_KEYS.map((key) => `external_auth_context ? '${key}'`).join(' AND ')
  return `
    CASE
      WHEN external_auth_context IS NULL THEN TRUE
      WHEN pg_catalog.jsonb_typeof(external_auth_context) IS DISTINCT FROM 'object' THEN FALSE
      ELSE
        ${required}
        AND (external_auth_context - ARRAY[${keyList}]::text[]) = '{}'::jsonb
        AND external_auth_context -> 'v' = '1'::jsonb
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'provider') = 'string'
        AND external_auth_context ->> 'provider' = 'dingtalk'
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'assurance') = 'string'
        AND external_auth_context ->> 'assurance' = 'self_authenticated'
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'scopeAsserted') = 'boolean'
        AND external_auth_context -> 'scopeAsserted' = 'false'::jsonb
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'policyRevision') = 'number'
        AND (external_auth_context ->> 'policyRevision') ~ '^(0|[1-9][0-9]*)$'
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'connectionId') = 'string'
        AND (external_auth_context ->> 'connectionId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'identityId') = 'string'
        AND (external_auth_context ->> 'identityId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'grantId') = 'string'
        AND (external_auth_context ->> 'grantId') ~ '^slg\\.[0-9a-f]{64}$'
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'evidenceId') = 'string'
        AND pg_catalog.length(pg_catalog.btrim(external_auth_context ->> 'evidenceId')) > 0
        AND (external_auth_context ->> 'evidenceId') = pg_catalog.btrim(external_auth_context ->> 'evidenceId')
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'orgId') = 'string'
        AND pg_catalog.length(pg_catalog.btrim(external_auth_context ->> 'orgId')) > 0
        AND (external_auth_context ->> 'orgId') = pg_catalog.btrim(external_auth_context ->> 'orgId')
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'subjectAppScope') = 'string'
        AND pg_catalog.length(pg_catalog.btrim(external_auth_context ->> 'subjectAppScope')) > 0
        AND (external_auth_context ->> 'subjectAppScope') = pg_catalog.btrim(external_auth_context ->> 'subjectAppScope')
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'subjectKey') = 'string'
        AND pg_catalog.length(pg_catalog.btrim(external_auth_context ->> 'subjectKey')) > 0
        AND (external_auth_context ->> 'subjectKey') = pg_catalog.btrim(external_auth_context ->> 'subjectKey')
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'capRev') = 'string'
        AND pg_catalog.length(pg_catalog.btrim(external_auth_context ->> 'capRev')) > 0
        AND (external_auth_context ->> 'capRev') = pg_catalog.btrim(external_auth_context ->> 'capRev')
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'bindingRevision') = 'string'
        AND (external_auth_context ->> 'bindingRevision') ~ '^(0|[1-9][0-9]*)$'
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'applicationRevision') = 'string'
        AND (external_auth_context ->> 'applicationRevision') ~ '^(0|[1-9][0-9]*)$'
        AND pg_catalog.jsonb_typeof(external_auth_context -> 'accessGeneration') = 'string'
        AND (external_auth_context ->> 'accessGeneration') ~ '^(0|[1-9][0-9]*)$'
    END
  `
}

function truncateGuard(schema: string): string {
  return `
    CREATE FUNCTION ${schema}.strict_login_grant_truncate_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $fn$
    BEGIN
      RAISE EXCEPTION 'strict login grant truncate refused' USING ERRCODE = '55000';
    END;
    $fn$
  `
}

function scopeGuard(schema: string): string {
  return `
    CREATE FUNCTION ${schema}.strict_login_grant_scope_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'strict login grant scope is insert-only' USING ERRCODE = '55000';
      END IF;
      IF NEW.command_id IS NULL
         OR NEW.command_id <> pg_catalog.btrim(NEW.command_id)
         OR pg_catalog.length(NEW.command_id) = 0 THEN
        RAISE EXCEPTION 'strict login grant scope refused' USING ERRCODE = '55000';
      END IF;
      NEW.transitioned_at := pg_catalog.clock_timestamp();
      RETURN NEW;
    END;
    $fn$
  `
}

function receiptGuard(schema: string): string {
  return `
    CREATE FUNCTION ${schema}.strict_login_grant_receipt_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'strict login grant receipt is insert-only' USING ERRCODE = '55000';
      END IF;
      NEW.created_at := pg_catalog.clock_timestamp();
      RETURN NEW;
    END;
    $fn$
  `
}

function contextGuard(schema: string): string {
  return `
    CREATE FUNCTION ${schema}.strict_login_grant_context_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $fn$
    BEGIN
      RAISE EXCEPTION 'strict login grant session context is immutable' USING ERRCODE = '55000';
    END;
    $fn$
  `
}

function grantGuard(schema: string): string {
  const evidence = `${schema}.user_external_identity_evidence`
  return `
    CREATE FUNCTION ${schema}.strict_login_grant_grant_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $fn$
    DECLARE
      evidence_row ${evidence}%ROWTYPE;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'strict login grant delete refused' USING ERRCODE = '55000';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.enabled IS DISTINCT FROM TRUE
           OR NEW.disabled_at IS NOT NULL
           OR NEW.disabled_by IS NOT NULL
           OR NEW.revoked_at IS NOT NULL
           OR NEW.revoked_by IS NOT NULL
           OR NEW.revoked_reason IS NOT NULL
           OR NEW.revocation_generation IS DISTINCT FROM 0
           OR NEW.live_identity_id IS NULL
           OR NEW.live_identity_id::text IS DISTINCT FROM NEW.identity_id
           OR NEW.assurance IS DISTINCT FROM 'self_authenticated'
           OR NEW.grant_method IS DISTINCT FROM 'admin_explicit'
           OR NEW.revoked_event_id IS NOT NULL
           OR NEW.revoked_run_id IS NOT NULL
           OR NEW.revoked_account_id IS NOT NULL
           OR NEW.revoked_org_id IS NOT NULL THEN
          RAISE EXCEPTION 'strict login grant insert refused' USING ERRCODE = '55000';
        END IF;
        SELECT * INTO evidence_row FROM ${evidence} WHERE id = NEW.evidence_id;
        IF NOT FOUND
           OR evidence_row.revoked_at IS NOT NULL
           OR evidence_row.identity_id IS DISTINCT FROM NEW.identity_id
           OR evidence_row.binding_revision IS DISTINCT FROM NEW.binding_revision
           OR evidence_row.evidence_witness IS DISTINCT FROM NEW.evidence_witness
           OR evidence_row.connection_id IS DISTINCT FROM NEW.connection_id
           OR evidence_row.org_id IS DISTINCT FROM NEW.org_id
           OR evidence_row.application_revision IS DISTINCT FROM NEW.application_revision
           OR evidence_row.live_identity_id IS DISTINCT FROM NEW.live_identity_id THEN
          RAISE EXCEPTION 'strict login grant evidence pin refused' USING ERRCODE = '55000';
        END IF;
        IF (NEW.subject_key IS NOT NULL AND NEW.subject_key IS DISTINCT FROM evidence_row.subject_key)
           OR (NEW.app_scope IS NOT NULL AND NEW.app_scope IS DISTINCT FROM evidence_row.app_scope)
           OR (NEW.material_fingerprint IS NOT NULL AND NEW.material_fingerprint IS DISTINCT FROM evidence_row.material_fingerprint)
           OR (NEW.capability_revision_seen IS NOT NULL AND NEW.capability_revision_seen IS DISTINCT FROM evidence_row.capability_revision_seen::text) THEN
          RAISE EXCEPTION 'strict login grant evidence pin refused' USING ERRCODE = '55000';
        END IF;
        NEW.subject_key := evidence_row.subject_key;
        NEW.app_scope := evidence_row.app_scope;
        NEW.material_fingerprint := evidence_row.material_fingerprint;
        NEW.capability_revision_seen := evidence_row.capability_revision_seen::text;
        NEW.created_at := pg_catalog.clock_timestamp();
        RETURN NEW;
      END IF;
      IF OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'strict login grant revoked update refused' USING ERRCODE = '55000';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.command_key IS DISTINCT FROM OLD.command_key
         OR NEW.target_ordinal IS DISTINCT FROM OLD.target_ordinal
         OR NEW.command_id IS DISTINCT FROM OLD.command_id
         OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id
         OR NEW.evidence_witness IS DISTINCT FROM OLD.evidence_witness
         OR NEW.identity_id IS DISTINCT FROM OLD.identity_id
         OR NEW.local_user_id IS DISTINCT FROM OLD.local_user_id
         OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
         OR NEW.binding_revision IS DISTINCT FROM OLD.binding_revision
         OR NEW.binding_revision_text IS DISTINCT FROM OLD.binding_revision_text
         OR NEW.application_revision IS DISTINCT FROM OLD.application_revision
         OR NEW.access_generation_text IS DISTINCT FROM OLD.access_generation_text
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.subject_key IS DISTINCT FROM OLD.subject_key
         OR NEW.app_scope IS DISTINCT FROM OLD.app_scope
         OR NEW.material_fingerprint IS DISTINCT FROM OLD.material_fingerprint
         OR NEW.capability_revision_seen IS DISTINCT FROM OLD.capability_revision_seen
         OR NEW.privilege_witness IS DISTINCT FROM OLD.privilege_witness
         OR NEW.assurance IS DISTINCT FROM OLD.assurance
         OR NEW.grant_method IS DISTINCT FROM OLD.grant_method
         OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'strict login grant immutable column refused' USING ERRCODE = '55000';
      END IF;
      IF NEW.revoked_at IS NULL THEN
        IF OLD.enabled IS DISTINCT FROM TRUE
           OR NEW.enabled IS DISTINCT FROM FALSE
           OR OLD.disabled_at IS NOT NULL
           OR OLD.disabled_by IS NOT NULL
           OR NEW.disabled_by IS NULL
           OR NEW.live_identity_id IS DISTINCT FROM OLD.live_identity_id
           OR NEW.revocation_generation IS DISTINCT FROM OLD.revocation_generation
           OR NEW.revoked_by IS NOT NULL
           OR NEW.revoked_reason IS NOT NULL
           OR NEW.revoked_event_id IS NOT NULL
           OR NEW.revoked_run_id IS NOT NULL
           OR NEW.revoked_account_id IS NOT NULL
           OR NEW.revoked_org_id IS NOT NULL THEN
          RAISE EXCEPTION 'strict login grant disable refused' USING ERRCODE = '55000';
        END IF;
        NEW.disabled_at := pg_catalog.clock_timestamp();
        RETURN NEW;
      END IF;
      IF NEW.enabled IS DISTINCT FROM FALSE
         OR NEW.revocation_generation IS DISTINCT FROM OLD.revocation_generation + 1
         OR NEW.live_identity_id IS NOT NULL
         OR NEW.disabled_at IS DISTINCT FROM OLD.disabled_at
         OR NEW.disabled_by IS DISTINCT FROM OLD.disabled_by
         OR NEW.revoked_by IS NULL
         OR NEW.revoked_reason IS NULL
         OR NEW.revoked_reason NOT IN (
           'deprovision', 'admin_unbind', 'admin_disable', 'recycle_purge', 'privilege_elevation', 'binding_replaced'
         )
         OR (NEW.revoked_reason = 'deprovision' AND NEW.revoked_event_id IS NULL AND NEW.revoked_run_id IS NULL) THEN
        RAISE EXCEPTION 'strict login grant terminal revoke refused' USING ERRCODE = '55000';
      END IF;
      NEW.revoked_at := pg_catalog.clock_timestamp();
      RETURN NEW;
    END;
    $fn$
  `
}

function assertBundleFunction(schema: string): string {
  const receipts = `${schema}.${STRICT_LOGIN_GRANT_RECEIPT_TABLE}`
  const grants = `${schema}.${STRICT_LOGIN_GRANT_GRANT_TABLE}`
  const challenges = `${schema}.security_action_challenges`
  const seals = `${schema}.admin_grant_proof_seals`
  const targets = `${schema}.admin_grant_proof_targets`
  return `
    CREATE FUNCTION ${schema}.strict_login_grant_assert_bundle(p_command_key text)
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $fn$
    DECLARE
      receipt_row ${receipts}%ROWTYPE;
      seal_row record;
      challenge_row ${challenges}%ROWTYPE;
      grant_count bigint;
      target_count bigint;
      listed_count bigint;
    BEGIN
      SELECT * INTO receipt_row FROM ${receipts} WHERE command_key = p_command_key;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'strict login grant bundle refused' USING ERRCODE = '23514';
      END IF;
      SELECT * INTO challenge_row FROM ${challenges} WHERE id = receipt_row.proof_id;
      SELECT * INTO seal_row FROM ${seals} WHERE challenge_id = receipt_row.proof_id;
      IF NOT FOUND
         OR challenge_row.id IS NULL
         OR challenge_row.purpose IS DISTINCT FROM 'admin_login_grant_enable'
         OR challenge_row.status IS DISTINCT FROM 'consumed'
         OR challenge_row.consumed_action_ref IS DISTINCT FROM ('agc:' || receipt_row.command_key)
         OR pg_catalog.length(challenge_row.consumed_action_ref) IS DISTINCT FROM 68
         OR receipt_row.purpose IS DISTINCT FROM 'admin_login_grant_enable'
         OR receipt_row.outcome IS DISTINCT FROM 'enabled'
         OR receipt_row.actor_id IS DISTINCT FROM challenge_row.user_id
         OR receipt_row.org_id IS DISTINCT FROM challenge_row.org_id
         OR receipt_row.command_id IS DISTINCT FROM seal_row.command_id
         OR receipt_row.canonical_intent IS DISTINCT FROM seal_row.canonical_intent
         OR receipt_row.target_count IS DISTINCT FROM seal_row.target_count
         OR pg_catalog.encode(
              pg_catalog.sha256(
                pg_catalog.convert_to(
                  'metasheet:admin-login-grant-intent:v1|' || receipt_row.canonical_intent,
                  'UTF8'
                )
              ),
              'hex'
            ) IS DISTINCT FROM receipt_row.intent_digest THEN
        RAISE EXCEPTION 'strict login grant bundle refused' USING ERRCODE = '23514';
      END IF;
      SELECT count(*) INTO target_count FROM ${targets} WHERE challenge_id = receipt_row.proof_id;
      SELECT count(*) INTO grant_count FROM ${grants} WHERE command_key = receipt_row.command_key;
      IF target_count IS DISTINCT FROM receipt_row.target_count
         OR grant_count IS DISTINCT FROM receipt_row.target_count
         OR pg_catalog.jsonb_typeof(receipt_row.result) IS DISTINCT FROM 'object'
         OR (
           SELECT pg_catalog.array_agg(keys.key ORDER BY keys.key)
             FROM pg_catalog.jsonb_object_keys(receipt_row.result) AS keys(key)
         ) IS DISTINCT FROM ARRAY['grants']::text[]
         OR pg_catalog.jsonb_typeof(receipt_row.result -> 'grants') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'strict login grant bundle refused' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        SELECT 1
          FROM pg_catalog.jsonb_array_elements(receipt_row.result -> 'grants') AS elem(value)
         WHERE pg_catalog.jsonb_typeof(elem.value) IS DISTINCT FROM 'object'
            OR (
              SELECT pg_catalog.array_agg(keys.key ORDER BY keys.key)
                FROM pg_catalog.jsonb_object_keys(elem.value) AS keys(key)
            ) IS DISTINCT FROM ARRAY['grantId', 'ordinal', 'userId']::text[]
            OR pg_catalog.jsonb_typeof(elem.value -> 'grantId') IS DISTINCT FROM 'string'
            OR (elem.value ->> 'grantId') !~ '^slg\\.[0-9a-f]{64}$'
            OR pg_catalog.jsonb_typeof(elem.value -> 'ordinal') IS DISTINCT FROM 'number'
            OR (elem.value ->> 'ordinal') !~ '^[1-9][0-9]*$'
            OR pg_catalog.jsonb_typeof(elem.value -> 'userId') IS DISTINCT FROM 'string'
            OR pg_catalog.length(pg_catalog.btrim(elem.value ->> 'userId')) = 0
      ) THEN
        RAISE EXCEPTION 'strict login grant bundle refused' USING ERRCODE = '23514';
      END IF;
      SELECT count(*) INTO listed_count
        FROM pg_catalog.jsonb_array_elements(receipt_row.result -> 'grants') AS elem(value);
      IF listed_count IS DISTINCT FROM receipt_row.target_count THEN
        RAISE EXCEPTION 'strict login grant bundle refused' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (
        WITH proof_children AS (
          SELECT ordinal, user_id, identity_id, binding_revision, evidence_id, evidence_witness,
                 access_generation, privilege_witness
            FROM ${targets}
           WHERE challenge_id = receipt_row.proof_id
        ),
        stored AS (
          SELECT id, target_ordinal, local_user_id, identity_id, binding_revision, binding_revision_text,
                 evidence_id, evidence_witness, access_generation_text, privilege_witness, command_id,
                 application_revision, connection_id, org_id, assurance, grant_method, granted_by
            FROM ${grants}
           WHERE command_key = receipt_row.command_key
        ),
        listed AS (
          SELECT (elem.value ->> 'ordinal')::integer AS ordinal,
                 elem.value ->> 'userId' AS user_id,
                 elem.value ->> 'grantId' AS grant_id
            FROM pg_catalog.jsonb_array_elements(receipt_row.result -> 'grants') AS elem(value)
        )
        SELECT 1
          FROM proof_children AS child
          FULL JOIN stored AS grant_row ON grant_row.target_ordinal = child.ordinal
          FULL JOIN listed ON listed.ordinal = COALESCE(child.ordinal, grant_row.target_ordinal)
         WHERE child.ordinal IS NULL
            OR grant_row.target_ordinal IS NULL
            OR listed.ordinal IS NULL
            OR grant_row.local_user_id IS DISTINCT FROM child.user_id
            OR grant_row.identity_id IS DISTINCT FROM child.identity_id::text
            OR grant_row.binding_revision IS DISTINCT FROM child.binding_revision
            OR grant_row.binding_revision_text IS DISTINCT FROM child.binding_revision::text
            OR grant_row.evidence_id IS DISTINCT FROM child.evidence_id
            OR grant_row.evidence_witness IS DISTINCT FROM child.evidence_witness
            OR grant_row.access_generation_text IS DISTINCT FROM child.access_generation::text
            OR grant_row.privilege_witness IS DISTINCT FROM child.privilege_witness
            OR grant_row.command_id IS DISTINCT FROM seal_row.command_id
            OR grant_row.application_revision IS DISTINCT FROM seal_row.application_revision
            OR grant_row.connection_id IS DISTINCT FROM challenge_row.connection_id
            OR grant_row.org_id IS DISTINCT FROM receipt_row.org_id
            OR grant_row.assurance IS DISTINCT FROM 'self_authenticated'
            OR grant_row.grant_method IS DISTINCT FROM 'admin_explicit'
            OR grant_row.granted_by IS DISTINCT FROM receipt_row.actor_id
            OR listed.user_id IS DISTINCT FROM grant_row.local_user_id
            OR listed.grant_id IS DISTINCT FROM grant_row.id
      ) THEN
        RAISE EXCEPTION 'strict login grant bundle refused' USING ERRCODE = '23514';
      END IF;
      IF (
        SELECT count(DISTINCT (elem.value ->> 'ordinal'))
          FROM pg_catalog.jsonb_array_elements(receipt_row.result -> 'grants') AS elem(value)
      ) IS DISTINCT FROM receipt_row.target_count THEN
        RAISE EXCEPTION 'strict login grant bundle refused' USING ERRCODE = '23514';
      END IF;
    END;
    $fn$
  `
}

function bundleCommitFunction(schema: string): string {
  return `
    CREATE FUNCTION ${schema}.strict_login_grant_bundle_commit()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $fn$
    DECLARE
      command_key text;
    BEGIN
      IF TG_TABLE_NAME = 'security_action_challenges' THEN
        IF NEW.consumed_action_ref IS NULL
           OR pg_catalog.length(NEW.consumed_action_ref) <> 68
           OR pg_catalog.substr(NEW.consumed_action_ref, 1, 4) IS DISTINCT FROM 'agc:'
           OR pg_catalog.substr(NEW.consumed_action_ref, 5) !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION 'strict login grant bundle refused' USING ERRCODE = '23514';
        END IF;
        command_key := pg_catalog.substr(NEW.consumed_action_ref, 5);
      ELSE
        command_key := NEW.command_key;
      END IF;
      PERFORM ${schema}.strict_login_grant_assert_bundle(command_key);
      RETURN NULL;
    END;
    $fn$
  `
}

async function applyUp(db: Kysely<unknown>, schemaName: string): Promise<void> {
  const schema = quoteIdent(schemaName)
  const scope = qualified(schemaName, STRICT_LOGIN_GRANT_SCOPE_TABLE)
  const receipts = qualified(schemaName, STRICT_LOGIN_GRANT_RECEIPT_TABLE)
  const grants = qualified(schemaName, STRICT_LOGIN_GRANT_GRANT_TABLE)
  const sessions = qualified(schemaName, 'user_sessions')
  const challenges = qualified(schemaName, 'security_action_challenges')
  const integrations = qualified(schemaName, 'directory_integrations')
  const identities = qualified(schemaName, 'user_external_identities')
  const evidence = qualified(schemaName, 'user_external_identity_evidence')
  const events = qualified(schemaName, 'directory_deprovision_events')
  const runs = qualified(schemaName, 'directory_sync_runs')
  await sql.raw(`
    CREATE TABLE ${scope} (
      connection_id uuid NOT NULL,
      transitioned_at timestamptz NOT NULL,
      command_id text NOT NULL,
      CONSTRAINT directory_connection_login_scope_pkey PRIMARY KEY (connection_id),
      CONSTRAINT directory_connection_login_scope_command_id_uq UNIQUE (command_id),
      CONSTRAINT directory_connection_login_scope_connection_fk
        FOREIGN KEY (connection_id) REFERENCES ${integrations} (id) ON DELETE RESTRICT,
      CONSTRAINT directory_connection_login_scope_command_chk CHECK (
        command_id IS NOT NULL
        AND command_id = pg_catalog.btrim(command_id)
        AND pg_catalog.length(command_id) > 0
      )
    )
  `).execute(db)
  await sql.raw(`
    CREATE TABLE ${receipts} (
      command_key text NOT NULL,
      purpose text NOT NULL,
      actor_id text NOT NULL,
      org_id text NOT NULL,
      command_id text NOT NULL,
      intent_digest text NOT NULL,
      canonical_intent text NOT NULL,
      result jsonb NOT NULL,
      proof_id uuid NOT NULL,
      target_count integer NOT NULL,
      created_at timestamptz NOT NULL,
      outcome text NOT NULL,
      CONSTRAINT ${STRICT_LOGIN_GRANT_RECEIPT_PRIMARY_KEY} PRIMARY KEY (command_key),
      CONSTRAINT ${STRICT_LOGIN_GRANT_RECEIPT_PROOF_UNIQUE} UNIQUE (proof_id),
      CONSTRAINT admin_login_grant_command_receipts_proof_fk
        FOREIGN KEY (proof_id) REFERENCES ${challenges} (id) ON DELETE RESTRICT,
      CONSTRAINT admin_login_grant_command_receipts_key_chk CHECK (command_key ~ '^[0-9a-f]{64}$'),
      CONSTRAINT admin_login_grant_command_receipts_purpose_chk CHECK (purpose = 'admin_login_grant_enable'),
      CONSTRAINT admin_login_grant_command_receipts_outcome_chk CHECK (outcome = 'enabled'),
      CONSTRAINT admin_login_grant_command_receipts_digest_chk CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT admin_login_grant_command_receipts_count_chk CHECK (target_count >= 1),
      CONSTRAINT admin_login_grant_command_receipts_text_chk CHECK (
        actor_id = pg_catalog.btrim(actor_id) AND pg_catalog.length(actor_id) > 0
        AND org_id = pg_catalog.btrim(org_id) AND pg_catalog.length(org_id) > 0
        AND command_id = pg_catalog.btrim(command_id) AND pg_catalog.length(command_id) > 0
        AND pg_catalog.length(canonical_intent) > 0
      ),
      CONSTRAINT admin_login_grant_command_receipts_result_chk CHECK (
        pg_catalog.jsonb_typeof(result) = 'object'
      )
    )
  `).execute(db)
  await sql.raw(`
    CREATE TABLE ${grants} (
      id text NOT NULL,
      command_key text NOT NULL,
      target_ordinal integer NOT NULL,
      command_id text NOT NULL,
      evidence_id text NOT NULL,
      evidence_witness text NOT NULL,
      identity_id text NOT NULL,
      live_identity_id uuid,
      local_user_id text NOT NULL,
      connection_id uuid NOT NULL,
      binding_revision bigint NOT NULL,
      binding_revision_text text NOT NULL,
      application_revision text NOT NULL,
      access_generation_text text NOT NULL,
      org_id text NOT NULL,
      subject_key text NOT NULL,
      app_scope text NOT NULL,
      material_fingerprint text NOT NULL,
      capability_revision_seen text NOT NULL,
      privilege_witness text NOT NULL,
      assurance text NOT NULL,
      grant_method text NOT NULL,
      enabled boolean NOT NULL,
      granted_by text NOT NULL,
      disabled_at timestamptz,
      disabled_by text,
      revoked_at timestamptz,
      revoked_reason text,
      revoked_by text,
      revocation_generation bigint NOT NULL,
      revoked_event_id uuid,
      revoked_run_id uuid,
      revoked_account_id text,
      revoked_org_id text,
      created_at timestamptz NOT NULL,
      CONSTRAINT user_external_identity_login_grants_pkey PRIMARY KEY (id),
      CONSTRAINT ${STRICT_LOGIN_GRANT_GRANT_ORDINAL_UNIQUE} UNIQUE (command_key, target_ordinal),
      CONSTRAINT ${STRICT_LOGIN_GRANT_GRANT_USER_UNIQUE} UNIQUE (command_key, local_user_id),
      CONSTRAINT user_external_identity_login_grants_command_fk
        FOREIGN KEY (command_key) REFERENCES ${receipts} (command_key) ON DELETE RESTRICT,
      CONSTRAINT user_external_identity_login_grants_evidence_fk
        FOREIGN KEY (evidence_id) REFERENCES ${evidence} (id) ON DELETE RESTRICT,
      CONSTRAINT user_external_identity_login_grants_live_identity_fk
        FOREIGN KEY (live_identity_id) REFERENCES ${identities} (id) ON DELETE RESTRICT,
      CONSTRAINT user_external_identity_login_grants_connection_fk
        FOREIGN KEY (connection_id) REFERENCES ${integrations} (id) ON DELETE RESTRICT,
      CONSTRAINT user_external_identity_login_grants_event_fk
        FOREIGN KEY (revoked_event_id) REFERENCES ${events} (id) ON DELETE RESTRICT,
      CONSTRAINT user_external_identity_login_grants_run_fk
        FOREIGN KEY (revoked_run_id) REFERENCES ${runs} (id) ON DELETE RESTRICT,
      CONSTRAINT user_external_identity_login_grants_id_chk CHECK (id ~ '^slg\\.[0-9a-f]{64}$'),
      CONSTRAINT user_external_identity_login_grants_ordinal_chk CHECK (target_ordinal >= 1),
      CONSTRAINT user_external_identity_login_grants_binding_chk CHECK (
        binding_revision >= 0
        AND binding_revision_text ~ '^(0|[1-9][0-9]*)$'
        AND binding_revision_text = binding_revision::text
      ),
      CONSTRAINT user_external_identity_login_grants_revision_chk CHECK (
        application_revision ~ '^(0|[1-9][0-9]*)$'
        AND access_generation_text ~ '^(0|[1-9][0-9]*)$'
        AND capability_revision_seen ~ '^(0|[1-9][0-9]*)$'
      ),
      CONSTRAINT user_external_identity_login_grants_witness_chk CHECK (
        material_fingerprint ~ '^[0-9a-f]{64}$'
        AND privilege_witness ~ '^[0-9a-f]{64}$'
        AND evidence_witness = pg_catalog.btrim(evidence_witness)
        AND pg_catalog.length(evidence_witness) > 0
      ),
      CONSTRAINT user_external_identity_login_grants_method_chk CHECK (
        assurance = 'self_authenticated' AND grant_method = 'admin_explicit'
      ),
      CONSTRAINT user_external_identity_login_grants_text_chk CHECK (
        command_id = pg_catalog.btrim(command_id) AND pg_catalog.length(command_id) > 0
        AND identity_id = pg_catalog.btrim(identity_id) AND pg_catalog.length(identity_id) > 0
        AND local_user_id = pg_catalog.btrim(local_user_id) AND pg_catalog.length(local_user_id) > 0
        AND org_id = pg_catalog.btrim(org_id) AND pg_catalog.length(org_id) > 0
        AND subject_key = pg_catalog.btrim(subject_key) AND pg_catalog.length(subject_key) > 0
        AND app_scope = pg_catalog.btrim(app_scope) AND pg_catalog.length(app_scope) > 0
        AND granted_by = pg_catalog.btrim(granted_by) AND pg_catalog.length(granted_by) > 0
      ),
      CONSTRAINT user_external_identity_login_grants_live_text_chk CHECK (
        live_identity_id IS NULL OR live_identity_id::text = identity_id
      ),
      CONSTRAINT user_external_identity_login_grants_disable_pair_chk CHECK (
        (disabled_at IS NULL AND disabled_by IS NULL)
        OR (disabled_at IS NOT NULL AND disabled_by IS NOT NULL)
      ),
      CONSTRAINT user_external_identity_login_grants_enabled_chk CHECK (
        enabled = FALSE
        OR (disabled_at IS NULL AND disabled_by IS NULL AND revoked_at IS NULL)
      ),
      CONSTRAINT user_external_identity_login_grants_reason_chk CHECK (
        revoked_reason IS NULL
        OR revoked_reason IN (
          'deprovision', 'admin_unbind', 'admin_disable', 'recycle_purge', 'privilege_elevation', 'binding_replaced'
        )
      ),
      CONSTRAINT user_external_identity_login_grants_provenance_text_chk CHECK (
        (revoked_account_id IS NULL OR (
          revoked_account_id = pg_catalog.btrim(revoked_account_id) AND pg_catalog.length(revoked_account_id) > 0
        ))
        AND (revoked_org_id IS NULL OR (
          revoked_org_id = pg_catalog.btrim(revoked_org_id) AND pg_catalog.length(revoked_org_id) > 0
        ))
        AND (disabled_by IS NULL OR (
          disabled_by = pg_catalog.btrim(disabled_by) AND pg_catalog.length(disabled_by) > 0
        ))
        AND (revoked_by IS NULL OR (
          revoked_by = pg_catalog.btrim(revoked_by) AND pg_catalog.length(revoked_by) > 0
        ))
      ),
      CONSTRAINT user_external_identity_login_grants_lifecycle_chk CHECK (
        (
          revoked_at IS NULL
          AND revoked_by IS NULL
          AND revoked_reason IS NULL
          AND revocation_generation = 0
          AND live_identity_id IS NOT NULL
          AND revoked_event_id IS NULL
          AND revoked_run_id IS NULL
          AND revoked_account_id IS NULL
          AND revoked_org_id IS NULL
        )
        OR (
          revoked_at IS NOT NULL
          AND revoked_by IS NOT NULL
          AND revoked_reason IS NOT NULL
          AND revocation_generation >= 1
          AND live_identity_id IS NULL
          AND enabled = FALSE
          AND (
            revoked_reason <> 'deprovision'
            OR revoked_event_id IS NOT NULL
            OR revoked_run_id IS NOT NULL
          )
        )
      )
    )
  `).execute(db)
  await sql.raw(`
    CREATE UNIQUE INDEX ${STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX}
      ON ${grants} (live_identity_id, connection_id)
      WHERE revoked_at IS NULL
  `).execute(db)
  await sql.raw(truncateGuard(schema)).execute(db)
  await sql.raw(scopeGuard(schema)).execute(db)
  await sql.raw(receiptGuard(schema)).execute(db)
  await sql.raw(contextGuard(schema)).execute(db)
  await sql.raw(grantGuard(schema)).execute(db)
  await sql.raw(assertBundleFunction(schema)).execute(db)
  await sql.raw(bundleCommitFunction(schema)).execute(db)
  await sql.raw(`
    CREATE TRIGGER strict_login_grant_scope_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ${scope}
      FOR EACH ROW EXECUTE FUNCTION ${schema}.strict_login_grant_scope_guard()
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER strict_login_grant_scope_truncate
      BEFORE TRUNCATE ON ${scope}
      FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.strict_login_grant_truncate_guard()
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER strict_login_grant_receipt_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ${receipts}
      FOR EACH ROW EXECUTE FUNCTION ${schema}.strict_login_grant_receipt_guard()
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER strict_login_grant_receipt_truncate
      BEFORE TRUNCATE ON ${receipts}
      FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.strict_login_grant_truncate_guard()
  `).execute(db)
  await sql.raw(`
    CREATE CONSTRAINT TRIGGER strict_login_grant_receipt_commit
      AFTER INSERT ON ${receipts}
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ${schema}.strict_login_grant_bundle_commit()
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER strict_login_grant_grant_guard
      BEFORE INSERT OR UPDATE OR DELETE ON ${grants}
      FOR EACH ROW EXECUTE FUNCTION ${schema}.strict_login_grant_grant_guard()
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER strict_login_grant_grant_truncate
      BEFORE TRUNCATE ON ${grants}
      FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.strict_login_grant_truncate_guard()
  `).execute(db)
  await sql.raw(`
    CREATE CONSTRAINT TRIGGER strict_login_grant_grant_commit
      AFTER INSERT ON ${grants}
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ${schema}.strict_login_grant_bundle_commit()
  `).execute(db)
  await sql.raw(`
    ALTER TABLE ${sessions}
      ADD COLUMN ${STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN} jsonb
  `).execute(db)
  await sql.raw(`
    ALTER TABLE ${sessions}
      ADD CONSTRAINT ${STRICT_LOGIN_GRANT_SESSION_CHECKS[0]}
      CHECK ((id LIKE 'xs.%') = (${STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN} IS NOT NULL))
      NOT VALID
  `).execute(db)
  await sql.raw(`
    ALTER TABLE ${sessions}
      ADD CONSTRAINT ${STRICT_LOGIN_GRANT_SESSION_CHECKS[1]}
      CHECK (${contextShapeSql()})
      NOT VALID
  `).execute(db)
  await sql.raw(`
    CREATE TRIGGER strict_login_grant_context_guard
      BEFORE UPDATE OF ${STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN} ON ${sessions}
      FOR EACH ROW EXECUTE FUNCTION ${schema}.strict_login_grant_context_guard()
  `).execute(db)
  await sql.raw(`
    CREATE CONSTRAINT TRIGGER strict_login_grant_challenge_commit
      AFTER UPDATE OF status ON ${challenges}
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      WHEN (NEW.purpose = 'admin_login_grant_enable' AND NEW.status = 'consumed')
      EXECUTE FUNCTION ${schema}.strict_login_grant_bundle_commit()
  `).execute(db)
}

async function lockInstalled(db: Kysely<unknown>, schemaName: string): Promise<void> {
  for (const name of LOCK_ORDER) {
    await sql.raw(`LOCK TABLE ${qualified(schemaName, name)} IN ACCESS EXCLUSIVE MODE`).execute(db)
  }
}

async function holdsHistory(db: Kysely<unknown>, schemaName: string): Promise<boolean> {
  const scope = qualified(schemaName, STRICT_LOGIN_GRANT_SCOPE_TABLE)
  const receipts = qualified(schemaName, STRICT_LOGIN_GRANT_RECEIPT_TABLE)
  const grants = qualified(schemaName, STRICT_LOGIN_GRANT_GRANT_TABLE)
  const sessions = qualified(schemaName, 'user_sessions')
  const found = await sql<{ blocked: boolean }>`
    SELECT (
      EXISTS (SELECT 1 FROM ${sql.raw(scope)})
      OR EXISTS (SELECT 1 FROM ${sql.raw(receipts)})
      OR EXISTS (SELECT 1 FROM ${sql.raw(grants)})
      OR EXISTS (
        SELECT 1 FROM ${sql.raw(sessions)}
         WHERE ${sql.raw(STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN)} IS NOT NULL
      )
    ) AS blocked
  `.execute(db)
  return found.rows[0]?.blocked === true
}

async function dropInstalled(db: Kysely<unknown>, schemaName: string): Promise<void> {
  const schema = quoteIdent(schemaName)
  const scope = qualified(schemaName, STRICT_LOGIN_GRANT_SCOPE_TABLE)
  const receipts = qualified(schemaName, STRICT_LOGIN_GRANT_RECEIPT_TABLE)
  const grants = qualified(schemaName, STRICT_LOGIN_GRANT_GRANT_TABLE)
  const sessions = qualified(schemaName, 'user_sessions')
  const challenges = qualified(schemaName, 'security_action_challenges')
  await sql.raw(`LOCK TABLE ${challenges} IN ACCESS EXCLUSIVE MODE`).execute(db)
  await sql.raw(`DROP TRIGGER strict_login_grant_challenge_commit ON ${challenges}`).execute(db)
  await sql.raw(`DROP TRIGGER strict_login_grant_receipt_commit ON ${receipts}`).execute(db)
  await sql.raw(`DROP TRIGGER strict_login_grant_grant_commit ON ${grants}`).execute(db)
  await sql.raw(`DROP TRIGGER strict_login_grant_scope_truncate ON ${scope}`).execute(db)
  await sql.raw(`DROP TRIGGER strict_login_grant_scope_guard ON ${scope}`).execute(db)
  await sql.raw(`DROP TRIGGER strict_login_grant_receipt_truncate ON ${receipts}`).execute(db)
  await sql.raw(`DROP TRIGGER strict_login_grant_receipt_guard ON ${receipts}`).execute(db)
  await sql.raw(`DROP TRIGGER strict_login_grant_grant_truncate ON ${grants}`).execute(db)
  await sql.raw(`DROP TRIGGER strict_login_grant_grant_guard ON ${grants}`).execute(db)
  await sql.raw(`DROP TRIGGER strict_login_grant_context_guard ON ${sessions}`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.strict_login_grant_bundle_commit()`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.strict_login_grant_assert_bundle(text)`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.strict_login_grant_grant_guard()`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.strict_login_grant_receipt_guard()`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.strict_login_grant_scope_guard()`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.strict_login_grant_context_guard()`).execute(db)
  await sql.raw(`DROP FUNCTION ${schema}.strict_login_grant_truncate_guard()`).execute(db)
  await sql.raw(`DROP TABLE ${grants}`).execute(db)
  await sql.raw(`DROP TABLE ${receipts}`).execute(db)
  await sql.raw(`DROP TABLE ${scope}`).execute(db)
  await sql.raw(`ALTER TABLE ${sessions} DROP CONSTRAINT ${STRICT_LOGIN_GRANT_SESSION_CHECKS[0]}`).execute(db)
  await sql.raw(`ALTER TABLE ${sessions} DROP CONSTRAINT ${STRICT_LOGIN_GRANT_SESSION_CHECKS[1]}`).execute(db)
  await sql.raw(`ALTER TABLE ${sessions} DROP COLUMN ${STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN}`).execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  const schemaName = await currentSchema(db)
  await assertPrerequisites(db, schemaName)
  if ((await census(db, schemaName)) !== 'absent') {
    fail(STRICT_LOGIN_GRANT_PREREQUISITE_CODE, 'strict login grant objects already exist. Nothing was changed.')
  }
  await applyUp(db, schemaName)
  await restoreMigrationTimeouts(db, previous)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await requireCallerTransaction(db)
  const previous = await readMigrationTimeouts(db)
  try {
    await applyMigrationTimeouts(db)
    const schemaName = await currentSchema(db)
    const state = await census(db, schemaName)
    if (state === 'absent') {
      await restoreMigrationTimeouts(db, previous)
      return
    }
    if (state !== 'installed') {
      fail(STRICT_LOGIN_GRANT_DOWN_BLOCKED_CODE, 'down() refused because the strict login grant schema is partial. Nothing was changed.')
    }
    await lockInstalled(db, schemaName)
    if (await holdsHistory(db, schemaName)) {
      fail(STRICT_LOGIN_GRANT_DOWN_BLOCKED_CODE, 'down() refused while a strict login grant row or session context exists. Nothing was changed.')
    }
    await dropInstalled(db, schemaName)
    await restoreMigrationTimeouts(db, previous)
  } catch (error) {
    if (isDownRefusal(error)) await restoreMigrationTimeouts(db, previous)
    throw error
  }
}
