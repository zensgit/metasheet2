import { afterAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { query } from '../../src/db/pg'
import { authService } from '../../src/auth/AuthService'
import { __dingtalkOAuthInternalsForTests } from '../../src/auth/dingtalk-oauth'
import { readOrgDirectoryReadiness } from '../../src/routes/attendance-admin'

/**
 * W4-PRE-1 (§3.3 item 2 + item 5's dependent, W4-0-G3): two things this file proves against a
 * real Postgres.
 *
 * 1. Org-unknowable admission paths (AuthService.register — deployment-level self-service
 *    registration; DingTalk OAuth JIT admission — no per-org context anywhere in that module)
 *    write ZERO user_orgs rows. This is the negative half of the ticket's "never silently guess
 *    an org" instruction — the dual-syntax grep in the PR body proves these are the only OTHER
 *    production create-user call sites; this test proves their behavior matches the policy
 *    comments left at each site.
 *
 * 2. W4-0-G3's two positive controls (design lock §9), pre-run here per the lock's own
 *    instruction ("两正控在 SQL/服务层验证计数语义即可" — the setup-readiness HTTP endpoint is
 *    W4-0 scope, explicitly OUT of this ticket, and is NOT built by this PR):
 *      - a pure local org (>=1 active user_orgs member, zero directory_account_links) must
 *        compute orgActiveMemberCount>0 while directoryLinked stays false — i.e. the two signals
 *        are independent, never combined as `directoryLinked && count>0`.
 *      - a DingTalk-linked org must report BOTH orgActiveMemberCount>0 and directoryLinked=true
 *        correctly at the same time.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const RUN = crypto.randomBytes(4).toString('hex')
const NS = `w4pre1policy${TS}${RUN}`

describeIfDatabase('W4-PRE-1 — org-unknowable admission paths + W4-0-G3 positive-control pre-run (real DB)', () => {
  const createdUserIds: string[] = []
  const createdIntegrationIds: string[] = []

  afterAll(async () => {
    if (createdUserIds.length) {
      await query(`DELETE FROM directory_account_links WHERE local_user_id = ANY($1::text[])`, [createdUserIds])
      await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [createdUserIds])
      await query(`DELETE FROM user_external_identities WHERE local_user_id = ANY($1::text[])`, [createdUserIds])
      await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [createdUserIds])
    }
    if (createdIntegrationIds.length) {
      await query(`DELETE FROM directory_accounts WHERE integration_id = ANY($1::uuid[])`, [createdIntegrationIds])
      await query(`DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])`, [createdIntegrationIds])
    }
  })

  describe('org-unknowable policy (never silently guess an org)', () => {
    it('AuthService.register (deployment-level registration) writes zero user_orgs rows', async () => {
      const emailAddr = `${NS}-register@example.com`
      const user = await authService.register(emailAddr, 'W4pre1-Passw0rd!', 'W4PRE1 Register')
      expect(user).toBeTruthy()
      createdUserIds.push(user!.id)

      const rows = await query(`SELECT org_id FROM user_orgs WHERE user_id = $1`, [user!.id])
      expect(rows.rows).toEqual([])
    })

    it('DingTalk OAuth JIT admission (createProvisionedUser) writes zero user_orgs rows', async () => {
      const { createProvisionedUser } = __dingtalkOAuthInternalsForTests
      const localUser = await createProvisionedUser({
        unionId: `${NS}-union`,
        nick: 'W4PRE1 DingTalk',
        email: `${NS}-dingtalk@example.com`,
      })
      createdUserIds.push(localUser.id)

      const rows = await query(`SELECT org_id FROM user_orgs WHERE user_id = $1`, [localUser.id])
      expect(rows.rows).toEqual([])
    })
  })

  describe('W4-0-G3 two positive controls (pre-run at SQL/service layer)', () => {
    async function activeMemberCount(org: string): Promise<number> {
      // Mirrors plugins/plugin-attendance/index.cjs:15532-15541 RD-3 target-population semantics
      // (§3.3 item 4): active org members = user_orgs.is_active=true AND users.is_active=true,
      // org-anchored. This is the counting query semantics being validated by G3 — the
      // setup-readiness aggregation endpoint that will eventually expose it is W4-0 scope.
      const result = await query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM user_orgs uo
           JOIN users u ON u.id = uo.user_id
          WHERE uo.org_id = $1 AND uo.is_active = true AND u.is_active = true`,
        [org],
      )
      return result.rows[0]?.n ?? 0
    }

    async function seedActiveUser(org: string, tag: string): Promise<string> {
      const id = `${NS}-g3-${tag}`
      await query(
        `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
         VALUES ($1, $2, $3, 'G3 Fixture', 'x', 'user', '[]'::jsonb, true, false, NOW(), NOW())`,
        [id, `${NS}-g3-${tag}@example.com`, `${NS}g3${tag}`],
      )
      await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [id, org])
      createdUserIds.push(id)
      return id
    }

    it('pure local org: >=1 active member, zero directory_account_links => orgActiveMemberCount>0 && directoryLinked=false', async () => {
      const org = `${NS}_g3_local`
      await seedActiveUser(org, 'local')

      const count = await activeMemberCount(org)
      expect(count).toBe(1)

      // Negative control per lock text: an implementation gated on `directoryLinked && count>0`
      // would wrongly treat this org as not-ready. Assert the two signals independently.
      const readiness = await readOrgDirectoryReadiness(org)
      expect(readiness.hasLinkedDirectoryAccounts).toBe(false)
    })

    it('DingTalk-linked org: directoryLinked=true and count>0, both correctly reported at once', async () => {
      const org = `${NS}_g3_linked`
      const userId = await seedActiveUser(org, 'linked')

      const integrationId = (
        await query<{ id: string }>(
          `INSERT INTO directory_integrations (org_id, name, corp_id, provider, status)
           VALUES ($1, $2, $3, 'dingtalk', 'active') RETURNING id::text AS id`,
          [org, `${NS}-g3-int`, `${NS}-g3-corp`],
        )
      ).rows[0].id
      createdIntegrationIds.push(integrationId)

      const accountId = (
        await query<{ id: string }>(
          `INSERT INTO directory_accounts (integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key, name, is_active)
           VALUES ($1, 'dingtalk', $2, $3, $4, $5, $6, 'G3 Linked', true) RETURNING id::text AS id`,
          [integrationId, `${NS}-g3-corp`, `${NS}-g3-ext`, `${NS}-g3-union`, `${NS}-g3-open`, `${NS}-g3-ext`],
        )
      ).rows[0].id

      await query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
         VALUES ($1, $2, 'linked', 'manual_admin')`,
        [accountId, userId],
      )

      const count = await activeMemberCount(org)
      expect(count).toBe(1)

      const readiness = await readOrgDirectoryReadiness(org)
      expect(readiness.hasLinkedDirectoryAccounts).toBe(true)
    })
  })
})
