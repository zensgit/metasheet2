import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { getOrCreateLocalIntegration } from '../../src/directory/directory-sync'
import { ApprovalRoutingPolicyError, resolveApprovalRequesterOrgRelations } from '../../src/services/ApprovalDirectoryOrg'

/**
 * Canonical Org MVP — B5-b (routing-policy RESOLVER), design lock Lock 2 + Q4, real DB.
 *
 * `resolveApprovalRequesterOrgRelations` picks the requester's directory account. LEGACY behavior
 * guesses among a user's linked accounts by `ORDER BY a.updated_at DESC LIMIT 1` — "latest
 * integration wins", forbidden by the §6 owner ruling once an org has multiple integrations.
 * This file proves the B5-b precedence end-to-end against real Postgres:
 *
 *   A. LEGACY CONTROL (no policy): with the SAME two-integration fixture, the resolver picks the
 *      LATEST-updated account (the dingtalk one) — proving the fixture genuinely exercises the
 *      guessing path this policy exists to kill, and that a policy-less org keeps byte-identical
 *      legacy behavior (Q1 staged opt-in).
 *   B. POLICY-AUTHORITATIVE: policy → local ⇒ resolves the LOCAL account (title proves the source)
 *      even though the dingtalk account is newer; flip the policy → dingtalk ⇒ resolves dingtalk.
 *      Never "latest wins" once a policy exists.
 *   C. FAIL-CLOSED on a broken target: policy → non-active integration ⇒ typed
 *      `ApprovalRoutingPolicyError` (CONFIG error — silent fallback to guessing would defeat the
 *      policy); positive control: reactivate ⇒ resolves.
 *   D. MULTI-ORG POLICY AMBIGUITY (Q4, unscoped / no orgId): user linked in TWO orgs that BOTH
 *      have policies ⇒ typed error; delete one policy ⇒ resolves via the remaining one (a
 *      policy-less second org does not re-ambiguate — deterministic, not a guess). This remains
 *      the kernel-path contract; F proves the orgId-scoped exception.
 *   E. DATA ABSENCE ≠ CONFIG ERROR: policy → local, but the requester has NO account in the local
 *      integration ⇒ `{}` (same semantics as "no linked directory account"), NOT an error.
 *   F. TENANT BOUNDARY (options.orgId scopes the policy probe — real Postgres, not a SQL-text
 *      fake): one user linked into org A and org B.
 *        Stage 1: policy exists ONLY in B; call with orgId=A → A's org-anchored account/title is
 *          selected; B's policy neither steers the pick nor multi-org-fails.
 *        Stage 2: add an A policy while B's remains; call with orgId=A → A's CANONICAL wins
 *          (not multi-org fail-close, not B's title). Unscoped Q4 stays covered by D.
 *
 * Load-bearing mutations (out-of-band, each reds this file for the stated reason):
 *   - remove `AND a.integration_id = $2::uuid` from the policy-scoped requester query → B reds
 *     (policy→local still resolves the newer dingtalk account — guessing came back).
 *   - remove the `canonical_status !== 'active'` fail-closed check → C reds (no throw).
 *   - remove ONLY the production policy-probe predicate `AND p.org_id = $2` (orgId-scoped arm)
 *     → F reds for the RIGHT wrong-org / ambiguity reason:
 *       Stage 1 (policy only in B + orgId=A) steers to B's title instead of A's org-anchored
 *       title (foreign policy becomes visible and authoritative).
 *       Stage 2 (policies in A and B + orgId=A) throws multi-org ambiguity instead of selecting
 *       A's canonical (the tenant boundary no longer filters B out before Q4).
 *     Unit fakes that mirror SQL text are NOT sufficient evidence for this boundary — F is.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()
const orgId = (suffix: string): string => `b5b-${STAMP}-${suffix}`
const newUserId = (suffix: string): string => `b5b-user-${STAMP}-${suffix}`

const q = query

async function seedUser(id: string): Promise<void> {
  await q(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')`, [id, `${id}@example.test`, id])
}

async function dingtalkIntegration(org: string, tag: string): Promise<string> {
  const r = await q<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
     VALUES ($1, 'dingtalk', $2, 'active', $3, '{}'::jsonb) RETURNING id`,
    [org, `DT ${tag}`, `corp-${STAMP}-${tag}`],
  )
  return r.rows[0].id
}

/** Raw-link an account (provider-agnostic) to a local user with a title that names its source. */
async function linkedAccount(integrationId: string, provider: string, userId: string, title: string): Promise<string> {
  const acc = await q<{ id: string }>(
    `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, title, is_active, raw)
     VALUES ($1, $2, $3, $3, $4, $5, true, '{}'::jsonb) RETURNING id`,
    [integrationId, provider, `${provider}:${STAMP}:${userId}:${integrationId.slice(0, 8)}`, userId, title],
  )
  await q(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
     VALUES ($1, $2, 'linked', 'manual')`,
    [acc.rows[0].id, userId],
  )
  return acc.rows[0].id
}

async function setPolicy(org: string, canonical: string): Promise<void> {
  await q(
    `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id)
     VALUES ($1, 'approval_routing', $2)
     ON CONFLICT ON CONSTRAINT orp_org_purpose_uniq
     DO UPDATE SET canonical_integration_id = EXCLUDED.canonical_integration_id, updated_at = NOW()`,
    [org, canonical],
  )
}

async function bumpUpdatedAt(accountId: string): Promise<void> {
  await q(`UPDATE directory_accounts SET updated_at = NOW() + interval '1 hour' WHERE id = $1`, [accountId])
}

describeIfDatabase('Canonical Org MVP — B5-b routing-policy resolver (real DB)', () => {
  const seededOrgIds: string[] = []
  const seededUserIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      await q(`DELETE FROM org_directory_routing_policy WHERE org_id = $1`, [org])
      await q(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
    }
    for (const uid of seededUserIds.splice(0)) {
      await q(`DELETE FROM users WHERE id = $1`, [uid])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  async function twoSourceFixture(tag: string): Promise<{ org: string; user: string; localInt: string; dtInt: string }> {
    const org = orgId(tag)
    seededOrgIds.push(org)
    const user = newUserId(tag)
    seededUserIds.push(user)
    await seedUser(user)
    const local = await getOrCreateLocalIntegration(org)
    const dt = await dingtalkIntegration(org, tag)
    await linkedAccount(local.id, 'local', user, 'Local Title')
    const dtAcc = await linkedAccount(dt, 'dingtalk', user, 'DingTalk Title')
    await bumpUpdatedAt(dtAcc) // the dingtalk account is NEWER — legacy guessing picks it
    return { org, user, localInt: local.id, dtInt: dt }
  }

  it('A. legacy control (no policy): latest-updated account wins — the guessing path is real and stays byte-identical', async () => {
    const { user } = await twoSourceFixture('legacy')
    const rel = await resolveApprovalRequesterOrgRelations(user, q)
    expect(rel.primaryTitle).toBe('DingTalk Title') // latest wins — today's behavior, unchanged without a policy
  })

  it('B. policy-authoritative: policy→local resolves the LOCAL account despite the newer dingtalk one; flip→dingtalk follows the policy', async () => {
    const { org, user, localInt, dtInt } = await twoSourceFixture('auth')

    await setPolicy(org, localInt)
    const viaLocal = await resolveApprovalRequesterOrgRelations(user, q)
    expect(viaLocal.primaryTitle).toBe('Local Title') // NOT the newer dingtalk account

    await setPolicy(org, dtInt)
    const viaDt = await resolveApprovalRequesterOrgRelations(user, q)
    expect(viaDt.primaryTitle).toBe('DingTalk Title')
  })

  it('C. fail-closed on a broken canonical: non-active target throws the typed CONFIG error; reactivating resolves', async () => {
    const { org, user, localInt } = await twoSourceFixture('failclosed')
    await setPolicy(org, localInt)
    await q(`UPDATE directory_integrations SET status = 'disabled' WHERE id = $1`, [localInt])

    await expect(resolveApprovalRequesterOrgRelations(user, q)).rejects.toBeInstanceOf(ApprovalRoutingPolicyError)

    // positive control: fix the target → resolves from it (the guard rejects BROKEN policies, not all policies)
    await q(`UPDATE directory_integrations SET status = 'active' WHERE id = $1`, [localInt])
    const rel = await resolveApprovalRequesterOrgRelations(user, q)
    expect(rel.primaryTitle).toBe('Local Title')
  })

  it('D. multi-org policy ambiguity (Q4): two policy-governed orgs → typed error; removing one policy resolves via the other', async () => {
    const a = await twoSourceFixture('mo-A')
    // link the SAME user into a second org that also has a policy
    const orgB = orgId('mo-B')
    seededOrgIds.push(orgB)
    const dtB = await dingtalkIntegration(orgB, 'mo-B')
    await linkedAccount(dtB, 'dingtalk', a.user, 'OrgB Title')
    await setPolicy(a.org, a.localInt)
    await setPolicy(orgB, dtB)

    await expect(resolveApprovalRequesterOrgRelations(a.user, q)).rejects.toBeInstanceOf(ApprovalRoutingPolicyError)

    // drop org B's policy: exactly one governed org remains → deterministic resolution via it
    await q(`DELETE FROM org_directory_routing_policy WHERE org_id = $1`, [orgB])
    const rel = await resolveApprovalRequesterOrgRelations(a.user, q)
    expect(rel.primaryTitle).toBe('Local Title')
  })

  it('E. data absence is not a config error: policy→local with no local account for the requester → {}', async () => {
    const org = orgId('absent')
    seededOrgIds.push(org)
    const user = newUserId('absent')
    seededUserIds.push(user)
    await seedUser(user)
    const local = await getOrCreateLocalIntegration(org)
    const dt = await dingtalkIntegration(org, 'absent')
    await linkedAccount(dt, 'dingtalk', user, 'DingTalk Title') // linked ONLY on the dingtalk side
    await setPolicy(org, local.id)

    const rel = await resolveApprovalRequesterOrgRelations(user, q)
    expect(rel).toEqual({}) // absent from the canonical directory — not an error, same as unlinked
  })

  it('F. tenant boundary: orgId scopes the policy probe (foreign B policy cannot steer A; same-org A policy wins without multi-org fail-close)', async () => {
    // One user linked into org A (local + dingtalk, dingtalk newer) AND org B (dingtalk).
    // Titles are the discrimination channel — real Postgres rows, not a SQL-text fake.
    const orgA = orgId('tb-A')
    const orgB = orgId('tb-B')
    seededOrgIds.push(orgA, orgB)
    const user = newUserId('tb')
    seededUserIds.push(user)
    await seedUser(user)

    const localA = await getOrCreateLocalIntegration(orgA)
    const dtA = await dingtalkIntegration(orgA, 'tb-A')
    await linkedAccount(localA.id, 'local', user, 'OrgA Local Title')
    const dtAAcc = await linkedAccount(dtA, 'dingtalk', user, 'OrgA DingTalk Title')
    await bumpUpdatedAt(dtAAcc) // within A, legacy/org-anchor without policy picks dingtalk

    const dtB = await dingtalkIntegration(orgB, 'tb-B')
    const dtBAcc = await linkedAccount(dtB, 'dingtalk', user, 'OrgB Policy Title')
    await bumpUpdatedAt(dtBAcc) // B account is also very new — unscoped guessing would notice it

    // Stage 1: policy exists ONLY in B. Call with orgId=A → tenant-scoped probe sees ZERO same-org
    // policies → S7 org-anchored pick inside A (newer dingtalk) — NOT B's title, NOT multi-org throw.
    await setPolicy(orgB, dtB)
    const stage1 = await resolveApprovalRequesterOrgRelations(user, q, { orgId: orgA })
    expect(stage1.primaryTitle).toBe('OrgA DingTalk Title')
    expect(stage1.primaryTitle).not.toBe('OrgB Policy Title')
    expect(stage1.primaryTitle).not.toBe('OrgA Local Title')

    // Positive control on the same fixture: unscoped (no orgId) with only B's policy follows B
    // (one governed org → authoritative). Proves the fixture's foreign policy is real and would
    // steer if the tenant predicate were absent.
    const unscopedOnlyB = await resolveApprovalRequesterOrgRelations(user, q)
    expect(unscopedOnlyB.primaryTitle).toBe('OrgB Policy Title')

    // Stage 2: add an A policy (→ local) while B's policy remains. orgId=A must NOT multi-org
    // fail-close; A's CANONICAL (local) wins over A's newer dingtalk and over B entirely.
    await setPolicy(orgA, localA.id)
    const stage2 = await resolveApprovalRequesterOrgRelations(user, q, { orgId: orgA })
    expect(stage2.primaryTitle).toBe('OrgA Local Title')
    expect(stage2.primaryTitle).not.toBe('OrgA DingTalk Title')
    expect(stage2.primaryTitle).not.toBe('OrgB Policy Title')

    // Unscoped Q4 still fails closed with both policies present (D's contract; re-asserted here
    // so F's tenant path cannot regress into "silently pick one" without D noticing either).
    await expect(resolveApprovalRequesterOrgRelations(user, q)).rejects.toBeInstanceOf(ApprovalRoutingPolicyError)
  })
})
