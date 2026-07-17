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
 *   D. MULTI-ORG POLICY AMBIGUITY (Q4): user linked in TWO orgs that BOTH have policies ⇒ typed
 *      error; delete one policy ⇒ resolves via the remaining one (a policy-less second org does
 *      not re-ambiguate — deterministic, not a guess).
 *   E. DATA ABSENCE ≠ CONFIG ERROR: policy → local, but the requester has NO account in the local
 *      integration ⇒ `{}` (same semantics as "no linked directory account"), NOT an error.
 *
 * Load-bearing mutations (out-of-band, each reds this file):
 *   - remove `AND a.integration_id = $2::uuid` from the policy-scoped requester query → B reds
 *     (policy→local still resolves the newer dingtalk account — guessing came back).
 *   - remove the `canonical_status !== 'active'` fail-closed check → C reds (no throw).
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
})
