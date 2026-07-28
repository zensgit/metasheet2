/**
 * D3 Rev 4.3 ledger schema proof.
 *
 * Runs the weak scaffold and hardening migration in an isolated schema. The
 * suite proves upgrade/replay/down behavior as well as the account, run, link,
 * parent-effect, and immutability invariants against real Postgres.
 */
import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { up as weakLedgerUp } from '../../src/db/migrations/zzzz20260724170000_directory_deprovision_ledger_and_generation'
import {
  down as hardenedLedgerDown,
  up as hardenedLedgerUp,
} from '../../src/db/migrations/zzzz20260728100000_harden_directory_deprovision_ledger'

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

describeDb('directory deprovision ledger hardening (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let db: Kysely<unknown>

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `d3ledger_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    testPool = new Pool({
      connectionString: dbUrl,
      options: `-c search_path=${schema}`,
    })
    db = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: testPool }),
    })

    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)
    await sql`
      CREATE TABLE users (
        id text PRIMARY KEY,
        is_active boolean NOT NULL DEFAULT TRUE,
        updated_at timestamptz NOT NULL DEFAULT NOW()
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
    await weakLedgerUp(db)
  })

  afterEach(async () => {
    await db.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  async function columnDataType(table: string, column: string): Promise<string | null> {
    const result = await sql<{ data_type: string }>`
      SELECT data_type
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = ${table}
         AND column_name = ${column}
    `.execute(db)
    return result.rows[0]?.data_type ?? null
  }

  async function columnExists(table: string, column: string): Promise<boolean> {
    return (await columnDataType(table, column)) !== null
  }

  async function constraintDefinition(table: string, name: string): Promise<string | null> {
    const result = await sql<{ definition: string }>`
      SELECT pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint constraint_row
        JOIN pg_class table_rel ON table_rel.oid = constraint_row.conrelid
        JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
       WHERE namespace.nspname = current_schema()
         AND table_rel.relname = ${table}
         AND constraint_row.conname = ${name}
    `.execute(db)
    return result.rows[0]?.definition ?? null
  }

  async function seedAuthority() {
    const userId = `user-${randomUUID()}`
    const orgId = `org-${randomUUID()}`
    await sql`INSERT INTO users (id) VALUES (${userId})`.execute(db)
    const integration = await sql<{ id: string }>`
      INSERT INTO directory_integrations (org_id) VALUES (${orgId}) RETURNING id
    `.execute(db)
    const integrationId = integration.rows[0]!.id
    const account = await sql<{ id: string }>`
      INSERT INTO directory_accounts (integration_id) VALUES (${integrationId}) RETURNING id
    `.execute(db)
    const accountId = account.rows[0]!.id
    await sql`
      INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
      VALUES (${accountId}, ${userId}, 'linked')
    `.execute(db)
    const run = await sql<{ id: string }>`
      INSERT INTO directory_sync_runs (integration_id) VALUES (${integrationId}) RETURNING id
    `.execute(db)
    return {
      userId,
      orgId,
      integrationId,
      accountId,
      runId: run.rows[0]!.id,
    }
  }

  async function insertValidEvent(authority: Awaited<ReturnType<typeof seedAuthority>>) {
    const event = await sql<{ id: string }>`
      INSERT INTO directory_deprovision_events (
        org_id, integration_id, directory_account_id, local_user_id, run_id,
        triggered_by, event_origin, link_witness_account_id,
        link_witness_local_user_id, policy, globally_clear,
        access_generation_at_apply, status
      ) VALUES (
        ${authority.orgId}, ${authority.integrationId}, ${authority.accountId},
        ${authority.userId}, ${authority.runId}, 'test', 'sync',
        ${authority.accountId}, ${authority.userId}, 'mark_inactive', TRUE, 1, 'applied'
      )
      RETURNING id
    `.execute(db)
    return event.rows[0]!.id
  }

  it('upgrades the weak scaffold to the exact typed FK/check vocabulary', async () => {
    await hardenedLedgerUp(db)

    expect(await columnDataType('directory_deprovision_events', 'integration_id')).toBe('uuid')
    expect(await columnDataType('directory_deprovision_events', 'directory_account_id')).toBe('uuid')
    expect(await columnDataType('directory_deprovision_events', 'run_id')).toBe('uuid')
    expect(await columnExists('directory_deprovision_events', 'link_witness_account_id')).toBe(true)
    expect(await columnExists('directory_deprovision_events', 'globally_clear')).toBe(true)

    expect(await constraintDefinition('directory_deprovision_events', 'ddev_account_integration_fk')).toContain(
      'FOREIGN KEY (directory_account_id, integration_id)',
    )
    expect(await constraintDefinition('directory_deprovision_events', 'ddev_run_integration_fk')).toContain(
      'FOREIGN KEY (run_id, integration_id)',
    )
    expect(await constraintDefinition('directory_deprovision_effects', 'ddef_event_effect_type_key')).toContain(
      'UNIQUE (event_id, effect_type)',
    )
  })

  it('accepts a valid chain, replays with evidence, and refuses down before DDL', async () => {
    await hardenedLedgerUp(db)
    const authority = await seedAuthority()
    const eventId = await insertValidEvent(authority)

    for (const effect of [
      { type: 'membership_changed', orgId: authority.orgId },
      { type: 'grant_changed', orgId: null },
      { type: 'user_changed', orgId: null },
    ]) {
      await sql`
        INSERT INTO directory_deprovision_effects (
          event_id, local_user_id, org_id, effect_type, before_active,
          after_active, access_generation_at_apply, status
        ) VALUES (
          ${eventId}, ${authority.userId}, ${effect.orgId}, ${effect.type},
          TRUE, FALSE, 1, 'applied'
        )
      `.execute(db)
    }

    await hardenedLedgerUp(db)
    const counts = await sql<{ events: number; effects: number }>`
      SELECT
        (SELECT count(*)::int FROM directory_deprovision_events) AS events,
        (SELECT count(*)::int FROM directory_deprovision_effects) AS effects
    `.execute(db)
    expect(counts.rows[0]).toEqual({ events: 1, effects: 3 })

    await expect(hardenedLedgerDown(db)).rejects.toThrow(/refused before DDL/)
    expect(await columnDataType('directory_deprovision_events', 'integration_id')).toBe('uuid')
    expect(await constraintDefinition('directory_deprovision_events', 'ddev_account_integration_fk')).not.toBeNull()
  })

  it('rejects malformed account/link/run/effect chains and immutable witness changes', async () => {
    await hardenedLedgerUp(db)
    const a = await seedAuthority()
    const b = await seedAuthority()

    await expect(
      sql`
      INSERT INTO directory_deprovision_events (
        org_id, integration_id, directory_account_id, local_user_id, run_id,
        triggered_by, event_origin, link_witness_account_id,
        link_witness_local_user_id, policy, globally_clear,
        access_generation_at_apply, status
      ) VALUES (
        ${a.orgId}, ${a.integrationId}, ${a.accountId}, ${b.userId}, ${a.runId},
        'test', 'sync', ${a.accountId}, ${b.userId}, 'mark_inactive', TRUE, 1, 'applied'
      )
    `.execute(db),
    ).rejects.toThrow(/requires a linked account\/user/)

    await expect(
      sql`
      INSERT INTO directory_deprovision_events (
        org_id, integration_id, directory_account_id, local_user_id, run_id,
        triggered_by, event_origin, link_witness_account_id,
        link_witness_local_user_id, policy, globally_clear,
        access_generation_at_apply, status
      ) VALUES (
        ${a.orgId}, ${a.integrationId}, ${a.accountId}, ${a.userId}, ${b.runId},
        'test', 'sync', ${a.accountId}, ${a.userId}, 'mark_inactive', TRUE, 1, 'applied'
      )
    `.execute(db),
    ).rejects.toThrow()

    const eventId = await insertValidEvent(a)
    await expect(
      sql`
      INSERT INTO directory_deprovision_effects (
        event_id, local_user_id, org_id, effect_type, before_active,
        after_active, access_generation_at_apply, status
      ) VALUES (
        ${eventId}, ${a.userId}, ${b.orgId}, 'membership_changed',
        TRUE, FALSE, 1, 'applied'
      )
    `.execute(db),
    ).rejects.toThrow(/membership effect org/)

    await expect(
      sql`
      INSERT INTO directory_deprovision_effects (
        event_id, local_user_id, org_id, effect_type, before_active,
        after_active, access_generation_at_apply, status
      ) VALUES (
        ${eventId}, ${b.userId}, NULL, 'grant_changed',
        TRUE, FALSE, 1, 'applied'
      )
    `.execute(db),
    ).rejects.toThrow(/effect user/)

    await sql`
      INSERT INTO directory_deprovision_effects (
        event_id, local_user_id, org_id, effect_type, before_active,
        after_active, access_generation_at_apply, status
      ) VALUES (
        ${eventId}, ${a.userId}, ${a.orgId}, 'membership_changed',
        TRUE, FALSE, 1, 'applied'
      )
    `.execute(db)
    await expect(
      sql`
      INSERT INTO directory_deprovision_effects (
        event_id, local_user_id, org_id, effect_type, before_active,
        after_active, access_generation_at_apply, status
      ) VALUES (
        ${eventId}, ${a.userId}, ${a.orgId}, 'membership_changed',
        TRUE, FALSE, 1, 'applied'
      )
    `.execute(db),
    ).rejects.toThrow(/ddef_event_effect_type_key/)

    await expect(
      sql`
      UPDATE directory_deprovision_events
         SET link_witness_local_user_id = ${b.userId}
       WHERE id = ${eventId}
    `.execute(db),
    ).rejects.toThrow(/identity fields are immutable/)
  })

  it('keeps historical witness stable while the live link is unbound and rebound', async () => {
    await hardenedLedgerUp(db)
    const authority = await seedAuthority()
    const eventId = await insertValidEvent(authority)

    await sql`
      UPDATE directory_account_links
         SET local_user_id = NULL, link_status = 'unlinked'
       WHERE directory_account_id = ${authority.accountId}
    `.execute(db)
    await sql`
      UPDATE directory_account_links
         SET local_user_id = ${authority.userId}, link_status = 'linked'
       WHERE directory_account_id = ${authority.accountId}
    `.execute(db)

    const event = await sql<{
      directory_account_id: string
      local_user_id: string
      link_witness_account_id: string
      link_witness_local_user_id: string
    }>`
      SELECT directory_account_id, local_user_id,
             link_witness_account_id, link_witness_local_user_id
        FROM directory_deprovision_events
       WHERE id = ${eventId}
    `.execute(db)
    expect(event.rows[0]).toEqual({
      directory_account_id: authority.accountId,
      local_user_id: authority.userId,
      link_witness_account_id: authority.accountId,
      link_witness_local_user_id: authority.userId,
    })
  })

  it('fails before DDL when the weak scaffold already contains unmodelled evidence', async () => {
    await sql`
      INSERT INTO directory_deprovision_events (
        org_id, integration_id, directory_account_id, local_user_id,
        triggered_by, event_origin, access_generation_at_apply, status
      ) VALUES ('org-old', 'not-a-uuid', 'not-a-uuid', 'user-old',
                'legacy', 'sync', 0, 'open')
    `.execute(db)

    await expect(hardenedLedgerUp(db)).rejects.toThrow(/aborted before DDL/)
    expect(await columnDataType('directory_deprovision_events', 'integration_id')).toBe('text')
    expect(await columnExists('directory_deprovision_events', 'policy')).toBe(false)
    expect(await constraintDefinition('directory_accounts', 'uq_directory_accounts_id_integration')).toBeNull()
  })

  it('fails closed on a same-named prerequisite UNIQUE with the wrong column shape', async () => {
    await sql`
      ALTER TABLE directory_accounts
      ADD CONSTRAINT uq_directory_accounts_id_integration UNIQUE (id, provider)
    `.execute(db)

    await expect(hardenedLedgerUp(db)).rejects.toThrow(/prerequisite drift/)
    expect(await columnDataType('directory_deprovision_events', 'integration_id')).toBe('text')
    expect(await columnExists('directory_deprovision_events', 'policy')).toBe(false)
  })

  it('down restores the weak shape and removes only parent UNIQUEs it owns', async () => {
    await sql`
      ALTER TABLE directory_accounts
      ADD CONSTRAINT preexisting_accounts_id_integration UNIQUE (id, integration_id)
    `.execute(db)
    await hardenedLedgerUp(db)
    await hardenedLedgerDown(db)

    expect(await columnDataType('directory_deprovision_events', 'integration_id')).toBe('text')
    expect(await columnExists('directory_deprovision_events', 'policy')).toBe(false)
    expect(await constraintDefinition('directory_accounts', 'preexisting_accounts_id_integration')).not.toBeNull()
    expect(await constraintDefinition('directory_sync_runs', 'uq_directory_sync_runs_id_integration')).toBeNull()
    expect(await constraintDefinition('directory_integrations', 'uq_directory_integrations_id_org')).not.toBeNull()
  })
})
