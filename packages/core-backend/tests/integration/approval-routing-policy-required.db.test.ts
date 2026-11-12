/**
 * Approval routing — the multi-source rule of the requester resolver against real PostgreSQL.
 *
 * Rule: with the require-policy switch on, an organisation that holds two or more distinct active
 * pull sources (`provider <> 'local'`, `status = 'active'`, de-duplicated by `(provider, corp_id)`)
 * and has no `approval_routing` policy gets no source picked for a requester who has a linked,
 * active directory account in it: the resolver raises the typed `policy_required` error.
 *
 * Invariants pinned here:
 *  - one pull source or fewer (the local directory is never counted): the result equals the result
 *    with the switch off, including the integration the requester was resolved from;
 *  - two or more: the typed error, whatever the update order of the requester's accounts;
 *  - switch off: the result equals the latest-updated pick in both update orders;
 *  - a policy stays authoritative and the multi-source check does not run under it;
 *  - the check is confined to the organisation passed as `orgId`, and to the organisations the
 *    requester is linked in when none is passed;
 *  - a preview override skips the check;
 *  - the error carries the organisation and the count only in typed properties;
 *  - the check writes nothing;
 *  - the requester reach is "linked and active account", the same as the requester pick;
 *  - the leaf count statement returns the number of distinct active pull sources per organisation.
 *
 * Every case builds its own organisations with a per-run prefix and removes them afterwards. The
 * switch is set per call and removed in `finally`, so a failing case cannot leak it.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { query } from '../../src/db/pg'
import { getOrCreateLocalIntegration } from '../../src/directory/directory-sync'
import {
  APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED,
  COUNT_ACTIVE_PULL_SOURCES_SQL,
  POLICY_REQUIRED_MESSAGE,
  countActivePullSources,
  isApprovalRoutingPolicyRequired,
} from '../../src/directory/pull-source-rule'
import {
  ApprovalRoutingPolicyError,
  resolveApprovalRequesterOrgRelations,
  type ApprovalRequesterOrgRelations,
} from '../../src/services/ApprovalDirectoryOrg'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
// Anti-skip-green sentinel: a DB-expected lane must have a database, never a silent skip.
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip

itIfExpectDb('requires a real DB', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const orgOf = (tag: string): string => `arpr-${STAMP}-${tag}`
const userOf = (tag: string): string => `arpr-user-${STAMP}-${tag}`
const corpOf = (tag: string): string => `corp-arpr-${STAMP}-${tag}`

type Resolved = ApprovalRequesterOrgRelations

async function withSwitch<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED]
  if (value === undefined) delete process.env[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED]
  else process.env[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED] = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED]
    else process.env[APPROVAL_ROUTING_REQUIRE_POLICY_ENABLED] = previous
  }
}

type ResolveOptions = NonNullable<Parameters<typeof resolveApprovalRequesterOrgRelations>[2]>

/** Resolve with the switch on; the integration the requester was resolved from is part of the result. */
function resolveOn(user: string, options: ResolveOptions = {}): Promise<Resolved> {
  return withSwitch('true', () =>
    resolveApprovalRequesterOrgRelations(user, query, { includeDepartmentFieldContext: true, ...options }))
}

/** Resolve with the switch off: the behaviour the rule leaves untouched. */
function resolveOff(user: string, options: ResolveOptions = {}): Promise<Resolved> {
  return withSwitch(undefined, () =>
    resolveApprovalRequesterOrgRelations(user, query, { includeDepartmentFieldContext: true, ...options }))
}

async function rejectionOn(user: string, options: ResolveOptions = {}): Promise<unknown> {
  try {
    await resolveOn(user, options)
  } catch (error) {
    return error
  }
  return null
}

async function expectPolicyRequired(user: string, options: ResolveOptions = {}): Promise<ApprovalRoutingPolicyError> {
  const error = await rejectionOn(user, options)
  expect(error).toBeInstanceOf(ApprovalRoutingPolicyError)
  expect((error as ApprovalRoutingPolicyError).reason).toBe('policy_required')
  return error as ApprovalRoutingPolicyError
}

