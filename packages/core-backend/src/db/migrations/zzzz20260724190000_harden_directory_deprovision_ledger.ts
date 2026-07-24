import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

/**
 * D3 completion — bring the deprovision ledger up to the ratified §5.2 shape
 * (`dingtalk-deprovision-reactivation-and-evidence-chain-design-20260723.md`, Rev 4.2).
 *
 * `zzzz20260724170000` landed the tables but not the enforcement the lock marks **mandatory**:
 * no composite FKs (and none of the three prerequisite UNIQUE keys they need), no witness
 * columns, no policy / globally_clear provenance, no CHECKs, no BEFORE INSERT live-link
 * validation, and `effects.event_id` nullable with no FK — so an effect row could be orphaned or
 * attached to another person's event. The lock's §5.2.1 table is the authority: the DB, not the
 * application, rejects a malformed evidence chain.
 *
 * Safe to run destructively-typed (`ALTER COLUMN ... TYPE uuid`) because the forward writer was
 * never wired to these tables (`deprovision-ledger.ts` had no importer on `main`) and
 * `DIRECTORY_DEPROVISION_ENABLED` has never been on: both tables are empty everywhere. The
 * migration still guards each step so a re-run (or a partially-applied environment) is a no-op.
 *
 * Deliberate deviation, recorded for owner ratification: the lock names the child table
 * `directory_deprovision_event_effects`; `zzzz20260724170000` created it as
 * `directory_deprovision_effects` and D7's API/UI already read that name. Renaming buys no
 * semantics, so the landed name is kept and the deviation is documented rather than silently
 * normalised.
 */

const EFFECT_TYPES = ['membership_changed', 'grant_changed', 'user_changed'] as const

