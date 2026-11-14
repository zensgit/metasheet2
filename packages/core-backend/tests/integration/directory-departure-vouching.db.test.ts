/**
 * Departure vouching — the single definition against real PostgreSQL.
 *
 * Invariants:
 *  - every scope variant (global, org, legacy login, strict login) and its non-local restriction
 *    counts exactly the active, linked directory accounts of the person inside its scope, minus
 *    the exclusion set; inactive accounts, pending links, links to other people, identities and
 *    login grants never vouch;
 *  - an empty exclusion array excludes nothing, an array naming an account excludes it, and a
 *    NULL exclusion set would make the expression false — which is why callers bind arrays only;
 *  - each statement that asks "does anyone else vouch" answers the same way through its own call
 *    site: candidate selection, the planner's state read (preview), the write-time membership
 *    recheck and the membership helper;
 *  - the preview reports `suppressedByLocal` when a local account alone vouches;
 *  - `createLocalAccount` writes the default match strategy and refuses anything outside the set.
 *
 * Fixtures are built per case with explicit org ids and a timestamp prefix. Integrations of a
 * non-default provider are inserted with SQL because no product writer creates them; local
 * accounts go through the product writer.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'

import { query, transaction } from '../../src/db/pg'
import {
  bindProspectiveAccountIds,
  globalVouchExists,
  legacyLoginScopeVouchExists,
  noProspectiveDeactivation,
  orgVouchExists,
  strictLoginScopeVouchExists,
} from '../../src/directory/departure-vouching'
import {
  applyDirectoryDeprovisionCandidate,
} from '../../src/directory/deprovision-ledger'
import { previewDeprovisionForUser } from '../../src/directory/deprovision-evidence-api'
import {
  applyDirectoryDeprovisionPolicies,
  deactivateUserOrgMembershipIfNoOtherActiveBinding,
} from '../../src/directory/directory-sync'
import {
  LocalDirectoryValidationError,
  createLocalAccount,
} from '../../src/directory/local-directory-org'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
// Anti-skip-green sentinel: a DB-expected lane must have a database, never a silent skip.
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
itIfExpectDb('requires a real DB', () => expect(process.env.DATABASE_URL).toBeTruthy())

const PREFIX = `rv2a-vouch-${Date.now()}`

type World = {
  orgA: string
  orgB: string
  userId: string
  otherUserId: string
  integrations: { dtA: string; dtB: string; wcA: string }
  corps: { dtA: string; dtB: string; wcA: string }
  accounts: { dtA: string; dtB: string; wcA: string }
}

async function cleanup(): Promise<void> {
  await query(`DELETE FROM directory_deprovision_events WHERE local_user_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM user_external_auth_grants WHERE local_user_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM user_external_identities WHERE local_user_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM directory_integrations WHERE org_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}-%`])
}

async function makeUser(label: string): Promise<string> {
  const userId = `${PREFIX}-user-${label}-${randomUUID()}`
  await query(
    `INSERT INTO users (id, password_hash, is_active, activation_status, access_generation)
     VALUES ($1, 'x', TRUE, 'activated', 3)`,
    [userId],
  )
  return userId
}

async function makeIntegration(orgId: string, provider: string, corpId: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO directory_integrations (name, corp_id, org_id, provider, status, default_deprovision_policy)
     VALUES ($1, $2, $3, $4, 'active', 'mark_inactive')
     RETURNING id::text AS id`,
    [`${PREFIX}-integration-${randomUUID()}`, corpId, orgId, provider],
  )
  return result.rows[0].id
}

async function makeAccount(options: {
  integrationId: string
  provider: string
  corpId: string
  userId: string | null
  active?: boolean
  linkStatus?: 'linked' | 'pending'
}): Promise<string> {
  const account = await query<{ id: string }>(
    `INSERT INTO directory_accounts (
       integration_id, provider, corp_id, external_user_id, external_key, name, is_active
     ) VALUES ($1::uuid, $2, $3, $4, $5, 'RV2a Vouch', $6)
     RETURNING id::text AS id`,
    [
      options.integrationId,
      options.provider,
      options.corpId,
      `${PREFIX}-external-${randomUUID()}`,
      `${options.provider}:${PREFIX}:${randomUUID()}`,
      options.active ?? true,
    ],
  )
  const accountId = account.rows[0].id
  if (options.userId) {
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
       VALUES ($1::uuid, $2, $3)`,
      [accountId, options.userId, options.linkStatus ?? 'linked'],
    )
  }
  return accountId
}

async function makeMembership(userId: string, orgId: string, active = true): Promise<void> {
  await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)`, [userId, orgId, active])
}

async function membershipActive(userId: string, orgId: string): Promise<boolean | null> {
  const result = await query<{ is_active: boolean }>(
    `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
    [userId, orgId],
  )
  return result.rows[0]?.is_active ?? null
}

/** One user vouched for by an account in each scope, plus a local account in org A. */
async function makeWorld(): Promise<World & { localAccountId: string }> {
  const orgA = `${PREFIX}-orgA-${randomUUID()}`
  const orgB = `${PREFIX}-orgB-${randomUUID()}`
  const corps = {
    dtA: `${PREFIX}-corp-dtA-${randomUUID()}`,
    dtB: `${PREFIX}-corp-dtB-${randomUUID()}`,
    wcA: `${PREFIX}-corp-wcA-${randomUUID()}`,
  }
  const userId = await makeUser('subject')
  const otherUserId = await makeUser('other')
  const integrations = {
    dtA: await makeIntegration(orgA, 'dingtalk', corps.dtA),
    dtB: await makeIntegration(orgB, 'dingtalk', corps.dtB),
    wcA: await makeIntegration(orgA, 'wecom', corps.wcA),
  }
  const accounts = {
    dtA: await makeAccount({ integrationId: integrations.dtA, provider: 'dingtalk', corpId: corps.dtA, userId }),
    dtB: await makeAccount({ integrationId: integrations.dtB, provider: 'dingtalk', corpId: corps.dtB, userId }),
    wcA: await makeAccount({ integrationId: integrations.wcA, provider: 'wecom', corpId: corps.wcA, userId }),
  }
  const local = await createLocalAccount({ orgId: orgA, localUserId: userId })
  return {
    orgA,
    orgB,
    userId,
    otherUserId,
    integrations,
    corps,
    accounts,
    localAccountId: local.id,
  }
}

