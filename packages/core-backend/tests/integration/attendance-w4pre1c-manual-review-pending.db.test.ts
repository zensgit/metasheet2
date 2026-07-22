import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { applyDirectoryDeprovisionPolicies } from '../../src/directory/directory-sync'

/**
 * W4-PRE-1c item B, owner case ④ ("人工复核") — owner 裁决②, 逐字: "manual_review 则保持
 * active 并暴露待人工确认状态".
 *
 * Run with `enabled: true` (not the default-off preview) — deliberately, so a mutation that
 * moves the `user_orgs` deactivation call INSIDE the `manual_review` branch (mutation ③, owner
 * E) actually fires and this test catches it. Running disabled would make such a mutation
 * unreachable regardless of correctness (the write is gated on `enabled` either way) and the
 * test would pass for the wrong reason.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const uid = (name: string) => `w4pre1cmr-${name}-${TS}`

describeIfDatabase('W4-PRE-1c case ④ — manual_review keeps membership ACTIVE and exposes a pending-confirmation state (real DB)', () => {
  let integrationId = ''
  let orgId = ''

  const client = {
    query: (sql: string, params?: unknown[]) =>
      query(sql, params).then((r) => ({ rows: r.rows as Array<Record<string, unknown>> })),
  }

  const membershipIsActive = async (userId: string, org: string): Promise<boolean | null> => {
    const result = await query<{ is_active: boolean }>(`SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [userId, org])
    return result.rows[0]?.is_active ?? null
  }

  beforeAll(async () => {
    const row = (await query<{ id: string; org_id: string }>(
      `INSERT INTO directory_integrations (name, corp_id, org_id, default_deprovision_policy)
       VALUES ($1, $2, $3, 'manual_review') RETURNING id::text AS id, org_id`,
      [`w4pre1cmr-${TS}`, `w4pre1cmr-corp-${TS}`, `w4pre1cmr-org-${TS}`],
    )).rows[0]
    integrationId = row.id
    orgId = row.org_id
  })

  afterEach(async () => {
    await query(`DELETE FROM user_external_auth_grants WHERE local_user_id LIKE $1`, [`w4pre1cmr-%-${TS}`])
    await query(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [`w4pre1cmr-%-${TS}`])
    await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId]) // links cascade
    await query(`DELETE FROM users WHERE id LIKE $1`, [`w4pre1cmr-%-${TS}`])
  })

  afterAll(async () => {
    await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
  })

  it('manual_review: membership stays ACTIVE, no grant/user write, and the pending state is exposed org/membership-scoped', async () => {
    const user = uid('pending')
    await query(`INSERT INTO users (id, password_hash, is_active) VALUES ($1, 'x', true)`, [user])
    const external = `${user}-acct`
    const account = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active)
       VALUES ($1, $2, $3, 'Fixture', false) RETURNING id::text AS id`,
      [integrationId, external, `dingtalk:${external}`],
    )
    const accountId = account.rows[0].id
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status) VALUES ($1::uuid, $2, 'linked')`,
      [accountId, user],
    )
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [user, orgId])

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      integrationId,
      deactivatedAccountIds: [accountId],
      syncedAccountCount: 50,
      integrationDefaultPolicy: 'manual_review',
      enabled: true, // deliberately enabled — see file doc-comment for why this matters
    })

    expect(outcome.candidateCount).toBe(1)
    expect(outcome.manualReviewCount).toBe(1)
    expect(outcome.affected).toEqual([])
    expect(outcome.usersDeactivatedCount).toBe(0)
    expect(outcome.grantsDisabledCount).toBe(0)

    // THE LOAD-BEARING ASSERTION for mutation ③ (owner E): manual_review must never deactivate
    // user_orgs, even when the switch is on and the circuit breaker passed.
    await expect(membershipIsActive(user, orgId)).resolves.toBe(true)

    const grant = await query(`SELECT 1 FROM user_external_auth_grants WHERE local_user_id = $1`, [user])
    expect(grant.rows).toEqual([])
    const platformUser = await query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [user])
    expect(platformUser.rows[0].is_active).toBe(true)

    // The "待人工确认" exposure (owner裁决②): org/membership-scoped, values-free (ids only).
    expect(outcome.manualReviewPending).toEqual([{ directoryAccountId: accountId, localUserId: user, orgId }])
  })

  it('a per-account override to manual_review inside an otherwise mark_inactive integration ALSO stays active and pending (least-destructive-wins composition)', async () => {
    const user = uid('override')
    await query(`UPDATE directory_integrations SET default_deprovision_policy = 'mark_inactive' WHERE id = $1`, [integrationId])
    await query(`INSERT INTO users (id, password_hash, is_active) VALUES ($1, 'x', true)`, [user])
    const external = `${user}-acct`
    const account = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, deprovision_policy_override)
       VALUES ($1, $2, $3, 'Fixture', false, 'manual_review') RETURNING id::text AS id`,
      [integrationId, external, `dingtalk:${external}`],
    )
    const accountId = account.rows[0].id
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status) VALUES ($1::uuid, $2, 'linked')`,
      [accountId, user],
    )
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [user, orgId])

    const outcome = await applyDirectoryDeprovisionPolicies(client, {
      integrationId,
      deactivatedAccountIds: [accountId],
      syncedAccountCount: 50,
      integrationDefaultPolicy: 'mark_inactive',
      enabled: true,
    })

    expect(outcome.manualReviewCount).toBe(1)
    await expect(membershipIsActive(user, orgId)).resolves.toBe(true)
    expect(outcome.manualReviewPending).toEqual([{ directoryAccountId: accountId, localUserId: user, orgId }])

    await query(`UPDATE directory_integrations SET default_deprovision_policy = 'manual_review' WHERE id = $1`, [integrationId])
  })
})
