/**
 * Deprovision effect provider witness — schema proof (real PostgreSQL, isolated schema).
 *
 * Each case builds a random schema, creates the minimal authority tables, applies the ledger
 * migrations in name order and then exercises the provider migration directly through its
 * exported `up` / `down`. Expected SQLSTATEs follow PostgreSQL's execution order on this table:
 * BEFORE ROW triggers run in trigger-name order (`…provider_validate` before `…validate` on
 * INSERT; `…immutable` before `…provider_immutable` on UPDATE), CHECK constraints are evaluated
 * after every BEFORE trigger. A case that targets the CHECK therefore uses a row the triggers
 * let through, and the CHECK's `btrim(provider) <> ''` arm is proved with the validating trigger
 * disabled inside a savepoint.
 *
 * Invariants:
 *  - provider on a grant_changed row equals the parent event integration's provider, NULL read
 *    as 'dingtalk'; a non-grant row never carries a provider; provider is immutable;
 *  - `up` is idempotent, survives an out-of-order replay of the two later shared-trigger
 *    migrations, refuses a column of a different shape, holds its lock bound and restores the
 *    session timeouts; `down` refuses while a non-default provider exists, removes only its own
 *    objects, and is a no-op without the column;
 *  - the ledger writer records the provider when the column exists and the legacy INSERT shape
 *    remains valid before and after the migration.
 */
import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { up as weakLedgerUp } from '../../src/db/migrations/zzzz20260724170000_directory_deprovision_ledger_and_generation'
import { up as hardenedLedgerUp } from '../../src/db/migrations/zzzz20260728100000_harden_directory_deprovision_ledger'
import { up as grantRowCreatedUp } from '../../src/db/migrations/zzzz20260808090000_deprovision_effect_grant_row_created'
import { up as compensationStatusUp } from '../../src/db/migrations/zzzz20260810100000_deprovision_effect_compensation_status'
import {
  __deprovisionEffectProviderObjects as objects,
  down as providerDown,
  up as providerUp,
} from '../../src/db/migrations/zzzz20261107010000_deprovision_effect_provider'
import {
  LEGACY_DEPROVISION_EFFECT_INSERT_SQL,
  applyDirectoryDeprovisionCandidate,
  probeDeprovisionEffectProviderColumn,
  type DirectoryTransactionClient,
} from '../../src/directory/deprovision-ledger'

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip
// Anti-skip-green sentinel: a DB-expected lane must have a database, never a silent skip.
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
itIfExpectDb('requires a real DB', () => expect(dbUrl).toBeTruthy())

const PROVIDER_MISMATCH = /deprovision effect provider does not match the event integration/
const PROVIDER_IMMUTABLE = /deprovision effect provider is immutable/

type PgError = Error & { code?: string; constraint?: string }

async function sqlstate(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise
  } catch (error) {
    return error as PgError
  }
  throw new Error('expected the statement to be rejected')
}