describeIfDatabase('approval routing multi-source rule against real PostgreSQL', () => {
  const seededOrgIds: string[] = []
  const seededUserIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      await query(`DELETE FROM org_directory_routing_policy WHERE org_id = $1`, [org])
      await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
    }
    for (const user of seededUserIds.splice(0)) {
      await query(`DELETE FROM user_orgs WHERE user_id = $1`, [user])
      await query(`DELETE FROM users WHERE id = $1`, [user])
    }
  })

  function newOrg(tag: string): string {
    const org = orgOf(tag)
    seededOrgIds.push(org)
    return org
  }

  async function seedUser(tag: string): Promise<string> {
    const id = userOf(tag)
    seededUserIds.push(id)
    await query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')`, [id, `${id}@example.test`, id])
    return id
  }

  /** A pull-type integration row. `corpTag` names the external enterprise; `nameTag` keeps names unique. */
  async function integration(
    org: string,
    corpTag: string,
    options: { provider?: string; status?: string; nameTag?: string } = {},
  ): Promise<string> {
    const provider = options.provider ?? 'dingtalk'
    const inserted = await query<{ id: string }>(
      `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb) RETURNING id`,
      [org, provider, `Source ${options.nameTag ?? corpTag} ${STAMP}`, options.status ?? 'active', corpOf(corpTag)],
    )
    return inserted.rows[0].id
  }

  /** An account of `user` under the integration; its title names the source it belongs to. */
  async function account(
    integrationId: string,
    provider: string,
    user: string,
    title: string,
    options: { linkStatus?: string; isActive?: boolean } = {},
  ): Promise<string> {
    const inserted = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, title, is_active, raw)
       VALUES ($1, $2, $3, $3, $4, $5, $6, '{}'::jsonb) RETURNING id`,
      [integrationId, provider, `${provider}:${STAMP}:${user}:${integrationId.slice(0, 8)}`, user, title, options.isActive ?? true],
    )
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, $3, 'manual')`,
      [inserted.rows[0].id, user, options.linkStatus ?? 'linked'],
    )
    return inserted.rows[0].id
  }

  async function setPolicy(org: string, canonical: string): Promise<void> {
    await query(
      `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id)
       VALUES ($1, 'approval_routing', $2)
       ON CONFLICT ON CONSTRAINT orp_org_purpose_uniq
       DO UPDATE SET canonical_integration_id = EXCLUDED.canonical_integration_id, updated_at = NOW()`,
      [org, canonical],
    )
  }

  /** Make this account the most recently updated one of its owner. */
  async function makeNewest(accountId: string): Promise<void> {
    await query(
      `UPDATE directory_accounts
          SET updated_at = (SELECT max(updated_at) FROM directory_accounts) + interval '1 hour'
        WHERE id = $1`,
      [accountId],
    )
  }

  async function setStatus(integrationId: string, status: string): Promise<void> {
    await query(`UPDATE directory_integrations SET status = $2 WHERE id = $1`, [integrationId, status])
  }

  /** Two DingTalk integrations of different enterprises in one organisation, the requester linked in both. */
  async function twoPullFixture(tag: string): Promise<{
    org: string; user: string; a: string; b: string; accountA: string; accountB: string
  }> {
    const org = newOrg(tag)
    const user = await seedUser(tag)
    const a = await integration(org, `${tag}-a`)
    const b = await integration(org, `${tag}-b`)
    const accountA = await account(a, 'dingtalk', user, 'Source A')
    const accountB = await account(b, 'dingtalk', user, 'Source B')
    return { org, user, a, b, accountA, accountB }
  }

  /** One DingTalk integration plus an active integration row of another provider value, requester linked in both. */
  async function dtPlusOtherProviderFixture(tag: string, otherProvider: string): Promise<{ org: string; user: string }> {
    const org = newOrg(tag)
    const user = await seedUser(tag)
    const dt = await integration(org, `${tag}-dt`)
    const other = await integration(org, `${tag}-other`, { provider: otherProvider })
    await account(dt, 'dingtalk', user, 'DingTalk')
    await account(other, otherProvider, user, 'Other provider')
    return { org, user }
  }

  it('R1 single pull source: the result with the switch on equals the result with it off', async () => {
    const org = newOrg('r1')
    const user = await seedUser('r1')
    const dt = await integration(org, 'r1')
    await account(dt, 'dingtalk', user, 'Only source')

    const off = await resolveOff(user)
    const on = await resolveOn(user)

    expect(off.primaryTitle).toBe('Only source')
    expect(off.canonicalIntegrationId).toBe(dt)
    expect(on).toEqual(off)
  })

  it('R2 one pull source plus the local directory: the local directory is not counted', async () => {
    const org = newOrg('r2')
    const user = await seedUser('r2')
    const local = await getOrCreateLocalIntegration(org)
    const dt = await integration(org, 'r2')
    await account(local.id, 'local', user, 'Local')
    const dtAccount = await account(dt, 'dingtalk', user, 'DingTalk')
    await makeNewest(dtAccount)

    const off = await resolveOff(user)
    const on = await resolveOn(user)

    expect(off.primaryTitle).toBe('DingTalk')
    expect(on).toEqual(off)
  })

  it('R3 two pull sources and no policy: policy_required in either update order', async () => {
    const { user, accountA, accountB } = await twoPullFixture('r3')

    await expectPolicyRequired(user)
    await makeNewest(accountA)
    await expectPolicyRequired(user)
    await makeNewest(accountB)
    await expectPolicyRequired(user)
  })

  it('R4 two pull sources, switch off: the latest-updated account is picked in either update order', async () => {
    const { user, a, b, accountA, accountB } = await twoPullFixture('r4')

    await makeNewest(accountA)
    const newestA = await resolveOff(user)
    await makeNewest(accountB)
    const newestB = await resolveOff(user)

    expect(newestA.primaryTitle).toBe('Source A')
    expect(newestA.canonicalIntegrationId).toBe(a)
    expect(newestB.primaryTitle).toBe('Source B')
    expect(newestB.canonicalIntegrationId).toBe(b)
  })

  it.each(['wecom', 'unlisted-provider'])(
    'R5 a DingTalk source plus an active %s integration row: policy_required',
    async (otherProvider) => {
      const { user } = await dtPlusOtherProviderFixture(`r5-${otherProvider.slice(0, 2)}`, otherProvider)

      const error = await expectPolicyRequired(user)

      expect(error.sourceCount).toBe(2)
    },
  )

  it('R6 two pull sources plus the local directory: the local directory does not satisfy the rule', async () => {
    const { org, user } = await twoPullFixture('r6')
    const local = await getOrCreateLocalIntegration(org)
    const localAccount = await account(local.id, 'local', user, 'Local')
    await makeNewest(localAccount)

    const error = await expectPolicyRequired(user)

    expect(error.sourceCount).toBe(2)
  })

  it('R7 a policy is authoritative in a multi-source organisation, whatever the update order', async () => {
    const { org, user, a, accountB } = await twoPullFixture('r7')
    const local = await getOrCreateLocalIntegration(org)
    const localAccount = await account(local.id, 'local', user, 'Local')

    await setPolicy(org, a)
    await makeNewest(accountB)
    const viaA = await resolveOn(user)
    await setPolicy(org, local.id)
    await makeNewest(accountB)
    const viaLocal = await resolveOn(user)
    await makeNewest(localAccount)
    await setPolicy(org, a)
    const viaAAgain = await resolveOn(user)

    expect(viaA.primaryTitle).toBe('Source A')
    expect(viaA.canonicalIntegrationId).toBe(a)
    expect(viaLocal.primaryTitle).toBe('Local')
    expect(viaLocal.canonicalIntegrationId).toBe(local.id)
    expect(viaAAgain.primaryTitle).toBe('Source A')
  })

  it('R8 the rule is per organisation: a requester linked in one source only is still refused', async () => {
    const org = newOrg('r8')
    const user = await seedUser('r8')
    const a = await integration(org, 'r8-a')
    await integration(org, 'r8-b')
    await account(a, 'dingtalk', user, 'Source A')

    const error = await expectPolicyRequired(user)

    expect(error.orgId).toBe(org)
  })

  it('R8 a requester with no linked account resolves to an empty result without an error', async () => {
    const org = newOrg('r8n')
    await integration(org, 'r8n-a')
    await integration(org, 'r8n-b')
    const unlinked = await seedUser('r8n')

    const on = await resolveOn(unlinked)

    expect(on).toEqual({})
  })

  it('R9 a non-active second integration without accounts is not a source; active again, it is', async () => {
    const org = newOrg('r9a')
    const user = await seedUser('r9a')
    const a = await integration(org, 'r9a-a')
    const b = await integration(org, 'r9a-b')
    await account(a, 'dingtalk', user, 'Source A')

    await setStatus(b, 'paused')
    const offPaused = await resolveOff(user)
    const onPaused = await resolveOn(user)
    await setStatus(b, 'active')
    const errorActive = await rejectionOn(user)

    expect(offPaused.primaryTitle).toBe('Source A')
    expect(onPaused).toEqual(offPaused)
    expect(errorActive).toBeInstanceOf(ApprovalRoutingPolicyError)
    expect((errorActive as ApprovalRoutingPolicyError).reason).toBe('policy_required')
  })

  it('R9 a non-active second integration that still holds a linked account is not a source; active again, it is', async () => {
    const { user, b, accountB } = await twoPullFixture('r9b')
    await makeNewest(accountB)

    await setStatus(b, 'disabled')
    const offNonActive = await resolveOff(user)
    const onNonActive = await resolveOn(user)
    await setStatus(b, 'active')
    const errorActive = await rejectionOn(user)

    expect(offNonActive.primaryTitle).toBe('Source B')
    expect(onNonActive).toEqual(offNonActive)
    expect(errorActive).toBeInstanceOf(ApprovalRoutingPolicyError)
    expect((errorActive as ApprovalRoutingPolicyError).reason).toBe('policy_required')
  })

  it('R10 two rows of the same provider and enterprise are one source', async () => {
    const org = newOrg('r10')
    const user = await seedUser('r10')
    const withAccounts = await integration(org, 'r10-same', { nameTag: 'r10-first' })
    await integration(org, 'r10-same', { nameTag: 'r10-second' })
    await account(withAccounts, 'dingtalk', user, 'Same enterprise')

    const off = await resolveOff(user)
    const on = await resolveOn(user)

    expect(off.primaryTitle).toBe('Same enterprise')
    expect(off.canonicalIntegrationId).toBe(withAccounts)
    expect(on).toEqual(off)
  })

  it('R11 organisation boundary: the sources of another organisation are not counted', async () => {
    const x = await twoPullFixture('r11x')
    const orgY = newOrg('r11y')
    const y = await integration(orgY, 'r11y')
    await account(y, 'dingtalk', x.user, 'Org Y')
    const onlyInY = await seedUser('r11v')
    await account(y, 'dingtalk', onlyInY, 'Org Y other')

    const bothInY = await resolveOn(x.user, { orgId: orgY })
    const bothInYOff = await resolveOff(x.user, { orgId: orgY })
    const otherInY = await resolveOn(onlyInY, { orgId: orgY })
    const errorInX = await expectPolicyRequired(x.user, { orgId: x.org })

    expect(bothInY.primaryTitle).toBe('Org Y')
    expect(bothInY.canonicalIntegrationId).toBe(y)
    expect(bothInY).toEqual(bothInYOff)
    expect(otherInY.primaryTitle).toBe('Org Y other')
    expect(errorInX.orgId).toBe(x.org)
  })

  it('R12 without orgId: a governed organisation is followed and the check does not run', async () => {
    const x = await twoPullFixture('r12x')
    const orgZ = newOrg('r12z')
    const z = await integration(orgZ, 'r12z')
    await account(z, 'dingtalk', x.user, 'Org Z')
    await setPolicy(orgZ, z)

    const followsZ = await resolveOn(x.user)
    await query(`DELETE FROM org_directory_routing_policy WHERE org_id = $1`, [orgZ])
    await query(`DELETE FROM directory_integrations WHERE id = $1`, [z])
    const onlyInX = await rejectionOn(x.user)

    expect(followsZ.primaryTitle).toBe('Org Z')
    expect(followsZ.canonicalIntegrationId).toBe(z)
    expect(onlyInX).toBeInstanceOf(ApprovalRoutingPolicyError)
    expect((onlyInX as ApprovalRoutingPolicyError).reason).toBe('policy_required')
  })

  it('R12 without orgId: an ungoverned multi-source organisation refuses even when another organisation has one source', async () => {
    const x = await twoPullFixture('r12bx')
    const orgY = newOrg('r12by')
    const y = await integration(orgY, 'r12by')
    await account(y, 'dingtalk', x.user, 'Org Y')

    const unscoped = await expectPolicyRequired(x.user)
    const scopedToY = await resolveOn(x.user, { orgId: orgY })

    expect(unscoped.orgId).toBe(x.org)
    expect(scopedToY.primaryTitle).toBe('Org Y')
  })

  it('R13 a preview override skips the check, both as an integration and as null', async () => {
    const { user, a, accountB } = await twoPullFixture('r13')
    await makeNewest(accountB)

    const asIfA = await resolveOn(user, { overrideCanonicalIntegrationId: a })
    const forcedLegacy = await resolveOn(user, { overrideCanonicalIntegrationId: null })

    expect(asIfA.primaryTitle).toBe('Source A')
    expect(forcedLegacy.primaryTitle).toBe('Source B')
  })

  it('R14 policy_required carries the organisation and the count in typed properties only', async () => {
    const { org, user, a, b } = await twoPullFixture('r14')
    await integration(org, 'r14-c')

    const error = await expectPolicyRequired(user)

    expect(error.name).toBe('ApprovalRoutingPolicyError')
    expect(error.orgId).toBe(org)
    expect(error.sourceCount).toBe(3)
    expect(error.message).toBe(POLICY_REQUIRED_MESSAGE)
    expect(error.message).not.toContain(org)
    expect(error.message).not.toContain(user)
    expect(error.message).not.toContain(STAMP)
    expect(error.message).not.toContain(a)
    expect(error.message).not.toContain(b)
    expect(error.message).not.toMatch(/\d/)
  })

  it('R14 a policy that points at a non-active integration keeps its reason and sentence', async () => {
    const { org, user, a } = await twoPullFixture('r14c')
    await setPolicy(org, a)
    await setStatus(a, 'disabled')

    const error = await rejectionOn(user)

    expect(error).toBeInstanceOf(ApprovalRoutingPolicyError)
    expect((error as ApprovalRoutingPolicyError).reason).toBe('canonical_unavailable')
    expect((error as ApprovalRoutingPolicyError).message).toBe(
      `the approval_routing policy for org "${org}" points at a 'disabled' integration; fix the routing policy`,
    )
  })

  it('R14 policies in two organisations of one requester keep their reason and sentence', async () => {
    const x = await twoPullFixture('r14mx')
    const orgY = newOrg('r14my')
    const y = await integration(orgY, 'r14my')
    await account(y, 'dingtalk', x.user, 'Org Y')
    await setPolicy(x.org, x.a)
    await setPolicy(orgY, y)

    const error = await rejectionOn(x.user)

    expect(error).toBeInstanceOf(ApprovalRoutingPolicyError)
    expect((error as ApprovalRoutingPolicyError).reason).toBe('multi_org_ambiguous')
    expect((error as ApprovalRoutingPolicyError).message).toBe(
      'approval routing is policy-managed in 2 orgs this user is linked in; multi-org routing requires explicit resolution',
    )
  })

  it('R15 the check writes nothing: integration and policy rows keep their content and row version', async () => {
    const refused = await twoPullFixture('r15a')
    const governed = await twoPullFixture('r15b')
    await setPolicy(governed.org, governed.a)
    const single = newOrg('r15c')
    const singleUser = await seedUser('r15c')
    await account(await integration(single, 'r15c'), 'dingtalk', singleUser, 'Only source')
    const orgs = [refused.org, governed.org, single]
    const snapshot = async (): Promise<unknown[]> => {
      const integrations = await query(
        `SELECT 'integration' AS kind, i.xmin::text AS row_version, to_jsonb(i)::text AS content
           FROM directory_integrations i WHERE i.org_id = ANY($1::text[]) ORDER BY i.id`,
        [orgs],
      )
      const policies = await query(
        `SELECT 'policy' AS kind, p.xmin::text AS row_version, to_jsonb(p)::text AS content
           FROM org_directory_routing_policy p WHERE p.org_id = ANY($1::text[]) ORDER BY p.org_id, p.purpose`,
        [orgs],
      )
      return [...integrations.rows, ...policies.rows]
    }

    const before = await snapshot()
    await expectPolicyRequired(refused.user)
    await expectPolicyRequired(refused.user, { orgId: refused.org })
    await resolveOn(governed.user)
    await resolveOn(singleUser)
    const after = await snapshot()

    expect(before).toHaveLength(6)
    expect(after).toEqual(before)
  })

  it('R16 a requester whose only link is pending is not reached by the check', async () => {
    const org = newOrg('r16p')
    const user = await seedUser('r16p')
    const a = await integration(org, 'r16p-a')
    await integration(org, 'r16p-b')
    await account(a, 'dingtalk', user, 'Pending link', { linkStatus: 'pending' })

    const off = await resolveOff(user)
    const on = await resolveOn(user)

    expect(on).toEqual({})
    expect(on).toEqual(off)
  })

  it('R16 a requester whose only account is inactive is not reached by the check', async () => {
    const org = newOrg('r16i')
    const user = await seedUser('r16i')
    const a = await integration(org, 'r16i-a')
    await integration(org, 'r16i-b')
    await account(a, 'dingtalk', user, 'Inactive account', { isActive: false })

    const off = await resolveOff(user)
    const on = await resolveOn(user)

    expect(on).toEqual({})
    expect(on).toEqual(off)
  })

  it('R16 a requester whose only account is local is reached: the rule is per organisation', async () => {
    const org = newOrg('r16l')
    const user = await seedUser('r16l')
    await integration(org, 'r16l-a')
    await integration(org, 'r16l-b')
    const local = await getOrCreateLocalIntegration(org)
    await account(local.id, 'local', user, 'Local only')

    const error = await expectPolicyRequired(user)

    expect(error.orgId).toBe(org)
  })

  it('R17 with a policy, a requester who has no account in the canonical source resolves to an empty result', async () => {
    const org = newOrg('r17')
    const user = await seedUser('r17')
    const a = await integration(org, 'r17-a')
    const b = await integration(org, 'r17-b')
    await account(b, 'dingtalk', user, 'Source B')
    await setPolicy(org, a)

    const on = await resolveOn(user)

    expect(on).toEqual({})
  })

  // The rule counts active integrations only, while the requester pick does not look at the
  // integration status. Should the rule ever count a non-active integration that still holds
  // linked active accounts, this case becomes "raises policy_required".
  it('R18 an active source plus a paused integration that still holds the requester\'s linked account: no error, same pick as with the switch off', async () => {
    const { user, b, accountA, accountB } = await twoPullFixture('r18')
    await setStatus(b, 'paused')

    await makeNewest(accountA)
    const offNewestA = await resolveOff(user)
    const onNewestA = await resolveOn(user)
    await makeNewest(accountB)
    const offNewestB = await resolveOff(user)
    const onNewestB = await resolveOn(user)

    expect(offNewestA.primaryTitle).toBe('Source A')
    expect(onNewestA).toEqual(offNewestA)
    expect(offNewestB.primaryTitle).toBe('Source B')
    expect(offNewestB.canonicalIntegrationId).toBe(b)
    expect(onNewestB).toEqual(offNewestB)
  })

  // Without orgId the rule counts per organisation while the requester pick spans organisations.
  // Should the caller ever pass the organisation derived for the approval, the first case becomes
  // "resolves inside that organisation" and the second "raises or resolves to an empty result
  // inside that organisation".
  it('R19 without orgId, one source in each of two organisations: no error, same pick as with the switch off', async () => {
    const orgX = newOrg('r19x')
    const orgY = newOrg('r19y')
    const user = await seedUser('r19')
    const x = await integration(orgX, 'r19x')
    const y = await integration(orgY, 'r19y')
    const accountX = await account(x, 'dingtalk', user, 'Org X')
    const accountY = await account(y, 'dingtalk', user, 'Org Y')

    await makeNewest(accountX)
    const offNewestX = await resolveOff(user)
    const onNewestX = await resolveOn(user)
    await makeNewest(accountY)
    const offNewestY = await resolveOff(user)
    const onNewestY = await resolveOn(user)

    expect(offNewestX.primaryTitle).toBe('Org X')
    expect(onNewestX).toEqual(offNewestX)
    expect(offNewestY.primaryTitle).toBe('Org Y')
    expect(onNewestY).toEqual(offNewestY)
  })

  it('R19 without orgId, a member of a multi-source organisation whose accounts are all in another organisation: no error', async () => {
    const orgX = newOrg('r19mx')
    const orgY = newOrg('r19my')
    const user = await seedUser('r19m')
    await integration(orgX, 'r19mx-a')
    await integration(orgX, 'r19mx-b')
    const y = await integration(orgY, 'r19my')
    await account(y, 'dingtalk', user, 'Org Y')
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [user, orgX])

    const off = await resolveOff(user)
    const on = await resolveOn(user)

    expect(off.primaryTitle).toBe('Org Y')
    expect(on).toEqual(off)
  })

  it('R20 the leaf count statement returns the number of distinct active pull sources of one organisation', async () => {
    const localOnly = newOrg('r20l')
    await getOrCreateLocalIntegration(localOnly)
    const one = newOrg('r20o')
    await integration(one, 'r20o')
    await getOrCreateLocalIntegration(one)
    const sameEnterprise = newOrg('r20s')
    await integration(sameEnterprise, 'r20s', { nameTag: 'r20s-first' })
    await integration(sameEnterprise, 'r20s', { nameTag: 'r20s-second' })
    const two = newOrg('r20t')
    await integration(two, 'r20t-a')
    await integration(two, 'r20t-b')
    await integration(two, 'r20t-c', { status: 'paused' })
    const empty = newOrg('r20e')

    const raw = await query<{ pull_source_count: number }>(COUNT_ACTIVE_PULL_SOURCES_SQL, [two])
    const counts = {
      localOnly: await countActivePullSources(query, localOnly),
      one: await countActivePullSources(query, one),
      sameEnterprise: await countActivePullSources(query, sameEnterprise),
      two: await countActivePullSources(query, two),
      empty: await countActivePullSources(query, empty),
    }
    const requiredTwo = await isApprovalRoutingPolicyRequired(query, two)
    const requiredOne = await isApprovalRoutingPolicyRequired(query, one)
    const twoRow = await query<{ id: string }>(
      `SELECT id::text AS id FROM directory_integrations WHERE org_id = $1 AND status = 'active' ORDER BY id LIMIT 1`,
      [two],
    )
    await setPolicy(two, twoRow.rows[0].id)
    const governedTwo = await isApprovalRoutingPolicyRequired(query, two)

    expect(raw.rows).toEqual([{ pull_source_count: 2 }])
    expect(counts).toEqual({ localOnly: 0, one: 1, sameEnterprise: 1, two: 2, empty: 0 })
    expect(requiredTwo).toEqual({ required: true, sourceCount: 2, hasPolicy: false })
    expect(requiredOne).toEqual({ required: false, sourceCount: 1, hasPolicy: false })
    expect(governedTwo).toEqual({ required: false, sourceCount: 2, hasPolicy: true })
  })
})
