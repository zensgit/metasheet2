/** Persistent notification routing metadata. Nonempty tables cannot be rolled back. */
import { sql, type Kysely } from 'kysely'
import { applyMigrationTimeouts, readMigrationTimeouts, restoreMigrationTimeouts } from '../migration-timeouts'

export async function up(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  const prerequisite = await sql<{ present: boolean }>`SELECT to_regclass('directory_integrations') IS NOT NULL AS present`.execute(db)
  if (prerequisite.rows[0]?.present !== true) throw new Error('NOTIFICATION_ROUTING_PREREQUISITE_MISSING')
  await sql`
    CREATE TABLE org_notification_topic_policies (
      org_id                text        NOT NULL,
      topic                 text        NOT NULL,
      state                 text        NOT NULL,
      default_connection_id uuid,
      revision              bigint      NOT NULL DEFAULT 1,
      created_by            text        NOT NULL,
      updated_by            text        NOT NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, topic),
      CONSTRAINT ontp_default_conn_fk FOREIGN KEY (default_connection_id, org_id) REFERENCES directory_integrations (id, org_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT ontp_state_chk CHECK (state IN ('active', 'paused')),
      CONSTRAINT ontp_shape_chk CHECK (org_id ~ '^[!-~]+$' AND topic ~ '^[a-z][a-z0-9_]{0,63}$' AND created_by ~ '^[!-~]+$' AND updated_by ~ '^[!-~]+$'),
      CONSTRAINT ontp_revision_chk CHECK (revision >= 1)
    )
  `.execute(db)
  await restoreMigrationTimeouts(db, previous)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  const table = await sql<{ present: boolean }>`SELECT to_regclass('org_notification_topic_policies') IS NOT NULL AS present`.execute(db)
  if (table.rows[0]?.present === true) {
    const held = await sql<{ present: boolean }>`SELECT EXISTS (SELECT 1 FROM org_notification_topic_policies) AS present`.execute(db)
    if (held.rows[0]?.present === true) throw new Error('NOTIFICATION_ROUTING_DOWN_BLOCKED')
  }
  await sql`DROP TABLE IF EXISTS org_notification_topic_policies`.execute(db)
  await restoreMigrationTimeouts(db, previous)
}
