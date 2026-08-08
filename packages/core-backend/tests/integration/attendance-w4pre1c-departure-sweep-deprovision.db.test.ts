import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * W4-PRE-1c item A (owner 裁决②, #4522 rev3 review, 2026-07-22 — the only GitHub-persisted
 * text is issuecomment-5042388830's acknowledgment):
 * "不因单次同步缺失撤销 membership；deprovision circuit-breaker 通过 + 开关启用 + 策略实际
 * 执行时同事务失活对应 user_orgs；manual_review 保持 active 并暴露待人工确认状态。"
 *
 * Owner's case ① ("真实同步 sweep"): drives the REAL `syncDirectoryIntegration` orchestration
 * over a genuine departure (an account absent from the mocked DingTalk pull), not a hand-
 * invoked `applyDirectoryDeprovisionPolicies` call — proving the DT-OPS-01 sweep and the
 * deprovision executor compose correctly end-to-end in the production call path, both inside
 * the SAME transaction.
 *
 * Fixture pattern follows `directory-sync-orchestration.db.test.ts`'s own "departure fixture"
 * (§3, `seedDepartureFixture`): pre-seed a `directory_accounts` row with an old `last_seen_at`
 * so ONE sync (the account absent from the mock pull) both transitions the sweep AND feeds the
 * deprovision executor — no second pass needed. That file proves the executor's existing
 * `users.is_active` / grant effects; THIS file proves the NEW `user_orgs` effect (owner 裁决②)
 * on top of an initial ACTIVE `user_orgs` row that file never seeds.
 */
const clientMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  fetchDingTalkAppAccessToken: clientMocks.fetchDingTalkAppAccessToken,
  listDingTalkDepartments: clientMocks.listDingTalkDepartments,
  getDingTalkDepartmentDetail: clientMocks.getDingTalkDepartmentDetail,
  listDingTalkDepartmentUsers: clientMocks.listDingTalkDepartmentUsers,
  getDingTalkUserDetail: clientMocks.getDingTalkUserDetail,
}))

import { query } from '../../src/db/pg'
import { createDirectoryIntegration, listDirectorySyncRuns, syncDirectoryIntegration } from '../../src/directory/directory-sync'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

type Fixture = {
  integrationId: string
  orgId: string
  localUserId: string
  accountId: string
  deptId: string
  survivorExt: string
}

/** The departed account and its `user_orgs` row are pre-seeded; the survivor keeps
 * `syncedAccountCount > 0` so the empty-fetch circuit breaker never fires. */
