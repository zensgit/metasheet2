/**
 * Deprovision effect provider witness — restore, compensation and the writer against the real,
 * migrated schema (real PostgreSQL).
 *
 * Invariants:
 *  - restore reverses the grant row of the provider the effect witnesses; a NULL witness (every
 *    row written before the provider column existed) reverses the default provider row; a
 *    non-default witness reverses that provider's row and leaves the default provider's row as
 *    it was;
 *  - compensation deletes the orphan deny row of the witnessed provider only, and its
 *    already-compensated residual check reads the same provider;
 *  - the writer records the source integration's provider on the grant effect, writes the
 *    matching grant row, and leaves every other provider's grant row untouched.
 *
 * Fixtures are built per case with explicit org ids and a timestamp prefix; integrations of a
 * non-default provider are inserted with SQL because no product writer creates them.
 */
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import * as database from '../../src/db/pg'
import { query, transaction } from '../../src/db/pg'
import { checkCardConnectionBeforeDispatch, legacyGrantAllowsPublicForm } from '../../src/auth/dingtalk-legacy-resource-scope'
import { checkOrdinaryDingTalkSource } from '../../src/auth/dingtalk-login-source'
import { insertConnectionLoginScope } from '../../src/auth/strict-login-grant-store'
import {
  compensateSupersededDenyGrant,
  listDeprovisionEffects,
  restoreDeprovisionEvent,
} from '../../src/directory/deprovision-evidence-api'
import { applyDirectoryDeprovisionCandidate } from '../../src/directory/deprovision-ledger'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
// Anti-skip-green sentinel: a DB-expected lane must have a database, never a silent skip.
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
itIfExpectDb('requires a real DB', () => expect(process.env.DATABASE_URL).toBeTruthy())

const PREFIX = `rv1-evidence-${Date.now()}`

type Seeded = {
  accountId: string
  integrationId: string
  orgId: string
  provider: string
  runId: string
  userId: string
}

async function cleanup(): Promise<void> {
  await query(`DELETE FROM directory_deprovision_events WHERE local_user_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM user_external_auth_grants WHERE local_user_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM directory_integrations WHERE org_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}-%`])
}

async function seed(options: {
  provider?: string
  accountActive?: boolean
  userActive?: boolean
  membershipActive?: boolean
  generation?: number
} = {}): Promise<Seeded> {
  const provider = options.provider ?? 'dingtalk'
  const orgId = `${PREFIX}-org-${randomUUID()}`
  const userId = `${PREFIX}-user-${randomUUID()}`
  const corpId = `${PREFIX}-corp-${provider}-${randomUUID()}`
  const integration = await query<{ id: string }>(
    `INSERT INTO directory_integrations (
       name, corp_id, org_id, provider, status, default_deprovision_policy
     ) VALUES ($1, $2, $3, $4, 'active', 'mark_inactive')
     RETURNING id::text AS id`,
    [`${PREFIX}-integration-${randomUUID()}`, corpId, orgId, provider],
  )
  const integrationId = integration.rows[0].id
  const run = await query<{ id: string }>(
    `INSERT INTO directory_sync_runs (
       integration_id, status, triggered_by, trigger_source
     ) VALUES ($1::uuid, 'success', 'test:rv1-evidence', 'manual')
     RETURNING id::text AS id`,
    [integrationId],
  )
  await query(
    `INSERT INTO users (
       id, password_hash, is_active, activation_status, access_generation
     ) VALUES ($1, 'x', $2, 'activated', $3)`,
    [userId, options.userActive ?? true, options.generation ?? 3],
  )
  await query(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)`,
    [userId, orgId, options.membershipActive ?? true],
  )
  const account = await query<{ id: string }>(
    `INSERT INTO directory_accounts (
       integration_id, provider, corp_id, external_user_id, external_key, name, is_active
     ) VALUES ($1::uuid, $2, $3, $4, $5, 'RV1 Evidence', $6)
     RETURNING id::text AS id`,
    [
      integrationId,
      provider,
      corpId,
      `${PREFIX}-external-${randomUUID()}`,
      `${provider}:${PREFIX}:${randomUUID()}`,
      options.accountActive ?? true,
    ],
  )
  const accountId = account.rows[0].id
  await query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
     VALUES ($1::uuid, $2, 'linked')`,
    [accountId, userId],
  )
  return { accountId, integrationId, orgId, provider, runId: run.rows[0].id, userId }
}

