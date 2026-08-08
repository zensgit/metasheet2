import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { query, transaction } from '../../src/db/pg'
import { applyDirectoryDeprovisionCandidate } from '../../src/directory/deprovision-ledger'
import { applyDirectoryDeprovisionPolicies } from '../../src/directory/directory-sync'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const PREFIX = `d4-writer-${TS}`

type SeededDirectory = {
  accountId: string
  integrationId: string
  orgId: string
  runId: string
  userId: string
}

async function cleanup(): Promise<void> {
  await query(
    `DELETE FROM directory_deprovision_events
      WHERE local_user_id LIKE $1`,
    [`${PREFIX}-%`],
  )
  await query(
    `DELETE FROM user_external_auth_grants
      WHERE local_user_id LIKE $1`,
    [`${PREFIX}-%`],
  )
  await query(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [`${PREFIX}-%`])
  await query(`DELETE FROM directory_integrations WHERE org_id LIKE $1`, [
    `${PREFIX}-%`,
  ])
  await query(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}-%`])
}

async function seedDirectory(
  options: {
    grantEnabled?: boolean
    membershipActive?: boolean
    policy?: 'manual_review' | 'disable_grant_only' | 'mark_inactive'
  } = {},
): Promise<SeededDirectory> {
  const orgId = `${PREFIX}-org-${randomUUID()}`
  const userId = `${PREFIX}-user-${randomUUID()}`
  const integration = await query<{ id: string }>(
    `INSERT INTO directory_integrations (
       name, corp_id, org_id, provider, status, default_deprovision_policy
     ) VALUES ($1, $2, $3, 'dingtalk', 'active', $4)
     RETURNING id::text AS id`,
    [
      `${PREFIX}-integration-${randomUUID()}`,
      `${PREFIX}-corp-${randomUUID()}`,
      orgId,
      options.policy ?? 'mark_inactive',
    ],
  )
  const integrationId = integration.rows[0].id
  const run = await query<{ id: string }>(
    `INSERT INTO directory_sync_runs (
       integration_id, status, triggered_by, trigger_source
     ) VALUES ($1::uuid, 'success', 'test:d4-writer', 'manual')
     RETURNING id::text AS id`,
    [integrationId],
  )
  await query(
    `INSERT INTO users (
       id, password_hash, is_active, activation_status, access_generation
     ) VALUES ($1, 'x', TRUE, 'activated', 7)`,
    [userId],
  )
  if (options.membershipActive !== false) {
    await query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, TRUE)`,
      [userId, orgId],
    )
  } else {
    await query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, FALSE)`,
      [userId, orgId],
    )
  }
  const account = await query<{ id: string }>(
    `INSERT INTO directory_accounts (
       integration_id, provider, external_user_id, external_key, name, is_active
     ) VALUES ($1::uuid, 'dingtalk', $2, $3, 'D4 Writer', FALSE)
     RETURNING id::text AS id`,
    [
      integrationId,
      `${PREFIX}-external-${randomUUID()}`,
      `dingtalk:${PREFIX}:${randomUUID()}`,
    ],
  )
  const accountId = account.rows[0].id
  await query(
    `INSERT INTO directory_account_links (
       directory_account_id, local_user_id, link_status
     ) VALUES ($1::uuid, $2, 'linked')`,
    [accountId, userId],
  )
  if (options.grantEnabled === true) {
    await query(
      `INSERT INTO user_external_auth_grants (
         provider, local_user_id, enabled, granted_by, created_at, updated_at
       ) VALUES ('dingtalk', $1, TRUE, 'test:d4-writer', NOW(), NOW())`,
      [userId],
    )
  }
  return {
    accountId,
    integrationId,
    orgId,
    runId: run.rows[0].id,
    userId,
  }
}

async function seedActiveSibling(
  seeded: SeededDirectory,
): Promise<{ integrationId: string; orgId: string }> {
  const orgId = `${PREFIX}-sibling-org-${randomUUID()}`
  const integration = await query<{ id: string }>(
    `INSERT INTO directory_integrations (
       name, corp_id, org_id, provider, status
     ) VALUES ($1, $2, $3, 'dingtalk', 'active')
     RETURNING id::text AS id`,
    [
      `${PREFIX}-sibling-integration-${randomUUID()}`,
      `${PREFIX}-sibling-corp-${randomUUID()}`,
      orgId,
    ],
  )
  const integrationId = integration.rows[0].id
  const account = await query<{ id: string }>(
    `INSERT INTO directory_accounts (
       integration_id, provider, external_user_id, external_key, name, is_active
     ) VALUES ($1::uuid, 'dingtalk', $2, $3, 'D4 Sibling', TRUE)
     RETURNING id::text AS id`,
    [
      integrationId,
      `${PREFIX}-sibling-external-${randomUUID()}`,
      `dingtalk:${PREFIX}:sibling:${randomUUID()}`,
    ],
  )
  await query(
    `INSERT INTO directory_account_links (
       directory_account_id, local_user_id, link_status
     ) VALUES ($1::uuid, $2, 'linked')`,
    [account.rows[0].id, seeded.userId],
  )
  await query(
    `INSERT INTO user_orgs (user_id, org_id, is_active)
     VALUES ($1, $2, TRUE)`,
    [seeded.userId, orgId],
  )
  return { integrationId, orgId }
}

async function apply(
  seeded: SeededDirectory,
  options: {
    enabled?: boolean
    runId?: string
  } = {},
) {
  return transaction(async (client) =>
    applyDirectoryDeprovisionPolicies(
      {
        query: async (statement, params) => {
          const result = await client.query(statement, params)
          return { rows: result.rows as Array<Record<string, unknown>> }
        },
      },
      {
        integrationId: seeded.integrationId,
        runId: options.runId ?? seeded.runId,
        triggeredBy: 'test:d4-writer',
        deactivatedAccountIds: [seeded.accountId],
        syncedAccountCount: 1,
        integrationDefaultPolicy: 'mark_inactive',
        enabled: options.enabled ?? true,
      },
    ),
  )
}

describeIfDatabase(
  'D4 deprovision writer and evidence ledger (real DB)',
  () => {
    beforeEach(cleanup)
    afterAll(cleanup)

    it('commits access-graph changes, generation, event, and typed effects together', async () => {
      const seeded = await seedDirectory({ grantEnabled: true })
      const outcome = await apply(seeded)

      expect(outcome.usersDeactivatedCount).toBe(1)
      expect(outcome.grantsDisabledCount).toBe(1)
      expect(outcome.membershipDeactivationAttemptedCount).toBe(1)

      const state = await query<{
        access_generation: string
        grant_enabled: boolean
        membership_active: boolean
        user_active: boolean
      }>(
        `SELECT u.is_active AS user_active,
              u.access_generation::text,
              m.is_active AS membership_active,
              g.enabled AS grant_enabled
         FROM users u
         JOIN user_orgs m ON m.user_id = u.id AND m.org_id = $2
         JOIN user_external_auth_grants g
           ON g.local_user_id = u.id AND g.provider = 'dingtalk'
        WHERE u.id = $1`,
        [seeded.userId, seeded.orgId],
      )
      expect(state.rows[0]).toMatchObject({
        access_generation: '8',
        grant_enabled: false,
        membership_active: false,
        user_active: false,
      })

      const event = await query<{
        access_generation_at_apply: string
        directory_account_id: string
        globally_clear: boolean
        integration_id: string
        link_witness_account_id: string
        link_witness_local_user_id: string
        local_user_id: string
        org_id: string
        policy: string
        run_id: string
        status: string
        triggered_by: string
      }>(
        `SELECT org_id, integration_id::text, directory_account_id::text, local_user_id,
              run_id::text, triggered_by, link_witness_account_id::text,
              link_witness_local_user_id, policy, globally_clear,
              access_generation_at_apply::text, status
         FROM directory_deprovision_events
        WHERE local_user_id = $1`,
        [seeded.userId],
      )
      expect(event.rows[0]).toEqual({
        access_generation_at_apply: '8',
        directory_account_id: seeded.accountId,
        globally_clear: true,
        integration_id: seeded.integrationId,
        link_witness_account_id: seeded.accountId,
        link_witness_local_user_id: seeded.userId,
        local_user_id: seeded.userId,
        org_id: seeded.orgId,
        policy: 'mark_inactive',
        run_id: seeded.runId,
        status: 'applied',
        triggered_by: 'test:d4-writer',
      })
      const effects = await query<{
        after_active: boolean
        before_active: boolean
        effect_type: string
        org_id: string | null
        status: string
      }>(
        `SELECT effect_type, org_id, before_active, after_active, status
         FROM directory_deprovision_effects
        WHERE local_user_id = $1
        ORDER BY effect_type`,
        [seeded.userId],
      )
      expect(effects.rows).toEqual([
        {
          after_active: false,
          before_active: true,
          effect_type: 'grant_changed',
          org_id: null,
          status: 'applied',
        },
        {
          after_active: false,
          before_active: true,
          effect_type: 'membership_changed',
          org_id: seeded.orgId,
          status: 'applied',
        },
        {
          after_active: false,
          before_active: true,
          effect_type: 'user_changed',
          org_id: null,
          status: 'applied',
        },
      ])
    })

    it('deactivates only the source-org membership when another org still has an active binding', async () => {
      const seeded = await seedDirectory({ grantEnabled: true })
      const sibling = await seedActiveSibling(seeded)
      const outcome = await apply(seeded)

      expect(outcome.globalCandidateCount).toBe(0)
      expect(outcome.usersDeactivatedCount).toBe(0)
      expect(outcome.grantsDisabledCount).toBe(0)
      const state = await query<{
        access_generation: string
        grant_enabled: boolean
        sibling_membership_active: boolean
        source_membership_active: boolean
        user_active: boolean
      }>(
        `SELECT u.is_active AS user_active,
              u.access_generation::text,
              source_membership.is_active AS source_membership_active,
              sibling_membership.is_active AS sibling_membership_active,
              grant_row.enabled AS grant_enabled
         FROM users u
         JOIN user_orgs source_membership
           ON source_membership.user_id = u.id AND source_membership.org_id = $2
         JOIN user_orgs sibling_membership
           ON sibling_membership.user_id = u.id AND sibling_membership.org_id = $3
         JOIN user_external_auth_grants grant_row
           ON grant_row.local_user_id = u.id AND grant_row.provider = 'dingtalk'
        WHERE u.id = $1`,
        [seeded.userId, seeded.orgId, sibling.orgId],
      )
      expect(state.rows[0]).toMatchObject({
        access_generation: '8',
        grant_enabled: true,
        sibling_membership_active: true,
        source_membership_active: false,
        user_active: true,
      })
      const effects = await query<{
        effect_type: string
        org_id: string | null
      }>(
        `SELECT effect_type, org_id
         FROM directory_deprovision_effects
        WHERE local_user_id = $1`,
        [seeded.userId],
      )
      expect(effects.rows).toEqual([
        { effect_type: 'membership_changed', org_id: seeded.orgId },
      ])
    })

    it('keeps the default-off path strictly read-only, including generation and ledger', async () => {
      const seeded = await seedDirectory({ grantEnabled: true })
      const outcome = await apply(seeded, { enabled: false })

      expect(outcome.applied).toBe(false)
      expect(outcome.usersDeactivatedCount).toBe(1)
      const state = await query<{
        access_generation: string
        grant_enabled: boolean
        membership_active: boolean
        user_active: boolean
      }>(
        `SELECT u.is_active AS user_active,
              u.access_generation::text,
              m.is_active AS membership_active,
              g.enabled AS grant_enabled
         FROM users u
         JOIN user_orgs m ON m.user_id = u.id AND m.org_id = $2
         JOIN user_external_auth_grants g
           ON g.local_user_id = u.id AND g.provider = 'dingtalk'
        WHERE u.id = $1`,
        [seeded.userId, seeded.orgId],
      )
      expect(state.rows[0]).toMatchObject({
        access_generation: '7',
        grant_enabled: true,
        membership_active: true,
        user_active: true,
      })
      const evidence = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM directory_deprovision_events
        WHERE local_user_id = $1`,
        [seeded.userId],
      )
      expect(evidence.rows[0].count).toBe('0')
    })

    it('writes no generation or evidence when the planner produces zero effects', async () => {
      const seeded = await seedDirectory({
        grantEnabled: false,
        membershipActive: false,
        policy: 'disable_grant_only',
      })
      const outcome = await transaction(async (client) =>
        applyDirectoryDeprovisionPolicies(
          {
            query: async (statement, params) => {
              const result = await client.query(statement, params)
              return { rows: result.rows as Array<Record<string, unknown>> }
            },
          },
          {
            integrationId: seeded.integrationId,
            runId: seeded.runId,
            triggeredBy: 'test:d4-writer',
            deactivatedAccountIds: [seeded.accountId],
            syncedAccountCount: 1,
            integrationDefaultPolicy: 'disable_grant_only',
            enabled: true,
          },
        ),
      )

      expect(outcome.affected).toEqual([])
      const user = await query<{
        access_generation: string
        is_active: boolean
      }>(`SELECT access_generation::text, is_active FROM users WHERE id = $1`, [
        seeded.userId,
      ])
      expect(user.rows[0]).toEqual({ access_generation: '7', is_active: true })
      const evidence = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM directory_deprovision_events
        WHERE local_user_id = $1`,
        [seeded.userId],
      )
      expect(evidence.rows[0].count).toBe('0')
    })

    it('ignores a stale transition id when the source account is active again', async () => {
      const seeded = await seedDirectory({ grantEnabled: true })
      await query(
        `UPDATE directory_accounts SET is_active = TRUE WHERE id = $1::uuid`,
        [seeded.accountId],
      )

      const outcome = await apply(seeded)

      expect(outcome.candidateCount).toBe(0)
      expect(outcome.affected).toEqual([])
      const state = await query<{
        access_generation: string
        grant_enabled: boolean
        membership_active: boolean
        user_active: boolean
      }>(
        `SELECT u.is_active AS user_active,
              u.access_generation::text,
              m.is_active AS membership_active,
              g.enabled AS grant_enabled
         FROM users u
         JOIN user_orgs m ON m.user_id = u.id AND m.org_id = $2
         JOIN user_external_auth_grants g
           ON g.local_user_id = u.id AND g.provider = 'dingtalk'
        WHERE u.id = $1`,
        [seeded.userId, seeded.orgId],
      )
      expect(state.rows[0]).toMatchObject({
        access_generation: '7',
        grant_enabled: true,
        membership_active: true,
        user_active: true,
      })
      const evidence = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM directory_deprovision_events
        WHERE local_user_id = $1`,
        [seeded.userId],
      )
      expect(evidence.rows[0].count).toBe('0')
    })

    it('skips (without writing or aborting) a direct writer call when the source account is no longer inactive', async () => {
      const seeded = await seedDirectory({ grantEnabled: true })
      await query(
        `UPDATE directory_accounts SET is_active = TRUE WHERE id = $1::uuid`,
        [seeded.accountId],
      )

      // Adversarial-review P2 absorption: this used to THROW, which aborted the ENTIRE directory
      // sync transaction for a per-candidate race — and did so even with the deprovision flag
      // OFF. The contract is now a skip: the invariant under test is unchanged (a re-activated
      // source must never be deprovisioned — zero writes below), only the failure mode moved
      // from run-fatal to candidate-scoped.
      const result = await transaction(async (client) =>
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
            triggeredBy: 'test:d4-direct-writer',
            policy: 'mark_inactive',
            write: true,
          },
        ),
      )
      expect(result.applied).toBe(false)
      expect(result.skipReason).toBe('candidate_vanished')
      expect(result.plan.effects).toEqual([])

      const user = await query<{
        access_generation: string
        is_active: boolean
      }>(`SELECT access_generation::text, is_active FROM users WHERE id = $1`, [
        seeded.userId,
      ])
      expect(user.rows[0]).toEqual({ access_generation: '7', is_active: true })
    })

    it('rolls back every access write when the evidence event cannot satisfy its run FK', async () => {
      const seeded = await seedDirectory({ grantEnabled: true })

      await expect(apply(seeded, { runId: randomUUID() })).rejects.toThrow()

      const state = await query<{
        access_generation: string
        grant_enabled: boolean
        membership_active: boolean
        user_active: boolean
      }>(
        `SELECT u.is_active AS user_active,
              u.access_generation::text,
              m.is_active AS membership_active,
              g.enabled AS grant_enabled
         FROM users u
         JOIN user_orgs m ON m.user_id = u.id AND m.org_id = $2
         JOIN user_external_auth_grants g
           ON g.local_user_id = u.id AND g.provider = 'dingtalk'
        WHERE u.id = $1`,
        [seeded.userId, seeded.orgId],
      )
      expect(state.rows[0]).toMatchObject({
        access_generation: '7',
        grant_enabled: true,
        membership_active: true,
        user_active: true,
      })
      const evidence = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM directory_deprovision_events
        WHERE local_user_id = $1`,
        [seeded.userId],
      )
      expect(evidence.rows[0].count).toBe('0')
    })
  },
)
