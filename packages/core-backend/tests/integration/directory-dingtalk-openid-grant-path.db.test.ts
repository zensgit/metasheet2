/**
 * Directory page "bind + enable DingTalk login" dead end — proved against REAL Postgres.
 *
 * DT-HARDEN-02 keeps the invariant that a corp-scoped grant needs a stable corpId+openId key.
 * This suite proves the four repairs to where that openId comes from, on the real SQL:
 *  1. the grant check accepts the openId a DingTalk login recorded for the SAME person — same
 *     corp AND same unionId — and never one from a different unionId or a different corp;
 *  2. the directory sync upsert keeps a known openId while unionId/corp are unchanged and clears
 *     it when the unionId changes;
 *  3. a DingTalk login (successful, or rejected for a missing grant) backfills the directory
 *     member row of the same corp+union, and nobody else's;
 *  4. a re-bind keeps the identity's openId for the same person and clears it for a different one.
 *  5. field item 3: a corp-less (R66-R70) identity backfills the openId into its single linked,
 *     active, same-unionId directory account, never touching the identity row; a failing lookup
 *     stays inside the backfill savepoint; user management's 「缺 OpenID」 keeps its R72 meaning, so
 *     such a member is never a 「批量关闭缺 OpenID 钉钉扫码」 candidate.
 *
 * The DingTalk HTTP client is mocked; nothing here talks to DingTalk. Section 5 points the mocks
 * back at the real client and answers its HTTP calls from a stubbed global fetch.
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  exchangeCodeForUserAccessToken: vi.fn(),
  fetchDingTalkCurrentUser: vi.fn(),
  isDingTalkConfigured: vi.fn(() => true),
  readDingTalkOauthConfig: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exchangeCodeForUserAccessToken: clientMocks.exchangeCodeForUserAccessToken,
  fetchDingTalkCurrentUser: clientMocks.fetchDingTalkCurrentUser,
  isDingTalkConfigured: clientMocks.isDingTalkConfigured,
  readDingTalkOauthConfig: clientMocks.readDingTalkOauthConfig,
}))

import { query } from '../../src/db/pg'
import { Logger } from '../../src/core/logger'
import { exchangeCodeForUser } from '../../src/auth/dingtalk-oauth'
import { __directorySyncInternalsForTests, bindDirectoryAccount, getDirectoryAccountSummary } from '../../src/directory/directory-sync'
import { authenticate } from '../../src/middleware/auth'
import { authRouter } from '../../src/routes/auth'
import { adminDirectoryRouter } from '../../src/routes/admin-directory'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { usePinnedServer } from '../utils/pinned-server'

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => query(sql, params)

// Module level on purpose (outside describeIfDb): the real-DB CI step arms EXPECT_DB=1, so a
// DATABASE_URL that does not reach this worker reds instead of skip-greening the whole file.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const RUN = `dto_${Date.now()}`
const CORP = `corp_${RUN}`
const OTHER_CORP = `corp_${RUN}_other`
const ADMIN = `admin_${RUN}`

describeIfDb('directory DingTalk grant — openId source (real DB)', () => {
  let integrationId = ''
  let otherIntegrationId = ''

  async function seedIntegration(name: string, corpId: string): Promise<string> {
    return (await q(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id::text AS id`,
      [name, corpId],
    )).rows[0].id
  }

  async function seedAccount(opts: { tag: string; unionId: string | null; openId?: string | null; integration?: string; externalKey?: string }) {
    const integration = opts.integration ?? integrationId
    const external = `emp_${RUN}_${opts.tag}`
    const row = (await q(
      `INSERT INTO directory_accounts (integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key, name, is_active)
       SELECT $1::uuid, 'dingtalk', corp_id, $2, $3, $4, $5, 'Fixture', true
       FROM directory_integrations WHERE id = $1::uuid
       RETURNING id::text AS id`,
      [integration, external, opts.unionId, opts.openId ?? null, opts.externalKey ?? (opts.unionId || external)],
    )).rows[0]
    return row.id as string
  }

  async function seedUser(tag: string): Promise<string> {
    const id = `user_${RUN}_${tag}`
    await q(
      `INSERT INTO users (id, username, name, password_hash, is_active) VALUES ($1, $1, 'Fixture', 'x', true)`,
      [id],
    )
    return id
  }

  async function seedIdentity(opts: { userId: string; corpId: string; unionId: string; openId: string | null }) {
    await q(
      `INSERT INTO user_external_identities (provider, external_key, provider_union_id, provider_open_id, corp_id, local_user_id, profile)
       VALUES ('dingtalk', $1, $2, $3, $4, $5, '{}'::jsonb)`,
      [`${opts.corpId}:${opts.openId || opts.unionId}`, opts.unionId, opts.openId, opts.corpId, opts.userId],
    )
  }

  const accountOpenId = async (accountId: string) =>
    (await q(`SELECT open_id FROM directory_accounts WHERE id = $1::uuid`, [accountId])).rows[0]?.open_id ?? null

  const identityOf = async (userId: string) =>
    (await q(
      `SELECT provider_union_id, provider_open_id FROM user_external_identities WHERE provider = 'dingtalk' AND local_user_id = $1`,
      [userId],
    )).rows[0] ?? null

  const grantOf = async (userId: string) =>
    (await q(
      `SELECT enabled FROM user_external_auth_grants WHERE provider = 'dingtalk' AND local_user_id = $1`,
      [userId],
    )).rows[0]?.enabled ?? null

  const bind = (accountId: string, userId: string, enableDingTalkGrant: boolean) =>
    bindDirectoryAccount(accountId, { localUserRef: userId, adminUserId: ADMIN, enableDingTalkGrant })

  function primeWebLogin(unionId: string, openId: string) {
    clientMocks.exchangeCodeForUserAccessToken.mockResolvedValue({ accessToken: 'user-token' })
    clientMocks.fetchDingTalkCurrentUser.mockResolvedValue({
      openId,
      unionId,
      nick: 'Fixture',
      email: undefined,
      mobile: undefined,
      avatarUrl: '',
    })
  }

  beforeAll(async () => {
    clientMocks.readDingTalkOauthConfig.mockReturnValue({
      clientId: 'dto-client',
      clientSecret: 'dto-secret',
      redirectUri: 'https://app.example.com/login/dingtalk/callback',
      corpId: CORP,
    })
    integrationId = await seedIntegration(`dto-${RUN}`, CORP)
    otherIntegrationId = await seedIntegration(`dto-${RUN}-other`, OTHER_CORP)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    const users = `user_${RUN}_%`
    await q(`DELETE FROM user_external_auth_grants WHERE local_user_id LIKE $1`, [users]).catch(() => {})
    await q(`DELETE FROM user_external_identities WHERE local_user_id LIKE $1`, [users]).catch(() => {})
    await q(`DELETE FROM user_orgs WHERE user_id LIKE $1`, [users]).catch(() => {})
    await q(
      `DELETE FROM directory_account_links WHERE directory_account_id IN (
         SELECT id FROM directory_accounts WHERE integration_id = ANY($1::uuid[]))`,
      [[integrationId, otherIntegrationId].filter(Boolean)],
    ).catch(() => {})
    await q(`DELETE FROM directory_accounts WHERE integration_id = ANY($1::uuid[])`, [[integrationId, otherIntegrationId].filter(Boolean)]).catch(() => {})
    await q(`DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])`, [[integrationId, otherIntegrationId].filter(Boolean)]).catch(() => {})
    await q(`DELETE FROM users WHERE id LIKE $1`, [users]).catch(() => {})
  })

  // ── 1. grant check: same corp + same unionId only ───────────────────────────────────────────

  it('grants a member whose openId is known only from their own DingTalk login (same corp + unionId), and the re-bind keeps it', async () => {
    const union = `union_${RUN}_same`
    const openId = `open_${RUN}_same`
    const accountId = await seedAccount({ tag: 'same', unionId: union })
    const userId = await seedUser('same')
    await seedIdentity({ userId, corpId: CORP, unionId: union, openId })
    // B1: the page verdict (same builder/predicate, real GROUP BY query) agrees before the bind
    await expect(getDirectoryAccountSummary(accountId)).resolves.toMatchObject({ openId: null, grantOpenIdAvailable: true })

    await expect(bind(accountId, userId, true)).resolves.toBeTruthy()
    await expect(grantOf(userId)).resolves.toBe(true)
    // 4. the bind's identity UPDATE did not erase the login-proven openId
    await expect(identityOf(userId)).resolves.toEqual({ provider_union_id: union, provider_open_id: openId })
    // N3: and kept the corp:openId key the login wrote (no flip to corp:unionId)
    const key = (await q(
      `SELECT external_key FROM user_external_identities WHERE provider = 'dingtalk' AND local_user_id = $1`,
      [userId],
    )).rows[0]?.external_key
    expect(key).toBe(`${CORP}:${openId}`)
  })

  it('does NOT borrow the openId of the local user\'s identity when its unionId differs', async () => {
    const accountId = await seedAccount({ tag: 'union-mismatch', unionId: `union_${RUN}_um_account` })
    const userId = await seedUser('union-mismatch')
    await seedIdentity({ userId, corpId: CORP, unionId: `union_${RUN}_um_identity`, openId: `open_${RUN}_um` })
    await expect(getDirectoryAccountSummary(accountId)).resolves.toMatchObject({ grantOpenIdAvailable: false })

    await expect(bind(accountId, userId, true)).rejects.toThrow('missing DingTalk openId')
    await expect(grantOf(userId)).resolves.toBeNull()
  })

  it('does NOT borrow an openId recorded under a different corp, even for the same unionId', async () => {
    const union = `union_${RUN}_cm`
    const accountId = await seedAccount({ tag: 'corp-mismatch', unionId: union })
    const userId = await seedUser('corp-mismatch')
    await seedIdentity({ userId, corpId: OTHER_CORP, unionId: union, openId: `open_${RUN}_cm` })
    await expect(getDirectoryAccountSummary(accountId)).resolves.toMatchObject({ grantOpenIdAvailable: false })

    await expect(bind(accountId, userId, true)).rejects.toThrow('missing DingTalk openId')
    await expect(grantOf(userId)).resolves.toBeNull()
  })

  it('a re-bind onto an identity that described a DIFFERENT person clears that person\'s openId', async () => {
    const accountUnion = `union_${RUN}_rebind_new`
    const accountId = await seedAccount({ tag: 'rebind', unionId: accountUnion })
    const userId = await seedUser('rebind')
    await seedIdentity({ userId, corpId: CORP, unionId: `union_${RUN}_rebind_old`, openId: `open_${RUN}_rebind_old` })

    await expect(bind(accountId, userId, false)).resolves.toBeTruthy()
    await expect(identityOf(userId)).resolves.toEqual({ provider_union_id: accountUnion, provider_open_id: null })
  })

  // ── 2. sync upsert ──────────────────────────────────────────────────────────────────────────

  it('the sync upsert keeps a known openId while unionId/corp are unchanged, and clears it when the unionId changes', async () => {
    const external = `emp_${RUN}_sync`
    const upsert = (unionId: string | null, openId: string | null) => q(
      __directorySyncInternalsForTests.DIRECTORY_ACCOUNT_UPSERT_SQL,
      [
        integrationId, 'dingtalk', CORP, external, unionId, openId, unionId ?? external,
        'Fixture', null, null, null, null, null, null, JSON.stringify({}), new Date(),
      ],
    )
    const read = async () => (await q(
      `SELECT open_id FROM directory_accounts WHERE integration_id = $1::uuid AND external_user_id = $2`,
      [integrationId, external],
    )).rows[0]?.open_id ?? null

    const unionA = `union_${RUN}_sync_a`
    await upsert(unionA, null)
    await expect(read()).resolves.toBeNull()

    // a login backfilled it
    await q(`UPDATE directory_accounts SET open_id = $3 WHERE integration_id = $1::uuid AND external_user_id = $2`, [integrationId, external, `open_${RUN}_sync`])
    await upsert(unionA, null) // 通讯录 pull carries no openId
    await expect(read()).resolves.toBe(`open_${RUN}_sync`)

    await upsert(`union_${RUN}_sync_b`, null) // same userid, different person-key → stale openId dropped
    await expect(read()).resolves.toBeNull()

    await upsert(`union_${RUN}_sync_b`, `open_${RUN}_sync_pulled`) // a pull that does carry one wins
    await expect(read()).resolves.toBe(`open_${RUN}_sync_pulled`)

    // N1: a NULL unionId is never "the same person" — not even NULL→NULL — so the openId is cleared
    await upsert(null, null)
    await expect(read()).resolves.toBeNull()
    await q(`UPDATE directory_accounts SET open_id = $3 WHERE integration_id = $1::uuid AND external_user_id = $2`, [integrationId, external, `open_${RUN}_sync_null_union`])
    await upsert(null, null)
    await expect(read()).resolves.toBeNull()
  })

  // ── 3. login backfill ───────────────────────────────────────────────────────────────────────

  it('a successful DingTalk login backfills the same corp+union member, and only that member', async () => {
    const union = `union_${RUN}_login`
    const openId = `open_${RUN}_login`
    const userId = await seedUser('login')
    await seedIdentity({ userId, corpId: CORP, unionId: union, openId: null })
    await q(
      `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, created_at, updated_at)
       VALUES ('dingtalk', $1, TRUE, NOW(), NOW())`,
      [userId],
    )
    const target = await seedAccount({ tag: 'login-target', unionId: union })
    const neighbour = await seedAccount({ tag: 'login-neighbour', unionId: `union_${RUN}_login_other` })
    const foreignCorp = await seedAccount({ tag: 'login-foreign', unionId: union, integration: otherIntegrationId })
    // SAME corp + SAME unionId as the target, but an openId is already on file: the backfill must
    // leave it alone (this row matches every other backfill condition, so only the empty-openId
    // guard keeps it unchanged).
    const alreadyKnown = await seedAccount({
      tag: 'login-known',
      unionId: union,
      openId: `open_${RUN}_known`,
      externalKey: `ext_${RUN}_login_known`,
    })

    primeWebLogin(union, openId)
    const result = await exchangeCodeForUser(`code-${RUN}-login`)
    expect(result.localUserId).toBe(userId)

    await expect(accountOpenId(target)).resolves.toBe(openId)
    await expect(accountOpenId(neighbour)).resolves.toBeNull()
    await expect(accountOpenId(foreignCorp)).resolves.toBeNull()
    await expect(accountOpenId(alreadyKnown)).resolves.toBe(`open_${RUN}_known`)
  })

  it('a login rejected for a missing grant still backfills, after which the directory page can grant', async () => {
    vi.stubEnv('DINGTALK_AUTH_REQUIRE_GRANT', '1')
    const union = `union_${RUN}_rejected`
    const openId = `open_${RUN}_rejected`
    const accountId = await seedAccount({ tag: 'rejected', unionId: union })
    const userId = await seedUser('rejected')
    // what a grant-less directory bind leaves behind: union-keyed identity, no openId
    await expect(bind(accountId, userId, false)).resolves.toBeTruthy()
    await expect(identityOf(userId)).resolves.toEqual({ provider_union_id: union, provider_open_id: null })
    await expect(bind(accountId, userId, true)).rejects.toThrow('missing DingTalk openId')

    primeWebLogin(union, openId)
    await expect(exchangeCodeForUser(`code-${RUN}-rejected`)).rejects.toMatchObject({ code: 'grant_required' })

    await expect(accountOpenId(accountId)).resolves.toBe(openId)
    await expect(bind(accountId, userId, true)).resolves.toBeTruthy()
    await expect(grantOf(userId)).resolves.toBe(true)
    await expect(identityOf(userId)).resolves.toEqual({ provider_union_id: union, provider_open_id: openId })
  })
})

// ── 5. field item 3: corp-less (R66-R70) identities, through the real routers ─────────────────

describeIfDb('field item 3: a corp-less DingTalk identity backfills its linked directory openId (real routers, real DB)', () => {
  // The pinned server's listen hook lives in this outer suite so it has finished before the inner
  // suite's beforeAll asks for its URL (vitest runs one suite's hooks in parallel by default).
  const pinned = usePinnedServer()

  describe('shape D: identity corp_id NULL with a bare unionId key, left by an R66-R70 login without DINGTALK_CORP_ID', () => {
    const ITEM3 = `item3_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`
    const DIR_CORP = `corp_${ITEM3}`
    const SECOND_CORP = `corp_${ITEM3}_second`
    const ORG = `org_${ITEM3}`
    const ADMIN_ID = `admin_${ITEM3}`
    const ENV_NAMES = [
      'DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET', 'DINGTALK_APP_KEY', 'DINGTALK_APP_SECRET',
      'DINGTALK_REDIRECT_URI', 'DINGTALK_CORP_ID', 'DINGTALK_ALLOWED_CORP_IDS',
      'DINGTALK_AUTH_REQUIRE_GRANT', 'DINGTALK_AUTH_AUTO_LINK_EMAIL', 'DINGTALK_AUTH_AUTO_PROVISION',
      'DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE', 'REDIS_URL', 'REDIS_HOST',
    ]
    const savedEnv = new Map<string, string | undefined>()
    const realFetch: typeof fetch = globalThis.fetch.bind(globalThis)
    const integrationIds: string[] = []
    const localUserIds: string[] = []
    let adminToken = ''
    let dingtalkProfile: Record<string, unknown> = {}

    type Member = {
      integrationId: string
      accountId: string
      userId: string
      email: string
      unionId: string
      openId: string
    }

    function setEnv(shape: { corp: string | null; requireGrant?: boolean; autoLinkEmail?: boolean }): void {
      for (const name of ENV_NAMES) delete process.env[name]
      process.env.DINGTALK_CLIENT_ID = 'synthetic-client'
      process.env.DINGTALK_CLIENT_SECRET = 'synthetic-secret'
      process.env.DINGTALK_REDIRECT_URI = 'https://app.example.test/login/dingtalk/callback'
      if (shape.corp) process.env.DINGTALK_CORP_ID = shape.corp
      if (shape.requireGrant) process.env.DINGTALK_AUTH_REQUIRE_GRANT = 'true'
      if (shape.autoLinkEmail) process.env.DINGTALK_AUTH_AUTO_LINK_EMAIL = 'true'
    }

    function jsonResponse(body: unknown, status = 200): Response {
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }

    // Only api.dingtalk.com is answered here; everything else (the pinned server) passes through.
    async function fakeDingTalkFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const parsed = new URL(url)
      if (parsed.hostname === 'api.dingtalk.com' || parsed.hostname === 'oapi.dingtalk.com') {
        if (parsed.pathname === '/v1.0/oauth2/userAccessToken') {
          return jsonResponse({ accessToken: 'synthetic-user-token', expireIn: 7200 })
        }
        if (parsed.pathname === '/v1.0/contact/users/me') return jsonResponse(dingtalkProfile)
        return jsonResponse({ code: 'synthetic.unexpected', message: 'unexpected synthetic DingTalk path' }, 404)
      }
      return realFetch(input as never, init)
    }

    async function api(method: string, path: string, body?: unknown, auth = true) {
      const res = await realFetch(`${pinned.url()}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(auth ? { authorization: `Bearer ${adminToken}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      let json: any = null
      try { json = JSON.parse(text) } catch { json = null }
      return { status: res.status, json }
    }

    async function seedIntegration(tag: string, corpId: string): Promise<string> {
      const id = (await q(
        `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id)
         VALUES ($1, 'dingtalk', $2, 'active', $3) RETURNING id::text AS id`,
        [ORG, `${ITEM3}-${tag}`, corpId],
      )).rows[0].id as string
      integrationIds.push(id)
      return id
    }

    /** The statement the directory sync runs per 通讯录 member: open_id NULL, external_key = unionId. */
    async function seedDirectoryAccount(integrationId: string, corpId: string, externalUserId: string, unionId: string): Promise<string> {
      await q(__directorySyncInternalsForTests.DIRECTORY_ACCOUNT_UPSERT_SQL, [
        integrationId, 'dingtalk', corpId, externalUserId, unionId, null, unionId,
        'Synthetic member', null, null, null, null, null, null, JSON.stringify({ synthetic: true }), new Date(),
      ])
      return (await q(
        `SELECT id::text AS id FROM directory_accounts WHERE integration_id = $1::uuid AND external_user_id = $2`,
        [integrationId, externalUserId],
      )).rows[0].id as string
    }

    async function seedLocalUser(tag: string): Promise<{ userId: string; email: string }> {
      const userId = `user_${ITEM3}_${tag}`
      const email = `${tag}.${ITEM3}@example.test`
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, is_active, activation_status)
         VALUES ($1, $2, 'Synthetic member', 'unused', 'user', TRUE, 'activated')`,
        [userId, email],
      )
      localUserIds.push(userId)
      return { userId, email }
    }

    function bindOnDirectoryPage(m: Member, enableDingTalkGrant: boolean) {
      return api('POST', `/api/admin/directory/accounts/${m.accountId}/bind`, { localUserRef: m.userId, enableDingTalkGrant })
    }

    /** A 通讯录 member bound to a local user on the directory page (CORP_ID unset, no grant). */
    async function seedBoundMember(tag: string): Promise<Member> {
      setEnv({ corp: null })
      const integrationId = await seedIntegration(tag, DIR_CORP)
      const unionId = `union_${ITEM3}_${tag}`
      const accountId = await seedDirectoryAccount(integrationId, DIR_CORP, `emp_${ITEM3}_${tag}`, unionId)
      const { userId, email } = await seedLocalUser(tag)
      const m = { integrationId, accountId, userId, email, unionId, openId: `open_${ITEM3}_${tag}` }
      expect((await bindOnDirectoryPage(m, false)).status).toBe(200)
      return m
    }

    // The R66-R70 successful-login identity UPDATE, verbatim. With DINGTALK_CORP_ID unset those
    // builds wrote external_key = unionId and corp_id = NULL on every web login.
    async function applyLegacyR70SuccessfulLogin(m: Member): Promise<void> {
      await q(
        `UPDATE user_external_identities
         SET external_key = CASE WHEN $8::boolean THEN $3 ELSE COALESCE(NULLIF(external_key, ''), $3) END,
             provider_union_id = COALESCE($4, provider_union_id),
             provider_open_id = CASE WHEN $8::boolean THEN $5 ELSE provider_open_id END,
             corp_id = CASE WHEN $8::boolean THEN $6 ELSE COALESCE(corp_id, $6) END,
             profile = $7::jsonb,
             bound_by = COALESCE(bound_by, $2),
             last_login_at = NOW(),
             updated_at = NOW()
         WHERE provider = $1 AND local_user_id = $2`,
        ['dingtalk', m.userId, m.unionId, m.unionId, m.openId, null,
          JSON.stringify({ openId: m.openId, unionId: m.unionId, nick: 'Synthetic' }), true],
      )
    }

    async function seedShapeDMember(tag: string): Promise<Member> {
      const m = await seedBoundMember(tag)
      await applyLegacyR70SuccessfulLogin(m)
      return m
    }

    /** The member scans: GET /api/auth/dingtalk/launch, then POST /api/auth/dingtalk/callback. */
    async function scan(m: Member, opts: { withEmail?: boolean } = {}) {
      dingtalkProfile = {
        openId: m.openId,
        unionId: m.unionId,
        nick: 'Synthetic',
        ...(opts.withEmail ? { email: m.email } : {}),
      }
      const launch = await api('GET', '/api/auth/dingtalk/launch?redirect=%2F', undefined, false)
      expect(launch.status).toBe(200)
      const callback = await api('POST', '/api/auth/dingtalk/callback', { code: `code-${randomUUID()}`, state: launch.json?.data?.state }, false)
      return { status: callback.status, userId: callback.json?.data?.user?.id ?? null }
    }

    const accountOpenIdOf = async (accountId: string) =>
      (await q(`SELECT open_id FROM directory_accounts WHERE id = $1::uuid`, [accountId])).rows[0]?.open_id ?? null

    const identityRowOf = async (userId: string) =>
      (await q(
        `SELECT corp_id, external_key, provider_union_id, provider_open_id
           FROM user_external_identities WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [userId],
      )).rows[0] ?? null

    const grantEnabledOf = async (userId: string) =>
      (await q(
        `SELECT enabled FROM user_external_auth_grants WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [userId],
      )).rows[0]?.enabled ?? null

    /** What 「刷新当前成员」 reads on the account card and in the review queue. */
    async function directoryView(accountId: string) {
      const account = await api('GET', `/api/admin/directory/accounts/${accountId}`)
      const item = await api('GET', `/api/admin/directory/accounts/${accountId}/review-item`)
      expect([account.status, item.status]).toEqual([200, 200])
      return {
        grantOpenIdAvailable: account.json?.data?.account?.grantOpenIdAvailable ?? null,
        missingOpenIdChip: item.json?.data?.item?.flags?.missingOpenId ?? null,
      }
    }

    async function userManagementRow(userId: string): Promise<Record<string, unknown> | null> {
      const list = await api('GET', `/api/admin/users?q=${encodeURIComponent(userId)}&page=1&pageSize=20`)
      expect(list.status).toBe(200)
      return (list.json?.data?.items ?? []).find((entry: { id?: string }) => entry?.id === userId) ?? null
    }

    /** User management list row: the 「缺 OpenID」 badge and the openid-missing filter read this flag. */
    async function userManagementBadge(userId: string): Promise<boolean | null> {
      const row = await userManagementRow(userId)
      return row ? Boolean(row.dingtalkOpenIdMissing) : null
    }

    /** The web's 「批量关闭缺 OpenID 钉钉扫码」 candidates (screeningUsersMissingOpenIdWithGrant). */
    async function isBulkCloseCandidate(userId: string): Promise<boolean | null> {
      const row = await userManagementRow(userId)
      return row ? row.dingtalkOpenIdMissing === true && row.dingtalkLoginEnabled === true : null
    }

    function grantFromUserManagement(m: Member) {
      return api('PATCH', `/api/admin/users/${encodeURIComponent(m.userId)}/dingtalk-grant`, { enabled: true })
    }

    /** warn/error lines, with the text of the error handed to the logger (where values could leak). */
    function captureWarnings(): () => Array<{ message: string; text: string }> {
      const lines: Array<{ message: string; text: string }> = []
      const spies = (['warn', 'error'] as const).map((level) =>
        vi.spyOn(Logger.prototype, level).mockImplementation(((message: unknown, error?: unknown) => {
          const detail = error instanceof Error
            ? [error.message, (error as Error & { detail?: unknown }).detail].map((part) => String(part ?? '')).join(' ')
            : String(error ?? '')
          lines.push({ message: String(message), text: `${String(message)} ${detail}` })
        }) as never))
      return () => {
        for (const spy of spies) spy.mockRestore()
        return lines
      }
    }

    beforeAll(async () => {
      for (const name of ENV_NAMES) savedEnv.set(name, process.env[name])
      // Point the file-level client mocks back at the real client: the real env reader and the real
      // transport run, and only the DingTalk HTTP answers below are synthetic.
      const actualClient = await vi.importActual<typeof import('../../src/integrations/dingtalk/client')>(
        '../../src/integrations/dingtalk/client',
      )
      clientMocks.exchangeCodeForUserAccessToken.mockImplementation(actualClient.exchangeCodeForUserAccessToken)
      clientMocks.fetchDingTalkCurrentUser.mockImplementation(actualClient.fetchDingTalkCurrentUser)
      clientMocks.isDingTalkConfigured.mockImplementation(actualClient.isDingTalkConfigured)
      clientMocks.readDingTalkOauthConfig.mockImplementation(actualClient.readDingTalkOauthConfig)
      vi.stubGlobal('fetch', fakeDingTalkFetch)
      setEnv({ corp: null })

      const app = express()
      app.use(express.json())
      app.use('/api/auth', authRouter)
      app.use('/api/admin/directory', authenticate, adminDirectoryRouter())
      app.use(adminUsersRouter())
      pinned.setApp(app as never)
      const token = await api('GET', `/api/auth/dev-token?userId=${ADMIN_ID}&roles=admin&perms=${encodeURIComponent('*:*')}`, undefined, false)
      adminToken = String(token.json?.token ?? '')
      expect(adminToken).not.toBe('')
    })

    afterAll(async () => {
      for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      vi.unstubAllGlobals()
      clientMocks.exchangeCodeForUserAccessToken.mockReset()
      clientMocks.fetchDingTalkCurrentUser.mockReset()
      clientMocks.readDingTalkOauthConfig.mockReset()
      clientMocks.isDingTalkConfigured.mockReset()
      clientMocks.isDingTalkConfigured.mockImplementation(() => true)
      await q(`DELETE FROM user_external_auth_grants WHERE local_user_id = ANY($1::text[])`, [localUserIds]).catch(() => {})
      await q(`DELETE FROM user_external_identities WHERE local_user_id = ANY($1::text[])`, [localUserIds]).catch(() => {})
      await q(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [localUserIds]).catch(() => {})
      await q(
        `DELETE FROM directory_account_links WHERE directory_account_id IN (
           SELECT id FROM directory_accounts WHERE integration_id = ANY($1::uuid[]))`,
        [integrationIds],
      ).catch(() => {})
      await q(`DELETE FROM directory_accounts WHERE integration_id = ANY($1::uuid[])`, [integrationIds]).catch(() => {})
      await q(`DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])`, [integrationIds]).catch(() => {})
      await q(`DELETE FROM users WHERE id = ANY($1::text[])`, [localUserIds]).catch(() => {})
    })

    it('D1: with DINGTALK_CORP_ID unset one scan backfills the linked directory openId; the directory page clears, directory grant 200, the next login 200; the identity row is untouched', async () => {
      const m = await seedShapeDMember('d1')
      const legacyIdentity = await identityRowOf(m.userId)
      expect(legacyIdentity).toEqual({
        corp_id: null, external_key: m.unionId, provider_union_id: m.unionId, provider_open_id: m.openId,
      })
      // before: the directory page says 缺 openId; user management keeps its R72 meaning (no badge
      // for a corp-less identity), so it never offers this member to the 缺 OpenID bulk close
      await expect(directoryView(m.accountId)).resolves.toEqual({ grantOpenIdAvailable: false, missingOpenIdChip: true })
      await expect(userManagementBadge(m.userId)).resolves.toBe(false)

      setEnv({ corp: null })
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })

      // 刷新当前成员: the directory row learned the openId and the directory page clears
      await expect(accountOpenIdOf(m.accountId)).resolves.toBe(m.openId)
      await expect(directoryView(m.accountId)).resolves.toEqual({ grantOpenIdAvailable: true, missingOpenIdChip: false })
      await expect(userManagementBadge(m.userId)).resolves.toBe(false)
      // the derived corp scoped the backfill only: corp, key and ids of the identity are unchanged
      await expect(identityRowOf(m.userId)).resolves.toEqual(legacyIdentity)

      // directory 开通 now succeeds, and the member keeps signing in
      expect((await bindOnDirectoryPage(m, true)).status).toBe(200)
      await expect(grantEnabledOf(m.userId)).resolves.toBe(true)
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
      // the directory grant re-bound the identity into the enterprise; only now is DINGTALK_CORP_ID safe
      await expect(identityRowOf(m.userId)).resolves.toEqual({
        corp_id: DIR_CORP, external_key: `${DIR_CORP}:${m.openId}`, provider_union_id: m.unionId, provider_open_id: m.openId,
      })
      setEnv({ corp: DIR_CORP })
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
    })

    it('a rescan alone does not make DINGTALK_CORP_ID safe: the identity stays corp-less, so a CORP_ID-set login is still refused (403)', async () => {
      const m = await seedShapeDMember('rescan-only')
      setEnv({ corp: null })
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBe(m.openId)
      await expect(identityRowOf(m.userId)).resolves.toMatchObject({ corp_id: null, external_key: m.unionId })

      setEnv({ corp: DIR_CORP })
      await expect(scan(m)).resolves.toEqual({ status: 403, userId: null })
    })

    it('D2/D2b: setting DINGTALK_CORP_ID before the member rescans locks them out (403, or 409 with e-mail auto-link) and backfills nothing', async () => {
      const m = await seedShapeDMember('d2')
      setEnv({ corp: DIR_CORP })
      await expect(scan(m)).resolves.toEqual({ status: 403, userId: null })
      setEnv({ corp: DIR_CORP, autoLinkEmail: true })
      await expect(scan(m, { withEmail: true })).resolves.toEqual({ status: 409, userId: null })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBeNull()
    })

    it('refused-login enrichment (REQUIRE_GRANT, no grant yet): the 403 scan backfills under the same rule, then directory grant 200 and login 200', async () => {
      const m = await seedShapeDMember('d1g')
      const legacyIdentity = await identityRowOf(m.userId)
      await expect(userManagementBadge(m.userId)).resolves.toBe(false)

      setEnv({ corp: null, requireGrant: true })
      await expect(scan(m)).resolves.toEqual({ status: 403, userId: null })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBe(m.openId)
      await expect(identityRowOf(m.userId)).resolves.toEqual(legacyIdentity)
      await expect(directoryView(m.accountId)).resolves.toEqual({ grantOpenIdAvailable: true, missingOpenIdChip: false })
      await expect(userManagementBadge(m.userId)).resolves.toBe(false)

      expect((await bindOnDirectoryPage(m, true)).status).toBe(200)
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
    })

    it('refused-login enrichment that still has to learn the openId: it is learned, corp_id stays NULL and the key bare, the linked row is backfilled', async () => {
      const m = await seedBoundMember('refused-no-open')
      // a corp-less, union-keyed identity that never recorded an openId (e.g. a container login)
      await q(
        `UPDATE user_external_identities SET corp_id = NULL, external_key = $2, provider_open_id = NULL
          WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [m.userId, m.unionId],
      )

      setEnv({ corp: null, requireGrant: true })
      await expect(scan(m)).resolves.toEqual({ status: 403, userId: null })
      await expect(identityRowOf(m.userId)).resolves.toEqual({
        corp_id: null, external_key: m.unionId, provider_union_id: m.unionId, provider_open_id: m.openId,
      })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBe(m.openId)
    })

    it('granted from user management (the path the old directory 400 suggested): no new refusal, never a 批量关闭缺 OpenID candidate, and the member keeps signing in', async () => {
      const m = await seedShapeDMember('um-grant')
      const grant = await grantFromUserManagement(m)
      expect(grant.status).toBe(200)
      await expect(grantEnabledOf(m.userId)).resolves.toBe(true)
      // 缺 OpenID keeps its R72 meaning: a corp-less identity is not flagged, so one click on
      // 「批量关闭缺 OpenID 钉钉扫码」 cannot disable this member's working login
      await expect(userManagementBadge(m.userId)).resolves.toBe(false)
      await expect(isBulkCloseCandidate(m.userId)).resolves.toBe(false)

      setEnv({ corp: null })
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBe(m.openId)
      await expect(isBulkCloseCandidate(m.userId)).resolves.toBe(false)
    })

    it('AMB: two linked directory accounts carry the scanned unionId (two corps): no corp is picked, nothing is backfilled, the login still works and nothing is logged', async () => {
      const m = await seedShapeDMember('amb-two')
      const secondIntegrationId = await seedIntegration('amb-two-second', SECOND_CORP)
      const secondAccountId = await seedDirectoryAccount(secondIntegrationId, SECOND_CORP, `emp_${ITEM3}_amb_two_second`, m.unionId)
      // the directory page refuses a second link for one user, so a pre-existing one is seeded directly
      await q(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
         VALUES ($1::uuid, $2, 'linked', 'manual_admin', NOW(), NOW())`,
        [secondAccountId, m.userId],
      )
      expect((await grantFromUserManagement(m)).status).toBe(200)
      const legacyIdentity = await identityRowOf(m.userId)

      setEnv({ corp: null })
      const stopCapture = captureWarnings()
      let warnings: Array<{ message: string; text: string }> = []
      let result: { status: number; userId: string | null } | null = null
      try {
        result = await scan(m)
      } finally {
        warnings = stopCapture()
      }
      expect(result).toEqual({ status: 200, userId: m.userId })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBeNull()
      await expect(accountOpenIdOf(secondAccountId)).resolves.toBeNull()
      await expect(identityRowOf(m.userId)).resolves.toEqual(legacyIdentity)
      // a rescan cannot clear this member, so it must never sit in the bulk-close candidates
      await expect(userManagementBadge(m.userId)).resolves.toBe(false)
      await expect(isBulkCloseCandidate(m.userId)).resolves.toBe(false)
      expect(warnings).toEqual([])
    })

    it('AMB: no linked directory account: an unlinked row of the same person stays untouched', async () => {
      setEnv({ corp: null })
      const integrationId = await seedIntegration('amb-none', DIR_CORP)
      const unionId = `union_${ITEM3}_amb_none`
      const openId = `open_${ITEM3}_amb_none`
      const unlinkedAccountId = await seedDirectoryAccount(integrationId, DIR_CORP, `emp_${ITEM3}_amb_none`, unionId)
      const { userId, email } = await seedLocalUser('amb-none')
      await q(
        `INSERT INTO user_external_identities (provider, external_key, provider_union_id, provider_open_id, corp_id, local_user_id, profile)
         VALUES ('dingtalk', $1, $1, $2, NULL, $3, '{}'::jsonb)`,
        [unionId, openId, userId],
      )
      const legacyIdentity = await identityRowOf(userId)

      await expect(scan({ integrationId, accountId: unlinkedAccountId, userId, email, unionId, openId }))
        .resolves.toEqual({ status: 200, userId })
      await expect(accountOpenIdOf(unlinkedAccountId)).resolves.toBeNull()
      await expect(identityRowOf(userId)).resolves.toEqual(legacyIdentity)
      await expect(userManagementBadge(userId)).resolves.toBe(false)
    })

    it('the single linked account now carries another unionId: nothing is backfilled, not even a same-corp row of the scanned person', async () => {
      const m = await seedShapeDMember('union-mismatch')
      // a later 通讯录 pull re-keyed the linked row to another person
      const otherUnion = `union_${ITEM3}_union_mismatch_other`
      await q(`UPDATE directory_accounts SET union_id = $2, external_key = $2 WHERE id = $1::uuid`, [m.accountId, otherUnion])
      const samePersonAccountId = await seedDirectoryAccount(m.integrationId, DIR_CORP, `emp_${ITEM3}_union_mismatch_same`, m.unionId)
      const legacyIdentity = await identityRowOf(m.userId)

      setEnv({ corp: null })
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBeNull()
      await expect(accountOpenIdOf(samePersonAccountId)).resolves.toBeNull()
      await expect(identityRowOf(m.userId)).resolves.toEqual(legacyIdentity)
    })

    it('the single linked account is inactive (the member left the directory): nothing is backfilled', async () => {
      const m = await seedShapeDMember('inactive')
      await q(`UPDATE directory_accounts SET is_active = FALSE WHERE id = $1::uuid`, [m.accountId])
      expect((await grantFromUserManagement(m)).status).toBe(200)
      const legacyIdentity = await identityRowOf(m.userId)

      setEnv({ corp: null })
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBeNull()
      await expect(identityRowOf(m.userId)).resolves.toEqual(legacyIdentity)
      await expect(isBulkCloseCandidate(m.userId)).resolves.toBe(false)
    })

    it('the only link is pending (not linked): nothing is backfilled', async () => {
      const m = await seedShapeDMember('pending-link')
      await q(`UPDATE directory_account_links SET link_status = 'pending' WHERE directory_account_id = $1::uuid`, [m.accountId])

      setEnv({ corp: null })
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBeNull()
    })

    it('a linked account of another provider does not count: the single DingTalk link still backfills', async () => {
      const m = await seedShapeDMember('other-provider')
      const otherProviderIntegrationId = (await q(
        `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id)
         VALUES ($1, 'wecom', $2, 'active', $3) RETURNING id::text AS id`,
        [ORG, `${ITEM3}-other-provider`, SECOND_CORP],
      )).rows[0].id as string
      integrationIds.push(otherProviderIntegrationId)
      const otherProviderAccountId = (await q(
        `INSERT INTO directory_accounts (integration_id, provider, corp_id, external_user_id, union_id, external_key, name, is_active)
         VALUES ($1::uuid, 'wecom', $2, $3, $4, $4, 'Synthetic member', TRUE) RETURNING id::text AS id`,
        [otherProviderIntegrationId, SECOND_CORP, `emp_${ITEM3}_other_provider`, m.unionId],
      )).rows[0].id as string
      await q(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
         VALUES ($1::uuid, $2, 'linked', 'manual_admin', NOW(), NOW())`,
        [otherProviderAccountId, m.userId],
      )

      setEnv({ corp: null })
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBe(m.openId)
      await expect(accountOpenIdOf(otherProviderAccountId)).resolves.toBeNull()
    })

    it('a failing corp lookup stays inside the backfill savepoint: login 200, nothing backfilled, one values-free warning', async () => {
      const m = await seedShapeDMember('lookup-fails')
      const legacyIdentity = await identityRowOf(m.userId)
      setEnv({ corp: null })
      // The lookup filters on link_status: renaming that column for exactly one scan makes the
      // lookup statement fail inside the savepoint. Restored in finally before anything else runs.
      await q('ALTER TABLE directory_account_links RENAME COLUMN link_status TO link_status_item3_probe')
      const stopCapture = captureWarnings()
      let warnings: Array<{ message: string; text: string }> = []
      let result: { status: number; userId: string | null } | null = null
      try {
        result = await scan(m)
      } finally {
        warnings = stopCapture()
        await q('ALTER TABLE directory_account_links RENAME COLUMN link_status_item3_probe TO link_status')
      }
      expect(result).toEqual({ status: 200, userId: m.userId })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBeNull()
      await expect(identityRowOf(m.userId)).resolves.toEqual(legacyIdentity)
      expect(warnings.map((line) => line.message)).toEqual(['DingTalk directory openId backfill failed; login continues'])
      for (const value of [m.unionId, m.openId, m.userId, m.email]) {
        expect(warnings.some((line) => line.text.includes(value))).toBe(false)
      }

      // with the column back, the next scan backfills as usual
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBe(m.openId)
    })

    it('#6487 ambiguity is untouched: another local user holding the same person as a corp-less identity makes the scan 409 and nothing changes', async () => {
      const m = await seedBoundMember('amb-6487')
      const other = await seedLocalUser('amb-6487-other')
      await q(
        `INSERT INTO user_external_identities (provider, external_key, provider_union_id, provider_open_id, corp_id, local_user_id, profile)
         VALUES ('dingtalk', $1, $1, $2, NULL, $3, '{}'::jsonb)`,
        [m.unionId, m.openId, other.userId],
      )
      const before = await identityRowOf(m.userId)

      setEnv({ corp: null })
      await expect(scan(m)).resolves.toEqual({ status: 409, userId: null })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBeNull()
      await expect(identityRowOf(m.userId)).resolves.toEqual(before)
    })

    it('A1 unchanged: CORP_ID unset, a directory-bound member (corp-scoped identity) clears after one scan', async () => {
      const m = await seedBoundMember('a1')
      await expect(identityRowOf(m.userId)).resolves.toMatchObject({ corp_id: DIR_CORP, provider_open_id: null })
      await expect(userManagementBadge(m.userId)).resolves.toBe(true)

      setEnv({ corp: null })
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBe(m.openId)
      await expect(directoryView(m.accountId)).resolves.toEqual({ grantOpenIdAvailable: true, missingOpenIdChip: false })
      await expect(userManagementBadge(m.userId)).resolves.toBe(false)
      expect((await bindOnDirectoryPage(m, true)).status).toBe(200)
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
    })

    it('B unchanged: CORP_ID = the directory corp, a directory-bound member clears after one scan', async () => {
      const m = await seedBoundMember('b')
      setEnv({ corp: DIR_CORP })
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
      await expect(accountOpenIdOf(m.accountId)).resolves.toBe(m.openId)
      await expect(directoryView(m.accountId)).resolves.toEqual({ grantOpenIdAvailable: true, missingOpenIdChip: false })
      expect((await bindOnDirectoryPage(m, true)).status).toBe(200)
      await expect(scan(m)).resolves.toEqual({ status: 200, userId: m.userId })
    })
  })
})
