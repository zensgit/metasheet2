import type { Kysely } from 'kysely'
import { sql } from 'kysely'

/**
 * D3 completion for the Rev 4.3 deprovision evidence ledger.
 *
 * The earlier zzzz20260724170000 migration intentionally landed a weak, empty
 * scaffold. This migration makes the database authoritative: provenance is
 * typed, event/account/run relationships are FK-backed, effect vocabulary is
 * closed, the live account link is checked at INSERT time, and historical
 * identity fields are immutable.
 *
 * Upgrade policy:
 * - an empty weak scaffold can be upgraded;
 * - a hardened ledger can be replayed even after evidence exists;
 * - a non-empty weak or partial scaffold fails before any DDL because witness,
 *   policy, and globally-clear provenance cannot be reconstructed honestly;
 * - down() refuses to remove a ledger that contains evidence.
 */

const EVENTS = 'directory_deprovision_events'
const EFFECTS = 'directory_deprovision_effects'
const OWNER = 'owned-by:zzzz20260728100000_harden_directory_deprovision_ledger'
const REQUIRED_PROVENANCE_COLUMNS = [
  'link_witness_account_id',
  'link_witness_local_user_id',
  'policy',
  'globally_clear',
] as const

export const __deprovisionLedgerEffectTypes = ['membership_changed', 'grant_changed', 'user_changed'] as const

async function tableExists(db: Kysely<unknown>, tableName: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = ${tableName}
    ) AS exists
  `.execute(db)
  return result.rows[0]?.exists === true
}

async function columnExists(db: Kysely<unknown>, tableName: string, columnName: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = ${tableName}
         AND column_name = ${columnName}
    ) AS exists
  `.execute(db)
  return result.rows[0]?.exists === true
}

async function columnType(db: Kysely<unknown>, tableName: string, columnName: string): Promise<string | null> {
  const result = await sql<{ data_type: string }>`
    SELECT data_type
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ${tableName}
       AND column_name = ${columnName}
  `.execute(db)
  return result.rows[0]?.data_type ?? null
}

