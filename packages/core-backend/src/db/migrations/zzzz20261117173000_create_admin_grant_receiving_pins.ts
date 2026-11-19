import { sql, type Kysely } from 'kysely'

const MIGRATION_LOCK_TIMEOUT = '5s'
const MIGRATION_STATEMENT_TIMEOUT = '5min'

export const ADMIN_GRANT_RECEIVING_DOWN_BLOCKED_CODE = 'ADMIN_GRANT_RECEIVING_DOWN_BLOCKED'
export const ADMIN_GRANT_RECEIVING_DOWN_REQUIRES_TRANSACTION_CODE = 'ADMIN_GRANT_RECEIVING_DOWN_REQUIRES_TRANSACTION'
export const ADMIN_GRANT_RECEIVING_DOWN_REQUIRES_READ_COMMITTED_CODE = 'ADMIN_GRANT_RECEIVING_DOWN_REQUIRES_READ_COMMITTED'
export const ADMIN_GRANT_RECEIVING_PREREQUISITE_CODE = 'ADMIN_GRANT_RECEIVING_PREREQUISITE_MISSING'

type MigrationTimeouts = { lock_timeout: string; statement_timeout: string }

function fail(code: string, message: string): never {
  const error = new Error(`${code}: ${message}`)
  ;(error as Error & { code?: string }).code = code
  throw error
}

async function readMigrationTimeouts(db: Kysely<unknown>): Promise<MigrationTimeouts> {
  const result = await sql<MigrationTimeouts>`
    SELECT
      current_setting('lock_timeout') AS lock_timeout,
      current_setting('statement_timeout') AS statement_timeout
  `.execute(db)
  return result.rows[0] ?? { lock_timeout: '0', statement_timeout: '0' }
}

async function applyMigrationTimeouts(db: Kysely<unknown>): Promise<void> {
  await sql`
    SELECT
      set_config('lock_timeout', ${MIGRATION_LOCK_TIMEOUT}, true),
      set_config('statement_timeout', ${MIGRATION_STATEMENT_TIMEOUT}, true)
  `.execute(db)
}

async function restoreMigrationTimeouts(db: Kysely<unknown>, previous: MigrationTimeouts): Promise<void> {
  await sql`
    SELECT
      set_config('lock_timeout', ${previous.lock_timeout}, true),
      set_config('statement_timeout', ${previous.statement_timeout}, true)
  `.execute(db)
}

async function requirePrerequisites(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ integrations: boolean; identities: boolean }>`
    SELECT
      to_regclass('directory_integrations') IS NOT NULL AS integrations,
      to_regclass('user_external_identities') IS NOT NULL AS identities
  `.execute(db)
  const row = result.rows[0]
  if (row?.integrations !== true || row.identities !== true) {
    fail(
      ADMIN_GRANT_RECEIVING_PREREQUISITE_CODE,
      'directory_integrations and user_external_identities must exist before this migration runs. Nothing was changed.',
    )
  }
}