async function vouched(expression: string, params: unknown[]): Promise<boolean> {
  const result = await query<{ vouched: boolean }>(`SELECT ${expression} AS vouched`, params)
  return result.rows[0].vouched
}

describeIfDatabase('departure vouching against real PostgreSQL', () => {
  afterAll(async () => {
    await cleanup()
  })

  describe('scope variants', () => {
    it('global counts every active linked account of the person, minus the exclusion set', async () => {
      const w = await makeWorld()
      const all = [w.accounts.dtA, w.accounts.dtB, w.accounts.wcA, w.localAccountId]
      const expression = globalVouchExists({ user: '$1::text', prospectiveParam: 2 })
      expect(await vouched(expression, [w.userId, noProspectiveDeactivation()])).toBe(true)
      expect(await vouched(expression, [w.userId, all])).toBe(false)
      expect(await vouched(expression, [w.userId, all.slice(1)])).toBe(true)
      expect(await vouched(expression, [w.otherUserId, noProspectiveDeactivation()])).toBe(false)
    })

    it('org counts only accounts whose integration belongs to the organization, local accounts included', async () => {
      const w = await makeWorld()
      const expression = orgVouchExists({ user: '$1::text', prospectiveParam: 2, orgParam: 3 })
      expect(await vouched(expression, [w.userId, [], w.orgA])).toBe(true)
      expect(await vouched(expression, [w.userId, [], w.orgB])).toBe(true)
      expect(await vouched(expression, [w.userId, [], `${PREFIX}-no-such-org`])).toBe(false)
      // org A vouchers: the dingtalk, wecom and local accounts; org B: the dingtalk account only
      expect(await vouched(expression, [w.userId, [w.accounts.dtA, w.accounts.wcA], w.orgA])).toBe(true)
      expect(await vouched(expression, [w.userId, [w.accounts.dtA, w.accounts.wcA, w.localAccountId], w.orgA])).toBe(false)
      expect(await vouched(expression, [w.userId, [w.accounts.dtB], w.orgB])).toBe(false)
      expect(await vouched(expression, [w.userId, [w.accounts.dtB], w.orgA])).toBe(true)
    })

    it('legacy login scope counts only accounts on an integration with the same provider and corp', async () => {
      const w = await makeWorld()
      const expression = legacyLoginScopeVouchExists({
        user: '$1::text',
        prospectiveParam: 2,
        providerParam: 3,
        corpParam: 4,
      })
      expect(await vouched(expression, [w.userId, [], 'dingtalk', w.corps.dtA])).toBe(true)
      expect(await vouched(expression, [w.userId, [w.accounts.dtA], 'dingtalk', w.corps.dtA])).toBe(false)
      expect(await vouched(expression, [w.userId, [], 'dingtalk', w.corps.dtB])).toBe(true)
      expect(await vouched(expression, [w.userId, [w.accounts.dtB], 'dingtalk', w.corps.dtB])).toBe(false)
      // same corp under another provider, or another corp under the same provider: nobody
      expect(await vouched(expression, [w.userId, [], 'wecom', w.corps.dtA])).toBe(false)
      expect(await vouched(expression, [w.userId, [], 'dingtalk', w.corps.wcA])).toBe(false)
      expect(await vouched(expression, [w.userId, [], 'wecom', w.corps.wcA])).toBe(true)
    })

    it('login scopes name a provider and corp or a connection list, so local accounts are not counted by them', async () => {
      const w = await makeWorld()
      const exclusion = [w.accounts.dtA, w.accounts.dtB, w.accounts.wcA]
      const legacy = legacyLoginScopeVouchExists({
        user: '$1::text',
        prospectiveParam: 2,
        providerParam: 3,
        corpParam: 4,
      })
      for (const [provider, corp] of [
        ['dingtalk', w.corps.dtA],
        ['dingtalk', w.corps.dtB],
        ['wecom', w.corps.wcA],
      ]) {
        expect(await vouched(legacy, [w.userId, exclusion, provider, corp])).toBe(false)
      }
      const strict = strictLoginScopeVouchExists({ user: '$1::text', prospectiveParam: 2, connectionIdsParam: 3 })
      expect(
        await vouched(strict, [
          w.userId,
          exclusion,
          [w.integrations.dtA, w.integrations.dtB, w.integrations.wcA],
        ]),
      ).toBe(false)
      // the local account is linked and active: the organization scope still counts it
      const orgScope = orgVouchExists({ user: '$1::text', prospectiveParam: 2, orgParam: 3 })
      expect(await vouched(orgScope, [w.userId, exclusion, w.orgA])).toBe(true)
    })

    it('strict login scope counts only accounts on the listed integrations', async () => {
      const w = await makeWorld()
      const expression = strictLoginScopeVouchExists({ user: '$1::text', prospectiveParam: 2, connectionIdsParam: 3 })
      expect(await vouched(expression, [w.userId, [], [w.integrations.dtA]])).toBe(true)
      expect(await vouched(expression, [w.userId, [w.accounts.dtA], [w.integrations.dtA]])).toBe(false)
      expect(await vouched(expression, [w.userId, [w.accounts.dtA], [w.integrations.dtA, w.integrations.dtB]])).toBe(true)
      expect(await vouched(expression, [w.userId, [], [w.integrations.dtB]])).toBe(true)
      expect(await vouched(expression, [w.userId, [], []])).toBe(false)
      expect(await vouched(expression, [w.userId, [], [randomUUID()]])).toBe(false)
    })

    it('the non-local restriction leaves local accounts out and changes nothing else', async () => {
      const w = await makeWorld()
      const nonLocalExclusion = [w.accounts.dtA, w.accounts.wcA]
      const orgPlain = orgVouchExists({ user: '$1::text', prospectiveParam: 2, orgParam: 3 })
      const orgNonLocal = orgVouchExists({ user: '$1::text', prospectiveParam: 2, orgParam: 3, nonLocalOnly: true })
      // org A with both non-local accounts excluded: only the local account is left
      expect(await vouched(orgPlain, [w.userId, nonLocalExclusion, w.orgA])).toBe(true)
      expect(await vouched(orgNonLocal, [w.userId, nonLocalExclusion, w.orgA])).toBe(false)
      expect(await vouched(orgNonLocal, [w.userId, [w.accounts.dtA], w.orgA])).toBe(true)
      expect(await vouched(orgNonLocal, [w.userId, [], w.orgB])).toBe(true)

      const globalPlain = globalVouchExists({ user: '$1::text', prospectiveParam: 2 })
      const globalNonLocal = globalVouchExists({ user: '$1::text', prospectiveParam: 2, nonLocalOnly: true })
      const nonLocalAll = [w.accounts.dtA, w.accounts.dtB, w.accounts.wcA]
      expect(await vouched(globalPlain, [w.userId, nonLocalAll])).toBe(true)
      expect(await vouched(globalNonLocal, [w.userId, nonLocalAll])).toBe(false)
      expect(await vouched(globalNonLocal, [w.userId, []])).toBe(true)
    })

    it('inactive accounts, pending links, links to other people, identities and grants never vouch', async () => {
      const orgA = `${PREFIX}-orgA-${randomUUID()}`
      const corp = `${PREFIX}-corp-neg-${randomUUID()}`
      const userId = await makeUser('negative')
      const otherUserId = await makeUser('negative-other')
      const integrationId = await makeIntegration(orgA, 'dingtalk', corp)
      await makeAccount({ integrationId, provider: 'dingtalk', corpId: corp, userId, active: false })
      await makeAccount({ integrationId, provider: 'dingtalk', corpId: corp, userId, linkStatus: 'pending' })
      await makeAccount({ integrationId, provider: 'dingtalk', corpId: corp, userId: otherUserId })
      await makeAccount({ integrationId, provider: 'dingtalk', corpId: corp, userId: null })
      await query(
        `INSERT INTO user_external_identities (provider, external_key, provider_union_id, corp_id, local_user_id, profile)
         VALUES ('dingtalk', $1, $2, $3, $4, '{}'::jsonb)`,
        [`${PREFIX}-identity-key-${randomUUID()}`, `${PREFIX}-union-${randomUUID()}`, corp, userId],
      )
      await query(
        `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by)
         VALUES ('dingtalk', $1, TRUE, 'test')`,
        [userId],
      )
      const expressions: Array<[string, unknown[]]> = [
        [globalVouchExists({ user: '$1::text', prospectiveParam: 2 }), [userId, []]],
        [orgVouchExists({ user: '$1::text', prospectiveParam: 2, orgParam: 3 }), [userId, [], orgA]],
        [
          legacyLoginScopeVouchExists({ user: '$1::text', prospectiveParam: 2, providerParam: 3, corpParam: 4 }),
          [userId, [], 'dingtalk', corp],
        ],
        [
          strictLoginScopeVouchExists({ user: '$1::text', prospectiveParam: 2, connectionIdsParam: 3 }),
          [userId, [], [integrationId]],
        ],
      ]
      for (const [expression, params] of expressions) {
        expect(await vouched(expression, params)).toBe(false)
      }
    })

    it('a NULL exclusion set makes the expression false even when an account vouches; arrays are the only bound form', async () => {
      const w = await makeWorld()
      const expression = globalVouchExists({ user: '$1::text', prospectiveParam: 2 })
      expect(await vouched(expression, [w.userId, noProspectiveDeactivation()])).toBe(true)
      expect(await vouched(expression, [w.userId, null])).toBe(false)
      expect(() => bindProspectiveAccountIds(null)).toThrow(/exclusion set must be an array/)
    })
  })

  describe('call sites', () => {
    const select = async (integrationId: string, accountIds: string[]) =>
      applyDirectoryDeprovisionPolicies(
        { query: async (sql, params) => query(sql, params) },
        {
          integrationId,
          runId: randomUUID(),
          triggeredBy: 'test:rv2a-vouching',
          deactivatedAccountIds: accountIds,
          syncedAccountCount: 100,
          integrationDefaultPolicy: 'mark_inactive',
          enabled: false,
        },
      )

    /** A departing dingtalk account of a user who holds an active membership in the org. */
    async function departing() {
      const orgA = `${PREFIX}-orgA-${randomUUID()}`
      const orgB = `${PREFIX}-orgB-${randomUUID()}`
      const corpA = `${PREFIX}-corp-a-${randomUUID()}`
      const corpB = `${PREFIX}-corp-b-${randomUUID()}`
      const userId = await makeUser('departing')
      const integrationId = await makeIntegration(orgA, 'dingtalk', corpA)
      const accountId = await makeAccount({
        integrationId,
        provider: 'dingtalk',
        corpId: corpA,
        userId,
        active: false,
      })
      await makeMembership(userId, orgA)
      return { orgA, orgB, corpA, corpB, userId, integrationId, accountId }
    }

    describe('candidate selection', () => {
      it('selects a departing account when nobody else vouches', async () => {
        const d = await departing()
        const outcome = await select(d.integrationId, [d.accountId])
        expect(outcome.candidateCount).toBe(1)
        expect(outcome.globalCandidateCount).toBe(1)
        expect(outcome.affected).toEqual([
          expect.objectContaining({ localUserId: d.userId, globallyClear: true }),
        ])
      })

      it('does not select when another source of the same organization vouches', async () => {
        const d = await departing()
        const wecom = await makeIntegration(d.orgA, 'wecom', `${PREFIX}-corp-wc-${randomUUID()}`)
        await makeAccount({ integrationId: wecom, provider: 'wecom', corpId: `${PREFIX}-c-${randomUUID()}`, userId: d.userId })
        const outcome = await select(d.integrationId, [d.accountId])
        expect(outcome.candidateCount).toBe(0)
        expect(outcome.affected).toEqual([])
      })

      it('does not select when a local account of the same organization vouches', async () => {
        const d = await departing()
        await createLocalAccount({ orgId: d.orgA, localUserId: d.userId })
        const outcome = await select(d.integrationId, [d.accountId])
        expect(outcome.candidateCount).toBe(0)
        expect(outcome.affected).toEqual([])
      })

      it('selects when only another organization vouches; the account is not globally clear', async () => {
        const d = await departing()
        const other = await makeIntegration(d.orgB, 'dingtalk', d.corpB)
        await makeAccount({ integrationId: other, provider: 'dingtalk', corpId: d.corpB, userId: d.userId })
        const outcome = await select(d.integrationId, [d.accountId])
        expect(outcome.candidateCount).toBe(1)
        expect(outcome.globalCandidateCount).toBe(0)
        expect(outcome.affected).toEqual([
          expect.objectContaining({ localUserId: d.userId, globallyClear: false }),
        ])
      })

      it('selects when the only other accounts are inactive, pending or linked to someone else', async () => {
        const d = await departing()
        const otherUser = await makeUser('departing-other')
        const sibling = await makeIntegration(d.orgA, 'wecom', `${PREFIX}-corp-wc-${randomUUID()}`)
        const corp = `${PREFIX}-c-${randomUUID()}`
        await makeAccount({ integrationId: sibling, provider: 'wecom', corpId: corp, userId: d.userId, active: false })
        await makeAccount({ integrationId: sibling, provider: 'wecom', corpId: corp, userId: d.userId, linkStatus: 'pending' })
        await makeAccount({ integrationId: sibling, provider: 'wecom', corpId: corp, userId: otherUser })
        const outcome = await select(d.integrationId, [d.accountId])
        expect(outcome.candidateCount).toBe(1)
        expect(outcome.globalCandidateCount).toBe(1)
      })
    })

    describe('state read (preview)', () => {
      it('plans every effect when nobody else vouches, excluding the departing accounts themselves', async () => {
        const d = await departing()
        // a second active account of the same source is excluded together with the first
        const second = await makeAccount({
          integrationId: d.integrationId,
          provider: 'dingtalk',
          corpId: d.corpA,
          userId: d.userId,
        })
        await query(`UPDATE directory_accounts SET is_active = TRUE WHERE id = ANY($1::uuid[])`, [[d.accountId, second]])
        const preview = await previewDeprovisionForUser(d.userId, d.integrationId)
        expect(preview.prospectiveDeactivatedAccountIds.sort()).toEqual([d.accountId, second].sort())
        expect(preview.plan.effects.map((effect) => effect.type).sort()).toEqual([
          'grant_changed',
          'membership_changed',
          'user_changed',
        ])
        expect(preview.plan.suppressedByLocal).toEqual({ membership: false, global: false })
      })

      it('reports a local account alone as suppressing membership and global effects', async () => {
        const d = await departing()
        await query(`UPDATE directory_accounts SET is_active = TRUE WHERE id = $1::uuid`, [d.accountId])
        await createLocalAccount({ orgId: d.orgA, localUserId: d.userId })
        const preview = await previewDeprovisionForUser(d.userId, d.integrationId)
        expect(preview.plan.effects).toEqual([])
        expect(preview.plan.suppressedByLocal).toEqual({ membership: true, global: true })
      })

      it('does not report suppression when a non-local account also vouches', async () => {
        const d = await departing()
        await query(`UPDATE directory_accounts SET is_active = TRUE WHERE id = $1::uuid`, [d.accountId])
        await createLocalAccount({ orgId: d.orgA, localUserId: d.userId })
        const wecom = await makeIntegration(d.orgA, 'wecom', `${PREFIX}-corp-wc-${randomUUID()}`)
        await makeAccount({ integrationId: wecom, provider: 'wecom', corpId: `${PREFIX}-c-${randomUUID()}`, userId: d.userId })
        const preview = await previewDeprovisionForUser(d.userId, d.integrationId)
        expect(preview.plan.effects).toEqual([])
        expect(preview.plan.suppressedByLocal).toEqual({ membership: false, global: false })
      })

      it('another organization alone vouches: membership effect planned, global effects not, no suppression', async () => {
        const d = await departing()
        await query(`UPDATE directory_accounts SET is_active = TRUE WHERE id = $1::uuid`, [d.accountId])
        const other = await makeIntegration(d.orgB, 'dingtalk', d.corpB)
        await makeAccount({ integrationId: other, provider: 'dingtalk', corpId: d.corpB, userId: d.userId })
        const preview = await previewDeprovisionForUser(d.userId, d.integrationId)
        expect(preview.plan.effects.map((effect) => effect.type)).toEqual(['membership_changed'])
        expect(preview.plan.suppressedByLocal).toEqual({ membership: false, global: false })
      })

      it('a local account in another organization suppresses the global effects only', async () => {
        const d = await departing()
        await query(`UPDATE directory_accounts SET is_active = TRUE WHERE id = $1::uuid`, [d.accountId])
        await createLocalAccount({ orgId: d.orgB, localUserId: d.userId })
        const preview = await previewDeprovisionForUser(d.userId, d.integrationId)
        expect(preview.plan.effects.map((effect) => effect.type)).toEqual(['membership_changed'])
        expect(preview.plan.suppressedByLocal).toEqual({ membership: false, global: true })
      })
    })

    describe('write-time membership recheck', () => {
      it('deactivates the membership when nobody vouches at write time', async () => {
        const d = await departing()
        const runIdValue = await runId(d.integrationId)
        await transaction(async (client) => {
          const result = await applyDirectoryDeprovisionCandidate(client, {
            localUserId: d.userId,
            orgId: d.orgA,
            integrationId: d.integrationId,
            directoryAccountId: d.accountId,
            runId: runIdValue,
            triggeredBy: 'test:rv2a-vouching',
            policy: 'disable_grant_only',
            write: true,
            ledgerScope: {},
          })
          expect(result.applied).toBe(true)
        })
        expect(await membershipActive(d.userId, d.orgA)).toBe(false)
      })

      it('aborts and keeps the membership when a vouching account becomes active between planning and the write', async () => {
        const d = await departing()
        const wecom = await makeIntegration(d.orgA, 'wecom', `${PREFIX}-corp-wc-${randomUUID()}`)
        const sibling = await makeAccount({
          integrationId: wecom,
          provider: 'wecom',
          corpId: `${PREFIX}-c-${randomUUID()}`,
          userId: d.userId,
          active: false,
        })
        const runIdValue = await runId(d.integrationId)
        let injected = false
        await expect(
          transaction(async (client) => {
            const racing = {
              query: async (sql: string, params?: unknown[]) => {
                if (!injected && /^\s*UPDATE user_orgs\s+SET is_active = FALSE/.test(sql)) {
                  injected = true
                  // another connection activates the sibling after the state read, before the UPDATE
                  await query(`UPDATE directory_accounts SET is_active = TRUE WHERE id = $1::uuid`, [sibling])
                }
                return client.query(sql, params)
              },
            }
            await applyDirectoryDeprovisionCandidate(racing, {
              localUserId: d.userId,
              orgId: d.orgA,
              integrationId: d.integrationId,
              directoryAccountId: d.accountId,
              runId: runIdValue,
              triggeredBy: 'test:rv2a-vouching',
              policy: 'disable_grant_only',
              write: true,
              ledgerScope: {},
            })
          }),
        ).rejects.toThrow(/membership changed after planning/)
        expect(injected).toBe(true)
        expect(await membershipActive(d.userId, d.orgA)).toBe(true)
      })
    })

    describe('membership helper', () => {
      const helper = async (userId: string, orgId: string) =>
        deactivateUserOrgMembershipIfNoOtherActiveBinding(
          { query: async (sql, params) => query(sql, params) },
          { userId, orgId },
        )

      it('deactivates when no other active linked account exists in the organization', async () => {
        const d = await departing()
        await helper(d.userId, d.orgA)
        expect(await membershipActive(d.userId, d.orgA)).toBe(false)
      })

      it('keeps the membership when another source or a local account of the organization vouches', async () => {
        const d = await departing()
        const wecom = await makeIntegration(d.orgA, 'wecom', `${PREFIX}-corp-wc-${randomUUID()}`)
        await makeAccount({ integrationId: wecom, provider: 'wecom', corpId: `${PREFIX}-c-${randomUUID()}`, userId: d.userId })
        await helper(d.userId, d.orgA)
        expect(await membershipActive(d.userId, d.orgA)).toBe(true)

        const e = await departing()
        await createLocalAccount({ orgId: e.orgA, localUserId: e.userId })
        await helper(e.userId, e.orgA)
        expect(await membershipActive(e.userId, e.orgA)).toBe(true)
      })

      it('deactivates when the only other accounts are in another organization, inactive, pending or someone else\'s', async () => {
        const d = await departing()
        const otherUser = await makeUser('helper-other')
        const elsewhere = await makeIntegration(d.orgB, 'dingtalk', d.corpB)
        await makeAccount({ integrationId: elsewhere, provider: 'dingtalk', corpId: d.corpB, userId: d.userId })
        const sibling = await makeIntegration(d.orgA, 'wecom', `${PREFIX}-corp-wc-${randomUUID()}`)
        const corp = `${PREFIX}-c-${randomUUID()}`
        await makeAccount({ integrationId: sibling, provider: 'wecom', corpId: corp, userId: d.userId, active: false })
        await makeAccount({ integrationId: sibling, provider: 'wecom', corpId: corp, userId: d.userId, linkStatus: 'pending' })
        await makeAccount({ integrationId: sibling, provider: 'wecom', corpId: corp, userId: otherUser })
        await helper(d.userId, d.orgA)
        expect(await membershipActive(d.userId, d.orgA)).toBe(false)
      })
    })
  })

  describe('createLocalAccount match strategy', () => {
    const strategyOf = async (accountId: string) => {
      const result = await query<{ match_strategy: string | null; link_status: string }>(
        `SELECT match_strategy, link_status FROM directory_account_links WHERE directory_account_id = $1::uuid`,
        [accountId],
      )
      return result.rows[0]
    }

    it('writes the default strategy when none is given and when the default is named', async () => {
      const orgA = `${PREFIX}-orgA-${randomUUID()}`
      const orgB = `${PREFIX}-orgB-${randomUUID()}`
      const userId = await makeUser('strategy')
      const implicit = await createLocalAccount({ orgId: orgA, localUserId: userId })
      expect(await strategyOf(implicit.id)).toEqual({ match_strategy: 'local_explicit', link_status: 'linked' })
      const named = await createLocalAccount({ orgId: orgB, localUserId: userId, matchStrategy: 'local_explicit' })
      expect(await strategyOf(named.id)).toEqual({ match_strategy: 'local_explicit', link_status: 'linked' })
    })

    it('refuses a strategy outside the closed set and writes nothing', async () => {
      const orgA = `${PREFIX}-orgA-${randomUUID()}`
      const userId = await makeUser('strategy-refused')
      await expect(
        createLocalAccount({ orgId: orgA, localUserId: userId, matchStrategy: 'bulk_import' as never }),
      ).rejects.toBeInstanceOf(LocalDirectoryValidationError)
      const rows = await query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM directory_account_links l
           JOIN directory_accounts a ON a.id = l.directory_account_id
          WHERE l.local_user_id = $1`,
        [userId],
      )
      expect(rows.rows[0].n).toBe(0)
      expect(await membershipActive(userId, orgA)).toBeNull()
    })
  })
})

async function runId(integrationId: string): Promise<string> {
  const run = await query<{ id: string }>(
    `INSERT INTO directory_sync_runs (integration_id, status, triggered_by, trigger_source)
     VALUES ($1::uuid, 'success', 'test:rv2a-vouching', 'manual')
     RETURNING id::text AS id`,
    [integrationId],
  )
  return run.rows[0].id
}