async function rowCount(db: Kysely<unknown>, tableName: string): Promise<number> {
  const result = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count FROM ${sql.table(tableName)}
  `.execute(db)
  return Number(result.rows[0]?.count ?? 0)
}

async function assertUpgradePreflight(db: Kysely<unknown>): Promise<void> {
  const hasEvents = await tableExists(db, EVENTS)
  const hasEffects = await tableExists(db, EFFECTS)
  if (!hasEvents || !hasEffects) {
    throw new Error('directory deprovision ledger hardening requires both scaffold tables from ' + 'zzzz20260724170000')
  }

  const provenancePresence = await Promise.all(
    REQUIRED_PROVENANCE_COLUMNS.map((column) => columnExists(db, EVENTS, column)),
  )
  const hardenedProvenancePresent = provenancePresence.every(Boolean)
  if (hardenedProvenancePresent) return

  const eventRows = await rowCount(db, EVENTS)
  const effectRows = await rowCount(db, EFFECTS)
  if (eventRows > 0 || effectRows > 0) {
    throw new Error(
      'directory deprovision ledger hardening aborted before DDL: the weak or partial ledger ' +
        `contains ${eventRows} event row(s) and ${effectRows} effect row(s), so link witness, ` +
        'policy, and globally-clear provenance cannot be reconstructed safely',
    )
  }
}

async function ensureUuidColumn(db: Kysely<unknown>, tableName: string, columnName: string): Promise<void> {
  const type = await columnType(db, tableName, columnName)
  if (type === 'uuid') return
  if (type !== 'text') {
    throw new Error(`directory deprovision ledger column drift: ${tableName}.${columnName} is ${type ?? 'missing'}`)
  }
  await sql`
    ALTER TABLE ${sql.table(tableName)}
    ALTER COLUMN ${sql.id(columnName)} TYPE uuid
    USING ${sql.id(columnName)}::uuid
  `.execute(db)
}

async function uniqueColumnSets(
  db: Kysely<unknown>,
  tableName: string,
): Promise<Array<{ name: string; columns: string[] }>> {
  const result = await sql<{ name: string; columns: string[] }>`
    SELECT constraint_row.conname AS name,
           array_agg(attribute.attname ORDER BY key_column.ordinality)::text[] AS columns
      FROM pg_constraint constraint_row
      JOIN pg_class table_rel ON table_rel.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
      JOIN unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
        ON TRUE
      JOIN pg_attribute attribute
        ON attribute.attrelid = table_rel.oid
       AND attribute.attnum = key_column.attnum
     WHERE namespace.nspname = current_schema()
       AND table_rel.relname = ${tableName}
       AND constraint_row.contype IN ('p', 'u')
     GROUP BY constraint_row.oid, constraint_row.conname
  `.execute(db)
  return result.rows
}

async function ensureUniqueColumns(
  db: Kysely<unknown>,
  tableName: string,
  constraintName: string,
  columns: string[],
  leaveOnDown = false,
): Promise<void> {
  const shapes = await uniqueColumnSets(db, tableName)
  const named = shapes.find((shape) => shape.name === constraintName)
  if (named && named.columns.join('\0') !== columns.join('\0')) {
    throw new Error(`directory deprovision ledger prerequisite drift: ${tableName}.${constraintName}`)
  }
  if (shapes.some((shape) => shape.columns.join('\0') === columns.join('\0'))) return

  await sql`
    ALTER TABLE ${sql.table(tableName)}
    ADD CONSTRAINT ${sql.id(constraintName)}
    UNIQUE (${sql.join(columns.map((column) => sql.id(column)))})
  `.execute(db)
  if (!leaveOnDown) {
    await sql`
      COMMENT ON CONSTRAINT ${sql.id(constraintName)} ON ${sql.table(tableName)}
      IS ${sql.lit(OWNER)}
    `.execute(db)
  }
}

async function constraintOwned(db: Kysely<unknown>, tableName: string, constraintName: string): Promise<boolean> {
  const result = await sql<{ owned: boolean }>`
    SELECT COALESCE(obj_description(constraint_row.oid, 'pg_constraint'), '') = ${OWNER} AS owned
      FROM pg_constraint constraint_row
      JOIN pg_class table_rel ON table_rel.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_rel.relname = ${tableName}
       AND constraint_row.conname = ${constraintName}
  `.execute(db)
  return result.rows[0]?.owned === true
}

async function replaceConstraint(
  db: Kysely<unknown>,
  tableName: string,
  constraintName: string,
  definition: string,
): Promise<void> {
  await sql`
    ALTER TABLE ${sql.table(tableName)}
    DROP CONSTRAINT IF EXISTS ${sql.id(constraintName)}
  `.execute(db)
  await sql`
    ALTER TABLE ${sql.table(tableName)}
    ADD CONSTRAINT ${sql.id(constraintName)} ${sql.raw(definition)}
  `.execute(db)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await assertUpgradePreflight(db)

  await ensureUniqueColumns(db, 'directory_integrations', 'uq_directory_integrations_id_org', ['id', 'org_id'], true)
  await ensureUniqueColumns(db, 'directory_accounts', 'uq_directory_accounts_id_integration', ['id', 'integration_id'])
  await ensureUniqueColumns(db, 'directory_sync_runs', 'uq_directory_sync_runs_id_integration', [
    'id',
    'integration_id',
  ])

  await ensureUuidColumn(db, EVENTS, 'integration_id')
  await ensureUuidColumn(db, EVENTS, 'directory_account_id')
  await ensureUuidColumn(db, EVENTS, 'run_id')

  await sql`
    ALTER TABLE directory_deprovision_events
      ADD COLUMN IF NOT EXISTS link_witness_account_id uuid,
      ADD COLUMN IF NOT EXISTS link_witness_local_user_id text,
      ADD COLUMN IF NOT EXISTS policy text,
      ADD COLUMN IF NOT EXISTS globally_clear boolean,
      ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
      ADD COLUMN IF NOT EXISTS resolved_by text,
      ADD COLUMN IF NOT EXISTS resolve_note text,
      ADD COLUMN IF NOT EXISTS restore_mode text
  `.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      ADD COLUMN IF NOT EXISTS reversed_by text
  `.execute(db)

  await sql`
    ALTER TABLE directory_deprovision_events
      ALTER COLUMN link_witness_account_id SET NOT NULL,
      ALTER COLUMN link_witness_local_user_id SET NOT NULL,
      ALTER COLUMN policy SET NOT NULL,
      ALTER COLUMN policy SET DEFAULT 'manual_review',
      ALTER COLUMN globally_clear SET NOT NULL,
      ALTER COLUMN globally_clear SET DEFAULT FALSE,
      ALTER COLUMN triggered_by SET NOT NULL,
      ALTER COLUMN status SET DEFAULT 'applied'
  `.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_effects
      ALTER COLUMN event_id SET NOT NULL,
      ALTER COLUMN status SET DEFAULT 'applied'
  `.execute(db)

  await replaceConstraint(db, EVENTS, 'ddev_event_origin_check', "CHECK (event_origin IN ('sync','admin_manual'))")
  await replaceConstraint(
    db,
    EVENTS,
    'ddev_run_id_by_origin_check',
    "CHECK ((event_origin = 'sync' AND run_id IS NOT NULL) OR " + "(event_origin = 'admin_manual' AND run_id IS NULL))",
  )
  await replaceConstraint(
    db,
    EVENTS,
    'ddev_policy_check',
    "CHECK (policy IN ('manual_review','disable_grant_only','mark_inactive'))",
  )
  await replaceConstraint(
    db,
    EVENTS,
    'ddev_status_check',
    "CHECK (status IN ('applied','fully_resolved','superseded'))",
  )
  await replaceConstraint(
    db,
    EVENTS,
    'ddev_witness_account_check',
    'CHECK (link_witness_account_id = directory_account_id)',
  )
  await replaceConstraint(db, EVENTS, 'ddev_witness_user_check', 'CHECK (link_witness_local_user_id = local_user_id)')
  await replaceConstraint(
    db,
    EVENTS,
    'ddev_restore_mode_check',
    "CHECK (restore_mode IS NULL OR restore_mode IN ('rehire','admin_force'))",
  )

  await replaceConstraint(
    db,
    EFFECTS,
    'ddef_effect_type_check',
    "CHECK (effect_type IN ('membership_changed','grant_changed','user_changed'))",
  )
  await replaceConstraint(db, EFFECTS, 'ddef_status_check', "CHECK (status IN ('applied','reversed','superseded'))")
  await replaceConstraint(
    db,
    EFFECTS,
    'ddef_org_id_by_type_check',
    "CHECK ((effect_type = 'membership_changed' AND org_id IS NOT NULL) OR " +
      "(effect_type IN ('grant_changed','user_changed') AND org_id IS NULL))",
  )
  await replaceConstraint(db, EFFECTS, 'ddef_event_effect_type_key', 'UNIQUE (event_id, effect_type)')

  await replaceConstraint(db, EVENTS, 'ddev_user_fk', 'FOREIGN KEY (local_user_id) REFERENCES users(id)')
  await replaceConstraint(
    db,
    EVENTS,
    'ddev_account_integration_fk',
    'FOREIGN KEY (directory_account_id, integration_id) ' + 'REFERENCES directory_accounts(id, integration_id)',
  )
  await replaceConstraint(
    db,
    EVENTS,
    'ddev_integration_org_fk',
    'FOREIGN KEY (integration_id, org_id) REFERENCES directory_integrations(id, org_id)',
  )
  await replaceConstraint(
    db,
    EVENTS,
    'ddev_run_integration_fk',
    'FOREIGN KEY (run_id, integration_id) REFERENCES directory_sync_runs(id, integration_id)',
  )
  await replaceConstraint(
    db,
    EFFECTS,
    'ddef_event_fk',
    'FOREIGN KEY (event_id) REFERENCES directory_deprovision_events(id) ON DELETE CASCADE',
  )

  await sql`
    CREATE OR REPLACE FUNCTION directory_deprovision_validate_event()
    RETURNS trigger AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM directory_account_links link
         WHERE link.directory_account_id = NEW.directory_account_id
           AND link.local_user_id = NEW.local_user_id
           AND link.link_status = 'linked'
      ) THEN
        RAISE EXCEPTION 'deprovision event requires a linked account/user at apply time';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM directory_accounts account
         WHERE account.id = NEW.directory_account_id
           AND account.integration_id = NEW.integration_id
      ) THEN
        RAISE EXCEPTION 'deprovision event account/integration mismatch';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM directory_integrations integration
         WHERE integration.id = NEW.integration_id
           AND integration.org_id = NEW.org_id
      ) THEN
        RAISE EXCEPTION 'deprovision event integration/org mismatch';
      END IF;

      IF NEW.event_origin = 'sync' AND NOT EXISTS (
        SELECT 1 FROM directory_sync_runs run
         WHERE run.id = NEW.run_id
           AND run.integration_id = NEW.integration_id
      ) THEN
        RAISE EXCEPTION 'deprovision sync event run/integration mismatch';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION directory_deprovision_validate_effect()
    RETURNS trigger AS $$
    DECLARE
      parent_org text;
      parent_user text;
      parent_generation bigint;
    BEGIN
      SELECT org_id, local_user_id, access_generation_at_apply
        INTO parent_org, parent_user, parent_generation
        FROM directory_deprovision_events
       WHERE id = NEW.event_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'deprovision effect has no parent event';
      END IF;
      IF NEW.local_user_id IS DISTINCT FROM parent_user THEN
        RAISE EXCEPTION 'deprovision effect user does not match parent event';
      END IF;
      IF NEW.access_generation_at_apply IS DISTINCT FROM parent_generation THEN
        RAISE EXCEPTION 'deprovision effect generation does not match parent event';
      END IF;
      IF NEW.effect_type = 'membership_changed'
         AND NEW.org_id IS DISTINCT FROM parent_org THEN
        RAISE EXCEPTION 'membership effect org does not match parent event';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION directory_deprovision_reject_identity_update()
    RETURNS trigger AS $$
    BEGIN
      IF TG_TABLE_NAME = 'directory_deprovision_events' THEN
        IF NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.integration_id IS DISTINCT FROM OLD.integration_id
           OR NEW.directory_account_id IS DISTINCT FROM OLD.directory_account_id
           OR NEW.local_user_id IS DISTINCT FROM OLD.local_user_id
           OR NEW.link_witness_account_id IS DISTINCT FROM OLD.link_witness_account_id
           OR NEW.link_witness_local_user_id IS DISTINCT FROM OLD.link_witness_local_user_id
           OR NEW.policy IS DISTINCT FROM OLD.policy
           OR NEW.globally_clear IS DISTINCT FROM OLD.globally_clear
           OR NEW.access_generation_at_apply IS DISTINCT FROM OLD.access_generation_at_apply
           OR NEW.event_origin IS DISTINCT FROM OLD.event_origin
           OR NEW.run_id IS DISTINCT FROM OLD.run_id
           OR NEW.triggered_by IS DISTINCT FROM OLD.triggered_by THEN
          RAISE EXCEPTION 'directory_deprovision_events identity fields are immutable';
        END IF;
      ELSIF TG_TABLE_NAME = 'directory_deprovision_effects' THEN
        IF NEW.event_id IS DISTINCT FROM OLD.event_id
           OR NEW.local_user_id IS DISTINCT FROM OLD.local_user_id
           OR NEW.effect_type IS DISTINCT FROM OLD.effect_type
           OR NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.before_active IS DISTINCT FROM OLD.before_active
           OR NEW.after_active IS DISTINCT FROM OLD.after_active
           OR NEW.access_generation_at_apply IS DISTINCT FROM OLD.access_generation_at_apply THEN
          RAISE EXCEPTION 'directory_deprovision_effects identity fields are immutable';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_deprovision_events_validate ON directory_deprovision_events`.execute(db)
  await sql`
    CREATE TRIGGER trg_deprovision_events_validate
    BEFORE INSERT ON directory_deprovision_events
    FOR EACH ROW EXECUTE FUNCTION directory_deprovision_validate_event()
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_deprovision_effects_validate ON directory_deprovision_effects`.execute(db)
  await sql`
    CREATE TRIGGER trg_deprovision_effects_validate
    BEFORE INSERT ON directory_deprovision_effects
    FOR EACH ROW EXECUTE FUNCTION directory_deprovision_validate_effect()
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_deprovision_events_immutable ON directory_deprovision_events`.execute(db)
  await sql`
    CREATE TRIGGER trg_deprovision_events_immutable
    BEFORE UPDATE ON directory_deprovision_events
    FOR EACH ROW EXECUTE FUNCTION directory_deprovision_reject_identity_update()
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_deprovision_effects_immutable ON directory_deprovision_effects`.execute(db)
  await sql`
    CREATE TRIGGER trg_deprovision_effects_immutable
    BEFORE UPDATE ON directory_deprovision_effects
    FOR EACH ROW EXECUTE FUNCTION directory_deprovision_reject_identity_update()
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_directory_deprovision_events_integration_status
    ON directory_deprovision_events(integration_id, status, created_at DESC)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_directory_deprovision_effects_event_status
    ON directory_deprovision_effects(event_id, status)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await tableExists(db, EVENTS)) || !(await tableExists(db, EFFECTS))) return

  const eventRows = await rowCount(db, EVENTS)
  const effectRows = await rowCount(db, EFFECTS)
  if (eventRows > 0 || effectRows > 0) {
    throw new Error(
      'directory deprovision ledger hardening down migration refused before DDL: ' +
        `${eventRows} event row(s) and ${effectRows} effect row(s) are durable evidence`,
    )
  }

  await sql`DROP TRIGGER IF EXISTS trg_deprovision_effects_validate ON directory_deprovision_effects`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_deprovision_events_validate ON directory_deprovision_events`.execute(db)
  await sql`DROP FUNCTION IF EXISTS directory_deprovision_validate_effect()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS directory_deprovision_validate_event()`.execute(db)

  for (const [tableName, constraintName] of [
    [EFFECTS, 'ddef_event_fk'],
    [EFFECTS, 'ddef_event_effect_type_key'],
    [EFFECTS, 'ddef_org_id_by_type_check'],
    [EFFECTS, 'ddef_status_check'],
    [EFFECTS, 'ddef_effect_type_check'],
    [EVENTS, 'ddev_run_integration_fk'],
    [EVENTS, 'ddev_integration_org_fk'],
    [EVENTS, 'ddev_account_integration_fk'],
    [EVENTS, 'ddev_user_fk'],
    [EVENTS, 'ddev_restore_mode_check'],
    [EVENTS, 'ddev_witness_user_check'],
    [EVENTS, 'ddev_witness_account_check'],
    [EVENTS, 'ddev_status_check'],
    [EVENTS, 'ddev_policy_check'],
    [EVENTS, 'ddev_run_id_by_origin_check'],
    [EVENTS, 'ddev_event_origin_check'],
  ] as const) {
    await sql`
      ALTER TABLE ${sql.table(tableName)}
      DROP CONSTRAINT IF EXISTS ${sql.id(constraintName)}
    `.execute(db)
  }

  await sql`DROP INDEX IF EXISTS idx_directory_deprovision_effects_event_status`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_directory_deprovision_events_integration_status`.execute(db)

  await sql`
    ALTER TABLE directory_deprovision_effects
      ALTER COLUMN event_id DROP NOT NULL,
      DROP COLUMN IF EXISTS reversed_by
  `.execute(db)
  await sql`
    ALTER TABLE directory_deprovision_events
      ALTER COLUMN triggered_by DROP NOT NULL,
      ALTER COLUMN status SET DEFAULT 'open',
      DROP COLUMN IF EXISTS restore_mode,
      DROP COLUMN IF EXISTS resolve_note,
      DROP COLUMN IF EXISTS resolved_by,
      DROP COLUMN IF EXISTS resolved_at,
      DROP COLUMN IF EXISTS globally_clear,
      DROP COLUMN IF EXISTS policy,
      DROP COLUMN IF EXISTS link_witness_local_user_id,
      DROP COLUMN IF EXISTS link_witness_account_id,
      ALTER COLUMN integration_id TYPE text USING integration_id::text,
      ALTER COLUMN directory_account_id TYPE text USING directory_account_id::text,
      ALTER COLUMN run_id TYPE text USING run_id::text
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION directory_deprovision_reject_identity_update()
    RETURNS trigger AS $$
    BEGIN
      IF TG_TABLE_NAME = 'directory_deprovision_events' THEN
        IF NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.integration_id IS DISTINCT FROM OLD.integration_id
           OR NEW.directory_account_id IS DISTINCT FROM OLD.directory_account_id
           OR NEW.local_user_id IS DISTINCT FROM OLD.local_user_id
           OR NEW.access_generation_at_apply IS DISTINCT FROM OLD.access_generation_at_apply
           OR NEW.event_origin IS DISTINCT FROM OLD.event_origin
           OR NEW.run_id IS DISTINCT FROM OLD.run_id THEN
          RAISE EXCEPTION 'directory_deprovision_events identity fields are immutable';
        END IF;
      ELSIF TG_TABLE_NAME = 'directory_deprovision_effects' THEN
        IF NEW.effect_type IS DISTINCT FROM OLD.effect_type
           OR NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.before_active IS DISTINCT FROM OLD.before_active
           OR NEW.after_active IS DISTINCT FROM OLD.after_active
           OR NEW.access_generation_at_apply IS DISTINCT FROM OLD.access_generation_at_apply
           OR NEW.local_user_id IS DISTINCT FROM OLD.local_user_id THEN
          RAISE EXCEPTION 'directory_deprovision_effects identity fields are immutable';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  for (const [tableName, constraintName] of [
    ['directory_accounts', 'uq_directory_accounts_id_integration'],
    ['directory_sync_runs', 'uq_directory_sync_runs_id_integration'],
  ] as const) {
    if (await constraintOwned(db, tableName, constraintName)) {
      await sql`
        ALTER TABLE ${sql.table(tableName)}
        DROP CONSTRAINT ${sql.id(constraintName)}
      `.execute(db)
    }
  }
}
