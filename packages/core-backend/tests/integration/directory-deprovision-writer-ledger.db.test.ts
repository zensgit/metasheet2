import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { query, transaction } from '../../src/db/pg'
import { previewDeprovisionForUser, restoreDeprovisionEvent } from '../../src/directory/deprovision-evidence-api'
import { __dingtalkOAuthInternalsForTests } from '../../src/auth/dingtalk-oauth'
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
    /** Rev 4.4: seed the explicit OPS-01 deny row (disabled grant) instead of no row at all. */
    grantDisabledRow?: boolean
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
  } else if (options.grantDisabledRow === true) {
    await query(
      `INSERT INTO user_external_auth_grants (
         provider, local_user_id, enabled, granted_by, created_at, updated_at
       ) VALUES ('dingtalk', $1, FALSE, 'system:directory-deprovision', NOW(), NOW())`,
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

async function seedSameOrgActiveSibling(
  seeded: SeededDirectory,
): Promise<{ accountId: string; integrationId: string }> {
  const integration = await query<{ id: string }>(
    `INSERT INTO directory_integrations (
       name, corp_id, org_id, provider, status
     ) VALUES ($1, $2, $3, 'dingtalk', 'active')
     RETURNING id::text AS id`,
    [
      `${PREFIX}-same-org-integration-${randomUUID()}`,
      `${PREFIX}-same-org-corp-${randomUUID()}`,
      seeded.orgId,
    ],
  )
  const integrationId = integration.rows[0].id
  const account = await query<{ id: string }>(
    `INSERT INTO directory_accounts (
       integration_id, provider, external_user_id, external_key, name, is_active
     ) VALUES ($1::uuid, 'dingtalk', $2, $3, 'D4 Same Org Sibling', TRUE)
     RETURNING id::text AS id`,
    [
      integrationId,
      `${PREFIX}-same-org-external-${randomUUID()}`,
      `dingtalk:${PREFIX}:same-org:${randomUUID()}`,
    ],
  )
  await query(
    `INSERT INTO directory_account_links (
       directory_account_id, local_user_id, link_status
     ) VALUES ($1::uuid, $2, 'linked')`,
    [account.rows[0].id, seeded.userId],
  )
  return { accountId: account.rows[0].id, integrationId }
}

async function readOnlyApplyPlan(seeded: SeededDirectory) {
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
        triggeredBy: 'test:d7-preview-parity',
        policy: 'mark_inactive',
        write: false,
      },
    ),
  )
}