export async function up(db: Kysely<unknown>): Promise<void> {
  const hasEvents = await checkTableExists(db, 'directory_deprovision_events')
  const hasEffects = await checkTableExists(db, 'directory_deprovision_effects')
  if (!hasEvents || !hasEffects) return

  // ---------------------------------------------------------------------------------------
  // 0. Prerequisite UNIQUE keys (§5.2 "迁移必须先有，否则复合 FK 无法建").
  // ---------------------------------------------------------------------------------------
  await sql`
    ALTER TABLE directory_accounts
    ADD CONSTRAINT directory_accounts_id_integration_key UNIQUE (id, integration_id)
  `.execute(db).catch(swallowDuplicateObject)
  await sql`
    ALTER TABLE directory_integrations
    ADD CONSTRAINT directory_integrations_id_org_key UNIQUE (id, org_id)
  `.execute(db).catch(swallowDuplicateObject)
  await sql`
    ALTER TABLE directory_sync_runs
    ADD CONSTRAINT directory_sync_runs_id_integration_key UNIQUE (id, integration_id)
  `.execute(db).catch(swallowDuplicateObject)

  // ---------------------------------------------------------------------------------------
  // 1. Column types + the provenance columns §5.2 requires.
  //    `integration_id` / `directory_account_id` / `run_id` land as `text`; the composite FKs
  //    below reference `uuid` columns, so they must be converted first.
  // ---------------------------------------------------------------------------------------
  // Fail closed rather than deleting: the new NOT NULL provenance columns cannot be backfilled
  // for a pre-existing row without knowing its policy / globally_clear / witness, and this ledger
  // IS the evidence chain — a migration must never silently discard it. Empty everywhere by
  // construction (the writer had no importer; the flag has never been on), so a non-empty table
  // means something unmodelled happened and an operator has to look.
  await assertLedgerEmpty(db)

  await sql`
    ALTER TABLE directory_deprovision_events
      ALTER COLUMN integration_id TYPE uuid USING integration_id::uuid,
      ALTER COLUMN directory_account_id TYPE uuid USING directory_account_id::uuid,
      ALTER COLUMN run_id TYPE uuid USING run_id::uuid
  `.execute(db)

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

  // Tables are empty (see file header), so NOT NULL needs no backfill.
  await sql`
    ALTER TABLE directory_deprovision_events
      ALTER COLUMN link_witness_account_id SET NOT NULL,
      ALTER COLUMN link_witness_local_user_id SET NOT NULL,
      ALTER COLUMN policy SET NOT NULL,
      ALTER COLUMN globally_clear SET NOT NULL,
      ALTER COLUMN triggered_by SET NOT NULL
  `.execute(db)

  await sql`
    ALTER TABLE directory_deprovision_effects
      ALTER COLUMN event_id SET NOT NULL
  `.execute(db)

  // ---------------------------------------------------------------------------------------
  // 2. CHECK constraints (§5.2).
  // ---------------------------------------------------------------------------------------
  await addCheck(db, 'directory_deprovision_events', 'ddev_event_origin_check', `
    event_origin IN ('sync','admin_manual')
  `)
  await addCheck(db, 'directory_deprovision_events', 'ddev_run_id_by_origin_check', `
    (event_origin = 'sync' AND run_id IS NOT NULL)
    OR (event_origin = 'admin_manual' AND run_id IS NULL)
  `)
  await addCheck(db, 'directory_deprovision_events', 'ddev_policy_check', `
    policy IN ('manual_review','disable_grant_only','mark_inactive')
  `)
  await addCheck(db, 'directory_deprovision_events', 'ddev_status_check', `
    status IN ('applied','fully_resolved','superseded')
  `)
  // "CHECK 只防自相矛盾，trigger 才验 live link" — these two only pin the witness to the event's
  // own subject; the BEFORE INSERT trigger below is what proves the link existed at the time.
  await addCheck(db, 'directory_deprovision_events', 'ddev_witness_account_check', `
    link_witness_account_id = directory_account_id
  `)
  await addCheck(db, 'directory_deprovision_events', 'ddev_witness_user_check', `
    link_witness_local_user_id = local_user_id
  `)
  await addCheck(db, 'directory_deprovision_events', 'ddev_restore_mode_check', `
    restore_mode IS NULL OR restore_mode IN ('rehire','admin_force')
  `)

  await addCheck(db, 'directory_deprovision_effects', 'ddef_effect_type_check', `
    effect_type IN ('membership_changed','grant_changed','user_changed')
  `)
  await addCheck(db, 'directory_deprovision_effects', 'ddef_status_check', `
    status IN ('applied','reversed','superseded')
  `)
  await addCheck(db, 'directory_deprovision_effects', 'ddef_org_id_by_type_check', `
    (effect_type = 'membership_changed' AND org_id IS NOT NULL)
    OR (effect_type IN ('grant_changed','user_changed') AND org_id IS NULL)
  `)

  await sql`
    ALTER TABLE directory_deprovision_effects
    ADD CONSTRAINT ddef_event_effect_type_key UNIQUE (event_id, effect_type)
  `.execute(db).catch(swallowDuplicateObject)

  // ---------------------------------------------------------------------------------------
  // 3. Foreign keys — including the composite ones that pin a run to its own integration and an
  //    account to its own integration. §5.2 explicitly forbids an FK to the *current*
  //    `directory_account_links` row (unbind NULLs `local_user_id`, which would make historical
  //    events permanently block a legitimate unbind/rebind).
  // ---------------------------------------------------------------------------------------
  await addForeignKey(db, 'directory_deprovision_events', 'ddev_user_fk', `
    FOREIGN KEY (local_user_id) REFERENCES users (id)
  `)
  await addForeignKey(db, 'directory_deprovision_events', 'ddev_account_integration_fk', `
    FOREIGN KEY (directory_account_id, integration_id)
    REFERENCES directory_accounts (id, integration_id)
  `)
  await addForeignKey(db, 'directory_deprovision_events', 'ddev_integration_org_fk', `
    FOREIGN KEY (integration_id, org_id)
    REFERENCES directory_integrations (id, org_id)
  `)
  await addForeignKey(db, 'directory_deprovision_events', 'ddev_run_integration_fk', `
    FOREIGN KEY (run_id, integration_id)
    REFERENCES directory_sync_runs (id, integration_id)
  `)
  await addForeignKey(db, 'directory_deprovision_effects', 'ddef_event_fk', `
    FOREIGN KEY (event_id) REFERENCES directory_deprovision_events (id) ON DELETE CASCADE
  `)

  // ---------------------------------------------------------------------------------------
  // 4. Mandatory BEFORE INSERT validation (§5.2.1). The CHECKs above cannot see other tables;
  //    this is what refuses an event whose account/user were not actually linked at the time.
  // ---------------------------------------------------------------------------------------
  await sql`
    CREATE OR REPLACE FUNCTION directory_deprovision_validate_event()
    RETURNS trigger AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM directory_account_links l
         WHERE l.directory_account_id = NEW.directory_account_id
           AND l.local_user_id = NEW.local_user_id
           AND l.link_status = 'linked'
      ) THEN
        RAISE EXCEPTION 'directory_deprovision_events requires a linked account/user at apply time (account=%, user=%)',
          NEW.directory_account_id, NEW.local_user_id;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM directory_accounts a
         WHERE a.id = NEW.directory_account_id
           AND a.integration_id = NEW.integration_id
      ) THEN
        RAISE EXCEPTION 'directory_deprovision_events account % does not belong to integration %',
          NEW.directory_account_id, NEW.integration_id;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM directory_integrations i
         WHERE i.id = NEW.integration_id
           AND i.org_id = NEW.org_id
      ) THEN
        RAISE EXCEPTION 'directory_deprovision_events integration % does not belong to org %',
          NEW.integration_id, NEW.org_id;
      END IF;

      IF NEW.event_origin = 'sync' AND NOT EXISTS (
        SELECT 1 FROM directory_sync_runs r
         WHERE r.id = NEW.run_id
           AND r.integration_id = NEW.integration_id
      ) THEN
        RAISE EXCEPTION 'directory_deprovision_events sync event requires a run of the same integration (run=%, integration=%)',
          NEW.run_id, NEW.integration_id;
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

  await sql`
    CREATE OR REPLACE FUNCTION directory_deprovision_validate_effect()
    RETURNS trigger AS $$
    DECLARE
      parent_org text;
    BEGIN
      SELECT org_id INTO parent_org
        FROM directory_deprovision_events
       WHERE id = NEW.event_id;

      IF parent_org IS NULL THEN
        RAISE EXCEPTION 'directory_deprovision_effects has no parent event %', NEW.event_id;
      END IF;

      IF NEW.effect_type = 'membership_changed' AND NEW.org_id IS DISTINCT FROM parent_org THEN
        RAISE EXCEPTION 'membership_changed effect org % must equal parent event org %',
          NEW.org_id, parent_org;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trg_deprovision_effects_validate ON directory_deprovision_effects`.execute(db)
  await sql`
    CREATE TRIGGER trg_deprovision_effects_validate
    BEFORE INSERT ON directory_deprovision_effects
    FOR EACH ROW EXECUTE FUNCTION directory_deprovision_validate_effect()
  `.execute(db)

  // ---------------------------------------------------------------------------------------
  // 5. Immutability — `zzzz20260724170000`'s trigger covered a subset of the identity columns.
  //    §5.2.1 requires the provenance columns added above to be frozen too; only the resolve
  //    columns (events) and status/reversed_* (effects) may ever change after INSERT.
  // ---------------------------------------------------------------------------------------
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
        IF NEW.effect_type IS DISTINCT FROM OLD.effect_type
           OR NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.before_active IS DISTINCT FROM OLD.before_active
           OR NEW.after_active IS DISTINCT FROM OLD.after_active
           OR NEW.access_generation_at_apply IS DISTINCT FROM OLD.access_generation_at_apply
           OR NEW.local_user_id IS DISTINCT FROM OLD.local_user_id
           OR NEW.event_id IS DISTINCT FROM OLD.event_id THEN
          RAISE EXCEPTION 'directory_deprovision_effects identity fields are immutable';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_deprovision_effects_validate ON directory_deprovision_effects`.execute(db)
    .catch(() => undefined)
  await sql`DROP TRIGGER IF EXISTS trg_deprovision_events_validate ON directory_deprovision_events`.execute(db)
    .catch(() => undefined)
  await sql`DROP FUNCTION IF EXISTS directory_deprovision_validate_effect()`.execute(db).catch(() => undefined)
  await sql`DROP FUNCTION IF EXISTS directory_deprovision_validate_event()`.execute(db).catch(() => undefined)

  for (const [table, constraint] of [
    ['directory_deprovision_effects', 'ddef_event_fk'],
    ['directory_deprovision_effects', 'ddef_event_effect_type_key'],
    ['directory_deprovision_effects', 'ddef_org_id_by_type_check'],
    ['directory_deprovision_effects', 'ddef_status_check'],
    ['directory_deprovision_effects', 'ddef_effect_type_check'],
    ['directory_deprovision_events', 'ddev_run_integration_fk'],
    ['directory_deprovision_events', 'ddev_integration_org_fk'],
    ['directory_deprovision_events', 'ddev_account_integration_fk'],
    ['directory_deprovision_events', 'ddev_user_fk'],
    ['directory_deprovision_events', 'ddev_restore_mode_check'],
    ['directory_deprovision_events', 'ddev_witness_user_check'],
    ['directory_deprovision_events', 'ddev_witness_account_check'],
    ['directory_deprovision_events', 'ddev_status_check'],
    ['directory_deprovision_events', 'ddev_policy_check'],
    ['directory_deprovision_events', 'ddev_run_id_by_origin_check'],
    ['directory_deprovision_events', 'ddev_event_origin_check'],
  ] as const) {
    await sql`ALTER TABLE ${sql.raw(table)} DROP CONSTRAINT IF EXISTS ${sql.raw(constraint)}`
      .execute(db)
      .catch(() => undefined)
  }

  await sql`
    ALTER TABLE directory_deprovision_events
      DROP COLUMN IF EXISTS restore_mode,
      DROP COLUMN IF EXISTS resolve_note,
      DROP COLUMN IF EXISTS resolved_by,
      DROP COLUMN IF EXISTS resolved_at,
      DROP COLUMN IF EXISTS globally_clear,
      DROP COLUMN IF EXISTS policy,
      DROP COLUMN IF EXISTS link_witness_local_user_id,
      DROP COLUMN IF EXISTS link_witness_account_id
  `.execute(db).catch(() => undefined)

  for (const [table, constraint] of [
    ['directory_sync_runs', 'directory_sync_runs_id_integration_key'],
    ['directory_integrations', 'directory_integrations_id_org_key'],
    ['directory_accounts', 'directory_accounts_id_integration_key'],
  ] as const) {
    await sql`ALTER TABLE ${sql.raw(table)} DROP CONSTRAINT IF EXISTS ${sql.raw(constraint)}`
      .execute(db)
      .catch(() => undefined)
  }
}