async function applyUp(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE directory_connection_application_pins (
      connection_id uuid NOT NULL,
      application_revision text NOT NULL,
      material_fingerprint text NOT NULL,
      updated_by text NOT NULL,
      CONSTRAINT directory_connection_application_pins_pkey PRIMARY KEY (connection_id),
      CONSTRAINT directory_connection_application_pins_connection_fk
        FOREIGN KEY (connection_id) REFERENCES directory_integrations (id) ON DELETE RESTRICT,
      CONSTRAINT directory_connection_application_pins_revision_chk
        CHECK (application_revision ~ '^(0|[1-9][0-9]*)$'),
      CONSTRAINT directory_connection_application_pins_fingerprint_chk
        CHECK (material_fingerprint ~ '^[0-9a-f]{64}$')
    )
  `.execute(db)
  await sql`
    CREATE TABLE user_external_identity_binding_pins (
      identity_id uuid NOT NULL,
      binding_revision bigint NOT NULL,
      provider text NOT NULL,
      local_user_id text NOT NULL,
      external_key text NOT NULL,
      corp_id text,
      provider_open_id text,
      provider_union_id text,
      CONSTRAINT user_external_identity_binding_pins_pkey PRIMARY KEY (identity_id),
      CONSTRAINT user_external_identity_binding_pins_identity_fk
        FOREIGN KEY (identity_id) REFERENCES user_external_identities (id) ON DELETE CASCADE,
      CONSTRAINT user_external_identity_binding_pins_revision_chk
        CHECK (binding_revision >= 0 AND binding_revision <= 9223372036854775807)
    )
  `.execute(db)
  await sql`
    CREATE TABLE user_external_identity_evidence (
      id text NOT NULL,
      evidence_witness text NOT NULL,
      identity_id text NOT NULL,
      live_identity_id uuid,
      binding_revision bigint NOT NULL,
      producer_id text NOT NULL,
      assurance text NOT NULL,
      subject_key text NOT NULL,
      app_scope text NOT NULL,
      org_id text NOT NULL,
      connection_id uuid NOT NULL,
      capability_revision_seen bigint NOT NULL,
      application_revision text NOT NULL,
      material_fingerprint text NOT NULL,
      evidence_revision bigint NOT NULL,
      witnessed_at timestamptz NOT NULL,
      fresh_until timestamptz NOT NULL,
      revocation_generation bigint NOT NULL,
      slot_snapshot jsonb NOT NULL,
      created_by text NOT NULL,
      revoked_at timestamptz,
      CONSTRAINT user_external_identity_evidence_pkey PRIMARY KEY (id),
      CONSTRAINT user_external_identity_evidence_live_identity_fk
        FOREIGN KEY (live_identity_id) REFERENCES user_external_identities (id) ON DELETE RESTRICT,
      CONSTRAINT user_external_identity_evidence_connection_fk
        FOREIGN KEY (connection_id) REFERENCES directory_integrations (id) ON DELETE RESTRICT,
      CONSTRAINT user_external_identity_evidence_binding_revision_chk
        CHECK (binding_revision >= 0 AND binding_revision <= 9223372036854775807),
      CONSTRAINT user_external_identity_evidence_assurance_chk
        CHECK (assurance IN ('self_authenticated', 'association')),
      CONSTRAINT user_external_identity_evidence_revision_chk
        CHECK (application_revision ~ '^(0|[1-9][0-9]*)$'),
      CONSTRAINT user_external_identity_evidence_fingerprint_chk
        CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT user_external_identity_evidence_evidence_revision_chk
        CHECK (evidence_revision >= 1),
      CONSTRAINT user_external_identity_evidence_generation_chk
        CHECK (revocation_generation >= 0),
      CONSTRAINT user_external_identity_evidence_freshness_chk
        CHECK (fresh_until > witnessed_at),
      CONSTRAINT user_external_identity_evidence_lifecycle_chk
        CHECK (
          (revoked_at IS NULL AND live_identity_id IS NOT NULL AND live_identity_id::text = identity_id)
          OR (revoked_at IS NOT NULL AND live_identity_id IS NULL)
        )
    )
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX user_external_identity_evidence_live_identity_uniq
      ON user_external_identity_evidence (live_identity_id)
      WHERE live_identity_id IS NOT NULL
  `.execute(db)
  await sql`
    CREATE FUNCTION admin_grant_evidence_insert_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $$
    BEGIN
      IF NEW.revoked_at IS NOT NULL
         OR NEW.live_identity_id IS NULL
         OR NEW.revocation_generation IS DISTINCT FROM 0
         OR NEW.live_identity_id::text IS DISTINCT FROM NEW.identity_id THEN
        RAISE EXCEPTION 'admin grant evidence insert refused' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $$
  `.execute(db)
  await sql`
    CREATE TRIGGER admin_grant_evidence_insert_guard
      BEFORE INSERT ON user_external_identity_evidence
      FOR EACH ROW EXECUTE FUNCTION admin_grant_evidence_insert_guard()
  `.execute(db)
  await sql`
    CREATE FUNCTION admin_grant_evidence_update_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $$
    BEGIN
      IF OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'admin grant evidence revoked update refused' USING ERRCODE = '55000';
      END IF;
      IF OLD.revocation_generation = 9223372036854775807 THEN
        RAISE EXCEPTION 'admin grant evidence generation overflow refused' USING ERRCODE = '55000';
      END IF;
      IF NEW.revocation_generation IS DISTINCT FROM OLD.revocation_generation + 1
         OR NEW.live_identity_id IS NOT NULL
         OR NEW.id IS DISTINCT FROM OLD.id
         OR NEW.evidence_witness IS DISTINCT FROM OLD.evidence_witness
         OR NEW.identity_id IS DISTINCT FROM OLD.identity_id
         OR NEW.binding_revision IS DISTINCT FROM OLD.binding_revision
         OR NEW.producer_id IS DISTINCT FROM OLD.producer_id
         OR NEW.assurance IS DISTINCT FROM OLD.assurance
         OR NEW.subject_key IS DISTINCT FROM OLD.subject_key
         OR NEW.app_scope IS DISTINCT FROM OLD.app_scope
         OR NEW.org_id IS DISTINCT FROM OLD.org_id
         OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
         OR NEW.capability_revision_seen IS DISTINCT FROM OLD.capability_revision_seen
         OR NEW.application_revision IS DISTINCT FROM OLD.application_revision
         OR NEW.material_fingerprint IS DISTINCT FROM OLD.material_fingerprint
         OR NEW.evidence_revision IS DISTINCT FROM OLD.evidence_revision
         OR NEW.witnessed_at IS DISTINCT FROM OLD.witnessed_at
         OR NEW.fresh_until IS DISTINCT FROM OLD.fresh_until
         OR NEW.slot_snapshot IS DISTINCT FROM OLD.slot_snapshot
         OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'admin grant evidence transition refused' USING ERRCODE = '55000';
      END IF;
      NEW.revoked_at := clock_timestamp();
      RETURN NEW;
    END
    $$
  `.execute(db)
  await sql`
    CREATE TRIGGER admin_grant_evidence_update_guard
      BEFORE UPDATE ON user_external_identity_evidence
      FOR EACH ROW EXECUTE FUNCTION admin_grant_evidence_update_guard()
  `.execute(db)
  await sql`
    CREATE FUNCTION admin_grant_evidence_delete_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $$
    BEGIN
      RAISE EXCEPTION 'admin grant evidence delete refused' USING ERRCODE = '55000';
    END
    $$
  `.execute(db)
  await sql`
    CREATE TRIGGER admin_grant_evidence_delete_guard
      BEFORE DELETE ON user_external_identity_evidence
      FOR EACH ROW EXECUTE FUNCTION admin_grant_evidence_delete_guard()
  `.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  await requirePrerequisites(db)
  await applyUp(db)
  await restoreMigrationTimeouts(db, previous)
}

async function tableHoldsRow(db: Kysely<unknown>, present: boolean, tableName: 'directory_connection_application_pins' | 'user_external_identity_binding_pins' | 'user_external_identity_evidence'): Promise<boolean> {
  if (!present) return false
  if (tableName === 'directory_connection_application_pins') {
    const rows = await sql<{ present: boolean }>`
      SELECT EXISTS (SELECT 1 FROM directory_connection_application_pins) AS present
    `.execute(db)
    return rows.rows[0]?.present === true
  }
  if (tableName === 'user_external_identity_binding_pins') {
    const rows = await sql<{ present: boolean }>`
      SELECT EXISTS (SELECT 1 FROM user_external_identity_binding_pins) AS present
    `.execute(db)
    return rows.rows[0]?.present === true
  }
  const rows = await sql<{ present: boolean }>`
    SELECT EXISTS (SELECT 1 FROM user_external_identity_evidence) AS present
  `.execute(db)
  return rows.rows[0]?.present === true
}

type ReceivingTablePresence = {
  application_pins: boolean
  binding_pins: boolean
  evidence: boolean
}

async function requireCallerTransaction(db: Kysely<unknown>): Promise<void> {
  const first = await sql<{ xid: string }>`SELECT pg_current_xact_id()::text AS xid`.execute(db)
  const second = await sql<{ xid: string }>`SELECT pg_current_xact_id()::text AS xid`.execute(db)
  const firstXid = first.rows[0]?.xid
  const secondXid = second.rows[0]?.xid
  if (typeof firstXid !== 'string' || firstXid.length === 0 || firstXid !== secondXid) {
    fail(
      ADMIN_GRANT_RECEIVING_DOWN_REQUIRES_TRANSACTION_CODE,
      'down() requires an open caller transaction so its ACCESS EXCLUSIVE locks stay held through the empty check and DROP. A plain autocommit invocation changes nothing.',
    )
  }
  const isolation = await sql<{ isolation: string }>`
    SELECT current_setting('transaction_isolation') AS isolation
  `.execute(db)
  if (isolation.rows[0]?.isolation !== 'read committed') {
    fail(
      ADMIN_GRANT_RECEIVING_DOWN_REQUIRES_READ_COMMITTED_CODE,
      'down() requires read committed before it locks, checks, or drops receiving tables. Nothing was changed.',
    )
  }
}

async function presentReceivingTables(db: Kysely<unknown>): Promise<ReceivingTablePresence> {
  const exists = await sql<{ application_pins: boolean; binding_pins: boolean; evidence: boolean }>`
    SELECT
      to_regclass('directory_connection_application_pins') IS NOT NULL AS application_pins,
      to_regclass('user_external_identity_binding_pins') IS NOT NULL AS binding_pins,
      to_regclass('user_external_identity_evidence') IS NOT NULL AS evidence
  `.execute(db)
  const row = exists.rows[0]
  return {
    application_pins: row?.application_pins === true,
    binding_pins: row?.binding_pins === true,
    evidence: row?.evidence === true,
  }
}

async function lockPresentReceivingTables(db: Kysely<unknown>, present: ReceivingTablePresence): Promise<void> {
  if (present.application_pins) {
    await sql`LOCK TABLE directory_connection_application_pins IN ACCESS EXCLUSIVE MODE`.execute(db)
  }
  if (present.binding_pins) {
    await sql`LOCK TABLE user_external_identity_binding_pins IN ACCESS EXCLUSIVE MODE`.execute(db)
  }
  if (present.evidence) {
    await sql`LOCK TABLE user_external_identity_evidence IN ACCESS EXCLUSIVE MODE`.execute(db)
  }
}

async function refuseDownWhileRowsExist(db: Kysely<unknown>, present: ReceivingTablePresence): Promise<void> {
  const held = await tableHoldsRow(db, present.application_pins, 'directory_connection_application_pins')
    || await tableHoldsRow(db, present.binding_pins, 'user_external_identity_binding_pins')
    || await tableHoldsRow(db, present.evidence, 'user_external_identity_evidence')
  if (held) {
    fail(
      ADMIN_GRANT_RECEIVING_DOWN_BLOCKED_CODE,
      'down() refused while an admin grant receiving table holds a row. Nothing was changed.',
    )
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await requireCallerTransaction(db)
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  const present = await presentReceivingTables(db)
  await lockPresentReceivingTables(db, present)
  await refuseDownWhileRowsExist(db, present)
  await sql`DROP TABLE IF EXISTS user_external_identity_evidence`.execute(db)
  await sql`DROP TABLE IF EXISTS user_external_identity_binding_pins`.execute(db)
  await sql`DROP TABLE IF EXISTS directory_connection_application_pins`.execute(db)
  await sql`DROP FUNCTION IF EXISTS admin_grant_evidence_delete_guard()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS admin_grant_evidence_update_guard()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS admin_grant_evidence_insert_guard()`.execute(db)
  await restoreMigrationTimeouts(db, previous)
}
