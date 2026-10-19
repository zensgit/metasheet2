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
 *
 * The DingTalk HTTP client is mocked; nothing here talks to DingTalk.
 */
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
import { exchangeCodeForUser } from '../../src/auth/dingtalk-oauth'
import { __directorySyncInternalsForTests, bindDirectoryAccount, getDirectoryAccountSummary } from '../../src/directory/directory-sync'

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
