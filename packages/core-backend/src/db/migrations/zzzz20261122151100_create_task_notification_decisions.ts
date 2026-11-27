/** Persistent notification routing metadata. Nonempty tables cannot be rolled back. */
import { sql, type Kysely } from 'kysely'
import { applyMigrationTimeouts, readMigrationTimeouts, restoreMigrationTimeouts } from '../migration-timeouts'

export async function up(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  const prerequisite = await sql<{ present: boolean }>`SELECT to_regclass('task_notification_deliveries') IS NOT NULL AS present`.execute(db)
  if (prerequisite.rows[0]?.present !== true) throw new Error('NOTIFICATION_ROUTING_PREREQUISITE_MISSING')
  await sql`
    CREATE TABLE task_notification_delivery_decisions (
      delivery_id            uuid     PRIMARY KEY REFERENCES task_notification_deliveries (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      org_id                 text     NOT NULL,
      recipient_user_id      text     NOT NULL,
      event_key              text     NOT NULL,
      rank                   smallint NOT NULL,
      route_source           text,
      connection_id          uuid,
      endpoint_id            uuid,
      endpoint_revision      bigint,
      preference_revision    bigint,
      policy_revision        bigint   NOT NULL,
      capability_revision    bigint,
      capability_witness     text,
      verification_level     text,
      address_kind           text,
      address_witness        text,
      proof_witness          text,
      bound_tenant           text,
      bound_app_scope        text,
      fallback               jsonb,
      excluded               jsonb    NOT NULL DEFAULT '[]'::jsonb,
      reason                 text,
      depends_on_delivery_id uuid,
      router_version         smallint NOT NULL,
      decided_at             timestamptz NOT NULL,
      CONSTRAINT tnd_rank_chk CHECK (rank IN (0, 1)),
      CONSTRAINT tnd_depends_chk CHECK ((rank = 1) = (depends_on_delivery_id IS NOT NULL)),
      CONSTRAINT tnd_target_or_reason_chk CHECK (
        (reason IS NULL AND connection_id IS NOT NULL AND route_source IS NOT NULL AND address_kind IS NOT NULL
           AND address_witness IS NOT NULL AND proof_witness IS NOT NULL AND bound_tenant IS NOT NULL AND bound_app_scope IS NOT NULL
           AND capability_revision IS NOT NULL AND capability_witness IS NOT NULL AND verification_level IS NOT NULL AND policy_revision >= 1)
        OR (reason IS NOT NULL AND connection_id IS NULL AND route_source IS NULL AND fallback IS NULL AND rank = 0
           AND endpoint_id IS NULL AND endpoint_revision IS NULL AND capability_revision IS NULL AND capability_witness IS NULL
           AND verification_level IS NULL AND address_kind IS NULL AND address_witness IS NULL AND proof_witness IS NULL
           AND bound_tenant IS NULL AND bound_app_scope IS NULL)),
      CONSTRAINT tnd_source_chk CHECK (route_source IS NULL OR route_source IN ('user_primary', 'user_fallback', 'org_default')),
      CONSTRAINT tnd_level_chk  CHECK (verification_level IS NULL OR verification_level IN ('token', 'send')),
      CONSTRAINT tnd_source_endpoint_chk CHECK (route_source IS NULL OR (route_source = 'org_default') = (endpoint_id IS NULL)),
      CONSTRAINT tnd_endpoint_revision_chk CHECK ((endpoint_id IS NULL) = (endpoint_revision IS NULL) AND (endpoint_revision IS NULL OR endpoint_revision >= 1)),
      CONSTRAINT tnd_fallback_rank_chk CHECK (fallback IS NULL OR rank = 0),
      CONSTRAINT tnd_json_chk CHECK (jsonb_typeof(excluded) = 'array' AND (fallback IS NULL OR jsonb_typeof(fallback) = 'object')),
      CONSTRAINT tnd_shape_chk CHECK (
        org_id ~ '^[!-~]+$' AND recipient_user_id ~ '^[!-~]+$'
        AND event_key !~ '[[:cntrl:]]' AND length(event_key) <= 512
        AND (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$')
        AND (address_kind IS NULL OR address_kind ~ '^[a-z][a-z0-9_]{0,63}$')
        AND (bound_tenant IS NULL OR bound_tenant ~ '^[!-~]+$')
        AND (bound_app_scope IS NULL OR (bound_app_scope ~ '^[!-~]+$' AND char_length(bound_app_scope) <= 256))
        AND (address_witness IS NULL OR address_witness ~ '^[0-9a-f]{64}$')
        AND (proof_witness IS NULL OR proof_witness ~ '^[0-9a-f]{64}$')
        AND (capability_witness IS NULL OR capability_witness ~ '^[0-9a-f]{64}$'))
    )
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX tnd_group_rank_uniq ON task_notification_delivery_decisions (org_id, recipient_user_id, event_key, rank)
  `.execute(db)
  await sql`
    CREATE INDEX tnd_group_idx ON task_notification_delivery_decisions (org_id, recipient_user_id, event_key)
  `.execute(db)
  await sql`
    CREATE INDEX tnd_continuation_idx ON task_notification_delivery_decisions (decided_at) WHERE rank = 0 AND fallback IS NOT NULL
  `.execute(db)
  await restoreMigrationTimeouts(db, previous)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const previous = await readMigrationTimeouts(db)
  await applyMigrationTimeouts(db)
  const table = await sql<{ present: boolean }>`SELECT to_regclass('task_notification_delivery_decisions') IS NOT NULL AS present`.execute(db)
  if (table.rows[0]?.present === true) {
    await sql`LOCK TABLE task_notification_delivery_decisions IN ACCESS EXCLUSIVE MODE`.execute(db)
    const held = await sql<{ present: boolean }>`SELECT EXISTS (SELECT 1 FROM task_notification_delivery_decisions) AS present`.execute(db)
    if (held.rows[0]?.present === true) throw new Error('NOTIFICATION_ROUTING_DOWN_BLOCKED')
  }
  await sql`DROP TABLE IF EXISTS task_notification_delivery_decisions`.execute(db)
  await restoreMigrationTimeouts(db, previous)
}
