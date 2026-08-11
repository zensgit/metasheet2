/**
 * Alias full-writer coverage — real Postgres.
 *
 * Proves positive alias rows + rollback-on-conflict for production writer classes that
 * are reachable without HTTP (flags remain OFF; no T3 batch/SSO / deprovision / env / docs).
 *
 * Load-bearing notes:
 * 1. auth_register — AuthService.register (production createUser + claim)
 * 2. helper admin_create shape — claimNonEmptyLoginAliasesOrThrow rollback only
 *    (HTTP POST /api/admin/users hook is load-bearing in admin-users-routes unit tests)
 * 3. directory_admit_activated / pending — createDirectoryAdmittedUserInTransaction
 * 4. dingtalk_jit — createProvisionedUser real email/mobile + users.mobile persist
 * 5. helper profile mobile + concurrent FOR UPDATE barrier — proves stale prior cannot
 *    be retired across concurrent writers; HTTP PATCH profile hook is in unit harness
 *
 * Production route hooks for admin create/profile are NOT claimed green by this file alone.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { AuthService } from '../../src/auth/AuthService'
import { __dingtalkOAuthInternalsForTests } from '../../src/auth/dingtalk-oauth'
import {
  applyMobileLoginAliasChangeOrThrow,
  claimNonEmptyLoginAliasesOrThrow,
  LoginAliasClaimError,
} from '../../src/auth/login-alias-service'
import { normalizeLoginIdentifier } from '../../src/auth/login-identifier'
import { query, transaction } from '../../src/db/pg'
import { __directorySyncInternalsForTests } from '../../src/directory/directory-sync'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const NS = `alias-writers-${Date.now()}`
const createdUserIds: string[] = []
const createdIntegrationIds: string[] = []

async function cleanup() {
  for (const uid of createdUserIds.splice(0, createdUserIds.length)) {
    await query(`DELETE FROM user_login_aliases WHERE user_id = $1`, [uid])
    await query(`DELETE FROM user_permissions WHERE user_id = $1`, [uid])
    await query(`DELETE FROM user_roles WHERE user_id = $1`, [uid])
    await query(`DELETE FROM user_orgs WHERE user_id = $1`, [uid])
    await query(`DELETE FROM directory_account_links WHERE local_user_id = $1`, [uid])
    await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = $1`, [uid])
    await query(`DELETE FROM user_external_identities WHERE local_user_id = $1`, [uid])
    await query(`DELETE FROM users WHERE id = $1`, [uid])
  }
  for (const integ of createdIntegrationIds.splice(0, createdIntegrationIds.length)) {
    await query(`DELETE FROM directory_account_links WHERE directory_account_id IN
      (SELECT id FROM directory_accounts WHERE integration_id = $1::uuid)`, [integ])
    await query(`DELETE FROM directory_accounts WHERE integration_id = $1::uuid`, [integ])
    await query(`DELETE FROM directory_integrations WHERE id = $1::uuid`, [integ])
  }
}

async function aliasRows(userId: string) {
  const result = await query<{ kind: string; normalized_value: string; source: string }>(
    `SELECT kind, normalized_value, source
       FROM user_login_aliases
      WHERE user_id = $1
      ORDER BY kind, normalized_value`,
    [userId],
  )
  return result.rows
}

async function userExists(userId: string): Promise<boolean> {
  const result = await query(`SELECT 1 FROM users WHERE id = $1`, [userId])
  return result.rows.length > 0
}

async function seedOccupyingAlias(normalized: string, kind: 'email' | 'username' | 'mobile' = 'email') {
  const ownerId = `${NS}-owner-${kind}-${normalized.slice(0, 12).replace(/[^a-z0-9]/gi, '')}`
  createdUserIds.push(ownerId)
  await query(
    `INSERT INTO users (id, email, name, password_hash, is_active, activation_status, local_password_set)
     VALUES ($1, $2, 'Alias Owner', 'x', TRUE, 'activated', TRUE)
     ON CONFLICT (id) DO NOTHING`,
    [ownerId, `${ownerId}@owner.example`],
  )
  await query(
    `INSERT INTO user_login_aliases (user_id, kind, normalized_value, source)
     VALUES ($1, $2, $3, 'test_seed')
     ON CONFLICT (normalized_value) DO NOTHING`,
    [ownerId, kind, normalized],
  )
  return ownerId
}

/**
 * Production-shaped mobile profile writer (lock → derive previous from lock → claim/update/retire).
 * Mirrors PATCH /api/admin/users/:userId/profile mobile path so the concurrent barrier exercises
 * the same ordering without HTTP.
 */
