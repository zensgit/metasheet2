/**
 * Connection verification evidence and the test-send ledger. Both tables store fixed metadata only.
 * The endpoint migration must already exist; its composite keys bind each send to its owner and
 * connection. down() refuses while either table holds rows. Timeout settings are restored afterwards.
 */
import { sql, type Kysely } from 'kysely'
import { applyMigrationTimeouts, readMigrationTimeouts, restoreMigrationTimeouts } from '../migration-timeouts'

export const NOTIFICATION_SEND_PREREQUISITE_CODE = 'NOTIFICATION_SEND_PREREQUISITE_MISSING'
export const NOTIFICATION_SEND_DOWN_BLOCKED_CODE = 'NOTIFICATION_SEND_DOWN_BLOCKED'

export async function up(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  const prerequisites = await sql<{ endpoints: boolean; preferences: boolean }>`
    SELECT to_regclass('user_notification_endpoints') IS NOT NULL AS endpoints,
      to_regclass('user_notification_preferences') IS NOT NULL AS preferences
  `.execute(db)
  if (prerequisites.rows[0]?.endpoints !== true || prerequisites.rows[0]?.preferences !== true) {
    throw Object.assign(new Error(`${NOTIFICATION_SEND_PREREQUISITE_CODE}: user notification tables must exist. Nothing was changed.`), {
      code: NOTIFICATION_SEND_PREREQUISITE_CODE,
    })
  }
  await sql`
    CREATE TABLE notification_connection_verifications (
      connection_id uuid PRIMARY KEY,
      provider text NOT NULL,
      reached_level text NOT NULL,
      tuple_fingerprint text NOT NULL,
      bound_tenant text NOT NULL,
      bound_app_scope text NOT NULL,
      verified_by text NOT NULL,
      verified_at timestamptz NOT NULL,
      invalidated_at timestamptz,
      revision bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ncv_conn_fk FOREIGN KEY (connection_id, provider)
        REFERENCES directory_integrations (id, provider) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT ncv_level_chk CHECK (reached_level IN ('token', 'send')),
      CONSTRAINT ncv_shape_chk CHECK (
        provider ~ '^[a-z][a-z0-9_]{0,31}$' AND bound_tenant ~ '^[!-~]+$'
        AND bound_app_scope ~ '^[!-~]+$' AND char_length(bound_app_scope) <= 256
        AND verified_by ~ '^[!-~]+$'),
      CONSTRAINT ncv_fp_chk CHECK (tuple_fingerprint ~ '^[0-9a-f]{64}$'),
      CONSTRAINT ncv_revision_chk CHECK (revision >= 1)
    )
  `.execute(db)
  await sql`
    CREATE TABLE notification_test_sends (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      user_id text NOT NULL,
      endpoint_id uuid NOT NULL,
      connection_id uuid NOT NULL,
      idempotency_key text NOT NULL,
      state text NOT NULL DEFAULT 'pending',
      outcome_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      sending_at timestamptz,
      finished_at timestamptz,
      CONSTRAINT nts_endpoint_fk FOREIGN KEY (endpoint_id, org_id, user_id)
        REFERENCES user_notification_endpoints (id, org_id, user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT nts_endpoint_conn_fk FOREIGN KEY (endpoint_id, connection_id)
        REFERENCES user_notification_endpoints (id, connection_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT nts_state_chk CHECK (state IN ('pending', 'sending', 'accepted', 'failed', 'outcome_unknown', 'refused')),
      CONSTRAINT nts_key_chk CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,64}$'),
      CONSTRAINT nts_code_chk CHECK (outcome_code IS NULL OR outcome_code ~ '^[a-z][a-z0-9_]{0,63}$'
        OR (char_length(outcome_code) <= 64 AND outcome_code ~ '^dingtalk_business_error_(-[0-9]+([.][0-9]+)?|[0-9]+[.][0-9]+)$')),
      CONSTRAINT nts_finished_chk CHECK ((state IN ('pending', 'sending')) = (finished_at IS NULL)),
      CONSTRAINT nts_sending_at_chk CHECK (state <> 'sending' OR sending_at IS NOT NULL),
      CONSTRAINT nts_terminal_code_chk CHECK (state IN ('pending', 'sending') OR outcome_code IS NOT NULL),
      CONSTRAINT nts_shape_chk CHECK (org_id ~ '^[!-~]+$' AND user_id ~ '^[!-~]+$')
    )
  `.execute(db)
  await sql`CREATE UNIQUE INDEX nts_key_uniq ON notification_test_sends (org_id, user_id, idempotency_key)`.execute(db)
  await sql`CREATE INDEX nts_user_time_idx ON notification_test_sends (org_id, user_id, created_at DESC)`.execute(db)
  await sql`CREATE INDEX nts_conn_time_idx ON notification_test_sends (connection_id, created_at DESC)`.execute(db)
  await restoreMigrationTimeouts(db, previous)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  const tables = await sql<{ evidence: boolean; sends: boolean }>`
    SELECT to_regclass('notification_connection_verifications') IS NOT NULL AS evidence,
      to_regclass('notification_test_sends') IS NOT NULL AS sends
  `.execute(db)
  let held = false
  if (tables.rows[0]?.evidence === true) {
    const rows = await sql<{ present: boolean }>`SELECT EXISTS (SELECT 1 FROM notification_connection_verifications) AS present`.execute(db)
    held = rows.rows[0]?.present === true
  }
  if (tables.rows[0]?.sends === true) {
    const rows = await sql<{ present: boolean }>`SELECT EXISTS (SELECT 1 FROM notification_test_sends) AS present`.execute(db)
    held = held || rows.rows[0]?.present === true
  }
  if (held) {
    throw Object.assign(new Error(`${NOTIFICATION_SEND_DOWN_BLOCKED_CODE}: notification verification or test-send rows exist. Roll back the application and retain the tables.`), {
      code: NOTIFICATION_SEND_DOWN_BLOCKED_CODE,
    })
  }
  await sql`DROP TABLE IF EXISTS notification_test_sends`.execute(db)
  await sql`DROP TABLE IF EXISTS notification_connection_verifications`.execute(db)
  await restoreMigrationTimeouts(db, previous)
}