describeDb('deprovision effect provider witness (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let db: Kysely<unknown>

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `rv1provider_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    testPool = new Pool({
      connectionString: dbUrl,
      options: `-c search_path=${schema}`,
    })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })

    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
    await sql`
      CREATE TABLE users (
        id text PRIMARY KEY,
        is_active boolean NOT NULL DEFAULT TRUE,
        activation_status text NOT NULL DEFAULT 'activated',
        access_generation bigint NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )
    `.execute(db)
    // D21 (Y5a): the writer's lockCandidateUser bumps the subject authorization version row before the
    // users FOR UPDATE; the isolated schema carries the table in its migrated shape (zzzz20261106110500).
    await sql`
      CREATE TABLE subject_authorization_versions (
        subject_id text PRIMARY KEY,
        version bigint NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `.execute(db)
    await sql`
      CREATE TABLE user_orgs (
        user_id text NOT NULL REFERENCES users(id),
        org_id text NOT NULL,
        is_active boolean NOT NULL DEFAULT TRUE,
        PRIMARY KEY (user_id, org_id)
      )
    `.execute(db)
    await sql`
      CREATE TABLE user_external_auth_grants (
        provider text NOT NULL,
        local_user_id text NOT NULL REFERENCES users(id),
        enabled boolean NOT NULL DEFAULT TRUE,
        granted_by text,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (provider, local_user_id)
      )
    `.execute(db)
    await sql`
      CREATE TABLE directory_integrations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id text NOT NULL,
        provider text NOT NULL DEFAULT 'dingtalk',
        CONSTRAINT uq_directory_integrations_id_org UNIQUE (id, org_id)
      )
    `.execute(db)
    await sql`
      CREATE TABLE directory_accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        integration_id uuid NOT NULL REFERENCES directory_integrations(id),
        provider text NOT NULL DEFAULT 'dingtalk',
        is_active boolean NOT NULL DEFAULT TRUE
      )
    `.execute(db)
    await sql`
      CREATE TABLE directory_account_links (
        directory_account_id uuid NOT NULL REFERENCES directory_accounts(id),
        local_user_id text REFERENCES users(id),
        link_status text NOT NULL
      )
    `.execute(db)
    await sql`
      CREATE TABLE directory_sync_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        integration_id uuid NOT NULL REFERENCES directory_integrations(id),
        status text NOT NULL DEFAULT 'success'
      )
    `.execute(db)
    // D21 (Y5a): the subject authorization version row the deprovision writer bumps as its first protocol statement
    // (lockCandidateUser, src/directory/deprovision-ledger.ts; table from zzzz20261106110500, no triggers in this
    // private schema).
    await sql`
      CREATE TABLE subject_authorization_versions (
        subject_id text PRIMARY KEY,
        version bigint NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )
    `.execute(db)
    await weakLedgerUp(db)
    await hardenedLedgerUp(db)
    await grantRowCreatedUp(db)
    await compensationStatusUp(db)
  })

  afterEach(async () => {
    await db.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  // The migrator runs every pending migration inside one transaction; `up` relies on that for
  // its transaction-local timeouts, so the proof applies it the same way.
  const upInTransaction = () => db.transaction().execute((trx) => providerUp(trx))
  const downInTransaction = () => db.transaction().execute((trx) => providerDown(trx))

  async function columnShape(): Promise<{ data_type: string; is_nullable: string; column_default: string | null } | null> {
    const result = await sql<{ data_type: string; is_nullable: string; column_default: string | null }>`
      SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'directory_deprovision_effects'
         AND column_name = 'provider'
    `.execute(db)
    return result.rows[0] ?? null
  }

  async function triggerState(name: string): Promise<{ proname: string; tgenabled: string } | null> {
    const result = await sql<{ proname: string; tgenabled: string }>`
      SELECT function_row.proname::text AS proname, trigger_row.tgenabled::text AS tgenabled
        FROM pg_trigger trigger_row
        JOIN pg_class table_rel ON table_rel.oid = trigger_row.tgrelid
        JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
        JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
       WHERE namespace.nspname = current_schema()
         AND table_rel.relname = 'directory_deprovision_effects'
         AND trigger_row.tgname = ${name}
         AND NOT trigger_row.tgisinternal
    `.execute(db)
    return result.rows[0] ?? null
  }

  async function functionExists(name: string): Promise<boolean> {
    const result = await sql<{ present: boolean }>`
      SELECT EXISTS (
        SELECT 1
          FROM pg_proc function_row
          JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
         WHERE namespace.nspname = current_schema()
           AND function_row.proname = ${name}
      ) AS present
    `.execute(db)
    return result.rows[0]?.present === true
  }

  async function constraintValidated(name: string): Promise<boolean | null> {
    const result = await sql<{ convalidated: boolean }>`
      SELECT constraint_row.convalidated
        FROM pg_constraint constraint_row
        JOIN pg_class table_rel ON table_rel.oid = constraint_row.conrelid
        JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
       WHERE namespace.nspname = current_schema()
         AND table_rel.relname = 'directory_deprovision_effects'
         AND constraint_row.conname = ${name}
    `.execute(db)
    return result.rows[0]?.convalidated ?? null
  }

  async function seedAuthority(provider = 'dingtalk', options: { orgId?: string } = {}) {
    const userId = `user-${randomUUID()}`
    const orgId = options.orgId ?? `org-${randomUUID()}`
    await sql`INSERT INTO users (id) VALUES (${userId})`.execute(db)
    await sql`INSERT INTO user_orgs (user_id, org_id) VALUES (${userId}, ${orgId})`.execute(db)
    const integration = await sql<{ id: string }>`
      INSERT INTO directory_integrations (org_id, provider) VALUES (${orgId}, ${provider}) RETURNING id
    `.execute(db)
    const integrationId = integration.rows[0]!.id
    const account = await sql<{ id: string }>`
      INSERT INTO directory_accounts (integration_id, provider, is_active)
      VALUES (${integrationId}, ${provider}, FALSE) RETURNING id
    `.execute(db)
    const accountId = account.rows[0]!.id
    await sql`
      INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
      VALUES (${accountId}, ${userId}, 'linked')
    `.execute(db)
    const run = await sql<{ id: string }>`
      INSERT INTO directory_sync_runs (integration_id) VALUES (${integrationId}) RETURNING id
    `.execute(db)
    return { userId, orgId, integrationId, accountId, runId: run.rows[0]!.id, provider }
  }

  async function insertEvent(authority: Awaited<ReturnType<typeof seedAuthority>>, generation = 1) {
    const event = await sql<{ id: string }>`
      INSERT INTO directory_deprovision_events (
        org_id, integration_id, directory_account_id, local_user_id, run_id,
        triggered_by, event_origin, link_witness_account_id,
        link_witness_local_user_id, policy, globally_clear,
        access_generation_at_apply, status
      ) VALUES (
        ${authority.orgId}, ${authority.integrationId}, ${authority.accountId},
        ${authority.userId}, ${authority.runId}, 'test', 'sync',
        ${authority.accountId}, ${authority.userId}, 'mark_inactive', TRUE, ${generation}, 'applied'
      )
      RETURNING id
    `.execute(db)
    return event.rows[0]!.id
  }

  function insertEffect(
    eventId: string,
    userId: string,
    effectType: string,
    orgId: string | null,
    provider: string | null,
    generation = 1,
  ) {
    return sql`
      INSERT INTO directory_deprovision_effects (
        event_id, local_user_id, org_id, effect_type, before_active, after_active,
        grant_row_created, access_generation_at_apply, status, provider
      ) VALUES (
        ${eventId}, ${userId}, ${orgId}, ${effectType}, TRUE, FALSE, FALSE, ${generation}, 'applied', ${provider}
      )
    `.execute(db)
  }

  async function readProvider(eventId: string, effectType: string): Promise<string | null | undefined> {
    const result = await sql<{ provider: string | null }>`
      SELECT (to_jsonb(effect) ->> 'provider') AS provider
        FROM directory_deprovision_effects effect
       WHERE effect.event_id = ${eventId} AND effect.effect_type = ${effectType}
    `.execute(db)
    return result.rows[0]?.provider
  }

  /** The provider invariants as one function, so the replay case can assert them again. */
  async function assertProviderInvariants() {
    const dingtalk = await seedAuthority('dingtalk')
    const wecom = await seedAuthority('wecom')

    // Trigger: a provider that is not the event integration's is refused (P0001, fixed text).
    const mismatch = await sqlstate(insertEffect(await insertEvent(dingtalk), dingtalk.userId, 'grant_changed', null, 'wecom'))
    expect(mismatch.code).toBe('P0001')
    expect(mismatch.message).toMatch(PROVIDER_MISMATCH)

    // Trigger, COALESCE arm: NULL reads as dingtalk, so NULL on a wecom event is refused.
    const nullOnWecom = await sqlstate(insertEffect(await insertEvent(wecom), wecom.userId, 'grant_changed', null, null))
    expect(nullOnWecom.code).toBe('P0001')
    expect(nullOnWecom.message).toMatch(PROVIDER_MISMATCH)

    // Trigger: NULL on a dingtalk event is the pre-column shape and is accepted.
    const legacyEvent = await insertEvent(dingtalk)
    await insertEffect(legacyEvent, dingtalk.userId, 'grant_changed', null, null)
    expect(await readProvider(legacyEvent, 'grant_changed')).toBeNull()

    // Trigger: an explicit matching provider is accepted on both integrations.
    const explicitEvent = await insertEvent(dingtalk)
    await insertEffect(explicitEvent, dingtalk.userId, 'grant_changed', null, 'dingtalk')
    const wecomEvent = await insertEvent(wecom)
    await insertEffect(wecomEvent, wecom.userId, 'grant_changed', null, 'wecom')
    expect(await readProvider(wecomEvent, 'grant_changed')).toBe('wecom')

    // Trigger: the witness is immutable, including NULL → value (P0001, fixed text).
    for (const [eventId, next] of [[explicitEvent, 'wecom'], [legacyEvent, 'dingtalk'], [explicitEvent, null]] as const) {
      const immutable = await sqlstate(
        sql`UPDATE directory_deprovision_effects SET provider = ${next} WHERE event_id = ${eventId}`.execute(db),
      )
      expect(immutable.code).toBe('P0001')
      expect(immutable.message).toMatch(PROVIDER_IMMUTABLE)
    }
    // …while an update that leaves provider alone still passes this trigger (status is not
    // pinned by the shared identity trigger).
    await sql`UPDATE directory_deprovision_effects SET status = 'superseded' WHERE event_id = ${explicitEvent}`.execute(db)

    // CHECK: a non-grant row carrying a provider that MATCHES the integration is let through by
    // the trigger (it compares grant rows only) and refused by the CHECK (23514, named).
    const checkOnMembership = await sqlstate(
      insertEffect(await insertEvent(dingtalk), dingtalk.userId, 'membership_changed', dingtalk.orgId, 'dingtalk'),
    )
    expect(checkOnMembership.code).toBe('23514')
    expect(checkOnMembership.constraint).toBe(objects.check)
    const checkOnUser = await sqlstate(insertEffect(await insertEvent(wecom), wecom.userId, 'user_changed', null, 'wecom'))
    expect(checkOnUser.code).toBe('23514')
    expect(checkOnUser.constraint).toBe(objects.check)

    // Empty provider on a grant row: the trigger runs first (COALESCE('', 'dingtalk') = '' is not
    // the integration's provider), so the SQLSTATE is P0001, not the CHECK's.
    const emptyProvider = await sqlstate(insertEffect(await insertEvent(dingtalk), dingtalk.userId, 'grant_changed', null, ''))
    expect(emptyProvider.code).toBe('P0001')
    expect(emptyProvider.message).toMatch(PROVIDER_MISMATCH)

    // CHECK in isolation: with the validating trigger disabled inside a savepoint, the blank
    // provider reaches the CHECK and is refused there; the trigger is enabled again afterwards.
    const blankEvent = await insertEvent(dingtalk)
    await db.transaction().execute(async (trx) => {
      await sql`SAVEPOINT without_provider_trigger`.execute(trx)
      await sql.raw(`ALTER TABLE directory_deprovision_effects DISABLE TRIGGER ${objects.validateTrigger}`).execute(trx)
      const blank = await sqlstate(
        sql`
          INSERT INTO directory_deprovision_effects (
            event_id, local_user_id, org_id, effect_type, before_active, after_active,
            grant_row_created, access_generation_at_apply, status, provider
          ) VALUES (${blankEvent}, ${dingtalk.userId}, NULL, 'grant_changed', TRUE, FALSE, FALSE, 1, 'applied', '  ')
        `.execute(trx),
      )
      expect(blank.code).toBe('23514')
      expect(blank.constraint).toBe(objects.check)
      await sql`ROLLBACK TO SAVEPOINT without_provider_trigger`.execute(trx)
    })
    expect((await triggerState(objects.validateTrigger))?.tgenabled).toBe('O')

    // Regression: the shared trigger's guards still hold beside the dedicated ones.
    const creationEvent = await insertEvent(dingtalk)
    await sql`
      INSERT INTO directory_deprovision_effects (
        event_id, local_user_id, org_id, effect_type, before_active, after_active,
        grant_row_created, access_generation_at_apply, status, provider
      ) VALUES (${creationEvent}, ${dingtalk.userId}, NULL, 'grant_changed', FALSE, FALSE, TRUE, 1, 'applied', 'dingtalk')
    `.execute(db)
    await expect(
      sql`UPDATE directory_deprovision_effects SET grant_row_created = FALSE WHERE event_id = ${creationEvent}`.execute(db),
    ).rejects.toThrow(/identity fields are immutable/)
    const compensatedEvent = await insertEvent(dingtalk)
    await sql`
      INSERT INTO directory_deprovision_effects (
        event_id, local_user_id, org_id, effect_type, before_active, after_active,
        grant_row_created, access_generation_at_apply, status, reversed_at, reversed_by,
        compensation_note, provider
      ) VALUES (${compensatedEvent}, ${dingtalk.userId}, NULL, 'grant_changed', FALSE, FALSE, TRUE, 1,
                'compensated', NOW(), 'admin-test', 'owner verified cleanup', 'dingtalk')
    `.execute(db)
    await expect(
      sql`UPDATE directory_deprovision_effects SET compensation_note = 'tampered' WHERE event_id = ${compensatedEvent}`.execute(db),
    ).rejects.toThrow(/compensated deprovision effect evidence is immutable/)
  }

  it('provider is validated against the event integration, scoped to grant rows, and immutable', async () => {
    await upInTransaction()
    expect(await columnShape()).toEqual({ data_type: 'text', is_nullable: 'YES', column_default: null })
    expect(await constraintValidated(objects.check)).toBe(true)
    expect(await triggerState(objects.validateTrigger)).toEqual({ proname: objects.validateFunction, tgenabled: 'O' })
    expect(await triggerState(objects.immutableTrigger)).toEqual({ proname: objects.immutableFunction, tgenabled: 'O' })
    await assertProviderInvariants()
  })

  it('up twice, then the later shared-trigger migrations replayed in name order, keeps every guard', async () => {
    await upInTransaction()
    await upInTransaction()
    // Out-of-order replay: both later migrations re-issue the shared trigger function. The
    // dedicated objects are untouched by them, and the compensation arm is back once both ran.
    await grantRowCreatedUp(db)
    await compensationStatusUp(db)
    expect(await columnShape()).toEqual({ data_type: 'text', is_nullable: 'YES', column_default: null })
    expect(await constraintValidated(objects.check)).toBe(true)
    expect(await triggerState(objects.validateTrigger)).toEqual({ proname: objects.validateFunction, tgenabled: 'O' })
    expect(await triggerState(objects.immutableTrigger)).toEqual({ proname: objects.immutableFunction, tgenabled: 'O' })
    await assertProviderInvariants()
  })

  it('down refuses while a non-default provider exists, then removes only its own objects', async () => {
    await upInTransaction()
    const wecom = await seedAuthority('wecom')
    const wecomEvent = await insertEvent(wecom)
    await insertEffect(wecomEvent, wecom.userId, 'grant_changed', null, 'wecom')
    const dingtalk = await seedAuthority('dingtalk')
    await insertEffect(await insertEvent(dingtalk), dingtalk.userId, 'grant_changed', null, 'dingtalk')
    await insertEffect(await insertEvent(dingtalk), dingtalk.userId, 'grant_changed', null, null)

    await expect(downInTransaction()).rejects.toThrow(/refusing to drop the deprovision effect provider column/)
    expect(await columnShape()).not.toBeNull()

    await sql`DELETE FROM directory_deprovision_events WHERE id = ${wecomEvent}`.execute(db)
    await downInTransaction()
    expect(await columnShape()).toBeNull()
    expect(await constraintValidated(objects.check)).toBeNull()
    expect(await triggerState(objects.validateTrigger)).toBeNull()
    expect(await triggerState(objects.immutableTrigger)).toBeNull()
    expect(await functionExists(objects.validateFunction)).toBe(false)
    expect(await functionExists(objects.immutableFunction)).toBe(false)
    // The shared objects created by the hardening migration are still there.
    expect(await triggerState('trg_deprovision_effects_validate')).toEqual({ proname: 'directory_deprovision_validate_effect', tgenabled: 'O' })
    expect(await triggerState('trg_deprovision_effects_immutable')).toEqual({ proname: 'directory_deprovision_reject_identity_update', tgenabled: 'O' })
    expect(await functionExists('directory_deprovision_reject_identity_update')).toBe(true)
    expect(await functionExists('directory_deprovision_validate_effect')).toBe(true)
    // Rows written through the column survive the drop, minus the witness.
    const remaining = await sql<{ n: string }>`SELECT count(*)::text AS n FROM directory_deprovision_effects`.execute(db)
    expect(remaining.rows[0]?.n).toBe('2')
    // And down is idempotent.
    await downInTransaction()
  })

  it('down on a ledger without the column is a no-op', async () => {
    expect(await columnShape()).toBeNull()
    await downInTransaction()
    expect(await columnShape()).toBeNull()
    expect(await triggerState('trg_deprovision_effects_validate')).not.toBeNull()
  })

  it('a pre-existing provider column of another shape is refused as drift, without touching it', async () => {
    await sql`ALTER TABLE directory_deprovision_effects ADD COLUMN provider integer`.execute(db)
    const error = await sqlstate(upInTransaction())
    expect(error.message).toMatch(/deprovision effect provider column drift/)
    expect(error.message).not.toMatch(/integer/)
    expect(await columnShape()).toMatchObject({ data_type: 'integer' })
    expect(await constraintValidated(objects.check)).toBeNull()
    expect(await triggerState(objects.validateTrigger)).toBeNull()

    await sql`ALTER TABLE directory_deprovision_effects DROP COLUMN provider`.execute(db)
    await sql`ALTER TABLE directory_deprovision_effects ADD COLUMN provider text NOT NULL DEFAULT 'dingtalk'`.execute(db)
    const notNullable = await sqlstate(upInTransaction())
    expect(notNullable.message).toMatch(/deprovision effect provider column drift/)
  })

  it('with another connection holding ACCESS SHARE on the effects table, up fails with 55P03 inside its lock bound instead of waiting', async () => {
    const holder = await adminPool.connect()
    let released = false
    const release = async () => {
      if (released) return
      released = true
      try {
        await holder.query('ROLLBACK')
      } finally {
        holder.release()
      }
    }
    try {
      await holder.query('BEGIN')
      await holder.query(`SET LOCAL search_path = "${schema}"`)
      await holder.query('SELECT 1 FROM directory_deprovision_effects LIMIT 1')
      const startedAt = Date.now()
      const outcome = await Promise.race([
        sqlstate(upInTransaction()),
        new Promise<PgError>((resolve) => setTimeout(() => resolve(Object.assign(new Error('up did not fail within the test bound'), { code: 'TEST_TIMEOUT' })), 20_000)),
      ])
      expect(outcome.code).toBe('55P03')
      expect(Date.now() - startedAt).toBeLessThan(20_000)
    } finally {
      await release()
    }
    expect(await columnShape()).toBeNull()
  }, 40_000)

  it('up restores the lock and statement timeouts it found', async () => {
    await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('lock_timeout', '7s', true), set_config('statement_timeout', '9min', true)`.execute(trx)
      await providerUp(trx)
      const after = await sql<{ lock_timeout: string; statement_timeout: string }>`
        SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout
      `.execute(trx)
      expect(after.rows[0]).toEqual({ lock_timeout: '7s', statement_timeout: '9min' })
    })
    expect(await columnShape()).not.toBeNull()
  })

  async function withLedgerClient<T>(callback: (client: DirectoryTransactionClient, raw: PoolClient) => Promise<T>): Promise<T> {
    const raw = await testPool.connect()
    try {
      await raw.query('BEGIN')
      const client: DirectoryTransactionClient = {
        query: async (statement, params) => {
          const result = await raw.query(statement, params)
          return { rows: result.rows as Array<Record<string, unknown>> }
        },
      }
      const value = await callback(client, raw)
      await raw.query('COMMIT')
      return value
    } catch (error) {
      await raw.query('ROLLBACK')
      throw error
    } finally {
      raw.release()
    }
  }

  async function applyThroughWriter(authority: Awaited<ReturnType<typeof seedAuthority>>) {
    return withLedgerClient((client) =>
      applyDirectoryDeprovisionCandidate(client, {
        localUserId: authority.userId,
        orgId: authority.orgId,
        integrationId: authority.integrationId,
        directoryAccountId: authority.accountId,
        runId: authority.runId,
        triggeredBy: 'test',
        policy: 'mark_inactive',
        write: true,
        ledgerScope: {},
      }),
    )
  }

  it('before the migration the probe answers absent, the legacy INSERT succeeds and the witness reads NULL', async () => {
    const authority = await seedAuthority('dingtalk')
    const eventId = await insertEvent(authority)
    await withLedgerClient(async (client, raw) => {
      expect(await probeDeprovisionEffectProviderColumn(client, {})).toBe(false)
      await raw.query(LEGACY_DEPROVISION_EFFECT_INSERT_SQL, [eventId, authority.userId, null, 'grant_changed', true, false, false, 1])
    })
    expect(await readProvider(eventId, 'grant_changed')).toBeNull()
  })

  it('after the migration the writer records the integration provider on the grant effect only, and the legacy INSERT still succeeds', async () => {
    await upInTransaction()
    await withLedgerClient(async (client) => {
      expect(await probeDeprovisionEffectProviderColumn(client, {})).toBe(true)
    })

    const dingtalk = await seedAuthority('dingtalk')
    await sql`INSERT INTO user_external_auth_grants (provider, local_user_id, enabled) VALUES ('dingtalk', ${dingtalk.userId}, TRUE)`.execute(db)
    const applied = await applyThroughWriter(dingtalk)
    expect(applied.applied).toBe(true)
    expect(applied.plan.effects.map((effect) => effect.type).sort()).toEqual(['grant_changed', 'membership_changed', 'user_changed'])
    expect(await readProvider(applied.eventId!, 'grant_changed')).toBe('dingtalk')
    expect(await readProvider(applied.eventId!, 'membership_changed')).toBeNull()
    expect(await readProvider(applied.eventId!, 'user_changed')).toBeNull()

    // Registry variant: the provider written is the source integration's.
    const wecom = await seedAuthority('wecom')
    await sql`INSERT INTO user_external_auth_grants (provider, local_user_id, enabled) VALUES ('wecom', ${wecom.userId}, TRUE)`.execute(db)
    await sql`INSERT INTO user_external_auth_grants (provider, local_user_id, enabled) VALUES ('dingtalk', ${wecom.userId}, TRUE)`.execute(db)
    const wecomApplied = await applyThroughWriter(wecom)
    expect(await readProvider(wecomApplied.eventId!, 'grant_changed')).toBe('wecom')
    const grants = await sql<{ provider: string; enabled: boolean }>`
      SELECT provider, enabled FROM user_external_auth_grants WHERE local_user_id = ${wecom.userId} ORDER BY provider
    `.execute(db)
    expect(grants.rows).toEqual([
      { provider: 'dingtalk', enabled: true },
      { provider: 'wecom', enabled: false },
    ])

    // The pre-column INSERT shape remains valid against the migrated ledger.
    const legacy = await seedAuthority('dingtalk')
    const legacyEvent = await insertEvent(legacy)
    await withLedgerClient(async (_client, raw) => {
      await raw.query(LEGACY_DEPROVISION_EFFECT_INSERT_SQL, [legacyEvent, legacy.userId, null, 'grant_changed', true, false, false, 1])
      await raw.query(LEGACY_DEPROVISION_EFFECT_INSERT_SQL, [legacyEvent, legacy.userId, legacy.orgId, 'membership_changed', true, false, false, 1])
    })
    expect(await readProvider(legacyEvent, 'grant_changed')).toBeNull()
    expect(await readProvider(legacyEvent, 'membership_changed')).toBeNull()
  })
})