async function seedDepartureFixture(tag: string): Promise<Fixture> {
  const integration = await createDirectoryIntegration({
    name: `w4pre1cdep-${tag}-${TS}`,
    corpId: `w4pre1cdep-corp-${tag}-${TS}`,
    appKey: `w4pre1cdep-appkey-${tag}-${TS}`,
    appSecret: 'w4pre1cdep-secret',
    admissionMode: 'manual_only',
    defaultDeprovisionPolicy: 'mark_inactive',
  })

  const localUserId = `w4pre1cdep-user-${tag}-${TS}`
  await query(`INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'x', TRUE)`, [
    localUserId,
    `${localUserId}@example.test`,
  ])
  await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [localUserId, integration.orgId])

  const account = await query<{ id: string }>(
    `INSERT INTO directory_accounts (
       integration_id, corp_id, external_user_id, union_id, external_key, name, is_active, last_seen_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $4, 'Departed', true, NOW(), NOW(), NOW())
     RETURNING id`,
    [integration.id, `w4pre1cdep-corp-${tag}-${TS}`, `w4pre1cdep-ext-${tag}-${TS}`, `w4pre1cdep-un-${tag}-${TS}`],
  )
  await query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
     VALUES ($1, $2, 'linked', 'manual', NOW(), NOW())`,
    [account.rows[0].id, localUserId],
  )

  return {
    integrationId: integration.id,
    orgId: integration.orgId,
    localUserId,
    accountId: account.rows[0].id,
    deptId: `w4pre1cdep-dept-${tag}-${TS}`,
    survivorExt: `w4pre1cdep-surv-${tag}-${TS}`,
  }
}

function armMockDirectory(fixture: Fixture): void {
  clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('w4pre1cdep-token')
  clientMocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) =>
    parentId === '1' ? [{ id: fixture.deptId, parentId: '1', name: 'W4PRE1C Departure', order: 0, source: {} }] : [],
  )
  clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
  clientMocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, deptId: string) =>
    // The departed account is deliberately NOT in the pull; the survivor keeps
    // syncedAccountCount > 0 so the empty-fetch circuit breaker stays quiet.
    deptId === fixture.deptId
      ? { users: [{ userId: fixture.survivorExt, name: 'Survivor', departmentIds: [fixture.deptId], source: {} }], nextCursor: null, hasMore: false }
      : { users: [], nextCursor: null, hasMore: false },
  )
  clientMocks.getDingTalkUserDetail.mockImplementation(async (_token: string, userId: string) => ({
    userId,
    name: 'Survivor',
    unionId: `${fixture.survivorExt}-un`,
    openId: `${fixture.survivorExt}-op`,
    email: `${fixture.survivorExt}@example.test`,
    mobile: undefined,
    departmentIds: [fixture.deptId],
    source: {},
  }))
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await query(`DELETE FROM directory_sync_alerts WHERE integration_id = $1`, [fixture.integrationId])
  await query(`DELETE FROM directory_deprovision_events WHERE integration_id = $1`, [fixture.integrationId])
  await query(`DELETE FROM directory_sync_runs WHERE integration_id = $1`, [fixture.integrationId])
  await query(
    `DELETE FROM directory_account_links WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`,
    [fixture.integrationId],
  )
  await query(
    `DELETE FROM directory_account_departments WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`,
    [fixture.integrationId],
  )
  await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [fixture.integrationId])
  await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [fixture.integrationId])
  await query(`DELETE FROM directory_integrations WHERE id = $1`, [fixture.integrationId])
  await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = $1`, [fixture.localUserId])
  await query(`DELETE FROM user_orgs WHERE user_id = $1`, [fixture.localUserId])
  await query(`DELETE FROM users WHERE id = $1`, [fixture.localUserId])
}