async function apply(
  seeded: SeededDirectory,
  options: {
    enabled?: boolean
    integrationDefaultPolicy?: 'manual_review' | 'disable_grant_only' | 'mark_inactive'
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
        integrationDefaultPolicy: options.integrationDefaultPolicy ?? 'mark_inactive',
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

    // Rev 4.4: a globally-clear candidate with NO grant row is no longer zero-effect (the deny
    // mark must be evidenced — see the rehire golden below), so the zero-effect case is now
    // "deny row already present": nothing left to change, nothing written, and the person's
    // OAuth posture is asserted UNCHANGED — the exact loophole of closeout-review P2, where the
    // zero-effect path and the effectful path disagreed about the deny row.
    it('writes no generation or evidence when the planner produces zero effects', async () => {
      const seeded = await seedDirectory({
        grantEnabled: false,
        grantDisabledRow: true,
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
      // Closeout review P2: the zero-effect run must leave OAuth loginability EXACTLY as it
      // found it — here the pre-existing deny row, which creation-only ensureGrant must honour.
      await __dingtalkOAuthInternalsForTests.ensureGrant(seeded.userId)
      const posture = await query<{ enabled: boolean; count: string }>(
        `SELECT enabled, COUNT(*) OVER ()::text AS count
           FROM user_external_auth_grants
          WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [seeded.userId],
      )
      expect(posture.rows).toHaveLength(1)
      expect(posture.rows[0].enabled).toBe(false)
    })

    // THE closeout-review golden (P1): 无既有 grant → 离岗 → rehire → OAuth. A person who never
    // had a grant is deprovisioned; Rev 4.4 requires the deny row their departure creates to be
    // ledger-evidenced (grant_row_created), so the rehire restore can DELETE it — after which
    // OAuth's creation-only ensureGrant works again. Under the pre-4.4 writer the deny row was
    // written outside the ledger and the rehired person was locked out of OAuth forever.
    it('no-grant departure evidences the deny-row creation, and rehire restore deletes it so OAuth works again', async () => {
      const seeded = await seedDirectory({
        grantEnabled: false,
        membershipActive: true,
        policy: 'mark_inactive',
      })

      const outcome = await apply(seeded)
      expect(outcome.affected).toEqual([
        {
          directoryAccountId: seeded.accountId,
          localUserId: seeded.userId,
          policy: 'mark_inactive',
          globallyClear: true,
        },
      ])

      // The deny row exists, is disabled, and its CREATION is evidenced.
      const denyRow = await query<{ enabled: boolean; granted_by: string }>(
        `SELECT enabled, granted_by FROM user_external_auth_grants
          WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [seeded.userId],
      )
      expect(denyRow.rows).toHaveLength(1)
      expect(denyRow.rows[0]).toEqual({ enabled: false, granted_by: 'system:directory-deprovision' })
      const grantEffect = await query<{
        before_active: boolean
        after_active: boolean
        grant_row_created: boolean
      }>(
        `SELECT before_active, after_active, grant_row_created
           FROM directory_deprovision_effects
          WHERE local_user_id = $1 AND effect_type = 'grant_changed'`,
        [seeded.userId],
      )
      expect(grantEffect.rows).toEqual([
        { before_active: false, after_active: false, grant_row_created: true },
      ])

      // While departed, OAuth stays blocked: creation-only ensureGrant honours the deny row.
      await __dingtalkOAuthInternalsForTests.ensureGrant(seeded.userId)
      const blocked = await query<{ enabled: boolean }>(
        `SELECT enabled FROM user_external_auth_grants
          WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [seeded.userId],
      )
      expect(blocked.rows[0].enabled).toBe(false)

      // Rehire: the directory source comes back, and the restore reverses every effect —
      // including the deny row's EXISTENCE.
      await query(
        `UPDATE directory_accounts SET is_active = TRUE WHERE id = $1::uuid`,
        [seeded.accountId],
      )
      const eventRow = await query<{ id: string }>(
        `SELECT id::text AS id FROM directory_deprovision_events
          WHERE local_user_id = $1 AND status = 'applied'`,
        [seeded.userId],
      )
      expect(eventRow.rows).toHaveLength(1)
      await restoreDeprovisionEvent({
        eventId: eventRow.rows[0].id,
        mode: 'rehire',
        adminUserId: 'admin-test',
      })

      const restored = await query<{ user_active: boolean; membership_active: boolean }>(
        `SELECT u.is_active AS user_active, m.is_active AS membership_active
           FROM users u JOIN user_orgs m ON m.user_id = u.id AND m.org_id = $2
          WHERE u.id = $1`,
        [seeded.userId, seeded.orgId],
      )
      expect(restored.rows[0]).toEqual({ user_active: true, membership_active: true })
      const rowsAfterRestore = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM user_external_auth_grants
          WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [seeded.userId],
      )
      expect(rowsAfterRestore.rows[0].count).toBe('0') // absence restored — the actual reversal

      // And the rehired person can OAuth again: ensureGrant now CREATES the enabled grant.
      await __dingtalkOAuthInternalsForTests.ensureGrant(seeded.userId)
      const loginable = await query<{ enabled: boolean }>(
        `SELECT enabled FROM user_external_auth_grants
          WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [seeded.userId],
      )
      expect(loginable.rows[0].enabled).toBe(true)
    })

    // The other zero-effect flavour: NOT globally clear (still employed via another org's
    // directory). No deny row may appear — and the never-granted person must REMAIN
    // OAuth-loginable after the run. Kills any reintroduction of the unconditional deny write.
    it('a not-globally-clear zero-effect run leaves a never-granted person OAuth-loginable', async () => {
      const seeded = await seedDirectory({
        grantEnabled: false,
        membershipActive: false,
        policy: 'mark_inactive',
      })
      await seedActiveSibling(seeded)

      const outcome = await apply(seeded)
      expect(outcome.affected).toEqual([])
      const evidence = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM directory_deprovision_events
          WHERE local_user_id = $1`,
        [seeded.userId],
      )
      expect(evidence.rows[0].count).toBe('0')
      const denyRows = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM user_external_auth_grants
          WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [seeded.userId],
      )
      expect(denyRows.rows[0].count).toBe('0')

      await __dingtalkOAuthInternalsForTests.ensureGrant(seeded.userId)
      const loginable = await query<{ enabled: boolean }>(
        `SELECT enabled FROM user_external_auth_grants
          WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [seeded.userId],
      )
      expect(loginable.rows[0].enabled).toBe(true)
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

    it('keeps preview and apply identical when a same-org sibling remains active', async () => {
      const seeded = await seedDirectory({ grantEnabled: true })
      await seedSameOrgActiveSibling(seeded)
      await query(
        `UPDATE directory_accounts SET is_active = TRUE WHERE id = $1::uuid`,
        [seeded.accountId],
      )

      const preview = await previewDeprovisionForUser(
        seeded.userId,
        seeded.integrationId,
      )
      const afterPreview = await query<{
        access_generation: string
        grant_enabled: boolean
        membership_active: boolean
        user_active: boolean
        event_count: string
      }>(
        `SELECT u.access_generation::text,
                u.is_active AS user_active,
                m.is_active AS membership_active,
                g.enabled AS grant_enabled,
                (
                  SELECT COUNT(*)::text
                    FROM directory_deprovision_events event
                   WHERE event.local_user_id = u.id
                ) AS event_count
           FROM users u
           JOIN user_orgs m ON m.user_id = u.id AND m.org_id = $2
           JOIN user_external_auth_grants g
             ON g.local_user_id = u.id AND g.provider = 'dingtalk'
          WHERE u.id = $1`,
        [seeded.userId, seeded.orgId],
      )
      expect(afterPreview.rows[0]).toEqual({
        access_generation: '7',
        grant_enabled: true,
        membership_active: true,
        user_active: true,
        event_count: '0',
      })
      await query(
        `UPDATE directory_accounts SET is_active = FALSE WHERE id = $1::uuid`,
        [seeded.accountId],
      )
      const applyPlan = await readOnlyApplyPlan(seeded)

      expect(preview.plan).toEqual(applyPlan.plan)
      expect(preview.plan.effects).toEqual([])
      expect(preview.prospectiveDeactivatedAccountIds).toEqual([
        seeded.accountId,
      ])
    })

    it('keeps preview and apply identical for a globally-clear prospective departure', async () => {
      const seeded = await seedDirectory({ grantEnabled: true })
      await query(
        `UPDATE directory_accounts SET is_active = TRUE WHERE id = $1::uuid`,
        [seeded.accountId],
      )

      const preview = await previewDeprovisionForUser(
        seeded.userId,
        seeded.integrationId,
      )
      await query(
        `UPDATE directory_accounts SET is_active = FALSE WHERE id = $1::uuid`,
        [seeded.accountId],
      )
      const applyPlan = await readOnlyApplyPlan(seeded)

      expect(preview.plan).toEqual(applyPlan.plan)
      expect(preview.plan.effects.map((effect) => effect.type).sort()).toEqual([
        'grant_changed',
        'membership_changed',
        'user_changed',
      ])
    })

    it('lets an account override replace a more conservative integration default in both preview and apply', async () => {
      const seeded = await seedDirectory({
        grantEnabled: true,
        policy: 'manual_review',
      })
      await query(
        `UPDATE directory_accounts
            SET is_active = TRUE,
                deprovision_policy_override = 'mark_inactive'
          WHERE id = $1::uuid`,
        [seeded.accountId],
      )

      const preview = await previewDeprovisionForUser(
        seeded.userId,
        seeded.integrationId,
      )
      expect(preview.plan.skipReason).toBeNull()
      expect(preview.plan.effects.map((effect) => effect.type).sort()).toEqual([
        'grant_changed',
        'membership_changed',
        'user_changed',
      ])

      await query(
        `UPDATE directory_accounts SET is_active = FALSE WHERE id = $1::uuid`,
        [seeded.accountId],
      )
      const outcome = await apply(seeded, {
        integrationDefaultPolicy: 'manual_review',
      })
      expect(outcome.usersDeactivatedCount).toBe(1)
      expect(outcome.grantsDisabledCount).toBe(1)
      expect(outcome.membershipDeactivationAttemptedCount).toBe(1)

      const event = await query<{ policy: string }>(
        `SELECT policy
           FROM directory_deprovision_events
          WHERE local_user_id = $1`,
        [seeded.userId],
      )
      expect(event.rows).toEqual([{ policy: 'mark_inactive' }])
    })

    it('keeps preview and apply identical when only a different-org sibling remains active', async () => {
      const seeded = await seedDirectory({ grantEnabled: true })
      await seedActiveSibling(seeded)
      await query(
        `UPDATE directory_accounts SET is_active = TRUE WHERE id = $1::uuid`,
        [seeded.accountId],
      )

      const preview = await previewDeprovisionForUser(
        seeded.userId,
        seeded.integrationId,
      )
      await query(
        `UPDATE directory_accounts SET is_active = FALSE WHERE id = $1::uuid`,
        [seeded.accountId],
      )
      const applyPlan = await readOnlyApplyPlan(seeded)

      expect(preview.plan).toEqual(applyPlan.plan)
      expect(preview.plan.effects).toEqual([
        {
          type: 'membership_changed',
          orgId: seeded.orgId,
          beforeActive: true,
          afterActive: false,
        },
      ])
    })
  },
)
