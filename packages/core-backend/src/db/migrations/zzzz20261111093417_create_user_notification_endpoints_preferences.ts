/**
 * user_notification_endpoints: one row per (organization, user, connection, address kind, proof kind).
 * A row stores a reference to the proof that makes an address derivable plus digests of the proof state
 * and of the address; it never stores the address itself.
 * user_notification_preferences: one row per (organization, user, topic).
 *
 * Both tables are new and empty; no existing table is altered. The lock and statement bounds apply to
 * this migration only and are restored afterwards. down() refuses while either table holds a row.
 *
 * proof_id carries no foreign key: unbinding an identity or cancelling a directory link must keep
 * working while an endpoint refers to it; the next re-check finds the proof gone and marks the
 * endpoint stale. There is no foreign key to users or user_orgs either; membership is checked by the
 * services. The references between these tables and to directory_integrations use RESTRICT.
 *
 * Ordering: Kysely runs migrations in full-filename order; this file sorts after every migration on
 * main at the time it was written. It depends on directory_integrations and its two unique
 * constraints (id, provider) and (id, org_id); a missing prerequisite aborts the whole batch.
 */
import { sql, type Kysely } from 'kysely'
import { applyMigrationTimeouts, readMigrationTimeouts, restoreMigrationTimeouts } from '../migration-timeouts'

export const USER_NOTIFICATION_DOWN_BLOCKED_CODE = 'USER_NOTIFICATION_ENDPOINTS_DOWN_BLOCKED'
export const USER_NOTIFICATION_PREREQUISITE_CODE = 'USER_NOTIFICATION_ENDPOINTS_PREREQUISITE_MISSING'

async function requirePrerequisites(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ present: boolean; by_provider: boolean; by_org: boolean }>`
    SELECT
      to_regclass('directory_integrations') IS NOT NULL AS present,
      EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'uq_directory_integrations_id_provider'
           AND conrelid = to_regclass('directory_integrations')
           AND contype = 'u'
      ) AS by_provider,
      EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'uq_directory_integrations_id_org'
           AND conrelid = to_regclass('directory_integrations')
           AND contype = 'u'
      ) AS by_org
  `.execute(db)
  const row = result.rows[0]
  if (row?.present !== true || row.by_provider !== true || row.by_org !== true) {
    const error = new Error(
      `${USER_NOTIFICATION_PREREQUISITE_CODE}: directory_integrations and its unique constraints on (id, provider) and (id, org_id) must exist before this migration runs. Nothing was changed.`,
    )
    ;(error as Error & { code?: string }).code = USER_NOTIFICATION_PREREQUISITE_CODE
    throw error
  }
}