async function insertEvent(
  seeded: Seeded,
  options: { status?: 'applied' | 'superseded'; globallyClear?: boolean; generation?: number } = {},
): Promise<string> {
  const event = await query<{ id: string }>(
    `INSERT INTO directory_deprovision_events (
       org_id, integration_id, directory_account_id, local_user_id, run_id, triggered_by,
       event_origin, link_witness_account_id, link_witness_local_user_id,
       policy, globally_clear, access_generation_at_apply, status
     ) VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid, 'test', 'sync', $3::uuid, $4,
               'mark_inactive', $6, $7, $8)
     RETURNING id::text AS id`,
    [
      seeded.orgId,
      seeded.integrationId,
      seeded.accountId,
      seeded.userId,
      seeded.runId,
      options.globallyClear ?? true,
      options.generation ?? 3,
      options.status ?? 'applied',
    ],
  )
  return event.rows[0].id
}

/**
 * A grant effect row. `provider: null` is written WITHOUT the column, i.e. exactly the shape of
 * every row the ledger holds from before the migration.
 */
async function insertGrantEffect(
  seeded: Seeded,
  eventId: string,
  options: {
    provider: string | null
    creation?: boolean
    status?: 'applied' | 'superseded' | 'compensated'
    generation?: number
  },
): Promise<string> {
  const creation = options.creation === true
  const status = options.status ?? 'applied'
  const columns = [
    'event_id', 'local_user_id', 'org_id', 'effect_type', 'before_active', 'after_active',
    'grant_row_created', 'access_generation_at_apply', 'status',
  ]
  const values = [
    eventId, seeded.userId, null, 'grant_changed', !creation, false, creation,
    options.generation ?? 3, status,
  ]
  if (status === 'compensated') {
    columns.push('reversed_at', 'reversed_by', 'compensation_note')
    values.push(new Date(), 'admin-test', 'owner verified cleanup')
  }
  if (options.provider !== null) {
    columns.push('provider')
    values.push(options.provider)
  }
  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ')
  const effect = await query<{ id: string }>(
    `INSERT INTO directory_deprovision_effects (${columns.join(', ')})
     VALUES (${placeholders})
     RETURNING id::text AS id`,
    values,
  )
  return effect.rows[0].id
}

async function insertGrantRow(
  userId: string,
  provider: string,
  enabled: boolean,
  grantedBy = 'system:directory-deprovision',
): Promise<void> {
  await query(
    `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by)
     VALUES ($1, $2, $3, $4)`,
    [provider, userId, enabled, grantedBy],
  )
}

async function grantRows(userId: string): Promise<Array<{ provider: string; enabled: boolean; granted_by: string | null }>> {
  const result = await query<{ provider: string; enabled: boolean; granted_by: string | null }>(
    `SELECT provider, enabled, granted_by
       FROM user_external_auth_grants
      WHERE local_user_id = $1
      ORDER BY provider`,
    [userId],
  )
  return result.rows
}

async function effectStatuses(eventId: string): Promise<Array<{ effect_type: string; status: string; provider: string | null }>> {
  const result = await query<{ effect_type: string; status: string; provider: string | null }>(
    `SELECT effect_type, status, provider
       FROM directory_deprovision_effects
      WHERE event_id = $1::uuid
      ORDER BY effect_type`,
    [eventId],
  )
  return result.rows
}