async function productionShapedProfileMobileChange(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  options: { userId: string; nextMobile: string | null },
): Promise<void> {
  const locked = await client.query(
    `SELECT id, mobile FROM users WHERE id = $1 FOR UPDATE`,
    [options.userId],
  )
  const row = locked.rows[0] as { id: string; mobile: string | null } | undefined
  if (!row) {
    throw Object.assign(new Error('User not found'), { code: 'NOT_FOUND' })
  }
  await applyMobileLoginAliasChangeOrThrow({
    userId: options.userId,
    previousMobile: row.mobile,
    nextMobile: options.nextMobile,
    source: 'admin_profile_mobile',
    client,
    afterNewClaim: async () => {
      await client.query(
        `UPDATE users SET mobile = $1, updated_at = NOW() WHERE id = $2`,
        [options.nextMobile, options.userId],
      )
    },
  })
}

describeIfDatabase('alias full-writer coverage (real Postgres)', () => {
  beforeEach(async () => {
    await cleanup()
  })
  afterAll(async () => {
    await cleanup()
  })

  describe('1) auth_register (AuthService.register / createUser)', () => {
    it('positive: register claims email alias row', async () => {
      const email = `${NS}-reg@example.com`
      const auth = new AuthService()
      const user = await auth.register(email, 'AliasWriter1Pass!', 'Register Writer')
      expect(user).toBeTruthy()
      createdUserIds.push(user!.id)

      const aliases = await aliasRows(user!.id)
      expect(aliases.map((a) => a.normalized_value)).toContain(normalizeLoginIdentifier(email))
      expect(aliases.some((a) => a.kind === 'email' && a.source === 'auth_register')).toBe(true)
    })

    it('conflict: rolls back users row when email alias is taken', async () => {
      const email = `${NS}-reg-conflict@example.com`
      const normalized = normalizeLoginIdentifier(email)!
      await seedOccupyingAlias(normalized, 'email')

      const auth = new AuthService()
      const user = await auth.register(email, 'AliasWriter1Pass!', 'Conflict Register')
      expect(user).toBeNull()

      const orphans = await query(
        `SELECT id FROM users WHERE lower(email) = lower($1)`,
        [email],
      )
      expect(orphans.rows).toEqual([])
    })
  })

  describe('2) helper claimNonEmptyLoginAliasesOrThrow transactional rollback (not the HTTP route)', () => {
    it('positive: helper claims email/username/mobile inside a transaction', async () => {
      const userId = `${NS}-admin-create`
      createdUserIds.push(userId)
      const email = `${NS}-admin@example.com`
      const username = `${NS}_admin_user`
      const mobile = '13700137001'

      await transaction(async (client) => {
        await client.query(
          `INSERT INTO users (
             id, email, username, name, mobile, password_hash, role, permissions,
             is_active, activation_status, local_password_set, created_at, updated_at
           ) VALUES (
             $1, $2, $3, 'Admin Create', $4, 'x', 'user', '[]'::jsonb,
             TRUE, 'activated', TRUE, NOW(), NOW()
           )`,
          [userId, email, username, mobile],
        )
        await claimNonEmptyLoginAliasesOrThrow({
          userId,
          email,
          username,
          mobile,
          source: 'admin_create',
          client,
        })
      })

      const aliases = await aliasRows(userId)
      expect(aliases.map((a) => a.normalized_value).sort()).toEqual(
        [
          normalizeLoginIdentifier(email),
          normalizeLoginIdentifier(username),
          normalizeLoginIdentifier(mobile),
        ].sort(),
      )
    })

    it('conflict: helper failure rolls back users insert when username alias is taken', async () => {
      const userId = `${NS}-admin-conflict`
      const username = `${NS}_taken_user`
      await seedOccupyingAlias(normalizeLoginIdentifier(username)!, 'username')

      await expect(
        transaction(async (client) => {
          await client.query(
            `INSERT INTO users (
               id, email, username, name, password_hash, role, permissions,
               is_active, activation_status, local_password_set, created_at, updated_at
             ) VALUES (
               $1, $2, $3, 'Conflict', 'x', 'user', '[]'::jsonb,
               TRUE, 'activated', TRUE, NOW(), NOW()
             )`,
            [userId, `${userId}@example.com`, username],
          )
          await claimNonEmptyLoginAliasesOrThrow({
            userId,
            email: `${userId}@example.com`,
            username,
            source: 'admin_create',
            client,
          })
        }),
      ).rejects.toBeInstanceOf(LoginAliasClaimError)

      expect(await userExists(userId)).toBe(false)
    })
  })

  describe('3) directory_admit activated vs pending', () => {
    async function seedAccount(tag: string) {
      const integ = await query<{ id: string }>(
        `INSERT INTO directory_integrations (name, corp_id, org_id, status, default_deprovision_policy)
         VALUES ($1, $2, $3, 'active', 'mark_inactive')
         RETURNING id::text AS id`,
        [`${NS}-${tag}`, `corp-${NS}-${tag}`, `org-${NS}-${tag}`],
      )
      const integrationId = integ.rows[0].id
      createdIntegrationIds.push(integrationId)
      const acct = await query<{ id: string }>(
        `INSERT INTO directory_accounts (
           integration_id, provider, corp_id, external_user_id, external_key,
           name, email, mobile, union_id, open_id, is_active
         )
         SELECT id, 'dingtalk', corp_id, $2, $3, 'Admit Fixture', $4, $5, $6, $7, TRUE
           FROM directory_integrations WHERE id = $1::uuid
         RETURNING id::text AS id`,
        [
          integrationId,
          `ext-${tag}`,
          `dingtalk:${NS}:${tag}`,
          `${NS}-${tag}@dir.example.com`,
          '13600136001',
          `union-${tag}`,
          `open-${tag}`,
        ],
      )
      return {
        id: acct.rows[0].id,
        integration_id: integrationId,
        provider: 'dingtalk',
        corp_id: `corp-${NS}-${tag}`,
        external_user_id: `ext-${tag}`,
        union_id: `union-${tag}`,
        open_id: `open-${tag}`,
        external_key: `dingtalk:${NS}:${tag}`,
        name: 'Admit Fixture',
        email: `${NS}-${tag}@dir.example.com`,
        mobile: '13600136001',
        is_active: true,
      }
    }

    it('positive activated (pending flag OFF): claims aliases', async () => {
      const prev = process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
      delete process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
      try {
        const account = await seedAccount('act')
        const { createDirectoryAdmittedUserInTransaction } = __directorySyncInternalsForTests
        const created = await transaction(async (client) =>
          createDirectoryAdmittedUserInTransaction(client, {
            account: account as never,
            adminUserId: 'admin-alias-test',
            name: 'Admit Activated',
            email: account.email,
            username: `${NS}_dir_user`,
            mobile: account.mobile,
            passwordHash: 'x',
            mustChangePassword: true,
            enableDingTalkGrant: false,
          }),
        )
        createdUserIds.push(created.userId)
        const aliases = await aliasRows(created.userId)
        expect(aliases.map((a) => a.normalized_value)).toEqual(
          expect.arrayContaining([
            normalizeLoginIdentifier(account.email),
            normalizeLoginIdentifier(`${NS}_dir_user`),
            normalizeLoginIdentifier(account.mobile),
          ]),
        )
        expect(aliases.every((a) => a.source === 'directory_admit')).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
        else process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = prev
      }
    })

    it('pending_activation (flag ON): claims nothing', async () => {
      const prev = process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
      process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = '1'
      try {
        const account = await seedAccount('pend')
        const { createDirectoryAdmittedUserInTransaction } = __directorySyncInternalsForTests
        const created = await transaction(async (client) =>
          createDirectoryAdmittedUserInTransaction(client, {
            account: account as never,
            adminUserId: 'admin-alias-test',
            name: 'Admit Pending',
            email: account.email,
            username: `${NS}_dir_pending`,
            mobile: account.mobile,
            passwordHash: 'x',
            mustChangePassword: true,
            enableDingTalkGrant: false,
          }),
        )
        createdUserIds.push(created.userId)
        const status = await query<{ activation_status: string }>(
          `SELECT activation_status FROM users WHERE id = $1`,
          [created.userId],
        )
        expect(status.rows[0]?.activation_status).toBe('pending_activation')
        expect(await aliasRows(created.userId)).toEqual([])
      } finally {
        if (prev === undefined) delete process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
        else process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = prev
      }
    })

    it('activated conflict: rolls back users + bind (no orphan)', async () => {
      const prev = process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
      delete process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
      try {
        const account = await seedAccount('conf')
        const taken = normalizeLoginIdentifier(account.email)!
        await seedOccupyingAlias(taken, 'email')

        const { createDirectoryAdmittedUserInTransaction } = __directorySyncInternalsForTests
        await expect(
          transaction(async (client) =>
            createDirectoryAdmittedUserInTransaction(client, {
              account: account as never,
              adminUserId: 'admin-alias-test',
              name: 'Admit Conflict',
              email: account.email,
              username: `${NS}_dir_conflict`,
              mobile: null,
              passwordHash: 'x',
              mustChangePassword: true,
              enableDingTalkGrant: false,
            }),
          ),
        ).rejects.toBeInstanceOf(LoginAliasClaimError)

        const orphans = await query(
          `SELECT id FROM users WHERE lower(email) = lower($1)`,
          [account.email],
        )
        expect(orphans.rows).toEqual([])
      } finally {
        if (prev === undefined) delete process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
        else process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = prev
      }
    })
  })

  describe('4) dingtalk_jit createProvisionedUser', () => {
    it('positive: persists users.mobile and claims real email + mobile; never placeholder', async () => {
      const { createProvisionedUser } = __dingtalkOAuthInternalsForTests
      const email = `${NS}-dt@example.com`
      const mobile = '13500135001'
      const localUser = await createProvisionedUser({
        unionId: `${NS}-union-real`,
        nick: 'DT Real',
        email,
        mobile,
      })
      createdUserIds.push(localUser.id)

      const userRow = await query<{ mobile: string | null; email: string }>(
        `SELECT mobile, email FROM users WHERE id = $1`,
        [localUser.id],
      )
      expect(userRow.rows[0]?.mobile).toBe(mobile)
      expect(userRow.rows[0]?.email).toBe(email)

      const aliases = await aliasRows(localUser.id)
      expect(aliases.map((a) => a.normalized_value).sort()).toEqual(
        [normalizeLoginIdentifier(email), normalizeLoginIdentifier(mobile)].sort(),
      )
      expect(aliases.every((a) => a.source === 'dingtalk_jit')).toBe(true)
      expect(aliases.some((a) => a.normalized_value.includes('placeholder'))).toBe(false)
    })

    it('placeholder-only provision (no mobile): users.mobile null, zero alias rows', async () => {
      const { createProvisionedUser } = __dingtalkOAuthInternalsForTests
      const localUser = await createProvisionedUser({
        unionId: `${NS}-union-ph`,
        nick: 'DT Placeholder',
        // no email / mobile → synthetic placeholder email on users.email
      })
      createdUserIds.push(localUser.id)
      expect(localUser.email).toMatch(/@placeholder\.local$/i)

      const userRow = await query<{ mobile: string | null; email: string }>(
        `SELECT mobile, email FROM users WHERE id = $1`,
        [localUser.id],
      )
      expect(userRow.rows[0]?.email).toMatch(/@placeholder\.local$/i)
      expect(userRow.rows[0]?.mobile).toBeNull()
      expect(await aliasRows(localUser.id)).toEqual([])
    })

    it('real email without mobile: users.mobile null, email alias only (no placeholder claim)', async () => {
      const { createProvisionedUser } = __dingtalkOAuthInternalsForTests
      const email = `${NS}-dt-email-only@example.com`
      const localUser = await createProvisionedUser({
        unionId: `${NS}-union-email-only`,
        nick: 'DT Email Only',
        email,
      })
      createdUserIds.push(localUser.id)

      const userRow = await query<{ mobile: string | null }>(
        `SELECT mobile FROM users WHERE id = $1`,
        [localUser.id],
      )
      expect(userRow.rows[0]?.mobile).toBeNull()
      const aliases = await aliasRows(localUser.id)
      expect(aliases.map((a) => a.normalized_value)).toEqual([normalizeLoginIdentifier(email)])
      expect(aliases.some((a) => a.kind === 'mobile')).toBe(false)
    })

    it('conflict: rolls back users row when real email alias taken', async () => {
      const email = `${NS}-dt-conflict@example.com`
      await seedOccupyingAlias(normalizeLoginIdentifier(email)!, 'email')
      const { createProvisionedUser } = __dingtalkOAuthInternalsForTests

      await expect(
        createProvisionedUser({
          unionId: `${NS}-union-conf`,
          nick: 'DT Conflict',
          email,
        }),
      ).rejects.toMatchObject({ code: 'auto_provision_alias_conflict' })

      const orphans = await query(
        `SELECT id FROM users WHERE lower(email) = lower($1)`,
        [email],
      )
      expect(orphans.rows).toEqual([])
    })
  })

  describe('5) profile mobile helper + concurrent FOR UPDATE barrier', () => {
    it('positive: claims new mobile, updates row, retires prior owned alias only', async () => {
      const userId = `${NS}-profile`
      createdUserIds.push(userId)
      const prior = '13400134001'
      const next = '13400134002'
      await query(
        `INSERT INTO users (id, email, name, mobile, password_hash, is_active, activation_status, local_password_set)
         VALUES ($1, $2, 'Profile User', $3, 'x', TRUE, 'activated', TRUE)`,
        [userId, `${userId}@example.com`, prior],
      )
      await query(
        `INSERT INTO user_login_aliases (user_id, kind, normalized_value, source)
         VALUES ($1, 'mobile', $2, 'seed')`,
        [userId, normalizeLoginIdentifier(prior)],
      )
      const otherId = `${NS}-profile-other`
      createdUserIds.push(otherId)
      await query(
        `INSERT INTO users (id, email, name, mobile, password_hash, is_active, activation_status, local_password_set)
         VALUES ($1, $2, 'Other', $3, 'x', TRUE, 'activated', TRUE)`,
        [otherId, `${otherId}@example.com`, '13400134999'],
      )
      await query(
        `INSERT INTO user_login_aliases (user_id, kind, normalized_value, source)
         VALUES ($1, 'mobile', $2, 'seed')`,
        [otherId, normalizeLoginIdentifier('13400134999')],
      )

      await transaction(async (client) => {
        await productionShapedProfileMobileChange(client, { userId, nextMobile: next })
      })

      const mobile = await query<{ mobile: string }>(`SELECT mobile FROM users WHERE id = $1`, [userId])
      expect(mobile.rows[0]?.mobile).toBe(next)
      const aliases = await aliasRows(userId)
      expect(aliases.map((a) => a.normalized_value)).toEqual([normalizeLoginIdentifier(next)])
      const otherAliases = await aliasRows(otherId)
      expect(otherAliases.map((a) => a.normalized_value)).toEqual([
        normalizeLoginIdentifier('13400134999'),
      ])
    })

    it('conflict: does not replace users.mobile when new mobile alias is taken', async () => {
      const userId = `${NS}-profile-conf`
      createdUserIds.push(userId)
      const prior = '13300133001'
      const next = '13300133002'
      await query(
        `INSERT INTO users (id, email, name, mobile, password_hash, is_active, activation_status, local_password_set)
         VALUES ($1, $2, 'Profile Conflict', $3, 'x', TRUE, 'activated', TRUE)`,
        [userId, `${userId}@example.com`, prior],
      )
      await query(
        `INSERT INTO user_login_aliases (user_id, kind, normalized_value, source)
         VALUES ($1, 'mobile', $2, 'seed')`,
        [userId, normalizeLoginIdentifier(prior)],
      )
      await seedOccupyingAlias(normalizeLoginIdentifier(next)!, 'mobile')

      await expect(
        transaction(async (client) => {
          await productionShapedProfileMobileChange(client, { userId, nextMobile: next })
        }),
      ).rejects.toBeInstanceOf(LoginAliasClaimError)

      const mobile = await query<{ mobile: string }>(`SELECT mobile FROM users WHERE id = $1`, [userId])
      expect(mobile.rows[0]?.mobile).toBe(prior)
      const aliases = await aliasRows(userId)
      expect(aliases.map((a) => a.normalized_value)).toEqual([normalizeLoginIdentifier(prior)])
    })

    it('concurrent barrier: FOR UPDATE derives previous from lock so stale retire cannot orphan intermediate alias', async () => {
      const userId = `${NS}-profile-race`
      createdUserIds.push(userId)
      const m1 = '13200132001'
      const m2 = '13200132002'
      const m3 = '13200132003'
      await query(
        `INSERT INTO users (id, email, name, mobile, password_hash, is_active, activation_status, local_password_set)
         VALUES ($1, $2, 'Race User', $3, 'x', TRUE, 'activated', TRUE)`,
        [userId, `${userId}@example.com`, m1],
      )
      await query(
        `INSERT INTO user_login_aliases (user_id, kind, normalized_value, source)
         VALUES ($1, 'mobile', $2, 'seed')`,
        [userId, normalizeLoginIdentifier(m1)],
      )

      const pool = new Pool({ connectionString: process.env.DATABASE_URL })
      const holder = await pool.connect()
      const waiter = await pool.connect()

      // Pin the barrier to this two-connection chain only — never any other
      // Lock-waiting FOR UPDATE in the database (unrelated concurrent tests).
      const holderPid = holder.processID
      const waiterPid = waiter.processID
      expect(typeof holderPid).toBe('number')
      expect(typeof waiterPid).toBe('number')
      expect(holderPid).toBeGreaterThan(0)
      expect(waiterPid).toBeGreaterThan(0)
      expect(holderPid).not.toBe(waiterPid)

      async function waitForWaiterBlockedByHolder(): Promise<void> {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const result = await pool.query<{ blocked: boolean }>(
            `SELECT EXISTS (
               SELECT 1
                 FROM pg_stat_activity a
                WHERE a.pid = $1::int
                  AND a.wait_event_type = 'Lock'
                  AND $2::int = ANY (pg_blocking_pids(a.pid))
             ) AS blocked`,
            [waiterPid, holderPid],
          )
          if (result.rows[0]?.blocked === true) return
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw new Error(
          `timed out waiting for waiter pid=${waiterPid} Lock-blocked by holder pid=${holderPid}`,
        )
      }

      try {
        // Client A (holder): lock the row with the original mobile still visible.
        await holder.query('BEGIN')
        await holder.query(`SELECT id, mobile FROM users WHERE id = $1 FOR UPDATE`, [userId])

        // Client B (waiter): production-shaped mobile change to m3 — blocks on FOR UPDATE.
        // If it used a STALE previous=m1 (pre-txn snapshot), after A commits m1→m2 it would
        // claim m3, update to m3, and retire m1 (already gone) — leaving m2 orphaned.
        const waiterPromise = (async () => {
          await waiter.query('BEGIN')
          await productionShapedProfileMobileChange(waiter, { userId, nextMobile: m3 })
          await waiter.query('COMMIT')
        })()

        await waitForWaiterBlockedByHolder()

        // While B is blocked, A performs an intermediate mobile write m1→m2 (with aliases).
        await applyMobileLoginAliasChangeOrThrow({
          userId,
          previousMobile: m1,
          nextMobile: m2,
          source: 'concurrent_intermediate',
          client: holder,
          afterNewClaim: async () => {
            await holder.query(
              `UPDATE users SET mobile = $1, updated_at = NOW() WHERE id = $2`,
              [m2, userId],
            )
          },
        })
        await holder.query('COMMIT')

        await waiterPromise

        const mobile = await query<{ mobile: string }>(
          `SELECT mobile FROM users WHERE id = $1`,
          [userId],
        )
        expect(mobile.rows[0]?.mobile).toBe(m3)

        const aliases = await aliasRows(userId)
        // Only m3 must remain. If B retired stale m1 instead of authoritative m2,
        // m2 would still be present (the discriminating orphan).
        expect(aliases.map((a) => a.normalized_value)).toEqual([normalizeLoginIdentifier(m3)])
        expect(aliases.map((a) => a.normalized_value)).not.toContain(normalizeLoginIdentifier(m1))
        expect(aliases.map((a) => a.normalized_value)).not.toContain(normalizeLoginIdentifier(m2))
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined)
        await waiter.query('ROLLBACK').catch(() => undefined)
        holder.release()
        waiter.release()
        await pool.end()
      }
    })
  })
})