async function applyUp(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE user_notification_endpoints (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      user_id text NOT NULL,
      connection_id uuid NOT NULL,
      provider text NOT NULL,
      address_kind text NOT NULL,
      proof_kind text NOT NULL,
      proof_id uuid NOT NULL,
      proof_witness text NOT NULL,
      address_witness text NOT NULL,
      tenant_address_witness text NOT NULL,
      bound_tenant text NOT NULL,
      bound_app_scope text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      revision bigint NOT NULL DEFAULT 1,
      last_verified_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT une_conn_org_fk FOREIGN KEY (connection_id, org_id)
        REFERENCES directory_integrations (id, org_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT une_conn_provider_fk FOREIGN KEY (connection_id, provider)
        REFERENCES directory_integrations (id, provider) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT une_shape_chk CHECK (
        org_id ~ '^[!-~]+$' AND user_id ~ '^[!-~]+$'
        AND provider ~ '^[a-z][a-z0-9_]{0,31}$' AND address_kind ~ '^[a-z][a-z0-9_]{0,63}$'
        AND bound_tenant ~ '^[!-~]+$' AND bound_app_scope ~ '^[!-~]+$' AND char_length(bound_app_scope) <= 256
        AND proof_witness ~ '^[0-9a-f]{64}$' AND address_witness ~ '^[0-9a-f]{64}$'
        AND tenant_address_witness ~ '^[0-9a-f]{64}$'),
      CONSTRAINT une_proof_kind_chk CHECK (proof_kind IN ('directory_link', 'external_identity')),
      CONSTRAINT une_status_chk CHECK (status IN ('active', 'stale', 'revoked')),
      CONSTRAINT une_revision_chk CHECK (revision >= 1),
      CONSTRAINT une_revoked_chk CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
      CONSTRAINT une_id_org_user_uniq UNIQUE (id, org_id, user_id),
      CONSTRAINT une_id_conn_uniq UNIQUE (id, connection_id)
    )
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX une_proof_uniq
      ON user_notification_endpoints (org_id, user_id, connection_id, address_kind, proof_kind)
  `.execute(db)
  // One active endpoint per address within a provider and tenant anchor: any user, any connection, any
  // organization. The index carries no org_id because the identifier's real scope is the tenant anchor.
  await sql`
    CREATE UNIQUE INDEX une_tenant_address_active_uniq
      ON user_notification_endpoints (provider, bound_tenant, address_kind, tenant_address_witness)
      WHERE status = 'active'
  `.execute(db)
  await sql`CREATE INDEX une_user_idx ON user_notification_endpoints (org_id, user_id)`.execute(db)

  await sql`
    CREATE TABLE user_notification_preferences (
      org_id text NOT NULL,
      user_id text NOT NULL,
      topic text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      primary_endpoint_id uuid,
      fallback_endpoint_id uuid,
      quiet_start time,
      quiet_end time,
      quiet_timezone text,
      revision bigint NOT NULL DEFAULT 1,
      updated_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, user_id, topic),
      CONSTRAINT unp_primary_fk FOREIGN KEY (primary_endpoint_id, org_id, user_id)
        REFERENCES user_notification_endpoints (id, org_id, user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT unp_fallback_fk FOREIGN KEY (fallback_endpoint_id, org_id, user_id)
        REFERENCES user_notification_endpoints (id, org_id, user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT unp_shape_chk CHECK (
        org_id ~ '^[!-~]+$' AND user_id ~ '^[!-~]+$' AND topic ~ '^[a-z][a-z0-9_]{0,63}$'
        AND updated_by ~ '^[!-~]+$'),
      CONSTRAINT unp_distinct_chk CHECK (
        fallback_endpoint_id IS NULL OR (primary_endpoint_id IS NOT NULL AND fallback_endpoint_id <> primary_endpoint_id)),
      CONSTRAINT unp_quiet_all_or_none_chk CHECK (
        (quiet_start IS NULL) = (quiet_end IS NULL) AND (quiet_start IS NULL) = (quiet_timezone IS NULL)),
      CONSTRAINT unp_quiet_minute_chk CHECK (
        quiet_start IS NULL OR (extract(second FROM quiet_start) = 0 AND extract(second FROM quiet_end) = 0)),
      CONSTRAINT unp_quiet_nonempty_chk CHECK (quiet_start IS NULL OR quiet_start <> quiet_end),
      CONSTRAINT unp_quiet_tz_shape_chk CHECK (quiet_timezone IS NULL OR quiet_timezone ~ '^[A-Za-z0-9_+/-]{1,64}$'),
      CONSTRAINT unp_revision_chk CHECK (revision >= 1)
    )
  `.execute(db)
  await sql`
    CREATE INDEX unp_primary_idx ON user_notification_preferences (primary_endpoint_id)
      WHERE primary_endpoint_id IS NOT NULL
  `.execute(db)
  await sql`
    CREATE INDEX unp_fallback_idx ON user_notification_preferences (fallback_endpoint_id)
      WHERE fallback_endpoint_id IS NOT NULL
  `.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  await requirePrerequisites(db)
  await applyUp(db)
  await restoreMigrationTimeouts(db, previous)
}

// Each existence check and its row check are separate statements because Postgres resolves every
// relation named in a statement before evaluating it.
async function refuseDownWhileRowsExist(db: Kysely<unknown>): Promise<void> {
  const exists = await sql<{ endpoints: boolean; preferences: boolean }>`
    SELECT
      to_regclass('user_notification_endpoints') IS NOT NULL AS endpoints,
      to_regclass('user_notification_preferences') IS NOT NULL AS preferences
  `.execute(db)
  const present = exists.rows[0]
  let held = false
  if (present?.endpoints === true) {
    const rows = await sql<{ present: boolean }>`
      SELECT EXISTS (SELECT 1 FROM user_notification_endpoints) AS present
    `.execute(db)
    held = held || rows.rows[0]?.present === true
  }
  if (present?.preferences === true) {
    const rows = await sql<{ present: boolean }>`
      SELECT EXISTS (SELECT 1 FROM user_notification_preferences) AS present
    `.execute(db)
    held = held || rows.rows[0]?.present === true
  }
  if (held) {
    const error = new Error(
      `${USER_NOTIFICATION_DOWN_BLOCKED_CODE}: down() refused while the user notification endpoint or preference tables hold rows. Nothing was changed. Roll back the application build and leave the tables in place.`,
    )
    ;(error as Error & { code?: string }).code = USER_NOTIFICATION_DOWN_BLOCKED_CODE
    throw error
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  await refuseDownWhileRowsExist(db)
  await sql`DROP TABLE IF EXISTS user_notification_preferences`.execute(db)
  await sql`DROP TABLE IF EXISTS user_notification_endpoints`.execute(db)
  await restoreMigrationTimeouts(db, previous)
}