describeIfDatabase('deprovision effect provider witness (restore, compensation, writer — real DB)', () => {
  beforeEach(cleanup)
  afterAll(cleanup)

  describe('restore reads a NULL witness as the default provider', () => {
    it('flips the default provider row back for a pre-column flip effect', async () => {
      const seeded = await seed()
      await insertGrantRow(seeded.userId, 'dingtalk', false)
      await insertGrantRow(seeded.userId, 'wecom', false, 'someone-else')
      const eventId = await insertEvent(seeded)
      await insertGrantEffect(seeded, eventId, { provider: null })

      const listed = await listDeprovisionEffects(eventId)
      expect(listed.map((row) => [row.effect_type, row.provider, row.login_grant_provider])).toEqual([
        ['grant_changed', null, 'dingtalk'],
      ])

      const result = await restoreDeprovisionEvent({ eventId, mode: 'rehire', adminUserId: 'admin-test' })
      expect(result.effectsReversed).toEqual(['grant_changed'])
      expect(await grantRows(seeded.userId)).toEqual([
        { provider: 'dingtalk', enabled: true, granted_by: 'restore:admin-test' },
        { provider: 'wecom', enabled: false, granted_by: 'someone-else' },
      ])
      expect(await effectStatuses(eventId)).toEqual([{ effect_type: 'grant_changed', status: 'reversed', provider: null }])
    })

    it('deletes the default provider deny row for a pre-column creation effect', async () => {
      const seeded = await seed()
      await insertGrantRow(seeded.userId, 'dingtalk', false)
      await insertGrantRow(seeded.userId, 'wecom', false, 'someone-else')
      const eventId = await insertEvent(seeded)
      await insertGrantEffect(seeded, eventId, { provider: null, creation: true })

      await restoreDeprovisionEvent({ eventId, mode: 'rehire', adminUserId: 'admin-test' })
      expect(await grantRows(seeded.userId)).toEqual([
        { provider: 'wecom', enabled: false, granted_by: 'someone-else' },
      ])
      expect(await effectStatuses(eventId)).toEqual([{ effect_type: 'grant_changed', status: 'reversed', provider: null }])
    })

    it('a NULL witness whose default provider row is already enabled is drift, not a match on another row', async () => {
      const seeded = await seed()
      await insertGrantRow(seeded.userId, 'dingtalk', true, 'someone-re-granted-it')
      await insertGrantRow(seeded.userId, 'wecom', false)
      const eventId = await insertEvent(seeded)
      await insertGrantEffect(seeded, eventId, { provider: null })

      await expect(
        restoreDeprovisionEvent({ eventId, mode: 'rehire', adminUserId: 'admin-test' }),
      ).rejects.toMatchObject({ code: 'DRIFT_CONFLICT' })
      expect(await grantRows(seeded.userId)).toEqual([
        { provider: 'dingtalk', enabled: true, granted_by: 'someone-re-granted-it' },
        { provider: 'wecom', enabled: false, granted_by: 'system:directory-deprovision' },
      ])
      expect(await effectStatuses(eventId)).toEqual([{ effect_type: 'grant_changed', status: 'applied', provider: null }])
    })
  })

  describe('restore reverses the witnessed provider row only (non-default integration provider)', () => {
    it('a wecom flip effect re-enables the wecom row and leaves the dingtalk row untouched', async () => {
      const seeded = await seed({ provider: 'wecom' })
      await insertGrantRow(seeded.userId, 'wecom', false)
      await insertGrantRow(seeded.userId, 'dingtalk', false, 'someone-else')
      const eventId = await insertEvent(seeded)
      await insertGrantEffect(seeded, eventId, { provider: 'wecom' })

      const listed = await listDeprovisionEffects(eventId)
      expect(listed.map((row) => [row.provider, row.login_grant_provider])).toEqual([['wecom', 'wecom']])

      const result = await restoreDeprovisionEvent({ eventId, mode: 'rehire', adminUserId: 'admin-test' })
      expect(result.effectsReversed).toEqual(['grant_changed'])
      expect(await grantRows(seeded.userId)).toEqual([
        { provider: 'dingtalk', enabled: false, granted_by: 'someone-else' },
        { provider: 'wecom', enabled: true, granted_by: 'restore:admin-test' },
      ])
    })

    it('a wecom creation effect deletes the wecom deny row and leaves the dingtalk deny row', async () => {
      const seeded = await seed({ provider: 'wecom' })
      await insertGrantRow(seeded.userId, 'wecom', false)
      await insertGrantRow(seeded.userId, 'dingtalk', false)
      const eventId = await insertEvent(seeded)
      await insertGrantEffect(seeded, eventId, { provider: 'wecom', creation: true })

      await restoreDeprovisionEvent({ eventId, mode: 'admin_force', adminUserId: 'admin-test', confirm: true, note: 'owner approved restore' })
      expect(await grantRows(seeded.userId)).toEqual([
        { provider: 'dingtalk', enabled: false, granted_by: 'system:directory-deprovision' },
      ])
    })

    it('a wecom witness with the wecom row missing is drift even though a dingtalk row would match', async () => {
      const seeded = await seed({ provider: 'wecom' })
      await insertGrantRow(seeded.userId, 'dingtalk', false)
      const eventId = await insertEvent(seeded)
      await insertGrantEffect(seeded, eventId, { provider: 'wecom', creation: true })

      await expect(
        restoreDeprovisionEvent({ eventId, mode: 'rehire', adminUserId: 'admin-test' }),
      ).rejects.toMatchObject({ code: 'DRIFT_CONFLICT' })
      expect(await grantRows(seeded.userId)).toEqual([
        { provider: 'dingtalk', enabled: false, granted_by: 'system:directory-deprovision' },
      ])
    })
  })

  describe('provider-scoped ledger reversals', () => {
    it('refuses forced restoration while a cutover owns the exact source lock', async () => {
      const seeded = await seed()
      await insertGrantRow(seeded.userId, 'dingtalk', false)
      const eventId = await insertEvent(seeded)
      await insertGrantEffect(seeded, eventId, { provider: 'dingtalk' })
      const transition = new Client({ connectionString: process.env.DATABASE_URL })
      await transition.connect()
      try {
        await transition.query('BEGIN')
        await insertConnectionLoginScope(transition, { connectionId: seeded.integrationId, commandId: randomUUID() })
        await expect(restoreDeprovisionEvent({ eventId, mode: 'admin_force', adminUserId: 'admin-test', confirm: true, note: 'verified source restore' }))
          .rejects.toMatchObject({ code: 'DRIFT_CONFLICT' })
        expect(await effectStatuses(eventId)).toEqual([{ effect_type: 'grant_changed', status: 'applied', provider: 'dingtalk' }])
        expect((await grantRows(seeded.userId)).map(grant => grant.enabled)).toEqual([false])
      } finally {
        await transition.query('ROLLBACK')
        await transition.end()
      }
    })

    for (const action of ['rehire', 'admin_force', 'compensate'] as const) {
      it(`${action} reverses the historical effect in strict scope without granting access`, async () => {
        const seeded = await seed()
        const creation = action === 'compensate'
        const status = creation ? 'superseded' : 'applied'
        await insertGrantRow(seeded.userId, 'dingtalk', false)
        const eventId = await insertEvent(seeded, { status })
        await insertGrantEffect(seeded, eventId, { provider: 'dingtalk', status, creation })
        const application = randomUUID()
        const integration = await query<{ corp_id: string }>(
          "UPDATE directory_integrations SET config=jsonb_build_object('appKey',$2::text) WHERE id=$1 RETURNING corp_id",
          [seeded.integrationId, application],
        )
        const corp = integration.rows[0].corp_id
        await query('UPDATE directory_accounts SET corp_id=$2 WHERE id=$1', [seeded.accountId, corp])
        const source = { connectionId: seeded.integrationId, orgId: seeded.orgId, corpId: corp,
          appKey: application, configuredCorp: corp, explicit: true, strict: false }

        const connection = new Client({ connectionString: process.env.DATABASE_URL })
        await connection.connect()
        try {
          // Use the actual permanent-scope table and guards inside one rolled-back fixture transaction.
          // Only the transaction owner is substituted: the service and readers execute their own SQL.
          await connection.query('BEGIN ISOLATION LEVEL READ COMMITTED')
          await expect(checkOrdinaryDingTalkSource(connection, source)).resolves.toBeUndefined()
          await insertConnectionLoginScope(connection, { connectionId: seeded.integrationId, commandId: randomUUID() })
          const bound = vi.spyOn(database, 'transaction').mockImplementationOnce(handler => handler(connection))
          try {
            if (creation) {
              const result = await compensateSupersededDenyGrant({ eventId, adminUserId: 'admin-test', confirm: true, note: 'verified source cleanup' })
              expect(result.grantRow).toBe('deleted')
            } else {
              const result = await restoreDeprovisionEvent({ eventId, mode: action, adminUserId: 'admin-test', confirm: true, note: 'verified source restore' })
              expect(result.effectsReversed).toEqual(['grant_changed'])
            }
          } finally { bound.mockRestore() }
          const grants = await connection.query("SELECT enabled FROM user_external_auth_grants WHERE provider='dingtalk' AND local_user_id=$1", [seeded.userId])
          expect(grants.rows).toEqual(creation ? [] : [{ enabled: true }])
          const effects = await connection.query('SELECT status FROM directory_deprovision_effects WHERE event_id=$1', [eventId])
          expect(effects.rows).toEqual([{ status: creation ? 'compensated' : 'reversed' }])
          await expect(checkOrdinaryDingTalkSource(connection, source)).rejects.toMatchObject({ statusCode: 403 })
          const read = connection.query.bind(connection)
          await expect(legacyGrantAllowsPublicForm(read, seeded.userId, false, true)).resolves.toBe(false)
          await expect(checkCardConnectionBeforeDispatch(read, seeded.integrationId, true)).resolves.toBe('refused')
          expect((await connection.query('SELECT id FROM user_sessions WHERE user_id=$1', [seeded.userId])).rows).toEqual([])
          expect((await connection.query('SELECT 1 FROM user_external_identity_login_grants WHERE local_user_id=$1', [seeded.userId])).rows).toEqual([])
        } finally {
          await connection.query('ROLLBACK')
          await connection.end()
        }
      })

      it(`${action} refuses a drifted source without changing the ledger or the grant`, async () => {
        const seeded = await seed()
        const creation = action === 'compensate'
        const status = creation ? 'superseded' : 'applied'
        await insertGrantRow(seeded.userId, 'dingtalk', false)
        const eventId = await insertEvent(seeded, { status })
        await insertGrantEffect(seeded, eventId, { provider: 'dingtalk', status, creation })
        await query("UPDATE directory_accounts SET provider='wecom' WHERE id=$1", [seeded.accountId])
        const act = creation
          ? compensateSupersededDenyGrant({ eventId, adminUserId: 'admin-test', confirm: true, note: 'verified source cleanup' })
          : restoreDeprovisionEvent({ eventId, mode: action, adminUserId: 'admin-test', confirm: true, note: 'verified source restore' })
        await expect(act).rejects.toMatchObject({ code: 'DRIFT_CONFLICT' })
        expect(await effectStatuses(eventId)).toEqual([{ effect_type: 'grant_changed', status, provider: 'dingtalk' }])
        expect((await grantRows(seeded.userId)).map(g => g.enabled)).toEqual([false])
      })
    }
  })

  describe('compensation acts on the witnessed provider, NULL read as the default', () => {
    const compensate = (eventId: string) =>
      compensateSupersededDenyGrant({ eventId, adminUserId: 'admin-test', confirm: true, note: 'owner verified cleanup' })

    it('(a) DELETE branch: a pre-column creation effect deletes the default provider deny row only', async () => {
      const seeded = await seed()
      await insertGrantRow(seeded.userId, 'dingtalk', false)
      await insertGrantRow(seeded.userId, 'wecom', false)
      const eventId = await insertEvent(seeded, { status: 'superseded' })
      await insertGrantEffect(seeded, eventId, { provider: null, creation: true, status: 'superseded' })

      const result = await compensate(eventId)
      expect(result).toMatchObject({ grantRow: 'deleted', effectStatus: 'compensated', alreadyCompensated: false })
      expect(await grantRows(seeded.userId)).toEqual([
        { provider: 'wecom', enabled: false, granted_by: 'system:directory-deprovision' },
      ])
      expect(await effectStatuses(eventId)).toEqual([{ effect_type: 'grant_changed', status: 'compensated', provider: null }])
    })

    it('(b) already-compensated branch: the residual check reads the default provider for a NULL witness', async () => {
      const seeded = await seed()
      await insertGrantRow(seeded.userId, 'dingtalk', false)
      const eventId = await insertEvent(seeded, { status: 'superseded' })
      await insertGrantEffect(seeded, eventId, { provider: null, creation: true, status: 'compensated' })

      await expect(compensate(eventId)).rejects.toMatchObject({ code: 'DRIFT_CONFLICT' })

      await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = $1 AND provider = 'dingtalk'`, [seeded.userId])
      await insertGrantRow(seeded.userId, 'wecom', false)
      const retry = await compensate(eventId)
      expect(retry).toMatchObject({ alreadyCompensated: true, grantRow: 'already_absent' })
    })

    it('(e) non-default integration provider: a wecom creation effect deletes the wecom deny row and leaves the dingtalk deny row', async () => {
      const seeded = await seed({ provider: 'wecom' })
      await insertGrantRow(seeded.userId, 'wecom', false)
      await insertGrantRow(seeded.userId, 'dingtalk', false)
      const eventId = await insertEvent(seeded, { status: 'superseded' })
      await insertGrantEffect(seeded, eventId, { provider: 'wecom', creation: true, status: 'superseded' })

      const result = await compensate(eventId)
      expect(result).toMatchObject({ grantRow: 'deleted' })
      expect(await grantRows(seeded.userId)).toEqual([
        { provider: 'dingtalk', enabled: false, granted_by: 'system:directory-deprovision' },
      ])
      expect(await effectStatuses(eventId)).toEqual([{ effect_type: 'grant_changed', status: 'compensated', provider: 'wecom' }])
    })

    it('(e) non-default integration provider: a wecom witness whose wecom row is missing is drift even with a dingtalk deny row present', async () => {
      const seeded = await seed({ provider: 'wecom' })
      await insertGrantRow(seeded.userId, 'dingtalk', false)
      const eventId = await insertEvent(seeded, { status: 'superseded' })
      await insertGrantEffect(seeded, eventId, { provider: 'wecom', creation: true, status: 'superseded' })

      await expect(compensate(eventId)).rejects.toMatchObject({ code: 'DRIFT_CONFLICT' })
      expect(await grantRows(seeded.userId)).toEqual([
        { provider: 'dingtalk', enabled: false, granted_by: 'system:directory-deprovision' },
      ])
      expect(await effectStatuses(eventId)).toEqual([{ effect_type: 'grant_changed', status: 'superseded', provider: 'wecom' }])
    })
  })

  describe('writer: the grant effect records the source integration provider', () => {
    async function applyFor(seeded: Seeded) {
      return transaction(async (client) =>
        applyDirectoryDeprovisionCandidate(
          {
            query: async (statement, params) => {
              const result = await client.query(statement, params)
              return { rows: result.rows as Array<Record<string, unknown>> }
            },
          },
          {
            localUserId: seeded.userId,
            orgId: seeded.orgId,
            integrationId: seeded.integrationId,
            directoryAccountId: seeded.accountId,
            runId: seeded.runId,
            triggeredBy: 'test:rv1-evidence',
            policy: 'mark_inactive',
            write: true,
            ledgerScope: {},
          },
        ),
      )
    }

    it('a dingtalk departure writes provider=dingtalk on the grant effect and NULL on the others', async () => {
      const seeded = await seed({ accountActive: false })
      await insertGrantRow(seeded.userId, 'dingtalk', true, 'someone')
      const applied = await applyFor(seeded)
      expect(applied.applied).toBe(true)
      expect(await effectStatuses(applied.eventId!)).toEqual([
        { effect_type: 'grant_changed', status: 'applied', provider: 'dingtalk' },
        { effect_type: 'membership_changed', status: 'applied', provider: null },
        { effect_type: 'user_changed', status: 'applied', provider: null },
      ])
      expect(await grantRows(seeded.userId)).toEqual([
        { provider: 'dingtalk', enabled: false, granted_by: 'system:directory-deprovision' },
      ])
    })

    it('a wecom departure (non-default integration provider) flips the wecom row, records provider=wecom, and leaves the dingtalk row untouched', async () => {
      const seeded = await seed({ provider: 'wecom', accountActive: false })
      await insertGrantRow(seeded.userId, 'wecom', true, 'someone')
      await insertGrantRow(seeded.userId, 'dingtalk', true, 'someone')
      const applied = await applyFor(seeded)
      expect(applied.applied).toBe(true)
      expect((await effectStatuses(applied.eventId!)).find((row) => row.effect_type === 'grant_changed')).toEqual({
        effect_type: 'grant_changed', status: 'applied', provider: 'wecom',
      })
      expect(await grantRows(seeded.userId)).toEqual([
        { provider: 'dingtalk', enabled: true, granted_by: 'someone' },
        { provider: 'wecom', enabled: false, granted_by: 'system:directory-deprovision' },
      ])

      // And the round trip: restore reverses the wecom row only.
      await restoreDeprovisionEvent({ eventId: applied.eventId!, mode: 'admin_force', adminUserId: 'admin-test', confirm: true, note: 'owner approved restore' })
      expect(await grantRows(seeded.userId)).toEqual([
        { provider: 'dingtalk', enabled: true, granted_by: 'someone' },
        { provider: 'wecom', enabled: true, granted_by: 'restore:admin-test' },
      ])
    })
  })
})