const membershipIsActive = async (userId: string, orgId: string): Promise<boolean | null> => {
  const result = await query<{ is_active: boolean }>(`SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [userId, orgId])
  return result.rows[0]?.is_active ?? null
}

describeIfDatabase('W4-PRE-1c case ① — real sync sweep composed with the deprovision executor (real DB)', () => {
  describe('DIRECTORY_DEPROVISION_ENABLED unset (shipped default) — the switch being off means ZERO user_orgs deactivation', () => {
    let fixture: Fixture

    afterAll(async () => {
      if (fixture) await cleanupFixture(fixture)
    })

    it('a genuine departure (sweep transitions + circuit breaker passes) writes NOTHING to user_orgs while the switch is off', async () => {
      fixture = await seedDepartureFixture('off')
      armMockDirectory(fixture)
      expect(process.env.DIRECTORY_DEPROVISION_ENABLED).toBeUndefined()

      await expect(membershipIsActive(fixture.localUserId, fixture.orgId)).resolves.toBe(true)

      const result = await syncDirectoryIntegration(fixture.integrationId, 'system:w4pre1c-dep-off', 'manual')
      const stats = result.run.stats as Record<string, unknown>

      // The sweep DID transition the account (real, unconditional) and the executor DID
      // evaluate it (candidateCount / would-be counts) — only the WRITE is gated off.
      const account = await query<{ is_active: boolean }>(`SELECT is_active FROM directory_accounts WHERE id = $1`, [fixture.accountId])
      expect(account.rows[0].is_active).toBe(false)
      expect(stats.deprovisionApplied).toBe(false)
      expect(stats.deprovisionCandidateCount).toBe(1)
      expect(stats.deprovisionUsersDeactivatedCount).toBe(1) // preview: "would have"

      // THE LOAD-BEARING ASSERTION for mutations ①/② (owner E): switch off ⇒ membership
      // stays ACTIVE, no matter where in the pipeline the sweep sits.
      await expect(membershipIsActive(fixture.localUserId, fixture.orgId)).resolves.toBe(true)

      // …and users.is_active also stayed untouched (pre-existing default-off guarantee).
      const user = await query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [fixture.localUserId])
      expect(user.rows[0].is_active).toBe(true)
    }, 30_000)
  })

  describe('DIRECTORY_DEPROVISION_ENABLED=true + circuit breaker passes + mark_inactive actually executes — SAME-transaction user_orgs deactivation', () => {
    let fixture: Fixture

    afterAll(async () => {
      if (fixture) await cleanupFixture(fixture)
      delete process.env.DIRECTORY_DEPROVISION_ENABLED
    })

    it('the departure is swept, the policy executes, and user_orgs is deactivated in the SAME run/transaction', async () => {
      fixture = await seedDepartureFixture('on')
      armMockDirectory(fixture)

      await expect(membershipIsActive(fixture.localUserId, fixture.orgId)).resolves.toBe(true)

      process.env.DIRECTORY_DEPROVISION_ENABLED = 'true'
      const result = await syncDirectoryIntegration(fixture.integrationId, 'system:w4pre1c-dep-on', 'manual')
      const stats = result.run.stats as Record<string, unknown>

      const account = await query<{ is_active: boolean }>(`SELECT is_active FROM directory_accounts WHERE id = $1`, [fixture.accountId])
      expect(account.rows[0].is_active).toBe(false)
      expect(stats.deprovisionApplied).toBe(true)
      expect(stats.deprovisionCandidateCount).toBe(1)
      expect(stats.deprovisionUsersDeactivatedCount).toBe(1)
      expect(stats.deprovisionAbortedReason).toBeNull()

      // THE LOAD-BEARING ASSERTION: circuit breaker passed + switch on + policy actually
      // executed (mark_inactive, not manual_review) ⇒ same-transaction user_orgs deactivation.
      await expect(membershipIsActive(fixture.localUserId, fixture.orgId)).resolves.toBe(false)

      const user = await query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [fixture.localUserId])
      expect(user.rows[0].is_active).toBe(false)

      // D4 orchestration pin: the production sync passed its own transaction client and real
      // run id into the writer. A second transaction or synthetic run cannot satisfy this readback.
      const evidence = await query<{
        effect_count: number
        run_id: string
      }>(
        `SELECT event.run_id::text,
                COUNT(effect.id)::int AS effect_count
           FROM directory_deprovision_events event
           JOIN directory_deprovision_effects effect ON effect.event_id = event.id
          WHERE event.local_user_id = $1
          GROUP BY event.run_id`,
        [fixture.localUserId],
      )
      // Rev 4.4: the fixture person has NO grant row, so the globally-clear departure now
      // plans a THIRD effect — the evidenced deny-row creation (grant_row_created) — on top of
      // membership_changed + user_changed.
      expect(evidence.rows).toEqual([
        { effect_count: 3, run_id: result.run.id },
      ])
      const grantEffect = await query<{ grant_row_created: boolean }>(
        `SELECT effect.grant_row_created
           FROM directory_deprovision_effects effect
          WHERE effect.local_user_id = $1 AND effect.effect_type = 'grant_changed'`,
        [fixture.localUserId],
      )
      expect(grantEffect.rows).toEqual([{ grant_row_created: true }])
    }, 30_000)
  })

  describe('D4 fail-last evidence write rolls the production sync transaction back', () => {
    let fixture: Fixture
    const triggerName = `d4_fail_event_trigger_${TS}`
    const functionName = `d4_fail_event_function_${TS}`

    afterAll(async () => {
      await query(`DROP TRIGGER IF EXISTS ${triggerName} ON directory_deprovision_events`)
      await query(`DROP FUNCTION IF EXISTS ${functionName}()`)
      if (fixture) await cleanupFixture(fixture)
      delete process.env.DIRECTORY_DEPROVISION_ENABLED
    })

    it('rolls back the account sweep and every access write when the ledger INSERT fails', async () => {
      fixture = await seedDepartureFixture('ledger-fail')
      armMockDirectory(fixture)
      process.env.DIRECTORY_DEPROVISION_ENABLED = 'true'
      await query(`
        CREATE FUNCTION ${functionName}()
        RETURNS trigger AS $$
        BEGIN
          IF NEW.local_user_id = '${fixture.localUserId}' THEN
            RAISE EXCEPTION 'D4 deterministic ledger failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `)
      await query(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON directory_deprovision_events
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()
      `)

      try {
        await expect(
          syncDirectoryIntegration(
            fixture.integrationId,
            'system:w4pre1c-d4-ledger-fail',
            'manual',
          ),
        ).rejects.toThrow('D4 deterministic ledger failure')
      } finally {
        await query(`DROP TRIGGER IF EXISTS ${triggerName} ON directory_deprovision_events`)
        await query(`DROP FUNCTION IF EXISTS ${functionName}()`)
      }

      const account = await query<{ is_active: boolean }>(
        `SELECT is_active FROM directory_accounts WHERE id = $1`,
        [fixture.accountId],
      )
      expect(account.rows[0].is_active).toBe(true)
      await expect(
        membershipIsActive(fixture.localUserId, fixture.orgId),
      ).resolves.toBe(true)
      const user = await query<{ access_generation: string; is_active: boolean }>(
        `SELECT access_generation::text, is_active FROM users WHERE id = $1`,
        [fixture.localUserId],
      )
      expect(user.rows[0]).toEqual({ access_generation: '0', is_active: true })
      const evidence = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM directory_deprovision_events
          WHERE local_user_id = $1`,
        [fixture.localUserId],
      )
      expect(evidence.rows[0].count).toBe('0')
      const runs = await listDirectorySyncRuns(fixture.integrationId, {
        limit: 1,
        offset: 0,
      })
      expect(runs.items[0]?.status).toBe('failed')
    }, 30_000)
  })
})