/** Exported so the real-DB suite asserts against the same list the migration writes. */
export const __deprovisionLedgerEffectTypes = EFFECT_TYPES

async function assertLedgerEmpty(db: Kysely<unknown>): Promise<void> {
  for (const table of ['directory_deprovision_events', 'directory_deprovision_effects']) {
    const result = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.raw(table)}
    `.execute(db)
    const rows = Number(result.rows[0]?.n ?? 0)
    if (rows > 0) {
      throw new Error(
        `${table} already holds ${rows} row(s); zzzz20260724190000 hardens the ledger to the `
        + 'Rev 4.2 §5.2 shape and cannot backfill link_witness_* / policy / globally_clear for '
        + 'pre-existing evidence. Export the rows and decide their provenance before migrating.',
      )
    }
  }
}

async function addCheck(db: Kysely<unknown>, table: string, name: string, body: string): Promise<void> {
  await sql`
    ALTER TABLE ${sql.raw(table)}
    ADD CONSTRAINT ${sql.raw(name)} CHECK (${sql.raw(body.trim())})
  `.execute(db).catch(swallowDuplicateObject)
}

async function addForeignKey(db: Kysely<unknown>, table: string, name: string, body: string): Promise<void> {
  await sql`
    ALTER TABLE ${sql.raw(table)}
    ADD CONSTRAINT ${sql.raw(name)} ${sql.raw(body.trim())}
  `.execute(db).catch(swallowDuplicateObject)
}

/**
 * Re-running the migration must be a no-op, but a genuine failure (missing prerequisite index,
 * a row that violates the constraint) must still surface — only "already exists" is swallowed.
 */
function swallowDuplicateObject(error: unknown): void {
  const code = (error as { code?: string } | null)?.code
  if (code === '42710' || code === '42P07') return
  throw error
}
