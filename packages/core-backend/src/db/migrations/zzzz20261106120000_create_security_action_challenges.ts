/**
 * security_action_challenges: one row per credential verification attempt for a security action.
 * An issued row is a one-time proof; a failed row counts toward the per-user failure limit.
 * Rows start as issued or failed; the only transitions are issued -> consumed and
 * issued -> superseded; a proof lives at most 300 seconds; at most one issued row exists per user,
 * session and purpose. The lock and statement bounds apply to this migration only and are restored
 * afterwards. down() refuses while the table holds a row.
 *
 * Ordering: Kysely runs migrations in full-filename order; this file sorts after every migration on
 * main at the time it was written. It depends on `users` only.
 */
import { sql, type Kysely } from 'kysely'

const MIGRATION_LOCK_TIMEOUT = '5s'
const MIGRATION_STATEMENT_TIMEOUT = '1min'

export const SECURITY_ACTION_CHALLENGES_DOWN_BLOCKED_CODE = 'SECURITY_ACTION_CHALLENGES_DOWN_BLOCKED'

type MigrationTimeouts = { lock_timeout: string; statement_timeout: string }

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

async function applyUp(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE security_action_challenges (
      id uuid NOT NULL,
      user_id text NOT NULL,
      session_id text NOT NULL,
      org_id text,
      purpose text NOT NULL,
      connection_id uuid,
      target_kind text NOT NULL,
      target_identity_id uuid,
      expected_binding_revision bigint,
      target_witness text NOT NULL,
      method text NOT NULL,
      method_connection_id uuid,
      assurance text,
      status text NOT NULL,
      failure_code text,
      proof_hash text,
      client_binding_digest text,
      policy_revision integer NOT NULL,
      access_generation bigint NOT NULL,
      credential_witness text NOT NULL,
      privilege_witness text NOT NULL,
      privilege_class text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,
      consumed_at timestamptz,
      consumed_action_ref text,
      superseded_at timestamptz,
      CONSTRAINT security_action_challenges_pkey PRIMARY KEY (id),
      CONSTRAINT security_action_challenges_purpose_chk CHECK (purpose IN ('external_identity_bind', 'external_identity_unbind', 'login_grant_enable', 'login_grant_disable')),
      CONSTRAINT security_action_challenges_target_kind_chk CHECK (target_kind IN ('empty_slot', 'identity_revision')),
      CONSTRAINT security_action_challenges_identity_target_chk CHECK ((target_kind = 'identity_revision') = (target_identity_id IS NOT NULL AND expected_binding_revision IS NOT NULL)),
      CONSTRAINT security_action_challenges_empty_slot_chk CHECK (target_kind = 'identity_revision' OR (target_identity_id IS NULL AND expected_binding_revision IS NULL)),
      CONSTRAINT security_action_challenges_binding_revision_chk CHECK (expected_binding_revision IS NULL OR expected_binding_revision >= 0),
      CONSTRAINT security_action_challenges_method_chk CHECK (method IN ('local_password', 'external_reauth')),
      CONSTRAINT security_action_challenges_method_connection_chk CHECK ((method = 'external_reauth') = (method_connection_id IS NOT NULL)),
      CONSTRAINT security_action_challenges_status_chk CHECK (status IN ('issued', 'consumed', 'superseded', 'failed')),
      CONSTRAINT security_action_challenges_privilege_class_chk CHECK (privilege_class IN ('standard', 'high')),
      CONSTRAINT security_action_challenges_policy_revision_chk CHECK (policy_revision > 0),
      CONSTRAINT security_action_challenges_witness_chk CHECK (target_witness ~ '^[0-9a-f]{64}$' AND credential_witness ~ '^[0-9a-f]{64}$' AND privilege_witness ~ '^[0-9a-f]{64}$'),
      CONSTRAINT security_action_challenges_proof_hash_chk CHECK (proof_hash IS NULL OR proof_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT security_action_challenges_client_binding_chk CHECK (client_binding_digest IS NULL OR client_binding_digest ~ '^[0-9a-f]{64}$'),
      CONSTRAINT security_action_challenges_action_ref_chk CHECK (consumed_action_ref IS NULL OR consumed_action_ref ~ '^[!-~]{1,128}$'),
      CONSTRAINT security_action_challenges_failed_shape_chk CHECK (status <> 'failed' OR (proof_hash IS NULL AND expires_at IS NULL AND assurance IS NULL AND consumed_at IS NULL AND superseded_at IS NULL AND client_binding_digest IS NULL AND failure_code IN ('credential_rejected', 'reauth_subject_mismatch'))),
      CONSTRAINT security_action_challenges_proof_shape_chk CHECK (status = 'failed' OR (proof_hash IS NOT NULL AND expires_at IS NOT NULL AND failure_code IS NULL AND assurance IN ('local_password', 'external_platform_asserted'))),
      CONSTRAINT security_action_challenges_consumed_chk CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
      CONSTRAINT security_action_challenges_superseded_chk CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
      CONSTRAINT security_action_challenges_action_ref_status_chk CHECK (consumed_action_ref IS NULL OR status = 'consumed'),
      CONSTRAINT security_action_challenges_ttl_chk CHECK (expires_at IS NULL OR (expires_at > created_at AND expires_at <= created_at + interval '300 seconds'))
    )
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX uq_security_action_live_proof ON security_action_challenges (user_id, session_id, purpose)
      WHERE status = 'issued'
  `.execute(db)
  await sql`
    CREATE INDEX idx_security_action_user_created ON security_action_challenges (user_id, created_at)
  `.execute(db)
  await sql`
    ALTER TABLE security_action_challenges
      ADD CONSTRAINT security_action_challenges_user_fk FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID
  `.execute(db)
  await sql`
    ALTER TABLE security_action_challenges VALIDATE CONSTRAINT security_action_challenges_user_fk
  `.execute(db)
  // Rows are admitted only as issued or failed, never dated in the future; an issued row may only
  // become consumed or superseded, and no other column may change on that transition.
  await sql`
    CREATE FUNCTION guard_security_action_challenge_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status NOT IN ('issued', 'failed') OR NEW.created_at > now() THEN
          RAISE EXCEPTION 'security action challenge state refused' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.status <> 'issued'
         OR NEW.status NOT IN ('consumed', 'superseded')
         OR (to_jsonb(NEW) - ARRAY['status', 'consumed_at', 'consumed_action_ref', 'superseded_at'])
            IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'consumed_at', 'consumed_action_ref', 'superseded_at']) THEN
        RAISE EXCEPTION 'security action challenge transition refused' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $$
  `.execute(db)
  await sql`
    CREATE TRIGGER security_action_challenge_transition
      BEFORE INSERT OR UPDATE ON security_action_challenges
      FOR EACH ROW EXECUTE FUNCTION guard_security_action_challenge_transition()
  `.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Kysely runs every pending migration in one transaction. Scope the lock and statement bounds to
  // this migration and restore them on success so later migrations do not inherit the settings.
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  await applyUp(db)
  await restoreMigrationTimeouts(db, previous)
}

// The table is retained security history. The existence check and the row check are two statements
// because Postgres resolves every relation named in a statement before evaluating it.
async function refuseDownWhileRowsExist(db: Kysely<unknown>): Promise<void> {
  const exists = await sql<{ e: boolean }>`
    SELECT to_regclass('security_action_challenges') IS NOT NULL AS e
  `.execute(db)
  if (!exists.rows[0]?.e) return
  const present = await sql<{ present: boolean }>`
    SELECT EXISTS (SELECT 1 FROM security_action_challenges) AS present
  `.execute(db)
  if (present.rows[0]?.present === true) {
    const error = new Error(
      `${SECURITY_ACTION_CHALLENGES_DOWN_BLOCKED_CODE}: down() refused while security_action_challenges holds rows; they are retained security history. Nothing was changed. Roll back the application build and leave the table in place.`,
    )
    ;(error as Error & { code?: string }).code = SECURITY_ACTION_CHALLENGES_DOWN_BLOCKED_CODE
    throw error
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  await refuseDownWhileRowsExist(db)
  await sql`DROP TABLE IF EXISTS security_action_challenges`.execute(db)
  await sql`DROP FUNCTION IF EXISTS guard_security_action_challenge_transition()`.execute(db)
  await restoreMigrationTimeouts(db, previous)
}