/** Sanity check that the new stats field the deprovision executor now writes is reachable
 * through the SAME existing admin surface `deprovisionAffected` already used
 * (`listDirectorySyncRuns` → `GET /integrations/:integrationId/runs`, see `admin-directory.ts`) —
 * proving the end of the wiring, not just the in-memory function return. Case ④'s own file
 * proves the manualReviewPending CONTENT semantics against a lighter direct-call harness; this
 * confirms the full production wiring persists it into `directory_sync_runs.stats` too.
 */
describeIfDatabase('W4-PRE-1c — manualReviewPending persists through the run-stats surface (real sync, real DB)', () => {
  let fixture: Fixture

  afterAll(async () => {
    if (fixture) await cleanupFixture(fixture)
    delete process.env.DIRECTORY_DEPROVISION_ENABLED
  })

  it('a manual_review departure appears in directory_sync_runs.stats.deprovisionManualReviewPending, and membership stays active', async () => {
    fixture = await seedDepartureFixture('review')
    await query(`UPDATE directory_integrations SET default_deprovision_policy = 'manual_review' WHERE id = $1`, [fixture.integrationId])
    armMockDirectory(fixture)

    process.env.DIRECTORY_DEPROVISION_ENABLED = 'true'
    await syncDirectoryIntegration(fixture.integrationId, 'system:w4pre1c-dep-review', 'manual')

    const runs = await listDirectorySyncRuns(fixture.integrationId, { limit: 1, offset: 0 })
    const stats = runs.items[0]?.stats as Record<string, unknown>
    expect(stats.deprovisionManualReviewPending).toEqual([
      { directoryAccountId: fixture.accountId, localUserId: fixture.localUserId, orgId: fixture.orgId },
    ])
    expect(stats.deprovisionAffected).toEqual([])

    await expect(membershipIsActive(fixture.localUserId, fixture.orgId)).resolves.toBe(true)
  }, 30_000)
})
